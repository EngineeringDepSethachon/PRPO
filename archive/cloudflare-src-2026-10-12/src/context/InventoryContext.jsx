import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { useAppContext } from './AppContext';
import { storageService } from '../services/storageService';
import { apiService } from '../services/apiService';
import { generateGRNNumber } from '../services/warehouseService';

const InventoryContext = createContext(null);

/**
 * Standalone & Context-Shared receiveToStock implementation
 * Increments stockBalance strictly for complete, undamaged goods
 */
export async function receiveToStock(items, options = {}) {
  const incoming = Array.isArray(items) ? items : [items];
  const products = storageService.getProducts() || [];
  const stockLogs = storageService.getStockLogs() || [];
  const timestamp = options.date || new Date().toLocaleString('th-TH');
  const isoTimestamp = new Date().toISOString();

  const processedItems = [];

  incoming.forEach((item, idx) => {
    const orderedQty = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
    const receivedQty = Number(item.receivedThisTime ?? item.receivedQty ?? item.qty) || 0;
    const damagedQty = Number(item.damagedQty ?? item.claimedQty ?? item.ngQty) || 0;

    // Filter only complete / intact units
    const goodQty = Math.max(0, receivedQty - damagedQty);
    if (goodQty <= 0) {
      // Skip updating stockBalance for zero or 100% damaged units
      return;
    }

    const tId = String(item.productId || item.id || '').trim().toLowerCase();
    const tCode = String(item.code || item.productCode || '').trim().toLowerCase();
    const tName = String(item.name || '').trim().toLowerCase();

    const prodIdx = products.findIndex(p => {
      if (!p) return false;
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || '').trim().toLowerCase();
      const pName = String(p.name || '').trim().toLowerCase();
      return (
        (tId && (pId === tId || pCode === tId)) ||
        (tCode && (pCode === tCode || pId === tCode)) ||
        (tName && pName === tName)
      );
    });

    if (prodIdx !== -1) {
      const prod = { ...products[prodIdx] };
      const rate = Number(item.conversionRate || prod.conversionRate) > 0 ? Number(item.conversionRate || prod.conversionRate) : 1;
      const stockQtyToAdd = goodQty * rate;
      const currentBal = Number(prod.stockBalance) || 0;
      const newBal = currentBal + stockQtyToAdd;

      prod.stockBalance = newBal;
      products[prodIdx] = prod;

      const sUnit = prod.stockUnit || prod.unit || 'ชิ้น';
      const pUnit = prod.purchaseUnit || prod.unit || sUnit;
      const rawPo = options.poNo || options.poNumber || item.poNo || item.poNumber || (String(options.docNo || item.docNo || '').startsWith('PO-') ? (options.docNo || item.docNo) : '');
      const round = options.round || options.roundNumber || item.round || item.roundNumber || 1;
      const grNumber = (options.grNumber && options.grNumber.startsWith('GRN-'))
        ? options.grNumber
        : (options.grnNumber && options.grnNumber.startsWith('GRN-'))
          ? options.grnNumber
          : generateGRNNumber(rawPo, round);
      const docNo = grNumber;
      const poNumber = rawPo || '';
      const actualPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? prod.price) || 0;
      const stockUnitPrice = actualPrice > 0 && rate > 0 ? (actualPrice / rate) : (Number(prod.price) || 0);

      const logNote = rate > 1
        ? `รับสินค้าเข้าคลังเฉพาะยอดสมบูรณ์ ${goodQty} ${pUnit} (= +${stockQtyToAdd} ${sUnit}) จากเอกสาร ${grNumber}${rawPo ? ` (PO: ${rawPo})` : ''}`
        : `รับสินค้าเข้าคลังเฉพาะยอดสมบูรณ์ +${stockQtyToAdd} ${sUnit} จากเอกสาร ${grNumber}${rawPo ? ` (PO: ${rawPo})` : ''}`;

      const logEntry = {
        id: `LOG-IN-${Date.now()}-${idx}-${Math.floor(Math.random() * 1000)}`,
        date: isoTimestamp,
        displayDate: timestamp,
        productId: prod.id,
        productCode: prod.code,
        name: prod.name,
        type: 'IN',
        documentNo: grNumber,
        docNo: grNumber,
        grnNo: grNumber,
        grnNumber: grNumber,
        grNumber: grNumber,
        poNo: poNumber,
        poNumber: poNumber,
        refPo: poNumber,
        roundNumber: Number(round) || 1,
        qty: stockQtyToAdd,
        receivedQty: goodQty,
        unit: sUnit,
        balance: newBal,
        unitPrice: stockUnitPrice,
        totalPrice: stockUnitPrice * stockQtyToAdd,
        actualPrice: actualPrice,
        user: typeof options.user === 'object' ? `${options.user.name} (${options.user.title || ''})` : (options.user || 'Warehouse Staff'),
        locationId: prod.locationId || '',
        locationName: prod.locationName || '',
        note: options.note || logNote
      };

      stockLogs.unshift(logEntry);

      processedItems.push({
        productId: prod.id,
        code: prod.code,
        name: prod.name,
        goodQty,
        stockQtyAdded: stockQtyToAdd,
        previousBalance: currentBal,
        newBalance: newBal,
        log: logEntry
      });
    }
  });

  if (processedItems.length > 0) {
    storageService.saveProducts(products);
    storageService.saveStockLogs(stockLogs);

    // Atomic backend sync for both products and stock logs
    try {
      await Promise.all([
        fetch('/api/products/batch', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(products)
        }),
        fetch('/api/stock-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stockLogs)
        })
      ]);
    } catch {
      // Graceful offline fallback
    }
  }

  return {
    success: true,
    processedCount: processedItems.length,
    processedItems,
    products,
    stockLogs
  };
}

export function InventoryProvider({ children }) {
  let app = null;
  try {
    app = useAppContext();
  } catch {
    app = null;
  }

  const handleReceiveToStock = useCallback(async (items, options) => {
    if (app?.receiveToStock) {
      return app.receiveToStock(items, options);
    }
    return receiveToStock(items, options);
  }, [app]);

  const value = useMemo(() => ({
    products: app?.products || storageService.getProducts() || [],
    stockLogs: app?.stockLogs || storageService.getStockLogs() || [],
    storageLocations: app?.storageLocations || storageService.getStorageLocations() || [],
    receiveToStock: handleReceiveToStock,
    saveProduct: app?.saveProduct || apiService.saveProduct.bind(apiService),
    deleteProduct: app?.deleteProduct || apiService.deleteProduct.bind(apiService),
    quickIssueStock: app?.quickIssueStock || apiService.quickIssueStock.bind(apiService)
  }), [app, handleReceiveToStock]);

  return (
    <InventoryContext.Provider value={value}>
      {children}
    </InventoryContext.Provider>
  );
}

const hasHookDispatcher = () => {
  try {
    return Boolean(
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.H ||
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher?.current
    );
  } catch {
    return false;
  }
};

export const useInventoryContext = () => {
  let context = null;
  if (hasHookDispatcher()) {
    try {
      context = useContext(InventoryContext);
    } catch {
      context = null;
    }
  }

  if (!context) {
    const products = storageService.getProducts() || [];
    const stockLogs = storageService.getStockLogs() || [];
    return {
      products,
      stockLogs,
      receiveToStock,
      saveProduct: apiService.saveProduct.bind(apiService),
      deleteProduct: apiService.deleteProduct.bind(apiService),
      quickIssueStock: apiService.quickIssueStock.bind(apiService)
    };
  }
  return context;
};

export default InventoryContext;
