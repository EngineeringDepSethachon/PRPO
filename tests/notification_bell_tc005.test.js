// TC-005 (docs/bug-log-tester-2026-10-14.md) : bell badge (open tasks) vs popover list (server notifications)
import { describe, it, expect, beforeEach } from 'vitest';
import './setup.js';
import { notificationService } from '../src/services/notificationService';
import { workflowEngine } from '../src/services/workflowEngine';
import { isTaskForMe } from '../src/services/workspaceService';

// current role as the client holds it (roleId / level ; "role" is the lower-cased roleId set by AppContext)
const purchaserLike = { id: 'U-9', name: 'Buyer', roleId: 'STORE_STAFF', role: 'store_staff', canonicalRole: 'STORE_STAFF', level: 2, department: 'PD', canOnlinePurchase: true };
const requester = { id: 'REQ-01', name: 'Pim Requester', roleId: 'REQUESTER_PD', level: 1, department: 'PD' };
const requesterFinal = { ...requester, id: 'REQ-02', canFinalApprove: true };

// rows exactly as GET /api/notifications / bootstrap return them (functions/_lib/notify.js + shapeNotification)
const serverRow = (over = {}) => ({
  id: 'NTF-1', timestamp: '2026-10-14T01:00:00.000Z', title: 'PO ถูกยกเลิกและคืนงบประมาณแล้ว', message: 'x', type: 'PO_CANCELLED',
  targetDepartment: 'PD', targetRole: 'Purchaser', docRef: 'PO-1', status: 'unread', isRead: false, read: false, createdAt: '2026-10-14T01:00:00.000Z', ...over
});

describe('TC-005 notifications the server sent to this user are listed', () => {
  beforeEach(() => { localStorage.clear(); });

  it('a server-scoped row is shown even when the client role/department rule would not match', () => {
    const row = serverRow({ targetDepartment: 'QC', targetRole: 'Purchaser' });
    const me = { ...requester, canOnlinePurchase: false };
    expect(notificationService.isNotificationTarget(row, me)).toBe(false); // untagged = old client rule
    notificationService.saveAll(notificationService.tagServerScoped([row]));
    expect(notificationService.getNotificationsForRole(me, 'Pim Requester')).toHaveLength(1);
  });

  it('untagged (locally made) rows for another department are still hidden', () => {
    notificationService.saveAll([serverRow({ targetDepartment: 'QC', targetRole: 'Requester' })]);
    expect(notificationService.getNotificationsForRole(requester, 'Pim Requester')).toHaveLength(0);
  });

  it('read state still applies to tagged rows', () => {
    notificationService.saveAll(notificationService.tagServerScoped([serverRow({ status: 'read', isRead: true, read: true })]));
    const list = notificationService.getNotificationsForRole(purchaserLike, 'Buyer');
    expect(list).toHaveLength(1);
    expect(notificationService.getUnreadCountForRole(purchaserLike, 'Buyer')).toBe(0);
  });
});

describe('TC-005 badge (getUserTasks) equals the To-Do list for claims', () => {
  const claimPo = (over = {}) => ({
    id: 'PO-C1', poNo: 'PO-C1', docType: 'PO', department: 'PD', requestedBy: 'Pim Requester', requesterId: 'REQ-01',
    status: 'PARTIAL', purchaseChannel: 'SELF', items: [{ name: 'A' }], ...over
  });
  const todo = (pos, user) => pos.filter(p => isTaskForMe(p, user)).length;
  const badge = (pos, user) => workflowEngine.getUserTasks(user, [], pos).counts.total;

  it('claimStatus IN_CLAIM / PENDING_CLAIM counts in both', () => {
    for (const claimStatus of ['IN_CLAIM', 'PENDING_CLAIM']) {
      const pos = [claimPo({ claimStatus })];
      expect(todo(pos, requester)).toBe(1);
      expect(badge(pos, requester)).toBe(1);
    }
  });

  it('an unresolved storeClaims entry counts in both', () => {
    const pos = [claimPo({ storeClaims: { s1: { isResolved: false } } })];
    expect(todo(pos, requester)).toBe(1);
    expect(badge(pos, requester)).toBe(1);
  });

  it('a Requester (level 1) holding canFinalApprove is a Requester for claims in both', () => {
    const pos = [claimPo({ claimStatus: 'IN_CLAIM', requesterId: 'REQ-02' })];
    expect(todo(pos, requesterFinal)).toBe(1);
    expect(badge(pos, requesterFinal)).toBe(1);
  });

  it('a Reviewer (level 2) is not the owner of a self claim in either', () => {
    const reviewer = { id: 'REV-01', name: 'Asst', roleId: 'ASST_MANAGER', level: 2, department: 'PD', canReview: true };
    const pos = [claimPo({ claimStatus: 'IN_CLAIM' })];
    expect(todo(pos, reviewer)).toBe(0);
    expect(badge(pos, reviewer)).toBe(0);
  });

  it('a COMPLETED / COMPLETED_WITH_REFUND PO with a stale claimStatus is 0 in both', () => {
    for (const status of ['COMPLETED', 'COMPLETED_WITH_REFUND']) {
      const pos = [claimPo({ status, claimStatus: 'IN_CLAIM' })];
      expect(todo(pos, requester)).toBe(0);
      expect(badge(pos, requester)).toBe(0);
    }
  });

  it('owner by requesterId only (different name, other department) counts the same in both', () => {
    const pos = [claimPo({ claimStatus: 'IN_CLAIM', requestedBy: 'someone', department: 'QC' })];
    expect(todo(pos, requester)).toBe(1);
    expect(badge(pos, requester)).toBe(1);
  });

  it('WAITING_DELIVERY_ROUND_2 with a stale hasUnresolvedClaim flag is not an open claim in either', () => {
    const pos = [claimPo({ status: 'WAITING_DELIVERY_ROUND_2', hasUnresolvedClaim: true })];
    expect(badge(pos, requester)).toBe(todo(pos, requester));
  });
});
