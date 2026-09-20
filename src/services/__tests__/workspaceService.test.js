import { describe, it, expect } from 'vitest';
import '../../../tests/setup.js';
import { isTaskForMe, isToDoTask, isInProgressTask, getTaskBadgeLabel } from '../workspaceService';

describe('workspaceService: Task Routing Double-Lock', () => {
  const requesterUser = {
    id: 'REQ-01',
    name: 'นายสมชาย ผู้ขอซื้อ',
    role: 'USER',
    roleId: 'USER',
    department: 'QC',
    departmentId: 'QC'
  };

  const purchaserUser = {
    id: 'PUR-01',
    name: 'เจ้าหน้าที่จัดซื้อออนไลน์',
    role: 'ONLINE_PURCHASER',
    roleId: 'ONLINE_PURCHASER',
    department: 'PURCHASE',
    departmentId: 'PURCHASE'
  };

  const adminUser = {
    id: 'ADMIN',
    name: 'ผู้ดูแลระบบ',
    role: 'ADMIN',
    roleId: 'ADMIN'
  };

  // Case B (Workspace To Do): เมื่อ PO อยู่ในสถานะ CLAIM_PENDING หรือ WAITING_DELIVERY_ROUND_2 -> Requester ต้องได้ isToDoTask === false และ isInProgressTask === true
  describe('Case B (Workspace To Do & In Progress Routing)', () => {
    it('when PO is in CLAIM_PENDING -> Requester gets isToDoTask === false and isInProgressTask === true', () => {
      const claimPendingPO = {
        id: 'PO-CLAIM-901',
        poNo: 'PO-2026-CLAIM-01',
        docType: 'PO',
        status: 'CLAIM_PENDING',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        requestedBy: 'นายสมชาย ผู้ขอซื้อ',
        requesterId: 'REQ-01',
        hasUnresolvedClaim: true,
        items: [{ name: 'สินค้าติดเคลม', orderedQty: 10, receivedQty: 8, shortageQty: 2 }]
      };

      // Requester ห้ามเห็นใน To Do เด็ดขาด
      expect(isToDoTask(claimPendingPO, requesterUser)).toBe(false);
      expect(isTaskForMe(claimPendingPO, requesterUser)).toBe(false);

      // Requester ต้องเห็นใน In Progress (รอฝ่ายจัดซื้อดำเนินการ)
      expect(isInProgressTask(claimPendingPO, requesterUser)).toBe(true);

      // Badge สำหรับ Requester
      expect(getTaskBadgeLabel(claimPendingPO, requesterUser)).toBe('⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า');

      // Purchaser / Admin ต้องเห็นใน To Do เพื่อดำเนินการเคลม
      expect(isToDoTask(claimPendingPO, purchaserUser)).toBe(true);
      expect(isToDoTask(claimPendingPO, adminUser)).toBe(true);
    });

    it('when PO is in WAITING_DELIVERY_ROUND_2 -> Requester gets isToDoTask === true and isInProgressTask === false', () => {
      const round2PO = {
        id: 'PO-ROUND2-902',
        poNo: 'PO-2026-ROUND2-02',
        docType: 'PO',
        status: 'WAITING_DELIVERY_ROUND_2',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        requestedBy: 'นายสมชาย ผู้ขอซื้อ',
        requesterId: 'REQ-01',
        hasUnresolvedClaim: false,
        items: [{ name: 'สินค้ารอรอบ 2', orderedQty: 10, receivedQty: 8, shortageQty: 2 }]
      };

      // Requester ต้องเห็นใน To Do ทันทีเพื่อเตรียมรับของ
      expect(isToDoTask(round2PO, requesterUser)).toBe(true);
      expect(isTaskForMe(round2PO, requesterUser)).toBe(true);

      // Requester ต้องไม่เห็นใน In Progress
      expect(isInProgressTask(round2PO, requesterUser)).toBe(false);

      // Badge ระบุชัดเจน
      expect(getTaskBadgeLabel(round2PO, requesterUser)).toBe('รอร้านค้าส่งของรอบที่ 2 (ทดแทน)');
    });
  });

  describe('Multi-Department Reviewer Support (Sidebar & Workspace Consistency)', () => {
    it('Kanlayanee (Reviewer for PD, QC) should have todoCount = 1 for a pending PR in PD', () => {
      const kanlayaneeUser = {
        id: 'REV-01',
        name: 'กัลยาณี',
        role: 'REVIEWER',
        roleId: 'ASST_MANAGER',
        level: 2,
        department: 'PD, QC'
      };

      const prPendingReview = {
        id: 'PR-PD-001',
        docType: 'PR',
        prNo: 'PR-2026-PD-01',
        status: 'pending_review',
        department: 'PD',
        requestedBy: 'พนักงานฝ่ายผลิต'
      };

      // To-Do Count simulation for Sidebar
      const allTasks = [prPendingReview];
      const todoCount = allTasks.filter(task => isToDoTask(task, kanlayaneeUser, [prPendingReview], [])).length;
      
      expect(isToDoTask(prPendingReview, kanlayaneeUser)).toBe(true);
      expect(todoCount).toBe(1);
    });
  });
});
