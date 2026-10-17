// @vitest-environment jsdom
// M10 T6 (FR-01) : PRDetailsModal for the BUFFER step ("พี่สุ", PENDING_BUFFER)
//   buttons per status x role, "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ" (comment + item edits saved first), link field, reviewer button text, buffer stamp.
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

import { ROLES } from '../src/config/constants';
import { apiService } from '../src/services/apiService';
import { storageService } from '../src/services/storageService';
import PRDetailsModal from '../src/components/pr/PRDetailsModal';

// ── actors (same shapes as tests/buffer_workflow.test.jsx) ──
const buffer = { ...ROLES.BUFFER, roleId: 'BUFFER', name: 'พี่สุ', title: 'ผู้ตรวจสอบจัดซื้อ (พี่สุ)' };
const reviewer = { ...ROLES.ASST_MANAGER, roleId: 'ASST_MANAGER' };
const approver = { ...ROLES.PLANT_MANAGER, roleId: 'PLANT_MANAGER' };
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

const seedPr = (over = {}) => ({
  id: 'PR-BUF-UI-1', prNo: 'PD001/2026', department: 'PD', status: 'PENDING_BUFFER', purchaseChannel: 'ONLINE',
  requestedBy: 'คุณวิชัย (PD)', requestedDate: '2026-10-17', totalAmount: 250,
  items: [
    { id: 'I1', code: 'C1', name: 'ถุงมือ', purchaseQty: 2, qty: 2, price: 100, total: 200, purchaseUnit: 'กล่อง', stockUnit: 'กล่อง', conversionRate: 1, stockQty: 2, productUrl: 'https://shopee.co.th/a' },
    { id: 'I2', code: 'C2', name: 'เทป', purchaseQty: 1, qty: 1, price: 50, total: 50, purchaseUnit: 'ม้วน', stockUnit: 'ม้วน', conversionRate: 1, stockQty: 1 }
  ],
  activityLog: [], approvalHistory: [],
  ...over
});

const onClose = vi.fn();
const onRefresh = vi.fn();

const open = (pr, role) => {
  mockCtx.value = { ...mockCtx.value, prs: [pr] };
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
  Object.values(mockModal).forEach((fn) => fn.mockReset());
  mockModal.confirm.mockResolvedValue(true);
  onClose.mockReset();
  onRefresh.mockReset();
  mockCtx.value = {
    prs: [],
    pos: [],
    products: [],
    bufferForwardPR: vi.fn().mockResolvedValue({ pr: {}, successMessage: 'ส่งต่อผู้อนุมัติแล้ว' }),
    reviewPR: vi.fn().mockResolvedValue({ pr: {}, successMessage: 'ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว' }),
    rejectPR: vi.fn().mockResolvedValue({}),
    cancelPR: vi.fn().mockResolvedValue(true)
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PRDetailsModal at PENDING_BUFFER : buttons per role', () => {
  it('(a) BUFFER sees the forward button, the comment box and the edit button - and no Reject / Cancel / review / approve', () => {
    open(seedPr(), buffer);
    expect(screen.getAllByText('รอพี่สุตรวจสอบ').length).toBeGreaterThan(0); // status badge from PR_STATUS
    expect(hasBtn(BTN_FORWARD)).toBe(true);
    expect(screen.getByLabelText(COMMENT_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(COMMENT_LABEL).getAttribute('maxlength')).toBe('2000');
    expect(hasBtn(BTN_EDIT_BUFFER)).toBe(true);
    expect(screen.queryByText(BTN_REJECT)).toBeNull();
    expect(screen.queryByText(BTN_CANCEL)).toBeNull();
    expect(screen.queryByText(BTN_REVIEW)).toBeNull();
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
  });

  it('(b) reviewer sees Reject + Cancel only - no forward, no comment box, no edit button, no approve', () => {
    open(seedPr(), reviewer);
    expect(screen.getByText(BTN_REJECT)).toBeTruthy();
    expect(screen.getByText(BTN_CANCEL)).toBeTruthy();
    expect(hasBtn(BTN_FORWARD)).toBe(false);
    expect(screen.queryByLabelText(COMMENT_LABEL)).toBeNull();
    expect(screen.queryByText(BTN_EDIT_BUFFER)).toBeNull();
    expect(screen.queryByText(BTN_EDIT)).toBeNull();
    expect(screen.queryByText(BTN_REVIEW)).toBeNull();
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
  });

  it('(c) approver sees Reject + Cancel but not approve (approving is REVIEWED only), no forward, no edit', () => {
    open(seedPr(), approver);
    expect(screen.getByText(BTN_REJECT)).toBeTruthy();
    expect(screen.getByText(BTN_CANCEL)).toBeTruthy();
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
    expect(hasBtn(BTN_FORWARD)).toBe(false);
    expect(screen.queryByText(BTN_EDIT_BUFFER)).toBeNull();
    expect(screen.queryByText(BTN_EDIT)).toBeNull();
  });

  it('admin sees everything at this stage : forward + comment + edit + Reject + Cancel', () => {
    open(seedPr(), admin);
    expect(hasBtn(BTN_FORWARD)).toBe(true);
    expect(screen.getByLabelText(COMMENT_LABEL)).toBeTruthy();
    expect(hasBtn(BTN_EDIT_BUFFER)).toBe(true);
    expect(screen.getByText(BTN_REJECT)).toBeTruthy();
    expect(screen.getByText(BTN_CANCEL)).toBeTruthy();
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
  });

});

describe('PRDetailsModal : other statuses are unchanged', () => {
  it('(d) REVIEWED : approver keeps approve / Reject / Cancel / edit ; BUFFER sees none of them', () => {
    const pr = seedPr({ status: 'REVIEWED' });
    open(pr, approver);
    expect(screen.getByText(BTN_APPROVE)).toBeTruthy();
    expect(screen.getByText(BTN_REJECT)).toBeTruthy();
    expect(screen.getByText(BTN_CANCEL)).toBeTruthy();
    expect(screen.getByText(BTN_EDIT)).toBeTruthy();
    cleanup();

    open(pr, buffer);
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
    expect(screen.queryByText(BTN_REJECT)).toBeNull();
    expect(screen.queryByText(BTN_CANCEL)).toBeNull();
    expect(screen.queryByText(BTN_EDIT)).toBeNull();
    expect(screen.queryByText(BTN_EDIT_BUFFER)).toBeNull();
    expect(hasBtn(BTN_FORWARD)).toBe(false);
    expect(screen.queryByLabelText(COMMENT_LABEL)).toBeNull();
    expect(screen.getByTitle('ปิดหน้าต่าง (Esc)')).toBeTruthy(); // close stays
  });

  it('(e) SUBMITTED : reviewer sees "ตรวจสอบผ่าน (ส่งต่อขั้นถัดไป)" (no fixed Plant Mgr), BUFFER sees nothing to act on', () => {
    const pr = seedPr({ status: 'SUBMITTED' });
    const { container } = open(pr, reviewer);
    expect(screen.getByText(BTN_REVIEW)).toBeTruthy();
    expect(screen.getByText(BTN_REJECT)).toBeTruthy();
    expect(screen.getByText(BTN_EDIT)).toBeTruthy();
    expect(container.textContent).not.toContain('ส่งต่อ Plant Mgr');
    cleanup();

    open(pr, buffer);
    expect(screen.queryByText(BTN_REVIEW)).toBeNull();
    expect(screen.queryByText(BTN_REJECT)).toBeNull();
    expect(screen.queryByText(BTN_CANCEL)).toBeNull();
    expect(screen.queryByText(BTN_EDIT)).toBeNull();
    expect(screen.queryByText(BTN_EDIT_BUFFER)).toBeNull();
  });

  it('(e2) the reviewer success message is the one reviewPR returns (BUFFER user or Plant Mgr)', async () => {
    for (const successMessage of ['ส่งต่อผู้ตรวจสอบจัดซื้อแล้ว', 'ส่งต่อ Plant Mgr แล้ว']) {
      mockModal.success.mockReset();
      mockCtx.value.reviewPR = vi.fn().mockResolvedValue({ pr: {}, successMessage });
      open(seedPr({ status: 'SUBMITTED' }), reviewer);
      fireEvent.click(screen.getByText(BTN_REVIEW));
      await waitFor(() => expect(mockCtx.value.reviewPR).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockModal.success).toHaveBeenCalledWith('ดำเนินการสำเร็จ', successMessage));
      // the confirm text names no fixed destination
      expect(mockModal.confirm.mock.calls.at(-1)[0].message).not.toContain('Plant');
      cleanup();
    }
  });

  it('REJECTED_TO_L2 : reviewer still gets the review button ; an old APPROVED PR shows no workflow buttons', () => {
    open(seedPr({ status: 'REJECTED_TO_L2' }), reviewer);
    expect(screen.getByText(BTN_REVIEW)).toBeTruthy();
    cleanup();
    open(seedPr({ status: 'APPROVED' }), approver);
    expect(screen.queryByText(BTN_REVIEW)).toBeNull();
    expect(screen.queryByText(BTN_APPROVE)).toBeNull();
    expect(screen.queryByText(BTN_CANCEL)).toBeNull();
    expect(hasBtn(BTN_FORWARD)).toBe(false);
  });
});

describe('PRDetailsModal : BUFFER forward', () => {
  it('(f) the forward button calls context.bufferForwardPR(id, comment), shows its successMessage and closes', async () => {
    const pr = seedPr();
    open(pr, buffer);
    fireEvent.change(screen.getByLabelText(COMMENT_LABEL), { target: { value: '  ราคาตรงกับร้านค้า  ' } });
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockCtx.value.bufferForwardPR).toHaveBeenCalledTimes(1));
    expect(mockCtx.value.bufferForwardPR).toHaveBeenCalledWith(pr.id, 'ราคาตรงกับร้านค้า');
    await waitFor(() => expect(mockModal.success).toHaveBeenCalledWith('ดำเนินการสำเร็จ', 'ส่งต่อผู้อนุมัติแล้ว'));
    expect(onClose).toHaveBeenCalled();
    expect(mockCtx.value.rejectPR).not.toHaveBeenCalled();
  });

  it('an empty comment is allowed (optional)', async () => {
    const pr = seedPr();
    open(pr, buffer);
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockCtx.value.bufferForwardPR).toHaveBeenCalledWith(pr.id, ''));
  });

  it('declining the confirm dialog sends nothing', async () => {
    mockModal.confirm.mockResolvedValue(false);
    open(seedPr(), buffer);
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.confirm).toHaveBeenCalled());
    expect(mockCtx.value.bufferForwardPR).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a failing forward shows the error and keeps the window open', async () => {
    mockCtx.value.bufferForwardPR = vi.fn().mockRejectedValue(new Error('ส่งต่อไม่สำเร็จ'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    open(seedPr(), buffer);
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.error).toHaveBeenCalledWith('เกิดข้อผิดพลาด', 'ส่งต่อไม่สำเร็จ'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PRDetailsModal : BUFFER item edit (qty / price / link)', () => {
  it('the link field shows for self-purchase and online PRs, prefilled with getProductUrl(item) ; hidden outside edit mode', () => {
    for (const purchaseChannel of ['ONLINE', 'SELF']) {
      open(seedPr({ purchaseChannel }), buffer);
      expect(screen.queryAllByLabelText(URL_LABEL).length).toBe(0);
      fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
      const inputs = screen.getAllByLabelText(URL_LABEL);
      expect(inputs.length).toBe(2);
      expect(inputs[0].value).toBe('https://shopee.co.th/a');
      expect(inputs[1].value).toBe('');
      cleanup();
    }
  });

  it('the link field is not offered to a reviewer / approver editing at SUBMITTED / REVIEWED', () => {
    open(seedPr({ status: 'SUBMITTED' }), reviewer);
    fireEvent.click(screen.getByText(BTN_EDIT));
    expect(screen.queryAllByLabelText(URL_LABEL).length).toBe(0);
  });

  it('forward with an open edit form : the items are saved first through editPRItems (link sent only for the changed row), then forwarded', async () => {
    const order = [];
    const editSpy = vi.spyOn(apiService, 'editPRItems').mockImplementation(async () => { order.push('edit'); return {}; });
    mockCtx.value.bufferForwardPR = vi.fn().mockImplementation(async () => { order.push('forward'); return { pr: {}, successMessage: 'ส่งต่อผู้อนุมัติแล้ว' }; });
    const pr = seedPr();
    open(pr, buffer);
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    const inputs = screen.getAllByLabelText(URL_LABEL);
    fireEvent.change(inputs[1], { target: { value: 'https://lazada.co.th/tape' } });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText(/ระบุเหตุผลที่ปรับแก้/), { target: { value: 'ต่อรองราคาได้' } });
    fireEvent.change(screen.getByLabelText(COMMENT_LABEL), { target: { value: 'แก้จำนวนและลิงก์แล้ว' } });
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));

    await waitFor(() => expect(mockCtx.value.bufferForwardPR).toHaveBeenCalledWith(pr.id, 'แก้จำนวนและลิงก์แล้ว'));
    expect(order).toEqual(['edit', 'forward']);
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [prId, sentItems, user, reason] = editSpy.mock.calls[0];
    expect(prId).toBe(pr.id);
    expect(user).toBe(buffer);
    expect(reason).toBe('ต่อรองราคาได้');
    expect(sentItems[0].purchaseQty).toBe(5);
    expect(sentItems[0].total).toBe(500);
    expect('productUrl' in sentItems[0] && sentItems[0].productUrl !== 'https://shopee.co.th/a').toBe(false); // untouched link keeps its value
    expect(sentItems[1].productUrl).toBe('https://lazada.co.th/tape');
  });

  it('forward with real edits but no edit reason : warns, saves nothing, forwards nothing (the edits stay on screen)', async () => {
    const editSpy = vi.spyOn(apiService, 'editPRItems').mockResolvedValue({});
    open(seedPr(), buffer);
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    fireEvent.change(screen.getAllByLabelText(URL_LABEL)[1], { target: { value: 'https://lazada.co.th/tape' } });
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.warning).toHaveBeenCalled());
    expect(editSpy).not.toHaveBeenCalled();
    expect(mockCtx.value.bufferForwardPR).not.toHaveBeenCalled();
    expect(mockModal.confirm).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText(URL_LABEL)[1].value).toBe('https://lazada.co.th/tape');
  });

  it('forward with an open but untouched edit form does not call editPRItems', async () => {
    const editSpy = vi.spyOn(apiService, 'editPRItems').mockResolvedValue({});
    const pr = seedPr();
    open(pr, buffer);
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockCtx.value.bufferForwardPR).toHaveBeenCalledWith(pr.id, ''));
    expect(editSpy).not.toHaveBeenCalled();
  });

  it('if saving the items fails nothing is forwarded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(apiService, 'editPRItems').mockRejectedValue(new Error('บันทึกรายการไม่สำเร็จ'));
    open(seedPr(), buffer);
    fireEvent.click(screen.getByText(BTN_EDIT_BUFFER));
    fireEvent.change(screen.getAllByLabelText(URL_LABEL)[1], { target: { value: 'https://lazada.co.th/tape' } });
    fireEvent.change(screen.getByPlaceholderText(/ระบุเหตุผลที่ปรับแก้/), { target: { value: 'เหตุผล' } });
    fireEvent.click(screen.getByRole('button', { name: BTN_FORWARD }));
    await waitFor(() => expect(mockModal.error).toHaveBeenCalledWith('เกิดข้อผิดพลาด', 'บันทึกรายการไม่สำเร็จ'));
    expect(mockCtx.value.bufferForwardPR).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PRDetailsModal : BUFFER stamp', () => {
  it('(g) shows "ตรวจสอบจัดซื้อโดย …" with the time and the comment once the BUFFER user has forwarded', () => {
    open(seedPr({
      status: 'REVIEWED', bufferReviewedBy: 'สุดา ตรวจสอบ', bufferReviewedById: 'USR-BUF', bufferReviewedAt: '2026-10-17T10:30:00',
      bufferComment: 'ลิงก์ร้านถูกต้อง\nราคาล่าสุด 100 บาท'
    }), approver);
    const box = screen.getByTestId('buffer-review-info');
    expect(box.textContent).toContain('ตรวจสอบจัดซื้อโดย สุดา ตรวจสอบ');
    expect(box.textContent).toContain('17/10/2026 10:30');
    expect(box.textContent).toContain('ลิงก์ร้านถูกต้อง');
    expect(box.textContent).toContain('ราคาล่าสุด 100 บาท');
  });

  it('no stamp row on a PR the BUFFER user never touched (old PRs)', () => {
    open(seedPr({ status: 'REVIEWED' }), approver);
    expect(screen.queryByTestId('buffer-review-info')).toBeNull();
  });
});
