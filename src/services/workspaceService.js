import { workflowEngine } from './workflowEngine';
import { hasDepartmentAccess } from '../utils/permissions';
import { isPoInOpenClaim, isPoDone, isOwnerByRequesterId } from '../utils/claimState';

// WorkspaceView's own user matching (email / name / username only ; NOT the id) - kept exactly as the view had it
const isWorkspaceUserMatched = (targetValue, currentUser) => {
  if (!targetValue || !currentUser) return false;
  const val = String(targetValue).trim().toLowerCase();
  const email = String(currentUser.email || '').trim().toLowerCase();
  const name = String(currentUser.name || '').trim().toLowerCase();
  const username = String(currentUser.username || '').trim().toLowerCase();
  return (email && val === email) || (name && val === name) || (username && val === username);
};

/**
 * WorkspaceView RBAC pre-filter (moved here unchanged from the view so the server can be tested against the real function) :
 * may `user` see document `doc` ({ ...pr|po, docType: 'PR' | 'PO' }) in the workspace?
 */
export const canSeeWorkspaceDocument = (doc, user) => {
  if (!user) return false;
  const roleId = String(user.roleId || user.id || '').toUpperCase();
  const userLevel = Number(user.level || 1);

  // Admin, Plant Manager, Central Purchaser sees ALL
  const isAdminOrGlobal = roleId === 'ADMIN' || user.role === 'admin' || userLevel >= 99 ||
                          roleId === 'PLANT_MANAGER' || userLevel >= 3 ||
                          roleId === 'PURCHASER' || roleId === 'ONLINE_PURCHASER';
  if (isAdminOrGlobal) return true;

  // Reviewer / Approver (Asst. Manager) - sees ALL docs in their department(s)
  const isReviewer = roleId === 'ASST_MANAGER' || roleId === 'REVIEWER' || userLevel === 2;
  if (isReviewer) {
    return hasDepartmentAccess(user, doc.department);
  }

  // Requester - sees ONLY docs they created, OR POs in their dept (since they receive goods)
  const isCreator =
    isWorkspaceUserMatched(doc.requestedBy, user) ||
    isWorkspaceUserMatched(doc.applicantName1, user) ||
    isWorkspaceUserMatched(doc.createdBy, user) ||
    doc.requesterId === user.id;
  if (isCreator) return true;

  // Requesters can see POs in their department (for receiving goods)
  if (doc.docType === 'PO' && hasDepartmentAccess(user, doc.department)) {
    return true;
  }

  return false; // Not allowed to see this document (Data Leak Prevention)
};

/**
 * Workspace Service - Single Source of Truth for Workspace Task Routing & Lifecycle
 */

export const isUserMatched = (targetValue, currentUser) => {
  if (!targetValue || !currentUser) return false;
  const val = String(targetValue).trim().toLowerCase();
  const email = String(currentUser.email || '').trim().toLowerCase();
  const name = String(currentUser.name || '').trim().toLowerCase();
  const username = String(currentUser.username || '').trim().toLowerCase();
  const id = String(currentUser.id || '').trim().toLowerCase();
  return (email && val === email) || (name && val === name) || (username && val === username) || (id && val === id);
};

export const isRequester = (user) => {
  if (!user) return false;
  const role = String(user.roleId || user.role || user.canonicalRole || '').toUpperCase();
  const level = Number(user.level || 1);
  return level <= 1 || role.startsWith('REQUESTER');
};

/**
 * Helper: ตรวจสอบว่าแผนกของเอกสารตรงกับแผนก(ต่าง ๆ) ของผู้ใช้
 * รองรับ userDept ทั้งแบบ "PD, QC", ["PD","QC"] หรือ "PD"
 */
export const isDepartmentMatch = (docDept, userDept) => {
  if (!docDept || !userDept) return false;
  const userDepts = Array.isArray(userDept)
    ? userDept.map(d => String(d).trim().toUpperCase())
    : String(userDept).split(',').map(d => d.trim().toUpperCase());
  const targetDept = String(docDept).trim().toUpperCase();
  return userDepts.includes(targetDept);
};

/**
 * ตรวจสอบว่าผู้ใช้มีส่วนเกี่ยวข้องกับเอกสารนี้ครอบคลุมทุกมิติ
 * ก. ตรวจสอบจาก flat field (Requester/Reviewer/Approver)
 * ข. ตรวจสอบจาก doc.stakeholders object (PO รุ่นใหม่)
 * ค. ย้อนหลังผ่าน allPRs สำหรับ PO เก่าที่ยังไม่มี stakeholders
 * ง. ตรวจสอบจาก Audit History / activityLog
 * จ. ตรวจสอบตามสิทธิ์บริหารแผนก (Manager/Dept Head ที่แผนกตรงกัน)
 *
 * @param {object} doc - PR หรือ PO document
 * @param {object} user - currentUser object
 * @param {Array}  allPRs - รายการ PR ทั้งหมด (ใช้สำหรับ backward compat ของ PO เก่า)
 */
export const isUserStakeholder = (doc, user, allPRs = []) => {
  if (!doc || !user) return false;
  const userId = user.id || user.uid || user.email;
  const userName = user.name;

  // ก. Flat field: Requester / Reviewer / Approver
  if (doc.createdBy === userId || doc.createdBy === userName) return true;
  if (doc.requesterId === userId || doc.requesterName === userName) return true;
  if (doc.requestedBy && isUserMatched(doc.requestedBy, user)) return true;
  if (doc.applicantName1 && isUserMatched(doc.applicantName1, user)) return true;
  if (doc.requesterEmail && isUserMatched(doc.requesterEmail, user)) return true;
  if (doc.reviewerId === userId || doc.reviewerName === userName) return true;
  if (doc.reviewedBy) {
    if (typeof doc.reviewedBy === 'object') {
      if (doc.reviewedBy.name === userName || doc.reviewedBy.id === userId) return true;
    } else if (isUserMatched(doc.reviewedBy, user)) return true;
  }
  if (Array.isArray(doc.reviewers) && doc.reviewers.some(r => isUserMatched(r, user))) return true;
  if (doc.approverId === userId || doc.approvedBy === userName) return true;
  if (doc.approverName && isUserMatched(doc.approverName, user)) return true;

  // ข. doc.stakeholders object (PO รุ่นใหม่)
  if (doc.stakeholders) {
    const sk = doc.stakeholders;
    if (sk.requesterId === userId || sk.requesterName === userName) return true;
    if (Array.isArray(sk.reviewerNames) && sk.reviewerNames.includes(userName)) return true;
    if (Array.isArray(sk.reviewerIds) && sk.reviewerIds.includes(userId)) return true;
    if (Array.isArray(sk.approverNames) && sk.approverNames.includes(userName)) return true;
    if (Array.isArray(sk.approverIds) && sk.approverIds.includes(userId)) return true;
  }

  // ค. Backward compat: ค้นหา parent PR ของ PO เก่าที่ยังไม่มี stakeholders
  const relatedPrNumber =
    doc.prNumber || doc.prNo ||
    (doc.title && typeof doc.title === 'string' && (doc.title.match(/PR:\s*([^\s]+)/)?.[1]));
  if (relatedPrNumber && Array.isArray(allPRs) && allPRs.length > 0) {
    const parentPR = allPRs.find(p => p.prNumber === relatedPrNumber || p.prNo === relatedPrNumber || p.id === relatedPrNumber);
    if (parentPR) {
      if (parentPR.createdBy === userId || parentPR.createdBy === userName) return true;
      if (parentPR.requesterId === userId || parentPR.requesterName === userName) return true;
      if (isUserMatched(parentPR.requestedBy, user)) return true;
      if (isUserMatched(parentPR.applicantName1, user)) return true;
      if (parentPR.reviewerName === userName || (parentPR.reviewedBy && isUserMatched(
        typeof parentPR.reviewedBy === 'object' ? parentPR.reviewedBy.name : parentPR.reviewedBy, user
      ))) return true;
      if (parentPR.approverName === userName || isUserMatched(parentPR.approvedBy, user)) return true;
    }
  }

  // ง. Audit History / timeline / activityLog
  if (
    (Array.isArray(doc.history) && doc.history.some(h => h.userId === userId || h.userName === userName || isUserMatched(h.user || h.by || h.name, user))) ||
    (Array.isArray(doc.timeline) && doc.timeline.some(t => isUserMatched(t.user || t.by || t.name, user))) ||
    (Array.isArray(doc.activityLog) && doc.activityLog.some(l =>
      isUserMatched(l.user, user) || (user?.title && l.role === user.title)
    ))
  ) {
    return true;
  }

  // จ. สิทธิ์บริหารแผนก: Manager / Dept Head / Asst. Manager ที่แผนกตรงกัน
  const userRole = String(user.roleId || user.role || user.canonicalRole || '').toUpperCase();
  const managementRoles = ['MGT', 'DEPT_HEAD', 'ASST_MANAGER', 'PLANT_MANAGER'];
  if (managementRoles.includes(userRole) && isDepartmentMatch(doc.department, user.department)) {
    return true;
  }

  return false;
};

/**
 * ตรวจสอบว่า Task นี้ต้องดำเนินการโดยฉัน (To Do) หรือไม่
 * กฎเหล็ก:
 * 1. บล็อก Requester จากการเห็น CLAIM_PENDING ใน To Do โดยเด็ดขาด
 * 2. เงื่อนไขเดียวที่ Requester จะได้ตรวจรับรอบ 2 คือสถานะ WAITING_DELIVERY_ROUND_2
 */
// shared with workflowEngine.getUserTasks (sidebar badge) so badge and To-Do count claims the same way
export { isPoInOpenClaim };

/**
 * PO จัดซื้อเองอยู่ในขั้นตอนเคลมที่ผู้ขอซื้อต้องเลือกแนวทางต่อ (ส่งเพิ่ม / คืนเงิน / ยอมรับสภาพ) ที่ PODetailsModal ไหม
 * CLAIM_REPORTED / CLAIM_IN_PROGRESS = ผ่าน fileClaim ; PARTIALLY_RECEIVED_IN_CLAIM / CLAIM_PENDING = ตรวจรับแล้วเลือก "บันทึกปัญหาไว้ก่อน" (TC-003)
 * PO ออนไลน์ใช้แผงของ Online Hub จึงไม่นับ (คงพฤติกรรมเดิมของ PODetailsModal)
 */
export const isSelfClaimStatus = (po) => {
  if (!po) return false;
  if (['CLAIM_REPORTED', 'CLAIM_IN_PROGRESS'].includes(po.status)) return true;
  return po.purchaseChannel === 'SELF' && ['PARTIALLY_RECEIVED_IN_CLAIM', 'CLAIM_PENDING'].includes(po.status);
};

export const isTaskForMe = (task, user) => {
  if (!user) return false;
  if (task.docType === 'PR') {
    const isDone = ['PO_ISSUED', 'APPROVED', 'CLOSED', 'CANCELLED', 'completed', 'received'].includes(task.status);
    if (isDone) return false;
    return workflowEngine.canAction(user, task);
  }
  if (task.docType === 'PO') {
    if (isPoDone(task)) return false;

    // 1. บล็อกงานที่อยู่ระหว่างการเคลมทุกชนิด
    const isClaiming = isPoInOpenClaim(task);

    if (isClaiming) {
      const uRole = String(user?.roleId || user?.role || user?.canonicalRole || '').toUpperCase();

      // For self-procurement (Offline/Internal), Requester MUST handle the claim (เลือกส่งเพิ่ม / คืนเงิน / ยอมรับสภาพ ใน PODetailsModal)
      // ผู้ตรวจทาน/ผู้จัดการ (level >= 2) ไม่ใช่เจ้าของงาน → ไปอยู่ "รอผู้อื่นดำเนินการ" (TC-003)
      const isOnlinePurchase = task.isOnlinePurchase === true || task.purchaseChannel === 'ONLINE';
      if (!isOnlinePurchase) {
        if (user?.id === 'ADMIN' || uRole === 'ADMIN' || Number(user?.level || 1) >= 99) return true;
        if (!isRequester(user) || uRole === 'ONLINE_PURCHASER' || Boolean(user?.canOnlinePurchase)) return false;
        return isUserMatched(task.requestedBy, user) ||
               isOwnerByRequesterId(task, user) ||
               isDepartmentMatch(task.department, user.department) ||
               hasDepartmentAccess(user, task.department);
      }

      // ส่งไปให้เฉพาะ Purchaser / Admin ทำ Action เท่านั้น (Requester ห้ามเห็นใน To Do สำหรับจัดซื้อออนไลน์)
      const isPurchaserOrAdmin =
        ['ONLINE_PURCHASER', 'PURCHASER', 'ADMIN'].includes(uRole) ||
        user?.id === 'ADMIN' ||
        Number(user?.level || 1) >= 99 ||
        Boolean(user?.canOnlinePurchase);

      if (!isPurchaserOrAdmin) {
        return false;
      }
      return true;
    }

    return workflowEngine.canAction(user, task);
  }
  return false;
};

export const isToDoTask = isTaskForMe;

/**
 * ตรวจสอบงานที่เสร็จสิ้นแล้ว (Completed)
 * ใช้ isUserStakeholder เพื่อให้ทุกคนที่เคยเกี่ยวข้องตั้งแต่ต้นน้ำถึงปลายน้ำเห็นการ์ด Completed เหมือนกัน
 *
 * @param {object} task - Document (PR/PO)
 * @param {object} user - currentUser
 * @param {Array}  allPRs - รายการ PR ทั้งหมด (สำหรับ backward compat)
 */
export const isCompletedTask = (task, user, allPRs = []) => {
  const isPR = task.docType === 'PR';
  let isDone = false;
  if (isPR) {
    isDone = ['COMPLETED', 'CLOSED', 'FORCE_CLOSED', 'REJECTED', 'CANCELLED', 'PO_ISSUED', 'APPROVED', 'completed', 'received'].includes(task.status);
  } else {
    isDone = ['COMPLETED', 'CLOSED', 'FORCE_CLOSED', 'REJECTED', 'CANCELLED', 'RECEIVED', 'COMPLETED_WITH_REFUND'].includes(task.status);
  }
  if (!isDone) return false;

  if (user?.id === 'ADMIN' || user?.roleId === 'ADMIN' || Number(user?.level || 1) >= 99) return true;

  return isUserStakeholder(task, user, allPRs);
};

/**
 * ตรวจสอบงานที่รอผู้อื่นดำเนินการ (In Progress)
 * - ซ่อน PR ที่ถูกแปลงเป็น PO แล้ว (deduplication)
 * - ใช้ isUserStakeholder เพื่อให้ Requester/Reviewer/Approver เห็นการ์ด In Progress เหมือนกัน
 *
 * @param {object} task   - Document (PR/PO)
 * @param {object} user   - currentUser
 * @param {Array}  allPRs - รายการ PR ทั้งหมด
 * @param {Array}  allPOs - รายการ PO ทั้งหมด (ใช้สำหรับ deduplication)
 */
export const isInProgressTask = (task, user, allPRs = [], allPOs = []) => {
  if (isTaskForMe(task, user)) return false;

  const isPR = task.docType === 'PR';
  const closedStatuses = ['COMPLETED', 'CLOSED', 'FORCE_CLOSED', 'REJECTED', 'CANCELLED'];
  const isDone = isPR
    ? [...closedStatuses, 'PO_ISSUED', 'APPROVED', 'completed', 'received'].some(s => task.status === s)
    : [...closedStatuses, 'RECEIVED', 'COMPLETED_WITH_REFUND'].some(s => task.status === s);
  if (isDone) return false;

  // Deduplication: ถ้า PR นี้ถูกแปลงเป็น PO แล้ว → ซ่อน PR ใบนั้น แสดงเฉพาะ PO
  if (isPR && Array.isArray(allPOs) && allPOs.length > 0) {
    const prNo = task.prNo || task.prNumber || task.id;
    const hasPO = allPOs.some(po =>
      (po.prId && (po.prId === task.id)) ||
      (po.prNo && prNo && po.prNo === prNo) ||
      (po.prNumber && prNo && po.prNumber === prNo)
    );
    if (hasPO) return false;
  }

  const roleId = String(user?.roleId || user?.id || '').toUpperCase();
  const userLevel = Number(user?.level || 1);
  if (roleId === 'ADMIN' || user?.role === 'admin' || userLevel >= 99) return true;

  return isUserStakeholder(task, user, allPRs);
};

/**
 * ตรวจสอบ backward compat: isUserParticipant (alias ไปยัง isUserStakeholder โดยไม่ต้องส่ง allPRs)
 * คงไว้เพื่อ backward compat กับ caller เดิมที่ยังใช้ชื่อนี้
 */
export const isUserParticipant = (doc, currentUser) => isUserStakeholder(doc, currentUser, []);

export const getTaskBadgeLabel = (task, user) => {
  if (!task) return '';
  if (task.docType === 'PO') {
    if (isPoInOpenClaim(task)) {
      const isPurchaser = user?.roleId === 'ONLINE_PURCHASER' || user?.canOnlinePurchase || user?.roleId === 'ADMIN' || Number(user?.level || 1) >= 99;
      return isPurchaser ? '🔴 รอเจรจาเคลมร้านค้า' : '⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า';
    }
    if (task.status === 'WAITING_DELIVERY_ROUND_2') {
      return 'รอร้านค้าส่งของรอบที่ 2 (ทดแทน)';
    }
  }
  return task.statusLabel || task.status || '';
};

export const workspaceService = {
  isUserMatched,
  isRequester,
  isDepartmentMatch,
  isUserStakeholder,
  isTaskForMe,
  isPoInOpenClaim,
  isSelfClaimStatus,
  isToDoTask,
  isInProgressTask,
  isCompletedTask,
  isUserParticipant,
  getTaskBadgeLabel
};

export default workspaceService;
