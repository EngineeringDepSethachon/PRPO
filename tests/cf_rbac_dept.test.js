// @vitest-environment node
// Server department gate == the client's own functions (src/utils/permissions.js), compared as a table.
// + (T5.3d) functional bypass attempts against the master-data / ledger handlers : the row that is checked must be the row that is changed.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import './setup.js';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { canAccessDepartmentData, getUserDepartments, matchDepartment } from '../src/utils/permissions.js';
import { resolveUserPermissions } from '../src/config/constants.js';
import { canAccessDepartment, clientCanAccessDepartmentData, clientMatchDepartment, clientUserDepartments, clientViewOfUser, normalizeUser } from '../functions/_lib/rbac.js';

// what the login response (formatSafeUser) gives the client for a users row
function sessionOf(row) {
  const n = normalizeUser(row);
  let depts = null;
  if (typeof row.allowedDepartments === 'string' && row.allowedDepartments) {
    try { const j = JSON.parse(row.allowedDepartments); if (Array.isArray(j) && j.length) depts = j; } catch { /* comma list */ }
    if (!depts) depts = row.allowedDepartments.split(',').map((d) => d.trim()).filter(Boolean);
  }
  if (!depts || depts.length === 0) depts = [row.department || 'PD'];
  const perms = resolveUserPermissions({ level: n.level, roleId: n.roleId, department: row.department || 'PD', departments: depts, allowedDepartments: depts });
  return {
    id: row.id, username: row.username, roleId: n.roleId, level: n.level, isAdmin: n.isAdmin,
    department: row.department, primaryDepartment: row.primaryDepartment,
    departments: depts, assignedDepartments: depts, allowedDepartments: depts,
    canViewAllDepts: perms.canViewAllDepts
  };
}

const USERS = {
  l1_pd: { username: 'a', department: 'PD', allowedDepartments: '["PD"]', roleId: 'REQUESTER_PD', level: 1 },
  l2_pd_qc: { username: 'b', department: 'PD', allowedDepartments: '["PD","QC"]', roleId: 'ASST_MANAGER', level: 2 },
  comma_string: { username: 'c', department: 'PD', allowedDepartments: 'PD, QC', roleId: 'ASST_MANAGER', level: 2 },
  dept_prefix: { username: 'd', department: 'QC', allowedDepartments: '["DEPT-QC"]', roleId: 'REQUESTER_QC', level: 1 },
  primary_counts: { username: 'e', department: 'PD', primaryDepartment: 'WH', allowedDepartments: '["PD"]', roleId: 'REQUESTER_PD', level: 1 },
  star: { username: 'f', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', level: 3 },
  all: { username: 'g', department: 'MGT', allowedDepartments: '["ALL"]', roleId: 'PLANT_MANAGER', level: 3 },
  admin_empty: { username: 'root', department: 'ALL', allowedDepartments: '', roleId: 'ADMIN', level: 99 },
  both_user: { username: 'h', department: 'BOTH', allowedDepartments: '["BOTH"]', roleId: 'REQUESTER_PD', level: 1 },
  lower_case: { username: 'i', department: 'pd', allowedDepartments: '["pd","qc"]', roleId: 'REQUESTER_PD', level: 1 },
  l3_mgt_only: { username: 'j', department: 'MGT', allowedDepartments: '["MGT"]', roleId: 'PLANT_MANAGER', level: 3 },
  // T4.6: the server no longer treats the username 'admin' as an admin (the client function still does), so the persona is an admin by roleId/level
  admin_by_role: { username: 'root', department: 'PD', allowedDepartments: '["PD"]', roleId: 'ADMIN', level: 99 },
  no_allowed: { username: 'k', department: 'WH', roleId: 'REQUESTER_PD', level: 1 }
};
const TARGETS = ['PD', 'QC', 'DEPT-QC', 'DEPT-PD', 'dept-pd', 'Qc ', 'WH', 'MGT', 'ALL', 'BOTH', '*', 'all', 'both', '', undefined, null, 'XX'];

describe('server department gate == client permissions.js', () => {
  for (const [name, row] of Object.entries(USERS)) {
    const session = sessionOf(row);
    const view = clientViewOfUser(row);
    it(`${name}: getUserDepartments / canAccessDepartmentData / server gate agree for every target`, () => {
      expect(clientUserDepartments(view)).toEqual(getUserDepartments(session));
      for (const t of TARGETS) {
        const real = canAccessDepartmentData(session, t);
        expect(clientCanAccessDepartmentData(view, t), `port ${name} -> ${String(t)}`).toBe(real);
        expect(canAccessDepartment(row, t), `gate ${name} -> ${String(t)}`).toBe(real);
      }
    });
  }

  it('matchDepartment port == client for a code/alias table', () => {
    const vals = ['PD', 'QC', 'DEPT-QC', 'dept-qc', 'ALL', '*', 'BOTH', 'WH', ' qc ', ''];
    for (const a of vals) for (const b of vals) expect(clientMatchDepartment(a, b), `${a} / ${b}`).toBe(matchDepartment(a, b));
  });

  it('the online purchaser works across departments even without ALL (by design) ; records marked ALL/BOTH are open to everybody', () => {
    const online = { username: 'nat', department: 'PUR', allowedDepartments: '["PUR"]', roleId: 'ONLINE_PURCHASER', level: 2 };
    expect(canAccessDepartment(online, 'QC')).toBe(true);
    expect(canAccessDepartment(USERS.l1_pd, 'ALL')).toBe(true);
    expect(canAccessDepartment(USERS.l1_pd, 'BOTH')).toBe(true);
    expect(canAccessDepartment(USERS.l1_pd, 'DEPT-QC')).toBe(false);
    expect(canAccessDepartment(USERS.dept_prefix, 'QC')).toBe(true); // DEPT-QC <-> QC
    expect(canAccessDepartment(USERS.primary_counts, 'WH')).toBe(true); // primaryDepartment counts
    expect(canAccessDepartment(USERS.l3_mgt_only, 'PD')).toBe(false); // level 3 is NOT automatically all-department (client canAction is strict too)
  });
});

// ───────────────────────── T5.3d : "check one row, change another" must be impossible ─────────────────────────
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const P = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => {
      sdb.exec('BEGIN');
      try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; }
    }
  };
}

describe.skipIf(!DatabaseSync)('T5.3d master-data handlers act on the row they checked', () => {
  let sdb; let env; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const one = (q, ...p) => rows(q, ...p)[0];
  const call = async (who, method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    for (const u of Object.values(P)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(P)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    const prod = sdb.prepare('INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES (?, ?, ?, ?, ?, 5, 0)');
    prod.run('P-PD', 'PD-A', 'pd product', 'PD', 'PD'); prod.run('P-QC', 'QC-A', 'qc product', 'QC', 'QC');
    const ven = sdb.prepare('INSERT INTO vendors (id, code, name, department, isDeleted) VALUES (?, ?, ?, ?, 0)');
    ven.run('V-PD', 'VPD', 'pd vendor', 'PD'); ven.run('V-QC', 'VQC', 'qc vendor', 'QC');
    const loc = sdb.prepare('INSERT INTO storage_locations (id, name, department) VALUES (?, ?, ?)');
    loc.run('L-PD', 'pd loc', 'PD'); loc.run('L-QC', 'qc loc', 'QC');
    sdb.prepare("INSERT INTO usage_units (id, name, department) VALUES ('UN-QC', 'qc unit', 'QC')").run();
  });

  it('products PUT : the checked row is the one updated ; a body id / code pointing at another department\'s row cannot redirect it', async () => {
    // body id names another record than the URL -> 400, nothing written
    expect((await call('L1', 'PUT', '/api/products/P-PD', { id: 'P-QC', name: 'hijack' })).status).toBe(400);
    expect((await call('L1', 'PUT', '/api/products/no-such-row', { id: 'P-QC', name: 'hijack' })).status).toBe(400);
    expect(one("SELECT name FROM products WHERE id = 'P-QC'").name).toBe('qc product');
    // body code of the QC row : the URL row (PD) is what changes, the QC row stays
    const r = await call('L1', 'PUT', '/api/products/P-PD', { code: 'QC-A', name: 'renamed pd' });
    expect(r.status).toBe(200);
    expect(one("SELECT name FROM products WHERE id = 'P-PD'").name).toBe('renamed pd');
    expect(one("SELECT name, code FROM products WHERE id = 'P-QC'")).toEqual({ name: 'qc product', code: 'QC-A' });
    // the URL itself may be the code, with the matching id in the body
    expect((await call('L1', 'PUT', '/api/products/PD-A', { id: 'P-PD', name: 'by code' })).status).toBe(200);
    expect(one("SELECT name FROM products WHERE id = 'P-PD'").name).toBe('by code');
    // the QC row directly / via POST upsert by its code / inside a batch
    expect((await call('L1', 'PUT', '/api/products/P-QC', { name: 'x' })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/products', { id: 'NEW-1', code: 'QC-A', name: 'x', department: 'PD' })).status).toBe(403);
    // the bulk stock-sync route is sent with products of every department : the QC row is skipped silently, the PD row is written
    const batch = await call('L1', 'PUT', '/api/products/batch', [{ id: 'P-PD', name: 'ok' }, { id: 'P-QC', name: 'x' }]);
    expect(batch.status).toBe(200);
    expect(batch.json).toMatchObject({ success: true, count: 1, skipped: ['P-QC'] });
    expect(one("SELECT name FROM products WHERE id = 'P-QC'").name).toBe('qc product');
    expect(one("SELECT name FROM products WHERE id = 'P-PD'").name).toBe('ok');
  });

  it('products/batch with the payload the client really sends (every department, full product objects) : own rows written, others skipped, nothing moved out of reach', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-ALL', 'ALL-A', 'shared', 'ALL', 'ALL', 1, 0)").run();
    const full = (id, code, dept, stock) => ({ id, code, name: `n-${id}`, category: dept, department: dept, purchaseUnit: 'ชิ้น', usageUnit: 'ชิ้น', conversionRate: 1, minStock: 0, currentStock: stock, standardPrice: 9, locationId: '' });
    const payload = [full('P-PD', 'PD-A', 'PD', 11), full('P-QC', 'QC-A', 'QC', 22), full('P-ALL', 'ALL-A', 'ALL', 33),
      { ...full('P-PD', 'PD-A', 'PD', 44), department: 'QC', category: 'QC' }]; // tries to move the PD row to QC
    for (const who of ['L1']) {
      const r = await call(who, 'PUT', '/api/products/batch', payload);
      expect(r.status).toBe(200);
      expect(r.json.skipped).toEqual(['P-QC', 'P-PD']);
    }
    expect(rows('SELECT id, currentStock, department FROM products ORDER BY id')).toEqual([
      { id: 'P-ALL', currentStock: 33, department: 'ALL' },
      { id: 'P-PD', currentStock: 11, department: 'PD' }, // written by the first item, never moved to QC, not overwritten by the 4th
      { id: 'P-QC', currentStock: 5, department: 'QC' }
    ]);
    // admin / online purchaser write every row
    const a = await call('ADMIN', 'PUT', '/api/products/batch', payload.slice(0, 3));
    expect(a.json.skipped).toBeUndefined();
    expect(one("SELECT currentStock FROM products WHERE id = 'P-QC'").currentStock).toBe(22);
    // POST on the batch route behaves the same
    const p = await call('L1', 'POST', '/api/products/batch', [{ ...full('P-QC', 'QC-A', 'QC', 99), standardPrice: 10 }, full('P-NEW', 'NEW-A', 'PD', 1)]); // master field (price) differs -> reported ; stock alone would be silent
    expect(p.json).toMatchObject({ count: 1, skipped: ['P-QC'] });
    expect(one("SELECT currentStock FROM products WHERE id = 'P-QC'").currentStock).toBe(22);
    // all rows forbidden -> still 200 with nothing written
    const none = await call('L1', 'PUT', '/api/products/batch', [{ ...full('P-QC', 'QC-A', 'QC', 7), standardPrice: 10 }]);
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ count: 0, skipped: ['P-QC'] });
    // a category with no department is the department that gets written : it has to be reachable
    expect((await call('L1', 'POST', '/api/products', { id: 'P-CAT', code: 'CAT-1', name: 'n', category: 'QC' })).status).toBe(403);
    // a single (non-batch) PUT of a forbidden row stays a hard 403
    expect((await call('L1', 'PUT', '/api/products/P-QC', { name: 'x' })).status).toBe(403);
  });

  it('vendors POST is keyed by id (ON CONFLICT(id)) : the checked row is the written row ; a code that belongs to another row is a 409', async () => {
    // new id + code of the QC vendor -> 409, nothing written
    const dup = await call('L1', 'POST', '/api/vendors', { id: 'V-NEW', code: 'VQC', name: 'dup', department: 'PD' });
    expect(dup.status).toBe(409);
    expect(rows("SELECT id FROM vendors WHERE id = 'V-NEW'").length).toBe(0);
    // existing PD id carrying the QC vendor's code -> 409 (would be a UNIQUE clash), QC row untouched
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-PD', code: 'VQC', name: 'x', department: 'PD' })).status).toBe(409);
    expect(rows('SELECT id, name FROM vendors ORDER BY id')).toEqual([{ id: 'V-PD', name: 'pd vendor' }, { id: 'V-QC', name: 'qc vendor' }]);
    // the QC row by its own id : forbidden ; the PD row by its own id and code : fine
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-QC', code: 'VQC', name: 'x', department: 'PD' })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-PD', code: 'VPD', name: 'pd v2', department: 'PD' })).status).toBe(200);
    // vendorCode is the vendors alias of `code` (products use itemCode)
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-NEW2', vendorCode: 'VQC', name: 'dup', department: 'PD' })).status).toBe(409);
    expect((await call('L1', 'POST', '/api/products', { id: 'P-X', vendorCode: 'QC-A', code: 'FREE-1', name: 'n', department: 'PD' })).status).toBe(200); // vendorCode means nothing for products
    expect((await call('L1', 'POST', '/api/products', { id: 'P-Y', itemCode: 'QC-A', name: 'n', department: 'PD' })).status).toBe(403); // itemCode does : it is the code the handler writes with
  });

  it('vendors PUT : UPDATE hits only the checked row (it used to hit every row matching id OR code)', async () => {
    const r = await call('L1', 'PUT', '/api/vendors/V-PD', { id: 'V-PD', code: 'VQC', name: 'pd renamed', department: 'PD' });
    expect(r.status).toBe(200);
    expect(rows('SELECT id, name FROM vendors ORDER BY id')).toEqual([{ id: 'V-PD', name: 'pd renamed' }, { id: 'V-QC', name: 'qc vendor' }]);
    expect((await call('L1', 'PUT', '/api/vendors/V-PD', { id: 'V-QC', name: 'hijack' })).status).toBe(400);
    expect((await call('L1', 'PUT', '/api/vendors/V-QC', { name: 'hijack' })).status).toBe(403);
    expect((await call('L1', 'PUT', '/api/vendors', { id: 'V-QC', name: 'hijack' })).status).toBe(403); // no URL id : the body id is the target
    expect((await call('L1', 'PUT', '/api/vendors', { id: 'nope', code: 'VQC', name: 'hijack' })).status).toBe(403); // ... or the body code
    expect(one("SELECT name FROM vendors WHERE id = 'V-QC'").name).toBe('qc vendor');
  });

  it('DELETE products / vendors / storage-locations : the row\'s department is checked first (admin / own department pass)', async () => {
    expect((await call('L1', 'DELETE', '/api/products/P-QC')).status).toBe(403);
    expect((await call('L1', 'DELETE', '/api/products/QC-A')).status).toBe(403); // by code
    expect(one("SELECT isDeleted FROM products WHERE id = 'P-QC'").isDeleted).toBe(0);
    expect((await call('L1', 'DELETE', '/api/vendors/V-QC')).status).toBe(403);
    expect((await call('L1', 'DELETE', '/api/vendors/VQC')).status).toBe(403);
    expect(one("SELECT isDeleted FROM vendors WHERE id = 'V-QC'").isDeleted).toBe(0);
    expect((await call('L1', 'DELETE', '/api/storage-locations/L-QC')).status).toBe(403);
    expect(rows("SELECT id FROM storage_locations WHERE id = 'L-QC'").length).toBe(1);
    // own department / by code : only that row goes
    expect((await call('L1', 'DELETE', '/api/products/PD-A')).status).toBe(200);
    expect(rows('SELECT id, isDeleted FROM products ORDER BY id')).toEqual([{ id: 'P-PD', isDeleted: 1 }, { id: 'P-QC', isDeleted: 0 }]);
    expect((await call('L1', 'DELETE', '/api/vendors/V-PD')).status).toBe(200);
    expect((await call('L1', 'DELETE', '/api/storage-locations/L-PD')).status).toBe(200);
    // admin / online purchaser are not limited by department
    expect((await call('ONLINE', 'DELETE', '/api/vendors/V-QC')).status).toBe(200);
    expect((await call('ADMIN', 'DELETE', '/api/products/P-QC')).status).toBe(200);
    expect((await call('ADMIN', 'DELETE', '/api/storage-locations/L-QC')).status).toBe(200);
    expect((await call('L1', 'DELETE', '/api/products/never-existed')).status).toBe(200); // unknown id : nothing to do, as before
  });

  it('usage-units / storage-locations PUT : a body id that differs from the URL is refused (400)', async () => {
    expect((await call('L1', 'PUT', '/api/usage-units/UN-NEW', { id: 'UN-QC', name: 'x', department: 'PD' })).status).toBe(400);
    expect((await call('L1', 'PUT', '/api/storage-locations/L-PD', { id: 'L-QC', name: 'x' })).status).toBe(400);
    expect(one("SELECT name FROM usage_units WHERE id = 'UN-QC'").name).toBe('qc unit');
    expect(one("SELECT name FROM storage_locations WHERE id = 'L-QC'").name).toBe('qc loc');
    expect((await call('L1', 'PUT', '/api/storage-locations/L-PD', { id: 'L-PD', name: 'renamed' })).status).toBe(200);
  });

  it('budget-transactions : dept and department must name the same, reachable department', async () => {
    const tx = (extra) => ({ id: `T-${Math.random().toString(36).slice(2, 9)}`, type: 'ACTUAL_SPEND', amount: -5, docNo: 'D-1', ...extra });
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ dept: 'PD', department: 'QC' }))).status).toBe(403); // checked on PD, would be recorded under QC
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ dept: 'QC', department: 'PD' }))).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ dept: 'ฝ่าย PD', department: 'PD' }))).status).toBe(200); // same department, two spellings
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ dept: 'ฝ่าย PD', department: 'ฝ่าย PD' }))).status).toBe(200); // what the client sends
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ department: 'PD' }))).status).toBe(200); // only one of the two
    expect((await call('L1', 'POST', '/api/budget-transactions', tx({ dept: 'dept-pd', department: 'PD' }))).status).toBe(200);
    const norm = (d) => String(d).replace(/^ฝ่าย\s*/, '').trim().toUpperCase().replace(/^DEPT-/, '');
    const stored = rows('SELECT dept, department FROM budget_transactions');
    expect(stored.length).toBe(4); // only the four consistent posts were written
    expect(stored.every((r) => norm(r.dept) === 'PD' && norm(r.department) === 'PD')).toBe(true);
  });

  it('the department that counts is `department || category` (what the handler writes and MasterDataView checks) : category is looked at only when there is no department', async () => {
    const withDept = (category) => call('L1', 'POST', '/api/products', { id: `W-${category}`, code: `WC-${category}`, name: 'n', department: 'PD', category });
    const noDept = (category, who = 'L1') => call(who, 'POST', '/api/products', { id: `N-${category}`, code: `NC-${category}`, name: 'n', category });
    for (const populate of [false, true]) {
      if (populate) sdb.prepare("INSERT INTO departments (id, code, name, isActive) VALUES ('DEPT-PD','PD','PD',1), ('DEPT-QC','QC','QC',1)").run();
      const tag = populate ? 'departments populated' : 'departments table empty';
      // a department is present : the category is only a label, whatever it looks like
      for (const c of ['QC', 'WH', 'Tools', 'วัสดุสิ้นเปลือง', 'A-1', 'XYZ']) expect((await withDept(c)).status, `${tag} dept+${c}`).toBe(200);
      sdb.prepare("DELETE FROM products WHERE id LIKE 'W-%'").run();
      // no department : the category IS the department that gets written - it has to be reachable (fail closed, also with an empty departments table)
      expect((await noDept('QC')).status, `${tag} QC`).toBe(403);
      expect((await noDept('WH')).status, `${tag} WH`).toBe(403);
      expect((await noDept('Tools')).status, `${tag} label`).toBe(403);
      expect((await noDept('PD')).status, `${tag} PD`).toBe(200);
      expect((await noDept('ALL')).status, `${tag} ALL`).toBe(200); // shared master data
      expect((await noDept('QC', 'ADMIN')).status, `${tag} admin`).toBe(200);
      expect((await noDept('QC', 'ONLINE')).status, `${tag} online`).toBe(200);
      sdb.prepare("DELETE FROM products WHERE id LIKE 'N-%'").run();
    }
  });

  it('malformed rows (null / number / string / nested array) are a 400, never a 500 - batch, single, vendors, storage-locations', async () => {
    for (const bad of [null, 5, 'abc', [1], true]) {
      expect((await call('L1', 'PUT', '/api/products/batch', [{ id: 'P-PD', name: 'ok' }, bad])).status, `batch [.., ${JSON.stringify(bad)}]`).toBe(400);
      expect((await call('L1', 'POST', '/api/products/batch', [bad])).status, `post batch [${JSON.stringify(bad)}]`).toBe(400);
      expect((await call('L1', 'POST', '/api/products', { products: [bad] })).status).toBe(400);
      expect((await call('L1', 'POST', '/api/vendors', [bad])).status).toBe(400);
    }
    // the same bodies that are not even a list of rows
    for (const body of [null, 5, 'abc', true]) {
      expect((await call('L1', 'PUT', '/api/products/batch', body)).status, `body ${JSON.stringify(body)}`).toBe(400);
      expect((await call('L1', 'POST', '/api/products', body)).status).toBe(400);
      expect((await call('L1', 'PUT', '/api/products/P-PD', body)).status).toBe(400);
      expect((await call('L1', 'PUT', '/api/vendors/V-PD', body)).status).toBe(400);
      expect((await call('L1', 'POST', '/api/storage-locations', body)).status).toBe(400);
    }
    // a malformed row refuses the WHOLE batch : the good row before it is not written
    expect(one("SELECT name FROM products WHERE id = 'P-PD'").name).toBe('pd product');
    expect(one("SELECT currentStock FROM products WHERE id = 'P-QC'").currentStock).toBe(5);
  });
});
