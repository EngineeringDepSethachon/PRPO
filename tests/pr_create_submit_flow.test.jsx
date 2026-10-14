// @vitest-environment jsdom
// S7 (smoke 2026-10-14) : after a successful submit the form must not flip to "create new" mode / a new PR number behind the success modal,
// and a second submit must be impossible ; the original flow (modal -> "ตกลง" -> navigate to pr-list) is kept.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import { storageService } from '../src/services/storageService';
import { modalService } from '../src/services/modalService';
import { budgetService } from '../src/services/budgetService';
import { AppProvider } from '../src/context/AppContext';
import PRCreateView from '../src/views/PRCreateView';

const role = { id: 'USR-PD-01', name: 'คุณสมชาย', department: 'PD', roleId: 'REQUESTER_PD', level: 1 };
const products = [{ id: 'PROD-PD-001', code: 'PD-OIL-068', name: 'น้ำมันไฮดรอลิก', category: 'PD', unit: 'ลิตร', price: 100, stockBalance: 10, reorderPoint: 2 }];
const vendors = [{ id: 'V1', code: 'V-001', name: 'ผู้ขาย A', department: 'ALL' }];
const editingPR = {
  id: 'PR-S7-1', prNo: 'PD001/2026', department: 'PD', purchaseChannel: 'SELF', vendorId: 'V1', status: 'REJECTED_TO_DRAFT',
  items: [{ productId: 'PROD-PD-001', code: 'PD-OIL-068', name: 'น้ำมันไฮดรอลิก', price: 100, qty: 2, unit: 'ลิตร' }]
};

describe('PRCreateView : after a successful submit (S7)', () => {
  beforeEach(() => { localStorage.clear(); storageService.resetData(); });
  afterEach(() => { cleanup(); });

  it('resubmit : shows the success modal, keeps edit mode + same PR no. until "ตกลง", blocks a 2nd submit, then clears and navigates', async () => {
    const updatePR = vi.fn(async (id, payload) => ({ ...payload, id, status: 'WAITING_REVIEW' }));
    const clearEditingPR = vi.fn();
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <AppProvider>
          <PRCreateView currentRole={role} editingPR={editingPR} products={products} vendors={vendors} departments={[{ id: 'PD', code: 'PD', name: 'ฝ่ายผลิต' }]}
            updatePR={updatePR} clearEditingPR={clearEditingPR} onNavigate={onNavigate} />
        </AppProvider>
      </MemoryRouter>
    );
    vi.spyOn(budgetService, 'calculatePeriodBudgetSummary').mockReturnValue({ current: { PD: { isAllocated: true } } });
    const warn = vi.spyOn(modalService, 'warning').mockImplementation(() => {});
    const err = vi.spyOn(modalService, 'error').mockImplementation(() => {});
    const submit = () => screen.getByText(/บันทึกและส่งใบ PR ใหม่ \(Resubmit\)/);
    fireEvent.click(submit());
    await waitFor(() => { if (!document.getElementById('pr-create-success-modal-btn')) throw new Error('no modal ; warn=' + JSON.stringify(warn.mock.calls) + ' err=' + JSON.stringify(err.mock.calls)); });
    expect(updatePR).toHaveBeenCalledTimes(1);
    // nothing is cleared while the modal is up : the form behind it stays in edit mode with the same number
    expect(clearEditingPR).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getAllByText(/PD001\/2026/).length).toBeGreaterThan(0);
    // a second click on submit (through the overlay) does nothing
    fireEvent.click(submit());
    await new Promise((r) => setTimeout(r, 30));
    expect(updatePR).toHaveBeenCalledTimes(1);
    // "ตกลง" : clear edit mode, go to the PR list (original behaviour)
    fireEvent.click(document.getElementById('pr-create-success-modal-btn'));
    expect(clearEditingPR).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('pr-list');
  });
});
