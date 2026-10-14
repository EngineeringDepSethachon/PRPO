// T4.6: the client's "is admin" test follows the server rule (level >= 99 or roleId === 'ADMIN') in cloudflare mode only ;
// mock / gas keep the legacy expression (username 'admin', role text ...).
import { describe, it, expect, afterEach, vi } from 'vitest';
import './setup.js';
import { isAdminUser } from '../src/utils/adminRule';
import { canAccessDepartmentData, getUserAccessibleDepartments } from '../src/utils/permissions';
import { notificationService } from '../src/services/notificationService';
import { getRolePermissionsChecklist, DEFAULT_EMPLOYEE_ACCOUNTS } from '../src/services/authService';

const NOT_ADMIN = [
  { level: 1, username: 'admin', roleId: 'REQUESTER_PD', department: 'PD' },
  { level: 1, role: 'admin', roleId: 'REQUESTER_PD', department: 'PD' },
  { level: 1, canonicalRole: 'ADMIN', roleId: 'REQUESTER_PD', department: 'PD' },
  { level: 1, title: 'System ADMIN', roleId: 'REQUESTER_PD', department: 'PD' },
  { level: 3, roleId: 'SUPER_ADMIN', department: 'PD' }
];
const ADMIN = [
  { level: 99, roleId: 'X' },
  { level: 1, roleId: 'ADMIN' },
  { level: 1, role_id: 'ADMIN' },
  { isAdmin: true, level: 1 },
  { id: 'ADMIN' } // a role object from resolveUserPermissions
];

describe('client admin rule', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('cloudflare mode : exactly the server rule', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    for (const u of NOT_ADMIN) {
      expect(isAdminUser(u, true), JSON.stringify(u)).toBe(false); // the legacy flag is ignored
      expect(canAccessDepartmentData(u, 'QC'), JSON.stringify(u)).toBe(false); // department gate no longer opens for them
    }
    for (const u of ADMIN) {
      expect(isAdminUser(u, false), JSON.stringify(u)).toBe(true);
    }
    expect(canAccessDepartmentData({ level: 1, roleId: 'ADMIN', department: 'PD' }, 'QC')).toBe(true);
    expect(getUserAccessibleDepartments({ level: 1, username: 'admin', roleId: 'REQUESTER_PD', department: 'PD' }, ['PD', 'QC'])).toEqual(['PD']);
    expect(getUserAccessibleDepartments({ level: 99, roleId: 'ADMIN', department: 'ALL' }, ['PD', 'QC'])).toEqual(['PD', 'QC']);
    // notification target + permission checklist
    expect(notificationService.isNotificationTarget({ targetRole: 'APPROVER', targetDepartment: 'QC' }, { level: 1, username: 'admin', roleId: 'REQUESTER_PD', department: 'PD' })).toBe(false);
    expect(notificationService.isNotificationTarget({ targetRole: 'APPROVER', targetDepartment: 'QC' }, { level: 99, roleId: 'ADMIN' })).toBe(true);
    const checklist = (u) => getRolePermissionsChecklist(u).filter((x) => x.allowed).length;
    expect(checklist({ level: 1, username: 'admin', roleId: 'REQUESTER_PD', canonicalRole: 'ADMIN' })).toBeLessThan(checklist({ level: 99, roleId: 'ADMIN' }));
  });

  it('mock / gas mode : legacy behaviour is unchanged (username admin / role text still count)', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    for (const u of [{ level: 1, username: 'admin', roleId: 'REQUESTER_PD' }, { level: 1, role: 'admin' }]) {
      expect(canAccessDepartmentData({ ...u, department: 'PD' }, 'QC'), JSON.stringify(u)).toBe(true);
    }
    expect(isAdminUser({ level: 1 }, true)).toBe(true);
    expect(isAdminUser({ level: 1 }, false)).toBe(false);
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    expect(isAdminUser({ level: 1 }, true)).toBe(true);
  });

  it('the sample admin account is still an admin in every mode (roleId ADMIN, level 99)', () => {
    const admin = DEFAULT_EMPLOYEE_ACCOUNTS.find((u) => u.username === 'admin');
    expect(admin).toMatchObject({ roleId: 'ADMIN', level: 99 });
    for (const mode of ['mock', 'gas', 'cloudflare']) {
      vi.stubEnv('VITE_BACKEND_MODE', mode);
      expect(isAdminUser(admin, true), mode).toBe(true);
      expect(canAccessDepartmentData({ ...admin, department: 'PD' }, 'QC'), mode).toBe(true);
    }
  });
});
