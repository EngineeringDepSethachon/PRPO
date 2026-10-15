// @vitest-environment jsdom
// TC-011 (Bug_log_PRPO (3).xlsx, 2026-10-15) : a user who looks after 2+ departments (Asst. Manager and up, allowedDepartments PD + QC)
// could only open a PR for the primary department - the form locked the department to currentRole.department unless it was 'ALL'.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import { storageService } from '../src/services/storageService';
import { AppProvider } from '../src/context/AppContext';
import PRCreateView from '../src/views/PRCreateView';

const DEPTS = [
  { id: 'PD', code: 'PD', name: 'ฝ่ายผลิต' },
  { id: 'QC', code: 'QC', name: 'ฝ่ายควบคุมคุณภาพ' },
  { id: 'MGT', code: 'MGT', name: 'ฝ่ายบริหาร' },
  { id: 'OLD', code: 'OLD', name: 'แผนกปิดแล้ว', isActive: false }
];
const products = [{ id: 'PROD-PD-001', code: 'PD-OIL-068', name: 'น้ำมันไฮดรอลิก', category: 'PD', unit: 'ลิตร', price: 100, stockBalance: 10 }];

// the session object as AppContext / the login build it (allowedDepartments from the users table, department = primary)
const asstTwoDepts = { id: 'USR-6539', name: 'กัลยาณี พลไกร', roleId: 'ASST_MANAGER', level: 2, department: 'PD', primaryDepartment: 'PD', allowedDepartments: ['PD', 'QC'], assignedDepartments: ['PD', 'QC'], canReview: true };
const requesterOneDept = { id: 'USR-0894', name: 'สิรภัทร แจ่มมิน', roleId: 'REQUESTER', level: 1, department: 'PD', allowedDepartments: ['PD'] };
const plantManagerAll = { id: 'USR-3333', name: 'ณัฐนิชา', roleId: 'PLANT_MANAGER', level: 3, department: 'MGT', allowedDepartments: ['*'], canViewAllDepts: true };

const open = (role, extra = {}) => render(
  <MemoryRouter>
    <AppProvider>
      <PRCreateView currentRole={role} products={products} vendors={[]} departments={DEPTS} {...extra} />
    </AppProvider>
  </MemoryRouter>
);
const select = () => screen.queryByLabelText('ฝ่ายผู้ขอซื้อ');
const optionCodes = () => Array.from(select().querySelectorAll('option')).map(o => o.value);

describe('PRCreateView department choice (TC-011)', () => {
  beforeEach(() => { localStorage.clear(); storageService.resetData(); });
  afterEach(() => cleanup());

  it('a user with 2 departments (PD + QC) gets a selector with exactly those departments, primary first, and can switch to QC', () => {
    open(asstTwoDepts);
    expect(select()).toBeTruthy();
    expect(optionCodes()).toEqual(['PD', 'QC']);
    expect(select().value).toBe('PD');
    fireEvent.change(select(), { target: { value: 'QC' } });
    expect(select().value).toBe('QC');
    expect(screen.getAllByText(/\[QC\]/).length).toBeGreaterThan(0);
  });

  it('a single-department requester keeps the locked field (ตามสิทธิ์)', () => {
    open(requesterOneDept);
    expect(select()).toBeNull();
    expect(screen.getByText('(ตามสิทธิ์)')).toBeTruthy();
    expect(screen.getAllByText(/ฝ่ายผลิต \(PD\)/).length).toBeGreaterThan(0);
  });

  it('an all-department user (allowedDepartments *) chooses among every ACTIVE department', () => {
    open(plantManagerAll);
    expect(optionCodes()).toEqual(['PD', 'QC', 'MGT']);
  });

  it('a department of the user that no longer exists / is inactive is not offered ; one left = locked', () => {
    open({ ...asstTwoDepts, allowedDepartments: ['PD', 'OLD'], assignedDepartments: ['PD', 'OLD'] });
    expect(select()).toBeNull();
    expect(screen.getAllByText(/ฝ่ายผลิต \(PD\)/).length).toBeGreaterThan(0);
  });

  it('editing an existing PR keeps its department locked (ตามเอกสาร) even for a multi-department user', () => {
    const editingPR = { id: 'PR-X', prNo: 'QC001/2026', department: 'QC', purchaseChannel: 'SELF', status: 'DRAFT', items: [] };
    open(asstTwoDepts, { editingPR });
    expect(select()).toBeNull();
    expect(screen.getByText('(ตามเอกสาร)')).toBeTruthy();
  });
});
