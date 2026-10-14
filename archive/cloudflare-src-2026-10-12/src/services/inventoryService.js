import { storageService } from './storageService.js';
import warehouseService from './warehouseService.js';

export { default as warehouseService } from './warehouseService.js';
export * from './warehouseService.js';

/**
 * Format timestamp in Asia/Bangkok (UTC+7) Thai locale
 */
export function formatLocalTimestamp(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return new Date().toLocaleString('th-TH');
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

import { getValidConversionRate, toStockQuantity, toStockUnitCost } from '../utils/uomEngine.js';

/**
 * Inventory valuation calculation helper for Stock Movement Log
 * Ensures Dual-UOM base unit cost conversion is properly computed.
 */
export function calculateStockMovementValue(movement, product = {}) {
  const conversionRate = getValidConversionRate(product.conversionRate || product.conversionRatio || movement.conversionRate);
  const rawPrice = movement.baseUnitCost ?? movement.stockUnitPrice ?? (movement.unitPrice || product.price || 0);
  const unitCostInStock = movement.baseUnitCost 
    ? Number(movement.baseUnitCost) 
    : (typeof toStockUnitCost === 'function' 
        ? toStockUnitCost(rawPrice, conversionRate) 
        : Number(rawPrice || 0) / (Number(conversionRate) > 0 ? Number(conversionRate) : 1));
  const totalAmount = movement.totalAmount !== undefined && movement.totalAmount !== null
    ? Number(movement.totalAmount)
    : (movement.totalPrice !== undefined && movement.totalPrice !== null && !movement.unitPrice
      ? Number(movement.totalPrice)
      : (Number(movement.quantity ?? movement.qty ?? 0) * unitCostInStock));

  return {
    conversionRate,
    unitCostInStock,
    totalAmount
  };
}

/**
 * Enterprise Stock Movement Log Generator & Syncer
 */
export const inventoryService = {
  formatLocalTimestamp,
  calculateStockMovementValue,

  /**
   * Retrieve all stock movements
   */
  getStockMovements() {
    return storageService.getStockLogs() || [];
  },

  /**
   * Save a single movement record to storage and local backend
   */
  async recordStockMovement(movementRecord) {
    if (!movementRecord || typeof movementRecord !== 'object') return null;
    const allLogs = storageService.getStockLogs() || [];

    // Deduplicate by ID or (docNo + productId)
    const existingIdx = allLogs.findIndex(l => 
      (l.id && movementRecord.id && l.id === movementRecord.id) ||
      (l.docNo && movementRecord.docNo && l.docNo === movementRecord.docNo && l.productId === movementRecord.productId) ||
      (l.documentNo && movementRecord.documentNo && l.documentNo === movementRecord.documentNo && l.productId === movementRecord.productId)
    );

    let updatedLogs;
    if (existingIdx !== -1) {
      updatedLogs = [...allLogs];
      updatedLogs[existingIdx] = { ...updatedLogs[existingIdx], ...movementRecord };
    } else {
      updatedLogs = [movementRecord, ...allLogs];
    }

    storageService.saveStockLogs(updatedLogs);

    // Sync to local server if running
    try {
      fetch('/api/stock-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(movementRecord)
      }).catch(() => {});
    } catch {}

    return movementRecord;
  },

  /**
   * Batch record stock movements for a Goods Receipt (GRN) event
   */
  async recordGRNStockMovements({ po, grnNumber, receivingItems = [], currentUser = {} }) {
    if (!po || !Array.isArray(receivingItems) || receivingItems.length === 0) return [];

    const products = storageService.getProducts() || [];
    const grnNo = grnNumber || `GRN-${po.poNo || po.id}-${Date.now()}`;
    const vendorName = po.vendorName || po.vendor?.name || 'ผู้จำหน่าย';
    const movements = [];

    const activeUser = (currentUser && typeof currentUser === 'object') ? currentUser : {};
    const actorName = activeUser.name || activeUser.employeeName || activeUser.username || (typeof currentUser === 'string' && currentUser ? currentUser : 'สิรภัทร แจ่มมิน');
    const actorRole = activeUser.canonicalRole || activeUser.role || activeUser.title || 'REQUESTER';

    receivingItems.forEach(item => {
      const goodQty = Number(item.goodQty ?? item.acceptedQty ?? item.receivedThisTime ?? item.receivedQty ?? item.qty ?? 0);
      if (goodQty <= 0) return;

      const pId = String(item.productId || item.id || '').trim().toLowerCase();
      const pCode = String(item.code || item.productCode || item.sku || '').trim().toLowerCase();
      const pName = String(item.name || '').trim().toLowerCase();

      const prod = products.find(p => {
        if (!p) return false;
        const prodId = String(p.id || '').trim().toLowerCase();
        const prodCode = String(p.code || p.sku || '').trim().toLowerCase();
        const prodName = String(p.name || '').trim().toLowerCase();
        return (pId && (prodId === pId || prodCode === pId)) ||
               (pCode && (prodCode === pCode || prodId === pCode)) ||
               (pName && prodName === pName);
      }) || {};

      const conversionRate = getValidConversionRate(item.conversionRate || item.conversionRatio || prod.conversionRate || prod.conversionRatio || 1);
      const receivedStockQty = typeof toStockQuantity === 'function'
        ? toStockQuantity(goodQty, conversionRate)
        : Number(goodQty || 0) * (Number(conversionRate) > 0 ? Number(conversionRate) : 1);
      const currentBalance = Number(prod.stockBalance ?? 0);
      const newBalance = currentBalance + receivedStockQty;

      // Calculate unit cost in stock unit
      const purchasePrice = Number(item.actUnitPrice ?? item.actualPrice ?? item.price ?? prod.price ?? 0);
      const unitCostInStock = typeof toStockUnitCost === 'function'
        ? toStockUnitCost(purchasePrice, conversionRate)
        : Number(purchasePrice || 0) / (Number(conversionRate) > 0 ? Number(conversionRate) : 1);
      const receivedPoItemTotal = item.total !== undefined && item.total !== null
        ? Number(item.total)
        : (receivedStockQty * unitCostInStock);

      // MAC Calculation (Moving Average Cost)
      const currentAvgCost = Number(prod.averageCost ?? prod.avgCost ?? prod.unitCost ?? 0);
      let newAverageCost = unitCostInStock;
      if (currentBalance > 0) {
        const currentTotalValue = currentBalance * currentAvgCost;
        const inTotalValue = receivedStockQty * unitCostInStock;
        newAverageCost = (currentTotalValue + inTotalValue) / newBalance;
      }
      newAverageCost = Math.round(newAverageCost * 100) / 100;

      // Update Master Inventory Product
      if (prod.id) {
        prod.averageCost = newAverageCost;
        prod.avgCost = newAverageCost;
        prod.stockBalance = newBalance;
        prod.totalValue = newBalance * newAverageCost;
        const pIndex = products.findIndex(p => p.id === prod.id);
        if (pIndex !== -1) {
          products[pIndex] = { ...products[pIndex], ...prod };
        }
      }

      const movementRecord = {
        id: `MOV-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        timestamp: formatLocalTimestamp(), // เวลาไทย UTC+7
        date: formatLocalTimestamp(),
        productId: String(prod.id || item.productId || '').trim(),
        productCode: String(prod.code || prod.sku || item.code || item.sku || '').trim(),
        sku: String(prod.code || prod.sku || item.code || item.sku || '').trim(),
        itemCode: String(prod.code || prod.sku || item.code || item.sku || '').trim(),
        productName: prod.name || item.name || '',
        name: prod.name || item.name || '',
        type: 'IN', // รับเข้า (+IN)
        docType: 'GRN',
        docNo: grnNo, // เช่น GRN-PO-PD-2026-003-01
        documentNo: grnNo,
        grnNo: grnNo,
        grnNumber: grnNo,
        poNo: po.poNo || po.id, // เช่น PO-PD-2026-003
        poNumber: po.poNo || po.id,
        prNo: po.prNo || po.prNumber || '',
        quantity: receivedStockQty, // จำนวนในหน่วยสต็อก (เช่น +20 ชิ้น)
        qty: receivedStockQty,
        receivedQty: goodQty, // จำนวนหน่วยจัดซื้อ (เช่น 10 คู่)
        unit: prod.stockUnit || prod.unit || item.stockUnit || item.unit || 'ชิ้น',
        stockUnit: prod.stockUnit || prod.unit || item.stockUnit || item.unit || 'ชิ้น',
        purchaseUnit: prod.purchaseUnit || item.purchaseUnit || 'คู่',
        conversionRate,
        conversionRatio: conversionRate,
        balanceAfter: Number(newBalance), // ยอดหลังรับ (เช่น 36)
        balanceStock: Number(newBalance),
        balance: Number(newBalance),
        unitPrice: Number(unitCostInStock), // ต้นทุนต่อหน่วยสต็อก (เช่น ฿50.00 / ชิ้น)
        baseUnitCost: Number(unitCostInStock),
        appliedAvgCost: Number(newAverageCost), // ต้นทุนเฉลี่ยใหม่หลังรวมล็อตนี้
        totalAmount: Number(receivedPoItemTotal), // มูลค่าเงินตาม PO จริง (เช่น 1,000.00 ฿)
        totalPrice: Number(receivedPoItemTotal),
        totalValue: Number(receivedPoItemTotal),
        actorName,
        user: actorName,
        actorRole,
        department: po.department || prod.department || 'PD',
        location: prod.locationName || prod.storageLocationName || 'ออฟฟิศ PD',
        locationName: prod.locationName || prod.storageLocationName || 'ออฟฟิศ PD',
        notes: `ตรวจรับสินค้าตามใบสั่งซื้อ ${po.poNo} (${vendorName})`,
        note: `ตรวจรับสินค้าตามใบสั่งซื้อ ${po.poNo} (${vendorName})`,
        createdAt: new Date().toISOString()
      };

      movements.push(movementRecord);
    });

    if (movements.length > 0) {
      const allLogs = storageService.getStockLogs() || [];
      const updatedLogs = [...movements, ...allLogs];
      storageService.saveStockLogs(updatedLogs);
      
      // Save updated products (MAC)
      storageService.saveProducts(products);

      // Sync to local server
      try {
        fetch('/api/stock-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedLogs)
        }).catch(() => {});
      } catch {}
    }

    return movements;
  }
};

export default inventoryService;
