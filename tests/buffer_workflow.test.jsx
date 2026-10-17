// M10 T5 (FR-01) : client workflow engine for the BUFFER step ("พี่สุ", PENDING_BUFFER)
//   canAction / canCancelPR / rejectPR / cancelPR per role, updatePRStatus following the server's saved status, editPRItems (link + financials),
//   getUserTasks / workspaceService routing, notificationService audience.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';

import { ROLES } from '../src/config/constants';
import { workflowEngine, canBufferForward, canEditPrAtBuffer, canReturnAtBuffer } from '../src/services/workflowEngine';
import { apiService } from '../src/services/apiService';
import { storageService } from '../src/services/storageService';
import { notificationService } from '../src/services/notificationService';
import {
  isTaskForMe, isInProgressTask, canSeeWorkspaceDocument, isUserStakeholder
} from '../src/services/workspaceService';

// ── actors ──
const buffer = { ...ROLES.BUFFER, roleId: 'BUFFER', name: 'พี่สุ', title: 'ผู้ตรวจสอบจัดซื้อ (พี่สุ)' };
const bufferMgt = { id: 'USR-BUF', roleId: 'BUFFER', level: 2, department: 'MGT', name: 'พี่สุ', canViewAllDepts: true, isBuffer: true }; // admin files the role under MGT
const reviewer = { ...ROLES.ASST_MANAGER, roleId: 'ASST_MANAGER' };
const reviewerQC = { ...ROLES.ASST_MANAGER, roleId: 'ASST_MANAGER', department: 'QC', departments: ['QC'] };
const approver = { ...ROLES.PLANT_MANAGER, roleId: 'PLANT_MANAGER' };
const requester = { ...ROLES.REQUESTER_PD, roleId: 'REQUESTER_PD', name: 'คุณวิชัย (PD)' };
const online = { ...ROLES.ONLINE_PURCHASER, roleId: 'ONLINE_PURCHASER' };
const admin = { ...ROLES.ADMIN, roleId: 'ADMIN' };

const seedPr = (over = {}) => ({
  id: 'PR-BUF-1', prNo: 'PD001/2026', department: 'PD', status: 'PENDING_BUFFER', purchaseChannel: 'ONLINE',
  requestedBy: 'คุณวิชัย (PD)', requestedDate: '2026-10-17', totalAmount: 250,
  items: [
    { id: 'I1', code: 'C1', name: 'ถุงมือ', purchaseQty: 2, qty: 2, price: 100, total: 200, purchaseUnit: 'กล่อง', stockUnit: 'กล่อง', conversionRate: 1, stockQty: 2, productUrl: 'https://shopee.co.th/a' },
    { id: 'I2', code: 'C2', name: 'เทป', purchaseQty: 1, qty: 1, price: 50, total: 50, purchaseUnit: 'ม้วน', stockUnit: 'ม้วน', conversionRate: 1, stockQty: 1 }
  ],
  activityLog: [{ action: 'ตรวจสอบแล้ว', user: 'ผู้ตรวจสอบ A', role: 'Reviewer PD', timestamp: 't' }],
  approvalHistory: [],
  ...over
});

const jsonRes = (body, ok = true, status = 200) => {
  const res = { ok, status, json: async () => body };
  res.clone = () => res;
  return res;
};

const putCalls = (fetchMock) => fetchMock.mock.calls.filter(([, init]) => init && init.method === 'PUT');

beforeEach(() => {
  localStorage.clear();
  storageService.resetData();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('canAction at PENDING_BUFFER (and the BUFFER role elsewhere)', () => {
  const pr = seedPr();

  it('only BUFFER and admin may act on PENDING_BUFFER', () => {
    expect(workflowEngine.canAction(buffer, pr)).toBe(true);
    expect(workflowEngine.canAction(bufferMgt, pr)).toBe(true); // department filed as MGT : still every department
    expect(workflowEngine.canAction(admin, pr)).toBe(true);
    expect(workflowEngine.canAction(reviewer, pr)).toBe(false);
    expect(workflowEngine.canAction(approver, pr)).toBe(false);
    expect(workflowEngine.canAction(requester, pr)).toBe(false);
    expect(workflowEngine.canAction(online, pr)).toBe(false);
  });

  it('BUFFER may not review SUBMITTED / REJECTED_TO_L2, may not approve REVIEWED ; the reviewer / approver keep theirs', () => {
    for (const status of ['SUBMITTED', 'REJECTED_TO_L2']) {
      expect(workflowEngine.canAction(buffer, seedPr({ status }))).toBe(false);
      expect(workflowEngine.canAction(bufferMgt, seedPr({ status }))).toBe(false);
      expect(workflowEngine.canAction(reviewer, seedPr({ status }))).toBe(true);
    }
    expect(workflowEngine.canAction(buffer, seedPr({ status: 'REVIEWED' }))).toBe(false);
    expect(workflowEngine.canAction(approver, seedPr({ status: 'REVIEWED' }))).toBe(true);
    expect(workflowEngine.canAction(reviewer, seedPr({ status: 'REVIEWED' }))).toBe(false);
  });

  it('old REVIEWED / APPROVED PRs behave exactly as before for every role', () => {
    const reviewed = seedPr({ status: 'REVIEWED' });
    expect(workflowEngine.canAction(admin, reviewed)).toBe(true);
    expect(workflowEngine.canAction(requester, reviewed)).toBe(false);
    expect(workflowEngine.canAction(online, reviewed)).toBe(false);
    for (const status of ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED', 'CANCELLED']) {
      expect(workflowEngine.canAction(buffer, seedPr({ status }))).toBe(false);
      expect(workflowEngine.canAction(approver, seedPr({ status }))).toBe(false);
    }
  });

  it('canBufferForward / canEditPrAtBuffer : BUFFER + admin at PENDING_BUFFER only', () => {
    const pr = seedPr();
    for (const fn of [canBufferForward, canEditPrAtBuffer, workflowEngine.canBufferForward, workflowEngine.canEditPrAtBuffer]) {
      expect(fn(buffer, pr)).toBe(true);
      expect(fn(admin, pr)).toBe(true);
      expect(fn(reviewer, pr)).toBe(false);
      expect(fn(approver, pr)).toBe(false);
      expect(fn(requester, pr)).toBe(false);
      expect(fn(buffer, seedPr({ status: 'REVIEWED' }))).toBe(false);
      expect(fn(buffer, seedPr({ status: 'SUBMITTED' }))).toBe(false);
      expect(fn(null, pr)).toBe(false);
      expect(fn(buffer, null)).toBe(false);
    }
  });
});

describe('canCancelPR / rejectPR / cancelPR at PENDING_BUFFER', () => {
  const pr = seedPr();

  it('reviewer, approver and admin may send back / cancel ; BUFFER, requester and online purchaser may not', () => {
    expect(workflowEngine.canCancelPR(reviewer, pr)).toBe(true);
    expect(workflowEngine.canCancelPR(approver, pr)).toBe(true);
    expect(workflowEngine.canCancelPR(admin, pr)).toBe(true);
    expect(workflowEngine.canCancelPR(buffer, pr)).toBe(false);
    expect(workflowEngine.canCancelPR(bufferMgt, pr)).toBe(false);
    expect(workflowEngine.canCancelPR(requester, pr)).toBe(false);
    expect(workflowEngine.canCancelPR(online, pr)).toBe(false);
    expect(canReturnAtBuffer(reviewer, pr)).toBe(true);
    expect(canReturnAtBuffer(buffer, pr)).toBe(false);
  });

  it('a reviewer of another department may not', () => {
    expect(workflowEngine.canCancelPR(reviewerQC, pr)).toBe(false);
  });

  it('other statuses keep the old canCancelPR rule (stage owner) and BUFFER gets nothing new', () => {
    expect(workflowEngine.canCancelPR(reviewer, seedPr({ status: 'SUBMITTED' }))).toBe(true);
    expect(workflowEngine.canCancelPR(buffer, seedPr({ status: 'SUBMITTED' }))).toBe(false);
    expect(workflowEngine.canCancelPR(approver, seedPr({ status: 'REVIEWED' }))).toBe(true);
    expect(workflowEngine.canCancelPR(reviewer, seedPr({ status: 'REVIEWED' }))).toBe(false);
    expect(workflowEngine.canCancelPR(approver, seedPr({ status: 'APPROVED' }))).toBe(false);
  });

  it('rejectPR : BUFFER is refused, reviewer / approver / admin send it back to the requester', async () => {
    storageService.savePRs([seedPr()]);
    await expect(workflowEngine.rejectPR('PR-BUF-1', buffer, 'ไม่ผ่าน')).rejects.toThrow();
    expect(storageService.getPRs().find(p => p.id === 'PR-BUF-1').status).toBe('PENDING_BUFFER');

    for (const actor of [reviewer, approver, admin]) {
      storageService.savePRs([seedPr()]);
      const out = await workflowEngine.rejectPR('PR-BUF-1', actor, 'ขอแก้ไข');
      expect(out.status).toBe('REJECTED_TO_DRAFT');
    }
  });

  it('cancelPR : BUFFER is refused, reviewer / approver / admin cancel', async () => {
    storageService.savePRs([seedPr()]);
    await expect(workflowEngine.cancelPR('PR-BUF-1', buffer, 'ยกเลิก')).rejects.toThrow();
    expect(storageService.getPRs().find(p => p.id === 'PR-BUF-1').status).toBe('PENDING_BUFFER');

    for (const actor of [reviewer, approver, admin]) {
      storageService.savePRs([seedPr()]);
      const out = await workflowEngine.cancelPR('PR-BUF-1', actor, 'ยกเลิก');
      expect(out.status).toBe('CANCELLED');
    }
  });
});

describe('updatePRStatus follows the status the server saved (cloudflare mode)', () => {
  const useCloudflare = (fetchImpl) => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const stored = (id = 'PR-BUF-1') => storageService.getPRs().find(p => p.id === id);
  const types = () => notificationService.getAll().map(n => n.type);

  it('reviewer pass + server answers PENDING_BUFFER -> PR parks at PENDING_BUFFER, message "ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว", no approver notification', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    const fetchMock = useCloudflare(async () => jsonRes({ success: true, id: 'PR-BUF-1', pr: { id: 'PR-BUF-1', status: 'PENDING_BUFFER' } }));

    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok');

    expect(putCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(putCalls(fetchMock)[0][1].body).status).toBe('REVIEWED'); // the client still asks for REVIEWED : the server decides
    expect(result.pr.status).toBe('PENDING_BUFFER');
    expect(result.finalStatus).toBe('PENDING_BUFFER');
    expect(result.bufferSkipped).toBe(false);
    expect(result.successMessage).toBe('ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว');
    expect(stored().status).toBe('PENDING_BUFFER');
    expect(stored().workflowStatus).toBe('PENDING_BUFFER');
    expect(stored().reviewedBy).toBeTruthy(); // reviewer stamp is kept
    expect(stored().activityLog.some(l => String(l.action).includes('ผู้ตรวจสอบจัดซื้อ'))).toBe(true);
    expect(types()).not.toContain('PR_REVIEWED'); // the approver is NOT told yet
    expect(workflowEngine.canAction(buffer, stored())).toBe(true);
    expect(workflowEngine.canAction(approver, stored())).toBe(false);
  });

  it('reviewer pass + server answers REVIEWED with bufferSkipped -> REVIEWED, message "ส่งต่อ Plant Mgr แล้ว", approver notified', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    useCloudflare(async () => jsonRes({ success: true, id: 'PR-BUF-1', pr: { id: 'PR-BUF-1', status: 'REVIEWED' }, bufferSkipped: true }));

    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok');

    expect(result.pr.status).toBe('REVIEWED');
    expect(result.finalStatus).toBe('REVIEWED');
    expect(result.bufferSkipped).toBe(true);
    expect(result.successMessage).toBe('ส่งต่อ Plant Mgr แล้ว');
    expect(stored().status).toBe('REVIEWED');
    expect(stored().bufferSkipped).toBe(true);
    expect(types().filter(t => t === 'PR_REVIEWED')).toHaveLength(1);
    expect(types()).not.toContain('PR_PENDING_BUFFER');
    expect(workflowEngine.canAction(approver, stored())).toBe(true);
  });

  it('a bare PR body (no { pr } envelope) is understood too', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    useCloudflare(async () => jsonRes({ id: 'PR-BUF-1', status: 'PENDING_BUFFER' }));
    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok');
    expect(result.pr.status).toBe('PENDING_BUFFER');
  });

  it('an answer without a status ({ success, unchanged }) keeps what was sent (REVIEWED)', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    useCloudflare(async () => jsonRes({ success: true, id: 'PR-BUF-1' }));
    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok');
    expect(result.pr.status).toBe('REVIEWED');
    expect(result.successMessage).toBe('ส่งต่อ Plant Mgr แล้ว');
  });

  it('BUFFER forward : PENDING_BUFFER -> REVIEWED carries bufferComment, keeps the reviewer stamp, notifies the approver', async () => {
    const reviewerStamp = { id: 'USR-0003', name: 'คุณสมชาย', signature: null, timestamp: '2026-10-17T01:00:00.000Z' };
    storageService.savePRs([seedPr({ reviewedBy: reviewerStamp })]);
    const fetchMock = useCloudflare(async () => jsonRes({ success: true, id: 'PR-BUF-1', pr: { id: 'PR-BUF-1', status: 'REVIEWED' } }));

    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', buffer, 'ราคาถูกลง', { bufferComment: 'ราคาถูกลง' });

    const body = JSON.parse(putCalls(fetchMock)[0][1].body);
    expect(body.status).toBe('REVIEWED');
    expect(body.bufferComment).toBe('ราคาถูกลง');
    expect(result.pr.status).toBe('REVIEWED');
    expect(result.successMessage).toBe('ส่งต่อ Plant Mgr แล้ว');
    expect(stored().reviewedBy).toEqual(reviewerStamp); // not overwritten by the BUFFER user
    expect(stored().bufferComment).toBe('ราคาถูกลง');
    expect(stored().bufferReviewedAt).toBeTruthy();
    expect(stored().activityLog.at(-1).action).toContain('Buffer Forward');
    expect(types().filter(t => t === 'PR_REVIEWED')).toHaveLength(1);
  });

  it('BUFFER forward through the AppContext-facing helper shape : comment defaults to the note', async () => {
    storageService.savePRs([seedPr()]);
    const fetchMock = useCloudflare(async () => jsonRes({ success: true, id: 'PR-BUF-1', pr: { id: 'PR-BUF-1', status: 'REVIEWED' } }));
    await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', buffer, 'โอเค');
    expect(JSON.parse(putCalls(fetchMock)[0][1].body).bufferComment).toBe('โอเค');
  });

  it('a failed write (HTTP 409) throws and leaves the PR as it was', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    useCloudflare(async () => jsonRes({ error: 'เอกสารถูกแก้ไขโดยผู้อื่น' }, false, 409));
    await expect(apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok')).rejects.toThrow();
    expect(stored().status).toBe('SUBMITTED');
  });

  it('mock mode (no server) : REVIEWED is final and the approver is notified exactly once', async () => {
    storageService.savePRs([seedPr({ status: 'SUBMITTED' })]);
    const result = await apiService.updatePRStatus('PR-BUF-1', 'REVIEWED', reviewer, 'ok');
    expect(result.pr.status).toBe('REVIEWED');
    expect(result.finalStatus).toBe('REVIEWED');
    expect(types().filter(t => t === 'PR_REVIEWED')).toHaveLength(1);
  });

  it('approving a PR that is still at PENDING_BUFFER is refused', async () => {
    storageService.savePRs([seedPr()]);
    await expect(workflowEngine.updatePRStatus('PR-BUF-1', 'APPROVED', approver, '')).rejects.toThrow();
  });
});

describe('editPRItems : link + totals + permission', () => {
  const withFinancials = () => seedPr({
    totalAmount: 240.75,
    financials: {
      subtotal: 250, itemDiscountTotal: 0, combinedDiscountType: 'percent', combinedDiscountValue: 10, combinedDiscountAmount: 25,
      totalDiscount: 25, vatMode: 'AFTER_DISCOUNT', vatAmount: 15.75, roundingAdj: 0, shippingCost: 0, grandTotal: 240.75
    }
  });
  const editedItems = (pr) => pr.items.map(it => (it.id === 'I1'
    ? { ...it, purchaseQty: 4, qty: 4, productUrl: 'https://www.lazada.co.th/new' }
    : { ...it, price: 60 }));

  it('BUFFER edits qty / price / link at PENDING_BUFFER ; totalAmount and financials follow the PR\'s own discount + VAT', async () => {
    storageService.savePRs([withFinancials()]);
    const out = await workflowEngine.editPRItems('PR-BUF-1', editedItems(withFinancials()), buffer, 'ปรับตามราคาจริง');

    const i1 = out.items.find(i => i.id === 'I1');
    expect(i1.purchaseQty).toBe(4);
    expect(i1.total).toBe(400);
    expect(i1.productUrl).toBe('https://www.lazada.co.th/new');
    expect(i1.onlineUrl).toBe('https://www.lazada.co.th/new'); // every url key kept in step
    expect(out.items.find(i => i.id === 'I2').total).toBe(60);
    // subtotal 460 ; 10% = 46 ; net 414 ; VAT 7% = 28.98 ; grand 442.98
    expect(out.financials.subtotal).toBe(460);
    expect(out.financials.combinedDiscountAmount).toBeCloseTo(46, 2);
    expect(out.financials.vatAmount).toBeCloseTo(28.98, 2);
    expect(out.financials.grandTotal).toBeCloseTo(442.98, 2);
    expect(out.totalAmount).toBeCloseTo(442.98, 2);
    expect(out.status).toBe('PENDING_BUFFER'); // editing does not move the PR
  });

  it('the activity log shows the before -> after values (qty, price, link) and the total', async () => {
    storageService.savePRs([withFinancials()]);
    const out = await workflowEngine.editPRItems('PR-BUF-1', editedItems(withFinancials()), buffer, 'ปรับตามราคาจริง');
    const log = out.activityLog.at(-1);
    expect(log.action).toContain('Buffer Item Edit');
    expect(log.note).toContain('จำนวน 2 → 4');
    expect(log.note).toContain('ราคา 50 → 60');
    expect(log.note).toContain('https://shopee.co.th/a → https://www.lazada.co.th/new');
    expect(log.note).toContain('ปรับตามราคาจริง');
  });

  it('the other names a line already carries for its qty / price follow the edit (the server refuses a line whose names disagree : kla round 3)', async () => {
    storageService.savePRs([seedPr()]);
    const items = seedPr().items.map(it => (it.id === 'I1'
      ? { ...it, quantity: 2, orderedQty: 2, unitPrice: 50, estimatedPrice: 50, purchaseQty: 5, qty: 5, price: 70 }
      : it));
    const out = await workflowEngine.editPRItems('PR-BUF-1', items, buffer, '');
    const i1 = out.items.find(i => i.id === 'I1');
    expect([i1.purchaseQty, i1.qty, i1.quantity, i1.orderedQty]).toEqual([5, 5, 5, 5]);
    expect([i1.price, i1.unitPrice, i1.estimatedPrice]).toEqual([70, 70, 70]);
    // a name the line does not carry is not invented
    const i2 = out.items.find(i => i.id === 'I2');
    expect('quantity' in i2).toBe(false);
    expect('unitPrice' in i2).toBe(false);
  });

  it('a PR without financials just sums the rows ; clearing the link clears every url key', async () => {
    storageService.savePRs([seedPr()]);
    const items = seedPr().items.map(it => (it.id === 'I1' ? { ...it, productUrl: '', purchaseQty: 3, qty: 3 } : it));
    const out = await workflowEngine.editPRItems('PR-BUF-1', items, buffer, '');
    expect(out.totalAmount).toBe(350);
    expect(out.financials).toBeUndefined();
    const i1 = out.items.find(i => i.id === 'I1');
    expect(i1.productUrl).toBe('');
    expect(i1.onlineUrl).toBe('');
  });

  it('only http / https links are accepted (a bare domain gets https://)', async () => {
    storageService.savePRs([seedPr()]);
    const bad = seedPr().items.map(it => (it.id === 'I1' ? { ...it, productUrl: 'javascript:alert(1)' } : it));
    await expect(workflowEngine.editPRItems('PR-BUF-1', bad, buffer, '')).rejects.toThrow();
    const bare = seedPr().items.map(it => (it.id === 'I1' ? { ...it, productUrl: 'shopee.co.th/x' } : it));
    const out = await workflowEngine.editPRItems('PR-BUF-1', bare, buffer, '');
    expect(out.items.find(i => i.id === 'I1').productUrl).toBe('https://shopee.co.th/x');
  });

  it('at PENDING_BUFFER only BUFFER and admin may edit (reviewer level 2 / approver / requester may not)', async () => {
    for (const actor of [reviewer, approver, requester]) {
      storageService.savePRs([seedPr()]);
      await expect(workflowEngine.editPRItems('PR-BUF-1', seedPr().items, actor, '')).rejects.toThrow();
    }
    storageService.savePRs([seedPr()]);
    await expect(workflowEngine.editPRItems('PR-BUF-1', seedPr().items, admin, '')).resolves.toBeTruthy();
  });

  it('other statuses : the old rule (level >= 2) holds, BUFFER is cut out', async () => {
    for (const status of ['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2']) {
      storageService.savePRs([seedPr({ status })]);
      await expect(workflowEngine.editPRItems('PR-BUF-1', seedPr().items, buffer, '')).rejects.toThrow();
      storageService.savePRs([seedPr({ status })]);
      await expect(workflowEngine.editPRItems('PR-BUF-1', seedPr().items, reviewer, '')).resolves.toBeTruthy();
    }
    storageService.savePRs([seedPr({ status: 'APPROVED' })]);
    await expect(workflowEngine.editPRItems('PR-BUF-1', seedPr().items, admin, '')).rejects.toThrow();
  });
});

describe('getUserTasks routing for PENDING_BUFFER', () => {
  const prs = [seedPr({ activityLog: [{ action: 'ตรวจสอบแล้ว', user: reviewer.name, role: 'Reviewer PD', timestamp: 't' }] })];
  const ids = (list) => list.map(t => t.id);

  it('BUFFER sees it in To-Do (any department)', () => {
    expect(ids(workflowEngine.getUserTasks(buffer, prs, []).action)).toEqual(['PR-BUF-1']);
    expect(ids(workflowEngine.getUserTasks(bufferMgt, [seedPr({ department: 'QC' })], []).action)).toEqual(['PR-BUF-1']);
  });

  it('reviewer and requester see it under "รอผู้อื่น" ; approver follows it as in progress, never as To-Do', () => {
    const rev = workflowEngine.getUserTasks(reviewer, prs, []);
    expect(rev.action).toHaveLength(0);
    expect(ids(rev.waiting)).toEqual(['PR-BUF-1']);

    const req = workflowEngine.getUserTasks(requester, prs, []);
    expect(req.action).toHaveLength(0);
    expect(ids(req.waiting)).toEqual(['PR-BUF-1']);

    const app = workflowEngine.getUserTasks(approver, prs, []);
    expect(app.action).toHaveLength(0);
    expect(ids(app.waiting)).toEqual(['PR-BUF-1']);
  });

  it('REVIEWED stays the approver\'s To-Do and out of the BUFFER user\'s To-Do', () => {
    const reviewed = [seedPr({ status: 'REVIEWED' })];
    expect(ids(workflowEngine.getUserTasks(approver, reviewed, []).action)).toEqual(['PR-BUF-1']);
    expect(workflowEngine.getUserTasks(buffer, reviewed, []).action).toHaveLength(0);
  });
});

describe('workspaceService routing for PENDING_BUFFER', () => {
  const task = { ...seedPr(), docType: 'PR' };

  it('isTaskForMe : BUFFER (and admin) only', () => {
    expect(isTaskForMe(task, buffer)).toBe(true);
    expect(isTaskForMe(task, bufferMgt)).toBe(true);
    expect(isTaskForMe(task, admin)).toBe(true);
    expect(isTaskForMe(task, reviewer)).toBe(false);
    expect(isTaskForMe(task, approver)).toBe(false);
    expect(isTaskForMe(task, requester)).toBe(false);
  });

  it('isInProgressTask : reviewer, approver and requester follow it ; BUFFER has it as To-Do instead', () => {
    expect(isInProgressTask(task, reviewer, [], [])).toBe(true);
    expect(isInProgressTask(task, reviewerQC, [], [])).toBe(false); // another department
    expect(isInProgressTask(task, approver, [], [])).toBe(true);
    expect(isInProgressTask(task, requester, [], [])).toBe(true);
    expect(isInProgressTask(task, buffer, [], [])).toBe(false);
    expect(isInProgressTask(task, online, [], [])).toBe(false);
  });

  it('BUFFER sees the workspace documents of every department ; a level 2 reviewer only his own', () => {
    const qcDoc = { ...seedPr({ department: 'QC' }), docType: 'PR' };
    const pdBuffer = { roleId: 'BUFFER', level: 2, department: 'PD', departments: ['PD'], name: 'พี่สุ' };
    expect(canSeeWorkspaceDocument(qcDoc, pdBuffer)).toBe(true);
    expect(canSeeWorkspaceDocument(qcDoc, { roleId: 'ASST_MANAGER', level: 2, department: 'PD', departments: ['PD'], name: 'x' })).toBe(false);
  });

  it('the BUFFER user who forwarded a PR is a stakeholder of it afterwards', () => {
    const doc = { ...seedPr({ status: 'REVIEWED' }), bufferReviewedById: 'USR-BUF', bufferReviewedBy: 'พี่สุ' };
    expect(isUserStakeholder(doc, { id: 'USR-BUF', name: 'พี่สุ', roleId: 'BUFFER', level: 2 })).toBe(true);
    expect(isUserStakeholder(doc, { id: 'USR-OTHER', name: 'ใครสักคน', roleId: 'REQUESTER_QC', level: 1 })).toBe(false);
  });
});

describe('notificationService audience', () => {
  const approverNoti = { type: 'PR_REVIEWED', department: 'PD', targetRoles: ['PLANT_MANAGER', 'ADMIN'] };
  const reviewerNoti = { type: 'PR_SUBMITTED', department: 'PD', targetRoles: ['ASST_MANAGER', 'ADMIN'] };
  const bufferNoti = { type: 'PR_PENDING_BUFFER', department: 'PD', targetRoles: ['BUFFER', 'ADMIN'] };
  const target = (n, who) => notificationService.isNotificationTarget(n, who);

  it('BUFFER (even filed under MGT) does not see approver / reviewer notifications', () => {
    expect(target(approverNoti, buffer)).toBe(false);
    expect(target(approverNoti, bufferMgt)).toBe(false);
    expect(target(reviewerNoti, buffer)).toBe(false);
    expect(target(reviewerNoti, bufferMgt)).toBe(false);
    expect(target({ ...approverNoti, targetRoles: undefined, targetRole: 'Approver' }, bufferMgt)).toBe(false);
  });

  it('the reviewer / approver / admin audiences are unchanged', () => {
    expect(target(approverNoti, approver)).toBe(true);
    expect(target(approverNoti, admin)).toBe(true);
    expect(target(reviewerNoti, reviewer)).toBe(true);
    expect(target(approverNoti, reviewer)).toBe(true); // legacy level >= 2 fallback for a real reviewer
  });

  it('PR_PENDING_BUFFER reaches BUFFER and admin only', () => {
    expect(target(bufferNoti, buffer)).toBe(true);
    expect(target(bufferNoti, bufferMgt)).toBe(true);
    expect(target(bufferNoti, admin)).toBe(true);
    expect(target(bufferNoti, reviewer)).toBe(false);
    expect(target(bufferNoti, approver)).toBe(false);
    expect(target(bufferNoti, requester)).toBe(false);
  });
});
