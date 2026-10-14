import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import BudgetView from '../src/views/BudgetView';
import { storageService } from '../src/services/storageService';
import { budgetService } from '../src/services/budgetService';

// Lets a test simulate an admin impersonating another role (auth.isAdmin follows originalUser).
let mockAuth = null;
vi.mock('../src/context/AuthContext', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useAuth: () => { if (mockAuth) return mockAuth; throw new Error('no auth'); } };
});

// S2: bootstrap gives admin canOnlinePurchase=true; admin must still be able to allocate monthly budget.
const render = (user) => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/budget?month=2030-01']}>
    <BudgetView currentUser={user} prs={[]} pos={[]} />
  </MemoryRouter>
);
const BTN = 'จัดสรรงบประมาณประจำเดือน';
const WAIT = 'รอการจัดสรรงบประมาณจาก Asst. Manager';

describe('BudgetView allocate permission (S2)', () => {
  beforeEach(() => {
    localStorage.clear();
    storageService.resetData();
    budgetService.resetBudgetData();
  });

  it('admin with canOnlinePurchase=true sees the allocate button', () => {
    const html = render({ id: 'ADMIN', roleId: 'ADMIN', level: 99, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
    expect(html).toContain(BTN);
    expect(html).not.toContain(WAIT);
  });

  it('online purchaser does not see the allocate button', () => {
    const html = render({ id: 'ONLINE_PURCHASER', roleId: 'ONLINE_PURCHASER', level: 1, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
    expect(html).not.toContain(BTN);
    expect(html).toContain(WAIT);
  });

  it('asst manager still sees the allocate button', () => {
    const html = render({ id: 'ASST_MANAGER', roleId: 'ASST_MANAGER', level: 2, canViewBudget: true, assignedDepartments: ['PD'] });
    expect(html).toContain(BTN);
  });

  it('mock mode: canAccess(BUDGET_MANAGE) still grants the button', () => {
    mockAuth = { canAccess: () => true };
    try {
      const html = render({ id: 'X', roleId: 'X', level: 1, canViewBudget: true, assignedDepartments: ['ALL'] });
      expect(html).toContain(BTN);
    } finally { mockAuth = null; }
  });

  it('mock mode: legacy role "admin" user still sees the button', () => {
    const html = render({ id: 'X', roleId: 'X', role: 'admin', level: 1, canViewBudget: true, assignedDepartments: ['ALL'] });
    expect(html).toContain(BTN);
  });

  describe('Cloudflare mode (server admin rule: level>=99 or roleId ADMIN exactly)', () => {
    beforeEach(() => { vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('real admin with canOnlinePurchase sees the button', () => {
      const html = render({ id: 'ADMIN', roleId: 'ADMIN', level: 99, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
      expect(html).toContain(BTN);
    });
    it('level 99 with another roleId sees the button', () => {
      const html = render({ id: 'SUPER', roleId: 'SUPER', level: 99, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
      expect(html).toContain(BTN);
    });
    it('ADMIN_ASSISTANT + canOnlinePurchase does not see the button', () => {
      const html = render({ id: 'ADMIN_ASSISTANT', roleId: 'ADMIN_ASSISTANT', level: 2, canViewBudget: true, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
      expect(html).not.toContain(BTN);
    });
    it('ADMIN_ASSISTANT level 1 with real-like canAccess (canonicalRole ADMIN -> true) does not see the button', () => {
      mockAuth = { canAccess: () => true };
      try {
        const html = render({ id: 'ADMIN_ASSISTANT', roleId: 'ADMIN_ASSISTANT', canonicalRole: 'ADMIN', level: 1, canViewBudget: true, assignedDepartments: ['ALL'] });
        expect(html).not.toContain(BTN);
      } finally { mockAuth = null; }
    });
    it('ADMIN_ASSISTANT level 1 (not online) does not see the button', () => {
      const html = render({ id: 'ADMIN_ASSISTANT', roleId: 'ADMIN_ASSISTANT', role: 'admin', canonicalRole: 'ADMIN', username: 'admin', level: 1, canViewBudget: true, assignedDepartments: ['ALL'] });
      expect(html).not.toContain(BTN);
    });
    it('admin impersonating a Requester does not see the button', () => {
      mockAuth = { isAdmin: true, currentUser: { roleId: 'ADMIN', level: 99 } };
      mockAuth.canAccess = () => false;
      try {
        const html = render({ id: 'REQUESTER', roleId: 'REQUESTER', level: 1, canViewBudget: true, assignedDepartments: ['ALL'] });
        expect(html).not.toContain(BTN);
      } finally { mockAuth = null; }
    });
    it('ONLINE_PURCHASER with legacy role "admin" does not see the button', () => {
      const html = render({ id: 'ONLINE_PURCHASER', roleId: 'ONLINE_PURCHASER', role: 'admin', level: 1, canOnlinePurchase: true, assignedDepartments: ['ALL'] });
      expect(html).not.toContain(BTN);
    });
  });
});
