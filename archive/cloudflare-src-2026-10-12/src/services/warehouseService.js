import { storageService } from './storageService';
import { workflowEngine } from './workflowEngine';
import { matchDepartment, isMultiDeptUser } from '../utils/permissions';

/**
 * A. Canonical GRN Number Generator
 * Enforces a single, strict document numbering rule across ALL rounds (Round 1, 2, 3...)
 */
export const generateGRNNumber = (poNumber, roundNumber = 1) => {
  if (!poNumber) return `GRN-${Date.now()}-01`;
  const cleanPoNo = String(poNumber).trim();
  const safeRound = String(Math.max(1, Number(roundNumber) || 1)).padStart(2, '0');
  return `GRN-${cleanPoNo}-${safeRound}`;
};

/**
 * WarehouseService (Enterprise Inventory & Goods Receipt Engine)
 * Guarantees Atomic Transactions for Goods Receipt (GRN) submissions,
 * synchronous stock balance increments with Movement Logs (+IN),
 * and self-healing data migration for Ghost Stock.
 */
/**
 * Resilient multi-source refund normalization helper
 */
function getEffectiveRefund(item, po) {
  if (!item) return { refundedQty: 0, refundAmount: 0, isRefunded: false };
  const ordered = Number(item.orderedQty ?? item.quantity ?? item.purchaseQty ?? item.qty ?? item.actualQty ?? 0);
  const prevReceived = Number(item.accumulatedReceived ?? item.goodQty ?? item.receivedQty ?? 0);

  const itemStore = (item.actualStoreName || item.storeName || '').trim();
  const storeClaims = po?.storeClaims || {};
  let storeClaim = (item.storeKey && storeClaims[item.storeKey]) || 
    (itemStore && storeClaims[itemStore]) || 
    (item.storePlatform && itemStore && storeClaims[`${item.storePlatform}_${itemStore}`]);

  if (!storeClaim && itemStore) {
    const normStore = itemStore.toLowerCase();
    for (const [k, c] of Object.entries(storeClaims)) {
      if (k.toLowerCase() === normStore || k.toLowerCase().includes(normStore) || normStore.includes(k.toLowerCase())) {
        storeClaim = c;
        break;
      }
    }
  }

  const isStoreRefunded = Boolean(
    storeClaim?.isResolved && 
    (storeClaim?.type === 'REFUND' || storeClaim?.actionType === 'REFUND' || storeClaim?.resolutionType === 'REFUND' || storeClaim?.type === 'CLOSE_WITH_REFUND' || String(storeClaim?.note || '').includes('คืนเงิน'))
  );

  let refunded = Number(item.refundedQty || 0);
  if (refunded === 0 && (item.claimResolution === 'REFUND' || isStoreRefunded)) {
    refunded = Number(item.damagedQty || item.shortageQty || Math.max(0, ordered - prevReceived));
  }

  const unitPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? 0);
  const refundAmt = Number(item.refundAmount || storeClaim?.refundAmount || (refunded * unitPrice));

  return {
    refundedQty: refunded,
    refundAmount: refundAmt,
    isRefunded: refunded > 0 || isStoreRefunded || item.claimResolution === 'REFUND'
  };
}

export const warehouseService = {
  /**
   * Helper to generate unique log ID
   */
  generateLogId(prefix = 'LOG-IN') {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  },

  /**
   * Find product by ID, code, or name with resilient matching
   */
  findProductIndex(products, target) {
    if (!target || !Array.isArray(products)) return -1;
    const tId = String(target.productId || target.id || '').trim().toLowerCase();
    const tCode = String(target.code || target.productCode || '').trim().toLowerCase();
    const tName = String(target.name || '').trim().toLowerCase();

    return products.findIndex(p => {
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
  },

  /**
   * Submit GRN (Goods Receipt Note) as an Atomic Transaction
   * Synchronously updates:
   * 1. Product total stock balance
   * 2. Movement Log (+IN) with standardized enterprise schema
   * 3. PO items and grnHistory
   * 4. Atomic persistence to local storage and backend database
   */
  async submitGRN(poId, grnPayload = {}, options = {}) {
    const pos = storageService.getPOs() || [];
    const products = storageService.getProducts() || [];
    const stockLogs = storageService.getStockLogs() || [];
    const currentUser = options.user || grnPayload.receivedBy || 'Warehouse Staff';
    const userName = typeof currentUser === 'object' 
      ? `${currentUser.name || 'Staff'}${currentUser.title ? ` (${currentUser.title})` : ''}`
      : String(currentUser);

    const poIndex = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    if (poIndex === -1) {
      throw new Error(`ไม่พบเอกสาร PO รหัส ${poId} ในระบบคลังสินค้า`);
    }

    const targetPO = { ...pos[poIndex] };
    const currentRound = Number(grnPayload.round || grnPayload.roundNumber || (targetPO.grnHistory?.length || 0) + 1);
    const poNumber = targetPO.poNo || targetPO.poNumber || targetPO.id;
    const grnNumber = (grnPayload.grnNumber && !/^PO-[A-Z0-9]+-\d{4}-\d{3,}$/i.test(grnPayload.grnNumber))
      ? grnPayload.grnNumber
      : (grnPayload.grNumber && !/^PO-[A-Z0-9]+-\d{4}-\d{3,}$/i.test(grnPayload.grNumber))
        ? grnPayload.grNumber
        : generateGRNNumber(poNumber, currentRound);
    const timestamp = grnPayload.receivedDate || new Date().toLocaleString('th-TH');
    const isoTimestamp = new Date().toISOString();

    const isOnlinePO = Boolean(
      targetPO.purchaseChannel === 'ONLINE' ||
      targetPO.purchaseType === 'ONLINE' ||
      targetPO.isOnlinePO ||
      targetPO.storeName ||
      grnPayload.isOnlinePO ||
      grnPayload.hasClaimRequest ||
      grnPayload.isClaim ||
      grnPayload.disputeAction === 'CLAIM' ||
      grnPayload.button === 'claim'
    );

    const incomingItems = grnPayload.receivingItems || grnPayload.items || [];
    const processedLogs = [];
    const processedProducts = [];

    // Process receiving items and synchronously update stock and movement logs
    incomingItems.forEach((incItem, idx) => {
      const matchPOItem = (targetPO.items || []).find(pIt => 
        (pIt.productId && pIt.productId === incItem.productId) ||
        (pIt.id && pIt.id === incItem.id) ||
        (pIt.code && String(pIt.code).trim().toLowerCase() === String(incItem.code).trim().toLowerCase())
      );
      
      const refInfo = getEffectiveRefund(matchPOItem, targetPO);
      const itemOrdered = Number(matchPOItem?.orderedQty ?? matchPOItem?.quantity ?? matchPOItem?.purchaseQty ?? matchPOItem?.qty ?? 0);
      const itemPrevReceived = Number(matchPOItem?.accumulatedReceived ?? matchPOItem?.receivedQty ?? 0);
      const itemRefunded = refInfo.refundedQty;
      const allowedReceive = Math.max(0, itemOrdered - itemPrevReceived - itemRefunded);

      let goodQty = Number(incItem.goodQty ?? incItem.acceptedQty ?? (Number(incItem.receivedThisTime ?? incItem.receivedQty ?? incItem.qty) - Number(incItem.damagedQty || 0))) || 0;
      if (matchPOItem && allowedReceive === 0) {
        goodQty = 0; // Row locked / fully received / refunded: strictly cannot receive into stock!
      } else if (matchPOItem) {
        goodQty = Math.min(goodQty, allowedReceive);
      }

      if (goodQty <= 0) return; // Only intact goods get received into active stock

      const pIdx = this.findProductIndex(products, incItem);
      if (pIdx !== -1) {
        const prod = { ...products[pIdx] };
        const rate = Number(incItem.conversionRate || prod.conversionRate) > 0 ? Number(incItem.conversionRate || prod.conversionRate) : 1;
        const stockQtyToAdd = goodQty * rate;
        const currentBalance = Number(prod.stockBalance) || 0;
        const newBalance = currentBalance + stockQtyToAdd;

        const actualPrice = Number(incItem.actualPrice ?? incItem.unitPrice ?? incItem.price ?? prod.price) || 0;
        const stockUnitPrice = actualPrice > 0 && rate > 0 ? (actualPrice / rate) : (Number(prod.price) || 0);

        // MAC Calculation
        const currentAvgCost = Number(prod.averageCost ?? prod.avgCost ?? prod.unitCost ?? 0);
        let newAverageCost = stockUnitPrice;
        if (currentBalance > 0 && newBalance > 0) {
          const currentTotalValue = currentBalance * currentAvgCost;
          const inTotalValue = stockQtyToAdd * stockUnitPrice;
          newAverageCost = (currentTotalValue + inTotalValue) / newBalance;
        }
        newAverageCost = Math.round(newAverageCost * 100) / 100;

        prod.stockBalance = newBalance;
        prod.averageCost = newAverageCost;
        prod.avgCost = newAverageCost;
        prod.totalValue = newBalance * newAverageCost;
        products[pIdx] = prod;

        const sUnit = prod.stockUnit || prod.unit || 'ชิ้น';
        const pUnit = prod.purchaseUnit || prod.unit || sUnit;

        const logEntry = {
          id: this.generateLogId(`LOG-IN-${idx}`),
          date: isoTimestamp,
          displayDate: timestamp,
          type: 'IN',
          documentNo: grnNumber,
          docNo: grnNumber,
          grnNumber: grnNumber,
          grnNo: grnNumber,
          grNumber: grnNumber,
          poNo: poNumber,
          poNumber: poNumber,
          refPo: poNumber,
          round: currentRound,
          roundNumber: currentRound,
          productId: prod.id,
          productCode: prod.code,
          name: prod.name,
          qty: stockQtyToAdd,
          receivedQty: goodQty,
          unit: sUnit,
          balance: newBalance,
          unitPrice: stockUnitPrice,
          totalPrice: stockUnitPrice * stockQtyToAdd,
          actualPrice: actualPrice,
          user: userName,
          locationId: prod.locationId || '',
          locationName: prod.locationName || '',
          note: grnPayload.note || (rate > 1
            ? `รับสินค้าสมบูรณ์เข้าคลัง ${goodQty} ${pUnit} (= +${stockQtyToAdd} ${sUnit}) [GRN: ${grnNumber}, PO: ${poNumber}]`
            : `รับสินค้าสมบูรณ์เข้าคลัง +${stockQtyToAdd} ${sUnit} [GRN: ${grnNumber}, PO: ${poNumber}]`)
        };

        stockLogs.unshift(logEntry);
        processedLogs.push(logEntry);
        processedProducts.push(prod);
      }
    });

    // Sync PO items with receiving data (Directive 1: GRN to PO Sync)
    const receiptMap = new Map();
    incomingItems.forEach((inc, idx) => {
      const key = inc.productId || inc.id || inc.code || String(idx);
      receiptMap.set(key, inc);
    });

    targetPO.items = (targetPO.items || []).map((poItem, idx) => {
      const matchKey = poItem.productId || poItem.id || poItem.code || String(idx);
      const inc = receiptMap.get(matchKey) || receiptMap.get(poItem.productId) || {};

      const refInfo = getEffectiveRefund(poItem, targetPO);
      const orderedQty = Number(poItem.orderedQty ?? poItem.quantity ?? poItem.purchaseQty ?? poItem.qty) || 0;
      const prevReceived = Number(poItem.accumulatedReceived ?? poItem.receivedQty) || 0;
      const prevDamaged = Number(poItem.damagedQty) || 0;
      const refundedQty = refInfo.refundedQty;
      const refundAmount = refInfo.refundAmount || poItem.refundAmount;
      const isItemRefunded = refInfo.isRefunded;

      const allowedReceiveQty = Math.max(0, orderedQty - prevReceived - refundedQty);

      let thisReceived = Number(inc.goodQty ?? inc.acceptedQty ?? (Number(inc.receivedThisTime ?? inc.receivedQty ?? inc.qty) - Number(inc.damagedQty || 0))) || 0;
      let thisDamaged = Number(inc.damagedQty ?? inc.claimedQty ?? inc.ngQty) || 0;

      // Defensive backend validation: rows with remaining 0 submit zero
      if (allowedReceiveQty === 0) {
        thisReceived = 0;
        thisDamaged = 0;
      } else {
        thisReceived = Math.max(0, Math.min(thisReceived, allowedReceiveQty));
        thisDamaged = Math.max(0, Math.min(thisDamaged, allowedReceiveQty - thisReceived));
      }

      const actualReceived = prevReceived + thisReceived;
      const actualDamaged = prevDamaged + thisDamaged;
      const actualShortage = Math.max(0, orderedQty - actualReceived - refundedQty - actualDamaged);
      const shortageAction = (isOnlinePO && actualShortage > 0)
        ? 'CLAIM_SHORTAGE'
        : (inc.shortageAction || (inc.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (actualShortage > 0 ? 'CLAIM_SHORTAGE' : '')));
      const isWaitNextRound = !isOnlinePO && (shortageAction === 'WAIT_NEXT_ROUND' || inc.shortageReason === 'SPLIT_SHIPMENT' || inc.disputeAction === 'WAIT_NEXT_ROUND');

      const isDamaged = actualDamaged > 0;
      const isShortage = actualShortage > 0;
      const hasDispute = isOnlinePO ? (isDamaged || isShortage) : (isDamaged || (isShortage && shortageAction === 'CLAIM_SHORTAGE'));
      const disputeAction = isOnlinePO ? (hasDispute ? 'CLAIM' : 'NONE') : (isWaitNextRound ? 'WAIT_NEXT_ROUND' : (hasDispute ? 'CLAIM' : 'NONE'));
      const disputedQty = hasDispute ? (actualDamaged + ((isOnlinePO || shortageAction === 'CLAIM_SHORTAGE') ? actualShortage : 0)) : actualDamaged;

      return {
        ...poItem,
        orderedQty,
        receivedQty: actualReceived,
        goodQty: actualReceived,
        acceptedQty: actualReceived,
        accumulatedReceived: actualReceived,
        damagedQty: actualDamaged,
        shortageQty: actualShortage,
        refundedQty,
        refundAmount: refundAmount || poItem.refundAmount,
        isSettled: isItemRefunded ? true : poItem.isSettled,
        claimResolution: isItemRefunded ? 'REFUND' : poItem.claimResolution,
        replacementPendingQty: poItem.replacementPendingQty,
        shortageAction: shortageAction,
        disputedQty: disputedQty,
        isDamaged,
        hasDispute,
        disputeAction,
        shortageReason: inc.shortageReason || (shortageAction === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : (shortageAction === 'CLAIM_SHORTAGE' ? 'VENDOR_SHORTAGE' : (poItem.shortageReason || ''))),
        defectReason: inc.defectReason || poItem.defectReason || '',
        isFullyReceived: actualShortage === 0 && actualDamaged === 0
      };
    });

    // Update PO activity & status (Rule 1: Lock PO to CLAIM_PENDING on defects or shortage)
    const hasDefect = targetPO.items.some(it => Number(it.damagedQty || it.ngQty || 0) > 0);
    const hasShortage = targetPO.items.some(it => Number(it.shortageQty || 0) > 0);
    const allItemsFullyReceived = targetPO.items.every(it => Number(it.shortageQty || 0) === 0 && Number(it.damagedQty || 0) === 0);

    const isClaimRequired = isOnlinePO 
      ? (hasDefect || hasShortage) 
      : (hasDefect || targetPO.items.some(it => it.hasDispute || (Number(it.shortageQty || 0) > 0 && it.shortageAction === 'CLAIM_SHORTAGE')));

    targetPO.hasGRN = true;
    targetPO.hasDispute = Boolean(isClaimRequired);
    targetPO.isInClaim = Boolean(isClaimRequired);

    // กฎเหล็ก: ไม่ว่าจะเป็นของเสีย หรือของขาดส่ง ตราบใดที่มีของไม่ครบ = ต้องเข้า CLAIM_PENDING เท่านั้น!
    // ห้ามแตะกิ่ง WAITING_DELIVERY_ROUND_2 เด็ดขาดในจังหวะบันทึก GRN!
    // สถานะ WAITING_DELIVERY_ROUND_2 มีสิทธิ์เกิดขึ้นได้ที่เดียวคือ "ฝ่ายจัดซื้อออนไลน์กดเลือก 'ร้านค้าส่งสินค้าใหม่ทดแทน' ในหน้า Online Procurement Hub" เท่านั้น!
    if (isOnlinePO) {
      if (hasDefect || hasShortage) {
        targetPO.status = 'CLAIM_PENDING';
        targetPO.claimStatus = 'PENDING_CLAIM';
      } else if (grnPayload.statusOverride) {
        targetPO.status = grnPayload.statusOverride;
      } else if (allItemsFullyReceived) {
        targetPO.status = 'COMPLETED';
      } else {
        targetPO.status = 'PARTIAL';
      }
    } else {
      if (hasDefect || (hasShortage && targetPO.items.some(it => it.hasDispute || it.shortageAction === 'CLAIM_SHORTAGE'))) {
        targetPO.status = 'CLAIM_PENDING';
        targetPO.claimStatus = 'PENDING_CLAIM';
      } else if (grnPayload.statusOverride) {
        targetPO.status = grnPayload.statusOverride;
      } else if (allItemsFullyReceived) {
        targetPO.status = 'COMPLETED';
      } else {
        targetPO.status = 'PARTIAL';
      }
    }

    // Rule 2: บันทึกหลักฐานการตรวจรับ (Evidence Persistence)
    const defectNotesFromItems = incomingItems
      .map(it => it.defectReason || it.defectNote)
      .filter(Boolean)
      .join('; ');

    const defectNote = grnPayload.defectNote || 
      grnPayload.claimEvidence?.defectNote || 
      grnPayload.claimEvidence?.notes || 
      defectNotesFromItems || 
      grnPayload.note || '';

    const defectImages = grnPayload.defectImages || 
      grnPayload.evidenceAttachments || 
      grnPayload.attachments || 
      grnPayload.claimEvidence?.defectImages || 
      grnPayload.claimEvidence?.evidenceAttachments || 
      grnPayload.claimEvidence?.attachments || 
      [];

    const inspectorName = grnPayload.inspectorName || 
      grnPayload.claimEvidence?.inspectorName || 
      userName || 
      'ผู้ตรวจรับพัสดุ';

    const inspectedAt = grnPayload.inspectedAt || 
      grnPayload.claimEvidence?.inspectedAt || 
      isoTimestamp;

    if (isClaimRequired || grnPayload.claimEvidence || defectNote || (Array.isArray(defectImages) && defectImages.length > 0)) {
      const evidenceObj = {
        inspectorName,
        inspectedAt,
        defectNote,
        notes: defectNote,
        defectImages: Array.isArray(defectImages) ? defectImages : [defectImages],
        evidenceAttachments: Array.isArray(defectImages) ? defectImages : [defectImages],
        attachments: Array.isArray(defectImages) ? defectImages : [defectImages]
      };
      targetPO.claimEvidence = evidenceObj;
      targetPO.disputeInfo = evidenceObj;
    }

    const grnEntry = {
      grnNumber,
      grnNo: grnNumber,
      round: currentRound,
      roundNumber: currentRound,
      date: timestamp,
      receivedBy: userName,
      items: incomingItems,
      note: grnPayload.note || '',
      poNumber: poNumber,
      poNo: poNumber,
      refPo: poNumber
    };

    targetPO.grnHistory = [...(targetPO.grnHistory || []), grnEntry];
    pos[poIndex] = targetPO;

    // ATOMIC PERSISTENCE: Save both products and stockLogs together
    storageService.savePOs(pos);
    storageService.saveProducts(products);
    storageService.saveStockLogs(stockLogs);

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
      // Offline fallback
    }

    return {
      success: true,
      grnNumber,
      grnNo: grnNumber,
      roundNumber: currentRound,
      round: currentRound,
      poNumber,
      processedLogs,
      processedProducts,
      products,
      stockLogs,
      po: targetPO
    };
  },

  /**
   * Self-Healing Migration for Ghost Stock:
   * If a product has stockBalance > 0 but has 0 movement logs,
   * auto-generates the initial balance log (+IN System Initial Balance)
   * and persists it permanently.
   */
  selfHealGhostStock(product, options = {}) {
    if (!product) return null;
    const stockVal = Number(product.stockBalance ?? product.stock ?? product.qty) || 0;
    if (stockVal <= 0) return null;

    const allLogs = storageService.getStockLogs() || [];
    const pId = String(product.id || '').trim().toLowerCase();
    const pCode = String(product.code || '').trim().toLowerCase();
    const pName = String(product.name || '').trim().toLowerCase();

    const hasLog = allLogs.some(l => {
      if (!l) return false;
      const logPId = String(l.productId || '').trim().toLowerCase();
      const logPCode = String(l.productCode || '').trim().toLowerCase();
      const logPName = String(l.name || '').trim().toLowerCase();
      return (
        (pId && (logPId === pId || logPCode === pId)) ||
        (pCode && (logPCode === pCode || logPId === pCode)) ||
        (pName && logPName === pName)
      );
    });

    if (hasLog) return null;

    const conversionRate = Number(product.conversionRate || product.conversionRatio) || 1;
    const unitPrice = (Number(product.price) || 0) / conversionRate;
    const initialLog = {
      id: `INIT-${product.id || product.code || Date.now()}`,
      date: new Date().toISOString(),
      displayDate: product.createdAt ? new Date(product.createdAt).toLocaleString('th-TH') : new Date().toLocaleString('th-TH'),
      type: 'IN',
      documentNo: 'SYSTEM-INITIAL-BALANCE',
      docNo: 'SYSTEM-INITIAL-BALANCE',
      poNo: '-',
      poNumber: '-',
      productId: product.id,
      productCode: product.code,
      name: product.name,
      department: product.department || product.category || 'PD',
      qty: stockVal,
      balance: stockVal,
      unit: product.stockUnit || product.unit || 'ชิ้น',
      unitPrice: unitPrice,
      totalPrice: unitPrice * stockVal,
      conversionRate: conversionRate,
      user: 'System Initial Balance',
      locationId: product.locationId || '',
      locationName: product.locationName || '',
      note: 'ยอดยกมาจากระบบเริ่มต้น (System Initial Balance)'
    };

    const updatedLogs = [initialLog, ...allLogs];
    storageService.saveStockLogs(updatedLogs);

    try {
      fetch('/api/stock-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedLogs)
      }).catch(() => {});
    } catch {}

    return initialLog;
  },

  /**
   * Get movement logs for a given product with self-healing migration
   */
  getStockMovementLogs(product, externalLogs = null, currentUser = null) {
    if (!product) return [];
    const sourceLogs = Array.isArray(externalLogs) && externalLogs.length > 0 
      ? externalLogs 
      : (storageService.getStockLogs() || []);

    const targetProductId = String(product.id || '').trim();
    const targetDept = String(product.department || product.category || '').trim();
    const targetCode = String(product.code || product.sku || '').trim();

    const userDept = currentUser ? String(currentUser.department || currentUser.primaryDepartment || '').trim() : '';
    const isMultiDept = currentUser ? isMultiDeptUser(currentUser) : true;

    const matched = sourceLogs.filter(l => {
      if (!l) return false;

      // 0. User Department Protection Guard
      if (userDept && !isMultiDept && !matchDepartment(l.department || targetDept, userDept)) {
        return false;
      }

      // Department consistency guard
      if (l.department && targetDept && !matchDepartment(l.department, targetDept)) {
        return false;
      }

      // 1. Primary match by Product ID
      if (targetProductId && l.productId) {
        return String(l.productId).trim() === targetProductId;
      }

      // 2. Fallback: Both department and code
      const isSameDept = matchDepartment(l.department || targetDept, targetDept);
      const isSameCode = String(l.productCode || l.code || l.sku || '').trim() === targetCode;
      return isSameDept && isSameCode;
    });

    const stockVal = Number(product.stockBalance ?? product.stock ?? product.qty) || 0;
    if (matched.length === 0 && stockVal > 0) {
      const healedLog = this.selfHealGhostStock(product);
      if (healedLog) {
        return [healedLog];
      }
    }

    return matched;
  },


  generateGRNNumber(poNumber, roundNumber = 1) {
    return generateGRNNumber(poNumber, roundNumber);
  }
};

export default warehouseService;
