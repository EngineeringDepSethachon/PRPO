import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import './setup.js';

import { ROLES, PR_STATUS, resolveUserPermissions } from '../src/config/constants';

const readSrc = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('T4 FR-01 client constants: BUFFER role + PENDING_BUFFER status', () => {
  it('ROLES.BUFFER exists with level 2, ALL dept, canViewAllDepts, no review/final approve', () => {
    expect(ROLES.BUFFER).toBeDefined();
    expect(ROLES.BUFFER.id).toBe('BUFFER');
    expect(ROLES.BUFFER.level).toBe(2);
    expect(ROLES.BUFFER.department).toBe('ALL');
    expect(ROLES.BUFFER.canViewAllDepts).toBe(true);
    expect(ROLES.BUFFER.canReview).toBe(false);
    expect(ROLES.BUFFER.canFinalApprove).toBe(false);
    expect(ROLES.BUFFER.canSetBudget).toBe(false);
    expect(ROLES.BUFFER.canManageMaster).toBe(false); // M10: master data read-only
    expect(ROLES.BUFFER.canDeleteMaster).toBe(false);
  });

  it('resolveUserPermissions({roleId:"BUFFER", level:2}) gives isBuffer true, canReview false, canViewAllDepts true', () => {
    const p = resolveUserPermissions({ roleId: 'BUFFER', level: 2 });
    expect(p.isBuffer).toBe(true);
    expect(p.canReview).toBe(false);
    expect(p.canFinalApprove).toBe(false);
    expect(p.canSetBudget).toBe(false);
    expect(p.canViewAllDepts).toBe(true);
    expect(p.canViewBudget).toBe(true);
    expect(p.canCreatePR).toBe(true);
    expect(p.canManageMaster).toBe(false); // M10
    expect(p.canDeleteMaster).toBe(false);
  });

  it('non-BUFFER level 2 and level 1 users keep canManageMaster / canDeleteMaster (rule unchanged for others)', () => {
    const asst = resolveUserPermissions({ roleId: 'ASST_MANAGER', level: 2, department: 'PD' });
    expect(asst.canManageMaster).toBe(true);
    expect(asst.canDeleteMaster).toBe(true); // resolveUserPermissions : level >= 1 (unchanged)
    const req = resolveUserPermissions({ roleId: 'REQUESTER_PD', level: 1, department: 'PD' });
    expect(req.canManageMaster).toBe(true);
    expect(req.canDeleteMaster).toBe(true);
  });

  it('non-BUFFER level 2 user keeps canReview true and isBuffer false', () => {
    const p = resolveUserPermissions({ roleId: 'ASST_MANAGER', level: 2, department: 'PD' });
    expect(p.isBuffer).toBe(false);
    expect(p.canReview).toBe(true);
  });

  it('PR_STATUS.PENDING_BUFFER has label "รอพี่สุตรวจสอบ" and an id', () => {
    expect(PR_STATUS.PENDING_BUFFER).toBeDefined();
    expect(PR_STATUS.PENDING_BUFFER.id).toBe('PENDING_BUFFER');
    expect(PR_STATUS.PENDING_BUFFER.label).toBe('รอพี่สุตรวจสอบ');
    expect(typeof PR_STATUS.PENDING_BUFFER.color).toBe('string');
  });

  it('UserMasterView ROLE_OPTIONS source contains BUFFER at level 2', () => {
    // ROLE_OPTIONS is module-private in UserMasterView; verify through the source text
    const src = readSrc('../src/views/admin/UserMasterView.jsx');
    expect(src).toMatch(/id:\s*'BUFFER',\s*label:\s*'ผู้ตรวจสอบจัดซื้อ \(พี่สุ\)'.*level:\s*2/);
  });

  it('UserCRUDModal ROLE_OPTIONS source contains BUFFER at level 2', () => {
    // ROLE_OPTIONS is module-private in UserCRUDModal; verify through the source text
    const src = readSrc('../src/components/admin/UserCRUDModal.jsx');
    expect(src).toMatch(/id:\s*'BUFFER',\s*label:\s*'ผู้ตรวจสอบจัดซื้อ \(พี่สุ\)'.*level:\s*2/);
  });
});
