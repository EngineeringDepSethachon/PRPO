// @vitest-environment node
// Phase 3 / M10 T2 (FR-01) : server rules for the new role BUFFER ("ผู้ตรวจสอบจัดซื้อ (พี่สุ)") and the new PR status PENDING_BUFFER.
//   rbac.js (normalizeUser / resolvePermissions / PR_FLOWS / canTransitionPR / canEditPrContent / canWriteBudget), scope.js (buildViewer),
//   extra.js (NOTIFICATION_ROLES / isUserTargetOfNotification).
// Decisions (docs/whiteboard.md 2026-10-17) : Q6 reviewer + approver + admin send back / cancel a PR parked at the checker, the checker has no reject / cancel ;
// Q7 level 2, sees every department, cannot allocate budget nor review in place of the reviewer ; Q9 only the checker + admin edit at PENDING_BUFFER.
import { describe, it, expect } from 'vitest';
import {
  normalizeUser, resolvePermissions, canTransitionPR, canEditPrContent, canWriteBudget, canAccessDepartment, authorize,
  PR_FLOWS, PR_KNOWN_STATUSES, PR_PENDING_BUFFER
} from '../functions/_lib/rbac.js';
import { buildViewer, canSeeDocument, canSeeStockLog, canSeeBudgetDepartment, filterDocuments } from '../functions/_lib/scope.js';
import { NOTIFICATION_ROLES, isUserTargetOfNotification } from '../functions/_lib/extra.js';

const U = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  BUFFER: { id: 'U-BF', username: 'p.su', name: 'Su', department: 'ALL', allowedDepartments: '["ALL"]', roleId: 'BUFFER', canonicalRole: 'BUFFER', level: 2 },
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
const ALL = Object.keys(U);
const PB = 'PENDING_BUFFER';

describe('BUFFER : identity and permission flags', () => {
  it('PR_PENDING_BUFFER constant and the status is a known PR status', () => {
    expect(PR_PENDING_BUFFER).toBe(PB);
    expect(PR_KNOWN_STATUSES).toContain(PB);
    // the old statuses are still known
    for (const s of ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'REJECTED_TO_DRAFT', 'REJECTED_TO_L2', 'CANCELLED', 'CLOSED']) {
      expect(PR_KNOWN_STATUSES, s).toContain(s);
    }
  });

  it('isBuffer comes from roleId exactly BUFFER (role_id too), never from level', () => {
    expect(normalizeUser(U.BUFFER).isBuffer).toBe(true);
    expect(normalizeUser({ level: 2, role_id: 'BUFFER' }).isBuffer).toBe(true);
    expect(resolvePermissions(U.BUFFER).isBuffer).toBe(true);
    for (const k of ['L1', 'L2', 'L3', 'ONLINE', 'ADMIN']) {
      expect(normalizeUser(U[k]).isBuffer, k).toBe(false);
      expect(resolvePermissions(U[k]).isBuffer, k).toBe(false);
    }
    // level 2 alone, a title / positionKey / canonicalRole text, a look-alike roleId : not a buffer
    for (const u of [{ level: 2 }, { level: 2, roleId: 'ASST_MANAGER' }, { level: 2, canonicalRole: 'BUFFER' }, { level: 2, positionKey: 'BUFFER' },
      { level: 2, title: 'BUFFER' }, { level: 2, roleId: 'BUFFER_X' }, { level: 2, role: 'BUFFER' }]) {
      expect(normalizeUser(u).isBuffer, JSON.stringify(u)).toBe(false);
    }
    // M10 hardening : the roleId is compared trimmed and case-insensitively ('buffer' is the same role), and a BUFFER account is level 2 even if the row says 99 / 3
    // (a stored 99 must never make it an admin)
    for (const roleId of ['buffer', ' Buffer ']) expect(normalizeUser({ level: 2, roleId }).isBuffer, roleId).toBe(true);
    expect(normalizeUser({ level: 99, roleId: 'BUFFER' })).toMatchObject({ isBuffer: true, isAdmin: false, level: 2 });
    expect(normalizeUser({ level: 3, roleId: 'BUFFER' })).toMatchObject({ isBuffer: true, isAdmin: false, level: 2 });
  });

  it('buffer flags: level 2, sees every department and the budget, cannot review / approve / allocate / issue as online', () => {
    const p = resolvePermissions(U.BUFFER);
    expect(p).toMatchObject({
      level: 2, isAdmin: false, isBuffer: true, canReview: false, canFinalApprove: false, canSetBudget: false, canViewAllDepts: true,
      canViewBudget: true, canViewBudgetMenu: true, canCreatePR: true, canSubmitPR: true, canOnlinePurchase: false, onlineish: false
    });
    // a buffer whose department is not ALL still sees every department (role-based)
    expect(resolvePermissions({ level: 2, roleId: 'BUFFER', department: 'PD' }).canViewAllDepts).toBe(true);
  });

  it('other personas keep their flags (canReview stays level >= 2 for the reviewer and the online level-2 account)', () => {
    expect(resolvePermissions(U.L2)).toMatchObject({ canReview: true, canViewAllDepts: false, isBuffer: false });
    expect(resolvePermissions(U.L3)).toMatchObject({ canReview: true, canFinalApprove: true, isBuffer: false });
    expect(resolvePermissions(U.L1)).toMatchObject({ canReview: false });
  });

  it('canAccessDepartment : the buffer SEES every department (scope) but WRITES only in the departments it is assigned to, like a plain level 2', () => {
    // (U.BUFFER is assigned ALL here ; a buffer assigned only PD does not reach QC)
    for (const d of ['PD', 'QC', 'MGT', 'XX']) expect(canAccessDepartment(U.BUFFER, d), d).toBe(true);
    const pdOnly = { ...U.BUFFER, department: 'PD', allowedDepartments: '["PD"]' };
    expect(canAccessDepartment(pdOnly, 'PD')).toBe(true);
    for (const d of ['QC', 'MGT']) expect(canAccessDepartment(pdOnly, d), d).toBe(false);
    expect(buildViewer(pdOnly).isGlobal).toBe(true); // reading is unchanged
    expect(canAccessDepartment(U.L2, 'QC')).toBe(false);
    expect(canAccessDepartment(U.L2, 'PD')).toBe(true);
  });
});

describe('BUFFER : canWriteBudget / canAllocateBudget', () => {
  it('buffer views the budget but cannot allocate / reset it', () => {
    const exp = { L1: false, L2: true, BUFFER: false, L3: true, ONLINE: false, ADMIN: true };
    for (const k of ALL) expect(canWriteBudget(resolvePermissions(U[k])), k).toBe(exp[k]);
    expect(authorize(U.BUFFER, 'POST', '/api/budgets/allocate')).toBe(false);
    expect(authorize(U.BUFFER, 'POST', '/api/budgets/reset')).toBe(false);
    expect(authorize(U.BUFFER, 'GET', '/api/budgets')).toBe(true);
    expect(authorize(U.L2, 'POST', '/api/budgets/allocate')).toBe(true);
  });

  it('buffer can still write PRs / POs (PUT of the forward) and create a PR', () => {
    expect(authorize(U.BUFFER, 'PUT', '/api/prs/PR1')).toBe(true);
    expect(authorize(U.BUFFER, 'POST', '/api/prs')).toBe(true);
  });
});

describe('BUFFER : PR_FLOWS actors', () => {
  it('every flow uses a known actor (no flow dead because of a typo)', () => {
    const actors = new Set(['any', 'requester', 'reviewer', 'buffer', 'approver', 'reviewerOrApprover']);
    for (const f of PR_FLOWS) expect(actors.has(f.actor), f.action).toBe(true);
  });
});

// [from, to, personas allowed]  (an admin bypasses everything)
const REVIEW_FROM = ['SUBMITTED', 'REJECTED_TO_L2', 'waiting_review', 'pending_review', 'รอตรวจทาน', 'รอตรวจสอบ'];
const TABLE = [
  // reviewer passes a PR on : straight to REVIEWED (no active buffer ; the route decides) or to PENDING_BUFFER. The buffer is NOT a reviewer.
  ...REVIEW_FROM.flatMap((f) => [[f, 'PENDING_BUFFER', ['L2', 'ADMIN']], [f, 'REVIEWED', ['L2', 'ADMIN']]]),
  // the checker forwards to approval
  [PB, 'REVIEWED', ['BUFFER', 'ADMIN']],
  // sent back / cancelled while at the checker (Q6) : reviewer + approver + admin, never the buffer
  [PB, 'REJECTED_TO_DRAFT', ['L2', 'L3', 'ADMIN']],
  [PB, 'CANCELLED', ['L2', 'L3', 'ADMIN']],
  [PB, 'REJECTED_TO_L2', ['L3', 'ADMIN']],
  // nobody but the admin skips the checker straight to approval / PO
  [PB, 'APPROVED', ['ADMIN']],
  [PB, 'PO_ISSUED', ['ADMIN']],
  [PB, 'IN_PROGRESS_ONLINE', ['ADMIN']],
  // and no other move out of PENDING_BUFFER
  [PB, 'SUBMITTED', ['ADMIN']],
  [PB, 'DRAFT', ['ADMIN']],
  [PB, 'CLOSED', ['ADMIN']],
  // the existing moves are unchanged
  ['REVIEWED', 'APPROVED', ['L3', 'ADMIN']],
  ['REVIEWED', 'PO_ISSUED', ['L3', 'ADMIN']],
  ['REVIEWED', 'IN_PROGRESS_ONLINE', ['L3', 'ADMIN']],
  ['REVIEWED', 'REJECTED_TO_DRAFT', ['L3', 'ADMIN']],
  ['REVIEWED', 'REJECTED_TO_L2', ['L3', 'ADMIN']],
  ['REVIEWED', 'CANCELLED', ['L3', 'ADMIN']],
  ['REVIEWED', PB, ['ADMIN']], // never back to the checker
  ['SUBMITTED', 'REJECTED_TO_DRAFT', ['L2', 'ADMIN']],
  ['SUBMITTED', 'CANCELLED', ['L2', 'ADMIN']],
  ['SUBMITTED', 'APPROVED', ['ADMIN']],
  ['DRAFT', 'SUBMITTED', ALL],
  ['DRAFT', PB, ['ADMIN']], // a draft is submitted first
  ['REJECTED_TO_DRAFT', 'SUBMITTED', ALL],
  ['APPROVED', PB, ['ADMIN']],
  ['CANCELLED', PB, []]
];

describe('BUFFER : canTransitionPR table x persona (L1 / L2 / BUFFER / L3 / ONLINE / ADMIN)', () => {
  for (const [from, to, allowed] of TABLE) {
    for (const k of ALL) {
      // ADMIN bypasses every flow, even out of CANCELLED? No : canTransitionPR returns true for admin first.
      const want = k === 'ADMIN' ? true : allowed.includes(k);
      it(`${from} -> ${to} as ${k} -> ${want ? 'allow' : 'deny'}`, () => {
        expect(canTransitionPR(U[k], from, to)).toBe(want);
      });
    }
  }

  it('the buffer has no reject / cancel / review anywhere (only the requester own-draft cancel it shares with every level >= 1 user)', () => {
    const froms = PR_KNOWN_STATUSES.filter((s) => s !== 'DRAFT' && s !== 'REJECTED_TO_DRAFT');
    for (const from of froms) for (const to of ['REJECTED_TO_DRAFT', 'REJECTED_TO_L2', 'CANCELLED']) {
      if (from === to) continue;
      expect(canTransitionPR(U.BUFFER, from, to), `${from} -> ${to}`).toBe(false);
    }
    for (const from of REVIEW_FROM) {
      expect(canTransitionPR(U.BUFFER, from, 'REVIEWED'), from).toBe(false);
      expect(canTransitionPR(U.BUFFER, from, PB), from).toBe(false);
    }
  });

  it('the buffer may only move PENDING_BUFFER -> REVIEWED (and the requester moves every user has, as before)', () => {
    const tos = PR_KNOWN_STATUSES.filter((s) => s !== PB);
    expect(tos.filter((t) => canTransitionPR(U.BUFFER, PB, t))).toEqual(['REVIEWED']);
    // a document the buffer created himself : same requester rules as any level >= 1 user
    expect(canTransitionPR(U.BUFFER, undefined, 'DRAFT')).toBe(true);
    expect(canTransitionPR(U.BUFFER, undefined, 'SUBMITTED')).toBe(true);
    expect(canTransitionPR(U.BUFFER, 'DRAFT', 'SUBMITTED')).toBe(true);
  });

  it('no status change is not a transition (also at PENDING_BUFFER) ; an online purchaser is never a reviewer / approver / buffer', () => {
    for (const k of ALL) expect(canTransitionPR(U[k], PB, PB), k).toBe(true);
    for (const to of ['REVIEWED', 'REJECTED_TO_DRAFT', 'CANCELLED', 'REJECTED_TO_L2']) expect(canTransitionPR(U.ONLINE, PB, to), to).toBe(false);
  });

  it('old PRs (REVIEWED / APPROVED ...) keep their original transitions for the original roles', () => {
    expect(canTransitionPR(U.L2, 'SUBMITTED', 'REVIEWED')).toBe(true);
    expect(canTransitionPR(U.L3, 'SUBMITTED', 'REVIEWED')).toBe(false);
    expect(canTransitionPR(U.L3, 'REVIEWED', 'PO_ISSUED')).toBe(true);
    expect(canTransitionPR(U.L2, 'REVIEWED', 'PO_ISSUED')).toBe(false);
    expect(canTransitionPR(U.L2, 'REVIEWED', 'REJECTED_TO_DRAFT')).toBe(false);
    expect(canTransitionPR(U.L1, 'APPROVED', 'PO_ISSUED')).toBe(true); // PO progress cascade : any
    expect(canTransitionPR(U.BUFFER, 'APPROVED', 'PO_ISSUED')).toBe(true);
  });
});

describe('BUFFER : canEditPrContent per status (Q9)', () => {
  // [status, personas that may edit]
  const EDIT = [
    ['DRAFT', ALL], ['REJECTED_TO_DRAFT', ALL],
    ['SUBMITTED', ['L2', 'ONLINE', 'L3', 'ADMIN']], ['REVIEWED', ['L2', 'ONLINE', 'L3', 'ADMIN']], ['REJECTED_TO_L2', ['L2', 'ONLINE', 'L3', 'ADMIN']],
    [PB, ['BUFFER', 'ADMIN']],
    ['APPROVED', ['ADMIN']], ['PO_ISSUED', ['ADMIN']], ['IN_PROGRESS_ONLINE', ['ADMIN']], ['CLOSED', ['ADMIN']], ['CANCELLED', ['ADMIN']], ['SOMETHING_ELSE', ['ADMIN']]
  ];
  for (const [status, allowed] of EDIT) {
    for (const k of ALL) {
      it(`${status} as ${k} -> ${allowed.includes(k) ? 'edit' : 'frozen'}`, () => {
        expect(canEditPrContent(U[k], status)).toBe(allowed.includes(k));
      });
    }
  }

  it('status text is trimmed / case-insensitive ; nothing / null is frozen for a non-admin', () => {
    expect(canEditPrContent(U.BUFFER, ' pending_buffer ')).toBe(true);
    expect(canEditPrContent(U.L2, 'pending_buffer')).toBe(false);
    expect(canEditPrContent(U.L3, 'Pending_Buffer')).toBe(false);
    expect(canEditPrContent(U.BUFFER, 'submitted')).toBe(false);
    expect(canEditPrContent(U.BUFFER, undefined)).toBe(false);
    expect(canEditPrContent(U.BUFFER, null)).toBe(false);
    expect(canEditPrContent(U.ADMIN, undefined)).toBe(true);
  });
});

describe('BUFFER : scope.buildViewer / document + stock + budget visibility', () => {
  it('buffer is global (sees every department), not a reviewer ; a plain level 2 is still a reviewer, not global', () => {
    const b = buildViewer(U.BUFFER);
    expect(b).toMatchObject({ isGlobal: true, isReviewer: false, level: 2, roleId: 'BUFFER', canViewAllDepts: true, onlineish: false });
    // role-based : a buffer account bound to one department is still global
    expect(buildViewer({ ...U.BUFFER, department: 'PD', allowedDepartments: '["PD"]' })).toMatchObject({ isGlobal: true, isReviewer: false });
    const l2 = buildViewer(U.L2);
    expect(l2).toMatchObject({ isGlobal: false, isReviewer: true });
    expect(buildViewer(U.L3)).toMatchObject({ isGlobal: true });
    expect(buildViewer(U.L1)).toMatchObject({ isGlobal: false, isReviewer: false });
    expect(buildViewer(U.ONLINE)).toMatchObject({ isGlobal: true });
  });

  it('buffer sees PRs / POs of every department and every stock log ; level 2 of PD still only sees PD (and the budget departments)', () => {
    const docs = [
      { id: 'a', department: 'PD', status: PB }, { id: 'b', department: 'QC', status: PB }, { id: 'c', department: 'MGT', status: 'REVIEWED' },
      { id: 'd', department: 'XX', status: 'SUBMITTED' }, { id: 'e', department: '', status: 'DRAFT' }
    ];
    const vb = buildViewer({ ...U.BUFFER, department: 'PD', allowedDepartments: '["PD"]' });
    expect(filterDocuments(vb, docs).map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(canSeeDocument(buildViewer(U.BUFFER), { department: 'QC', status: PB })).toBe(true);
    expect(canSeeStockLog(vb, { department: 'QC' })).toBe(true);
    expect(canSeeBudgetDepartment(vb, 'QC')).toBe(true);
    // the plain requester of PD does not
    const v1 = buildViewer(U.L1);
    expect(canSeeDocument(v1, { department: 'QC', status: PB, requestedBy: 'someone' })).toBe(false);
    expect(canSeeDocument(v1, { department: 'PD', status: PB })).toBe(true);
  });
});

describe('BUFFER : notifications', () => {
  // the viewer is the login-shaped user (formatSafeUser) : roleId / canonicalRole / level / department / flags
  const safe = (k, extra = {}) => ({ ...U[k], isAdmin: k === 'ADMIN', canViewAllDepts: k === 'BUFFER' || k === 'L3' || k === 'ADMIN' || k === 'ONLINE', ...extra });
  const note = (targetRole, targetDepartment = 'ALL') => ({ id: 'N1', targetRole, targetDepartment });

  it('BUFFER is a notification role the client/server may produce', () => {
    expect(NOTIFICATION_ROLES.has('BUFFER')).toBe(true);
    expect(NOTIFICATION_ROLES.has('APPROVER')).toBe(true); // the old ones stay
  });

  it('targetRole BUFFER : only roleId BUFFER (+ admin), whatever the department of the PR', () => {
    for (const dept of ['ALL', 'PD', 'QC', 'MGT']) {
      const n = note('BUFFER', dept);
      expect(isUserTargetOfNotification(n, safe('BUFFER')), `buffer ${dept}`).toBe(true);
      expect(isUserTargetOfNotification(n, safe('ADMIN')), `admin ${dept}`).toBe(true);
      for (const k of ['L1', 'L2', 'L3', 'ONLINE']) expect(isUserTargetOfNotification(n, safe(k)), `${k} ${dept}`).toBe(false);
    }
    // targetRoles array form and lower case
    expect(isUserTargetOfNotification({ targetRoles: ['buffer'], targetDepartment: 'PD' }, safe('BUFFER'))).toBe(true);
    expect(isUserTargetOfNotification({ targetRoles: ['buffer'], targetDepartment: 'PD' }, safe('L3'))).toBe(false);
    // level 2 alone is not enough, even with the reviewer flags set on the account
    expect(isUserTargetOfNotification(note('BUFFER'), safe('L2', { canReview: true }))).toBe(false);
    // a manager / approver level never receives it
    expect(isUserTargetOfNotification(note('BUFFER'), safe('L3', { canReview: true, canFinalApprove: true }))).toBe(false);
  });

  it('the buffer does not receive Approver / Reviewer / manager notifications just because it is level 2 (or carries canReview)', () => {
    const buf = safe('BUFFER', { canReview: true, canFinalApprove: false });
    for (const role of ['APPROVER', 'REVIEWER', 'ASST_MANAGER', 'PLANT_MANAGER', 'MANAGER']) {
      for (const dept of ['ALL', 'PD', 'QC']) {
        expect(isUserTargetOfNotification(note(role, dept), buf), `${role} ${dept}`).toBe(false);
      }
    }
    // also when the account sits in the MGT department (the approver/MGT shortcut)
    const mgt = safe('BUFFER', { department: 'MGT', canReview: true });
    for (const role of ['APPROVER', 'REVIEWER']) expect(isUserTargetOfNotification(note(role, 'PD'), mgt), role).toBe(false);
    // while the real reviewer / approver still do (unchanged)
    expect(isUserTargetOfNotification(note('APPROVER', 'QC'), safe('L3', { canReview: true, canFinalApprove: true }))).toBe(true);
    expect(isUserTargetOfNotification(note('APPROVER', 'PD'), safe('L2', { canReview: true }))).toBe(true);
    expect(isUserTargetOfNotification(note('REVIEWER', 'PD'), safe('L2', { canReview: true }))).toBe(true);
  });

  it('broadcast (ALL) still reaches the buffer and a requester target does not', () => {
    expect(isUserTargetOfNotification(note('ALL'), safe('BUFFER'))).toBe(true);
    expect(isUserTargetOfNotification(note('REQUESTER', 'PD'), safe('BUFFER'))).toBe(false);
  });
});
