// Shared claim rules : the sidebar badge (workflowEngine.getUserTasks) and the To-Do list (workspaceService.isTaskForMe) must agree.

export const CLAIM_PO_STATUSES = ['CLAIM_PENDING', 'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'PARTIALLY_RECEIVED_IN_CLAIM'];

/**
 * PO ยังอยู่ระหว่างเคลมจริงหรือไม่ (ใช้ร่วม To-Do / badge / ป้ายสถานะ)
 * - สถานะเคลม / claimStatus PENDING_CLAIM,IN_CLAIM / มี storeClaims ที่ยังไม่เจรจา = ยังเคลมอยู่เสมอ
 * - WAITING_DELIVERY_ROUND_2 = เคลมเจรจาจบแล้ว (รอของทดแทน) → flag ค้าง (hasUnresolvedClaim ที่ ReceivingModal ตั้งตอนแจ้งเคลม) ห้ามทำให้ถือว่ายังเคลมอยู่
 *   ไม่งั้น Requester ไม่เห็นงานตรวจรับรอบ 2 ใน To-Do (TC-006)
 */
export const isPoInOpenClaim = (task) => {
  if (!task) return false;
  if (CLAIM_PO_STATUSES.includes(task.status)) return true;
  if (task.claimStatus === 'PENDING_CLAIM' || task.claimStatus === 'IN_CLAIM') return true;
  const storeClaims = task.storeClaims && typeof task.storeClaims === 'object' ? Object.values(task.storeClaims) : [];
  if (storeClaims.some(c => c && c.isResolved === false)) return true;
  if (task.status === 'WAITING_DELIVERY_ROUND_2') return false;
  return Boolean(task.hasUnresolvedClaim) || Boolean(task.claimPending);
};

/** PO สถานะ "จบแล้ว" ชุดเดียวของ badge (getUserTasks) และ To-Do (isTaskForMe) */
export const PO_DONE_STATUSES = ['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND'];
export const isPoDone = (po) => Boolean(po) && PO_DONE_STATUSES.includes(po.status);

/** เจ้าของ PO จาก requesterId (เงื่อนไขเดียวกันของ badge และ To-Do) */
export const isOwnerByRequesterId = (po, user) => Boolean(po?.requesterId) && Boolean(user?.id) && po.requesterId === user.id;

/** ผู้ใช้ระดับ Requester (level <= 1 หรือ role ขึ้นต้น REQUESTER) - ไม่ดูสิทธิ์ canFinalApprove */
export const isRequesterUser = (user) => {
  if (!user) return false;
  const role = String(user.roleId || user.role || user.canonicalRole || '').toUpperCase();
  return Number(user.level || 1) <= 1 || role.startsWith('REQUESTER');
};
