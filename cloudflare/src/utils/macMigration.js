import { storageService, isGAS, callGAS } from '../services/storageService';
import { cfBackground, cfWrite } from '../services/cfGuard';
import { isCloudflareMode } from '../config/backendMode.js';

/**
 * Recalculates Moving Average Cost (MAC) for a product from historical IN logs
 * and commits the mutation directly to the master database (Google Sheets Products tab).
 *
 * @param {string} targetSkuOrName Product ID, code, SKU, or name
 * @returns {Promise<Object|null>} The updated product record or null
 */
export const healMACForProduct = async (targetSkuOrName) => {
  try {
    const logs = storageService.getStockLogs() || [];
    const products = storageService.getProducts() || [];
    
    const targetSkuLow = String(targetSkuOrName || '').trim().toLowerCase();
    
    // ค้นหาสินค้า
    const targetProductIndex = products.findIndex(p => {
      const code = String(p.code || p.sku || '').trim().toLowerCase();
      const id = String(p.id || '').trim().toLowerCase();
      const name = String(p.name || p.productName || '').trim().toLowerCase();
      return code === targetSkuLow || id === targetSkuLow || name === targetSkuLow;
    });

    if (targetProductIndex === -1) {
      console.warn(`[MAC Recalculation] ไม่พบสินค้า "${targetSkuOrName}" ใน Master Inventory`);
      return null;
    }
    
    const product = { ...products[targetProductIndex] };
    const pCode = String(product.code || product.sku || '').trim().toLowerCase();
    const pId = String(product.id || '').trim().toLowerCase();
    const pName = String(product.name || '').trim().toLowerCase();

    // กรอง log รับเข้าจริง (type === 'IN' และ qty > 0) เรียงตามเวลาเก่าไปใหม่
    const targetLogs = logs
      .filter(l => {
        if (!l) return false;
        const lSku = String(l.productCode || l.code || l.sku || '').trim().toLowerCase();
        const lId = String(l.productId || '').trim().toLowerCase();
        const lName = String(l.name || l.productName || '').trim().toLowerCase();
        const matches = (pId && lId === pId) || 
                        (pCode && (lSku === pCode || lId === pCode)) || 
                        (pName && lName === pName);
        const lType = String(l.type || '').toUpperCase();
        const qty = Number(l.quantity !== undefined ? l.quantity : (l.qty || 0));
        return matches && lType === 'IN' && qty > 0;
      })
      .sort((a, b) => new Date(a.timestamp || a.date || 0).getTime() - new Date(b.timestamp || b.date || 0).getTime());

    let currentStock = 0;
    let currentAvgCost = 0;

    targetLogs.forEach(log => {
      const inQty = Number(log.quantity !== undefined ? log.quantity : (log.qty || 0));
      const inUnitCost = Number(
        log.unitPrice !== undefined ? log.unitPrice : 
        (log.actualUnitPrice !== undefined ? log.actualUnitPrice : 
        (log.unitCost || log.baseUnitCost || 0))
      );

      const currentTotalValue = currentStock * currentAvgCost;
      const inTotalValue = inQty * inUnitCost;
      
      const newStock = currentStock + inQty;
      let newAverageCost = inUnitCost;
      
      if (currentStock > 0 && newStock > 0) {
        newAverageCost = (currentTotalValue + inTotalValue) / newStock;
      }
      
      newAverageCost = Math.round(newAverageCost * 100) / 100;
      
      currentStock = newStock;
      currentAvgCost = newAverageCost;
      
      // Update appliedAvgCost on log
      log.appliedAvgCost = currentAvgCost;
    });

    if (currentAvgCost > 0) {
      const stockBalance = Number(product.stockBalance !== undefined ? product.stockBalance : (product.currentStock || 0));
      product.averageCost = currentAvgCost;
      product.avgCost = currentAvgCost;
      product.totalValue = Math.round(stockBalance * currentAvgCost * 100) / 100;
      product.updatedAt = new Date().toISOString();
      products[targetProductIndex] = product;

      // 1. Local Cache Update
      storageService.saveProducts(products);
      storageService.saveStockLogs(logs);

      // 2. Database Mutation (GAS Backend or REST API)
      if (isGAS()) {
        try {
          const res = await callGAS('apiRecalculateProductMAC', {
            productId: product.id,
            productCode: product.code,
            averageCost: currentAvgCost,
            totalValue: product.totalValue,
            product: product
          });
          if (res && res.data && res.data.product) {
            Object.assign(product, res.data.product);
          }
        } catch (gasErr) {
          console.warn('[MAC Recalculation] apiRecalculateProductMAC fallback to apiSaveMasterItem:', gasErr.message);
          try {
            await callGAS('apiSaveMasterItem', 'Products', product);
          } catch (saveErr) {
            console.error('[MAC Recalculation] Failed to mutate Products sheet:', saveErr.message);
          }
        }
      } else if (isCloudflareMode()) {
        // cloudflare: PUT /api/products ignores avgCost (master fields only), so persist through the server's own MAC recalculation
        // (computed from stock_logs on the server, same rule as GAS apiRecalculateProductMAC) and show what the server stored.
        const res = await cfWrite('คำนวณต้นทุนเฉลี่ยใหม่ไม่สำเร็จ', '/api/products/recalculate-mac', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: product.id, productCode: product.code })
        });
        const data = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null;
        const sp = data && data.product;
        if (sp && Number(sp.avgCost) > 0) {
          Object.assign(product, sp);
          currentAvgCost = Number(sp.avgCost);
          const all = storageService.getProducts() || [];
          const i = all.findIndex(p => String(p.id) === String(product.id));
          if (i !== -1) { all[i] = { ...all[i], ...sp }; storageService.saveProducts(all); }
        }
      } else {
        // Secondary (MAC self-heal): never throws; cloudflare mode logs a warning on failure
        await cfBackground('MAC recalculation sync', '/api/products/' + encodeURIComponent(product.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(product)
        });
      }

      console.log(`[MAC Recalculation] คำนวณต้นทุน MAC ใหม่ของ "${product.name}" สำเร็จ: ฿${currentAvgCost}`);
      return product;
    }
    
    return product;
  } catch (error) {
    console.error('[MAC Recalculation] Error:', error);
    return null;
  }
};

export const runMacMigration = async () => {
  return await healMACForProduct('ถุงมือกันร้อน');
};
