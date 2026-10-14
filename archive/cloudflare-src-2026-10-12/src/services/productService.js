import { storageService } from './storageService';
import { apiService } from './apiService';

/**
 * Auto-fallback on Read:
 * If a product has stockBalance > 0 (or currentStock > 0) but averageCost is 0 or empty,
 * retrieves the unitPrice from the latest 'IN' log in StockLogs as fallback.
 * Never sends 0 or null if purchase history exists.
 *
 * @param {Array} products List of products
 * @param {Array|null} stockLogs List of stock logs (optional)
 * @returns {Array} Products with fallback cost applied
 */
export function applyProductCostFailSafe(products = [], stockLogs = null) {
  if (!Array.isArray(products)) return [];
  const logs = Array.isArray(stockLogs) ? stockLogs : (storageService.getStockLogs() || []);

  const latestInLogsMap = new Map();
  logs.forEach(l => {
    if (!l) return;
    const lType = String(l.type || '').toUpperCase();
    const qty = Number(l.qty || l.quantity || 0);
    const unitPrice = Number(
      l.unitPrice !== undefined ? l.unitPrice : 
      (l.actualUnitPrice !== undefined ? l.actualUnitPrice : 
      (l.unitCost || l.baseUnitCost || 0))
    );

    if (lType === 'IN' && qty > 0 && unitPrice > 0) {
      const ts = new Date(l.timestamp || l.date || 0).getTime();
      const keys = [
        String(l.productId || '').trim().toLowerCase(),
        String(l.productCode || l.code || l.sku || '').trim().toLowerCase(),
        String(l.name || '').trim().toLowerCase()
      ].filter(Boolean);

      keys.forEach(k => {
        const existing = latestInLogsMap.get(k);
        if (!existing || ts >= existing.ts) {
          latestInLogsMap.set(k, { unitPrice, ts });
        }
      });
    }
  });

  return products.map(p => {
    if (!p) return p;
    const stock = Number(p.stockBalance !== undefined ? p.stockBalance : (p.currentStock || p.stock || 0));
    const rawCost = Number(
      p.averageCost !== undefined && p.averageCost !== '' && p.averageCost !== null ? p.averageCost : 
      (p.avgCost !== undefined && p.avgCost !== '' && p.avgCost !== null ? p.avgCost : 
      (p.unitCost || 0))
    );

    let updated = { ...p };
    if (stock > 0 && rawCost <= 0) {
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || p.sku || '').trim().toLowerCase();
      const pName = String(p.name || '').trim().toLowerCase();

      const match = (pId && latestInLogsMap.get(pId)) || 
                    (pCode && latestInLogsMap.get(pCode)) || 
                    (pName && latestInLogsMap.get(pName));

      if (match && match.unitPrice > 0) {
        updated.averageCost = match.unitPrice;
        updated.avgCost = match.unitPrice;
        if (!updated.totalValue || Number(updated.totalValue) <= 0) {
          updated.totalValue = Math.round(stock * match.unitPrice * 100) / 100;
        }
      }
    } else if (rawCost > 0) {
      if (updated.averageCost === undefined || updated.averageCost === null || updated.averageCost === '') {
        updated.averageCost = rawCost;
      }
      if (updated.avgCost === undefined || updated.avgCost === null || updated.avgCost === '') {
        updated.avgCost = rawCost;
      }
      if (!updated.totalValue || Number(updated.totalValue) <= 0) {
        updated.totalValue = Math.round(stock * rawCost * 100) / 100;
      }
    }
    return updated;
  });
}

export const productService = {
  /**
   * Retrieves products with fresh fetch option and auto-fallback applied.
   */
  async getProducts(forceFetch = false) {
    const prods = await apiService.getProducts(forceFetch);
    const logs = storageService.getStockLogs() || [];
    return applyProductCostFailSafe(prods, logs);
  },

  /**
   * Retrieves warehouse stock list with auto-fallback applied.
   */
  getWarehouseStock() {
    const prods = storageService.getProducts() || [];
    const logs = storageService.getStockLogs() || [];
    return applyProductCostFailSafe(prods, logs);
  },

  applyProductCostFailSafe
};

export default productService;
