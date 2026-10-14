import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { useAppContext } from './AppContext';
import { storageService, isGAS, callGAS } from '../services/storageService';
import { apiService } from '../services/apiService';
import { PO_STATUS } from '../config/constants';
import { hasUnresolvedClaim } from '../views/OnlineTaskView';
import { calculateCompletedKPIs, parseOrderYearMonth } from '../views/procurement/OnlineProcurementHub';
import { budgetService } from '../services/budgetService';
import { generateGRNNumber } from '../services/warehouseService';

const ProcurementContext = createContext(null);

export { calculateCompletedKPIs, parseOrderYearMonth };

export function filterCompletedPOsByMonth(pos, selectedMonth) {
  return (pos || []).filter(po => {
    const statusUpper = String(po.status || '').toUpperCase();
    const poHasClaim = hasUnresolvedClaim(po);
    const isClosed = !poHasClaim && (
      statusUpper === 'COMPLETED' ||
      statusUpper === 'CLOSED' ||
      isOrderClosed(statusUpper) ||
      Boolean(po.isClosed)
    );
    if (!isClosed) return false;
    if (!selectedMonth || selectedMonth === 'ALL') return true;
    const orderDateStr = po.completedAt || po.updatedAt || po.orderDate || po.createdAt || '';
    const { year, ymKey } = parseOrderYearMonth(orderDateStr);
    if (selectedMonth === 'ALL_YEAR') {
      const targetYear = 2026;
      return year === targetYear;
    }
    return ymKey === selectedMonth;
  });
}

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

/**
 * Standalone & Context-Shared recordGoodsReceipt implementation
 */
export async function recordGoodsReceipt(poId, grnPayload = {}) {
  const pos = storageService.getPOs() || [];
  const targetIdx = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
  if (targetIdx === -1) {
    throw new Error(`ไม่พบเอกสาร PO รหัส ${poId} ในระบบ`);
  }

  const currentPO = { ...pos[targetIdx] };
  const currentItems = Array.isArray(currentPO.items) ? [...currentPO.items] : [];
  const incomingItems = grnPayload.receivingItems || grnPayload.items || [];

  const receiptMap = new Map();
  incomingItems.forEach((inc, idx) => {
    const key = inc.productId || inc.id || inc.code || String(idx);
    receiptMap.set(key, inc);
  });

  let hasAnyShortage = false;
  let hasAnyClaim = false;
  let allReceived = true;

  const roundSummary = [];

  // Update PO line-item contracts: orderedQty, receivedQty, damagedQty, shortageQty
  const updatedItems = currentItems.map((item, idx) => {
    const matchKey = item.productId || item.id || item.code || String(idx);
    const inc = receiptMap.get(matchKey) || receiptMap.get(item.productId) || {};

    const refInfo = getEffectiveRefund(item, currentPO);
    const orderedQty = Number(item.orderedQty ?? item.quantity ?? item.purchaseQty ?? item.qty) || 0;
    const prevReceived = Number(item.accumulatedReceived ?? item.receivedQty) || 0;
    const prevDamaged = Number(item.damagedQty ?? item.claimedQty ?? item.ngQty) || 0;
    const refundedQty = refInfo.refundedQty;
    const refundAmount = refInfo.refundAmount || item.refundAmount;
    const isItemRefunded = refInfo.isRefunded;

    const allowedReceiveQty = Math.max(0, orderedQty - prevReceived - refundedQty);

    let thisReceived = inc.goodQty !== undefined 
      ? Number(inc.goodQty) 
      : (inc.acceptedQty !== undefined 
          ? Number(inc.acceptedQty) 
          : Number(inc.receivedThisTime ?? inc.receivedQty ?? inc.qty ?? 0));
    let thisDamaged = Number(inc.damagedQty ?? inc.claimedQty ?? inc.ngQty) || 0;

    // Defensive validation: rows with remaining 0 submit zero
    if (allowedReceiveQty === 0) {
      thisReceived = 0;
      thisDamaged = 0;
    } else {
      thisReceived = Math.max(0, Math.min(thisReceived, allowedReceiveQty));
      thisDamaged = Math.max(0, Math.min(thisDamaged, allowedReceiveQty - thisReceived));
    }

    const newReceived = prevReceived + thisReceived;
    const newDamaged = prevDamaged + thisDamaged;
    const shortageQty = (inc.goodQty !== undefined || inc.acceptedQty !== undefined)
      ? Math.max(0, orderedQty - newReceived - refundedQty - newDamaged)
      : Math.max(0, orderedQty - newReceived - refundedQty);

    const isDamaged = newDamaged > 0;
    const shortageAction = inc.shortageAction || (inc.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (shortageQty > 0 ? 'CLAIM_SHORTAGE' : ''));
    const isWaitNextRound = shortageAction === 'WAIT_NEXT_ROUND' || inc.shortageReason === 'SPLIT_SHIPMENT' || inc.disputeAction === 'WAIT_NEXT_ROUND';
    const hasDispute = isDamaged || (shortageQty > 0 && shortageAction === 'CLAIM_SHORTAGE');
    const disputeAction = isWaitNextRound ? 'WAIT_NEXT_ROUND' : (hasDispute ? 'CLAIM' : 'NONE');

    if (hasDispute) hasAnyClaim = true;
    if (shortageQty > 0 || hasDispute || thisDamaged > 0 || newDamaged > 0 || (newReceived + refundedQty < orderedQty)) {
      allReceived = false;
    }
    if (shortageQty > 0) {
      hasAnyShortage = true;
    }

    roundSummary.push({
      productId: item.productId,
      name: item.name,
      code: item.code,
      orderedQty,
      receivedThisRound: thisReceived,
      damagedThisRound: thisDamaged,
      accumulatedReceived: newReceived,
      accumulatedDamaged: newDamaged,
      shortageQty,
      condition: inc.condition || (thisDamaged > 0 ? 'DAMAGED' : shortageQty > 0 ? 'SHORTAGE' : 'GOOD'),
      defectReason: inc.defectReason || inc.note || ''
    });

    return {
      ...item,
      orderedQty,
      receivedQty: newReceived,
      goodQty: newReceived,
      acceptedQty: newReceived,
      accumulatedReceived: newReceived,
      damagedQty: newDamaged,
      shortageQty,
      remainingQty: shortageQty,
      refundedQty,
      refundAmount: refundAmount || item.refundAmount,
      isSettled: isItemRefunded ? true : (hasDispute ? false : item.isSettled),
      claimResolution: isItemRefunded ? 'REFUND' : (hasDispute ? null : item.claimResolution),
      replacementPendingQty: hasDispute ? 0 : item.replacementPendingQty,
      isDamaged,
      hasDispute,
      disputeAction,
      shortageAction,
      shortageReason: inc.shortageReason || (shortageAction === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : (shortageAction === 'CLAIM_SHORTAGE' ? 'VENDOR_SHORTAGE' : (item.shortageReason || ''))),
      defectReason: inc.defectReason || item.defectReason || '',
      conversionRate: Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1
    };
  });

  // Determine status based on delivery round results
  let nextStatus = currentPO.status;
  if (grnPayload.statusOverride) {
    nextStatus = grnPayload.statusOverride;
  } else if (hasAnyClaim) {
    nextStatus = 'PARTIALLY_RECEIVED_IN_CLAIM';
  } else if (hasAnyShortage) {
    nextStatus = grnPayload.waitingRound2 ? 'WAITING_DELIVERY_ROUND_2' : 'PARTIAL';
  } else if (allReceived) {
    nextStatus = 'COMPLETED';
  }

  const isCompletedReceipt = !hasAnyClaim && grnPayload.statusOverride !== 'CLAIM_PENDING' && (allReceived || nextStatus === 'CLOSED' || nextStatus === 'COMPLETED');
  if (isCompletedReceipt && !grnPayload.statusOverride) {
    nextStatus = 'COMPLETED';
  }

  const receiptRound = grnPayload.round || (currentPO.grnHistory?.length || 0) + 1;
  const grnNumber = grnPayload.grnNumber || grnPayload.grNumber || grnPayload.grId || generateGRNNumber(currentPO.poNo || currentPO.id, receiptRound);
  const timestamp = grnPayload.receivedDate || grnPayload.date || new Date().toLocaleString('th-TH');
  const receivedAtIso = grnPayload.receivingInfo?.receivedAt || new Date().toISOString();

  const receiverName = grnPayload.receivingInfo?.receiverName || 
    (typeof grnPayload.receivedBy === 'string' ? grnPayload.receivedBy.split(' (')[0] : (grnPayload.receivedBy?.name || 'คุณวิชัย สุขใจ'));
  const receiverSig = grnPayload.receivingInfo?.receiverSignature || 
    grnPayload.receiverSignature || 
    storageService.getSignatureByRole?.('REQUESTER_PD')?.signatureUrl || 
    storageService.getSignatures?.()?.['REQUESTER_PD']?.signatureUrl || 
    '/signatures/receiver-default.png';

  const grnEntry = {
    grnNumber,
    round: grnPayload.round || (currentPO.grnHistory?.length || 0) + 1,
    date: timestamp,
    receivedBy: grnPayload.receivedBy || 'Staff',
    items: roundSummary,
    note: grnPayload.note || '',
    attachments: grnPayload.attachments || [],
    statusAfterRound: nextStatus
  };

    const updatedStoreClaims = { ...(currentPO.storeClaims || {}) };
    if (hasAnyClaim || grnPayload.statusOverride === 'CLAIM_PENDING') {
      currentItems.forEach((item, idx) => {
        const matchKey = item.productId || item.id || item.code || String(idx);
        const inc = receiptMap.get(matchKey) || receiptMap.get(item.productId) || {};
        const dam = Number(inc.damagedQty ?? inc.claimedQty ?? inc.ngQty) || 0;
        const sho = Number(inc.shortageQty) || 0;
        const sAct = inc.shortageAction || '';
        const isDisputed = dam > 0 || (sho > 0 && sAct === 'CLAIM_SHORTAGE');
        if (isDisputed) {
          const sName = (item.actualStoreName || item.storeName || currentPO.actualStoreName || currentPO.storeName || currentPO.shopName || currentPO.vendorName || '').trim();
          const plat = (item.storePlatform || item.platform || currentPO.storePlatform || currentPO.platform || 'Shopee').trim();
          const sKey = sName ? `${plat}_${sName.toLowerCase()}` : (item.storeKey || `Shopee_item_${idx}`);
          const resetEntry = {
            isResolved: false,
            status: 'PENDING_CLAIM',
            claimStatus: 'PENDING_CLAIM',
            type: null,
            actionType: null,
            reason: dam > 0 ? 'สินค้าชำรุด / แตกหักเสียหาย' : 'ร้านส่งของไม่ครบตามกล่อง (ขาดส่ง)',
            description: inc.defectReason || inc.note || '',
            defectNote: inc.defectReason || inc.note || ''
          };
          if (sKey) updatedStoreClaims[sKey] = resetEntry;
          if (sName && sName !== sKey) updatedStoreClaims[sName] = resetEntry;
        }
      });
    }

    const updatedPO = {
      ...currentPO,
      items: updatedItems,
      status: nextStatus,
      hasGRN: true,
      hasDispute: hasAnyClaim,
      isInClaim: hasAnyClaim,
      hasUnresolvedClaim: hasAnyClaim,
      isCompleted: !hasAnyClaim && allReceived,
      isClosed: !hasAnyClaim && (allReceived || nextStatus === 'CLOSED' || nextStatus === 'COMPLETED'),
      claimStatus: hasAnyClaim ? 'PENDING_CLAIM' : (currentPO.claimStatus || 'NONE'),
      storeClaims: updatedStoreClaims,
      grnHistory: [...(currentPO.grnHistory || []), grnEntry],
    ...(isCompletedReceipt ? {
      receivingInfo: {
        receiverName,
        receiverSignature: receiverSig,
        receivedAt: receivedAtIso
      },
      receivedBy: receiverName,
      receiverName,
      receiverSignature: receiverSig,
      receivedAt: receivedAtIso
    } : {}),
    activityLog: [
      ...(currentPO.activityLog || []),
      {
        action: `ตรวจรับสินค้าแยกรอบ (GRN: ${grnNumber})`,
        user: typeof grnPayload.receivedBy === 'string' ? grnPayload.receivedBy : (grnPayload.receivedBy?.name || 'Staff'),
        timestamp,
        note: grnPayload.note || `บันทึกการตรวจรับรอบที่ ${grnEntry.round} สถานะเอกสาร: ${nextStatus}`
      }
    ]
  };

  pos[targetIdx] = updatedPO;
  storageService.savePOs(pos);

  // STRICT SSOT: We no longer call apiReceivePO or apiService.receiveGoods here.
  // Stock is handled exclusively by storageService.logStockMovements.
  // PO saving is handled by the caller (e.g. ReceivingModal) via apiService.updatePO/callGAS('apiReceivePO').

  return { success: true, po: updatedPO, grn: grnEntry };
}

export function isOrderClosed(status) {
  if (!status) return false;
  const s = String(status).toUpperCase();
  return ['COMPLETED', 'CLOSED', 'COMPLETED_DELIVERY', 'CLOSED_ORDER', 'FINISHED', 'RESOLVED', 'CANCELLED'].includes(s) || s.startsWith('COMPLETED') || s.startsWith('CLOSED');
}

export function calculateActiveClaimCount(orders = []) {
  return (orders || []).filter(po => {
    if (!po) return false;
    const statusUpper = String(po.status || '').toUpperCase();
    if (isOrderClosed(statusUpper) || po.claimStatus === 'RESOLVED' || po.claimStatus === 'REFUNDED') return false;

    return hasUnresolvedClaim(po);
  }).length;
}

export function calculatePendingActionCount(orders = [], prs = []) {
  const pendingOrders = (orders || []).filter(po => {
    if (!po) return false;
    const s = String(po.status || '').toLowerCase();
    const statusUpper = s.toUpperCase();
    if (isOrderClosed(statusUpper)) return false;

    return (
      po.status === 'PENDING_ORDER' ||
      po.status === 'PENDING' ||
      statusUpper === 'PENDING_ORDER' ||
      statusUpper === 'PENDING' ||
      statusUpper === 'WAITING_PURCHASE' ||
      statusUpper === 'WAITING_ORDER' ||
      statusUpper === 'IN_PROGRESS_ONLINE' ||
      ['in_progress_online', 'waiting_order', 'waiting', 'waiting_purchase', 'issued', 'รอดำเนินการ', 'รอดำเนินการสั่งซื้อ'].includes(s)
    );
  });

  const pendingPRs = (prs || []).filter(pr => {
    if (!pr) return false;
    const s = String(pr.status || '').toLowerCase();
    const statusUpper = s.toUpperCase();
    if (isOrderClosed(statusUpper)) return false;

    const isOnline = pr.purchaseChannel === 'ONLINE' || pr.channel === 'ONLINE';
    const isPendingPR = (
      pr.status === 'WAITING_PURCHASE' ||
      statusUpper === 'WAITING_PURCHASE' ||
      statusUpper === 'PENDING_ORDER' ||
      statusUpper === 'PENDING_PURCHASE' ||
      s === 'waiting_purchase' ||
      s === 'รอดำเนินการสั่งซื้อ'
    );
    return isOnline && isPendingPR;
  });

  return pendingOrders.length + pendingPRs.length;
}

export function calculateUrgentTaskCount(orders = [], prs = []) {
  const pendingActionCount = calculatePendingActionCount(orders, prs);
  const activeClaimCount = calculateActiveClaimCount(orders);
  return Number(pendingActionCount || 0) + Number(activeClaimCount || 0);
}

export function ProcurementProvider({ children }) {
  let app = null;
  try {
    app = useAppContext();
  } catch {
    app = null;
  }

  React.useEffect(() => {
    budgetService.syncSettledRefundsToBudget();
  }, []);

  const handleRecordGoodsReceipt = useCallback(async (poId, grnPayload) => {
    if (app?.recordGoodsReceipt) {
      return app.recordGoodsReceipt(poId, grnPayload);
    }
    return recordGoodsReceipt(poId, grnPayload);
  }, [app]);

  const rawPOs = app?.pos || storageService.getPOs() || [];
  const rawPRs = app?.prs || storageService.getPRs?.() || [];
  const activeClaimCount = useMemo(() => calculateActiveClaimCount(rawPOs), [rawPOs]);
  const pendingActionCount = useMemo(() => calculatePendingActionCount(rawPOs, rawPRs), [rawPOs, rawPRs]);
  const urgentTaskCount = useMemo(() => Number(pendingActionCount || 0) + Number(activeClaimCount || 0), [pendingActionCount, activeClaimCount]);

  const value = useMemo(() => ({
    pos: app?.pos || storageService.getPOs() || [],
    prs: app?.prs || storageService.getPRs?.() || [],
    activeClaimCount,
    claimCount: activeClaimCount,
    pendingActionCount,
    urgentTaskCount,
    calculateActiveClaimCount,
    calculatePendingActionCount,
    calculateUrgentTaskCount,
    isOrderClosed,
    setPOs: app?.setPOs || ((pos) => storageService.savePOs(pos)),
    updatePO: (poId, updates) => {
      if (app?.updatePO) {
        app.updatePO(poId, updates);
      }
      const pos = storageService.getPOs() || [];
      const idx = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
      if (idx !== -1) {
        pos[idx] = { ...pos[idx], ...updates };
        storageService.savePOs(pos);
      }
    },
    getPOById: (poId) => {
      const list = app?.pos || storageService.getPOs() || [];
      return list.find(p => p.id === poId || p.poNo === poId || p.poNumber === poId) || null;
    },
    recordGoodsReceipt: handleRecordGoodsReceipt,
    filterCompletedPOsByMonth,
    calculateCompletedKPIs,
    getCompletedPOsByMonth: (m, opt) => storageService.getCompletedPOsByMonth(m, opt),
    PO_STATUS
  }), [app, handleRecordGoodsReceipt, activeClaimCount, pendingActionCount, urgentTaskCount]);

  return (
    <ProcurementContext.Provider value={value}>
      {children}
    </ProcurementContext.Provider>
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

export const useProcurementContext = () => {
  let context = null;
  if (hasHookDispatcher()) {
    try {
      context = useContext(ProcurementContext);
    } catch {
      context = null;
    }
  }

  if (!context) {
    const pos = storageService.getPOs() || [];
    const prs = storageService.getPRs?.() || [];
    const activeClaimCount = calculateActiveClaimCount(pos);
    const pendingActionCount = calculatePendingActionCount(pos, prs);
    const urgentTaskCount = Number(pendingActionCount || 0) + Number(activeClaimCount || 0);
    return {
      pos,
      prs,
      activeClaimCount,
      claimCount: activeClaimCount,
      pendingActionCount,
      urgentTaskCount,
      calculateActiveClaimCount,
      calculatePendingActionCount,
      calculateUrgentTaskCount,
      isOrderClosed,
      filterCompletedPOsByMonth,
      calculateCompletedKPIs,
      getCompletedPOsByMonth: (m, opt) => storageService.getCompletedPOsByMonth(m, opt),
      setPOs: (newPos) => storageService.savePOs(newPos),
      updatePO: (poId, updates) => {
        const pList = storageService.getPOs() || [];
        const idx = pList.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
        if (idx !== -1) {
          pList[idx] = { ...pList[idx], ...updates };
          storageService.savePOs(pList);
        }
      },
      getPOById: (poId) => (storageService.getPOs() || []).find(p => p.id === poId || p.poNo === poId || p.poNumber === poId) || null,
      recordGoodsReceipt,
      PO_STATUS
    };
  }
  return context;
};

export default ProcurementContext;
