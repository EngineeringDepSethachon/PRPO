import { storageService, callGAS, isGAS } from './storageService.js';
import { PR_STATUS, PO_STATUS, DEPARTMENTS } from '../config/constants.js';
import { notificationService } from './notificationService.js';
import { auditService } from './auditService.js';
import { budgetService } from './budgetService.js';
import { hasDepartmentAccess } from '../utils/permissions.js';
import { generateNextPRId, generateNextPOId } from '../utils/idGenerator.js';
import { generateGRNNumber } from './warehouseService.js';

// ─── Fallback Mock Attachment Assets (Phase 2) ───
const GLOVE_PACKAGE_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%"><rect width="400" height="400" fill="%23f8fafc"/><rect x="50" y="80" width="300" height="240" rx="16" fill="%230284c7" stroke="%230369a1" stroke-width="4"/><rect x="70" y="100" width="260" height="120" rx="10" fill="%2338bdf8" fill-opacity="0.3"/><path d="M120 160 Q150 130 180 160 T240 160 T280 150" fill="none" stroke="%23ffffff" stroke-width="5" stroke-linecap="round"/><circle cx="150" cy="150" r="12" fill="%23ffffff"/><circle cx="180" cy="140" r="14" fill="%23ffffff"/><circle cx="210" cy="145" r="13" fill="%23ffffff"/><circle cx="240" cy="160" r="11" fill="%23ffffff"/><rect x="80" y="235" width="240" height="65" rx="8" fill="%23075985"/><text x="200" y="260" font-family="sans-serif" font-size="16" font-weight="bold" fill="%23ffffff" text-anchor="middle">NITRILE EXAMINATION GLOVES</text><text x="200" y="285" font-family="sans-serif" font-size="13" fill="%23bae6fd" text-anchor="middle">กล่องบรรจุ 100 ชิ้น (Package)</text></svg>`;

const GLOVE_PRODUCT_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%"><rect width="400" height="400" fill="%23f0fdf4"/><circle cx="200" cy="200" r="170" fill="%23e0f2fe"/><path d="M160 290 C150 250 140 210 145 180 C148 160 140 130 145 110 C148 100 160 100 165 115 C170 135 170 150 172 160 C175 140 178 100 183 80 C186 70 198 70 200 85 C205 110 203 145 204 160 C208 140 215 95 220 85 C224 75 235 78 236 90 C238 120 234 150 234 165 C239 150 248 120 255 115 C262 110 270 120 266 135 C260 160 252 190 250 210 C245 250 240 290 230 310 Z" fill="%230284c7" stroke="%230369a1" stroke-width="4" stroke-linejoin="round"/><path d="M155 295 L235 295" stroke="%23075985" stroke-width="8" stroke-linecap="round"/><rect x="60" y="330" width="280" height="45" rx="8" fill="%230f172a"/><text x="200" y="358" font-family="sans-serif" font-size="13" font-weight="bold" fill="%2338bdf8" text-anchor="middle">ถุงมือยางไนไตรล์สีฟ้า (สินค้าจริง)</text></svg>`;

const STRETCH_FILM_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%"><rect width="400" height="400" fill="%23f8fafc"/><ellipse cx="200" cy="110" rx="90" ry="35" fill="%23cbd5e1" stroke="%2394a3b8" stroke-width="3"/><ellipse cx="200" cy="110" rx="35" ry="14" fill="%2378350f"/><path d="M110 110 L110 270 C110 295 150 315 200 315 C250 315 290 295 290 270 L290 110" fill="%23e2e8f0" fill-opacity="0.85" stroke="%2394a3b8" stroke-width="3"/><path d="M125 150 C150 170 250 170 275 150 M125 210 C150 230 250 230 275 210" fill="none" stroke="%2338bdf8" stroke-width="3" stroke-dasharray="6,6"/><rect x="60" y="335" width="280" height="45" rx="8" fill="%230f172a"/><text x="200" y="362" font-family="sans-serif" font-size="13" font-weight="bold" fill="%2338bdf8" text-anchor="middle">ฟิล์มยืดพันพาเลท 15 Micron (สินค้าจริง)</text></svg>`;

export const FALLBACK_SEED_ATTACHMENTS = {
  'ITM-001': [
    {
      name: 'รูปแพ็คเกจ: ถุงมือยางไนไตรล์ (100 ชิ้น/กล่อง)',
      url: GLOVE_PACKAGE_SVG,
      previewUrl: GLOVE_PACKAGE_SVG,
      type: 'image/svg+xml'
    },
    {
      name: 'รูปสินค้าจริง: ถุงมือยางไนไตรล์สีฟ้า ไร้แป้ง',
      url: GLOVE_PRODUCT_SVG,
      previewUrl: GLOVE_PRODUCT_SVG,
      type: 'image/svg+xml'
    }
  ],
  'PD-STF-001': [
    {
      name: 'รูปสินค้าจริง: ฟิล์มยืดพันพาเลท 15 Micron 500mm x 300m',
      url: STRETCH_FILM_SVG,
      previewUrl: STRETCH_FILM_SVG,
      type: 'image/svg+xml'
    }
  ]
};

export const getFallbackAttachmentsForCode = (code) => {
  if (!code) return [];
  const clean = String(code).trim().toUpperCase();
  return FALLBACK_SEED_ATTACHMENTS[clean] || [];
};

export const workflowEngine = {
  
  canActionPO(role, po) {
    return this.canAction(role, po);
  },

  canAction(role, doc) {
    if (!role || !doc) return false;

    const isAdmin = role.id === 'ADMIN' || role.roleId === 'ADMIN' || Number(role.level) >= 99;
    const userLevel = Number(role.level || (isAdmin ? 99 : 1));
    const isOnlinePurchaser = role.roleId === 'ONLINE_PURCHASER' || role.id === 'ONLINE_PURCHASER' || role.positionKey === 'ONLINE_PURCHASER' || (role.canOnlinePurchase && userLevel < 99);

    // Helper to check if role matches document creator / requester
    const isDocOwner = (d) => {
      if (!d) return false;
      const target = (d.requestedBy || d.applicantName1 || '').trim().toLowerCase();
      if (!target) return true; // If unspecified, allow matching department

      const rawNames = [role.name, role.employeeName, role.displayName, role.username].filter(Boolean);
      return rawNames.some(n => {
        const clean = n.trim().toLowerCase();
        const baseRole = clean.replace(/\s*\([^)]*\)/g, '').trim();
        const baseTarget = target.replace(/\s*\([^)]*\)/g, '').trim();
        return clean === target ||
               clean.includes(target) ||
               target.includes(clean) ||
               (baseRole && baseTarget && (baseRole === baseTarget || baseRole.includes(baseTarget) || baseTarget.includes(baseRole)));
      });
    };

    const matchesDept = (dept) => {
      return hasDepartmentAccess(role, dept);
    };

    // --- 1. PO Document Action Checks (if document is a PO) ---
    if (doc.poNo) {
      const po = doc;

      // 1. Online PO waiting for Online Purchaser (IN_PROGRESS_ONLINE):
      if (po.status === 'IN_PROGRESS_ONLINE') {
        return isOnlinePurchaser || isAdmin;
      }

      // 2. PO Goods Receiving (ORDERED, ORDERED_PENDING_DELIVERY, ISSUED, PARTIAL, IN_DELIVERY, PARTIAL_RECEIVED):
      // ─── PRIMARY RULE: ONLY Requester / Supervisor (Level 1) of that department can receive goods!
      // Asst. Mgr (Level 2) and Plant Mgr (Level 3) and Online Purchaser CANNOT receive goods.
      if (['ORDERED', 'ORDERED_PENDING_DELIVERY', 'ISSUED', 'PARTIAL', 'IN_DELIVERY', 'PARTIAL_RECEIVED', 'WAITING_DELIVERY_ROUND_2'].includes(po.status)) {
        
        // 1.5 BLOCKER: If PO has CLAIM_PENDING or unresolved claims, Requesters CANNOT act on it unless it's WAITING_DELIVERY_ROUND_2.
        const hasUnresolvedClaim = po.status === 'CLAIM_PENDING' || po.status === 'PARTIALLY_RECEIVED_IN_CLAIM' || po.claimStatus === 'PENDING_CLAIM' || po.claimStatus === 'IN_CLAIM' || po.hasUnresolvedClaim === true || (po.items && po.items.some(it => it.hasDispute || it.ngQty > 0 || it.shortageQty > 0));
        if (hasUnresolvedClaim && po.status !== 'WAITING_DELIVERY_ROUND_2') {
          return false;
        }

        if (isAdmin) return true;
        if (isOnlinePurchaser) return false;
        
        // Strictly disallow Level >= 2 managers (Asst. Mgr, Plant Mgr) from receiving goods
        if (userLevel >= 2) return false;

        // Department requester or supervisor (Level 1) of that department
        if (userLevel === 1 && matchesDept(po.department)) {
          return true;
        }

        return false;
      }

      return false;
    }

    // --- 2. PR Document Action Checks (if document is a PR) ---
    const pr = doc;

    // 1. DRAFT or REJECTED_TO_DRAFT:
    // Only the requester who owns the draft can action it (or Admin)
    if (['DRAFT', 'REJECTED_TO_DRAFT'].includes(pr.status)) {
      if (isAdmin) return true;
      if (role.canSubmitPR && matchesDept(pr.department) && isDocOwner(pr)) {
        return true;
      }
      return false;
    }

    // 2. SUBMITTED or REJECTED_TO_L2 or waiting review (Review Level 1 - Asst. Manager):
    // Only Level 2 Reviewers / Asst Managers (strictly NOT Plant Manager Level 3, NOT Requesters Level 1, NOT Online Purchaser)
    if (['SUBMITTED', 'REJECTED_TO_L2', 'waiting_review', 'pending_review', 'รอตรวจทาน', 'รอตรวจสอบ'].includes(pr.status)) {
      if (isAdmin) return true;
      if (isOnlinePurchaser) return false;
      // Disallow Level 3 (Plant Mgr / Approvers) and Level 1 (Requesters)
      if (userLevel >= 3 || role.canFinalApprove || userLevel <= 1) return false;

      const isLevel2Reviewer = userLevel === 2 || role.canReview || role.id === 'ASST_MANAGER' || role.id === 'REVIEWER' || role.positionKey === 'REVIEWER' || role.roleId === 'ASST_MANAGER';
      return isLevel2Reviewer && matchesDept(pr.department);
    }

    // 3. REVIEWED (Final Approval - Plant Manager):
    // Only Level 3 Approvers / Plant Managers (strictly NOT Level 2 Asst Managers, NOT Requesters Level 1, NOT Online Purchaser)
    if (pr.status === 'REVIEWED') {
      if (isAdmin) return true;
      if (isOnlinePurchaser) return false;
      const isLevel3Approver = userLevel >= 3 || role.canFinalApprove || role.id === 'PLANT_MANAGER' || role.id === 'APPROVER' || role.positionKey === 'APPROVER' || role.roleId === 'PLANT_MANAGER';
      return isLevel3Approver && matchesDept(pr.department);
    }

    return false;
  },

  // Check if a user can cancel a PR (Task must currently be with the user)
  canCancelPR(role, pr) {
    if (!role || !pr) return false;
    if (['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED', 'CANCELLED'].includes(pr.status)) {
      return false;
    }
    return this.canAction(role, pr);
  },

  // ─── Unified User Tasks & Workspace Task Aggregator (Single Source of Truth) ───
  getUserTasks(currentRole, prs = [], pos = []) {
    if (!currentRole) {
      return {
        action: [],
        waiting: [],
        completed: [],
        counts: { prCount: 0, poCount: 0, onlineCount: 0, total: 0 }
      };
    }

    const actionRequired = [];
    const waiting = [];
    const completed = [];

    const userLevel = Number(currentRole?.level || 1);
    const isAdmin = currentRole?.id === 'ADMIN' || currentRole?.roleId === 'ADMIN' || userLevel >= 99;
    const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER' || currentRole?.positionKey === 'ONLINE_PURCHASER' || (currentRole?.canOnlinePurchase && userLevel < 99);
    const isPlantMgr = userLevel >= 3 || currentRole?.canFinalApprove;
    const isAsstMgr = userLevel === 2 && !isOnlinePurchaser;

    const hasDirectlyActedOn = (doc) => {
      if (!doc || !currentRole) return false;
      const names = [currentRole.name, currentRole.employeeName, currentRole.displayName, currentRole.username].filter(Boolean);

      if (names.includes(doc.requestedBy) || names.includes(doc.applicantName1)) return true;

      if (doc.activityLog?.some(log =>
        names.includes(log.user) ||
        (currentRole.title && log.role === currentRole.title)
      )) return true;

      return false;
    };

    const waitingStatusesFor = {
      plantMgr: [],
      asstMgr: ['REVIEWED'],
      requester: ['SUBMITTED', 'REJECTED_TO_L2', 'REVIEWED', 'waiting_review', 'pending_review', 'รอตรวจทาน', 'รอตรวจสอบ'],
      onlinePurchaser: ['ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'PARTIAL'],
    };

    let prActionCount = 0;
    let poActionCount = 0;
    let onlineActionCount = 0;

    // 1. Process PRs
    prs.forEach(pr => {
      // Find related PO for this PR
      const relatedPO = pos.find(po =>
        (po.prId && (po.prId === pr.id || po.prId === pr.prNo)) ||
        (po.prNo && (po.prNo === pr.prNo || po.prNo === pr.id)) ||
        (po.prNumber && (po.prNumber === pr.id || po.prNumber === pr.prNo || po.prNumber === pr.prNumber)) ||
        (pr.poNo && (po.poNo === pr.poNo || po.id === pr.poNo)) ||
        (pr.poNumber && (po.poNo === pr.poNumber || po.poNumber === pr.poNumber))
      );
      const hasPO = Boolean(relatedPO || pr.poNo || pr.poNumber);

      const isPORelatedDone = relatedPO
        ? ['closed', 'cancelled', 'received', 'completed', 'fully_received'].includes(String(relatedPO.status).toLowerCase())
        : false;

      const isDone = ['PO_ISSUED', 'APPROVED', 'CLOSED', 'CANCELLED', 'completed', 'received'].includes(pr.status) || isPORelatedDone;
      const canAction = !isDone && !hasPO && this.canAction(currentRole, pr);
      const actedOn = hasDirectlyActedOn(pr);

      let isWaiting = false;
      // DEDUPLICATION GATE: If PR has been converted to PO, DO NOT show it in waiting/In Progress!
      // Status must only be tracked via the single PO card.
      if (!hasPO && !canAction && !isDone) {
        if (isAdmin) {
          isWaiting = true;
        } else if (isPlantMgr) {
          isWaiting = false;
        } else if (isAsstMgr) {
          isWaiting = actedOn && waitingStatusesFor.asstMgr.includes(pr.status);
        } else if (isOnlinePurchaser) {
          isWaiting = false;
        } else {
          isWaiting = actedOn && waitingStatusesFor.requester.includes(pr.status);
        }
      }

      const taskItem = {
        id: pr.id,
        type: 'PR',
        docNo: pr.prNo,
        date: pr.requestedDate || pr.createdAt,
        title: pr.items?.map(i => i.name).join(', ') || 'ใบขอซื้อ',
        status: isPORelatedDone ? 'CLOSED' : pr.status,
        amount: pr.totalAmount,
        raw: pr,
        statusInfo: PR_STATUS[isPORelatedDone ? 'CLOSED' : pr.status] || PR_STATUS[pr.status] || PR_STATUS.CLOSED
      };

      if (canAction) {
        actionRequired.push(taskItem);
        prActionCount++;
      } else if (isWaiting) {
        waiting.push(taskItem);
      } else if (isDone && (actedOn || hasPO)) {
        completed.push(taskItem);
      }
    });

    // 2. Helper for PO PR link
    const isLinkedToOwnPR = (po) => {
      if (!po.prId && !po.prNo) return false;
      return prs.some(pr =>
        (pr.id === po.prId || pr.prNo === po.prNo) && hasDirectlyActedOn(pr)
      );
    };

    // 3. Process POs
    pos.forEach(po => {
      const isClaim = ['CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'CLAIM_PENDING', 'PARTIALLY_RECEIVED_IN_CLAIM'].includes(po.status) || po.hasUnresolvedClaim === true;
      const isDone = po.status === 'CLOSED' || po.status === 'CANCELLED' || po.status === 'RECEIVED';
      const canAction = !isDone && this.canAction(currentRole, po);
      const actedOnPO = hasDirectlyActedOn(po);
      const isOwnerOfPO = actedOnPO || isLinkedToOwnPR(po);

      let isWaiting = false;
      if (!canAction && !isDone && !isClaim) {
        if (isAdmin) {
          isWaiting = true;
        } else if (isOnlinePurchaser) {
          isWaiting = actedOnPO && waitingStatusesFor.onlinePurchaser.includes(po.status);
        } else if (isPlantMgr || isAsstMgr) {
          isWaiting = false;
        } else {
          const isDeptMember = hasDepartmentAccess(currentRole, po.department);
          isWaiting = (isOwnerOfPO || isDeptMember) && po.status === 'IN_PROGRESS_ONLINE';
        }
      }

      let isClaimAction = false;
      if (isClaim && !isDone) {
        const isOnlineProcurement = po.isOnlinePurchase === true || po.purchaseChannel === 'ONLINE';
        if (isAdmin) {
          isClaimAction = true;
        } else if (!isOnlineProcurement) {
          const isDeptMember = hasDepartmentAccess(currentRole, po.department);
          isClaimAction = (isOwnerOfPO || isDeptMember) && !isOnlinePurchaser;
        } else if (isOnlineProcurement && isOnlinePurchaser) {
          isClaimAction = true;
        } else if (isOnlineProcurement && !isOnlinePurchaser) {
          const isDeptMember = hasDepartmentAccess(currentRole, po.department);
          isWaiting = (isOwnerOfPO || isDeptMember);
        }
      }

      if (po.purchaseChannel === 'ONLINE' && !isDone) {
        if (po.status === 'IN_PROGRESS_ONLINE' || isClaim) {
          onlineActionCount++;
        }
      }

      const poSubtitle = (() => {
        if (po.status === 'ISSUED') return '📦 รอดำเนินการ: ตรวจรับสินค้าเข้าคลัง';
        if (po.status === 'ORDERED' || po.status === 'ORDERED_PENDING_DELIVERY') return '🚚 สินค้ากำลังจัดส่ง: รอตรวจรับของ';
        if (po.status === 'PARTIAL' || po.status === 'PARTIAL_RECEIVED' || po.status === 'WAITING_DELIVERY_ROUND_2') return 'ตรวจรับพัสดุรอบถัดไป / ติดตามของเคลม';
        if (po.status === 'IN_PROGRESS_ONLINE') return '🛒 รอจัดซื้อออนไลน์ดำเนินการ';
        if (po.status === 'CLAIM_REPORTED' || po.status === 'CLAIM_IN_PROGRESS' || po.status === 'CLAIM_PENDING' || po.status === 'PARTIALLY_RECEIVED_IN_CLAIM' || po.hasUnresolvedClaim) {
           if (po.purchaseChannel === 'ONLINE') return '⏳ รอฝ่ายจัดซื้อออนไลน์ดำเนินการเคลมกับร้านค้า';
           return '🚨 แจ้งปัญหาแล้ว: รอดำเนินการแก้ไข';
        }
        return null;
      })();

      const productTitle = po.items && po.items.length > 0
        ? (po.items.length === 1 
            ? `${po.items[0].name} (x${Number((po.items[0].orderedQty ?? po.items[0].purchaseQty ?? po.items[0].qty) || 0).toLocaleString()} ${po.items[0].purchaseUnit || po.items[0].unit || 'ชิ้น'})`
            : `${po.items.map(i => i.name).join(', ')} (${po.items.length} รายการ)`)
        : `ใบสั่งซื้อ: ${po.vendorName}`;

      const taskItem = {
        id: po.id,
        type: 'PO',
        docNo: po.poNo,
        date: po.issueDate,
        title: productTitle,
        vendorName: po.vendorName,
        subtitle: poSubtitle,
        status: po.status,
        amount: po.grandTotal || po.totalAmount || po.subtotal || 0,
        raw: po,
        statusInfo: PO_STATUS[po.status]
      };

      if (canAction) {
        actionRequired.push(taskItem);
        if (!isOnlinePurchaser) poActionCount++;
      } else if (isClaimAction) {
        if (!isOnlinePurchaser) {
          actionRequired.push({ ...taskItem, isClaim: true });
          poActionCount++;
        }
      } else if (isWaiting) {
        waiting.push(taskItem);
      } else if (isDone && isOwnerOfPO) {
        completed.push(taskItem);
      }
    });

    const sortByDate = (a, b) => new Date(b.date) - new Date(a.date);

    return {
      action: actionRequired.sort(sortByDate),
      waiting: waiting.sort(sortByDate),
      completed: completed.sort(sortByDate).slice(0, 50),
      counts: {
        prCount: prActionCount,
        poCount: poActionCount,
        onlineCount: onlineActionCount,
        total: isOnlinePurchaser ? onlineActionCount : actionRequired.length
      }
    };
  },

  // Edit PR items by Approver (Level 2+) before approval
  async editPRItems(prId, updatedItems, user, editReason = '') {
    const prs = storageService.getPRs();
    const pr = prs.find(p => p.id === prId);
    if (!pr) throw new Error('ไม่พบเอกสาร PR ในระบบ');

    if (user.level < 2 && user.id !== 'ADMIN') {
      throw new Error('เฉพาะผู้อนุมัติตั้งแต่ Level 2 ขึ้นไปเท่านั้นที่สามารถแก้ไขรายการได้');
    }

    if (!['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2'].includes(pr.status)) {
      throw new Error('ไม่สามารถแก้ไขรายการในสถานะปัจจุบันของ PR นี้ได้');
    }

    const oldTotal = pr.totalAmount || 0;
    const formattedItems = updatedItems.map(item => {
      const pQty = Number(item.purchaseQty ?? item.qty) || 1;
      const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
      const sQty = Number(item.stockQty) || (pQty * rate);
      const price = Number(item.price) || 0;
      return {
        ...item,
        purchaseUnit: item.purchaseUnit || item.unit || 'ชิ้น',
        stockUnit: item.stockUnit || item.unit || 'ชิ้น',
        conversionRate: rate,
        purchaseQty: pQty,
        stockQty: sQty,
        qty: pQty,
        price,
        total: price * pQty
      };
    });

    const newTotal = formattedItems.reduce((sum, it) => sum + it.total, 0);
    pr.items = formattedItems;
    pr.totalAmount = newTotal;

    const timestamp = new Date().toLocaleString('th-TH');
    if (!Array.isArray(pr.activityLog)) {
      pr.activityLog = [];
    }
    pr.activityLog.push({
      action: 'แก้ไขรายการสินค้า (Approver Item Edit)',
      user: user.name,
      role: user.title,
      timestamp,
      note: `ผู้อนุมัติแก้ไขรายการสินค้า (ยอดเดิม ฿${oldTotal.toLocaleString()} → ยอดใหม่ ฿${newTotal.toLocaleString()})${editReason ? ` เหตุผล: ${editReason}` : ''}`
    });

    storageService.savePRs(prs);
    return pr;
  },

  // 1-Level Rejection Logic:
  // Level 3 (Plant Mgr) -> REJECTED_TO_L2 (Sent back to Level 2 Asst Mgr)
  // Level 2 (Asst Mgr) -> REJECTED_TO_DRAFT (Sent back to Level 1 Requester)
  async rejectPR(prId, user, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('กรุณาระบุเหตุผลการไม่อนุมัติ / ส่งกลับ');
    }

    const prs = storageService.getPRs();
    const pr = prs.find(p => p.id === prId);
    if (!pr) throw new Error('ไม่พบเอกสาร PR ในระบบ');

    const timestamp = new Date().toLocaleString('th-TH');
    let nextStatus = 'REJECTED_TO_DRAFT';
    let actionLabel = 'ส่งกลับให้ผู้ขอซื้อแก้ไข (Rejected to Draft)';
    let targetRoles = [pr.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN'];
    let notiTitle = 'ใบขอซื้อ (PR) ถูกส่งกลับให้แก้ไข';

    pr.status = nextStatus;
    pr.rejectReason = reason.trim();
    pr.rejectionReason = reason.trim();
    pr.returnComment = reason.trim();
    if (!Array.isArray(pr.activityLog)) pr.activityLog = [];
    pr.activityLog.push({
      action: actionLabel,
      user: user.name,
      role: user.title,
      timestamp,
      note: `เหตุผลการส่งกลับ: ${reason.trim()}`
    });

    if (!Array.isArray(pr.approvalHistory)) pr.approvalHistory = [];
    pr.approvalHistory.push({
      actorName: user.name,
      actorRole: user.title,
      action: 'REJECT',
      date: timestamp,
      timestamp,
      comment: reason.trim()
    });

    storageService.savePRs(prs);

    // Direct Sync to Local Backend File
    try {
      fetch(`/api/prs/${pr.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pr)
      }).catch(() => {});
    } catch {}

    auditService.logAction({
      action: 'PR_REJECTED',
      actor: user,
      department: pr.department,
      docNo: pr.prNo,
      docType: 'PR',
      details: `ส่งกลับ / ปฏิเสธ PR เลขที่ ${pr.prNo} (${actionLabel}): ${reason.trim()}`
    });

    // Dispatch Notification
    notificationService.dispatch({
      type: 'PR_REJECTED',
      title: notiTitle,
      message: `ใบขอซื้อเลขที่ ${pr.prNo} ถูกส่งกลับโดย ${user.name}: ${reason.trim()}`,
      reason: reason.trim(),
      rejectReason: reason.trim(),
      docNo: pr.prNo,
      refDocType: 'PR',
      refDocId: pr.id,
      department: pr.department,
      targetRoles,
      amount: pr.totalAmount,
      actor: user.name
    });

    return pr;
  },

  // Online Purchaser Confirms Order (Directive 3 alias to acknowledgeOnlineTask)
  async confirmOnlineOrder(poId, vendorName, user, updatedItems = null, varianceNote = '') {
    return this.acknowledgeOnlineTask(poId, vendorName, user, updatedItems, varianceNote);
  },

  // Online Purchaser Acknowledges Task & marks as ordered
  async acknowledgeOnlineTask(poId, vendorName, user, updatedItems = null, varianceNote = '') {
    if (!vendorName || !vendorName.trim()) {
      throw new Error('กรุณาระบุชื่อร้านค้า / ช่องทางที่สั่งซื้อ (เช่น Shopee ร้าน XYZ)');
    }

    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบเอกสาร PO ในระบบ');

    po.status = 'ORDERED';
    po.subStatus = 'ORDERED_PENDING_DELIVERY';
    po.vendorName = vendorName.trim();
    po.vendor = vendorName.trim();
    po.shopName = vendorName.trim();
    po.orderedAt = new Date().toISOString();
    const timestamp = new Date().toLocaleString('th-TH');

    let varianceDetails = [];

    if (Array.isArray(updatedItems) && updatedItems.length > 0) {
      po.items = po.items.map((origItem, origIdx) => {
        // Strict indexed mapping: Prioritize row index directly. Never match by non-unique code/sku
        const matchingUpdated = (origIdx < updatedItems.length && updatedItems[origIdx])
          ? updatedItems[origIdx]
          : ((origItem.id && updatedItems.find(u => u.id && String(u.id) === String(origItem.id))) || origItem);

        if (matchingUpdated) {
          const oldPrice = Number(origItem.actualPrice ?? origItem.unitPrice ?? origItem.estimatedPrice ?? origItem.price) || 0;
          const oldQty = Number(origItem.actualQty ?? origItem.purchaseQty ?? origItem.qty) || 1;
          const newPrice = matchingUpdated.actualPrice !== undefined && matchingUpdated.actualPrice !== ''
            ? Number(matchingUpdated.actualPrice)
            : (matchingUpdated.unitPrice !== undefined && matchingUpdated.unitPrice !== '' ? Number(matchingUpdated.unitPrice) : oldPrice);
          const newQty = matchingUpdated.actualQty !== undefined && matchingUpdated.actualQty !== ''
            ? Number(matchingUpdated.actualQty)
            : (matchingUpdated.purchaseQty !== undefined && matchingUpdated.purchaseQty !== '' ? Number(matchingUpdated.purchaseQty) : oldQty);
          const rate = Number(origItem.conversionRate) > 0 ? Number(origItem.conversionRate) : 1;
          const newStockQty = newQty * rate;

          // Preserve original PR values if not already preserved
          const originalEstimatedPrice = origItem.originalEstimatedPrice ?? origItem.estimatedPrice ?? oldPrice;
          const originalPurchaseQty = origItem.originalPurchaseQty ?? origItem.qty ?? oldQty;

          if (newPrice !== oldPrice || newQty !== oldQty) {
            varianceDetails.push(`${origItem.name}: เดิม ${oldQty} @ ฿${oldPrice.toLocaleString()} -> สั่งจริง ${newQty} @ ฿${newPrice.toLocaleString()}`);
          }

          const lineTotal = newPrice * newQty;

          return {
            ...origItem,
            ...matchingUpdated,
            originalEstimatedPrice,
            originalPurchaseQty,
            unitPrice: newPrice,
            estimatedPrice: newPrice,
            price: newPrice,
            actualPrice: newPrice,
            actUnitPrice: newPrice,
            purchaseQty: newQty,
            qty: newQty,
            orderedQty: newQty,
            actualQty: newQty,
            stockQty: newStockQty,
            lineTotal,
            total: lineTotal,
            actualStoreName: (matchingUpdated.actualStoreName !== undefined ? matchingUpdated.actualStoreName : (origItem.actualStoreName || origItem.storeName || '')).trim(),
            storePlatform: matchingUpdated.storePlatform || origItem.storePlatform || origItem.platform || 'Shopee',
            orderRefNo: (matchingUpdated.orderRefNo || origItem.orderRefNo || '').trim()
          };
        }
        return origItem;
      });

      // Update Header Vendor based on Line Items Stores (Directive 2)
      const stores = Array.from(new Set(po.items.map(u => (u.actualStoreName || '').trim()).filter(s => s && !s.includes('ระบุร้านภายหลัง'))));
      const platforms = Array.from(new Set(po.items.map(u => (u.storePlatform || '').trim()).filter(Boolean)));
      if (stores.length === 1 && platforms.length <= 1) {
        po.vendorName = stores[0];
        po.vendor = stores[0];
        po.shopName = stores[0];
      } else if (stores.length > 1 || platforms.length > 1) {
        const multiVendorStr = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
        po.vendorName = multiVendorStr;
        po.vendor = multiVendorStr;
        po.shopName = multiVendorStr;
      } else {
        po.vendorName = vendorName.trim();
        po.vendor = vendorName.trim();
        po.shopName = vendorName.trim();
      }

      // Recalculate PO total accurately: sum of (actualQty * actualPrice)
      const newTotal = po.items.reduce((sum, item) => sum + ((item.actualQty ?? item.purchaseQty ?? item.qty) * (item.actualPrice ?? item.unitPrice ?? item.price ?? 0)), 0);
      po.grandTotal = newTotal;
      po.totalAmount = newTotal;
      po.subtotal = newTotal;
      if (po.financials) {
        po.financials.subtotal = newTotal;
        po.financials.grandTotal = newTotal;
      }

      // ── Detailed Item-Level History Logging (Directive 3.4) ──
      if (!Array.isArray(po.activityLog)) po.activityLog = [];
      po.items.forEach(item => {
        const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
        const origQ = item.originalPurchaseQty;
        const curQ = item.actualQty ?? item.purchaseQty ?? item.qty;
        const origP = item.originalEstimatedPrice;
        const curP = item.actualPrice ?? item.unitPrice ?? item.price;
        const itemCode = item.code || item.sku || item.name;

        if (origQ !== undefined && Number(curQ) !== Number(origQ)) {
          if (!Array.isArray(po.activityLog)) {
            po.activityLog = [];
          }
          po.activityLog.push({
            action: 'ปรับปรุงจำนวนสั่งซื้อจริง',
            user: user.name || 'Online Purchaser',
            role: user.title || user.role || 'Purchaser',
            timestamp,
            note: `จัดซื้อปรับจำนวน ${itemCode} จาก ${origQ} เป็น ${curQ} ${pUnit}`
          });
        }
        if (origP !== undefined && Number(curP) !== Number(origP)) {
          if (!Array.isArray(po.activityLog)) {
            po.activityLog = [];
          }
          po.activityLog.push({
            action: 'ปรับปรุงราคาซื้อจริง',
            user: user.name || 'Online Purchaser',
            role: user.title || user.role || 'Purchaser',
            timestamp,
            note: `จัดซื้อปรับราคา ${itemCode} จาก ฿${Number(origP).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} เป็น ฿${Number(curP).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          });
        }
      });

      // ── Department Budget Reconciliation (Directive 3) ──
      const initialTotal = po.items.reduce((sum, item) => sum + ((Number(item.originalPurchaseQty ?? item.qty ?? 1)) * (Number(item.originalEstimatedPrice ?? item.price ?? 0))), 0);
      const budgetDiff = newTotal - initialTotal; // diff > 0 is overspend, diff < 0 is saving

      const dept = (po.department || 'PD').toUpperCase();
      const budgets = storageService.getBudgets();
      if (!budgets[dept]) budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };

      const curSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
      const poMonth = po.issueDate ? po.issueDate.substring(0, 7) : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

      if (budgetDiff < 0) {
        // Savings: Credit/rollback to department budget
        const savedAmt = Math.abs(budgetDiff);
        const newSpent = Math.max(0, curSpent - savedAmt);
        budgets[dept].spent = newSpent;
        budgets[dept].actualExpense = newSpent;
        const monthly = Number(budgets[dept].monthlyBudget || 0);
        budgets[dept].variance = monthly - newSpent;
        budgets[dept].remainingBudget = monthly - newSpent;

        if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
        budgets[dept].refundCredits[poMonth] = Math.round(((budgets[dept].refundCredits[poMonth] || 0) + savedAmt) * 100) / 100;

        storageService.saveBudgets(budgets);

        storageService.appendBudgetTransaction({
          id: `BTX-SAVINGS-${Date.now()}`,
          date: new Date().toISOString().replace('T', ' ').slice(0, 19),
          createdAt: new Date().toISOString(),
          dept,
          type: 'BUDGET_ROLLBACK',
          typeLabel: 'คืนงบประมาณจากการประหยัด (Procurement Savings)',
          previousAmount: curSpent,
          newAmount: newSpent,
          amount: savedAmt,
          delta: savedAmt,
          actor: user.name,
          refDocNo: po.poNo || po.id,
          note: `คืนงบประมาณส่วนต่างจากการสั่งซื้อออนไลน์ได้ราคา/จำนวนถูกลง (PO: ${po.poNo})`,
          targetMonth: poMonth
        });
      } else if (budgetDiff > 0) {
        // Over-budget: Deduct extra from department budget
        const extraAmt = budgetDiff;
        const newSpent = curSpent + extraAmt;
        budgets[dept].spent = newSpent;
        budgets[dept].actualExpense = newSpent;
        const monthly = Number(budgets[dept].monthlyBudget || 0);
        budgets[dept].variance = monthly - newSpent;
        budgets[dept].remainingBudget = monthly - newSpent;

        storageService.saveBudgets(budgets);

        storageService.appendBudgetTransaction({
          id: `BTX-OVERSPENT-${Date.now()}`,
          date: new Date().toISOString().replace('T', ' ').slice(0, 19),
          createdAt: new Date().toISOString(),
          dept,
          type: 'BUDGET_OVERSPENT',
          typeLabel: 'หักงบประมาณเพิ่มเติม (Over-Budget Adjustment)',
          previousAmount: curSpent,
          newAmount: newSpent,
          amount: extraAmt,
          delta: -extraAmt,
          actor: user.name,
          refDocNo: po.poNo || po.id,
          note: `หักงบประมาณเพิ่มเติมเนื่องจากยอดสั่งซื้อจริงเกินงบ PR (PO: ${po.poNo})`,
          targetMonth: poMonth
        });
      }

      // Log ACTUAL_SPEND for this Online PO and Release its PR_COMMITMENT portion
      budgetService.logBudgetTransaction({
        department: po.department,
        type: 'PR_RELEASE',
        amount: Math.abs(initialTotal),
        docType: 'PR',
        docRef: po.prNo || po.id,
        description: `คืนเงินผูกพัน (ออก PO ออนไลน์แล้ว) PR ${po.prNo}`,
        recordedBy: user.name || 'System'
      });

      budgetService.logBudgetTransaction({
        department: po.department,
        type: 'ACTUAL_SPEND',
        amount: -newTotal,
        docType: 'PO',
        docRef: po.poNo || po.id,
        description: `ตัดจ่ายจริง PO ${po.poNo}`,
        recordedBy: user.name || 'System'
      });
    }

    let noteText = `สั่งซื้อจาก: ${vendorName.trim()} — ส่งต่อให้แผนกต้นทางตรวจรับและปิด PO`;
    if (varianceDetails.length > 0) {
      noteText += ` | ปรับปรุงยอดสั่งซื้อจริง: [${varianceDetails.join(', ')}]`;
    }
    if (varianceNote && varianceNote.trim()) {
      noteText += ` (หมายเหตุ: ${varianceNote.trim()})`;
    }

    if (!Array.isArray(po.activityLog)) po.activityLog = [];
    po.activityLog.push({
      action: 'รับทราบและสั่งซื้อออนไลน์แล้ว (Online Order Placed)',
      user: user.name,
      role: user.title,
      timestamp,
      note: noteText
    });

    if (!Array.isArray(po.timeline)) {
      po.timeline = [];
    }
    po.timeline.push({
      status: 'ORDERED_PENDING_DELIVERY',
      title: 'สั่งซื้อสินค้าออนไลน์แล้ว',
      description: noteText,
      user: user.name,
      date: new Date().toISOString()
    });

    storageService.savePOs(pos);

    // Notify Department Requester
    notificationService.dispatch({
      type: 'ONLINE_ORDERED',
      title: '📦 สินค้าออนไลน์สั่งซื้อแล้ว (รอจัดส่ง)',
      message: `ใบสั่งซื้อ ${po.poNo} (อ้างอิง PR ${po.prNo}) สั่งซื้อจาก "${vendorName.trim()}" แล้ว (ยอดรวม ฿${(po.grandTotal || 0).toLocaleString()})${varianceDetails.length > 0 ? ' มีการปรับปรุงราคา/จำนวนตามสต็อกจริง' : ''}`,
      docNo: po.poNo,
      refDocType: 'PO',
      refDocId: po.id,
      department: po.department,
      targetRoles: [po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER'],
      amount: po.grandTotal,
      actor: user.name
    });

    return po;
  },

  // 2A: Cancel PR (Allowed ONLY before PO is issued)
  async cancelPR(prId, user, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('กรุณาระบุเหตุผลในการยกเลิกใบขอซื้อ (PR)');
    }

    const prs = storageService.getPRs();
    const pr = prs.find(p => p.id === prId);
    if (!pr) throw new Error('ไม่พบเอกสาร PR ในระบบ');

    if (['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED'].includes(pr.status)) {
      throw new Error('ไม่สามารถยกเลิก PR ที่ออกเป็น PO หรืออนุมัติสั่งซื้อแล้วได้ หากต้องการยกเลิก กรุณาใช้ฟังก์ชันยกเลิก PO แทน');
    }

    if (pr.status === 'CANCELLED') {
      throw new Error('เอกสาร PR นี้ถูกยกเลิกไปแล้ว');
    }

    // Must be actionable by the current user at their stage (Task must currently be at this user)
    if (!this.canAction(user, pr)) {
      throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากเอกสารไม่ได้อยู่ในขั้นตอนที่ท่านต้องดำเนินการในขณะนี้ (งานไม่ได้อยู่ที่ท่าน)');
    }

    pr.status = 'CANCELLED';
    const timestamp = new Date().toLocaleString('th-TH');

    if (!Array.isArray(pr.activityLog)) {
      pr.activityLog = [];
    }
    pr.activityLog.push({
      action: 'ยกเลิกใบขอซื้อ (Cancelled PR)',
      user: user.name,
      role: user.title,
      timestamp,
      note: `เหตุผลการยกเลิก: ${reason.trim()}`
    });

    storageService.savePRs(prs);

    auditService.logAction({
      action: 'PR_CANCELLED',
      actor: user,
      department: pr.department,
      docNo: pr.prNo,
      docType: 'PR',
      details: `ยกเลิกใบขอซื้อเลขที่ ${pr.prNo}: ${reason.trim()}`
    });

    // Dispatch Notification
    notificationService.dispatch({
      type: 'PR_CANCELLED',
      title: '❌ ใบขอซื้อ (PR) ถูกยกเลิก',
      message: `ใบขอซื้อเลขที่ ${pr.prNo} แผนก ${pr.department} ถูกยกเลิกโดย ${user.name}: ${reason.trim()}`,
      docNo: pr.prNo,
      refDocType: 'PR',
      refDocId: pr.id,
      department: pr.department,
      targetRoles: [pr.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER'],
      amount: pr.totalAmount,
      actor: user.name
    });

    return pr;
  },

  // 2A: Cancel PO (Dedicated PO cancellation function)
  async cancelPO(poId, user, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('กรุณาระบุเหตุผลในการยกเลิกใบสั่งซื้อ (PO)');
    }

    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบเอกสาร PO ในระบบ');

    if (['CLOSED', 'RECEIVED'].includes(po.status)) {
      throw new Error('ไม่สามารถยกเลิก PO ที่ปิดงานหรือรับสินค้าเข้าคลังเสร็จสิ้นแล้วได้');
    }

    if (po.status === 'CANCELLED') {
      throw new Error('เอกสาร PO นี้ถูกยกเลิกไปแล้ว');
    }

    po.status = 'CANCELLED';
    const timestamp = new Date().toLocaleString('th-TH');

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: 'ยกเลิกใบสั่งซื้อ (Cancelled PO)',
      user: user.name,
      role: user.title,
      timestamp,
      note: `เหตุผลการยกเลิก: ${reason.trim()}`
    });

    storageService.savePOs(pos);

    // BUDGET LOGGING: Refund PO
    budgetService.logBudgetTransaction({
      department: po.department,
      type: 'PO_CANCEL_REFUND',
      amount: Math.abs(po.grandTotal || 0),
      docType: 'PO',
      docRef: po.poNo || po.id,
      description: `คืนเงิน (ยกเลิก PO) ${po.poNo} เหตุผล: ${reason.trim()}`,
      recordedBy: user.name || 'System'
    });

    auditService.logAction({
      action: 'PO_CANCELLED',
      actor: user,
      department: po.department,
      docNo: po.poNo,
      docType: 'PO',
      details: `ยกเลิกใบสั่งซื้อ ${po.poNo}: ${reason.trim()}`
    });

    // Also update parent PR activity log if exists
    if (po.prId) {
      const prs = storageService.getPRs();
      const parentPR = prs.find(p => p.id === po.prId || p.prNo === po.prNo);
      if (parentPR) {
        if (!Array.isArray(parentPR.activityLog)) {
          parentPR.activityLog = [];
        }
        parentPR.activityLog.push({
          action: 'ใบสั่งซื้ออ้างอิงถูกยกเลิก (Referenced PO Cancelled)',
          user: user.name,
          role: user.title,
          timestamp,
          note: `ใบสั่งซื้อ ${po.poNo} ถูกยกเลิก: ${reason.trim()}`
        });
        storageService.savePRs(prs);
      }
    }

    // Dispatch Notification
    notificationService.dispatch({
      type: 'PO_CANCELLED',
      title: '❌ ใบสั่งซื้อ (PO) ถูกยกเลิก',
      message: `ใบสั่งซื้อ ${po.poNo} (อ้างอิง PR ${po.prNo}) แผนก ${po.department} ถูกยกเลิกโดย ${user.name}: ${reason.trim()}`,
      docNo: po.poNo,
      refDocType: 'PO',
      refDocId: po.id,
      department: po.department,
      targetRoles: [po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER', 'PLANT_MANAGER'],
      amount: po.grandTotal,
      actor: user.name
    });

    return po;
  },
  
  // Calculate Budget (Zero-Based Budgeting with MoM Comparative Analytics)
  calculateBudgetSummary(targetMonthStr) {
    const prs = storageService.getPRs();
    const pos = storageService.getPOs();
    const budgets = storageService.getBudgets();
    
    // Default to current month if not provided
    const today = new Date();
    const targetMonth = targetMonthStr || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    const currentSummary = {};
    const trends = {};

    const getTrendMonth = (m) => {
      if (!trends[m]) {
        trends[m] = {};
        Object.keys(DEPARTMENTS).forEach(dept => {
          const alloc = budgets[dept]?.history?.[m] || budgets[dept]?.monthlyBudget || DEPARTMENTS[dept].monthlyBudget;
          let histSpent = budgets[dept]?.historicalSpent?.[m];
          if (histSpent === undefined) {
            // Fallback deterministic simulation based on month hash
            const [y, mm] = m.split('-').map(Number);
            const factor = 0.65 + (((y * 12 + mm) * 17) % 30) / 100;
            histSpent = Math.round(alloc * factor);
          }
          trends[m][dept] = {
            baseAllocated: alloc,
            allocated: alloc,
            actualSpent: histSpent,
            committed: 0,
            totalSpent: histSpent,
            remaining: alloc - histSpent,
            percentage: alloc > 0 ? Math.round((histSpent / alloc) * 100) : 0
          };
        });
      }
      return trends[m];
    };

    // Pre-populate trend months: 24 months window around target
    const [tYear, tMonthNum] = targetMonth.split('-').map(Number);
    for (let i = 23; i >= 0; i--) {
      const d = new Date(tYear, tMonthNum - 1 - i, 1);
      const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      getTrendMonth(mStr);
    }
    getTrendMonth(targetMonth);

    // Sum PO spending
    pos.forEach(po => {
      if (!['CANCELLED'].includes(po.status)) {
        const total = po.items.reduce((sum, item) => sum + (item.actUnitPrice ? item.actUnitPrice * item.qty : (item.price * item.qty)), 0);
        const poMonth = po.issueDate ? po.issueDate.substring(0, 7) : targetMonth;
        const isActual = ['CLOSED', 'RECEIVED'].includes(po.status);
        
        const tMonth = getTrendMonth(poMonth);
        if (tMonth[po.department]) {
          if (isActual) {
            // Add to actual spent if real PO exists
            tMonth[po.department].actualSpent += total;
          } else {
            tMonth[po.department].committed += total;
          }
        }
      }
    });

    // Sum PR commitments
    prs.forEach(pr => {
      if (['SUBMITTED', 'REVIEWED', 'APPROVED'].includes(pr.status)) {
        if (!pos.some(po => po.prId === pr.id)) {
          const prMonth = pr.requestedDate ? pr.requestedDate.substring(0, 7) : targetMonth;
          const tMonth = getTrendMonth(prMonth);
          if (tMonth[pr.department]) {
            tMonth[pr.department].committed += (pr.totalAmount || 0);
          }
        }
      }
    });

    // ── Apply refundCredits ──
    Object.keys(DEPARTMENTS).forEach(dept => {
      const deptBudget = budgets[dept];
      if (!deptBudget?.refundCredits) return;

      Object.keys(deptBudget.refundCredits).forEach(month => {
        const credit = deptBudget.refundCredits[month];
        if (credit > 0 && trends[month] && trends[month][dept]) {
          trends[month][dept].actualSpent = Math.max(
            0,
            Math.round((trends[month][dept].actualSpent - credit) * 100) / 100
          );
        }
      });
    });

    // ── Zero-Based Monthly Recalculation (No Rollover / 100% Reset Each Month) ──
    // Formula: remaining = baseAllocated - (committedAmount + actualSpent)
    Object.keys(trends).forEach(m => {
      Object.keys(DEPARTMENTS).forEach(dept => {
        const d = trends[m][dept];
        const baseAllocated = budgets[dept]?.history?.[m] || budgets[dept]?.monthlyBudget || DEPARTMENTS[dept].monthlyBudget;
        const actualSpent = Number(d.actualSpent) || 0;
        const committed = Number(d.committed) || 0;
        const totalSpent = actualSpent + committed;
        const remaining = baseAllocated - totalSpent;
        const percentage = baseAllocated > 0 ? Math.round((totalSpent / baseAllocated) * 100) : 0;

        d.baseAllocated = baseAllocated;
        d.allocated = baseAllocated;
        d.actualSpent = actualSpent;
        d.committed = committed;
        d.totalSpent = totalSpent;
        d.remaining = remaining;
        d.percentage = percentage;
      });
    });

    // Compute previous month key for MoM comparison
    const prevDate = new Date(tYear, tMonthNum - 2, 1);
    const prevMonthKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    const prevMonthData = trends[prevMonthKey] || null;

    // Populate currentSummary for the selected targetMonth with MoM metrics
    Object.keys(DEPARTMENTS).forEach(dept => {
      const targetData = trends[targetMonth]?.[dept];
      const prevData = prevMonthData?.[dept] || null;

      let momDelta = null;
      if (prevData && prevData.totalSpent > 0 && targetData) {
        const spentDiff = targetData.totalSpent - prevData.totalSpent;
        const spentPercentDiff = Math.round(((targetData.totalSpent - prevData.totalSpent) / prevData.totalSpent) * 1000) / 10;
        momDelta = {
          spentDiff,
          spentPercentDiff,
          prevSpent: prevData.totalSpent,
          prevAllocated: prevData.baseAllocated,
          isHigher: spentDiff > 0,
          isLower: spentDiff < 0,
          isEqual: spentDiff === 0
        };
      } else if (prevData && targetData) {
        const spentDiff = targetData.totalSpent - (prevData.totalSpent || 0);
        momDelta = {
          spentDiff,
          spentPercentDiff: 0,
          prevSpent: prevData.totalSpent || 0,
          prevAllocated: prevData.baseAllocated,
          isHigher: spentDiff > 0,
          isLower: spentDiff < 0,
          isEqual: spentDiff === 0
        };
      }

      if (targetData) {
        currentSummary[dept] = { ...targetData, momDelta };
      } else {
        const baseAlloc = budgets[dept]?.history?.[targetMonth] || budgets[dept]?.monthlyBudget || DEPARTMENTS[dept].monthlyBudget;
        currentSummary[dept] = {
          baseAllocated: baseAlloc,
          allocated: baseAlloc,
          actualSpent: 0,
          committed: 0,
          totalSpent: 0,
          remaining: baseAlloc,
          percentage: 0,
          momDelta: null
        };
      }
    });

    return {
      current: currentSummary,
      trends: trends,
      targetMonth: targetMonth,
      prevMonth: prevMonthKey
    };
  },


  isOverBudget(department, amount) {
    const summary = this.calculateBudgetSummary().current;
    const deptInfo = summary[department];
    if (!deptInfo) return false;
    const remaining = deptInfo.allocated - (deptInfo.actualSpent + deptInfo.committed);
    return amount > remaining;
  },

  // Generate PR No with Robust Max-Sequence Scan and Collision Guard
  generatePRNo(deptId) {
    const prs = storageService.getPRs() || [];
    return generateNextPRId(prs, deptId);
  },

  // Generate PO No with Robust Max-Sequence Scan and Collision Guard
  generatePONo(deptId, offset = 0) {
    const pos = storageService.getPOs() || [];
    return generateNextPOId(pos, deptId, new Date().getFullYear(), offset);
  },

  // Validate PR Business Rules (Directive 1)
  validatePR(prData, isDraft = false) {
    const draftFlag = isDraft || Boolean(prData?.isDraft);
    const isOnline = (prData?.purchaseChannel || prData?.orderType) === 'ONLINE';
    if (!draftFlag && isOnline) {
      const hasMissingImage = (prData?.items || []).some(item => {
        const imgs = item.images || item.attachments || [];
        return !imgs || imgs.length === 0;
      });
      if (hasMissingImage) {
        throw new Error('กรุณาแนบรูปภาพสินค้าให้ครบทุกรายการสำหรับงานจัดซื้อออนไลน์');
      }
    }
    return true;
  },

  // Create PR (Draft or Submitted)
  async createPR(prData, user, isDraft = false) {
    const prs = storageService.getPRs() || [];
    let prNo = this.generatePRNo(prData.department);
    const existingPrNos = new Set(prs.flatMap(p => [p.prNo, p.prNumber, p.id].filter(Boolean).map(s => String(s).trim().toUpperCase())));
    while (existingPrNos.has(prNo.toUpperCase())) {
      prNo = generateNextPRId([...prs, { prNo }], prData.department);
    }
    const isoNow = new Date().toISOString();
    const timestamp = new Date().toLocaleString('th-TH');

    const draftFlag = isDraft || Boolean(prData.isDraft);
    const status = draftFlag ? 'DRAFT' : 'SUBMITTED';

    // Mandatory Image Enforcement for Online Procurement (Directive 1)
    if (prData.enforceImageValidation || prData.validateImages) {
      this.validatePR(prData, draftFlag);
    }

    const headerVendorId = prData.purchaseChannel === 'SELF' ? (prData.vendorId || prData.supplierId || prData.vendor?.id || null) : null;
    const headerVendorName = prData.purchaseChannel === 'SELF' ? (prData.vendorName || prData.supplierName || prData.vendor?.name || null) : null;

    const formattedItems = (prData.items || []).map(item => {
      const pQty = Number(item.purchaseQty ?? item.qty) || 1;
      const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
      const sQty = Number(item.stockQty) || (pQty * rate);
      const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
      const sUnit = item.stockUnit || item.unit || 'ชิ้น';
      const price = parseFloat(item.price) || 0;
      const discountPercent = parseFloat(item.discountPercent) || 0;
      const discountAmount = parseFloat(item.discountAmount) || (discountPercent > 0 ? (price * pQty * (discountPercent / 100)) : 0);
      const rowTotal = Math.max(0, (price * pQty) - discountAmount);
      const vId = headerVendorId || item.vendorId || item.supplierId || null;
      const vName = headerVendorName || item.vendorName || item.supplierName || null;

      const userImages = (Array.isArray(item.images) && item.images.length > 0)
        ? item.images
        : (Array.isArray(item.attachments) ? item.attachments : []);

      return {
        ...item,
        images: userImages,
        attachments: userImages,
        purchaseQty: pQty,
        stockQty: sQty,
        qty: pQty,
        purchaseUnit: pUnit,
        stockUnit: sUnit,
        unit: pUnit,
        conversionRate: rate,
        price,
        discountPercent,
        discountAmount,
        vendorId: vId,
        vendorName: vName,
        supplierId: vId,
        supplierName: vName,
        total: rowTotal,
        source: item.source === 'OFFICE' ? 'OFFICE' : 'FACTORY'
      };
    });

    const isSelfChannel = prData.purchaseChannel === 'SELF';
    const subtotal = formattedItems.reduce((sum, item) => sum + (item.purchaseQty * item.price), 0);
    const itemDiscountTotal = formattedItems.reduce((sum, item) => sum + (parseFloat(item.discountAmount) || 0), 0);
    const netAfterItemDiscount = Math.max(0, subtotal - itemDiscountTotal);

    let financials = null;
    let totalAmount = subtotal;

    if (isSelfChannel && (prData.financials || prData.vatMode || prData.hasVat !== undefined)) {
      const fin = prData.financials || {};
      const combinedDiscountType = fin.combinedDiscountType || prData.combinedDiscountType || 'percent';
      const combinedDiscountValue = parseFloat(fin.combinedDiscountValue ?? prData.combinedDiscountValue) || 0;
      const combinedDiscountAmount = combinedDiscountType === 'percent'
        ? (netAfterItemDiscount * (combinedDiscountValue / 100))
        : combinedDiscountValue;
      const totalDiscount = itemDiscountTotal + combinedDiscountAmount;
      const netAfterAllDiscount = Math.max(0, subtotal - totalDiscount);

      const hasVat = fin.hasVat !== undefined ? Boolean(fin.hasVat) : (prData.hasVat !== undefined ? Boolean(prData.hasVat) : true);
      const vatMode = fin.vatMode || prData.vatMode || (hasVat ? 'AFTER_DISCOUNT' : 'NONE');
      const vatBase = vatMode === 'BEFORE_DISCOUNT' ? subtotal : netAfterAllDiscount;
      const vatAmount = (vatMode === 'NONE' || !hasVat) ? 0 : (parseFloat((vatBase * 0.07).toFixed(2)) || 0);
      const roundingAdj = parseFloat(fin.roundingAdj ?? prData.roundingAdj) || 0;
      const shippingCost = parseFloat(fin.shippingCost ?? prData.shippingCost) || 0;

      const grandTotal = vatMode === 'BEFORE_DISCOUNT'
        ? parseFloat((subtotal + vatAmount - totalDiscount + roundingAdj + shippingCost).toFixed(2))
        : parseFloat((netAfterAllDiscount + vatAmount + roundingAdj + shippingCost).toFixed(2));

      financials = {
        subtotal,
        itemDiscountTotal,
        combinedDiscountType,
        combinedDiscountValue,
        combinedDiscountAmount,
        totalDiscount,
        vatMode,
        vatAmount,
        roundingAdj,
        shippingCost,
        grandTotal
      };
      totalAmount = grandTotal;
    } else {
      financials = {
        subtotal,
        itemDiscountTotal,
        combinedDiscountType: 'fixed',
        combinedDiscountValue: 0,
        combinedDiscountAmount: 0,
        totalDiscount: itemDiscountTotal,
        vatMode: 'NONE',
        vatAmount: 0,
        roundingAdj: 0,
        shippingCost: 0,
        grandTotal: prData.totalAmount !== undefined ? prData.totalAmount : Math.max(0, subtotal - itemDiscountTotal)
      };
      totalAmount = financials.grandTotal;
    }

    const newPR = {
      id: `PR-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
      prNo,
      department: prData.department,
      source: prData.source || 'FACTORY',
      purchaseChannel: prData.purchaseChannel || 'SELF',
      vendorId: headerVendorId || prData.vendorId || null,
      vendorName: headerVendorName || prData.vendorName || null,
      vendor: prData.vendor || null,
      supplierId: headerVendorId || prData.vendorId || prData.supplierId || null,
      supplierName: headerVendorName || prData.vendorName || prData.supplierName || null,
      hasVat: prData.hasVat !== undefined ? Boolean(prData.hasVat) : (financials?.hasVat ?? false),
      specUrl: prData.specUrl || '',
      attachments: prData.attachments || [],
      note: prData.note || '',
      items: formattedItems,
      financials,
      totalAmount,
      status,
      requestedBy: user.name,
      requestedByRole: user.title,
      requestedDept: user.department,
      createdAt: prData.createdAt || isoNow,
      submittedAt: draftFlag ? null : (prData.submittedAt || isoNow),
      updatedAt: isoNow,
      approvalHistory: [
        {
          actorName: user.name,
          actorRole: user.title || user.role,
          action: draftFlag ? 'CREATED' : 'SUBMITTED',
          date: isoNow,
          timestamp: isoNow,
          comment: draftFlag ? 'สร้างแบบร่าง PR' : 'ยื่นเสนอขอซื้อเข้าสู่ระบบ'
        }
      ],
      memo: prData.memo || null,
      activityLog: [
        {
          action: isDraft ? 'สร้างแบบร่าง PR (Draft Created)' : 'สร้างและยื่นส่ง PR (PR Submitted)',
          user: user.name,
          role: user.title,
          timestamp,
          note: isDraft ? 'บันทึกแบบร่าง' : 'ยื่นเสนอขอซื้อเข้าสู่ระบบ'
        }
      ]
    };

    // Directive 3: Prevent Overwrite during save - Check if newPR.id already exists
    const existingIndex = prs.findIndex(p => p.id === newPR.id);
    let updatedPRs;
    if (existingIndex !== -1) {
      // Edit Mode
      updatedPRs = [...prs];
      updatedPRs[existingIndex] = newPR;
    } else {
      // Create Mode: STRICTLY Prepend as new row, never overwrite existing index
      updatedPRs = [newPR, ...prs];
    }
    storageService.savePRs(updatedPRs);

    auditService.logAction({
      action: isDraft ? 'PR_DRAFT_CREATED' : 'PR_SUBMITTED',
      actor: user,
      department: newPR.department,
      docNo: newPR.prNo,
      docType: 'PR',
      details: `${isDraft ? 'บันทึกแบบร่าง PR' : 'สร้างและยื่นส่งใบขอซื้อ'} เลขที่ ${newPR.prNo} ยอดรวม ฿${newPR.totalAmount.toLocaleString()}`
    });

    return newPR;
  },

  // Update & Resubmit existing Draft/Returned PR
  async updatePR(prId, prData, user, isDraft = false) {
    const prs = storageService.getPRs();
    const pr = prs.find(p => p.id === prId);
    if (!pr) throw new Error('ไม่พบเอกสาร PR ในระบบ');

    const draftFlag = isDraft || Boolean(prData.isDraft);
    if (prData.enforceImageValidation || prData.validateImages) {
      this.validatePR({ ...pr, ...prData, isDraft: draftFlag }, draftFlag);
    }

    const formattedItems = (prData.items || []).map(item => {
      const pQty = Number(item.purchaseQty ?? item.qty) || 1;
      const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
      const sQty = Number(item.stockQty) || (pQty * rate);
      const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
      const sUnit = item.stockUnit || item.unit || 'ชิ้น';
      const price = parseFloat(item.price) || 0;
      const discountPercent = parseFloat(item.discountPercent) || 0;
      const discountAmount = parseFloat(item.discountAmount) || (discountPercent > 0 ? (price * pQty * (discountPercent / 100)) : 0);
      const rowTotal = Math.max(0, (price * pQty) - discountAmount);

      const userImages = (Array.isArray(item.images) && item.images.length > 0)
        ? item.images
        : (Array.isArray(item.attachments) ? item.attachments : []);

      return {
        ...item,
        images: userImages,
        attachments: userImages,
        purchaseQty: pQty,
        stockQty: sQty,
        qty: pQty,
        purchaseUnit: pUnit,
        stockUnit: sUnit,
        unit: pUnit,
        conversionRate: rate,
        price,
        discountPercent,
        discountAmount,
        total: rowTotal,
        source: item.source === 'OFFICE' ? 'OFFICE' : 'FACTORY'
      };
    });

    const isSelfChannel = (prData.purchaseChannel || pr.purchaseChannel) === 'SELF';
    const subtotal = formattedItems.reduce((sum, item) => sum + (item.purchaseQty * item.price), 0);
    const itemDiscountTotal = formattedItems.reduce((sum, item) => sum + (parseFloat(item.discountAmount) || 0), 0);
    const netAfterItemDiscount = Math.max(0, subtotal - itemDiscountTotal);

    let financials = null;
    let newTotal = subtotal;

    if (isSelfChannel && (prData.financials || prData.vatMode)) {
      const fin = prData.financials || {};
      const combinedDiscountType = fin.combinedDiscountType || prData.combinedDiscountType || 'percent';
      const combinedDiscountValue = parseFloat(fin.combinedDiscountValue ?? prData.combinedDiscountValue) || 0;
      const combinedDiscountAmount = combinedDiscountType === 'percent'
        ? (netAfterItemDiscount * (combinedDiscountValue / 100))
        : combinedDiscountValue;
      const totalDiscount = itemDiscountTotal + combinedDiscountAmount;
      const netAfterAllDiscount = Math.max(0, subtotal - totalDiscount);

      const vatMode = fin.vatMode || prData.vatMode || 'AFTER_DISCOUNT';
      const vatBase = vatMode === 'BEFORE_DISCOUNT' ? subtotal : netAfterAllDiscount;
      const vatAmount = vatMode === 'NONE' ? 0 : (parseFloat((vatBase * 0.07).toFixed(2)) || 0);
      const roundingAdj = parseFloat(fin.roundingAdj ?? prData.roundingAdj) || 0;
      const shippingCost = parseFloat(fin.shippingCost ?? prData.shippingCost) || 0;

      const grandTotal = vatMode === 'BEFORE_DISCOUNT'
        ? parseFloat((subtotal + vatAmount - totalDiscount + roundingAdj + shippingCost).toFixed(2))
        : parseFloat((netAfterAllDiscount + vatAmount + roundingAdj + shippingCost).toFixed(2));

      financials = {
        subtotal,
        itemDiscountTotal,
        combinedDiscountType,
        combinedDiscountValue,
        combinedDiscountAmount,
        totalDiscount,
        vatMode,
        vatAmount,
        roundingAdj,
        shippingCost,
        grandTotal
      };
      newTotal = grandTotal;
    } else {
      financials = {
        subtotal,
        itemDiscountTotal,
        combinedDiscountType: 'fixed',
        combinedDiscountValue: 0,
        combinedDiscountAmount: 0,
        totalDiscount: itemDiscountTotal,
        vatMode: 'NONE',
        vatAmount: 0,
        roundingAdj: 0,
        shippingCost: 0,
        grandTotal: prData.totalAmount !== undefined ? prData.totalAmount : Math.max(0, subtotal - itemDiscountTotal)
      };
      newTotal = financials.grandTotal;
    }

    const isoNow = new Date().toISOString();
    const timestamp = new Date().toLocaleString('th-TH');
    const nextStatus = draftFlag ? 'DRAFT' : 'SUBMITTED';

    pr.department = prData.department || pr.department;
    pr.source = prData.source || pr.source;
    pr.purchaseChannel = prData.purchaseChannel || pr.purchaseChannel;
    pr.specUrl = prData.specUrl || '';
    pr.attachments = prData.attachments || [];
    pr.items = formattedItems;
    pr.financials = financials;
    pr.totalAmount = newTotal;
    pr.note = prData.note || '';
    if (prData.memo !== undefined) pr.memo = prData.memo;
    pr.status = nextStatus;
    pr.updatedAt = isoNow;
    if (!draftFlag && !pr.submittedAt) {
      pr.submittedAt = isoNow;
    }

    if (!Array.isArray(pr.activityLog)) pr.activityLog = [];
    pr.activityLog.push({
      action: draftFlag ? 'แก้ไขและบันทึกแบบร่าง (Draft Updated)' : 'แก้ไขและส่งใบ PR ใหม่ (PR Resubmitted)',
      user: user.name,
      role: user.title,
      timestamp,
      note: draftFlag 
        ? 'ผู้ขอซื้อแก้ไขข้อมูลและบันทึกแบบร่าง' 
        : `ผู้ขอซื้อแก้ไขข้อมูลและยื่นส่งใหม่อีกครั้ง (ยอดรวม ฿${newTotal.toLocaleString()})`
    });

    if (!draftFlag) {
      if (!Array.isArray(pr.approvalHistory)) pr.approvalHistory = [];
      pr.approvalHistory.push({
        actorName: user.name,
        actorRole: user.title || user.role,
        action: 'SUBMITTED',
        date: isoNow,
        timestamp: isoNow,
        comment: 'ผู้ขอซื้อแก้ไขข้อมูลและยื่นส่งใหม่อีกครั้ง'
      });
    }

    storageService.savePRs(prs);

    auditService.logAction({
      action: draftFlag ? 'PR_DRAFT_UPDATED' : 'PR_RESUBMITTED',
      actor: user,
      department: pr.department,
      docNo: pr.prNo,
      docType: 'PR',
      details: `${draftFlag ? 'แก้ไขแบบร่าง' : 'แก้ไขและยื่นส่งใหม่'} PR เลขที่ ${pr.prNo} ยอดรวม ฿${newTotal.toLocaleString()}`
    });

    if (!draftFlag) {
      notificationService.dispatch({
        type: 'PR_SUBMITTED',
        title: 'มีการยื่นส่งใบขอซื้อ (PR) ที่แก้ไขใหม่',
        message: `ใบขอซื้อเลขที่ ${pr.prNo} (${pr.department}) ยอดเงิน ฿${newTotal.toLocaleString()} ได้รับการแก้ไขและส่งใหม่ รอตรวจสอบ`,
        docNo: pr.prNo,
        refDocType: 'PR',
        refDocId: pr.id,
        department: pr.department,
        targetRoles: ['ASST_MANAGER', 'ADMIN'],
        amount: newTotal,
        actor: user.name
      });
    }

    return pr;
  },
  
  // Submit existing Draft/Rejected PR
  async submitPR(prId, user, memoData = null) {
    const prs = storageService.getPRs();
    const pr = prs.find(p => p.id === prId);
    if (!pr) throw new Error('PR not found');

    if (memoData) {
      pr.memo = memoData;
    }

    const isoNow = new Date().toISOString();
    pr.status = 'SUBMITTED';
    pr.submittedAt = isoNow;
    pr.updatedAt = isoNow;

    if (!Array.isArray(pr.activityLog)) pr.activityLog = [];
    pr.activityLog.push({
      action: 'ส่งพิจารณา (Submit)',
      user: user.name,
      role: user.title,
      timestamp: new Date().toLocaleString('th-TH'),
      note: 'ส่ง PR เข้าสู่ระบบเพื่อพิจารณา'
    });

    if (!Array.isArray(pr.approvalHistory)) pr.approvalHistory = [];
    pr.approvalHistory.push({
      actorName: user.name,
      actorRole: user.title || user.role,
      action: 'SUBMITTED',
      date: isoNow,
      timestamp: isoNow,
      comment: 'ส่ง PR เข้าสู่ระบบเพื่อพิจารณา'
    });
    
    storageService.savePRs(prs);

    auditService.logAction({
      action: 'PR_SUBMITTED',
      actor: user,
      department: pr.department,
      docNo: pr.prNo,
      docType: 'PR',
      details: `ส่งใบขอซื้อเลขที่ ${pr.prNo} ยอดเงิน ฿${(pr.totalAmount || 0).toLocaleString()} เข้าสู่ระบบเพื่อตรวจสอบ`
    });

    // Dispatch In-App Notification
    notificationService.dispatch({
      type: 'PR_SUBMITTED',
      title: 'มีคำขอซื้อใหม่รอการตรวจสอบ (Review Level 1)',
      message: `ใบขอซื้อเลขที่ ${pr.prNo} แผนก ${pr.department} ยอดเงิน ฿${(pr.totalAmount || 0).toLocaleString()} รอคุณสมชาย (Asst. Manager) ตรวจสอบ`,
      docNo: pr.prNo,
      refDocType: 'PR',
      refDocId: pr.id,
      department: pr.department,
      targetRoles: ['ASST_MANAGER', 'ADMIN'],
      amount: pr.totalAmount,
      actor: user.name
    });

    return pr;
  },

  // Update Status & Handle Workflow Transitions
  async updatePRStatus(prId, nextStatus, user, note = '') {
    const prs = storageService.getPRs();
    const index = prs.findIndex(p => p.id === prId);
    if (index === -1) throw new Error('PR not found');

    const pr = prs[index];
    const previousStatus = pr.status;
    const timestamp = new Date().toLocaleString('th-TH');

    let actionLabel = 'อัพเดทสถานะ';
    if (nextStatus === 'REVIEWED') actionLabel = 'ตรวจสอบแล้ว (Level 1 - Asst Mgr)';
    if (nextStatus === 'APPROVED') actionLabel = 'อนุมัติ (Final Approval - Plant Mgr)';
    if (nextStatus === 'REJECTED_TO_DRAFT') actionLabel = 'ไม่อนุมัติ / ตีกลับให้แก้ไข (Rejected to Draft)';
    if (nextStatus === 'CANCELLED') actionLabel = 'ยกเลิกเอกสาร (Cancelled)';

    if (!Array.isArray(pr.activityLog)) pr.activityLog = [];
    pr.activityLog.push({
      action: actionLabel,
      user: user.name,
      role: user.title,
      timestamp,
      note: note || `เปลี่ยนสถานะเป็น ${PR_STATUS[nextStatus]?.label}`
    });

    if (!Array.isArray(pr.approvalHistory)) pr.approvalHistory = [];
    pr.approvalHistory.push({
      actorName: user.name,
      actorRole: user.title || user.role,
      action: nextStatus,
      date: timestamp,
      timestamp,
      comment: note || ''
    });

    if (nextStatus === 'REVIEWED') {
      const reviewerSig = user?.signature || 
        storageService.getSignatureByRole?.(user?.roleId || user?.id)?.signatureUrl || 
        storageService.getSignatures?.()?.[user?.roleId || 'ASST_MANAGER']?.signatureUrl || 
        null;
      const realName = user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : 'คุณสมชาย มุ่งมั่น');
      pr.reviewedBy = {
        id: user?.id || user?.userId || 'USR-0003',
        name: realName,
        signature: reviewerSig,
        timestamp: new Date().toISOString()
      };
      pr.reviewerName = pr.reviewedBy.name;
      pr.reviewerSignature = pr.reviewedBy.signature;
      pr.reviewedAt = pr.reviewedBy.timestamp;
    }

    let generatedPO = null;
    if (nextStatus === 'APPROVED') {
      const appUserSig = user?.signature || 
        storageService.getSignatureByRole?.(user?.roleId || user?.id)?.signatureUrl || 
        storageService.getSignatures?.()?.[user?.roleId || 'PLANT_MANAGER']?.signatureUrl || 
        null;
      const appRealName = user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : 'คุณประเสริฐ ยิ่งยง');
      pr.approvedBy = {
        id: user?.id || user?.userId || 'USR-0005',
        name: appRealName,
        signature: appUserSig,
        timestamp: new Date().toISOString()
      };
      pr.approverName = pr.approvedBy.name;
      pr.approverSignature = pr.approvedBy.signature;
      pr.approvedAt = pr.approvedBy.timestamp;

      const currentNorm = String(previousStatus || '').toLowerCase();
      // State Machine Guard: Cannot approve or issue PO if PR has not been reviewed
      if (['waiting_review', 'submitted', 'draft', 'rejected_to_draft', 'rejected_to_l2', 'waiting_approval'].includes(currentNorm)) {
        throw new Error(`ไม่อนุญาตให้อนุมัติออกใบสั่งซื้อ (PO): ใบขอซื้อ ${pr.prNo || pr.id} อยู่ในสถานะ "${previousStatus}" ซึ่งยังไม่ผ่านการตรวจทาน (ต้องผ่านการตรวจทานเป็นสถานะ REVIEWED ก่อนเท่านั้น)`);
      }
      pr.status = 'APPROVED';
      pr.workflowStatus = 'APPROVED';
      generatedPO = await this.createPOFromPR(pr, user);
      const hasAnyLink = (pr.items || []).some(item => !!(item.productUrl || item.onlineUrl || item.url));
      const isOnlinePr = pr.purchaseChannel === 'ONLINE' || pr.purchaseChannel === 'ONLINE_PURCHASE' || hasAnyLink;
      const finalApprovedStatus = isOnlinePr ? 'IN_PROGRESS_ONLINE' : 'PO_ISSUED';
      pr.status = finalApprovedStatus;
      pr.workflowStatus = finalApprovedStatus;
      if (Array.isArray(generatedPO) && generatedPO.length > 0) {
        pr.poNumbers = generatedPO.map(p => p.poNo);
        pr.poNumber = generatedPO.map(p => p.poNo).join(', ');
        pr.poNo = generatedPO[0].poNo;
        pr.poId = generatedPO[0].id;
      } else if (generatedPO) {
        pr.poNumber = generatedPO.poNo;
        pr.poNo = generatedPO.poNo;
        pr.poId = generatedPO.id;
      }
    } else {
      pr.status = nextStatus;
      pr.workflowStatus = nextStatus;
    }

    storageService.savePRs(prs);

    // BUDGET LOGGING
    if (nextStatus === 'APPROVED') {
      budgetService.logBudgetTransaction({
        department: pr.department,
        type: 'PR_COMMITMENT',
        amount: -(pr.totalAmount || 0),
        docType: 'PR',
        docRef: pr.prNo || pr.id,
        description: `กันเงินผูกพันอนุมัติ PR ${pr.prNo}`,
        recordedBy: user.name || 'System'
      });
    } else if (nextStatus === 'REJECTED_TO_DRAFT' || nextStatus === 'CANCELLED') {
      budgetService.logBudgetTransaction({
        department: pr.department,
        type: 'PR_RELEASE',
        amount: Math.abs(pr.totalAmount || 0),
        docType: 'PR',
        docRef: pr.prNo || pr.id,
        description: `คืนเงินผูกพัน PR ${nextStatus === 'CANCELLED' ? 'ยกเลิก' : 'ไม่อนุมัติ'} ${pr.prNo}`,
        recordedBy: user.name || 'System'
      });
    }

    // Dispatch In-App Notification for Review / Reject
    if (nextStatus === 'REVIEWED') {
      notificationService.dispatch({
        type: 'PR_REVIEWED',
        title: 'PR ผ่านการตรวจสอบแล้ว รออนุมัติสั่งซื้อ (Final Approve)',
        message: `ใบขอซื้อเลขที่ ${pr.prNo} แผนก ${pr.department} ยอดเงิน ฿${(pr.totalAmount || 0).toLocaleString()} ผ่านการตรวจ Level 1 แล้ว รอคุณประเสริฐ (Plant Manager) อนุมัติ`,
        docNo: pr.prNo,
        refDocType: 'PR',
        refDocId: pr.id,
        department: pr.department,
        targetRoles: ['PLANT_MANAGER', 'ADMIN'],
        amount: pr.totalAmount,
        actor: user.name
      });
    } else if (nextStatus === 'REJECTED_TO_DRAFT') {
      notificationService.dispatch({
        type: 'PR_REJECTED',
        title: 'ใบขอซื้อ (PR) ถูกส่งกลับให้แก้ไข / ไม่อนุมัติ',
        message: `ใบขอซื้อเลขที่ ${pr.prNo} ถูกส่งกลับโดย ${user.name}: ${note || 'กรุณาตรวจสอบรายละเอียดและแก้ไข'}`,
        reason: note || '',
        rejectReason: note || '',
        docNo: pr.prNo,
        refDocType: 'PR',
        refDocId: pr.id,
        department: pr.department,
        targetRoles: [pr.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN'],
        amount: pr.totalAmount,
        actor: user.name
      });
    }

    return { pr, po: generatedPO };
  },

  // Auto Create PO from PR (Workflow Engine Logic)
  async createPOFromPR(pr, user) {
    if (!pr) throw new Error('ไม่พบข้อมูลใบขอซื้อ (PR not found)');

    // Strict State Machine Guard: PO can ONLY be generated if PR status is 'approved'
    const normalizedStatus = String(pr.status || '').toLowerCase();
    const isApproved = ['approved', 'po_issued', 'in_progress_online'].includes(normalizedStatus);
    if (!isApproved) {
      throw new Error(`ไม่อนุญาตให้ออกใบสั่งซื้อ (PO): ใบขอซื้อ ${pr.prNo || pr.id} อยู่ในสถานะ "${pr.status}" ซึ่งยังไม่ผ่านการอนุมัติ (สถานะต้องผ่านการอนุมัติเป็น APPROVED จาก Plant Manager เท่านั้น ห้ามสร้างจาก waiting_review หรือ waiting_approval)`);
    }

    const pos = storageService.getPOs();
    const vendors = storageService.getVendors();
    const products = storageService.getProducts();
    const timestamp = new Date().toLocaleString('th-TH');

    // Idempotent Guard: Check if PO(s) for this PR already exist in storage
    const targetPrNo = pr.prNo || pr.prNumber;
    const existingPOs = (pos || []).filter(p => 
      (p.prId && pr.id && p.prId === pr.id) || 
      (p.prNo && targetPrNo && p.prNo === targetPrNo)
    );
    if (existingPOs.length > 0) {
      console.log(`[WorkflowEngine] Idempotent Guard: PO already exists for PR (${targetPrNo || pr.id}). Skipping creation.`);
      return existingPOs.length === 1 ? existingPOs[0] : existingPOs;
    }
    
    // Group items for PO generation:
    // 1. If Online Purchase: Exactly 1 PO routed to Online Procurement Hub
    // 2. If Internal Purchase (SELF): Exactly 1 PO for the selected Master Vendor (1 PR = 1 Vendor)
    // 3. Fallback for legacy records: Group by supplierId
    const hasAnyLink = (pr.items || []).some(item => !!(item.productUrl || item.onlineUrl || item.url));
    const isOnlinePr = pr.purchaseChannel === 'ONLINE' || pr.purchaseChannel === 'ONLINE_PURCHASE' || hasAnyLink;

    let groups = {};
    if (isOnlinePr) {
      groups['ONLINE'] = pr.items || [];
    } else if (pr.vendorId || pr.vendor?.id) {
      const vId = pr.vendorId || pr.vendor?.id;
      groups[vId] = pr.items || [];
    } else {
      // Fallback for legacy PRs without header vendorId
      (pr.items || []).forEach(item => {
        const prod = products.find(p => p.id === item.productId);
        const supplierId = item.vendorId || item.supplierId || prod?.supplierId || prod?.preferredSupplier || 'NULL';
        if (!Array.isArray(groups[supplierId])) {
          groups[supplierId] = [];
        }
        groups[supplierId].push(item);
      });
    }

    const generatedPOs = [];
    let splitIdx = 0;
    const isSplit = Object.keys(groups).length > 1;

    for (const [vendorId, items] of Object.entries(groups)) {
      let vendor = (vendorId !== 'NULL' && vendorId !== 'ONLINE') 
        ? vendors.find(v => v.id === vendorId || v.code === vendorId || v.name === vendorId) 
        : null;
      if (!vendor && pr.vendor && typeof pr.vendor === 'object') {
        vendor = pr.vendor;
      }
      
      // Consecutive PO running numbers with collision guard (e.g. PO-PD-2026-005, PO-PD-2026-006)
      let poNo = this.generatePONo(pr.department, splitIdx);
      const existingPoNos = new Set([
        ...pos.map(p => (p.poNo || p.poNumber || p.id || '').toUpperCase()),
        ...generatedPOs.map(p => (p.poNo || p.poNumber || p.id || '').toUpperCase())
      ]);
      let offset = splitIdx;
      while (existingPoNos.has(poNo.toUpperCase())) {
        offset++;
        poNo = this.generatePONo(pr.department, offset);
      }
      splitIdx++;
      
      const subtotal = items.reduce((sum, item) => sum + ((parseFloat(item.price) || 0) * (item.purchaseQty ?? item.qty ?? 1)), 0);
      const itemDiscountTotal = items.reduce((sum, item) => sum + (parseFloat(item.discountAmount) || 0), 0);
      
      let vat = 0;
      let grandTotal = subtotal;
      let financials = null;

      const hasVat = pr.hasVat !== undefined 
        ? Boolean(pr.hasVat) 
        : (pr.financials?.hasVat !== undefined ? Boolean(pr.financials.hasVat) : (pr.financials?.vatMode !== 'NONE'));

      if (!isOnlinePr) {
        const prFin = pr.financials || {};
        if (!isSplit && prFin && prFin.grandTotal !== undefined) {
          financials = { ...prFin };
          vat = Number(prFin.vatAmount) || 0;
          grandTotal = Number(prFin.grandTotal) || subtotal;
        } else {
          const netAfterItemDiscount = Math.max(0, subtotal - itemDiscountTotal);
          const vatAmount = hasVat ? parseFloat((netAfterItemDiscount * 0.07).toFixed(2)) : 0;
          vat = vatAmount;
          grandTotal = parseFloat((netAfterItemDiscount + vatAmount).toFixed(2));

          financials = {
            subtotal,
            itemDiscountTotal,
            combinedDiscountType: 'fixed',
            combinedDiscountValue: 0,
            combinedDiscountAmount: 0,
            totalDiscount: itemDiscountTotal,
            hasVat,
            vatMode: hasVat ? 'AFTER_DISCOUNT' : 'NONE',
            vatAmount,
            roundingAdj: 0,
            shippingCost: 0,
            grandTotal
          };
        }
      } else {
        grandTotal = subtotal;
        financials = {
          subtotal,
          itemDiscountTotal: 0,
          combinedDiscountType: 'fixed',
          combinedDiscountValue: 0,
          combinedDiscountAmount: 0,
          totalDiscount: 0,
          hasVat: false,
          vatMode: 'NONE',
          vatAmount: 0,
          roundingAdj: 0,
          shippingCost: 0,
          grandTotal: subtotal
        };
      }

      const poStatus = isOnlinePr ? 'IN_PROGRESS_ONLINE' : 'ISSUED';
      
      let vId = vendor?.id || (!isOnlinePr ? (pr.vendorId || (vendorId !== 'NULL' && vendorId !== 'ONLINE' ? vendorId : null)) : null);
      let vName = vendor?.name || (!isOnlinePr ? (pr.vendorName || vendor?.name || 'ไม่ระบุผู้ขาย (รอจัดซื้อดำเนินการ)') : 'ไม่ระบุผู้ขาย (รอจัดซื้อดำเนินการ)');
      if (isOnlinePr) {
        vId = null;
        const onlineStores = Array.from(new Set((items || []).map(i => (i.actualStoreName || i.storeName || '').trim()).filter(s => s && !s.includes('ระบุร้านภายหลัง'))));
        if (onlineStores.length === 1) {
          vName = onlineStores[0];
        } else if (onlineStores.length > 1) {
          vName = 'แพลตฟอร์ม Shopee / Lazada Marketplace (สั่งซื้อออนไลน์)';
        } else {
          vName = pr.shopName || 'Shopee / Lazada (ระบุร้านภายหลัง)';
        }
      }

      // Copy complete Vendor Object from Master Data (5 points: name, taxId, address, contactPerson, phone)
      const vendorObj = vendor ? {
        id: vendor.id,
        code: vendor.code || '',
        name: vendor.name || '',
        taxId: vendor.taxId || '',
        address: vendor.address || '',
        phone: vendor.phone || '',
        email: vendor.email || '',
        contactPerson: vendor.contactPerson || ''
      } : (pr.vendor && typeof pr.vendor === 'object' ? pr.vendor : null);

      const newPO = {
        id: `PO-${Date.now()}-${splitIdx}`,
        poNo,
        prId: pr.id,
        prNo: pr.prNo,
        prNumber: pr.prNo || pr.id,
        // ─── Snapshot PR ownership data so Requester can always access this PO ───
        requestedBy: pr.requestedBy || '',
        requesterId: pr.requesterId || null,
        requesterSignature: pr.requesterSignature || null,
        department: pr.department,
        // ─── Stakeholders snapshot (Requester / Reviewer / Approver) ───
        // บันทึกข้อมูลผู้เกี่ยวข้องทั้งหมดจาก PR ลงใน PO ใหม่ เพื่อให้
        // isUserStakeholder ทำงานได้โดยไม่ต้องค้นย้อนหลัง parent PR
        stakeholders: {
          requesterId: pr.requesterId || null,
          requesterName: pr.requestedBy || pr.requesterName || pr.applicantName1 || '',
          reviewerNames: pr.reviewerName
            ? [pr.reviewerName]
            : (pr.reviewedBy && typeof pr.reviewedBy === 'object' && pr.reviewedBy.name
              ? [pr.reviewedBy.name]
              : (typeof pr.reviewedBy === 'string' && pr.reviewedBy ? [pr.reviewedBy] : [])),
          reviewerIds: pr.reviewerId ? [pr.reviewerId] : [],
          approverNames: [user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : '') || ''].filter(Boolean),
          approverIds: [user?.id || user?.uid || ''].filter(Boolean),
          department: pr.department,
        },
        vendorId: vId,
        vendorName: vName,
        vendor: vendorObj || vName,
        vendorDetails: vendorObj,
        purchaseChannel: isOnlinePr ? 'ONLINE' : 'SELF',
        onlineLink: pr.onlineLink || null,
        specUrl: pr.specUrl || null,
        issueDate: new Date().toISOString().split('T')[0],
        status: poStatus,
        // ─── Reviewer details forwarded from PR ───
        reviewedBy: (pr.reviewedBy && typeof pr.reviewedBy === 'object') ? pr.reviewedBy : (pr.reviewerName ? { name: pr.reviewerName, signature: pr.reviewerSignature || null, timestamp: pr.reviewedAt || null } : null),
        reviewerName: (pr.reviewedBy && typeof pr.reviewedBy === 'object' ? pr.reviewedBy.name : null) || pr.reviewerName || (typeof pr.reviewedBy === 'string' && pr.reviewedBy !== 'Admin System' ? pr.reviewedBy : null) || null,
        reviewerSignature: (pr.reviewedBy && typeof pr.reviewedBy === 'object' ? pr.reviewedBy.signature : null) || pr.reviewerSignature || null,
        reviewedAt: (pr.reviewedBy && typeof pr.reviewedBy === 'object' ? pr.reviewedBy.timestamp : null) || pr.reviewedAt || null,
        // ─── Approver details ───
        approvedBy: user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : 'คุณประเสริฐ ยิ่งยง'),
        approverName: user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : 'คุณประเสริฐ ยิ่งยง'),
        approverSignature: user?.signature || storageService.getSignatureByRole?.(user?.roleId || user?.id)?.signatureUrl || storageService.getSignatures?.()?.[user?.roleId || 'PLANT_MANAGER']?.signatureUrl || null,
        approvedAt: timestamp,
        // ─── Receiver details (strictly blank until goods physically received) ───
        receivedBy: null,
        receiverName: null,
        receiverSignature: null,
        receivedAt: null,
        items: items.map(item => {
          const pQty = Number(item.purchaseQty ?? item.qty) || 0;
          const cleanCode = String(item.code || item.sku || item.productId || '').trim().toUpperCase();

          // ✅ ตรวจสอบรูปภาพจริงของผู้ใช้เป็นลำดับแรก (User Upload First)
          const userImages = (Array.isArray(item.images) && item.images.length > 0)
            ? item.images
            : ((Array.isArray(item.attachments) && item.attachments.length > 0) ? item.attachments : null);

          // ดึง fallback เฉพาะเมื่อผู้ใช้ไม่ได้แนบรูปมาจริง ๆ เท่านั้น
          const finalAttachments = userImages || FALLBACK_SEED_ATTACHMENTS[cleanCode] || [];

          return {
            ...item,
            orderedQty: pQty,
            receivedQty: 0,
            damagedQty: 0,
            shortageQty: 0,
            receivedStockQty: 0,
            receivedNgQty: 0,
            remainingQty: pQty,
            claimStatus: null,
            actUnitPrice: null,
            source: item.source || 'FACTORY',
            discountPercent: parseFloat(item.discountPercent) || 0,
            discountAmount: parseFloat(item.discountAmount) || 0,
            actualStoreName: item.actualStoreName || item.storeName || '',
            storePlatform: item.storePlatform || item.platform || 'Shopee',
            orderRefNo: item.orderRefNo || '',
            attachments: finalAttachments,
            images: finalAttachments,
            productUrl: item.productUrl || item.onlineUrl || item.link || ''
          };
        }),
        prAttachments: [
          ...(pr.quotationFiles || []),
          ...(pr.generalAttachments || []),
          ...(pr.attachments || []),
          ...(pr.images || [])
        ],
        financials,
        subtotal,
        vat,
        grandTotal,
        history: [],
        timeline: [],
        claimHistory: [],
        attachments: [],
        comments: [],
        activityLog: [
          {
            action: 'แปลง PR เป็น PO และออกใบสั่งซื้ออัตโนมัติ',
            user: user.name,
            role: user.title,
            timestamp,
            note: isSplit ? `อนุมัติสร้าง PO แยกตามผู้ขาย เลขที่ ${poNo}` : `อนุมัติสร้างเอกสาร PO เลขที่ ${poNo}`
          }
        ]
      };
      
      const alreadyExists = pos.some(p => 
        (p.id && p.id === newPO.id) || 
        (p.poNo && p.poNo === newPO.poNo) ||
        (newPO.prNo && p.prNo === newPO.prNo && p.vendorId === newPO.vendorId)
      );

      if (!alreadyExists) {
        generatedPOs.push(newPO);
        pos.unshift(newPO);
      } else {
        const existing = pos.find(p => (p.poNo && p.poNo === newPO.poNo) || (p.id && p.id === newPO.id));
        if (existing) generatedPOs.push(existing);
      }

      auditService.logAction({
        action: 'PR_APPROVED_PO_CREATED',
        actor: user,
        department: pr.department,
        docNo: newPO.poNo,
        docType: 'PO',
        details: `อนุมัติ PR ${pr.prNo} ออกใบสั่งซื้อ ${newPO.poNo} (ผู้ขาย: ${vName}) ยอดเงิน ฿${newPO.grandTotal.toLocaleString()}`
      });

      // Dispatch Notification for each PO
      if (newPO.purchaseChannel === 'ONLINE') {
        notificationService.dispatch({
          type: 'ONLINE_TASK',
          title: 'มีงานสั่งซื้อออนไลน์ใหม่ (Shopee / Lazada)',
          message: `ใบสั่งซื้อออนไลน์เลขที่ ${newPO.poNo} อ้างอิง PR ${newPO.prNo} ยอดประเมิน ฿${newPO.grandTotal.toLocaleString()} รอคุณนัทดำเนินการสั่งซื้อ`,
          docNo: newPO.poNo,
          refDocType: 'PO',
          refDocId: newPO.id,
          department: newPO.department,
          targetRoles: ['ONLINE_PURCHASER', 'ADMIN'],
          amount: newPO.grandTotal,
          actor: user.name
        });
      } else {
        notificationService.dispatch({
          type: 'PR_APPROVED',
          title: 'PR ได้รับการอนุมัติ & ออก PO อัตโนมัติเรียบร้อย',
          message: `ใบสั่งซื้อ ${newPO.poNo} ถูกสร้างจาก ${pr.prNo} (ผู้ขาย: ${newPO.vendorName}) ยอดเงิน ฿${newPO.grandTotal.toLocaleString()}`,
          docNo: newPO.poNo,
          refDocType: 'PO',
          refDocId: newPO.id,
          department: newPO.department,
          targetRoles: [pr.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER'],
          amount: newPO.grandTotal,
          actor: user.name
        });
      }
    }

    const seenFinal = new Set();
    const deduplicatedPOs = pos.filter(p => {
      const key = p.poNo || p.poNumber || p.id;
      if (!key || seenFinal.has(key)) return false;
      seenFinal.add(key);
      return true;
    });

    storageService.savePOs(deduplicatedPOs);

    // BUDGET LOGGING: Release PR Commitment and Record PO Actual Spends
    const _isOnlinePr = pr.purchaseChannel === 'ONLINE' || pr.purchaseChannel === 'ONLINE_PURCHASE';
    if (!_isOnlinePr) {
      budgetService.logBudgetTransaction({
        department: pr.department,
        type: 'PR_RELEASE',
        amount: Math.abs(pr.totalAmount || 0),
        docType: 'PR',
        docRef: pr.prNo || pr.id,
        description: `คืนเงินผูกพัน (ออก PO แล้ว) PR ${pr.prNo}`,
        recordedBy: user.name || 'System'
      });

      generatedPOs.forEach(po => {
        budgetService.logBudgetTransaction({
          department: po.department,
          type: 'ACTUAL_SPEND',
          amount: -(po.grandTotal || 0),
          docType: 'PO',
          docRef: po.poNo || po.id,
          description: `ตัดจ่ายจริง PO ${po.poNo}`,
          recordedBy: user.name || 'System'
        });
      });
    }

    return generatedPOs.length === 1 ? generatedPOs[0] : generatedPOs;
  },

  // ─── Partial / Full Goods Receiving ──────────────────────────────────────────
  // receivingItems: Array of { productId, receivedThisTime (in purchaseQty units) }
  // options: { problematicItems, grAttachments }
  async receiveGoods(poId, receivingItems, user, note = '', options = {}) {
    const pos = storageService.getPOs();
    const products = storageService.getProducts();
    const stockLogs = storageService.getStockLogs();
    const prs = storageService.getPRs();
    const timestamp = new Date().toLocaleString('th-TH');

    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบเอกสาร PO ในระบบ');
    if (['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND'].includes(po.status)) {
      throw new Error(`ไม่สามารถตรวจรับได้เนื่องจาก PO ${po.poNo || po.id} อยู่ในสถานะ "${po.status}" เรียบร้อยแล้ว`);
    }

    const roundNumber = options?.round || options?.roundNumber || (po.grnHistory?.length || 0) + 1;
    const grNumber = options?.grNumber || options?.grId || generateGRNNumber(po.poNo || po.id, roundNumber);

    // Idempotency check on grNumber
    const existingLogForGr = stockLogs.find(l => l.grNumber && l.grNumber === grNumber);
    if (existingLogForGr) {
      console.log(`[WorkflowEngine] Idempotent guard: GR ${grNumber} already processed.`);
      return po;
    }

    // Quantity boundary validation
    for (const r of receivingItems) {
      const targetItem = (po.items || []).find(i => i.productId === r.productId);
      if (targetItem) {
        const ordered = Number(targetItem.orderedQty ?? targetItem.purchaseQty ?? targetItem.qty) || 0;
        const already = Number(targetItem.receivedQty) || 0;
        const incoming = Number(r.receivedThisTime) || 0;
        if (incoming < 0) {
          throw new Error(`จำนวนรับสำหรับรายการ "${targetItem.name}" ต้องไม่ติดลบ`);
        }
        if (already + incoming > ordered) {
          throw new Error(`จำนวนตรวจรับรายการ "${targetItem.name}" เกินยอดสั่งซื้อ (รับไปแล้ว ${already} + รับเพิ่ม ${incoming} > สั่งซื้อ ${ordered})`);
        }
      }
    }

    const receiveMap = {};
    receivingItems.forEach(r => { receiveMap[r.productId] = Number(r.receivedThisTime) || 0; });

    let allFullyReceived = true;
    let hasAnyClaim = false;
    const receivedSummaryParts = [];
    const problematicSummaryParts = [];
    const claimItemList = [];

    const problematicItems = options?.problematicItems || {};
    const receivingLocations = options?.receivingLocations || {};
    const grAttachments = options?.grAttachments || [];

    const REASON_LABELS = {
      'SHORT_SHIPMENT': 'ได้รับสินค้าไม่ครบ (ขาดส่ง)',
      'DAMAGED': 'สินค้าชำรุด / เสียหาย',
      'WRONG_SPEC': 'สินค้าไม่ตรงสเปก / ส่งผิดรุ่น',
      'OTHER': 'อื่นๆ (ตามรายละเอียด)'
    };

    po.items.forEach(poItem => {
      const pQty = Number(poItem.orderedQty ?? poItem.purchaseQty ?? poItem.qty) || 0;
      const alreadyReceived = Number(poItem.receivedQty) || 0;
      const remaining = Math.max(0, pQty - alreadyReceived);
      const thisReceive = Math.min(receiveMap[poItem.productId] ?? 0, remaining);

      if (receivingLocations[poItem.productId]) {
        poItem.receivingLocation = receivingLocations[poItem.productId];
      }

      const probInfo = problematicItems[poItem.productId];
      const isProb = Boolean(probInfo?.isProblematic);
      const claimedQty = isProb ? (Number(probInfo?.claimedQty) > 0 ? Number(probInfo.claimedQty) : (thisReceive > 0 ? thisReceive : Math.max(1, pQty - (alreadyReceived + thisReceive)))) : 0;
      const rawReason = probInfo?.reason || 'DAMAGED';
      const reasonLabel = REASON_LABELS[rawReason] || rawReason;
      const defectNote = (probInfo?.description || probInfo?.defectReason || '').trim();

      const rate = Number(poItem.conversionRate) > 0 ? Number(poItem.conversionRate) : 1;
      const tId = String(poItem.productId || poItem.id || '').trim().toLowerCase();
      const tCode = String(poItem.code || poItem.productCode || '').trim().toLowerCase();
      const tName = String(poItem.name || '').trim().toLowerCase();

      const prodIndex = products.findIndex(p => {
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
      const prod = prodIndex !== -1 ? products[prodIndex] : null;
      const sUnit = prod?.stockUnit || prod?.unit || poItem.stockUnit || poItem.unit || 'ชิ้น';
      const pUnit = prod?.purchaseUnit || prod?.unit || poItem.purchaseUnit || sUnit;
      const itemUnitPrice = Number(poItem.actualUnitPrice ?? poItem.actUnitPrice ?? poItem.actualPrice ?? poItem.price ?? prod?.price) || 0;
      const stockUnitPrice = itemUnitPrice > 0 && rate > 0 ? (itemUnitPrice / rate) : (Number(prod?.price) || 0);

      // 1. Process Normal (Good) Receipt if quantity > 0
      const currentReceived = alreadyReceived + thisReceive;
      poItem.receivedQty = currentReceived;
      poItem.orderedQty = pQty;
      poItem.remainingQty = Math.max(0, pQty - currentReceived);
      poItem.shortageQty = Math.max(0, pQty - currentReceived);

      if (thisReceive > 0) {
        const stockReceive = thisReceive * rate;
        poItem.receivedStockQty = (Number(poItem.receivedStockQty) || 0) + stockReceive;

        if (prod) {
          const currentBal = Number(prod.stockBalance) || 0;
          if (!isProb) {
            const newBal = currentBal + stockReceive;
            prod.stockBalance = newBal;

            const logNote = rate > 1
              ? `รับสินค้า ${thisReceive} ${pUnit} (= ${stockReceive} ${sUnit}) จาก PO ${po.poNo}`
              : `รับสินค้า ${thisReceive} ${sUnit} จาก PO ${po.poNo}`;

            stockLogs.unshift({
              id: `LOG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
              grNumber,
              documentNo: grNumber,
              docNo: grNumber,
              grnNo: grNumber,
              grnNumber: grNumber,
              date: timestamp,
              isoDate: new Date().toISOString(),
              productId: prod.id,
              productCode: prod.code,
              name: prod.name,
              type: 'IN',
              poNo: po.poNo,
              poNumber: po.poNo,
              refPo: po.poNo,
              roundNumber,
              qty: stockReceive,
              receivedQty: thisReceive,
              unit: sUnit,
              balance: newBal,
              unitPrice: stockUnitPrice,
              totalPrice: stockUnitPrice * stockReceive,
              actualPrice: itemUnitPrice,
              user: `${user.name} (${user.title})`,
              locationId: prod?.locationId || '',
              locationName: prod?.locationName || '',
              note: note || logNote
            });
          } else {
            stockLogs.unshift({
              id: `LOG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
              grNumber,
              documentNo: grNumber,
              docNo: grNumber,
              grnNo: grNumber,
              grnNumber: grNumber,
              date: timestamp,
              productId: poItem.productId,
              productCode: poItem.code,
              type: 'IN_NG',
              poNo: po.poNo,
              poNumber: po.poNo,
              refPo: po.poNo,
              roundNumber,
              qty: stockReceive,
              unit: sUnit,
              balance: currentBal,
              user: `${user.name} (${user.title})`,
              locationId: prod?.locationId || '',
              locationName: prod?.locationName || '',
              note: `[สินค้าชำรุด/NG] ${defectNote || reasonLabel}`
            });
          }
        }

        receivedSummaryParts.push(`${poItem.name}: ${thisReceive} ${pUnit}`);
      }

      // 2. Process Problematic / Claimed Items
      if (isProb) {
        hasAnyClaim = true;
        allFullyReceived = false;

        const claimedStockQty = claimedQty * rate;
        poItem.hasDefect = true;
        poItem.claimedQty = (Number(poItem.claimedQty) || 0) + claimedQty;
        poItem.damagedQty = (Number(poItem.damagedQty) || 0) + claimedQty;
        poItem.receivedNgQty = (Number(poItem.receivedNgQty) || 0) + claimedStockQty;
        poItem.defectReason = defectNote || reasonLabel;
        poItem.defectNote = defectNote || reasonLabel;

        if (!Array.isArray(po.ngItems)) {
          po.ngItems = [];
        }
        po.ngItems.push({
          productId: poItem.productId,
          productCode: poItem.code,
          name: poItem.name,
          qty: claimedStockQty,
          unit: sUnit,
          defectNote: defectNote || reasonLabel,
          defectReason: defectNote || reasonLabel,
          reason: rawReason,
          date: timestamp
        });

        stockLogs.unshift({
          id: `LOG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          grNumber,
          date: timestamp,
          productId: poItem.productId,
          productCode: poItem.code,
          type: 'NG',
          docNo: po.poNo,
          qty: claimedStockQty,
          unit: sUnit,
          balance: prod ? prod.stockBalance : 0,
          user: `${user.name} (${user.title})`,
          note: `[สินค้ามีปัญหา/เคลม (${reasonLabel})] ${defectNote || '-'} (PO ${po.poNo})`
        });

        claimItemList.push({
          productId: poItem.productId,
          code: poItem.code,
          name: poItem.name,
          orderedQty: pQty,
          receivedQty: thisReceive,
          claimedQty: claimedQty,
          purchaseUnit: pUnit,
          stockUnit: sUnit,
          reason: rawReason,
          reasonLabel: reasonLabel,
          description: defectNote || reasonLabel,
          photo: probInfo.photo || null
        });

        problematicSummaryParts.push(`${poItem.name}: มีปัญหา ${claimedQty} ${pUnit} (${reasonLabel}${defectNote ? ` - ${defectNote}` : ''})`);
      } else {
        if (poItem.receivedQty < pQty) {
          allFullyReceived = false;
        }
      }
    });

    // Save GR Attachments
    if (Array.isArray(grAttachments) && grAttachments.length > 0) {
      po.grAttachments = [...(po.grAttachments || []), ...grAttachments];
    }

    const channel = po.purchaseChannel === 'ONLINE' ? 'ONLINE' : 'SELF-BUY';
    const requesterRole = po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC';

    // ─── Status Assignment Logic ───
    if (hasAnyClaim) {
      // If ANY item has a claim/problem -> PO MUST BE CLAIM_REPORTED (NEVER CLOSED)
      po.status = 'CLAIM_REPORTED';

      const reasons = Array.from(new Set(claimItemList.map(c => c.reasonLabel).filter(Boolean)));
      const mainReason = reasons.join(', ') || 'พบสินค้ามีปัญหาจากการตรวจรับ';
      const descSummary = claimItemList.map(c => `${c.name}: มีปัญหา ${c.claimedQty} ${c.purchaseUnit} (${c.description || c.reasonLabel})`).join('; ');

      po.claimDetails = {
        reportedAt: new Date().toISOString(),
        reportedBy: user.name,
        reportedById: user.id || user.roleId || '',
        channel,
        reason: mainReason,
        description: descSummary,
        items: claimItemList
      };

      po.claimData = {
        reason: mainReason,
        description: descSummary,
        channel,
        reportedBy: user.name,
        reportedById: user.id || user.roleId || '',
        reportedAt: timestamp,
        claimDetails: po.claimDetails
      };

      const parts = [];
      if (receivedSummaryParts.length > 0) parts.push(`รับปกติเข้าสต็อก: ${receivedSummaryParts.join(', ')}`);
      if (problematicSummaryParts.length > 0) parts.push(`ส่งเรื่องเคลม: ${problematicSummaryParts.join(', ')}`);
      const summaryNote = parts.join(' | ') + (note ? ` (หมายเหตุ: ${note})` : '');

      if (!Array.isArray(po.activityLog)) {
        po.activityLog = [];
      }
      po.activityLog.push({
        action: `[${channel} CLAIM] ตรวจรับสินค้าพร้อมแจ้งเคลม`,
        user: user.name,
        role: user.title,
        timestamp,
        note: summaryNote,
        type: 'PO_CLAIM',
        channel
      });

      auditService.logAction({
        action: 'GOODS_RECEIVED_CLAIM_REPORTED',
        actor: user,
        department: po.department,
        docNo: po.poNo,
        docType: 'PO',
        details: `ตรวจรับสินค้าและแจ้งเคลม PO ${po.poNo}: ${summaryNote}`
      });

      // Dispatch Claim Notification
      if (channel === 'ONLINE') {
        notificationService.dispatch({
          type: 'PO_CLAIM',
          title: '🚨 สินค้าออนไลน์มีปัญหาจากการตรวจรับ (รอเคลม)',
          message: `PO ${po.poNo} (PR ${po.prNo}) ตรวจรับแล้วพบปัญหา: ${descSummary} — รอคุณนัทติดต่อร้านค้าเพื่อดำเนินการ`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: ['ONLINE_PURCHASER', 'ADMIN'],
          amount: po.grandTotal,
          actor: user.name
        });
      } else {
        notificationService.dispatch({
          type: 'SELF_CLAIM',
          title: '🚨 สินค้ามีปัญหาจากการตรวจรับ (จัดซื้อทั่วไป)',
          message: `PO ${po.poNo} (PR ${po.prNo}) ตรวจรับแล้วพบปัญหา: ${descSummary} — โปรดดำเนินการแก้ไขผ่านหน้า "งานของฉัน"`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: [requesterRole, 'ASST_MANAGER', 'ADMIN'],
          amount: po.grandTotal,
          actor: user.name
        });
      }

    } else {
      // Normal Goods Receiving (No Claims)
      po.status = allFullyReceived ? 'CLOSED' : 'PARTIAL';
      const parts = [];
      if (receivedSummaryParts.length > 0) parts.push(`รับปกติ: ${receivedSummaryParts.join(', ')}`);
      const summaryNote = parts.length > 0 ? `${parts.join(' | ')}${note ? ` — ${note}` : ''}` : (note || 'รับสินค้าบางส่วน');

      if (!Array.isArray(po.activityLog)) {
        po.activityLog = [];
      }

      po.activityLog.push({
        action: allFullyReceived ? 'รับสินค้าครบและปิด PO (Goods Received – Closed)' : 'รับสินค้าบางส่วน (Partial Receiving)',
        user: user.name,
        role: user.title,
        timestamp,
        note: summaryNote
      });

      auditService.logAction({
        action: allFullyReceived ? 'GOODS_RECEIVED_PO_CLOSED' : 'GOODS_RECEIVED_PARTIAL',
        actor: user,
        department: po.department,
        docNo: po.poNo,
        docType: 'PO',
        details: `${allFullyReceived ? 'ตรวจรับสินค้าครบและปิด PO' : 'ตรวจรับสินค้าบางส่วน'} ${po.poNo}: ${summaryNote}`
      });

      let notifyRoles = [requesterRole, 'ADMIN'];
      if (po.purchaseChannel === 'ONLINE') notifyRoles.push('ONLINE_PURCHASER');

      if (allFullyReceived) {
        po.status = 'CLOSED';
        po.fullyReceivedAt = new Date().toISOString();
        const pr = prs.find(p => 
          (po.prId && (p.id === po.prId || p.prNo === po.prId)) ||
          (po.prNo && (p.prNo === po.prNo || p.id === po.prNo)) ||
          (po.prNumber && (p.prNo === po.prNumber || p.id === po.prNumber || p.prNo === po.prNo)) ||
          (p.poNo && (p.poNo === po.poNo || p.id === po.poNo)) ||
          (p.poNumber && (p.poNumber === po.poNo || p.poNumber === po.poNumber))
        );
        if (pr) {
          pr.status = 'completed';
          pr.poStatus = 'completed';
          pr.poNumber = po.poNo || po.poNumber || pr.poNumber;
          pr.fullyReceivedAt = new Date().toISOString();
          if (!Array.isArray(pr.activityLog)) {
            pr.activityLog = [];
          }
          pr.activityLog.push({
            action: 'ปิดเอกสาร (Closed)',
            user: user.name,
            role: user.title,
            timestamp,
            note: `PO ${po.poNo} รับสินค้าครบแล้ว ปิดใบ PR อัตโนมัติ`
          });
          storageService.savePRs(prs);
        }

        notificationService.dispatch({
          type: 'GOODS_RECEIVED',
          title: 'รับสินค้าครบแล้ว — ปิด PO เรียบร้อย (+IN)',
          message: `PO ${po.poNo} รับสินค้าครบทุกรายการแล้ว สต็อกการ์ดถูกอัปเดตเรียบร้อย`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: [...notifyRoles, 'ASST_MANAGER'],
          amount: po.grandTotal,
          actor: user.name
        });
      } else {
        notificationService.dispatch({
          type: 'GOODS_PARTIAL',
          title: '⚠️ รับสินค้าบางส่วน — ยังมียอดค้างอยู่',
          message: `PO ${po.poNo} รับสินค้าบางส่วนแล้ว (${summaryNote}) ยังมีรายการที่รอรับอยู่`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: notifyRoles,
          amount: po.grandTotal,
          actor: user.name
        });
      }
    }

    const recUserSig = user?.signature || 
      storageService.getSignatureByRole?.(user?.roleId || user?.id)?.signatureUrl || 
      storageService.getSignatures?.()?.[user?.roleId || 'REQUESTER_PD']?.signatureUrl || 
      null;
    const realReceiverName = user?.employeeName || (user?.name && user.name !== 'Admin System' ? user.name : (user?.username || ''));
    const realReceiverRole = user?.position || user?.roleId || user?.role || user?.title || 'ผู้ตรวจรับ / บันทึกสต็อก';

    po.receivedBy = realReceiverName;
    po.receiverName = realReceiverName;
    po.receivedById = user?.id || user?.username || '';
    po.receivedRole = realReceiverRole;
    po.receiverRole = realReceiverRole;
    po.receiverSignature = recUserSig || '/signatures/receiver-default.png';
    po.receivedAt = timestamp;
    po.receivingInfo = {
      receiverName: realReceiverName,
      receiverId: po.receivedById,
      receiverRole: realReceiverRole,
      receiverSignature: recUserSig || '/signatures/receiver-default.png',
      receivedAt: new Date().toISOString()
    };

    // ── Persist to local storage immediately (Optimistic Update) ────────────
    storageService.savePOs(pos);
    storageService.saveProducts(products);
    storageService.saveStockLogs(stockLogs);

    // ── Persist to GAS (Google Sheet SSOT) ──────────────────────────────────
    // Fire-and-forget: do NOT block the UI on GAS round-trip.
    // apiReceivePO handles its own Idempotency Guard server-side.
    if (isGAS()) {
      const gasPoPayload = {
        id: po.id,
        poNo: po.poNo,
        department: po.department,
        status: po.status,
        grNumber,
        items: po.items,
        history: po.history,
        timeline: po.timeline,
        activityLog: po.activityLog,
        grnHistory: po.grnHistory,
        ngItems: po.ngItems,
        claimHistory: po.claimHistory,
        claimDetails: po.claimDetails,
        claimData: po.claimData,
        receivedBy: po.receivedBy,
        receiverName: po.receiverName,
        receivedById: po.receivedById,
        receiverId: po.receivedById,
        receiverRole: po.receiverRole,
        receiverSignature: po.receiverSignature,
        receivedAt: po.receivedAt,
        receivingInfo: po.receivingInfo,
        fullyReceivedAt: po.fullyReceivedAt,
        prId: po.prId,
        prNo: po.prNo,
        prNumber: po.prNumber,
        currentUser: user
      };

      // Build stock movements list for apiAppendStockMovements
      const stockMovementsForGAS = stockLogs
        .filter(l => l.grNumber === grNumber)
        .map(l => ({
          id: l.id,
          timestamp: l.isoDate || l.date,
          productId: l.productId,
          productCode: l.productCode,
          name: l.name,
          type: l.type || 'IN',
          documentNo: l.grNumber,
          grnNumber: l.grNumber,
          poNumber: po.poNo,
          qty: l.qty,
          unit: l.unit,
          conversionRate: l.conversionRate || 1,
          unitPrice: l.unitPrice || 0,
          totalPrice: l.totalPrice || 0,
          balanceAfter: l.balance,
          actorName: realReceiverName,
          department: po.department,
          locationId: l.locationId || '',
          notes: l.note || ''
        }));

      try {
        await callGAS('apiReceivePO', gasPoPayload);
      } catch (e) {
        console.warn('[WorkflowEngine] GAS apiReceivePO failed:', e.message);
      }
      if (stockMovementsForGAS.length > 0) {
        try {
          await callGAS('apiAppendStockMovements', stockMovementsForGAS);
        } catch (e) {
          console.warn('[WorkflowEngine] GAS apiAppendStockMovements failed:', e.message);
        }
      }
    }

    return po;
  },

  // ─── Short-Close PO (ปิด PO ก่อนกำหนดเมื่อได้ของไม่ครบและไม่รอของแล้ว) ──────
  async shortClosePO(poId, reason, user) {
    if (!reason || !reason.trim()) {
      throw new Error('กรุณาระบุเหตุผลในการปิด PO ก่อนกำหนด');
    }

    const pos = storageService.getPOs();
    const prs = storageService.getPRs();
    const timestamp = new Date().toLocaleString('th-TH');

    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบเอกสาร PO ในระบบ');
    if (['CLOSED', 'CANCELLED'].includes(po.status)) {
      throw new Error('PO นี้ถูกปิดหรือยกเลิกไปแล้ว');
    }

    po.status = 'CLOSED';
    po.closedEarly = true;
    po.shortCloseReason = reason.trim();
    po.closedBy = user.name;
    po.closedDate = timestamp;

    const unfulfilledSummary = (po.items || [])
      .map(it => {
        const ordered = Number(it.orderedQty ?? it.purchaseQty ?? it.qty) || 0;
        const received = Number(it.receivedQty) || 0;
        const remaining = Math.max(0, ordered - received);
        return remaining > 0 ? `${it.name}: ขาด ${remaining} ${it.purchaseUnit || it.unit || 'ชิ้น'}` : null;
      })
      .filter(Boolean)
      .join(', ');

    const noteMsg = `ปิด PO ก่อนกำหนด (ของไม่ครบ/ไม่รอของแล้ว): ${reason.trim()}${unfulfilledSummary ? ` [ยอดที่ยังไม่ได้รับ: ${unfulfilledSummary}]` : ''}`;

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: 'ปิด PO ก่อนกำหนด (Short-Close PO)',
      user: user.name,
      role: user.title,
      timestamp,
      note: noteMsg
    });

    storageService.savePOs(pos);

    const relatedPR = prs.find(p => 
      (po.prId && (p.id === po.prId || p.prNo === po.prId)) ||
      (po.prNo && (p.prNo === po.prNo || p.id === po.prNo)) ||
      (po.prNumber && (p.prNo === po.prNumber || p.id === po.prNumber || p.prNo === po.prNo))
    );
    if (relatedPR) {
      if (!Array.isArray(relatedPR.activityLog)) {
        relatedPR.activityLog = [];
      }
      relatedPR.activityLog.push({
        action: 'ใบสั่งซื้อถูกปิดก่อนกำหนด (PO Short-Closed)',
        user: user.name,
        role: user.title,
        timestamp,
        note: noteMsg
      });

      const siblingPOs = pos.filter(p => p.prId === relatedPR.id || p.prNo === relatedPR.prNo);
      const allSiblingClosed = siblingPOs.every(p => ['CLOSED', 'CANCELLED'].includes(p.status));
      if (allSiblingClosed) {
        relatedPR.status = 'completed';
        relatedPR.poStatus = 'completed';
      }
      storageService.savePRs(prs);
    }

    auditService.logAction({
      action: 'PO_SHORT_CLOSED',
      actor: user,
      department: po.department,
      docNo: po.poNo,
      docType: 'PO',
      details: `ปิด PO ${po.poNo} ก่อนกำหนด: ${reason.trim()}`
    });

    notificationService.dispatch({
      type: 'PO_SHORT_CLOSED',
      title: '🔒 ใบสั่งซื้อ (PO) ถูกปิดก่อนกำหนด (Short-Close)',
      message: `ใบสั่งซื้อ ${po.poNo} (PR ${po.prNo}) ถูกปิดโดย ${user.name}: ${reason.trim()}`,
      docNo: po.poNo,
      refDocType: 'PO',
      refDocId: po.id,
      department: po.department,
      targetRoles: [po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER'],
      amount: po.grandTotal,
      actor: user.name
    });

    return po;
  },

  // Update actual price for ONLINE PO and calculate variance
  async updateActualPrice(poId, itemIndex, actPrice, user) {
    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('PO not found');

    const item = po.items[itemIndex];
    if (!item) throw new Error('Item not found');

    const oldPrice = item.price;
    item.actUnitPrice = Number(actPrice);
    
    const pQty = item.purchaseQty ?? item.qty ?? 1;
    const variance = (oldPrice - item.actUnitPrice) * pQty; // Positive means saved money, negative means overspent

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: 'อัปเดตราคาจริง (Actual Price)',
      user: user.name,
      role: user.title,
      timestamp: new Date().toLocaleString('th-TH'),
      note: `อัปเดตราคาจริงของ ${item.name} เป็น ฿${item.actUnitPrice.toLocaleString()} (ส่วนต่าง: ${variance >= 0 ? '+' : ''}${variance.toLocaleString()})`
    });

    // Update variance in budget module
    const budgets = storageService.getBudgets();
    if (!budgets[po.department]) budgets[po.department] = { spent: 0, pending: 0, variance: 0 };
    budgets[po.department].variance = (budgets[po.department].variance || 0) + variance;
    storageService.saveBudgets(budgets);

    storageService.savePOs(pos);
    return po;
  },

  // Assign Vendor to PO
  async assignVendorToPO(poId, vendorId, vendorName, user) {
    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('PO not found');

    po.vendorId = vendorId;
    po.vendorName = vendorName;
    po.vendor = vendorName;
    po.shopName = vendorName;
    const timestamp = new Date().toLocaleString('th-TH');

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: 'ระบุผู้ขาย (Assign Vendor)',
      user: user.name,
      role: user.title,
      timestamp,
      note: `อัปเดตผู้ขายเป็น: ${vendorName}`
    });

    storageService.savePOs(pos);
    return po;
  },

  // ─── Generic Claim Filing (supports ONLINE & SELF-BUY channels) ───────────
  async fileClaim(poId, claimData, user) {
    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบใบสั่งซื้อ');

    const isSelfProcurement = po.procurementType === 'INTERNAL' || po.channel === 'DIRECT' || po.purchaseChannel === 'SELF';
    const channel = isSelfProcurement ? 'SELF-BUY' : 'ONLINE';
    const timestamp = new Date().toLocaleString('th-TH');

    po.status = 'CLAIM_REPORTED';
    po.claimData = {
      ...claimData,
      reportedBy: user.name,
      reportedById: user.id || user.roleId || user.positionKey || '',
      reportedAt: timestamp,
      channel
    };

    // Channel-tagged audit log
    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: channel === 'ONLINE'
        ? '[ONLINE CLAIM] แจ้งปัญหาสินค้าสั่งซื้อออนไลน์'
        : '[SELF-BUY CLAIM] แจ้งปัญหาสินค้าจัดซื้อทั่วไป',
      date: timestamp,
      timestamp,
      user: user.name,
      userId: user.id || user.roleId || '',
      role: user.title,
      note: `[${channel} CLAIM] แจ้งปัญหา: ${claimData.reason} | ${claimData.description} โดย ${user.name}`,
      type: 'PO_CLAIM',
      channel
    });

    storageService.savePOs(pos);

    if (channel === 'ONLINE') {
      // ONLINE: notify the Online Purchaser (คุณนัท)
      notificationService.dispatch({
        type: 'PO_CLAIM',
        title: '🚨 แจ้งปัญหา / เคลมสินค้าออนไลน์',
        message: `มีรายการแจ้งปัญหาสำหรับ PO ${po.poNo} จาก ${user.name} — กรุณาตรวจสอบและติดต่อร้านค้า`,
        docNo: po.poNo,
        refDocType: 'PO',
        refDocId: po.id,
        department: po.department,
        targetRoles: ['ONLINE_PURCHASER', 'ADMIN'],
        amount: po.grandTotal,
        actor: user.name
      });
    } else {
      // SELF-BUY: notify the requester's department + Asst. Manager
      const requesterRole = po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC';
      notificationService.dispatch({
        type: 'SELF_CLAIM',
        title: '🚨 แจ้งปัญหาสินค้า (จัดซื้อทั่วไป)',
        message: `PO ${po.poNo} มีรายการแจ้งปัญหา: "${claimData.reason}" — โปรดดำเนินการผ่านหน้า "งานของฉัน"`,
        docNo: po.poNo,
        refDocType: 'PO',
        refDocId: po.id,
        department: po.department,
        targetRoles: ['REQUESTER'],
        amount: po.grandTotal,
        actor: user.name
      });
    }

    return po;
  },

  // Backward-compat alias
  async fileOnlineClaim(poId, claimData, user) {
    return this.fileClaim(poId, claimData, user);
  },

  // ─── Generic Claim Resolution (supports ONLINE & SELF-BUY channels) ────────
  async resolveClaim(poId, resolution, user) {
    const pos = storageService.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('ไม่พบใบสั่งซื้อ');

    const channel = po.purchaseChannel === 'ONLINE' ? 'ONLINE' : 'SELF-BUY';
    po.claimRound = (po.claimRound || 0) + 1;
    if (!Array.isArray(po.claimHistory)) {
      po.claimHistory = [];
    }
    
    const timestamp = new Date().toLocaleString('th-TH');
    
    // Save history entry
    po.claimHistory.push({
      round: po.claimRound,
      reportData: po.claimData,
      resolution: resolution,
      resolvedBy: user.name,
      resolvedById: user.id || user.roleId || '',
      resolvedAt: timestamp,
      channel
    });

    let actionLabel = 'ดำเนินการเคลม (Resolution)';
    let noteMsg = '';
    
    const requesterRole = po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC';

    if (['RESEND', 'REPLACEMENT'].includes(resolution.type)) {
      po.status = 'WAITING_DELIVERY_ROUND_2';
      po.claimStatus = 'RESOLVED_WAITING_DELIVERY';
      po.refundAmount = 0;
      noteMsg = `[${channel} CLAIM RESOLVED] ดำเนินการ: ${resolution.type} — จัดซื้อใหม่/ส่งสินค้าทดแทน (รอบที่ ${po.claimRound}), คาดรับวันที่: ${resolution.expectedDate || '-'} — ${resolution.note} โดย ${user.name}`;
      
      if (channel === 'ONLINE') {
        // ONLINE RESEND: notify Requester to wait for re-delivery
        notificationService.dispatch({
          type: 'PO_CLAIM_RESEND',
          title: '🔄 ร้านค้าจัดส่งสินค้ามาให้ใหม่ (เคลม)',
          message: `PO ${po.poNo}: ร้านค้ากำลังส่งสินค้ามาใหม่ (รอบที่ ${po.claimRound}) คาดรับวันที่ ${resolution.expectedDate || '-'} โปรดเตรียมตรวจรับ`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: [requesterRole, 'ADMIN', 'ASST_MANAGER'],
          amount: po.grandTotal,
          actor: user.name
        });
      } else {
        // SELF-BUY RESEND: notify same requester that they need to re-purchase
        notificationService.dispatch({
          type: 'PO_CLAIM_RESEND',
          title: '🔄 ต้องจัดซื้อสินค้าทดแทน (Self-buy Claim)',
          message: `PO ${po.poNo}: กรุณาดำเนินการจัดซื้อสินค้าทดแทน (รอบที่ ${po.claimRound}) ตามผลการเคลม คาดรับวันที่ ${resolution.expectedDate || '-'}`,
          docNo: po.poNo,
          refDocType: 'PO',
          refDocId: po.id,
          department: po.department,
          targetRoles: [requesterRole, 'ADMIN', 'ASST_MANAGER'],
          amount: po.grandTotal,
          actor: user.name
        });
      }

    } else if (['CLOSE_WITH_REFUND', 'REFUND', 'CANCEL'].includes(resolution.type)) {
      if (!resolution.storeKey || resolution.allStoresResolved) {
        if (resolution.hasPendingDeliveries) {
          po.status = 'WAITING_DELIVERY_ROUND_2';
          po.claimStatus = 'RESOLVED_WAITING_DELIVERY';
        } else {
          po.status = 'COMPLETED';
          po.claimStatus = resolution.type === 'CANCEL' ? 'CANCELLED' : 'RESOLVED_REFUNDED';
        }
      } else {
        po.status = (po.status && po.status !== 'COMPLETED' && po.status !== 'CLOSED') ? po.status : 'CLAIM_PENDING';
        po.claimStatus = 'IN_CLAIM';
      }

      // ── Budget Restore: คืนงบประมาณกลับฝ่ายต้นทาง (Idempotent via budgetService) ──
      const refundAmt = Math.round((Number(resolution.refundAmount) || 0) * 100) / 100;
      po.refundAmount = refundAmt;
      if (refundAmt > 0) {
        const storeClaim = resolution.storeKey && po.storeClaims ? po.storeClaims[resolution.storeKey] : null;
        const isStoreAlreadyResolved = storeClaim && (storeClaim.isResolved || storeClaim.status === 'RESOLVED') && (storeClaim.type === 'REFUND' || storeClaim.type === 'CLOSE_WITH_REFUND');
        if (!isStoreAlreadyResolved) {
          po.totalRefunded = Math.round(((Number(po.totalRefunded) || 0) + refundAmt) * 100) / 100;
        }

        const targetDepartment = po.department || po.departmentId || po.prDepartment || po.dept || 'PD';
        const storeLabel = resolution.storeName || resolution.storeKey || po.storeName || '';
        const reason = `จัดซื้อเจรจาเคลมสำเร็จ ได้รับเงินคืน ฿${refundAmt.toLocaleString()} เข้าแผนก (คืนงบประมาณจากการเคลมเงินคืนร้านค้า: ${storeLabel ? `ร้าน ${storeLabel}, ` : ''}PO: ${po.poNo || po.poNumber || po.id}) — ${resolution.note || '-'}`;

        await budgetService.creditDepartmentBudget({
          departmentId: targetDepartment,
          department: targetDepartment,
          amount: refundAmt,
          referencePo: po.poNo || po.poNumber || po.id,
          storeKey: resolution.storeKey || '',
          storeName: storeLabel,
          reason,
          actor: user.name
        });
      }

      noteMsg = `[${channel} CLAIM RESOLVED] จัดซื้อเจรจาเคลมสำเร็จ ได้รับเงินคืน ฿${refundAmt.toLocaleString()} เข้าแผนก | ${resolution.note || ''} โดย ${user.name}`;
    } else if (resolution.type === 'CLOSE_NO_ACTION' || resolution.type === 'WRITE_OFF' || resolution.type === 'ACCEPT_CONDITION') {
      if (!resolution.storeKey || resolution.allStoresResolved) {
        if (resolution.hasPendingDeliveries) {
          po.status = 'WAITING_DELIVERY_ROUND_2';
          po.claimStatus = 'RESOLVED_WAITING_DELIVERY';
        } else {
          po.status = 'COMPLETED';
          po.claimStatus = resolution.type === 'WRITE_OFF' ? 'RESOLVED_WRITE_OFF' : 'CLOSE_NO_ACTION';
        }
      } else {
        po.status = (po.status && po.status !== 'COMPLETED' && po.status !== 'CLOSED') ? po.status : 'CLAIM_PENDING';
        po.claimStatus = 'IN_CLAIM';
      }
      noteMsg = `[${channel} CLAIM RESOLVED] ดำเนินการ: ${resolution.type} — ${resolution.type === 'WRITE_OFF' ? 'ตัดจำหน่าย/ยกเว้นเคลม (ปิดเคส)' : 'ปิดเคสโดยไม่ดำเนินการต่อ'} | ${resolution.note || ''} โดย ${user.name}`;
    }

    // ── Update PO item settlement / claim metadata (Directives D & E) ──
    const isRefundType = ['CLOSE_WITH_REFUND', 'REFUND', 'CANCEL'].includes(resolution.type);
    const isReplacementType = ['REPLACEMENT', 'RESEND'].includes(resolution.type);
    const isWriteOffType = ['WRITE_OFF', 'CLOSE_NO_ACTION'].includes(resolution.type);
    if (Array.isArray(po.items) && (isRefundType || isReplacementType || isWriteOffType)) {
      po.items = po.items.map((item, idx) => {
        let isTarget = true;
        if (resolution.storeKey || resolution.storeName) {
          const itemStore = (item.actualStoreName || item.storeName || '').trim().toLowerCase();
          const targetStoreKey = String(resolution.storeKey || '').toLowerCase();
          const targetStoreName = String(resolution.storeName || '').toLowerCase();
          const itemStoreKey = String(item.storeKey || '').toLowerCase();
          const platformKey = item.storePlatform ? `${item.storePlatform.toLowerCase()}_${itemStore}` : '';
          
          isTarget = Boolean(
            (resolution.itemIndices && resolution.itemIndices.includes(idx)) ||
            (itemStoreKey && (itemStoreKey === targetStoreKey || targetStoreKey.includes(itemStoreKey))) ||
            (targetStoreName && itemStore === targetStoreName) ||
            (targetStoreKey && itemStore && targetStoreKey.includes(itemStore)) ||
            (targetStoreName && itemStore && targetStoreName.includes(itemStore)) ||
            (itemStore && targetStoreKey && itemStore.includes(targetStoreKey)) ||
            (platformKey && (platformKey === targetStoreKey || targetStoreKey.includes(platformKey)))
          );
        }

        if (!isTarget) return item;

        const ordered = Number(item.orderedQty ?? item.actualQty ?? item.quantity ?? item.purchaseQty ?? 0);
        const received = Number(item.accumulatedReceived ?? item.goodQty ?? item.receivedQty ?? 0);
        const disputeQty = Number(
          item.damagedQty || 
          item.shortageQty || 
          (item.disputedQty) || 
          Math.max(0, ordered - received)
        );

        if (isRefundType) {
          const unitPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? 0);
          const itemRefundValue = Number(resolution.refundAmount || (disputeQty * unitPrice)) || Math.round(disputeQty * unitPrice * 100) / 100;
          return {
            ...item,
            claimResolution: 'REFUND',
            refundedQty: disputeQty,
            refundAmount: itemRefundValue,
            isSettled: true,
            hasDispute: false,
            damagedQty: 0,
            shortageQty: 0,
            remainingQty: 0
          };
        } else if (isReplacementType) {
          return {
            ...item,
            claimResolution: 'REPLACEMENT',
            replacementPendingQty: disputeQty,
            refundedQty: 0,
            isSettled: false, // Remains receivable in GRN
            hasDispute: false
          };
        } else if (isWriteOffType) {
          return {
            ...item,
            claimResolution: 'WRITE_OFF',
            isSettled: true,
            hasDispute: false,
            damagedQty: 0,
            shortageQty: 0,
            disputedQty: 0,
            remainingQty: 0
          };
        }
        return item;
      });
    }

    // Support store-level claims for multi-store online procurement
    if (resolution.storeKey) {
      po.storeClaims = po.storeClaims || {};
      const isReplacement = resolution.type === 'REPLACEMENT' || resolution.type === 'RESEND';
      const storeClaimObj = {
        status: isReplacement ? 'WAITING_REPLACEMENT' : 'RESOLVED',
        isResolved: true,
        type: resolution.type,
        actionType: resolution.type,
        resolutionType: resolution.type,
        claimStatus: isReplacement ? 'RESOLVED_REPLACEMENT' : 'RESOLVED',
        hasPendingClaim: false,
        refundAmount: Number(resolution.refundAmount || 0),
        note: resolution.note || '',
        newTrackingNo: resolution.newTrackingNo || '',
        replacementTrackingNo: resolution.newTrackingNo || '',
        expectedDate: resolution.expectedDate || '',
        resolvedAt: new Date().toISOString(),
        resolvedBy: user.name,
        storeName: resolution.storeName || ''
      };
      po.storeClaims[resolution.storeKey] = storeClaimObj;
      if (resolution.storeName && resolution.storeName !== resolution.storeKey) {
        po.storeClaims[resolution.storeName] = storeClaimObj;
      }

      if (resolution.allStoresResolved) {
        // Directive 2: ตรวจสอบว่ายังมีสินค้าที่ต้องรอส่งมอบหรือไม่
        const hasPendingDeliveries = Boolean(
          resolution.hasPendingDeliveries ||
          ['RESEND', 'REPLACEMENT'].includes(resolution.type) ||
          Object.values(po.storeClaims || {}).some(c => 
            c && (c.type === 'REPLACEMENT' || c.type === 'RESEND' || c.actionType === 'REPLACEMENT' || c.actionType === 'RESEND')
          ) ||
          (Array.isArray(po.items) && po.items.some(it => 
            it.shortageAction === 'WAIT_NEXT_ROUND' || it.disputeAction === 'WAIT_NEXT_ROUND' || it.shortageReason === 'SPLIT_SHIPMENT' ||
            (Number(it.replacementPendingQty) > 0)
          ))
        );

        if (hasPendingDeliveries) {
          po.status = 'WAITING_DELIVERY_ROUND_2';
          po.claimStatus = 'REPLACEMENT_PENDING';
        } else {
          po.status = 'COMPLETED';
          po.claimStatus = 'RESOLVED';
        }
        // ปลดสถานะ po.claimStatus = 'RESOLVED' และ po.hasDispute = false ทันที เพื่อให้การ์ดหลุดออกจากแท็บ "รอเคลม" 100%
        po.hasDispute = false;
        po.isInClaim = false;
      } else {
        po.status = (po.status && po.status !== 'COMPLETED' && po.status !== 'CLOSED') ? po.status : 'CLAIM_PENDING';
        po.claimStatus = 'IN_CLAIM';
      }
    }

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: actionLabel,
      user: user.name,
      userId: user.id || user.roleId || '',
      role: user.title,
      timestamp,
      note: noteMsg,
      type: 'CLAIM_RESOLUTION',
      channel
    });

    // Handle closing PR if PO is now closed
    if (['CLOSE_WITH_REFUND', 'REFUND', 'CLOSE_NO_ACTION'].includes(resolution.type) && po.prId && (!resolution.storeKey || resolution.allStoresResolved)) {
      const prs = storageService.getPRs();
      const pr = prs.find(p => p.id === po.prId);
      if (pr) {
        if (!Array.isArray(pr.activityLog)) {
          pr.activityLog = [];
        }
        pr.activityLog.push({
          action: 'ใบสั่งซื้อถูกปิดหลังจากเคลม (PO Closed Post-Claim)',
          user: user.name,
          role: user.title,
          timestamp,
          note: `PO ${po.poNo} (${channel}) ปิดหลังแจ้งปัญหา: ${noteMsg}`
        });
        const siblingPOs = pos.filter(p => p.prId === pr.id);
        const allSiblingClosed = siblingPOs.every(p => ['CLOSED', 'CANCELLED'].includes(p.status));
        if (allSiblingClosed) {
          pr.status = 'CLOSED';
        }
        storageService.savePRs(prs);
      }
      
      notificationService.dispatch({
        type: 'PO_CLAIM_CLOSED',
        title: '🔒 ใบสั่งซื้อ (PO) ถูกปิดหลังเคลมปัญหา',
        message: `PO ${po.poNo} (${channel}): ${noteMsg}`,
        docNo: po.poNo,
        refDocType: 'PO',
        refDocId: po.id,
        department: po.department,
        targetRoles: [requesterRole, 'ADMIN', 'ASST_MANAGER'],
        amount: po.grandTotal,
        actor: user.name
      });
    }

    if (!resolution.storeKey || resolution.allStoresResolved) {
      po.claimData = null; // Clear active claim data
      po.claimResolution = {
        type: resolution.type,
        refundAmount: Number(resolution.refundAmount || 0),
        note: resolution.note || '',
        resolvedAt: new Date().toISOString(),
        resolvedBy: user.name
      };
    }
    storageService.savePOs(pos);
    return po;
  },

  // Backward-compat alias
  async resolveOnlineClaim(poId, resolution, user) {
    return this.resolveClaim(poId, resolution, user);
  },

  // Update PO Status
  async updatePOStatus(poId, nextStatus, user, note = '') {
    const pos = storageService.getPOs();
    const index = pos.findIndex(p => p.id === poId);
    if (index === -1) throw new Error('PO not found');

    const po = pos[index];
    po.status = nextStatus;
    const timestamp = new Date().toLocaleString('th-TH');

    let actionLabel = 'อัปเดตสถานะ PO';
    if (nextStatus === 'IN_DELIVERY') actionLabel = 'อัปเดตสถานะการจัดส่ง (In Delivery)';

    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: actionLabel,
      user: user.name,
      role: user.title,
      timestamp,
      note: note || `เปลี่ยนสถานะเป็น ${PO_STATUS[nextStatus]?.label}`
    });

    storageService.savePOs(pos);
    return po;
  },

  // Close PO and receive goods
  async closePO(poId, user, note = '') {
    const pos = storageService.getPOs();
    const products = storageService.getProducts();
    const stockLogs = storageService.getStockLogs();
    const prs = storageService.getPRs();
    const timestamp = new Date().toLocaleString('th-TH');

    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('PO not found');

    // Fully receive all items and trigger IN stock movement
    po.items.forEach(poItem => {
      const pQty = Number(poItem.purchaseQty ?? poItem.qty) || 1;
      const rate = Number(poItem.conversionRate) > 0 ? Number(poItem.conversionRate) : 1;
      const pendingPurchaseQty = pQty - (poItem.receivedQty || 0);
      const totalStockQty = Number(poItem.stockQty) || (pQty * rate);
      const pendingStockQty = poItem.stockQty ? (totalStockQty - (poItem.receivedStockQty || 0)) : (pendingPurchaseQty * rate);

      if (pendingStockQty > 0 || pendingPurchaseQty > 0) {
        poItem.receivedQty = pQty;
        poItem.receivedStockQty = totalStockQty;

        const prodIndex = products.findIndex(p => p.id === poItem.productId);
        if (prodIndex !== -1) {
          const prod = products[prodIndex];
          const currentBal = Number(prod.stockBalance) || 0;
          const newBal = currentBal + pendingStockQty;
          prod.stockBalance = newBal;

          const sUnit = prod.stockUnit || prod.unit || 'ชิ้น';
          const pUnit = prod.purchaseUnit || prod.unit || sUnit;
          const noteDetail = rate > 1 
            ? `รับสินค้าเข้าคลัง ${pendingStockQty.toLocaleString()} ${sUnit} (${pQty} ${pUnit}) จาก PO เลขที่ ${po.poNo}`
            : `รับสินค้าเข้าคลังเต็มจำนวน ${pendingStockQty.toLocaleString()} ${sUnit} จาก PO เลขที่ ${po.poNo}`;

          stockLogs.unshift({
            id: `LOG-${Date.now()}-${Math.floor(Math.random()*1000)}`,
            date: timestamp,
            productId: poItem.productId,
            productCode: poItem.code,
            type: 'IN',
            docNo: po.poNo,
            qty: pendingStockQty,
            unit: sUnit,
            balance: newBal,
            user: `${user.name} (${user.title})`,
            locationId: prod?.locationId || '',
            locationName: prod?.locationName || '',
            note: note || noteDetail
          });
        }
      }
    });

    po.status = 'CLOSED';
    if (!Array.isArray(po.activityLog)) {
      po.activityLog = [];
    }
    po.activityLog.push({
      action: 'รับสินค้าและปิด PO (Closed)',
      user: user.name,
      role: user.title,
      timestamp,
      note: note || `รับสินค้าและบันทึกเข้า Stock เรียบร้อย`
    });

    auditService.logAction({
      action: 'GOODS_RECEIVED_PO_CLOSED',
      actor: user,
      department: po.department,
      docNo: po.poNo,
      docType: 'PO',
      details: `ตรวจรับสินค้าเข้าคลัง และปิดใบสั่งซื้อ ${po.poNo}`
    });

    // Also close the PR
    const pr = prs.find(p => p.id === po.prId);
    if (pr) {
      pr.status = 'CLOSED';
      if (!Array.isArray(pr.activityLog)) {
        pr.activityLog = [];
      }
      pr.activityLog.push({
        action: 'ปิดเอกสาร (Closed)',
        user: user.name,
        role: user.title,
        timestamp,
        note: `PO ที่เกี่ยวข้องถูกรับสินค้าและปิดงานแล้ว`
      });
    }

    storageService.savePOs(pos);
    storageService.saveProducts(products);
    storageService.saveStockLogs(stockLogs);
    storageService.savePRs(prs);

    // Dispatch Notification for Goods Received
    notificationService.dispatch({
      type: 'GOODS_RECEIVED',
      title: 'รับสินค้าเข้าคลังและปิด PO เรียบร้อย (+IN)',
      message: `ใบสั่งซื้อ ${po.poNo} ได้รับสินค้าครบถ้วนเข้าคลัง สต๊อกการ์ดถูกอัปเดตเรียบร้อยแล้ว`,
      docNo: po.poNo,
      refDocType: 'PO',
      refDocId: po.id,
      department: po.department,
      targetRoles: [po.department === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN', 'ASST_MANAGER'],
      amount: po.grandTotal,
      actor: user.name
    });

    return po;
  },

  // --- Quick Issue Stock (เบิกจ่าย) ---
  async quickIssueStock(productId, issueQty, user, note = '', issueUnit = '') {
    const products = storageService.getProducts();
    const stockLogs = storageService.getStockLogs();
    const timestamp = new Date().toLocaleString('th-TH');

    const prodIndex = products.findIndex(p => p.id === productId);
    if (prodIndex === -1) throw new Error('Product not found');

    const product = products[prodIndex];
    const sUnit = product.stockUnit || product.unit || 'ชิ้น';
    const numIssueQty = Number(issueQty) || 0;

    if (product.stockBalance < numIssueQty) {
      throw new Error(`จำนวนคงเหลือไม่พอเบิก (มี ${product.stockBalance} ${sUnit}, ต้องการเบิก ${numIssueQty} ${sUnit})`);
    }

    const newBal = Math.round((product.stockBalance - numIssueQty) * 10000) / 10000;
    product.stockBalance = newBal;

    const logNo = `REQ-${Date.now().toString().slice(-4)}`;
    const masterUnits = storageService.getUsageUnits?.() || [];
    const matchedUnit = masterUnits.find(u => u.name === issueUnit || u.id === issueUnit);

    stockLogs.unshift({
      id: `LOG-${Date.now()}`,
      date: timestamp,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      department: product.category,
      type: 'OUT',
      docNo: logNo,
      qty: numIssueQty,
      unit: sUnit,
      balance: newBal,
      user: `${user.name} (${user.title})`,
      issueUnit: issueUnit || '',
      unitId: matchedUnit?.id || '',
      unitName: matchedUnit?.name || issueUnit || '',
      locationId: product.locationId || '',
      locationName: product.locationName || '',
      note: note || `เบิกสินค้าไปใช้งาน`
    });

    storageService.saveProducts(products);
    storageService.saveStockLogs(stockLogs);

    // Dispatch Notification for Quick Issue & Check ROP
    notificationService.dispatch({
      type: 'STOCK_ISSUED',
      title: 'เบิกจ่ายสินค้าสำเร็จ (-OUT)',
      message: `เบิกจ่าย ${product.name} (${product.code}) จำนวน ${numIssueQty} ${sUnit} คงเหลือ ${newBal} ${sUnit}`,
      docNo: logNo,
      refDocType: 'STOCK',
      refDocId: product.id,
      department: product.category,
      targetRoles: [product.category === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ADMIN'],
      actor: user.name
    });

    const isInactive = product.isActive === false || String(product.status || '').toUpperCase() === 'INACTIVE';
    if (!isInactive && newBal <= (product.reorderPoint || 0)) {
      notificationService.dispatch({
        type: 'LOW_STOCK_ROP',
        title: '⚠️ แจ้งเตือน: สต๊อกสินค้าแตะจุดสั่งซื้อ (ROP Alert)',
        message: `สินค้า "${product.name}" (${product.code}) มียอดคงเหลือ ${newBal} ${sUnit} ซึ่งน้อยกว่าหรือเท่ากับจุด ROP (${product.reorderPoint} ${sUnit}) แนะนำให้เปิด PR สั่งซื้อเพิ่ม`,
        docNo: product.code,
        refDocType: 'STOCK',
        refDocId: product.id,
        department: product.category,
        targetRoles: [product.category === 'PD' ? 'REQUESTER_PD' : 'REQUESTER_QC', 'ASST_MANAGER', 'ADMIN'],
        actor: 'ระบบแจ้งเตือนสต๊อกอัตโนมัติ'
      });
    }

    return product;
  },

  // ─── Online PO Settlement & Cost Reconciliation ───────────────────────────
  async settlePO(poId, settlementData, user) {
    const pos = storageService.getPOs();
    const po = pos.find(p => String(p.id) === String(poId) || String(p.poNo) === String(poId));
    if (!po) throw new Error('ไม่พบใบสั่งซื้อ');

    const originalTotal = Number(po.grandTotal || po.totalAmount || po.subtotal || 0);
    const actualTotal = Number(settlementData.actualTotalAmount !== undefined ? settlementData.actualTotalAmount : settlementData.actualTotal || 0);
    if (isNaN(actualTotal) || actualTotal < 0) {
      throw new Error('ยอดเงินจ่ายจริงไม่ถูกต้อง');
    }

    const savings = originalTotal - actualTotal;
    const costRatio = originalTotal > 0 ? (actualTotal / originalTotal) : 1;
    let items = Array.isArray(po.items) ? [...po.items] : [];
    const actualItems = settlementData.actualItems || items;

    items = items.map((item, idx) => {
      const explicitActual = Array.isArray(actualItems) && actualItems[idx];
      const basePrice = Number(item.price || item.unitPrice || item.estimatedPrice || 0);
      const unitPrice = explicitActual && explicitActual.actualUnitPrice !== undefined
        ? Number(explicitActual.actualUnitPrice)
        : Math.round((basePrice * costRatio) * 100) / 100;
      return {
        ...item,
        actualPrice: unitPrice,
        actualUnitPrice: unitPrice,
        unitPrice: unitPrice
      };
    });

    po.items = items;
    po.actualTotalAmount = actualTotal;
    po.savingsAmount = savings;
    po.settlementStatus = 'SETTLED';
    po.settlementNote = settlementData.settlementNote || settlementData.note || '';
    po.settlementProofUrl = settlementData.settlementProofUrl || settlementData.proofUrl || '';
    po.settledBy = user?.name || settlementData.settledBy || 'Purchaser';
    po.settledAt = new Date().toISOString();
    po.actualItems = actualItems;
    po.updatedAt = new Date().toISOString();

    if (!Array.isArray(po.activityLog)) po.activityLog = [];
    po.activityLog.push({
      action: 'PO_SETTLED',
      date: new Date().toLocaleString('th-TH'),
      timestamp: new Date().toISOString(),
      user: po.settledBy,
      role: user?.title || user?.role || 'จัดซื้อ',
      note: `ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿${originalTotal.toLocaleString()} | ยอดจ่ายจริง ฿${actualTotal.toLocaleString()}${savings > 0 ? ` | ประหยัดงบ ฿${savings.toLocaleString()}` : ''}${po.settlementNote ? ` | ${po.settlementNote}` : ''}`
    });

    // Refund department budget if savings > 0
    if (savings > 0) {
      const dept = (po.department || user?.department || 'PD').toUpperCase();
      const budgets = storageService.getBudgets();
      if (!budgets[dept]) budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, refundCredits: {} };
      const curSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
      const newSpent = Math.max(0, curSpent - savings);
      budgets[dept].spent = newSpent;
      budgets[dept].actualExpense = newSpent;
      const monthly = Number(budgets[dept].monthlyBudget || 0);
      budgets[dept].variance = monthly - newSpent;
      budgets[dept].remainingBudget = monthly - newSpent;
      const poMonth = po.issueDate ? po.issueDate.substring(0, 7) : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
      budgets[dept].refundCredits[poMonth] = Math.round(((budgets[dept].refundCredits[poMonth] || 0) + savings) * 100) / 100;
      storageService.saveBudgets(budgets);

      storageService.appendBudgetTransaction({
        id: `BTX-SAVINGS-${Date.now()}`,
        date: new Date().toISOString().replace('T', ' ').slice(0, 19),
        createdAt: new Date().toISOString(),
        dept,
        type: 'BUDGET_ROLLBACK',
        typeLabel: 'คืนงบประมาณจากการประหยัด (Procurement Savings)',
        previousAmount: curSpent,
        newAmount: newSpent,
        amount: savings,
        delta: savings,
        actor: user?.name || 'Purchaser',
        refDocNo: po.poNo || po.id,
        note: `คืนงบประมาณจากการปิดยอดจ่ายจริง (Online Settlement) PO ${po.poNo || po.id} (ประหยัด ฿${savings.toLocaleString()})`,
        targetMonth: poMonth
      });
    }

    storageService.savePOs(pos);
    return po;
  }
};
