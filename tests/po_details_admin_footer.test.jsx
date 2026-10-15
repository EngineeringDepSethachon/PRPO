// @vitest-environment jsdom
// 2026-10-15 tester : as System Admin a SELF PO in PARTIALLY_RECEIVED_IN_CLAIM showed NO footer button ("จัดการเคสปัญหา" missing once the
// claim panel was closed), while the user decision of 2026-10-14 lets the admin close a claim. Cause : the `isOperational` gate
// (requester / asst_mgr / supervisor) did not count the admin, although canReceiveGoods / canResolveSelfClaim already allow ADMIN.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import './setup.js';
import PODetailsModal from '../src/components/po/PODetailsModal';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return { ...actual, createPortal: (node) => node };
});

const admin = { id: 'ADMIN', roleId: 'ADMIN', role: 'admin', name: 'System Admin', level: 99, department: 'ALL', canViewAllDepts: true };
const requester = { id: 'REQUESTER_PD', roleId: 'REQUESTER_PD', role: 'requester', name: 'กัลยาณี พลไกร', level: 1, department: 'PD', canReceiveGoods: true };
// id must differ from the PO's requesterId : the client still stores the ROLE id there (whiteboard follow-up), so a same-role user with the
// same id would count as the owner
const reviewer = { id: 'REV-01', userId: 'REV-01', roleId: 'ASST_MANAGER', role: 'asst_mgr', name: 'Someone Else', level: 2, department: 'PD', canReview: true };

// PO-PD-2026-003 as production holds it (SELF, "บันทึกปัญหาไว้ก่อน" after a partial receipt)
const claimPo = (over = {}) => ({
  id: 'PO-1792033280316-1', poNo: 'PO-PD-2026-003', prNo: 'PD003/2026', department: 'PD', purchaseChannel: 'SELF',
  status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', requestedBy: 'กัลยาณี พลไกร', requesterId: 'ASST_MANAGER',
  issueDate: '2026-10-15', vendorName: 'สยามไทย',
  claimData: { reason: 'damaged', description: 'x', reportedBy: 'กัลยาณี พลไกร' },
  items: [{ productId: 'P1', name: 'ผ้ากันเปื้อน', orderedQty: 10, purchaseQty: 10, receivedQty: 7, price: 174 }],
  ...over
});

const open = (po, role) => render(<PODetailsModal selectedPO={po} currentRole={role} onClose={() => {}} />);
const RESOLVE_BTN = '✓ ยืนยันบันทึกผลการจัดการเคส';
const FOOTER_BTN = 'จัดการเคสปัญหา';

afterEach(() => cleanup());

describe('PODetailsModal : self-claim actions of the admin (PO-PD-2026-003)', () => {
  it('System Admin : the claim panel opens with the resolve options ; after "ยกเลิก" the footer shows "จัดการเคสปัญหา" to reopen it', () => {
    open(claimPo(), admin);
    expect(screen.getByText(RESOLVE_BTN)).toBeTruthy();
    expect(screen.queryByText(FOOTER_BTN)).toBeNull(); // panel already open
    fireEvent.click(screen.getByText('ยกเลิก'));
    expect(screen.queryByText(RESOLVE_BTN)).toBeNull();
    expect(screen.getByText(FOOTER_BTN)).toBeTruthy();
    fireEvent.click(screen.getByText(FOOTER_BTN));
    expect(screen.getByText(RESOLVE_BTN)).toBeTruthy();
  });

  it('the owner Requester has the same two-way flow', () => {
    open(claimPo(), requester);
    expect(screen.getByText(RESOLVE_BTN)).toBeTruthy();
    fireEvent.click(screen.getByText('ยกเลิก'));
    expect(screen.getByText(FOOTER_BTN)).toBeTruthy();
  });

  it('the requester who received the goods and reported the claim resolves it even though the PR belongs to somebody else (PO-PD-2026-003, 2026-10-15)', () => {
    const receiver = { id: 'REQUESTER', userId: 'USR-0894', roleId: 'REQUESTER', role: 'requester', name: 'สิรภัทร แจ่มมิน', level: 1, department: 'PD', canReceiveGoods: true };
    open(claimPo({ claimData: { reason: 'short', description: 'x', reportedBy: 'สิรภัทร แจ่มมิน' } }), receiver);
    expect(screen.getByText(RESOLVE_BTN)).toBeTruthy();
    cleanup();
    // "name (position)" stamp counts by its name part
    open(claimPo({ claimData: { reason: 'short', description: 'x', reportedBy: 'สิรภัทร แจ่มมิน (Requester)' } }), receiver);
    expect(screen.getByText(RESOLVE_BTN)).toBeTruthy();
    cleanup();
    // a requester who neither owns the PR nor reported the claim still gets the waiting notice
    open(claimPo(), receiver);
    expect(screen.getByText('อยู่ระหว่างผู้จัดซื้อดำเนินการแก้ไข')).toBeTruthy();
  });

  it('a Reviewer who is not the owner only sees the waiting notice, never the resolve options nor the footer button (decision 2026-10-14)', () => {
    const { container } = open(claimPo(), reviewer);
    expect(screen.getByText('อยู่ระหว่างผู้จัดซื้อดำเนินการแก้ไข')).toBeTruthy();
    expect(screen.queryByText(RESOLVE_BTN)).toBeNull();
    expect(container.textContent).not.toContain(FOOTER_BTN);
  });

  it('admin on an ISSUED SELF PO gets the receive button (canReceiveGoods already allowed ADMIN)', () => {
    const { container } = open(claimPo({ status: 'ISSUED', claimStatus: undefined, claimData: undefined, items: [{ productId: 'P1', name: 'ผ้ากันเปื้อน', orderedQty: 10, purchaseQty: 10, receivedQty: 0, price: 174 }] }), admin);
    expect(container.textContent).toContain('บันทึกตรวจรับสินค้า');
    expect(container.textContent).not.toContain(FOOTER_BTN);
  });

  it('an ONLINE PO in claim never shows the self-claim panel or button, admin included (its panel is the Online Hub)', () => {
    const { container } = open(claimPo({ purchaseChannel: 'ONLINE' }), admin);
    expect(container.textContent).not.toContain(FOOTER_BTN);
    expect(container.textContent).not.toContain(RESOLVE_BTN);
  });
});
