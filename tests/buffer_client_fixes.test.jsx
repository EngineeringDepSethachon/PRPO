// @vitest-environment jsdom
// M10 client fixes for the purchasing checker "พี่สุ" (roleId BUFFER, level 2) :
//   BUG-5  BudgetView : BUFFER may view the budget but never sees the set / allocate buttons (decision Q7)
//   AuthContext : normalizeRole('BUFFER') -> canonical BUFFER (not REQUESTER) ; hasRole / canAccess / canAccessDepartment ; route guards
//   read-only screens : stock adjust / stock-in buttons and the product remark editor are hidden from BUFFER
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import './setup.js';

import { normalizeRole, CANONICAL_ROLES, PERMISSIONS, AuthProvider, AUTH_STORAGE_KEY, useAuth } from '../src/context/AuthContext.jsx';
import ProtectedRoute from '../src/components/common/ProtectedRoute.jsx';
import BudgetView from '../src/views/BudgetView';
import MasterDataView from '../src/views/MasterDataView';
import StockCardView from '../src/views/StockCardView';
import ProductRemarkDrawer from '../src/components/stock/ProductRemarkDrawer';
import { storageService } from '../src/services/storageService';
import { budgetService } from '../src/services/budgetService';
import { resolveUserPermissions } from '../src/config/constants';

// the shape a real login session has for the BUFFER account (authService spreads resolveUserPermissions) ; a session saved before this fix
// carries canonicalRole REQUESTER
const bufferUser = {
  ...resolveUserPermissions({ roleId: 'BUFFER', level: 2, department: 'MGT', departments: ['*'], name: 'พี่สุ', title: 'ผู้ตรวจสอบจัดซื้อ (พี่สุ)' }),
  username: 'su.buffer',
  canonicalRole: 'REQUESTER'
};

describe('AuthContext.normalizeRole : BUFFER is its own canonical role', () => {
  it('string, roleId, positionKey and a stale stored canonicalRole all give BUFFER', () => {
    expect(normalizeRole('BUFFER')).toBe(CANONICAL_ROLES.BUFFER);
    expect(normalizeRole('buffer')).toBe('BUFFER');
    expect(normalizeRole({ roleId: 'BUFFER' })).toBe('BUFFER');
    expect(normalizeRole({ positionKey: 'BUFFER', level: 2 })).toBe('BUFFER');
    expect(normalizeRole(bufferUser)).toBe('BUFFER'); // canonicalRole REQUESTER from an old session is overridden
  });

  it('every other role keeps its old answer', () => {
    expect(normalizeRole('ASST_MANAGER')).toBe('REVIEWER');
    expect(normalizeRole({ roleId: 'PLANT_MANAGER' })).toBe('APPROVER');
    expect(normalizeRole({ roleId: 'REQUESTER_PD' })).toBe('REQUESTER');
    expect(normalizeRole({ roleId: 'ONLINE_PURCHASER' })).toBe('PURCHASER');
    expect(normalizeRole({ roleId: 'ADMIN' })).toBe('ADMIN');
    expect(normalizeRole(null)).toBe('REQUESTER');
    expect(normalizeRole('SOMETHING_ELSE')).toBe('REQUESTER');
  });

  it('PERMISSIONS : BUFFER creates PRs, reads the budget and master data - and does not review / approve / allocate / administer', () => {
    expect(PERMISSIONS.PR_CREATE).toContain('BUFFER');
    expect(PERMISSIONS.BUDGET_VIEW).toContain('BUFFER');
    expect(PERMISSIONS.MASTER_DATA).toContain('BUFFER');
    for (const key of ['PR_APPROVE', 'BUDGET_MANAGE', 'SYSTEM_ADMIN', 'ONLINE_PROCURE', 'CLAIM_RESOLVE', 'GRN_RECEIVE']) {
      expect(PERMISSIONS[key], key).not.toContain('BUFFER');
    }
  });
});

describe('AuthContext guards with a BUFFER session', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  const Probe = () => {
    const a = useAuth();
    return (
      <pre data-probe="1">{JSON.stringify({
        canonical: a.canonicalRole,
        hasBuffer: a.hasRole('BUFFER'),
        hasRequester: a.hasRole('REQUESTER'),
        hasReviewer: a.hasRole(['REVIEWER', 'APPROVER']),
        prCreate: a.canAccess('PR_CREATE'),
        budgetView: a.canAccess('BUDGET_VIEW'),
        budgetManage: a.canAccess('BUDGET_MANAGE'),
        prApprove: a.canAccess('PR_APPROVE'),
        sysAdmin: a.canAccess('SYSTEM_ADMIN'),
        masterData: a.canAccess('MASTER_DATA'),
        deptQC: a.canAccessDepartment('QC'),
        deptPD: a.canAccessDepartment('PD')
      })}</pre>
    );
  };

  const probe = () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(bufferUser));
    const html = renderToStaticMarkup(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
    const m = html.match(/<pre data-probe="1">([\s\S]*?)<\/pre>/);
    return JSON.parse(m[1].replace(/&quot;/g, '"'));
  };

  it('hasRole / canAccess / canAccessDepartment see the BUFFER role correctly', () => {
    expect(probe()).toEqual({
      canonical: 'BUFFER', hasBuffer: true, hasRequester: false, hasReviewer: false,
      prCreate: true, budgetView: true, budgetManage: false, prApprove: false, sysAdmin: false, masterData: true,
      deptQC: true, deptPD: true
    });
  });

  const guard = (guardProps, label = 'ALLOWED') => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(bufferUser));
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={['/x']}>
        <AuthProvider>
          <Routes>
            <Route path="/x" element={<ProtectedRoute {...guardProps}><div>{label}</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
  };

  it('BUFFER enters PR create, the budget page (read), master data and plain pages (PR list / workspace / stock)', () => {
    expect(guard({ requiredPermission: 'PR_CREATE' })).toContain('ALLOWED');
    expect(guard({ requiredPermission: 'BUDGET_VIEW' })).toContain('ALLOWED');
    expect(guard({ allowedRoles: ['REQUESTER', 'REVIEWER', 'PURCHASER', 'APPROVER', 'BUFFER', 'ADMIN'], disallowOnlinePurchaser: true })).toContain('ALLOWED');
    expect(guard({ disallowOnlinePurchaser: true })).toContain('ALLOWED'); // /my-workspace, /inventory/quick-issue
    expect(guard({})).toContain('ALLOWED'); // /prs, /pos, /inventory/stock-card carry no guard at all
  });

  it('BUFFER does not enter the admin pages, the approve gate or the online-procurement page', () => {
    for (const requiredPermission of ['SYSTEM_ADMIN', 'PR_APPROVE', 'ONLINE_PROCURE']) {
      const html = guard({ requiredPermission });
      expect(html, requiredPermission).not.toContain('ALLOWED');
      expect(html, requiredPermission).toContain('403 Access Denied');
    }
  });
});

describe('BUG-5 BudgetView : BUFFER views the budget, never sets it', () => {
  const BTN = 'จัดสรรงบประมาณประจำเดือน';
  const WAIT = 'รอการจัดสรรงบประมาณจาก Asst. Manager';
  const render = (user) => renderToStaticMarkup(
    <MemoryRouter initialEntries={['/budget?month=2030-01']}>
      <BudgetView currentUser={user} prs={[]} pos={[]} />
    </MemoryRouter>
  );

  beforeEach(() => {
    localStorage.clear();
    storageService.resetData();
    budgetService.resetBudgetData();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  for (const mode of ['mock', 'cloudflare']) {
    it(`${mode} mode : the session shape of the BUFFER account gets no allocate / edit button`, () => {
      vi.stubEnv('VITE_BACKEND_MODE', mode);
      const html = render(bufferUser);
      expect(html).not.toContain(BTN);
      expect(html).toContain(WAIT);
    });

    it(`${mode} mode : a bare { roleId: 'BUFFER', level: 2 } user gets none either, an Asst. Manager of the same level still does`, () => {
      vi.stubEnv('VITE_BACKEND_MODE', mode);
      expect(render({ id: 'BUFFER', roleId: 'BUFFER', level: 2, canViewBudget: true, assignedDepartments: ['*'] })).not.toContain(BTN);
      expect(render({ id: 'ASST_MANAGER', roleId: 'ASST_MANAGER', level: 2, canViewBudget: true, assignedDepartments: ['PD'] })).toContain(BTN);
    });
  }
});

describe('read-only screens for BUFFER (hidden write buttons)', () => {
  const asst = { id: 'ASST_MANAGER', roleId: 'ASST_MANAGER', level: 2, canReceiveGoods: false, department: 'PD', departments: ['PD'], canViewAllDepts: true };
  const stock = (role) => renderToStaticMarkup(
    <MemoryRouter><StockCardView products={[]} storageLocations={[]} stockLogs={[]} pos={[]} departments={[]} currentRole={role} /></MemoryRouter>
  );

  beforeEach(() => { localStorage.clear(); storageService.resetData(); });
  afterEach(() => { cleanup(); });

  it('stock card : "ปรับปรุงยอด" / "รับเข้าคลัง" are shown to a reviewer, not to BUFFER (even when a flag would open them)', () => {
    expect(stock(asst)).toContain('ปรับปรุงยอด');
    expect(stock(bufferUser)).not.toContain('ปรับปรุงยอด');
    expect(stock(bufferUser)).not.toContain('รับเข้าคลัง');
    expect(stock({ ...bufferUser, canReceiveGoods: true })).not.toContain('รับเข้าคลัง');
  });

  it('product remark drawer : the edit button is for others, not for BUFFER', () => {
    const product = { id: 'P1', code: 'P1', name: 'ถุงมือ', category: 'PD', remark: 'ห้ามเปลี่ยนยี่ห้อ' };
    const open = (role) => rtlRender(<ProductRemarkDrawer isOpen product={product} currentRole={role} onClose={() => {}} onRefresh={() => {}} />);
    open({ id: 'ADMIN', roleId: 'ADMIN', level: 99 });
    expect(screen.queryByText('แก้ไขข้อความ')).not.toBeNull();
    cleanup();
    open(bufferUser);
    expect(screen.queryByText('แก้ไขข้อความ')).toBeNull();
    expect(screen.queryByText('ห้ามเปลี่ยนยี่ห้อ')).not.toBeNull(); // still readable
  });
});

describe('M10 MasterDataView : BUFFER reads master data, no add / edit / delete / reactivate buttons', () => {
  const mdProducts = [{ id: 'p1', code: 'MAT-PD-001', name: 'วัตถุดิบ PD', department: 'PD', category: 'PD', price: 100 }];
  const mdVendors = [{ id: 'v1', code: 'VEN-001', name: 'Vendor PD', department: 'PD' }];
  const mdLocations = [{ id: 'l1', name: 'คลัง PD ชั้น 1', department: 'PD' }];
  const mdUnits = [{ id: 'u1', name: 'ไลน์การผลิต 1', department: 'PD', status: 'ACTIVE' }];
  const WRITE_TITLE = /title="(?:แก้ไข|ลบ|ไม่มีสิทธิ์แก้ไข|ไม่มีสิทธิ์ลบ|เปิดใช้งานใหม่)/;
  const render = (role, tab) => renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/master-data?tab=${tab}`]}>
      <MasterDataView
        currentUser={role}
        currentRole={role}
        departments={[]}
        products={mdProducts}
        vendors={mdVendors}
        storageLocations={mdLocations}
        usageUnits={mdUnits}
      />
    </MemoryRouter>
  );
  const ADD = { catalog: 'เพิ่มสินค้าใหม่', vendors: 'เพิ่มผู้ขายใหม่', locations: 'เพิ่มจุดจัดเก็บใหม่', rooms: 'เพิ่มหน่วยเบิกใหม่' };

  it('BUFFER (พี่สุ) : every master tab is readable but shows no add button and no row edit / delete button', () => {
    const bufferRole = { ...bufferUser, canManageMaster: false, canDeleteMaster: false };
    for (const tab of Object.keys(ADD)) {
      const html = render(bufferRole, tab);
      expect(html, tab).not.toContain(ADD[tab]);
      expect(html, tab).not.toMatch(WRITE_TITLE);
    }
    // still readable
    expect(render(bufferRole, 'catalog')).toContain('MAT-PD-001');
    expect(render(bufferRole, 'vendors')).toContain('VEN-001');
  });

  it('BUFFER session shape from the bare roles table (canManageMaster false) gets the same read-only view', () => {
    const bare = { id: 'BUFFER', roleId: 'BUFFER', level: 2, canViewAllDepts: true, assignedDepartments: ['*'] };
    for (const tab of Object.keys(ADD)) {
      const html = render(bare, tab);
      expect(html, tab).not.toContain(ADD[tab]);
      expect(html, tab).not.toMatch(WRITE_TITLE);
    }
  });

  it('a non-BUFFER role with canManageMaster false keeps the buttons (UX unchanged outside BUFFER) ; an assistant manager keeps them too', () => {
    const noWriteFlag = { id: 'OTHER', roleId: 'ONLINE_PURCHASER', level: 2, canManageMaster: false, canDeleteMaster: false, canViewAllDepts: true };
    for (const tab of Object.keys(ADD)) {
      expect(render(noWriteFlag, tab), tab).toContain(ADD[tab]);
    }
    const asst = { id: 'ASST_MANAGER', roleId: 'ASST_MANAGER', level: 2, canManageMaster: true, canDeleteMaster: false, canViewAllDepts: true, department: 'PD', departments: ['PD'] };
    for (const tab of Object.keys(ADD)) {
      expect(render(asst, tab), tab).toContain(ADD[tab]);
    }
    expect(render(asst, 'catalog')).toMatch(/title="แก้ไขสินค้า"/);
  });
});
