import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { apiService } from '../services/apiService';
import { useAppContext } from './AppContext';
import { modalService } from '../services/modalService';

const OnlineOrderContext = createContext(null);

export const PENDING_STATUSES = [
  'pending',
  'pending_order',
  'waiting_order',
  'waiting',
  'in_progress_online',
  'issued',
  'รอดำเนินการ',
  'รอดำเนินการสั่งซื้อ'
];

export const ORDERED_STATUSES = [
  'ordered',
  'ordered_pending_delivery',
  'in_delivery',
  'in_transit',
  'waiting_delivery',
  'waiting_delivery_round_2',
  'สั่งซื้อแล้ว',
  'สั่งซื้อแล้ว (ระหว่างส่ง)'
];

export const CLAIM_STATUSES = [
  'claim',
  'dispute',
  'in_claim',
  'partially_received_in_claim',
  'claim_reported',
  'claim_in_progress',
  'รอเคลมสินค้า'
];

export const CLOSED_STATUSES = [
  'closed',
  'completed',
  'resolved',
  'received',
  'fully_received',
  'completed_with_refund',
  'ปิดงาน',
  'ตรวจรับครบ'
];

/**
 * Check if an order is in pending order placement mode (Mode 1)
 */
export function isOrderPending(status) {
  if (!status) return true;
  const s = String(status).toLowerCase();
  return PENDING_STATUSES.includes(s);
}

/**
 * Check if an order is in claim mode (Mode 2)
 */
export function isOrderInClaim(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  if (isOrderPending(status) || isOrderClosed(status)) return false;
  return CLAIM_STATUSES.includes(s) || (s.includes('claim') && !s.includes('refund'));
}

/**
 * Check if an order is closed / completed
 */
export function isOrderClosed(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return CLOSED_STATUSES.includes(s) || s.startsWith('completed');
}

/**
 * Directive 2: Check if an item has a genuine dispute.
 * STRICT: An item CANNOT be in dispute if the PO is still pending order placement or not yet in claim mode!
 */
export function isItemDisputed(order, item) {
  if (!order || !item) return false;
  const status = String(order.status || '').toLowerCase();
  
  // An order must strictly be in claim status from GRN inspection
  const inClaimMode = isOrderInClaim(status);
  if (!inClaimMode) return false;

  return Boolean(
    Number(item.shortageQty) > 0 || 
    Number(item.damagedQty) > 0 || 
    item.claimStatus === 'PENDING'
  );
}

export function OnlineOrderProvider({ children }) {
  const { currentRole, currentUser, updatePO } = useAppContext();

  const confirmOrder = useCallback(async (po, finalItems, vendorName, varianceNote = '') => {
    const updatedPO = await apiService.acknowledgeOnlineTask(
      po.id,
      vendorName,
      currentRole || currentUser,
      finalItems,
      varianceNote
    );
    if (updatePO) updatePO(updatedPO);
    return updatedPO;
  }, [currentRole, currentUser, updatePO]);

  const value = useMemo(() => ({
    isOrderPending,
    isOrderInClaim,
    isOrderClosed,
    isItemDisputed,
    confirmOrder
  }), [confirmOrder]);

  return (
    <OnlineOrderContext.Provider value={value}>
      {children}
    </OnlineOrderContext.Provider>
  );
}

export function useOnlineOrder() {
  const context = useContext(OnlineOrderContext);
  return context || {
    isOrderPending,
    isOrderInClaim,
    isOrderClosed,
    isItemDisputed
  };
}

export default OnlineOrderContext;
