// @vitest-environment jsdom
// QA (prae) for M10 T4 + T5 + T6 (FR-01 role "พี่สุ" BUFFER, status PENDING_BUFFER) - client side.
// Extra cases on top of buffer_constants / buffer_workflow / pr_details_buffer :
//   (1) readSavedPrOutcome with the REAL server answer shapes (PUT has NO pr object) + rollback when the PUT fails
//   (2) editPRItems financials vs the server formula (functions/api/[[route]].js prExpectedAmounts, copied below)
//   (3) buttons / permissions with the REAL login-session shape (resolveUserPermissions + canonicalRole REQUESTER)
//   (4) notification audience  (5) save-then-forward through the real engine + fetch  (6) link checks + safe href
//   (7) success text by final status  (8) user forms with role BUFFER  (9) To-Do / badge counts
// Tests named BUG-n are expected to FAIL today : they pin a defect found by reading the code (see the QA report).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

const { mockCtx, mockModal } = vi.hoisted(() => ({
  mockCtx: { value: {} },
  mockModal: {
    confirm: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    alert: vi.fn(),
    prompt: vi.fn()
  }
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return { ...actual, createPortal: (node) => node };
});

vi.mock('../src/context/AppContext', async () => {
  const actual = await vi.importActual('../src/context/AppContext');
  return { ...actual, useAppContext: () => mockCtx.value };
});

vi.mock('../src/services/modalService', () => ({ modalService: mockModal }));

import { ROLES, PR_STATUS, resolveUserPermissions } from '../src/config/constants';
import { workflowEngine } from '../src/services/workflowEngine';
import { apiService } from '../src/services/apiService';
import { storageService } from '../src/services/storageService';
import { notificationService, NOTIFICATION_TYPES } from '../src/services/notificationService';
import { getProductUrl } from '../src/utils/urlHelper';
import PRDetailsModal from '../src/components/pr/PRDetailsModal';
import UserMasterView from '../src/views/admin/UserMasterView.jsx';
import UserCRUDModal from '../src/components/admin/UserCRUDModal.jsx';

// ───────────── actors : the shapes a real login session has (authService spreads resolveUserPermissions) ─────────────
const bufferSession = {
  ...resolveUserPermissions({ roleId: 'BUFFER', level: 2, department: 'MGT', departments: ['*'], name: 'พี่สุ', title: 'ผู้ตรวจสอบจัดซื้อ (พี่สุ)' }),
  canonicalRole: 'REQUESTER', // AuthContext.normalizeRole('BUFFER') answers REQUESTER
  userId: 'U-BF'
};
const reviewerPD = {
  ...resolveUserPermissions({ roleId: 'ASST_MANAGER', level: 2, department: 'PD', departments: ['PD'], name: 'ผู้ตรวจ PD', title: 'Asst PD' }),
  canonicalRole: 'REVIEWER'
};
const approver = {
  ...resolveUserPermissions({ roleId: 'PLANT_MANAGER', level: 3, department: 'MGT', departments: ['*'], name: 'ผู้จัดการโรงงาน', title: 'Plant Manager' }),
  canonicalRole: 'APPROVER'
};
const requester = {
  ...resolveUserPermissions({ roleId: 'REQUESTER_PD', level: 1, department: 'PD', departments: ['PD'], name: 'คุณวิชัย (PD)', title: 'Requester PD' }),
  canonicalRole: 'REQUESTER'
};
const admin = { ...ROLES.ADMIN, roleId: 'ADMIN' };

const BTN_FORWARD = 'บันทึกการแก้ไขและส่งต่อผู้อนุมัติ';
const BTN_REJECT = /ส่งกลับแก้ไข \(Reject\)/;
const BTN_CANCEL = 'ยกเลิกคำขอ';
const BTN_APPROVE = /อนุมัติสั่งซื้อ \(Approve/;
const BTN_REVIEW = 'ตรวจสอบผ่าน (ส่งต่อขั้นถัดไป)';
const BTN_EDIT_BUFFER = 'แก้ไขจำนวน/ราคา/ลิงก์';
const BTN_EDIT = 'แก้ไขจำนวน/ราคา';
const COMMENT_LABEL = 'บันทึกถึงผู้อนุมัติ (พี่สุ)';
const URL_LABEL = /ลิงก์สั่งซื้อออนไลน์ รายการที่/;
const ID = 'PR-QA-1';

const seedPr = (over = {}) => ({
  id: ID, prNo: 'PD001/2026', department: 'PD', status: 'PENDING_BUFFER', purchaseChannel: 'ONLINE',
  requestedBy: 'คุณวิชัย (PD)', requestedDate: '2026-10-17', totalAmount: 250,
  items: [
    { id: 'I1', code: 'C1', name: 'ถุงมือ', purchaseQty: 2, qty: 2, price: 100, total: 200, purchaseUnit: 'กล่อง', stockUnit: 'กล่อง', conversionRate: 1, stockQty: 2, productUrl: 'https://shopee.co.th/a', onlineUrl: 'https://shopee.co.th/a' },
    { id: 'I2', code: 'C2', name: 'เทป', purchaseQty: 1, qty: 1, price: 50, total: 50, purchaseUnit: 'ม้วน', stockUnit: 'ม้วน', conversionRate: 1, stockQty: 1 }
  ],
  activityLog: [], approvalHistory: [],
  ...over
});

const jsonRes = (body, ok = true, status = 200) => {
  const res = { ok, status, json: async () => body };
  res.clone = () => res;
  return res;
};
const stored = (id = ID) => storageService.getPRs().find((p) => p.id === id);
const seedStored = (over) => storageService.savePRs([seedPr(over)]);
const types = () => notificationService.getAll().map((n) => n.type);

const goCloudflare = (impl) => {
  vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
  const fetchMock = vi.fn(impl || (async () => jsonRes({})));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const prPuts = (fetchMock) => fetchMock.mock.calls.filter(([url, init]) => init && init.method === 'PUT' && String(url).startsWith('/api/prs/'));
const bodyOf = (call) => JSON.parse(call[1].body);

const onClose = vi.fn();
const onRefresh = vi.fn();

// the context handlers of AppContext (handleReviewPR / handleBufferForwardPR) without the React state part
const realCtx = (role) => ({
  prs: [], pos: [], products: [], budgetSummary: { current: {} }, // budgetSummary : the modal's cloudflare budget check needs no real data
  reviewPR: (id, note = '') => apiService.updatePRStatus(id, 'REVIEWED', role, note),
  bufferForwardPR: (id, comment = '') => {
    const text = String(comment ?? '').trim();
    return apiService.updatePRStatus(id, 'REVIEWED', role, text, { bufferComment: text });
  },
  rejectPR: vi.fn().mockResolvedValue({}),
  cancelPR: vi.fn().mockResolvedValue(true)
});

const open = (pr, role, ctx) => {
  mockCtx.value = ctx || realCtx(role);
  return render(
    <MemoryRouter>
      <PRDetailsModal selectedPR={pr} currentRole={role} onClose={onClose} onRefresh={onRefresh} />
    </MemoryRouter>
  );
};
const hasBtn = (name) => screen.queryByRole('button', { name }) !== null;

beforeEach(() => {
  localStorage.clear();
  storageService.resetData();
  notificationService.clearAll();
  Object.values(mockModal).forEach((fn) => fn.mockReset());
  mockModal.confirm.mockResolvedValue(true);
  onClose.mockReset();
  onRefresh.mockReset();
  mockCtx.value = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ═══════════════════════════ T4 : constants with the real session shape ═══════════════════════════
describe('T4 constants : BUFFER session shape', () => {
  it('resolveUserPermissions(BUFFER) : level 2, not a reviewer / approver / budget setter, sees every department and the budget', () => {
    expect(bufferSession).toMatchObject({
      id: 'BUFFER', level: 2, isBuffer: true, canReview: false, canFinalApprove: false, canSetBudget: false,
      canViewAllDepts: true, canViewBudget: true, canViewBudgetMenu: true, canOnlinePurchase: false, canCreatePR: true
    });
    // role_id spelling and a plain level-2 reviewer stay as before
    expect(resolveUserPermissions({ role_id: 'BUFFER', level: 2, department: 'MGT' })).toMatchObject({ isBuffer: true, canReview: false });
    expect(reviewerPD).toMatchObject({ isBuffer: false, canReview: true, canFinalApprove: false });
    expect(approver).toMatchObject({ isBuffer: false, canReview: true, canFinalApprove: true, canSetBudget: true });
  });

  it('PR_STATUS / ROLES / notification type know the new values', () => {
    expect(PR_STATUS.PENDING_BUFFER.label).toBe('รอพี่สุตรวจสอบ');
    expect(ROLES.BUFFER).toMatchObject({ level: 2, isBuffer: true, canReview: false, canFinalApprove: false, canSetBudget: false });
    expect(NOTIFICATION_TYPES.PR_PENDING_BUFFER).toBeTruthy();
  });
});

// ═══════════════════════════ (3) permissions with the login-session shape ═══════════════════════════
describe('(3) canAction / canCancelPR / editPRItems per role - session shapes, old statuses unchanged', () => {
  const at = (status) => seedPr({ status });

  it('PENDING_BUFFER : forward = BUFFER + admin ; send back / cancel = reviewer + approver + admin ; nobody else', () => {
    const pr = at('PENDING_BUFFER');
    expect(workflowEngine.canAction(bufferSession, pr)).toBe(true);
    expect(workflowEngine.canAction(admin, pr)).toBe(true);
    for (const u of [reviewerPD, approver, requester]) expect(workflowEngine.canAction(u, pr)).toBe(false);
    for (const u of [reviewerPD, approver, admin]) expect(workflowEngine.canCancelPR(u, pr)).toBe(true);
    for (const u of [bufferSession, requester]) expect(workflowEngine.canCancelPR(u, pr)).toBe(false);
  });

  it('SUBMITTED / REVIEWED / APPROVED : the old table, BUFFER gets nothing', () => {
    expect(workflowEngine.canAction(reviewerPD, at('SUBMITTED'))).toBe(true);
    expect(workflowEngine.canAction(bufferSession, at('SUBMITTED'))).toBe(false);
    expect(workflowEngine.canAction(approver, at('REVIEWED'))).toBe(true);
    expect(workflowEngine.canAction(admin, at('REVIEWED'))).toBe(true);
    expect(workflowEngine.canAction(reviewerPD, at('REVIEWED'))).toBe(false);
    expect(workflowEngine.canAction(bufferSession, at('REVIEWED'))).toBe(false);
    expect(workflowEngine.canCancelPR(approver, at('REVIEWED'))).toBe(true);
    expect(workflowEngine.canCancelPR(bufferSession, at('REVIEWED'))).toBe(false);
    for (const status of ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE']) {
      for (const u of [bufferSession, reviewerPD, approver]) {
        expect(workflowEngine.canAction(u, at(status)), `${status}`).toBe(false);
        expect(workflowEngine.canCancelPR(u, at(status)), `${status}`).toBe(false);
      }
    }
  });

  it('editPRItems : BUFFER edits only at PENDING_BUFFER ; reviewer cannot edit there ; reviewer / approver keep SUBMITTED / REVIEWED', async () => {
    storageService.savePRs([at('PENDING_BUFFER')]);
    await expect(workflowEngine.editPRItems(ID, seedPr().items, reviewerPD, 'x')).rejects.toThrow();
    await expect(workflowEngine.editPRItems(ID, seedPr().items, approver, 'x')).rejects.toThrow();
    await expect(workflowEngine.editPRItems(ID, seedPr().items, bufferSession, 'x')).resolves.toBeTruthy();
    for (const status of ['SUBMITTED', 'REVIEWED']) {
      storageService.savePRs([at(status)]);
      await expect(workflowEngine.editPRItems(ID, seedPr().items, bufferSession, 'x'), status).rejects.toThrow();
    }
    storageService.savePRs([at('SUBMITTED')]);
    await expect(workflowEngine.editPRItems(ID, seedPr().items, reviewerPD, 'x')).resolves.toBeTruthy();
    storageService.savePRs([at('REVIEWED')]);
    await expect(workflowEngine.editPRItems(ID, seedPr().items, approver, 'x')).resolves.toBeTruthy();
  });
});

describe('(3) PRDetailsModal buttons with the session shape (canonicalRole REQUESTER for BUFFER)', () => {
  it('BUFFER session at PENDING_BUFFER : forward + comment + edit only', () => {
    open(seedPr(), bufferSession);
    expect(hasBtn(BTN_FORWARD)).toBe(true);
    expect(screen.getByLabelText(COMMENT_LABEL)).toBeTruthy();
    expect(hasBtn(BTN_EDIT_BUFFER)).toBe(true);
    for (const t of [BTN_REJECT, BTN_CANCEL, BTN_REVIEW, BTN_APPROVE]) expect(screen.queryByText(t)).toBeNull();
  });

  it('old PR at REVIEWED : approver + admin keep approve / reject / cancel / edit ; reviewer and requester get no action button', () => {
    const pr = seedPr({ status: 'REVIEWED' });
    for (const u of [approver, admin]) {
      open(pr, u);
      expect(screen.getByText(BTN_APPROVE)).toBeTruthy();
      expect(screen.getByText(BTN_REJECT)).toBeTruthy();
      expect(screen.getByText(BTN_CANCEL)).toBeTruthy();
      expect(screen.getByText(BTN_EDIT)).toBeTruthy();
      cleanup();
    }
    for (const u of [reviewerPD, requester]) {
      open(pr, u);
      expect(screen.queryByText(BTN_APPROVE)).toBeNull();
      expect(screen.queryByText(BTN_REJECT)).toBeNull();
      expect(screen.queryByText(BTN_CANCEL)).toBeNull();
      cleanup();
    }
  });

  it('old PR at APPROVED / PO_ISSUED : no workflow button for approver, reviewer or BUFFER', () => {
    for (const status of ['APPROVED', 'PO_ISSUED']) {
      for (const u of [approver, reviewerPD, bufferSession]) {
        open(seedPr({ status }), u);
        for (const t of [BTN_APPROVE, BTN_REJECT, BTN_CANCEL, BTN_REVIEW]) expect(screen.queryByText(t), `${status}`).toBeNull();
        expect(hasBtn(BTN_FORWARD)).toBe(false);
        cleanup();
      }
    }
  });

  it('PENDING_BUFFER : a reviewer of ANOTHER department gets no reject / cancel', () => {
    const reviewerQC = { ...reviewerPD, department: 'QC', departments: ['QC'], assignedDepartments: ['QC'], allowedDepartments: ['QC'] };
    open(seedPr(), reviewerQC);
    expect(screen.queryByText(BTN_REJECT)).toBeNull();
    expect(screen.queryByText(BTN_CANCEL)).toBeNull();
  });
});

// ═══════════════════════════ (1) readSavedPrOutcome : real answer shapes ═══════════════════════════
describe('(1) updatePRStatus follows the status in the real server answer (cloudflare)', () => {
  it('PUT answer { success, id, status } (NO pr object) -> PENDING_BUFFER is applied to the result, state copy and localStorage', async () => {
    seedStored({ status: 'SUBMITTED' });
    const fm = goCloudflare(async () => jsonRes({ success: true, id: ID, status: 'PENDING_BUFFER' }));
    const r = await apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, 'ok');
    expect(prPuts(fm)).toHaveLength(1);
    expect(bodyOf(prPuts(fm)[0]).status).toBe('REVIEWED'); // the client asks, the server decides
    expect(r).toMatchObject({ finalStatus: 'PENDING_BUFFER', bufferSkipped: false, successMessage: 'ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว' });
    expect(r.pr.status).toBe('PENDING_BUFFER');
    expect(r.pr.workflowStatus).toBe('PENDING_BUFFER');
    expect(stored().status).toBe('PENDING_BUFFER');
    expect(stored().workflowStatus).toBe('PENDING_BUFFER');
    expect(types()).not.toContain('PR_REVIEWED');
    expect(types()).not.toContain('PR_PENDING_BUFFER'); // the server raises this one itself
  });

  it('PUT answer { status: REVIEWED, bufferSkipped: true } -> REVIEWED + "ส่งต่อ Plant Mgr แล้ว" + approver notified', async () => {
    seedStored({ status: 'SUBMITTED' });
    goCloudflare(async () => jsonRes({ success: true, id: ID, status: 'REVIEWED', bufferSkipped: true }));
    const r = await apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, 'ok');
    expect(r).toMatchObject({ finalStatus: 'REVIEWED', bufferSkipped: true, successMessage: 'ส่งต่อ Plant Mgr แล้ว' });
    expect(stored()).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    expect(types()).toContain('PR_REVIEWED');
  });

  it('POST-style answer : the PR itself with status / bufferSkipped on the top level, and { pr, status } together', async () => {
    seedStored({ status: 'SUBMITTED' });
    goCloudflare(async () => jsonRes({ ...seedPr({ status: 'SUBMITTED' }), status: 'PENDING_BUFFER', bufferSkipped: false }));
    const bare = await apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, '');
    expect(bare.finalStatus).toBe('PENDING_BUFFER');
    expect(stored().status).toBe('PENDING_BUFFER');
    cleanup();
    seedStored({ status: 'SUBMITTED' });
    goCloudflare(async () => jsonRes({ success: true, id: ID, pr: { id: ID, status: 'PENDING_BUFFER' }, status: 'PENDING_BUFFER', bufferSkipped: false }));
    const both = await apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, '');
    expect(both.finalStatus).toBe('PENDING_BUFFER');
  });

  it('an answer without a usable status (empty object / non-JSON / no clone()) never throws and falls back to what was sent', async () => {
    const shapes = [
      async () => jsonRes({ success: true }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } }),
      async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) // no clone()
    ];
    for (const impl of shapes) {
      seedStored({ status: 'SUBMITTED' });
      goCloudflare(impl);
      const r = await apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, '');
      expect(r.finalStatus).toBe('REVIEWED');
      expect(r.bufferSkipped).toBe(false);
      expect(stored().status).toBe('REVIEWED');
      vi.unstubAllGlobals();
    }
  });

  it('a failing PUT (500) throws, nothing is half-applied locally (status, reviewer stamp, log) and no notification is raised', async () => {
    seedStored({ status: 'SUBMITTED' });
    goCloudflare(async () => jsonRes({ error: 'boom' }, false, 500));
    await expect(apiService.updatePRStatus(ID, 'REVIEWED', reviewerPD, 'ok')).rejects.toThrow();
    expect(stored().status).toBe('SUBMITTED');
    expect(stored().reviewedBy).toBeUndefined();
    expect(types()).not.toContain('PR_REVIEWED');
  });
});

// ═══════════════════════════ (7) BUFFER forward through the engine ═══════════════════════════
describe('(7) BUFFER forward : body, stamps, message', () => {
  it('sends the trimmed comment as bufferComment, keeps the reviewer stamp, answer REVIEWED -> "ส่งต่อ Plant Mgr แล้ว"', async () => {
    seedStored({ status: 'PENDING_BUFFER', reviewedBy: { id: 'U2', name: 'ผู้ตรวจ PD' } });
    const fm = goCloudflare(async () => jsonRes({ success: true, id: ID, status: 'REVIEWED' }));
    const r = await apiService.updatePRStatus(ID, 'REVIEWED', bufferSession, '  ราคาตรง  ', { bufferComment: '  ราคาตรง  ' });
    const body = bodyOf(prPuts(fm)[0]);
    expect(body.status).toBe('REVIEWED');
    expect(body.bufferComment).toBe('ราคาตรง');
    expect(body.reviewedBy.name).toBe('ผู้ตรวจ PD');
    expect(r).toMatchObject({ finalStatus: 'REVIEWED', successMessage: 'ส่งต่อ Plant Mgr แล้ว', isBufferForward: true });
    expect(stored().status).toBe('REVIEWED');
    expect(stored().bufferReviewedBy).toBe('พี่สุ');
    expect(types()).toContain('PR_REVIEWED');
  });

  it('an explicit empty bufferComment is kept empty (it does not fall back to the note)', async () => {
    seedStored({ status: 'PENDING_BUFFER' });
    const fm = goCloudflare(async () => jsonRes({ success: true, id: ID, status: 'REVIEWED' }));
    await apiService.updatePRStatus(ID, 'REVIEWED', bufferSession, 'note', { bufferComment: '' });
    expect(bodyOf(prPuts(fm)[0]).bufferComment).toBe('');
  });
});

// ═══════════════════════════ (2) editPRItems financials vs the server formula ═══════════════════════════
// Copy of functions/api/[[route]].js prLineDiscount + prExpectedAmounts + the acceptance test of prBufferEdit (M10 hardening : ONE formula chosen from the stored line -
// discountPercent > 0 -> round2(qty x price x pct / 100), else min(stored discountAmount, qty x price) ; +/- 0.01).
const lineQty = (it) => Number(it && (it.purchaseQty ?? it.qty ?? it.quantity ?? 1));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function prLineDiscount(s, qty, price) {
  const gross = qty * price;
  const pct = parseFloat(s.discountPercent) || 0;
  const raw = pct > 0 ? r2(gross * (pct / 100)) : (parseFloat(s.discountAmount) || 0);
  return Math.min(gross, Math.max(0, raw));
}
function prExpectedAmounts(lines, storedLines, fin) {
  const f = fin && typeof fin === 'object' ? fin : {};
  let subtotal = 0; let itemDisc = 0;
  lines.forEach((it, i) => {
    const s = storedLines[i] || {};
    const amount = lineQty(it) * (parseFloat(it.price) || 0);
    subtotal += amount;
    itemDisc += prLineDiscount(s, lineQty(it), parseFloat(it.price) || 0);
  });
  const net = Math.max(0, subtotal - itemDisc);
  const cType = f.combinedDiscountType || 'fixed';
  const cValue = parseFloat(f.combinedDiscountValue) || 0;
  const cAmount = cType === 'percent' ? net * (cValue / 100) : cValue;
  const totalDiscount = itemDisc + cAmount;
  const netAll = Math.max(0, subtotal - totalDiscount);
  const vatMode = f.vatMode || 'NONE';
  const vatOn = vatMode !== 'NONE' && !((parseFloat(f.vatAmount) || 0) === 0 && (parseFloat(f.subtotal) || 0) > 0);
  const vatBase = vatMode === 'BEFORE_DISCOUNT' ? subtotal : netAll;
  const vatAmount = vatOn ? (parseFloat((vatBase * 0.07).toFixed(2)) || 0) : 0;
  const rounding = parseFloat(f.roundingAdj) || 0;
  const shipping = parseFloat(f.shippingCost) || 0;
  const grandTotal = vatMode === 'BEFORE_DISCOUNT'
    ? parseFloat((subtotal + vatAmount - totalDiscount + rounding + shipping).toFixed(2))
    : parseFloat((netAll + vatAmount + rounding + shipping).toFixed(2));
  return { subtotal, itemDiscountTotal: itemDisc, combinedDiscountAmount: cAmount, totalDiscount, vatAmount, grandTotal };
}

// would the server accept this PUT body (items changed) for the stored PR ?
const serverVerdict = (sent, storedBefore) => {
  const exp = [prExpectedAmounts(sent.items, storedBefore.items, storedBefore.financials)];
  const hit = exp.find((e) => Math.abs(e.grandTotal - Number(sent.totalAmount)) <= 0.01);
  const fg = sent.financials && typeof sent.financials === 'object' ? sent.financials.grandTotal : undefined;
  const financialsOk = fg === undefined || fg === null || (Boolean(hit) && Math.abs(Number(fg) - hit.grandTotal) <= 0.01);
  return { accepted: Boolean(hit) && financialsOk, exp, hit };
};

const ITEM = ({ id, q, p, pct = 0, disc = 0, over = {} }) => {
  const gross = q * p;
  const discountAmount = pct > 0 ? parseFloat((gross * (pct / 100)).toFixed(2)) : disc; // PRCreateView.jsx:726
  return {
    id, code: id, productId: id, name: `สินค้า ${id}`, purchaseQty: q, qty: q, price: p, purchaseUnit: 'ชิ้น', stockUnit: 'ชิ้น',
    conversionRate: 1, stockQty: q, discountPercent: pct, discountAmount, total: Math.max(0, gross - discountAmount), ...over
  };
};
// complete a partial financials object the way createPR does, using the server formula so the stored PR is self-consistent
const completeFin = (items, partial) => {
  const e = prExpectedAmounts(items, items, partial);
  return { ...partial, subtotal: e.subtotal, itemDiscountTotal: e.itemDiscountTotal, combinedDiscountAmount: e.combinedDiscountAmount, totalDiscount: e.totalDiscount, vatAmount: e.vatAmount, grandTotal: e.grandTotal };
};
const mkStored = (items, finPartial) => {
  const financials = finPartial ? completeFin(items, finPartial) : undefined;
  const totalAmount = financials ? financials.grandTotal : items.reduce((s, it) => s + Math.max(0, it.purchaseQty * it.price - it.discountAmount), 0);
  return { ...seedPr(), items, financials, totalAmount };
};
// run the buffer's edit through the real engine, then ask the server model
const edit = async (pr, mutate) => {
  const before = JSON.parse(JSON.stringify(pr));
  storageService.savePRs([pr]);
  const out = await workflowEngine.editPRItems(ID, pr.items.map((it, i) => mutate({ ...it }, i)), bufferSession, 'ปรับตามใบเสนอราคา');
  return { out, before, verdict: serverVerdict(out, before) };
};
const setQP = (q, p) => (it) => ({ ...it, purchaseQty: q ?? it.purchaseQty, qty: q ?? it.qty, price: p ?? it.price });

describe('(2) editPRItems : totalAmount / financials.grandTotal match the server formula (else the server answers 400)', () => {
  it('no financials at all (online PR) : total = sum of lines, accepted', async () => {
    const { out, verdict } = await edit(mkStored([ITEM({ id: 'A', q: 2, p: 100 }), ITEM({ id: 'B', q: 1, p: 50 })]), (it, i) => (i === 0 ? setQP(3, 99.99)(it) : it));
    expect(out.totalAmount).toBeCloseTo(349.97, 2);
    expect(verdict.accepted).toBe(true);
  });

  it('fixed combined discount + shipping + rounding, no VAT', async () => {
    const pr = mkStored([ITEM({ id: 'A', q: 2, p: 100 }), ITEM({ id: 'B', q: 1, p: 50 })], { combinedDiscountType: 'fixed', combinedDiscountValue: 20, vatMode: 'NONE', roundingAdj: -0.5, shippingCost: 30 });
    const { out, verdict } = await edit(pr, (it, i) => (i === 0 ? setQP(3, 99.99)(it) : it));
    expect(out.totalAmount).toBeCloseTo(349.97 - 20 - 0.5 + 30, 2);
    expect(out.financials.grandTotal).toBe(out.totalAmount);
    expect(verdict.accepted).toBe(true);
  });

  it('percent combined discount + VAT 7% after discount + a fixed line discount + shipping + rounding', async () => {
    const items = [ITEM({ id: 'A', q: 10, p: 25.5, disc: 10 }), ITEM({ id: 'B', q: 3, p: 199.99 }), ITEM({ id: 'C', q: 1, p: 1234.56 })];
    const pr = mkStored(items, { combinedDiscountType: 'percent', combinedDiscountValue: 5, vatMode: 'AFTER_DISCOUNT', vatAmount: 1, roundingAdj: -0.25, shippingCost: 45.5 });
    const { out, verdict } = await edit(pr, (it, i) => [setQP(12, 24.75), setQP(2, null), setQP(null, 1200)][i](it));
    expect(out.financials.grandTotal).toBe(out.totalAmount);
    expect(out.financials.vatAmount).toBeGreaterThan(0);
    expect(verdict.accepted, JSON.stringify(verdict.exp)).toBe(true);
  });

  it('VAT 7% BEFORE discount with a fixed combined discount', async () => {
    const items = [ITEM({ id: 'A', q: 5, p: 80 }), ITEM({ id: 'B', q: 2, p: 120.4, disc: 15 })];
    const pr = mkStored(items, { combinedDiscountType: 'fixed', combinedDiscountValue: 20, vatMode: 'BEFORE_DISCOUNT', vatAmount: 1, roundingAdj: 0.3, shippingCost: 15 });
    const { out, verdict } = await edit(pr, (it, i) => (i === 0 ? setQP(7, 77.77)(it) : setQP(1, null)(it)));
    expect(out.financials.vatMode).toBe('BEFORE_DISCOUNT');
    expect(verdict.accepted, JSON.stringify(verdict.exp)).toBe(true);
  });

  it('a PR with VAT switched off (vatMode NONE) stays VAT free', async () => {
    const pr = mkStored([ITEM({ id: 'A', q: 2, p: 100 })], { combinedDiscountType: 'fixed', combinedDiscountValue: 0, vatMode: 'NONE', shippingCost: 10 });
    const { out, verdict } = await edit(pr, setQP(4, null));
    expect(out.financials.vatAmount).toBe(0);
    expect(out.totalAmount).toBeCloseTo(410, 2);
    expect(verdict.accepted).toBe(true);
  });

  it('line discount in percent with whole-cent results (10% of 4 x 25 -> 6 x 25)', async () => {
    const pr = mkStored([ITEM({ id: 'A', q: 4, p: 25, pct: 10 }), ITEM({ id: 'B', q: 1, p: 40 })], { combinedDiscountType: 'percent', combinedDiscountValue: 0, vatMode: 'AFTER_DISCOUNT', vatAmount: 1 });
    const { out, verdict } = await edit(pr, (it, i) => (i === 0 ? setQP(6, null)(it) : it));
    expect(out.items[0].discountAmount).toBe(15);
    expect(verdict.accepted, JSON.stringify(verdict.exp)).toBe(true);
  });

  it('a link-only edit : the total stays within 0.01 of the stored total (server branch "figures not changed")', async () => {
    const items = [ITEM({ id: 'A', q: 10, p: 25.5, disc: 10 }), ITEM({ id: 'B', q: 3, p: 199.99 })];
    const pr = mkStored(items, { combinedDiscountType: 'percent', combinedDiscountValue: 5, vatMode: 'AFTER_DISCOUNT', vatAmount: 1, shippingCost: 45.5 });
    const { out } = await edit(pr, (it, i) => (i === 0 ? { ...it, productUrl: 'https://shop.example/new' } : it));
    expect(Math.abs(out.totalAmount - pr.totalAmount)).toBeLessThanOrEqual(0.01);
    expect(out.items[0].productUrl).toBe('https://shop.example/new');
  });

  it('BUG-1 (medium) : a PR with several PERCENT line discounts that are not whole cents -> the server rejects the edit (400 "ยอดรวมไม่ตรง")', async () => {
    // 6 lines 1 x 10.10 at 5% (0.505 each) ; the buffer raises line 1 to 20.20.
    // client rounds EVERY line discount to the cent (workflowEngine.js:503) = 3.56 ; server pct mode keeps them unrounded (route:162) = 3.535 ;
    // server abs mode keeps the stored amounts = 3.06 -> neither mode lands within 0.01 of the client total.
    const items = Array.from({ length: 6 }, (_, i) => ITEM({ id: `L${i + 1}`, q: 1, p: 10.1, pct: 5 }));
    const { out, verdict } = await edit(mkStored(items), (it, i) => (i === 0 ? setQP(null, 20.2)(it) : it));
    expect(verdict.accepted, `client total ${out.totalAmount} ; server expects ${verdict.exp.map((e) => e.grandTotal).join(' / ')}`).toBe(true);
  });

  it('BUG-2 (low) : a fixed line discount larger than the line after the edit -> client clamps per line, server does not -> totals differ', async () => {
    // line A 2 x 100 with discount 150 ; the buffer lowers the price to 50 (gross 100 < 150)
    const { out, verdict } = await edit(mkStored([ITEM({ id: 'A', q: 2, p: 100, disc: 150 }), ITEM({ id: 'B', q: 1, p: 50 })]), (it, i) => (i === 0 ? setQP(null, 50)(it) : it));
    expect(verdict.accepted, `client total ${out.totalAmount} ; server expects ${verdict.exp.map((e) => e.grandTotal).join(' / ')}`).toBe(true);
  });
});

// ═══════════════════════════ (6) link rules ═══════════════════════════
describe('(6) product link : http(s) only before anything is sent, safe href on screen', () => {
  const editLink = async (typed, base = {}) => {
    storageService.savePRs([seedPr(base)]);
    const items = seedPr().items.map((it, i) => (i === 1 ? { ...it, productUrl: typed } : { ...it }));
    return workflowEngine.editPRItems(ID, items, bufferSession, 'เพิ่มลิงก์');
  };

  it('every non-http(s) scheme is refused and the stored PR is left untouched', async () => {
    const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)  ', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://files.example/a', 'mailto:a@b.co'];
    for (const typed of bad) {
      storageService.savePRs([seedPr()]);
      const snap = JSON.stringify(storageService.getPRs());
      await expect(editLink(typed), typed).rejects.toThrow(/http/);
      expect(JSON.stringify(storageService.getPRs()), typed).toBe(snap);
    }
  });

  it('accepted links are normalised to http(s) ; a bare domain gets https://, host:port is not mistaken for a scheme', async () => {
    const cases = [
      ['https://shopee.co.th/x', 'https://shopee.co.th/x'],
      ['HTTP://a.example/p?q=1', 'HTTP://a.example/p?q=1'],
      ['  lazada.co.th/tape  ', 'https://lazada.co.th/tape'],
      ['localhost:3000/a', 'https://localhost:3000/a']
    ];
    for (const [typed, expected] of cases) {
      const out = await editLink(typed);
      expect(out.items[1].productUrl, typed).toBe(expected);
      expect(out.items[1].onlineUrl, typed).toBe(expected);
    }
    // anything with a hidden scheme-looking prefix still ends up under https://
    for (const typed of ['//evil.example/x', 'java\tscript:alert(1)']) {
      const out = await editLink(typed);
      expect(out.items[1].productUrl, typed).toMatch(/^https:\/\//);
    }
  });

  it('clearing the link of a row that has productUrl + onlineUrl empties both keys', async () => {
    storageService.savePRs([seedPr()]);
    const items = seedPr().items.map((it, i) => (i === 0 ? { ...it, productUrl: '' } : { ...it }));
    const out = await workflowEngine.editPRItems(ID, items, bufferSession, 'ถอดลิงก์');
    expect(getProductUrl(out.items[0])).toBe('');
    expect(out.items[0].onlineUrl).toBe('');
  });

  it('BUG-3 (low) : clearing the link of an older row that keeps it in onlineUrl / link only is silently ignored', async () => {
    for (const key of ['onlineUrl', 'link']) {
      const row = { ...seedPr().items[0] };
      delete row.productUrl; delete row.onlineUrl;
      row[key] = 'https://shop.example/legacy';
      storageService.savePRs([seedPr({ items: [row, seedPr().items[1]] })]);
      // PRDetailsModal.persistItemEdits sends the row with productUrl: '' when the field was cleared
      const out = await workflowEngine.editPRItems(ID, [{ ...row, productUrl: '' }, { ...seedPr().items[1] }], bufferSession, 'ถอดลิงก์');
      expect(getProductUrl(out.items[0]), key).toBe('');
    }
  });

  it('screen : a hostile stored link is rendered as an https:// href, never as javascript:', () => {
    for (const hostile of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const pr = seedPr({ status: 'REVIEWED', items: [{ ...seedPr().items[0], productUrl: hostile, onlineUrl: hostile }, seedPr().items[1]] });
      const { container } = open(pr, approver);
      const links = [...container.querySelectorAll('a')].filter((a) => a.textContent.includes('ดูร้านค้าออนไลน์'));
      expect(links.length, hostile).toBeGreaterThan(0);
      for (const a of links) {
        const href = a.getAttribute('href');
        expect(href, hostile).toMatch(/^https:\/\//);
        expect(href, hostile).not.toMatch(/^\s*(javascript|data|vbscript):/i);
        expect(a.getAttribute('rel')).toContain('noreferrer');
      }
      cleanup();
    }
  });
});

// ═══════════════════════════ (5) save first, then forward - real engine + fetch ═══════════════════════════
describe('(5)/(7) PRDetailsModal : edit form open when "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ" is pressed', () => {
  const fillEdit = () => {
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText(/ระบุเหตุผลที่ปรับแก้/), { target: { value: 'ต่อรองได้' } });
    fireEvent.change(screen.getByLabelText(COMMENT_LABEL), { target: { value: '  ตรวจราคาแล้ว  ' } });
  };
  const routePuts = (puts) => async (url, init) => (init && init.method === 'PUT' && String(url).startsWith('/api/prs/') ? puts.shift() : jsonRes({}));

  it('both PUTs succeed : edit (status stays PENDING_BUFFER, new total) THEN forward (REVIEWED + comment) ; message "ส่งต่อ Plant Mgr แล้ว"', async () => {
    seedStored();
    open(seedPr(), bufferSession);
    fillEdit();
    const fm = goCloudflare(routePuts([jsonRes({ success: true, id: ID, status: 'PENDING_BUFFER' }), jsonRes({ success: true, id: ID, status: 'REVIEWED' })]));
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.success).toHaveBeenCalledWith('ดำเนินการสำเร็จ', 'ส่งต่อ Plant Mgr แล้ว'));
    const puts = prPuts(fm);
    expect(puts).toHaveLength(2);
    const [first, second] = puts.map(bodyOf);
    expect(first.status).toBe('PENDING_BUFFER');
    expect(first.items[0].purchaseQty).toBe(5);
    expect(first.totalAmount).toBe(550);
    expect(second.status).toBe('REVIEWED');
    expect(second.bufferComment).toBe('ตรวจราคาแล้ว');
    expect(second.totalAmount).toBe(550);
    expect(second.items[0].purchaseQty).toBe(5);
    expect(stored().status).toBe('REVIEWED');
    expect(onClose).toHaveBeenCalled();
  });

  it('the edit PUT is refused (400) : NO forward PUT, error shown, window and edit form stay, local copy rolled back', async () => {
    seedStored();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open(seedPr(), bufferSession);
    fillEdit();
    const fm = goCloudflare(routePuts([jsonRes({ error: 'ยอดรวมไม่ตรงกับรายการสินค้า' }, false, 400)]));
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.error).toHaveBeenCalledWith('เกิดข้อผิดพลาด', 'ยอดรวมไม่ตรงกับรายการสินค้า'));
    expect(prPuts(fm)).toHaveLength(1);
    expect(prPuts(fm).map(bodyOf).some((b) => b.status === 'REVIEWED')).toBe(false);
    expect(mockModal.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('ยกเลิกการแก้ไข')).toBeTruthy(); // still in edit mode
    expect(stored().status).toBe('PENDING_BUFFER');
    expect(stored().items[0].purchaseQty).toBe(2); // rolled back : a later forward cannot carry the unsaved edit
  });

  it('a refused link (javascript:) stops the whole action before any request', async () => {
    seedStored();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open(seedPr(), bufferSession);
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    fireEvent.change(screen.getAllByLabelText(URL_LABEL)[1], { target: { value: 'javascript:alert(1)' } });
    fireEvent.change(screen.getByPlaceholderText(/ระบุเหตุผลที่ปรับแก้/), { target: { value: 'เพิ่มลิงก์' } });
    const fm = goCloudflare();
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.error).toHaveBeenCalled());
    expect(mockModal.error.mock.calls[0][1]).toMatch(/http/);
    expect(prPuts(fm)).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(stored().items[1].productUrl).toBeUndefined();
  });

  it('BUG-4 (low) : edit saved, forward then fails -> the window still shows the old qty/price because onRefresh is never called', async () => {
    seedStored();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open(seedPr(), bufferSession);
    fillEdit();
    goCloudflare(routePuts([jsonRes({ success: true, id: ID, status: 'PENDING_BUFFER' }), jsonRes({ error: 'boom' }, false, 500)]));
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.error).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    // the server already holds the edit -> the parent must be told to reload
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe('(7) reviewer "ตรวจสอบผ่าน" : success text follows the status the server saved', () => {
  const pass = async (answer) => {
    seedStored({ status: 'SUBMITTED' });
    open(seedPr({ status: 'SUBMITTED' }), reviewerPD);
    goCloudflare(async (url, init) => (init && init.method === 'PUT' ? jsonRes(answer) : jsonRes({})));
    fireEvent.click(screen.getByText(BTN_REVIEW));
  };

  it('server parks it at the BUFFER user -> "ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว"', async () => {
    await pass({ success: true, id: ID, status: 'PENDING_BUFFER' });
    await waitFor(() => expect(mockModal.success).toHaveBeenCalledWith('ดำเนินการสำเร็จ', 'ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว'));
    expect(stored().status).toBe('PENDING_BUFFER');
  });

  it('no active BUFFER account (step skipped) -> "ส่งต่อ Plant Mgr แล้ว"', async () => {
    await pass({ success: true, id: ID, status: 'REVIEWED', bufferSkipped: true });
    await waitFor(() => expect(mockModal.success).toHaveBeenCalledWith('ดำเนินการสำเร็จ', 'ส่งต่อ Plant Mgr แล้ว'));
    expect(stored().status).toBe('REVIEWED');
  });
});

// ═══════════════════════════ (4) notification audience ═══════════════════════════
describe('(4) notifications : BUFFER sees PR_PENDING_BUFFER only ; approver / reviewer do not get it ; BUFFER gets none of the others', () => {
  const forRole = (role) => notificationService.getNotificationsForRole(role).map((n) => n.type);
  const pr = { id: 'N1', prNo: 'PD009/2026', department: 'PD', totalAmount: 1000 };

  it('local dispatch of the two review outcomes', () => {
    workflowEngine.notifyReviewOutcome(pr, reviewerPD, 'PENDING_BUFFER');
    expect(forRole(bufferSession)).toContain('PR_PENDING_BUFFER');
    expect(forRole(admin)).toContain('PR_PENDING_BUFFER');
    for (const u of [approver, reviewerPD, requester]) expect(forRole(u)).not.toContain('PR_PENDING_BUFFER');

    workflowEngine.notifyReviewOutcome(pr, bufferSession, 'REVIEWED');
    expect(forRole(approver)).toContain('PR_REVIEWED');
    expect(forRole(bufferSession)).not.toContain('PR_REVIEWED');
  });

  it('review / requester notifications never reach the BUFFER session', () => {
    notificationService.dispatch({ type: 'PR_SUBMITTED', title: 'รอตรวจ', message: 'm', department: 'PD', targetRoles: ['ASST_MANAGER', 'ADMIN'] });
    notificationService.dispatch({ type: 'PR_REJECTED', title: 'ตีกลับ', message: 'm', department: 'PD', targetRoles: ['REQUESTER_PD', 'ADMIN'] });
    notificationService.dispatch({ type: 'PR_CANCELLED', title: 'ยกเลิก', message: 'm', department: 'PD', targetRoles: ['REQUESTER_PD', 'ADMIN', 'ASST_MANAGER'] });
    expect(forRole(reviewerPD)).toContain('PR_SUBMITTED');
    expect(forRole(bufferSession)).toEqual([]);
  });
});

// ═══════════════════════════ (9) To-Do / sidebar badge ═══════════════════════════
describe('(9) getUserTasks (sidebar badge) with PENDING_BUFFER', () => {
  const mk = (id, status, department = 'PD', over = {}) => ({
    id, prNo: id, department, status, requestedBy: 'คุณวิชัย (PD)', requestedDate: '2026-10-17', totalAmount: 100,
    items: [{ id: 'I', name: 'x', qty: 1, price: 100 }], activityLog: [], ...over
  });
  const prs = [
    mk('A', 'PENDING_BUFFER', 'PD'),
    mk('B', 'PENDING_BUFFER', 'QC'),
    mk('C', 'SUBMITTED', 'PD'),
    mk('D', 'REVIEWED', 'PD'),
    mk('E', 'PENDING_BUFFER', 'PD', { activityLog: [{ action: 'ตรวจสอบแล้ว', user: 'ผู้ตรวจ PD', role: 'Asst PD', timestamp: 't' }] })
  ];
  const ids = (list) => list.map((x) => x.id).sort();
  const tasks = (u) => workflowEngine.getUserTasks(u, prs, []);

  it('BUFFER : every PENDING_BUFFER of every department is a To-Do and the badge counts exactly those', () => {
    const t = tasks(bufferSession);
    expect(ids(t.action)).toEqual(['A', 'B', 'E']);
    expect(t.counts.prCount).toBe(3);
    expect(t.counts.total).toBe(3);
  });

  it('reviewer : only SUBMITTED is a To-Do ; the PR it passed on waits at the BUFFER ("รอผู้อื่น")', () => {
    const t = tasks(reviewerPD);
    expect(ids(t.action)).toEqual(['C']);
    expect(ids(t.waiting)).toEqual(['E']);
  });

  it('approver : only REVIEWED is a To-Do ; PENDING_BUFFER is shown as in progress, never as a To-Do', () => {
    const t = tasks(approver);
    expect(ids(t.action)).toEqual(['D']);
    expect(ids(t.waiting)).toEqual(['A', 'B', 'E']);
  });

  it('requester : no To-Do on submitted PRs ; its own PRs are "รอผู้อื่น" including PENDING_BUFFER', () => {
    const t = tasks(requester);
    expect(t.action).toEqual([]);
    expect(ids(t.waiting)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

// ═══════════════════════════ (8) user forms ═══════════════════════════
describe('(8) user forms : role BUFFER', () => {
  const dept = [{ code: 'PD', name: 'PD' }, { code: 'QC', name: 'QC' }];
  let saveUser;
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    saveUser = vi.spyOn(apiService, 'saveUser').mockImplementation(async (u) => ({ ...u }));
    vi.spyOn(apiService, 'getUsers').mockResolvedValue([]);
    // jsdom has no canvas : the signature pad only needs a 2d context object
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ lineCap: '', lineJoin: '', strokeStyle: '', lineWidth: 0, clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }));
  });

  it('UserMasterView : choosing BUFFER needs no department, saves level 2 with every department (*) and a management primary department', async () => {
    render(<UserMasterView users={[{ id: 'U0', name: 'X', username: 'x', roleId: 'REQUESTER', department: 'PD' }]} departments={dept} currentRole={admin} currentUser={admin} onRefresh={() => {}} />);
    const addBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes('เพิ่มผู้ใช้ใหม่'));
    fireEvent.click(addBtn);
    const select = [...document.body.querySelectorAll('form select')].find((s) => [...s.options].some((o) => o.value === 'BUFFER'));
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: 'BUFFER' } });
    fireEvent.change(document.body.querySelector('input[placeholder="เช่น คุณวิชัย (PD)"]'), { target: { value: 'พี่สุ' } });
    fireEvent.change(document.body.querySelector('input[placeholder="เช่น wichai.pd"]'), { target: { value: 'su.buffer' } });
    fireEvent.submit([...document.body.querySelectorAll('form')].find((f) => f.contains(select)));
    await waitFor(() => expect(saveUser).toHaveBeenCalledTimes(1));
    expect(mockModal.warning).not.toHaveBeenCalled();
    expect(saveUser.mock.calls[0][0]).toMatchObject({ roleId: 'BUFFER', level: 2, assignedDepartments: ['*'], allowedDepartments: ['*'], department: 'MGT', primaryDepartment: 'MGT' });
  });

  it('UserCRUDModal : choosing BUFFER saves level 2 with every department (ALL)', async () => {
    render(<UserCRUDModal user={null} users={[]} departments={dept} currentRole={{ id: 'ADMIN' }} onClose={() => {}} onSaved={() => {}} />);
    const select = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'BUFFER'));
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: 'BUFFER' } });
    fireEvent.change(document.body.querySelector('input[placeholder="เช่น คุณวิชัย (PD)"]'), { target: { value: 'พี่สุ' } });
    fireEvent.change(document.body.querySelector('input[placeholder="เช่น wichai.pd หรือ user@company.com"]'), { target: { value: 'su.buffer' } });
    fireEvent.submit(document.body.querySelector('form'));
    await waitFor(() => expect(saveUser).toHaveBeenCalledTimes(1));
    expect(saveUser.mock.calls[0][0]).toMatchObject({ roleId: 'BUFFER', positionKey: 'BUFFER', level: 2, assignedDepartments: ['ALL'] });
    expect(saveUser.mock.calls[0][0].allowedDepartments).toEqual(['*']);
  });
});
