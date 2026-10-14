// TC-003 / TC-006 / TC-009 (docs/bug-log-tester-2026-10-14.md) : claim flow stuck half way
import { describe, it, expect, beforeEach } from 'vitest';
import './setup.js';
import { isTaskForMe, isInProgressTask, isSelfClaimStatus, isPoInOpenClaim, getTaskBadgeLabel } from '../src/services/workspaceService';
import { workflowEngine } from '../src/services/workflowEngine';
import { storageService } from '../src/services/storageService';
import { hasUnresolvedClaim } from '../src/views/OnlineTaskView';
import { filterOrdersByTab, getTabMetrics } from '../src/views/procurement/OnlineProcurementHub';

const requester = { id: 'REQ-01', name: 'Pim Requester', roleId: 'REQUESTER_PD', level: 1, department: 'PD', canReceiveGoods: true };
const reviewer = { id: 'REV-01', name: 'Asst Manager', roleId: 'ASST_MANAGER', level: 2, department: 'PD', canReview: true };
const purchaser = { id: 'ONLINE_PURCHASER', name: 'Online Buyer', roleId: 'ONLINE_PURCHASER', level: 2, canOnlinePurchase: true, department: 'ALL' };
const admin = { id: 'ADMIN', name: 'Admin', roleId: 'ADMIN', level: 99 };

// what ReceivingModal saves for "บันทึกปัญหาไว้ก่อน" (ReceivingModal.jsx ~1107-1123)
const pendingClaimPo = (over = {}) => ({
  id: 'PO-C1', poNo: 'PO-C1', docType: 'PO', department: 'PD', requestedBy: 'Pim Requester', requesterId: 'REQ-01',
  status: 'PARTIALLY_RECEIVED_IN_CLAIM', workflowStatus: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM',
  hasDispute: true, isInClaim: true, hasUnresolvedClaim: true, purchaseChannel: 'SELF',
  claimData: { reason: 'broken', description: 'x', reportedBy: 'Pim Requester' },
  items: [{ name: 'A', orderedQty: 10, receivedQty: 8, damagedQty: 2, shortageQty: 0, hasDispute: true }],
  ...over
});

describe('TC-003 self-buy "บันทึกปัญหาไว้ก่อน" can be continued by the Requester', () => {
  it('PODetailsModal treats PARTIALLY_RECEIVED_IN_CLAIM / CLAIM_PENDING of a SELF PO as a claim the Requester resolves (button + panel condition)', () => {
    expect(isSelfClaimStatus(pendingClaimPo())).toBe(true);
    expect(isSelfClaimStatus(pendingClaimPo({ status: 'CLAIM_PENDING' }))).toBe(true);
    expect(isSelfClaimStatus(pendingClaimPo({ status: 'CLAIM_REPORTED' }))).toBe(true);
    expect(isSelfClaimStatus(pendingClaimPo({ status: 'CLAIM_IN_PROGRESS' }))).toBe(true);
  });

  it('is not widened to ONLINE POs (their claim panel is the Online Hub) nor to non-claim statuses', () => {
    expect(isSelfClaimStatus(pendingClaimPo({ purchaseChannel: 'ONLINE' }))).toBe(false);
    expect(isSelfClaimStatus(pendingClaimPo({ status: 'PARTIAL' }))).toBe(false);
    expect(isSelfClaimStatus(pendingClaimPo({ status: 'WAITING_DELIVERY_ROUND_2' }))).toBe(false);
    expect(isSelfClaimStatus(null)).toBe(false);
  });

  it('the task is in the To-Do of the Requester (and admin), not of the Reviewer ; the Reviewer follows it under "in progress"', () => {
    const po = pendingClaimPo();
    expect(isTaskForMe(po, requester)).toBe(true);
    expect(isTaskForMe(po, admin)).toBe(true);
    expect(isTaskForMe(po, reviewer)).toBe(false);
    expect(isInProgressTask(po, reviewer, [], [])).toBe(true);
    expect(isTaskForMe(po, purchaser)).toBe(false);
  });

  it('a Requester of another department does not get the task', () => {
    expect(isTaskForMe(pendingClaimPo({ requestedBy: 'someone', requesterId: 'X' }), { ...requester, department: 'QC' })).toBe(false);
  });

  it('resolving it (RESEND) moves the PO to WAITING_DELIVERY_ROUND_2 and the Requester gets the round-2 receiving task', async () => {
    storageService.savePOs([pendingClaimPo()]);
    const resolved = await workflowEngine.resolveClaim('PO-C1', { type: 'RESEND', note: 'shop resends', expectedDate: '2026-10-20' }, requester);
    expect(resolved.status).toBe('WAITING_DELIVERY_ROUND_2');
    expect(resolved.hasUnresolvedClaim).toBe(false);
    expect(isTaskForMe({ ...resolved, docType: 'PO' }, requester)).toBe(true);
  });

  it('resolving it with CLOSE_NO_ACTION / CLOSE_WITH_REFUND closes the PO', async () => {
    storageService.savePOs([pendingClaimPo()]);
    const a = await workflowEngine.resolveClaim('PO-C1', { type: 'CLOSE_NO_ACTION', note: 'accept' }, requester);
    expect(a.status).toBe('COMPLETED');
    storageService.savePOs([pendingClaimPo()]);
    const b = await workflowEngine.resolveClaim('PO-C1', { type: 'CLOSE_WITH_REFUND', refundAmount: 100, note: 'refund' }, requester);
    expect(b.status).toBe('COMPLETED');
    expect(b.hasUnresolvedClaim).toBe(false);
  });
});

describe('TC-006 online claim done -> Requester To-Do (not "in progress")', () => {
  const afterOnlineClaim = (over = {}) => ({
    id: 'PO-O1', poNo: 'PO-O1', docType: 'PO', department: 'PD', requestedBy: 'Pim Requester', requesterId: 'REQ-01', purchaseChannel: 'ONLINE',
    status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'REPLACEMENT_PENDING', hasDispute: false, isInClaim: false,
    hasUnresolvedClaim: true, // stale flag ReceivingModal set when the claim was filed
    storeClaims: { s1: { isResolved: true, type: 'REPLACEMENT' } },
    items: [{ name: 'A', orderedQty: 10, receivedQty: 8, replacementPendingQty: 2 }],
    ...over
  });

  it('a stale hasUnresolvedClaim flag does not keep a WAITING_DELIVERY_ROUND_2 PO as a claim', () => {
    expect(isPoInOpenClaim(afterOnlineClaim())).toBe(false);
    expect(isTaskForMe(afterOnlineClaim(), requester)).toBe(true);
    expect(isInProgressTask(afterOnlineClaim(), requester, [], [])).toBe(false);
    expect(isTaskForMe(afterOnlineClaim(), purchaser)).toBe(false);
    expect(getTaskBadgeLabel(afterOnlineClaim(), requester)).not.toContain('เจรจาเคลม');
  });

  it('while a store is still unresolved (IN_CLAIM / isResolved false) the task stays with the Purchaser', () => {
    const open = afterOnlineClaim({ claimStatus: 'IN_CLAIM', storeClaims: { s1: { isResolved: true }, s2: { isResolved: false, status: 'PENDING_CLAIM' } } });
    expect(isPoInOpenClaim(open)).toBe(true);
    expect(isTaskForMe(open, requester)).toBe(false);
    expect(isTaskForMe(open, purchaser)).toBe(true);
    expect(isPoInOpenClaim(afterOnlineClaim({ claimStatus: 'REPLACEMENT_PENDING', storeClaims: { s2: { isResolved: false } } }))).toBe(true);
  });

  it('a real claim status is still a claim (online : Purchaser only)', () => {
    const claim = afterOnlineClaim({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasDispute: true, isInClaim: true });
    expect(isTaskForMe(claim, requester)).toBe(false);
    expect(isTaskForMe(claim, purchaser)).toBe(true);
  });

  it('workflowEngine.resolveClaim (all stores resolved, REPLACEMENT) clears the stale flags so the Requester gets the task', async () => {
    const po = afterOnlineClaim({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasDispute: true, isInClaim: true, storeClaims: { s1: { isResolved: false, status: 'PENDING_CLAIM' } } });
    storageService.savePOs([po]);
    const res = await workflowEngine.resolveClaim('PO-O1', { storeKey: 's1', type: 'REPLACEMENT', allStoresResolved: true, hasPendingDeliveries: true, note: 'n' }, purchaser);
    expect(res.status).toBe('WAITING_DELIVERY_ROUND_2');
    expect(res.hasUnresolvedClaim).toBe(false);
    expect(res.isInClaim).toBe(false);
    expect(res.hasDispute).toBe(false);
    expect(isTaskForMe({ ...res, docType: 'PO' }, requester)).toBe(true);
  });

  it('a partial resolution (other store still pending) keeps the flags', async () => {
    const po = afterOnlineClaim({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasDispute: true, isInClaim: true });
    storageService.savePOs([po]);
    const res = await workflowEngine.resolveClaim('PO-O1', { storeKey: 's1', type: 'REPLACEMENT', allStoresResolved: false, note: 'n' }, purchaser);
    expect(res.claimStatus).toBe('IN_CLAIM');
    expect(res.hasUnresolvedClaim).toBe(true);
  });

  it('Sidebar/Navbar counter (getUserTasks): the Requester gets the round-2 task as an action, the Reviewer does not get a self-buy claim', () => {
    const t = workflowEngine.getUserTasks(requester, [], [afterOnlineClaim()]);
    expect(t.action.map(x => x.id)).toContain('PO-O1');
    const own = workflowEngine.getUserTasks(requester, [], [pendingClaimPo()]);
    expect(own.action.map(x => x.id)).toContain('PO-C1');
    const rev = workflowEngine.getUserTasks(reviewer, [], [pendingClaimPo()]);
    expect(rev.action.map(x => x.id)).not.toContain('PO-C1');
  });
});

describe('TC-009 Online Hub moves the finished claim PO to "ปิดงานสำเร็จ"', () => {
  beforeEach(() => storageService.savePOs([]));
  const thisYear = new Date().toISOString();
  const completedAfterClaim = (over = {}) => ({
    id: 'PO-H1', poNo: 'PO-H1', department: 'PD', purchaseChannel: 'ONLINE', status: 'COMPLETED', workflowStatus: 'COMPLETED',
    completedAt: thisYear, receivedAt: thisYear, claimStatus: 'REPLACEMENT_PENDING',
    hasDispute: false, isInClaim: false, hasUnresolvedClaim: false,
    grnHistory: [{ date: thisYear }],
    items: [{ name: 'A', orderedQty: 10, receivedQty: 10, damagedQty: 0, shortageQty: 0, claimResolution: 'REPLACEMENT' }],
    storeClaims: { s1: { isResolved: true, type: 'REPLACEMENT' } },
    ...over
  });

  it('COMPLETED + leftover claim markers (hasUnresolvedClaim / isInClaim / claimStatus IN_CLAIM) is NOT a claim and lands in the closed tab', () => {
    for (const over of [{ hasUnresolvedClaim: true }, { isInClaim: true }, { claimStatus: 'IN_CLAIM' }, { claimStatus: 'PENDING_CLAIM' }, { hasDispute: true, isInClaim: true, hasUnresolvedClaim: true }]) {
      const po = completedAfterClaim(over);
      expect(hasUnresolvedClaim(po)).toBe(false);
      expect(filterOrdersByTab([po], 'CLOSED').length).toBe(1);
      expect(filterOrdersByTab([po], 'CLAIM').length).toBe(0);
      const m = getTabMetrics([po]);
      expect(m.closed).toBe(1);
      expect(m.claim).toBe(0);
    }
  });

  it('COMPLETED_WITH_REFUND with leftover markers also closes', () => {
    const po = completedAfterClaim({ status: 'COMPLETED_WITH_REFUND', workflowStatus: 'COMPLETED_WITH_REFUND', isInClaim: true });
    expect(filterOrdersByTab([po], 'CLOSED').length).toBe(1);
  });

  it('a closed PO that still has a store claim not negotiated stays a claim', () => {
    const po = completedAfterClaim({
      hasUnresolvedClaim: true,
      items: [{ name: 'B', orderedQty: 5, receivedQty: 4, damagedQty: 1, actualStoreName: 's2', storePlatform: 'Shopee' }],
      storeClaims: { s1: { isResolved: true }, s2: { isResolved: false, status: 'PENDING_CLAIM' } }
    });
    expect(hasUnresolvedClaim(po)).toBe(true);
    expect(filterOrdersByTab([po], 'CLOSED').length).toBe(0);
  });

  it('an open claim status is still a claim (not closed)', () => {
    const po = completedAfterClaim({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', workflowStatus: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasUnresolvedClaim: true, isInClaim: true, hasDispute: true, storeClaims: { s1: { isResolved: false, status: 'PENDING_CLAIM' } }, items: [{ name: 'A', orderedQty: 10, receivedQty: 8, damagedQty: 2 }] });
    expect(filterOrdersByTab([po], 'CLAIM').length).toBe(1);
    expect(filterOrdersByTab([po], 'CLOSED').length).toBe(0);
  });

  it('end to end : claim filed -> Purchaser resolves REPLACEMENT -> Requester completes round 2 -> closed tab', async () => {
    const filed = {
      ...completedAfterClaim({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', workflowStatus: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasDispute: true, isInClaim: true, hasUnresolvedClaim: true,
        storeClaims: { s1: { isResolved: false, status: 'PENDING_CLAIM' } }, completedAt: undefined }),
      isCompleted: false
    };
    storageService.savePOs([filed]);
    const resolved = await workflowEngine.resolveClaim('PO-H1', { storeKey: 's1', type: 'REPLACEMENT', allStoresResolved: true, hasPendingDeliveries: true, note: 'n' }, purchaser);
    expect(filterOrdersByTab([resolved], 'ORDERED').length).toBe(1);
    // round 2 fully received (a receive path that only sets the status, like warehouseService : flags are not touched by it)
    const done = { ...resolved, status: 'COMPLETED', workflowStatus: 'COMPLETED', completedAt: thisYear, receivedAt: thisYear };
    expect(filterOrdersByTab([done], 'CLOSED').length).toBe(1);
    // and even a PO saved before this fix (stale flags) closes
    expect(filterOrdersByTab([{ ...done, hasUnresolvedClaim: true, isInClaim: true }], 'CLOSED').length).toBe(1);
  });
});
