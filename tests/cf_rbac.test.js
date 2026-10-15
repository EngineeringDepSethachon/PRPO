// @vitest-environment node
// T4.5: server-side RBAC for Cloudflare Functions (functions/_lib/rbac.js + authorize in functions/api/[[route]].js)
// Rules mirror the ORIGINAL client rules (resolveUserPermissions / canAction / views); nothing is added or removed.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveUserPermissions } from '../src/config/constants.js';
import { resolvePermissions, normalizeUser, authorize, matchRule, canTransitionPR, canTransitionPO, PR_FLOWS } from '../functions/_lib/rbac.js';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';

const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  // like the seeded accounts: managers / admin carry allowedDepartments ["*"] (the department gate mirrors the client, level alone does not widen it)
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  L4: { id: 'U-L4', username: 'exec.dir', name: 'Exec', department: 'MGT', allowedDepartments: '["*"]', roleId: 'EXECUTIVE', canonicalRole: 'APPROVER', level: 4 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};

describe('T4.5 rbac.resolvePermissions == src resolveUserPermissions', () => {
  const levels = [1, 2, 3, 4, 99];
  const roleIds = ['REQUESTER_PD', 'ONLINE_PURCHASER', 'ASST_MANAGER', 'PLANT_MANAGER', 'ADMIN', ''];
  const deptSets = [['PD'], ['PD', 'QC'], ['*'], ['ALL']];
  const departments = ['PD', 'ALL', 'MGT'];
  const keys = ['level', 'canCreatePR', 'canSubmitPR', 'canDeleteOwnDraft', 'canReceiveGoods', 'canCloseOwnPO', 'canManageMaster', 'canDeleteMaster',
    'canReview', 'canViewBudget', 'canViewBudgetMenu', 'canViewAllDepts', 'canFinalApprove', 'canSetBudget', 'canOnlinePurchase'];

  it('matches for every level x roleId x department x allowedDepartments combination', () => {
    let n = 0;
    for (const level of levels) for (const roleId of roleIds) for (const department of departments) for (const ds of deptSets) {
      const row = { level, roleId, department, username: 'u', allowedDepartments: JSON.stringify(ds) };
      const norm = normalizeUser(row);
      const client = resolveUserPermissions({ level: norm.level, roleId, department, departments: ds, allowedDepartments: ds });
      const server = resolvePermissions(row);
      for (const k of keys) expect(server[k], `${k} lvl=${level} role=${roleId} dept=${department} ds=${ds}`).toBe(client[k]);
      n++;
    }
    expect(n).toBe(levels.length * roleIds.length * departments.length * deptSets.length);
  });

  it('T4.6 admin = level >= 99 or roleId exactly ADMIN ; username / title / positionKey / canonicalRole text never makes an admin', () => {
    expect(normalizeUser({ level: 1, roleId: 'ADMIN' }).level).toBe(99);
    expect(normalizeUser({ level: 1, role_id: 'ADMIN' }).isAdmin).toBe(true);
    expect(normalizeUser({ level: 99, roleId: 'X' }).isAdmin).toBe(true);
    for (const u of [
      { level: 1, username: 'Admin' }, { level: 1, username: 'admin' },
      { level: 1, title: 'System Administrator ADMIN' }, { level: 1, positionKey: 'ADMIN' }, { level: 1, canonicalRole: 'ADMIN' },
      { level: 3, roleId: 'ADMIN_ASSISTANT' }, { level: 3, roleId: 'admin' }, { level: 1, roleId: 'SUPER_ADMIN' }, { level: 1, role: 'ADMIN' }
    ]) {
      expect(normalizeUser(u).isAdmin, JSON.stringify(u)).toBe(false);
      expect(normalizeUser(u).level).toBe(Number(u.level));
    }
    expect(resolvePermissions({ level: 2, role_id: 'ONLINE_PURCHASER' }).canOnlinePurchase).toBe(true);
    expect(resolvePermissions({}).level).toBe(1);
  });
});

describe('T4.5 endpoint x persona table (authorize)', () => {
  // [method, path, {persona: allowed}]  -- A = everyone
  const ALL = { L1: true, L2: true, ONLINE: true, L3: true, L4: true, ADMIN: true };
  const ADMIN_ONLY = { L1: false, L2: false, ONLINE: false, L3: false, L4: false, ADMIN: true };
  const BUDGETERS = { L1: false, L2: true, ONLINE: false, L3: true, L4: true, ADMIN: true };
  const TABLE = [
    ['GET', '/api/bootstrap', ALL], ['GET', '/api/users', ALL], ['GET', '/api/prs', ALL], ['GET', '/api/pos', ALL],
    ['GET', '/api/products', ALL], ['GET', '/api/budgets', ALL], ['GET', '/api/budget-transactions', ALL], ['GET', '/api/stock-logs', ALL],
    ['POST', '/api/users', ADMIN_ONLY], ['PUT', '/api/users/USR-1', ADMIN_ONLY], ['DELETE', '/api/users/USR-1', ADMIN_ONLY],
    ['POST', '/api/user', ADMIN_ONLY], ['PUT', '/api/users/', ADMIN_ONLY],
    ['POST', '/api/departments', ADMIN_ONLY], ['PUT', '/api/departments/PD', ADMIN_ONLY], ['DELETE', '/api/departments/PD', ADMIN_ONLY],
    ['POST', '/api/products', ALL], ['PUT', '/api/products/P1', ALL], ['POST', '/api/products/batch', ALL], ['DELETE', '/api/products/P1', ALL],
    ['POST', '/api/vendors', ALL], ['DELETE', '/api/vendors/V1', ALL], ['POST', '/api/storage-locations', ALL], ['DELETE', '/api/storage-locations/L1', ALL],
    ['POST', '/api/usage-units', ALL], ['DELETE', '/api/usage-units/U1', ALL],
    ['POST', '/api/budgets/allocate', BUDGETERS], ['POST', '/api/budgets/reset', BUDGETERS], ['POST', '/api/budgets', BUDGETERS],
    ['POST', '/api/budgets/adjust', ALL], ['PUT', '/api/budgets/PD', ALL], // route-level like adjust ; the handler allows non-budget users only a refund credit (cf_docnum_routes.test.js) ['POST', '/api/budget-transactions', ALL],
    ['POST', '/api/prs', ALL], ['PUT', '/api/prs/PR1', ALL], ['DELETE', '/api/prs/PR1', ADMIN_ONLY],
    ['POST', '/api/pos', ALL], ['PUT', '/api/pos/PO1', ALL], ['DELETE', '/api/pos/PO1', ADMIN_ONLY],
    ['POST', '/api/pos/PO1/receive', { L1: true, L2: false, ONLINE: false, L3: false, L4: false, ADMIN: true }],
    ['POST', '/api/receive-goods', { L1: true, L2: false, ONLINE: false, L3: false, L4: false, ADMIN: true }],
    ['POST', '/api/inventory/receive', { L1: true, L2: false, ONLINE: false, L3: false, L4: false, ADMIN: true }],
    ['POST', '/api/pos/PO1/settle', { L1: true, L2: false, ONLINE: true, L3: false, L4: false, ADMIN: true }],
    ['POST', '/api/stock-logs', ALL], ['POST', '/api/stock/issue', ALL],
    ['GET', '/api/audit-logs', ADMIN_ONLY], ['POST', '/api/upload', ALL],
    ['POST', '/api/unknown-write', { L1: false, L2: false, ONLINE: false, L3: false, L4: false, ADMIN: false }]
  ];
  for (const [method, p, expected] of TABLE) {
    for (const [persona, allowed] of Object.entries(expected)) {
      it(`${method} ${p} as ${persona} -> ${allowed ? 'allow' : '403'}`, () => {
        expect(authorize(PERSONAS[persona], method, p)).toBe(allowed);
      });
    }
  }

  it('unknown GET stays open to logged-in users (unchanged); unknown writes fail closed', () => {
    expect(authorize(PERSONAS.L1, 'GET', '/api/whatever')).toBe(true);
    expect(matchRule('POST', '/api/whatever')).toBeNull();
  });

  it('PR transitions follow canAction by current status', () => {
    expect(canTransitionPR(PERSONAS.L1, 'SUBMITTED', 'REVIEWED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L2, 'SUBMITTED', 'REVIEWED')).toBe(true);
    expect(canTransitionPR(PERSONAS.L3, 'SUBMITTED', 'REVIEWED')).toBe(false); // level 3 may not act on the review step
    expect(canTransitionPR(PERSONAS.ONLINE, 'SUBMITTED', 'REVIEWED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L2, 'REVIEWED', 'PO_ISSUED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L3, 'REVIEWED', 'PO_ISSUED')).toBe(true);
    expect(canTransitionPR(PERSONAS.L4, 'REVIEWED', 'PO_ISSUED')).toBe(true);
    expect(canTransitionPR(PERSONAS.L1, 'DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionPR(PERSONAS.ADMIN, 'REVIEWED', 'CANCELLED')).toBe(true);
    expect(canTransitionPR(PERSONAS.L1, 'SUBMITTED', 'SUBMITTED')).toBe(true); // no status change = not a transition
    expect(canTransitionPR(PERSONAS.L1, 'DRAFT', 'APPROVED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L2, 'SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L1, undefined, 'APPROVED')).toBe(false);
    expect(canTransitionPR(PERSONAS.L1, undefined, 'SUBMITTED')).toBe(true);
    expect(canTransitionPR(PERSONAS.L1, 'CANCELLED', 'DRAFT')).toBe(false);
    expect(canTransitionPO(PERSONAS.L3, 'IN_PROGRESS_ONLINE', 'ORDERED')).toBe(false);
    expect(canTransitionPO(PERSONAS.ONLINE, 'IN_PROGRESS_ONLINE', 'ORDERED')).toBe(true);
    expect(canTransitionPO(PERSONAS.ADMIN, 'IN_PROGRESS_ONLINE', 'COMPLETED')).toBe(true);
    expect(canTransitionPO(PERSONAS.L2, 'ORDERED', 'RECEIVED')).toBe(false);
    expect(canTransitionPO(PERSONAS.L1, 'ORDERED', 'RECEIVED')).toBe(true);
    expect(canTransitionPO(PERSONAS.L3, 'ORDERED', 'CLOSED')).toBe(true); // CLOSED is set by several roles (self-claim close, settle, receive)
    expect(canTransitionPO(PERSONAS.ONLINE, 'ORDERED', 'CLOSED')).toBe(true);
  });
});

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.all()); return out; }
  };
}

describe.skipIf(!DatabaseSync)('T4.5 functional (onRequest + migrated sqlite)', () => {
  let sdb; let env; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const one = (q, ...p) => rows(q, ...p)[0];
  // fixtures for the refund rules: a real PR + the validated PR_COMMITMENT ledger row, and a PO carrying the server snapshot
  const seedPr = (prNo, { dept = 'PD', total = 1000, commit = total, status = 'PO_ISSUED' } = {}) => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES (?, ?, ?, ?, ?, '[{\"productId\":\"SP1\",\"qty\":10}]')").run(`id-${prNo}`, prNo, dept, status, total);
    if (commit) sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES (?, ?, ?, 'PR_COMMITMENT', 'PR_COMMITMENT', ?, ?)").run(`K-${prNo}`, dept, dept, -commit, prNo);
  };
  const seedPo = (id, prNo, approved, over = {}) => sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, grandTotal, extraJson) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)")
    .run(id, `PO-${id}`, prNo, over.dept || 'PD', over.status || 'ORDERED', over.grand ?? 99999, JSON.stringify({ approvedTotal: approved }));
  // a PR with its server-written PR_COMMITMENT + a PO carrying the approvedTotal snapshot (the base of every refund cap) ; -> the PO number
  const seedRefundPo = (prNo, id, { dept = 'PD', total = 100000 } = {}) => {
    seedPr(prNo, { dept, total, commit: total });
    seedPo(id, prNo, total, { dept, status: 'ORDERED' });
    return `PO-${id}`;
  };
  const call = async (who, method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(read('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
  });

  it('non-admins get 403 (Thai JSON) on user management and cannot escalate themselves or others', async () => {
    for (const who of ['L1', 'L2', 'ONLINE', 'L3', 'L4']) {
      const self = PERSONAS[who];
      const r = await call(who, 'PUT', `/api/users/${self.id}`, { id: self.id, username: self.username, name: self.name, level: 99, roleId: 'ADMIN', canonicalRole: 'ADMIN' });
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ success: false, error: 'ไม่มีสิทธิ์ดำเนินการนี้' });
      expect(one('SELECT level, roleId FROM users WHERE id = ?', self.id)).toMatchObject({ level: self.level, roleId: self.roleId });
      expect((await call(who, 'PUT', '/api/users/U-L1', { id: 'U-L1', level: 99, roleId: 'ADMIN' })).status).toBe(403);
      expect((await call(who, 'POST', '/api/users', { username: 'evil', name: 'x', level: 99, roleId: 'ADMIN', password: 'Abcdef123!' })).status).toBe(403);
      expect((await call(who, 'PUT', '/api/users/U-AD', { id: 'U-AD', password: 'Hacked-12345' })).status).toBe(403);
      expect((await call(who, 'DELETE', '/api/users/U-AD')).status).toBe(403);
    }
    expect(one('SELECT status, passwordHash FROM users WHERE id = ?', 'U-AD')).toMatchObject({ status: 'ACTIVE', passwordHash: null });
    expect(rows("SELECT id FROM users WHERE username = 'evil'").length).toBe(0);
    expect(one('SELECT level FROM users WHERE id = ?', 'U-L1').level).toBe(1);
  });

  it('admin can manage users (POST/PUT/DELETE)', async () => {
    const c = await call('ADMIN', 'POST', '/api/users', { id: 'U-NEW', username: 'new.user', name: 'New', level: 1, roleId: 'REQUESTER_PD', password: 'Abcdef123!' });
    expect(c.status).toBe(200);
    expect((await call('ADMIN', 'PUT', '/api/users/U-NEW', { id: 'U-NEW', username: 'new.user', name: 'New2', level: 2, roleId: 'ASST_MANAGER' })).status).toBe(200);
    expect(one('SELECT level, name FROM users WHERE id = ?', 'U-NEW')).toMatchObject({ level: 2, name: 'New2' });
    expect((await call('ADMIN', 'DELETE', '/api/users/U-NEW')).status).toBe(200);
  });

  it('budgets: allocate/reset only level>=2 non-online or admin ; adjust by others only as positive refund', async () => {
    expect((await call('L1', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 5 } })).status).toBe(403);
    expect((await call('ONLINE', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 5 } })).status).toBe(403);
    expect((await call('L2', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 5 } })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/budgets/reset', {})).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 999999 })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: -100 })).status).toBe(403);
    // T4.6: giving budget back without the budget permission needs a real PO of the department (docNo)
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 100 })).status).toBe(400);
    const poNo = seedRefundPo('PR-T1', 'T1');
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 100, docNo: poNo })).status).toBe(200);
    expect((await call('L3', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 50 })).status).toBe(200);
  });

  it('PR status transitions are gated by the owner of the step; PO IN_PROGRESS_ONLINE belongs to online purchaser', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('PR1','PR-1','PD','SUBMITTED','[]')").run();
    expect((await call('L1', 'PUT', '/api/prs/PR1', { status: 'REVIEWED' })).status).toBe(403);
    expect(one('SELECT status FROM prs WHERE id = ?', 'PR1').status).toBe('SUBMITTED');
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR1', prNumber: 'PR-1', status: 'APPROVED' })).status).toBe(403);
    expect((await call('L2', 'PUT', '/api/prs/PR1', { status: 'REVIEWED' })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/prs/PR1', { status: 'PO_ISSUED' })).status).toBe(403);
    expect((await call('L3', 'PUT', '/api/prs/PR1', { status: 'PO_ISSUED' })).status).toBe(200);
    expect((await call('L1', 'DELETE', '/api/prs/PR1')).status).toBe(403);

    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO1','PO-1','PD','IN_PROGRESS_ONLINE','[]')").run();
    expect((await call('L3', 'PUT', '/api/pos/PO1', { status: 'COMPLETED' })).status).toBe(403);
    expect((await call('ONLINE', 'PUT', '/api/pos/PO1', { status: 'ORDERED' })).status).toBe(200);
  });

  it('PO status written by the receive endpoint needs the receive right ; claim/close statuses stay open (several roles set them)', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO5','PO-5','PD','ORDERED','[]')").run();
    for (const to of ['RECEIVED', 'PARTIALLY_RECEIVED', 'PARTIAL_RECEIVED']) {
      for (const who of ['L2', 'ONLINE', 'L3']) expect((await call(who, 'PUT', '/api/pos/PO5', { status: to })).status).toBe(403);
      expect((await call('L2', 'POST', '/api/pos', { id: 'PO5', poNumber: 'PO-5', status: to })).status).toBe(403);
    }
    expect((await call('L1', 'PUT', '/api/pos/PO5', { status: 'PARTIALLY_RECEIVED' })).status).toBe(200);
    // client self-claim resolution (reviewer) and online claim resolution (online purchaser) set COMPLETED / CLOSED
    expect((await call('L2', 'PUT', '/api/pos/PO5', { status: 'COMPLETED' })).status).toBe(200);
    expect((await call('ONLINE', 'PUT', '/api/pos/PO5', { status: 'CLOSED' })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/pos/PO5', { status: 'ORDERED' })).status).toBe(403); // a finished PO is not re-opened to "ordered" by a non-admin
    expect((await call('L1', 'PUT', '/api/pos/PO5', { status: 'CLAIM_REPORTED' })).status).toBe(200); // ... only by the claim flow
    sdb.prepare("UPDATE pos SET status = 'ORDERED' WHERE id = 'PO5'").run();
    sdb.prepare("UPDATE pos SET status = 'CANCELLED' WHERE id = 'PO5'").run();
    expect((await call('L1', 'PUT', '/api/pos/PO5', { status: 'ORDERED' })).status).toBe(403);
    expect((await call('L3', 'POST', '/api/pos', { id: 'PO7', poNumber: 'PO-7', status: 'ORDERED' })).status).toBe(400); // T4.5d: a new PO needs an approved PR
    expect((await call('ADMIN', 'POST', '/api/pos', { id: 'PO7', poNumber: 'PO-7', status: 'ORDERED' })).status).toBe(200);
  });

  it('PR_FLOWS / PO_RULES table: every client action is allowed for the roles the client allows, denied for the others', async () => {
    const who = (flow) => ({
      any: ['L1', 'L2', 'ONLINE', 'L3', 'L4', 'ADMIN'],
      requester: ['L1', 'L2', 'ONLINE', 'L3', 'L4', 'ADMIN'],
      reviewer: ['L2', 'ADMIN'],
      approver: ['L3', 'L4', 'ADMIN']
    })[flow.actor];
    for (const f of PR_FLOWS) {
      const froms = f.from === null ? [undefined] : f.from;
      for (const from of froms) for (const to of f.to) for (const persona of Object.keys(PERSONAS)) {
        const ok = who(f).includes(persona);
        expect(canTransitionPR(PERSONAS[persona], from, to), `${f.action}: ${from} -> ${to} as ${persona}`).toBe(ok || (from !== undefined && from === to));
      }
    }
    // rows of the PO table (parity.md c.5) : [from, to, personas allowed]
    const NOT_ONLINE = ['L1', 'L2', 'L3', 'L4', 'ADMIN'];
    const ALLP = Object.keys(PERSONAS);
    const PO_TABLE = [
      ['IN_PROGRESS_ONLINE', 'ORDERED', ['ONLINE', 'ADMIN']],
      ['IN_PROGRESS_ONLINE', 'ORDERED_PENDING_DELIVERY', ['ONLINE', 'ADMIN']],
      ['IN_PROGRESS_ONLINE', 'CANCELLED', NOT_ONLINE],
      ['ISSUED', 'IN_DELIVERY', ALLP],
      ['ORDERED_PENDING_DELIVERY', 'CLOSED', ALLP],
      ['ORDERED', 'PARTIAL', ALLP],
      ['ORDERED', 'CLOSED', ALLP],
      ['ORDERED', 'CLAIM_REPORTED', ALLP],
      // closing a PO with an open claim (decision 2026-10-14) : owner requester (ctx.isOwner, tested below), approver, admin ; online purchaser = online claims
      ['CLAIM_REPORTED', 'COMPLETED', ['ONLINE', 'L3', 'L4', 'ADMIN']],
      ['CLAIM_PENDING', 'COMPLETED', ['ONLINE', 'L3', 'L4', 'ADMIN']],
      ['CLAIM_REPORTED', 'WAITING_DELIVERY_ROUND_2', ALLP],
      ['ORDERED', 'CANCELLED', NOT_ONLINE], // canCancelPO: the online purchaser can never cancel a PO
      ['CLAIM_REPORTED', 'CANCELLED', NOT_ONLINE],
      ['ORDERED', 'RECEIVED', ['L1', 'ADMIN']],
      ['ORDERED', 'PARTIALLY_RECEIVED', ['L1', 'ADMIN']],
      ['CANCELLED', 'ORDERED', ['ADMIN']]
    ];
    for (const [from, to, allowed] of PO_TABLE) for (const persona of ALLP) {
      expect(canTransitionPO(PERSONAS[persona], from, to), `PO ${from} -> ${to} as ${persona}`).toBe(allowed.includes(persona));
    }
  });

  it('known fixes: L3 reject of REVIEWED -> REJECTED_TO_DRAFT ; online claim resolution -> COMPLETED ; online by canonicalRole PURCHASER', () => {
    expect(canTransitionPR(PERSONAS.L3, 'REVIEWED', 'REJECTED_TO_DRAFT')).toBe(true);
    expect(canTransitionPR(PERSONAS.L2, 'REVIEWED', 'REJECTED_TO_DRAFT')).toBe(false);
    expect(canTransitionPO(PERSONAS.ONLINE, 'CLAIM_REPORTED', 'COMPLETED')).toBe(true);
    const purchaserByCanonical = { id: 'U-P', username: 'buyer', department: 'PUR', roleId: 'BUYER_X', canonicalRole: 'PURCHASER', level: 2 };
    expect(canTransitionPR(purchaserByCanonical, 'SUBMITTED', 'REVIEWED')).toBe(false); // treated as online like formatSafeUser
    expect(canTransitionPO(purchaserByCanonical, 'IN_PROGRESS_ONLINE', 'ORDERED')).toBe(true);
    expect(authorize(purchaserByCanonical, 'POST', '/api/budgets/allocate')).toBe(false);
    expect(authorize(purchaserByCanonical, 'POST', '/api/pos/PO1/settle')).toBe(true);
  });

  it('budgets/adjust by a non-writer is limited to the user\'s own departments (online purchaser works across departments)', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('QC','QC',2026,1000,300,700)").run();
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'QC', action: 'TOP_UP', delta: 10 })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 10, docNo: seedRefundPo('PR-D1', 'D1') })).status).toBe(200);
    // the online purchaser works across departments : a QC PO, QC budget
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'QC', action: 'BUDGET_ROLLBACK', delta: 10, docNo: seedRefundPo('PR-D2', 'D2', { dept: 'QC' }) })).status).toBe(200);
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'QC').totalUsed).toBe(290);
  });

  it('PR (from -> to) pairs: no skipping steps ; new PR only DRAFT/SUBMITTED', async () => {
    expect((await call('L1', 'POST', '/api/prs', { id: 'PRN', prNumber: 'PRN', status: 'APPROVED', items: [] })).status).toBe(403);
    expect((await call('L2', 'POST', '/api/prs', { id: 'PRN', prNumber: 'PRN', status: 'PO_ISSUED', items: [] })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/prs', { id: 'PRN', prNumber: 'PRN', status: 'DRAFT', items: [] })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/prs/PRN', { status: 'APPROVED' })).status).toBe(403);
    expect((await call('L1', 'PUT', '/api/prs/PRN', { status: 'SUBMITTED' })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/prs/PRN', { status: 'APPROVED' })).status).toBe(403);
    expect((await call('L2', 'PUT', '/api/prs/PRN', { status: 'REJECTED_TO_DRAFT' })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/prs/PRN', { status: 'SUBMITTED' })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/prs/PRN', { status: 'REVIEWED' })).status).toBe(200);
    expect((await call('L3', 'PUT', '/api/prs/PRN', { status: 'REJECTED_TO_L2' })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/prs/PRN', { status: 'REVIEWED' })).status).toBe(200);
    expect((await call('L3', 'PUT', '/api/prs/PRN', { status: 'IN_PROGRESS_ONLINE' })).status).toBe(200);
    expect((await call('L3', 'PUT', '/api/prs/PRN', { status: 'DRAFT' })).status).toBe(403);
    expect((await call('ADMIN', 'PUT', '/api/prs/PRN', { status: 'DRAFT' })).status).toBe(200);
  });

  it('path is normalised once: trailing slash / double slash / encoded slash cannot widen a rule', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,300,700)").run();
    expect((await call('L1', 'POST', '/api/budgets/adjust/', { dept: 'PD', newAmount: 999999 })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/Adjust', { PD: { monthlyBudget: 999999 } })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/anything', { PD: { monthlyBudget: 999999 } })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/users/', { username: 'evil', name: 'x', level: 99, roleId: 'ADMIN' })).status).toBe(403);
    expect((await call('L1', 'POST', '//api/users', {})).status).toBe(400);
    expect((await call('L1', 'POST', '/api/budgets%2Fallocate', {})).status).toBe(400);
    expect((await call('L1', 'POST', '/api/budgets/a%2eb', {})).status).toBe(400);
    expect(one('SELECT monthlyBudget FROM budgets WHERE id = ?', 'PD').monthlyBudget).toBe(1000);
    expect(authorize(PERSONAS.L1, 'POST', '/api/budgets/adjust/')).toBe(false);
  });

  it('budgets/adjust refund flows use server state: no monthlyBudget overwrite ; non-writers cannot smuggle newAmount', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,1000,300,700)").run();
    const b = () => one('SELECT * FROM budgets WHERE id = ?', 'PD');
    // TOP_UP carrying newAmount is refused for a non-writer
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 1, newAmount: 999999999 })).status).toBe(403);
    expect(b().monthlyBudget).toBe(1000);
    const docNo = seedRefundPo('PR-R1', 'R1', { total: 1000 });
    // handleRefundBudget shape: delta only (+ the PO it comes from)
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 100, previousAmount: 5, targetMonth: '2026-10', docNo })).status).toBe(200);
    expect(b()).toMatchObject({ monthlyBudget: 1100, totalRemaining: 800, totalUsed: 300 });
    // handleRollbackBudget shape: newAmount = newSpent is ignored, spent computed server side
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: 50, previousAmount: 300, newAmount: 0, docNo })).status).toBe(200);
    expect(b()).toMatchObject({ monthlyBudget: 1100, totalUsed: 250, totalRemaining: 850 });
    expect(JSON.parse(b().refundCreditsJson)).toEqual({ '2026-10': 50 });
    // deductBudget shape: negative delta
    expect((await call('ONLINE', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_DEDUCT', delta: -20, previousAmount: 250, newAmount: 270 })).status).toBe(200);
    expect(b()).toMatchObject({ monthlyBudget: 1100, totalUsed: 270, totalRemaining: 830 });
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: -5 })).status).toBe(403);
    expect(rows("SELECT type FROM budget_transactions WHERE type != 'PR_COMMITMENT' ORDER BY rowid").map((r) => r.type)).toEqual(['TOP_UP', 'BUDGET_ROLLBACK', 'BUDGET_DEDUCT']);
    // writer (L3) set-budget path unchanged
    expect((await call('L3', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 2000, targetMonth: '2026-10' })).status).toBe(200);
    expect(b().monthlyBudget).toBe(2000);
  });

  it('goods receipt: level 1 / admin only ; settle: level 1 / online / admin ; not reviewers or approvers', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO2','PO-2','PD','ORDERED','[]')").run();
    for (const who of ['L2', 'ONLINE', 'L3', 'L4']) expect((await call(who, 'POST', '/api/pos/PO2/receive', { receivingItems: [] })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/pos/PO2/receive', { receivingItems: [] })).status).toBe(200);
    for (const who of ['L2', 'L3']) expect((await call(who, 'POST', '/api/pos/PO2/settle', {})).status).toBe(403);
    expect((await call('ONLINE', 'POST', '/api/pos/PO2/settle', {})).status).toBe(200);
  });

  it('T4.2b hardening: ledger actor from token ; ledger/stock-log append-only ; settle not repeatable ; refund capped', async () => {
    // (T5.3b: a BUDGET_ROLLBACK row from a non-writer is no longer stored, so the "actor from the token" check uses a record type the client really sends)
    const tx = { id: 'TX1', type: 'PO_CANCEL_REFUND', dept: 'PD', amount: 10, docNo: 'PO-9', actor: 'FAKE', actorRole: 'FAKEROLE' };
    expect((await call('L1', 'POST', '/api/budget-transactions', tx)).status).toBe(200);
    expect(one('SELECT actor, actorRole FROM budget_transactions WHERE id = ?', 'TX1')).toMatchObject({ actor: 'Req', actorRole: 'REQUESTER' });
    expect(rows("SELECT * FROM audit_logs WHERE action = 'BUDGET_TX'").length).toBe(1);
    const dup = await call('L1', 'POST', '/api/budget-transactions', { ...tx, amount: 99999 });
    expect(dup.json.duplicate).toBe(true);
    expect(one('SELECT amount FROM budget_transactions WHERE id = ?', 'TX1').amount).toBe(10);

    seedPr('PR-3', { total: 100 });
    seedPo('PO3', 'PR-3', 100);
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,300,700)").run();
    expect((await call('L1', 'POST', '/api/pos/PO3/settle', { refundAmount: 101 })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/pos/PO3/settle', { refundAmount: 40 })).json.duplicate).toBeUndefined();
    expect((await call('L1', 'POST', '/api/pos/PO3/settle', { refundAmount: 40 })).json).toMatchObject({ resettled: true, refundedAmount: 0 }); // an edit : not refunded twice (T4.6d)
    expect(one('SELECT totalUsed, totalRemaining FROM budgets WHERE id = ?', 'PD')).toMatchObject({ totalUsed: 260, totalRemaining: 740 });
    expect(rows("SELECT id FROM budget_transactions WHERE docNo = 'PO-PO3'").length).toBe(1);
  });

  it('master data: status follows isActive when status is omitted', async () => {
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V9', code: 'V9', name: 'x', isActive: false })).status).toBe(200);
    expect(one('SELECT status, isActive FROM vendors WHERE id = ?', 'V9')).toMatchObject({ status: 'INACTIVE', isActive: 0 });
  });

  // ───────────────────────── T4.5b ─────────────────────────
  it('T4.5b stock/issue: server-side log id, atomic deduction, original shortage message, ledger row never overwritten', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P1', code: 'C1', name: 'A', department: 'PD', currentStock: 5 });
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, balance, department) VALUES ('LOG-EXIST','P1','IN',1,1,'PD')").run();
    const ok = await call('L1', 'POST', '/api/stock/issue', { id: 'LOG-EXIST', productId: 'P1', quantity: 2, department: 'PD' });
    expect(ok.status).toBe(200);
    expect(ok.json.logEntry.id).not.toBe('LOG-EXIST');
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P1').currentStock).toBe(3);
    expect(one("SELECT type, quantity FROM stock_logs WHERE id = 'LOG-EXIST'")).toMatchObject({ type: 'IN', quantity: 1 });
    const short = await call('L1', 'POST', '/api/stock/issue', { productId: 'P1', quantity: 9, department: 'PD' });
    expect(short.status).toBe(400);
    expect(short.json.error).toContain('จำนวนคงเหลือไม่พอเบิก (มี 3');
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P1').currentStock).toBe(3);
    expect((await call('L1', 'POST', '/api/stock/issue', { productId: 'P1', quantity: 3, department: 'PD' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/stock/issue', { productId: 'P1', quantity: 1, department: 'PD' })).status).toBe(400);
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P1').currentStock).toBe(0);
  });

  it('T4.5b budgets/allocate: ledger append-only, one row per department, client id collision falls back to a server id', async () => {
    await call('ADMIN', 'POST', '/api/budget-transactions', { id: 'BTX-1', type: 'MONTHLY_ALLOCATION', dept: 'PD', amount: 5 });
    const r = await call('L2', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 100, QC: 200 }, transactionId: 'BTX-1', transactions: { PD: { id: 'BTX-1' } } });
    expect(r.status).toBe(200);
    expect(one("SELECT amount FROM budget_transactions WHERE id = 'BTX-1'").amount).toBe(5);
    expect(rows('SELECT dept FROM budget_transactions').map((x) => x.dept).sort()).toEqual(['PD', 'PD', 'QC']); // seeded BTX-1 + new PD (server id) + QC
    expect(one("SELECT monthlyBudget FROM budgets WHERE id = 'QC'").monthlyBudget).toBe(200);
  });

  it('T4.5b POST prs/pos on an existing row: no status => stored status kept ; status => always checked', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('PR9','PR-9','PD','REVIEWED','[]')").run();
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR9', prNumber: 'PR-9', reason: 'note' })).status).toBe(200);
    expect(one("SELECT status, totalAmount FROM prs WHERE id = 'PR9'")).toMatchObject({ status: 'REVIEWED', totalAmount: 0 });
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR9', prNumber: 'PR-9', items: [{ a: 1 }] })).status).toBe(403); // T4.5e: level 1 cannot change a REVIEWED PR's items
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR9', prNumber: 'PR-9', status: 'SUBMITTED' })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR-NEW', prNumber: 'PR-NEW', items: [] })).status).toBe(200);
    expect(one("SELECT status FROM prs WHERE id = 'PR-NEW'").status).toBe('SUBMITTED');
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO9','PO-9','PD','IN_PROGRESS_ONLINE','[]')").run();
    expect((await call('L3', 'POST', '/api/pos', { id: 'PO9', poNumber: 'PO-9', items: [] })).status).toBe(200);
    expect(one("SELECT status FROM pos WHERE id = 'PO9'").status).toBe('IN_PROGRESS_ONLINE');
    expect((await call('L3', 'POST', '/api/pos', { id: 'PO9', poNumber: 'PO-9', status: 'ORDERED' })).status).toBe(403);
  });

  it('T4.5b PUT prs/pos resolves ONE row (exact id first) and updates by id', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('ZZ','PR-X','PD','DRAFT','[]')").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('PR-X','PR-OTHER','PD','DRAFT','[]')").run();
    expect((await call('L1', 'PUT', '/api/prs/PR-X', { reason: 'changed' })).status).toBe(200);
    expect(rows('SELECT id, reason FROM prs ORDER BY id').map((x) => `${x.id}:${x.reason}`)).toEqual(['PR-X:changed', 'ZZ:null']);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('Q1','PO-Y','PD','ORDERED','[]')").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO-Y','PO-OTHER','PD','ORDERED','[]')").run();
    expect((await call('L1', 'PUT', '/api/pos/PO-Y', { paymentTerms: 'NET30' })).status).toBe(200);
    expect(rows('SELECT id, paymentTerms FROM pos ORDER BY id').map((x) => `${x.id}:${x.paymentTerms}`)).toEqual(['PO-Y:NET30', 'Q1:null']);
  });

  it('T4.5b settle: cancelled/draft refused ; cap from ledger commitment ; no known amount => no refund ; only server rows count as duplicates', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,300,700)").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, grandTotal) VALUES ('S1','PO-S1','PD','CANCELLED','[]',999)").run();
    expect((await call('L1', 'POST', '/api/pos/S1/settle', { refundAmount: 1 })).status).toBe(409);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('S2','PO-S2','PD','ORDERED','[]')").run();
    const noPr = await call('L1', 'POST', '/api/pos/S2/settle', { refundAmount: 1 });
    expect(noPr.json).toMatchObject({ success: true, refundSkipped: true, refundDenied: 'NO_PR' }); // no PR => no refund, PO still closes
    // T4.6c: like GAS apiSettlePO the settlement does NOT change the PO status ; it records settlementStatus = SETTLED
    expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = 'S2'")).toMatchObject({ status: 'ORDERED', ss: 'SETTLED' });
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(300);
    // the editable grandTotal is NOT the cap once the ledger has a commitment row
    seedPr('PR-S3', { total: 50 });
    seedPo('S3', 'PR-S3', 100000);
    // a client-made BUDGET_ROLLBACK for the same doc does not block the server refund
    await call('ADMIN', 'POST', '/api/budget-transactions', { id: 'C2', type: 'BUDGET_ROLLBACK', dept: 'PD', amount: 10, docNo: 'PO-S3-other' });
    expect((await call('L1', 'POST', '/api/pos/S3/settle', { refundAmount: 60 })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/pos/S3/settle', { refundAmount: 50 })).json.duplicate).toBeUndefined();
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(250);
    // settled already => settling again is an edit : accepted, but the refund of 50 is not paid twice
    const again = await call('L1', 'POST', '/api/pos/S3/settle', { refundAmount: 50 });
    expect(again.json).toMatchObject({ success: true, resettled: true, refundedAmount: 0 });
    expect(again.json.duplicate).toBeUndefined();
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(250);
    // a refund row exists but the PO was never marked settled (data from before T4.6c) : settled now, refund not repeated
    sdb.prepare("UPDATE pos SET extraJson = json_remove(extraJson, '$.settlementStatus') WHERE id = 'S3'").run();
    const legacy = await call('L1', 'POST', '/api/pos/S3/settle', { refundAmount: 50 });
    expect(legacy.json).toMatchObject({ success: true, refundedAmount: 0 });
    expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = 'S3'")).toMatchObject({ status: 'ORDERED', ss: 'SETTLED' });
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(250);
  });

  it('T4.5b receive: terminal PO statuses are returned unchanged (parity Code.gs:2643) ; over-receive is refused like the web engine (workflowEngine.receiveGoods)', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P2', code: 'C2', name: 'B', department: 'PD', currentStock: 0 });
    for (const st of ['CLOSED', 'CANCELLED']) {
      sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES (?, ?, 'PD', ?, '[{\"productId\":\"P2\",\"qty\":1}]')").run(`R-${st}`, `PO-R-${st}`, st);
      const r = await call('L1', 'POST', `/api/pos/R-${st}/receive`, { receivingItems: [{ productId: 'P2', goodQty: 5 }] });
      expect(r.status).toBe(200);
      expect(r.json.duplicate).toBe(true);
      expect(one("SELECT status FROM pos WHERE id = ?", `R-${st}`).status).toBe(st);
    }
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P2').currentStock).toBe(0);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('R-OK','PO-R-OK','PD','ORDERED','[{\"productId\":\"P2\",\"qty\":1}]')").run();
    expect((await call('L1', 'POST', '/api/pos/R-OK/receive', { receivingItems: [{ productId: 'P2', goodQty: 5 }] })).status).toBe(400); // ordered 1
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P2').currentStock).toBe(0);
    expect((await call('L1', 'POST', '/api/pos/R-OK/receive', { receivingItems: [{ productId: 'P2', goodQty: 1 }] })).status).toBe(200);
    expect(one('SELECT currentStock FROM products WHERE id = ?', 'P2').currentStock).toBe(1);
  });

  it('T4.5b budgets/adjust relative updates: credits and month history accumulate', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,1000,300,700)").run();
    const docNo = seedRefundPo('PR-R2', 'R2', { total: 1000 });
    await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: 50, targetMonth: '2026-10', docNo });
    await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: 30, targetMonth: '2026-10', docNo });
    await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 10, targetMonth: '2026-10', docNo });
    await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 5, targetMonth: '2026-10', docNo });
    const b = one("SELECT * FROM budgets WHERE id = 'PD'");
    expect(JSON.parse(b.refundCreditsJson)).toEqual({ '2026-10': 80 });
    expect(JSON.parse(b.monthsJson)).toEqual({ '2026-10': 1015 });
    expect(b).toMatchObject({ monthlyBudget: 1015, totalAllocated: 1015, totalUsed: 220, totalRemaining: 795 });
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 1, targetMonth: '2026-10"x' })).status).toBe(400);
  });

  it('T4.5b misc: HEAD follows GET rule, malformed % path => 400, ledger createdAt is server time', async () => {
    expect(authorize(PERSONAS.L1, 'HEAD', '/api/audit-logs')).toBe(false);
    expect(authorize(PERSONAS.ADMIN, 'HEAD', '/api/audit-logs')).toBe(true);
    expect(authorize(PERSONAS.L1, 'HEAD', '/api/users')).toBe(true);
    expect((await call('L1', 'GET', '/api/products/%E0%A4%A')).status).toBe(400);
    await call('L1', 'POST', '/api/budget-transactions', { id: 'T-OLD', type: 'ACTUAL_SPEND', dept: 'PD', amount: -1, createdAt: '2000-01-01T00:00:00.000Z', date: '2000-01-01' });
    expect(one("SELECT createdAt, date FROM budget_transactions WHERE id = 'T-OLD'").createdAt.startsWith('2000')).toBe(false);
    expect(one("SELECT createdAt, date FROM budget_transactions WHERE id = 'T-OLD'").date.startsWith('2000')).toBe(false);
  });

  it('T4.5b online purchaser can never cancel a PO (canCancelPO)', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('C9','PO-C9','PD','ORDERED','[]')").run();
    expect((await call('ONLINE', 'PUT', '/api/pos/C9', { status: 'CANCELLED' })).status).toBe(403);
    expect((await call('L2', 'PUT', '/api/pos/C9', { status: 'CANCELLED' })).status).toBe(200);
  });

  // ───────────────────────── T4.5c ─────────────────────────
  it('T4.5c ledger: PO_COMMITMENT / REFUND_SETTLEMENT are server-only ; PR_COMMITMENT only for a real, approved PR, once, <= PR total', async () => {
    for (const who of ['L1', 'L3', 'ADMIN']) {
      for (const k of ['PO_COMMITMENT', 'po_commitment']) {
        expect((await call(who, 'POST', '/api/budget-transactions', { id: `X-${who}-${k}`, type: k, dept: 'PD', amount: -9, docNo: 'PR-V' })).status).toBe(403);
        expect((await call(who, 'POST', '/api/budget-transactions', { id: `Y-${who}-${k}`, type: 'TOP_UP', actionType: k, dept: 'PD', amount: 9, docNo: 'PR-V' })).status).toBe(403);
      }
      // REFUND_SETTLEMENT: written only by the server, but the client's own row (creditDepartmentBudget) is acknowledged, never stored, never 403
      for (const k of ['REFUND_SETTLEMENT', 'refund_settlement']) {
        const a = await call(who, 'POST', '/api/budget-transactions', { id: `X-${who}-${k}`, type: k, dept: 'PD', amount: -9, docNo: 'PR-V' });
        const b = await call(who, 'POST', '/api/budget-transactions', { id: `Y-${who}-${k}`, type: 'BUDGET_ROLLBACK', actionType: k, dept: 'PD', amount: 9, docNo: 'PR-V' });
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(b.json).toMatchObject({ duplicate: true, serverManaged: true });
      }
    }
    expect(rows('SELECT id FROM budget_transactions').length).toBe(0);
    // T4.5e: a client PR_COMMITMENT is acknowledged (200 + duplicate, so the client does not break) but NEVER written, whatever it claims
    const commit = (over = {}) => ({ id: 'PC-1', type: 'PR_COMMITMENT', dept: 'ฝ่าย PD', amount: -400, docNo: 'PR-V', ...over });
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('PRV','PR-V','PD','REVIEWED',500,'[]')").run();
    for (const who of ['L1', 'L3', 'ADMIN']) {
      const r = await call(who, 'POST', '/api/budget-transactions', commit({ id: `PC-${who}`, amount: -99999999 }));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ success: true, duplicate: true });
    }
    expect((await call('L1', 'POST', '/api/budget-transactions', commit({ id: 'PC-lower', type: 'pr_commitment' }))).json.duplicate).toBe(true);
    expect(rows("SELECT id FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").length).toBe(0);
    // normal client ledger types stay open
    expect((await call('L1', 'POST', '/api/budget-transactions', { id: 'AS-1', type: 'ACTUAL_SPEND', dept: 'PD', amount: -5, docNo: 'PO-Z' })).status).toBe(200);
  });

  it('T4.5c settle ceiling: server snapshot (not the editable grandTotal), min with PR commitment, minus refunds of every PO of the PR', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    seedPr('PR-M', { total: 1000 });
    seedPo('MA', 'PR-M', 600);
    seedPo('MB', 'PR-M', 600);
    expect((await call('L1', 'POST', '/api/pos/MA/settle', { refundAmount: 700 })).status).toBe(400); // grandTotal 99999 is ignored
    expect((await call('L1', 'POST', '/api/pos/MA/settle', { refundAmount: 600 })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/pos/MB/settle', { refundAmount: 500 })).status).toBe(400); // 1000 - 600 = 400 left for the PR
    expect((await call('L1', 'POST', '/api/pos/MB/settle', { refundAmount: 400 })).status).toBe(200);
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(2000);
  });

  it('T4.5c PO value snapshot is written once by the server and never moved by PUT / later upserts', async () => {
    seedPr('PR-SN', { total: 700 });
    expect((await call('L3', 'POST', '/api/pos', { id: 'SN1', poNumber: 'PO-SN1', prNumber: 'PR-SN', department: 'PD', status: 'ISSUED', grandTotal: 700, items: [{ productId: 'SP1', qty: 1 }] })).status).toBe(200);
    const snap = () => JSON.parse(one("SELECT extraJson FROM pos WHERE id = 'SN1'").extraJson).approvedTotal;
    expect(snap()).toBe(700);
    await call('L3', 'PUT', '/api/pos/SN1', { grandTotal: 99999 });
    await call('L3', 'POST', '/api/pos', { id: 'SN1', poNumber: 'PO-SN1', status: 'ORDERED', grandTotal: 88888, items: [{ productId: 'SP1', qty: 1 }] });
    expect(snap()).toBe(700);
    expect(one("SELECT grandTotal FROM pos WHERE id = 'SN1'").grandTotal).toBe(88888); // value stays editable, ceiling does not follow it
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    expect((await call('L1', 'POST', '/api/pos/SN1/settle', { refundAmount: 701 })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/pos/SN1/settle', { refundAmount: 700 })).status).toBe(200);
  });

  it('T4.5d fake PO (no PR / unknown PR / PR of another department / PR not approved) cannot be created by a non-admin', async () => {
    seedPr('PR-OK', { total: 500 });
    seedPr('PR-QC', { total: 500, dept: 'QC' });
    seedPr('PR-REV', { total: 500, status: 'REVIEWED' });
    const body = (over) => ({ id: 'FK', poNumber: 'PO-FK', department: 'PD', status: 'ISSUED', grandTotal: 9999999, items: [{ productId: 'SP1', qty: 1 }], ...over });
    for (const who of ['L1', 'L3']) {
      expect((await call(who, 'POST', '/api/pos', body({}))).status).toBe(400); // no prNumber
      expect((await call(who, 'POST', '/api/pos', body({ prNumber: 'PR-NOPE' }))).status).toBe(400);
      expect((await call(who, 'POST', '/api/pos', body({ prNumber: 'PR-QC' }))).status).toBe(400); // PO department (PD) != PR department (QC)
    }
    // a PD-only user cannot issue a PO against a QC PR even when the departments match ; an approver (all departments) can
    expect((await call('L1', 'POST', '/api/pos', body({ prNumber: 'PR-QC', department: 'QC' }))).status).toBe(403);
    expect((await call('L3', 'POST', '/api/pos', body({ id: 'FKQ', prNumber: 'PR-QC', department: 'QC', grandTotal: 1 }))).status).toBe(200);
    expect((await call('L3', 'POST', '/api/pos', body({ prNumber: 'PR-REV' }))).status).toBe(400); // PR not yet approved
    expect(rows("SELECT id FROM pos WHERE id = 'FK'").length).toBe(0);
  });

  it('T4.5d approvedTotal is computed by the server from the PR (body grandTotal ignored) and shared between the POs of one PR', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    seedPr('PR-A', { total: 500 });
    const snap = (id) => JSON.parse(one('SELECT extraJson FROM pos WHERE id = ?', id).extraJson).approvedTotal;
    expect((await call('L3', 'POST', '/api/pos', { id: 'FA', poNumber: 'PO-FA', prNumber: 'PR-A', department: 'PD', status: 'ISSUED', grandTotal: 9999999, items: [{ productId: 'SP1', qty: 1 }] })).status).toBe(200);
    expect(snap('FA')).toBe(500); // min(9,999,999 , PR total 500)
    expect((await call('L3', 'POST', '/api/pos', { id: 'FB', poNumber: 'PO-FB', prNumber: 'PR-A', department: 'PD', status: 'ISSUED', grandTotal: 300, items: [{ productId: 'SP1', qty: 1 }] })).status).toBe(200);
    expect(snap('FB')).toBe(0); // nothing of the PR is left for a second PO
    expect(one("SELECT prNumber, department FROM pos WHERE id = 'FA'")).toMatchObject({ prNumber: 'PR-A', department: 'PD' });
    // a PO may exceed its PR a little (online variance) : creation is allowed, the refund ceiling is not
    expect((await call('L1', 'POST', '/api/pos/FA/settle', { refundAmount: 501 })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/pos/FB/settle', { refundAmount: 10 })).json).toMatchObject({ refundSkipped: true, refundDenied: 'NOTHING_LEFT' });
    expect((await call('L1', 'POST', '/api/pos/FA/settle', { refundAmount: 500 })).status).toBe(200);
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(2500);
  });

  it('T4.5d legacy PO without snapshot / PR without validated commitment: refund is denied, PO still closes ; PO vs PR department mismatch => 400', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    seedPr('PR-L', { total: 800 });
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, grandTotal) VALUES ('LG','PO-LG','PR-L','PD','ORDERED','[]',800)").run(); // no extraJson
    const r1 = await call('L1', 'POST', '/api/pos/LG/settle', { refundAmount: 100 });
    expect(r1.json).toMatchObject({ success: true, refundSkipped: true });
    expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = 'LG'")).toMatchObject({ status: 'ORDERED', ss: 'SETTLED' }); // settled, status untouched (GAS parity)
    seedPr('PR-NC', { total: 800, commit: 0 });
    seedPo('NC', 'PR-NC', 800);
    expect((await call('L1', 'POST', '/api/pos/NC/settle', { refundAmount: 100 })).json).toMatchObject({ refundSkipped: true, refundDenied: 'NO_COMMITMENT' });
    seedPr('PR-X', { total: 800, dept: 'QC' });
    seedPo('XD', 'PR-X', 800, { dept: 'PD' });
    expect((await call('L1', 'POST', '/api/pos/XD/settle', { refundAmount: 100 })).status).toBe(400);
    expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(3000);
    expect(rows("SELECT id FROM budget_transactions WHERE actionType = 'REFUND_SETTLEMENT'").length).toBe(0);
  });

  it('T4.5d two settles at the same time never exceed the PR commitment', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    seedPr('PR-C', { total: 500 });
    seedPo('CA', 'PR-C', 400);
    seedPo('CB', 'PR-C', 400);
    const [a, b] = await Promise.all([
      call('L1', 'POST', '/api/pos/CA/settle', { refundAmount: 400 }),
      call('L1', 'POST', '/api/pos/CB/settle', { refundAmount: 400 })
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 400)).toBe(true);
    const refunded = rows("SELECT amount FROM budget_transactions WHERE actionType = 'REFUND_SETTLEMENT'").reduce((s, r) => s + r.amount, 0);
    expect(refunded).toBeLessThanOrEqual(500);
    expect(3000 - one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(refunded);
    // the statement-level guard also holds when the JS pre-check passed for both: simulate by settling the second PO again after the first got 400
    expect(a.status === 200 || b.status === 200).toBe(true);
  });

  // ───────────────────────── T4.5e ─────────────────────────
  it('T4.5e full normal flow: create -> submit -> reject back -> fix & resubmit -> review -> approve (+PO) -> receive -> complete -> settle/close', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'PF', code: 'CF', name: 'F', department: 'PD', currentStock: 0 });
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,5000,3000,2000)").run();
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('OTHER','PD',2026,5000,3000,2000)").run();
    const prNo = 'PD001/2026';
    const item = (qty, price) => [{ productId: 'PF', qty, price }];
    expect((await call('L1', 'POST', '/api/prs', { id: 'FL1', prNumber: prNo, department: 'PD', status: 'DRAFT', items: item(2, 50), totalAmount: 100 })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/prs/FL1', { status: 'DRAFT', items: item(3, 50), totalAmount: 150 })).status).toBe(200); // edit own draft
    expect((await call('L1', 'PUT', '/api/prs/FL1', { status: 'SUBMITTED', items: item(3, 50), totalAmount: 150 })).status).toBe(200); // submit
    expect((await call('L1', 'PUT', '/api/prs/FL1', { items: item(30, 50), totalAmount: 1500 })).status).toBe(403); // requester cannot edit a submitted PR
    expect((await call('L2', 'PUT', '/api/prs/FL1', { status: 'REJECTED_TO_DRAFT', reason: 'แก้จำนวน', items: item(3, 50), totalAmount: 150 })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/prs/FL1', { status: 'SUBMITTED', items: item(2, 60), totalAmount: 120 })).status).toBe(200); // fixed & resubmitted
    expect((await call('L2', 'PUT', '/api/prs/FL1', { status: 'REVIEWED', items: item(2, 60), totalAmount: 120 })).status).toBe(200);
    // reviewer may adjust items before approval (workflowEngine.editPRItems, level >= 2) ; requester may not
    expect((await call('L2', 'PUT', '/api/prs/FL1', { items: item(2, 55), totalAmount: 110 })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/prs/FL1', { items: item(2, 60), totalAmount: 120 })).status).toBe(200);
    // client order on approval: ledger POST first (acknowledged, never stored), then PR PUT, then PO POST
    const ack = await call('L3', 'POST', '/api/budget-transactions', { id: 'TX-client-1', type: 'PR_COMMITMENT', dept: 'ฝ่าย PD', amount: -120, docNo: prNo });
    expect(ack.json).toMatchObject({ success: true, duplicate: true });
    expect((await call('L3', 'PUT', '/api/prs/FL1', { status: 'PO_ISSUED', items: item(2, 60), totalAmount: 120, poNo: 'PO-PD-1' })).status).toBe(200);
    const commit = rows("SELECT * FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'");
    expect(commit.length).toBe(1);
    expect(commit[0]).toMatchObject({ amount: -120, docNo: prNo, dept: 'PD', transactionId: `TXN-${prNo}-PR_COMMITMENT` });
    expect(commit[0].id).not.toBe('TX-client-1');
    // after approval nobody but an admin changes content
    for (const who of ['L1', 'L2', 'L3']) expect((await call(who, 'PUT', '/api/prs/FL1', { items: item(2, 1), totalAmount: 2 })).status).toBe(403);
    expect((await call('L3', 'POST', '/api/pos', { id: 'FLPO', poNumber: 'PO-PD-1', prNumber: prNo, department: 'PD', status: 'ISSUED', grandTotal: 120, items: [{ productId: 'PF', qty: 2 }] })).status).toBe(200);
    expect(JSON.parse(one("SELECT extraJson FROM pos WHERE id = 'FLPO'").extraJson).approvedTotal).toBe(120);
    expect((await call('L1', 'POST', '/api/pos/FLPO/receive', { receivingItems: [{ productId: 'PF', goodQty: 2 }] })).status).toBe(200);
    expect(one("SELECT currentStock FROM products WHERE id = 'PF'").currentStock).toBe(2);
    expect((await call('L1', 'PUT', '/api/prs/FL1', { status: 'completed' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/pos/FLPO/settle', { refundAmount: 20 })).status).toBe(200);
    expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = 'FLPO'")).toMatchObject({ status: 'CLOSED', ss: 'SETTLED' }); // T4.6c: status stays what the receive set
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(2980);
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'OTHER'").totalUsed).toBe(3000); // settle updates budgets by id only
    // approving the same PR again never writes a second commitment
    expect(rows("SELECT id FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").length).toBe(1);
  });

  it('T4.5e PR content frozen: totalAmount/items only editable where the client allows ; admin may', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('FZ','PR-FZ','PD','APPROVED',100,?)").run(JSON.stringify([{ productId: 'A', qty: 1, price: 100 }]));
    expect((await call('L3', 'PUT', '/api/prs/FZ', { totalAmount: 1 })).status).toBe(403);
    expect((await call('L3', 'POST', '/api/prs', { id: 'FZ', prNumber: 'PR-FZ', totalAmount: 1 })).status).toBe(403);
    expect((await call('L3', 'PUT', '/api/prs/FZ', { totalAmount: 100, items: [{ productId: 'A', qty: 1, price: 100, imageUrl: 'x' }] })).status).toBe(200); // same content + client-only fields
    expect((await call('ADMIN', 'PUT', '/api/prs/FZ', { totalAmount: 90 })).status).toBe(200);
    expect(one("SELECT totalAmount FROM prs WHERE id = 'FZ'").totalAmount).toBe(90);
  });

  it('T4.5e new PR: id/number must not collide with another PR ; department must be reachable ; existing PR department gate', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('EX','PR-EX','PD','SUBMITTED',10,'[]')").run();
    expect((await call('L1', 'POST', '/api/prs', { id: 'PR-EX', prNumber: 'PR-NEW1', department: 'PD', status: 'DRAFT' })).status).toBe(409); // id == another PR's number
    // T3.3: a client number that is already taken (= another PR's id, or the same number) is no longer a 409 : the server issues a fresh one and returns it
    const t2 = await call('L1', 'POST', '/api/prs', { id: 'NEW2', prNumber: 'EX', department: 'PD', status: 'DRAFT' }); // number == another PR's id
    expect(t2.status).toBe(200);
    expect(t2.json).toMatchObject({ renumbered: true, requestedPrNo: 'EX' });
    expect(t2.json.pr.prNumber).toBe(t2.json.prNo);
    expect(t2.json.prNo).toMatch(/^PD\d{3}\/\d{4}$/);
    const t3 = await call('L1', 'POST', '/api/prs', { id: 'NEW3', prNumber: 'PR-EX', department: 'PD', status: 'DRAFT' }); // same number
    expect(t3.status).toBe(200);
    expect(t3.json.renumbered).toBe(true);
    expect(t3.json.prNo).not.toBe(t2.json.prNo);
    expect(one("SELECT prNumber FROM prs WHERE id = 'EX'").prNumber).toBe('PR-EX'); // the existing PR is untouched
    expect((await call('L1', 'POST', '/api/prs', { id: 'NEW4', prNumber: 'PR-NEW4', department: 'PD', status: 'DRAFT' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/prs', { id: 'NEW5', prNumber: 'PR-NEW5', department: 'QC', status: 'DRAFT' })).status).toBe(403);
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('QCP','PR-QCP','QC','SUBMITTED',10,'[]')").run();
    expect((await call('L1', 'PUT', '/api/prs/QCP', { reason: 'x' })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/prs', { id: 'QCP', prNumber: 'PR-QCP', reason: 'x' })).status).toBe(403);
    expect((await call('L3', 'PUT', '/api/prs/QCP', { reason: 'x' })).status).toBe(200); // approver reaches every department
  });

  it('T4.5e unknown PR status is stuck for non-admins (the importer maps them) ; admin can move it', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('WD','PR-WD','PD','WEIRD',10,'[]')").run();
    for (const who of ['L1', 'L2', 'L3']) expect((await call(who, 'PUT', '/api/prs/WD', { status: 'SUBMITTED' })).status).toBe(403);
    expect((await call('ADMIN', 'PUT', '/api/prs/WD', { status: 'SUBMITTED' })).status).toBe(200);
  });

  // ───────────────────────── T4.5f ─────────────────────────
  it('T4.5f existing PO: POST upsert and PUT need access to the PO department (online purchaser / admin / all-department users pass)', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('DQ','PO-DQ','QC','ORDERED','[]')").run();
    expect((await call('L1', 'PUT', '/api/pos/DQ', { paymentTerms: 'x' })).status).toBe(403); // PD user, QC PO
    expect((await call('L1', 'POST', '/api/pos', { id: 'DQ', poNumber: 'PO-DQ', paymentTerms: 'x' })).status).toBe(403);
    expect((await call('L2', 'PUT', '/api/pos/DQ', { paymentTerms: 'x' })).status).toBe(403);
    expect(one("SELECT paymentTerms FROM pos WHERE id = 'DQ'").paymentTerms).toBeNull();
    for (const who of ['L3', 'L4', 'ADMIN']) expect((await call(who, 'PUT', '/api/pos/DQ', { paymentTerms: who })).status).toBe(200);
    expect((await call('ONLINE', 'PUT', '/api/pos/DQ', { paymentTerms: 'online' })).status).toBe(200);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('DP','PO-DP','PD','ORDERED','[]')").run();
    expect((await call('L1', 'PUT', '/api/pos/DP', { paymentTerms: 'own dept' })).status).toBe(200);
  });

  it('T4.5f server-made ids carry a random suffix and never repeat ; ids repeated inside one batch are refused', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'PU', code: 'CU', name: 'U', department: 'PD', currentStock: 10 });
    const ids = new Set();
    for (let i = 0; i < 3; i++) {
      const r = await call('L1', 'POST', '/api/stock/issue', { productId: 'PU', quantity: 1, department: 'PD' });
      expect(r.json.logEntry.id).toMatch(/^LOG-PD-\d+-[0-9a-f]{16}$/);
      ids.add(r.json.logEntry.id);
    }
    expect(ids.size).toBe(3);
    seedPr('PR-B1', { total: 100 });
    const Y = new Date(Date.now() + 7 * 3600e3).getUTCFullYear(); // T3.8: a client number must look like {DEPT}{digits}/{current year}, else the server issues one
    const a = await call('L3', 'POST', '/api/prs', [{ prNumber: `PD801/${Y}`, department: 'PD', status: 'DRAFT' }, { prNumber: `PD802/${Y}`, department: 'PD', status: 'DRAFT' }]);
    expect(a.status).toBe(200);
    const made = rows("SELECT id FROM prs WHERE prNumber IN (?, ?)", `PD801/${Y}`, `PD802/${Y}`).map((x) => x.id);
    expect(made.length).toBe(2);
    for (const id of made) expect(id).toMatch(/^PR-\d+-[0-9a-f]{16}$/);
    expect((await call('L3', 'POST', '/api/prs', [{ id: 'DUP', prNumber: 'D-1', department: 'PD', status: 'DRAFT' }, { id: 'DUP', prNumber: 'D-2', department: 'PD', status: 'DRAFT' }])).status).toBe(400);
    expect((await call('L3', 'POST', '/api/prs', [{ id: 'E1', prNumber: 'SAME', department: 'PD', status: 'DRAFT' }, { id: 'E2', prNumber: 'SAME', department: 'PD', status: 'DRAFT' }])).status).toBe(400);
    expect(rows("SELECT id FROM prs WHERE id IN ('DUP','E1','E2')").length).toBe(0);
    const po = await call('ADMIN', 'POST', '/api/pos', [{ poNumber: 'PX-1', status: 'ORDERED' }, { poNumber: 'PX-2', status: 'ORDERED' }]);
    expect(po.status).toBe(200);
    expect(rows("SELECT id FROM pos WHERE poNumber IN ('PX-1','PX-2')").length).toBe(2);
    expect((await call('ADMIN', 'POST', '/api/pos', [{ id: 'PXD', status: 'ORDERED' }, { id: 'PXD', status: 'ORDERED' }])).status).toBe(400);
  });

  // ───────────────────────── T4.5h ─────────────────────────
  it('T4.5h new PR department: wildcard (ALL/BOTH/* any case) only for admin ; canonical code stored ; unknown department refused when master data exists', async () => {
    for (const d of ['ALL', 'all', 'BOTH', 'both', '*', ' All ', 'DEPT-ALL']) {
      expect((await call('L3', 'POST', '/api/prs', { id: `W-${d}`, prNumber: `W-${d}`, department: d, status: 'DRAFT' })).status, d).toBe(400);
      expect((await call('L1', 'POST', '/api/prs', { id: `W1-${d}`, prNumber: `W1-${d}`, department: d, status: 'DRAFT' })).status, d).toBe(400);
    }
    expect(rows("SELECT id FROM prs WHERE id LIKE 'W%'").length).toBe(0);
    expect((await call('ADMIN', 'POST', '/api/prs', { id: 'ADM-ALL', prNumber: 'ADM-ALL', department: 'all', status: 'DRAFT' })).status).toBe(200);
    expect(one("SELECT department FROM prs WHERE id = 'ADM-ALL'").department).toBe('ALL');
    // canonical storage
    expect((await call('L1', 'POST', '/api/prs', { id: 'CN1', prNumber: 'CN1', department: ' dept-pd ', status: 'DRAFT' })).status).toBe(200);
    expect(one("SELECT department FROM prs WHERE id = 'CN1'").department).toBe('PD');
    // master data present: only known departments
    sdb.prepare("INSERT INTO departments (id, code, name, isActive) VALUES ('DEPT-PD','PD','ผลิต',1)").run();
    sdb.prepare("INSERT INTO departments (id, code, name, isActive) VALUES ('DEPT-QC','QC','คุณภาพ',1)").run();
    expect((await call('L1', 'POST', '/api/prs', { id: 'CN2', prNumber: 'CN2', department: 'pd', status: 'DRAFT' })).status).toBe(200);
    expect((await call('L3', 'POST', '/api/prs', { id: 'CN3', prNumber: 'CN3', department: 'DEPT-QC', status: 'DRAFT' })).status).toBe(200);
    expect(one("SELECT department FROM prs WHERE id = 'CN3'").department).toBe('QC');
    expect((await call('L3', 'POST', '/api/prs', { id: 'CN4', prNumber: 'CN4', department: 'ZZ', status: 'DRAFT' })).status).toBe(400);
  });

  it('T4.5h canAdjustBudget / allocate / adjust: wildcard department refused for non-admin, normalised for the rest', async () => {
    const { canAdjustBudget } = await import('../functions/_lib/rbac.js');
    for (const d of ['ALL', 'both', '*']) {
      expect(canAdjustBudget(PERSONAS.L3, { dept: d, newAmount: 5 })).toBe(false);
      expect(canAdjustBudget(PERSONAS.L1, { dept: d, action: 'TOP_UP', delta: 1 })).toBe(false);
      expect(canAdjustBudget(PERSONAS.ADMIN, { dept: d, newAmount: 5 })).toBe(true);
    }
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,300,700)").run();
    expect((await call('L3', 'POST', '/api/budgets/adjust', { dept: 'ALL', newAmount: 5 })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budgets/adjust', { dept: 'dept-pd', action: 'BUDGET_ROLLBACK', delta: 10, docNo: seedRefundPo('PR-W1', 'W1') })).status).toBe(200); // DEPT-PD -> PD
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(290);
    expect(rows("SELECT id FROM budgets WHERE id LIKE 'DEPT-%' OR id = 'ALL'").length).toBe(0);
    await call('L3', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { ALL: 9, both: 9, '*': 9, 'dept-qc': 77 } });
    expect(rows('SELECT id FROM budgets ORDER BY id').map((x) => x.id)).toEqual(['PD', 'QC']);
  });

  it('T4.5h CLOSED / CANCELLED PO keeps its amounts (PUT and POST upsert) ; settlement fields and items stay editable ; admin may correct ; upsert keeps unsent amounts', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, totalAmount, vatAmount, grandTotal) VALUES ('CL1','PO-CL1','PD','CLOSED','[]',100,7,107)").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, totalAmount, vatAmount, grandTotal) VALUES ('CX1','PO-CX1','PD','CANCELLED','[]',100,7,107)").run();
    for (const id of ['CL1', 'CX1']) {
      expect((await call('L1', 'PUT', `/api/pos/${id}`, { grandTotal: 1 })).status).toBe(403);
      expect((await call('L3', 'PUT', `/api/pos/${id}`, { totalAmount: 1 })).status).toBe(403);
      expect((await call('L1', 'POST', '/api/pos', { id, poNumber: `PO-${id}`, grandTotal: 5 })).status).toBe(403);
      expect((await call('L1', 'PUT', `/api/pos/${id}`, { grandTotal: 107, totalAmount: 100, vatAmount: 7, items: [{ actualPrice: 1 }], paymentTerms: 'x' })).status).toBe(200); // unchanged amounts + other fields
    }
    expect((await call('L1', 'POST', '/api/pos', { id: 'CL1', poNumber: 'PO-CL1', paymentTerms: 'net30' })).status).toBe(200);
    expect(one("SELECT totalAmount, vatAmount, grandTotal FROM pos WHERE id = 'CL1'")).toMatchObject({ totalAmount: 100, vatAmount: 7, grandTotal: 107 }); // not zeroed by the upsert
    expect((await call('ADMIN', 'PUT', '/api/pos/CL1', { grandTotal: 120 })).status).toBe(200);
    // open POs are unchanged by this rule
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, totalAmount, grandTotal) VALUES ('OP1','PO-OP1','PD','ORDERED','[]',100,100)").run();
    expect((await call('L1', 'PUT', '/api/pos/OP1', { grandTotal: 90 })).status).toBe(200);
  });

  it('T4.5c settle department gate: non-admin/non-online only for their own departments', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, grandTotal) VALUES ('QD','PO-QD','QC','ORDERED','[]',100)").run();
    expect((await call('L1', 'POST', '/api/pos/QD/settle', {})).status).toBe(403); // L1 is a PD user
    expect((await call('ONLINE', 'POST', '/api/pos/QD/settle', {})).status).toBe(200);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, grandTotal) VALUES ('QD2','PO-QD2','QC','ORDERED','[]',100)").run();
    expect((await call('ADMIN', 'POST', '/api/pos/QD2/settle', {})).status).toBe(200);
  });

  it('T4.5c receive: optimistic lock stops a concurrent receive ; stock + log + PO commit together', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P7', code: 'C7', name: 'G', department: 'PD', currentStock: 1 });
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('RV','PO-RV','PD','ORDERED','[{\"productId\":\"P7\",\"qty\":10}]')").run();
    const real = env.DB;
    env.DB = { ...real, prepare: (q) => { if (q.startsWith('UPDATE pos SET updatedAt = ?')) sdb.prepare("UPDATE pos SET updatedAt = 'RACE'").run(); return real.prepare(q); } };
    const lost = await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 4 }] });
    env.DB = real;
    expect(lost.status).toBe(409);
    expect(one("SELECT currentStock FROM products WHERE id = 'P7'").currentStock).toBe(1);
    expect(rows("SELECT id FROM stock_logs WHERE docType = 'GRN'").length).toBe(0);
    const ok = await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 4 }] });
    expect(ok.status).toBe(200);
    expect(one("SELECT currentStock FROM products WHERE id = 'P7'").currentStock).toBe(5);
    expect(one("SELECT balance, quantity FROM stock_logs WHERE docType = 'GRN'")).toMatchObject({ balance: 5, quantity: 4 });
    expect(one("SELECT status FROM pos WHERE id = 'RV'").status).toBe('PARTIAL');
    // exact id wins over a poNumber that equals another row's id
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('EX1','RV','PD','CLOSED','[]')").run();
    expect((await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 1 }] })).json.duplicate).toBeUndefined();
  });

  it('T4.5c stock/issue gives the stock back when the log cannot be written', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P8', code: 'C8', name: 'H', department: 'PD', currentStock: 10 });
    const real = env.DB;
    env.DB = { ...real, prepare: (q) => (q.includes('INSERT INTO stock_logs') ? { bind: () => ({ first: async () => { throw new Error('boom'); } }) } : real.prepare(q)) };
    const r = await call('L1', 'POST', '/api/stock/issue', { productId: 'P8', quantity: 4, department: 'PD' });
    env.DB = real;
    expect(r.status).toBe(500);
    expect(one("SELECT currentStock FROM products WHERE id = 'P8'").currentStock).toBe(10);
  });

  it('T4.5c server timestamps/ids: stock-logs createdAt, absolute budgets/adjust ledger ids never collide', async () => {
    await call('L1', 'POST', '/api/stock-logs', { id: 'OLDLOG', productId: 'P', type: 'IN', quantity: 1, balance: 1, department: 'PD', createdAt: '2000-01-01T00:00:00.000Z' });
    expect(one("SELECT createdAt FROM stock_logs WHERE id = 'OLDLOG'").createdAt.startsWith('2000')).toBe(false);
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,0,1000)").run();
    const [a, b] = await Promise.all([
      call('L3', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 1100, targetMonth: '2026-10' }),
      call('L3', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 1200, targetMonth: '2026-10' })
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(rows("SELECT id FROM budget_transactions WHERE dept = 'PD'").length).toBe(2);
  });
});
