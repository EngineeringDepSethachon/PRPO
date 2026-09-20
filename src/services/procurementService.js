import { hasUnresolvedClaim } from '../views/OnlineTaskView';

/**
 * ตรวจสอบว่าคำสั่งซื้อต้องดำเนินการสั่งซื้อหรือไม่ (ตรงกับแท็บ "รอดำเนินการ")
 */
export const isPendingPurchaseOrder = (po) => {
  if (!po) return false;
  // ข้ามใบที่ปิดงานแล้ว หรือยกเลิกแล้ว
  if (['COMPLETED', 'CLOSED', 'CANCELLED', 'FORCE_CLOSED'].includes(po.status)) return false;
  
  // เป็นงานรอสั่งซื้อ หาก:
  const pendingStatuses = [
    'PENDING_PURCHASE', 'PO_APPROVED', 'APPROVED', 'WAITING_PURCHASE', 'READY_TO_BUY',
    'PENDING_ORDER', 'PENDING', 'IN_PROGRESS_ONLINE', 'WAITING_ORDER', 'WAITING', 'ISSUED',
    'รอดำเนินการ', 'รอดำเนินการสั่งซื้อ'
  ];
  const s = String(po.status || '').toUpperCase();
  if (pendingStatuses.includes(s)) return true;
  
  // 2. หรือยังไม่มีการบันทึกการสั่งซื้อจริง (Fallback check)
  // 🛡️ ต้องไม่ใช่ใบที่อยู่ระหว่างรอเคลม และไม่ใช่ใบที่สั่งซื้อแล้ว (เช่น ORDERED, IN_TRANSIT, IN_DELIVERY)
  const isClaimStatus = po.status === 'CLAIM_PENDING' || po.status === 'IN_CLAIM' || po.status === 'PARTIALLY_RECEIVED_IN_CLAIM' || po.isInClaim;
  const isOrderedStatus = s === 'ORDERED' || s === 'ORDERED_PENDING_DELIVERY' || s === 'IN_TRANSIT' || s === 'IN_DELIVERY' || s === 'PARTIALLY_RECEIVED' || s === 'PARTIAL_RECEIVED' || s === 'PARTIALLY_RECEIVED_WAITING_DELIVERY' || s === 'WAITING_DELIVERY_ROUND_2' || s.startsWith('WAITING_DELIVERY');
  return !po.purchasedAt && !po.orderedAt && !po.isPurchased && !isClaimStatus && !isOrderedStatus && !hasUnresolvedClaim(po);
};

/**
 * ตรวจสอบว่าคำสั่งซื้อมีงานรอเจรจาเคลมหรือไม่ (ตรงกับแท็บ "รอเคลม")
 */
export const isPendingClaimOrder = (po) => {
  if (!po) return false;
  if (['COMPLETED', 'CLOSED', 'CANCELLED'].includes(po.status)) return false;

  return hasUnresolvedClaim(po);
};

/**
 * คำนวณจำนวน Badge ทั้งหมดสำหรับเมนูงานจัดซื้อ
 */
export const calculateProcurementBadgeCount = (orders = []) => {
  if (!Array.isArray(orders)) return 0;
  return orders.filter(po => {
    // กรองเฉพาะ PO ที่มี purchaseChannel === 'ONLINE' (ให้ตรงกับ OnlineTaskView.jsx)
    if (po.purchaseChannel !== 'ONLINE') return false;

    return isPendingPurchaseOrder(po) || isPendingClaimOrder(po);
  }).length;
};
