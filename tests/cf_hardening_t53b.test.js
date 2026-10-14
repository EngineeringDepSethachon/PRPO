// @vitest-environment node
// T5.3b (kla whole-system review): ledger write gate, master-data department gate, login body limit, alias removal,
// Preview D1 binding, no-sourcemap / no-demo-credentials Cloudflare bundle, prepare-cloudflare never rewrites the root wrangler.toml.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { hashPassword } from '../functions/_lib/password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const readRel = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};

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
    batch: async (stmts) => {
      sdb.exec('BEGIN');
      try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; }
    }
  };
}

describe.skipIf(!DatabaseSync)('T5.3b functional', () => {
  let sdb; let env; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const call = async (who, method, p, body, init = {}) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method,
        headers: { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) },
        body: body === undefined ? undefined : (typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body)),
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
      }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
  });

  // ───────── 3) POST /api/budget-transactions ─────────
  it('ledger : non-writers post only the record types the client sends, for a department they can reach', async () => {
    const tx = (type, dept, extra = {}) => ({ id: `T-${Math.random().toString(36).slice(2, 9)}`, type, dept, department: dept, amount: -10, docNo: 'DOC-1', ...extra });
    // what workflowEngine really sends ("ฝ่าย PD" department text)
    for (const type of ['PR_RELEASE', 'ACTUAL_SPEND', 'PO_CANCEL_REFUND']) {
      expect((await call('L1', 'POST', '/api/budget-transactions', tx(type, 'ฝ่าย PD'))).status, type).toBe(200);
    }
    expect(rows('SELECT id FROM budget_transactions').length).toBe(3);
    // other department / wildcard / no department
    expect((await call('L1', 'POST', '/api/budget-transactions', tx('ACTUAL_SPEND', 'ฝ่าย QC'))).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budget-transactions', tx('ACTUAL_SPEND', 'ALL'))).status).toBe(403);
    expect((await call('L1', 'POST', '/api/budget-transactions', { id: 'T-nodept', type: 'ACTUAL_SPEND', amount: 1 })).status).toBe(403);
    // allocation types need the budget permission ; unknown types are refused
    for (const type of ['MONTHLY_ALLOCATION', 'SET_BUDGET', 'BUDGET_ADJUSTMENT_UP', 'BUDGET_ADJUSTMENT_DOWN', 'WHATEVER', '']) {
      expect((await call('L1', 'POST', '/api/budget-transactions', tx(type, 'PD'))).status, type || '(empty)').toBe(403);
      expect((await call('ONLINE', 'POST', '/api/budget-transactions', tx(type, 'PD'))).status, `online ${type}`).toBe(403);
    }
    expect((await call('L1', 'POST', '/api/budget-transactions', { ...tx('ACTUAL_SPEND', 'PD'), actionType: 'MONTHLY_ALLOCATION' })).status).toBe(403); // actionType is checked too
    // the online purchaser works across departments
    expect((await call('ONLINE', 'POST', '/api/budget-transactions', tx('ACTUAL_SPEND', 'ฝ่าย QC'))).status).toBe(200);
    // a budget writer is not restricted
    for (const type of ['MONTHLY_ALLOCATION', 'SET_BUDGET', 'TOP_UP', 'BUDGET_ROLLBACK']) {
      expect((await call('L2', 'POST', '/api/budget-transactions', tx(type, 'PD'))).status, `writer ${type}`).toBe(200);
    }
    expect((await call('ADMIN', 'POST', '/api/budget-transactions', tx('MONTHLY_ALLOCATION', 'QC'))).status).toBe(200);
  });

  it('ledger : BUDGET_ROLLBACK / TOP_UP rows from a non-writer are acknowledged but NOT stored, so they cannot eat another PO\'s refund cap', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,1000,500,500)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('id-PR-K','PR-K','PD','PO_ISSUED',100,'[]')").run();
    sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES ('K-PR-K','PD','PD','PR_COMMITMENT','PR_COMMITMENT',-100,'PR-K')").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-PO-K','PO-K','PR-K','PD','ORDERED','[]',?)").run(JSON.stringify({ approvedTotal: 100 }));
    for (const type of ['BUDGET_ROLLBACK', 'TOP_UP']) {
      const r = await call('L1', 'POST', '/api/budget-transactions', { id: `EAT-${type}`, type, dept: 'PD', amount: 100, docNo: 'PO-K', poNumber: 'PO-K' });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ duplicate: true, serverManaged: true });
    }
    expect(rows("SELECT id FROM budget_transactions WHERE docNo = 'PO-K'").length).toBe(0);
    // the real refund of that PO still fits in the cap
    const adj = await call('L1', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: 100, docNo: 'PO-K' });
    expect(adj.status).toBe(200);
  });

  // ───────── 4) master data ─────────
  it('products / vendors / storage-locations : department gate + body shape', async () => {
    // products
    expect((await call('L1', 'POST', '/api/products', { id: 'P-PD', code: 'PD-1', name: 'a', department: 'PD', category: 'PD' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/products', { id: 'P-QC', code: 'QC-1', name: 'b', department: 'QC', category: 'QC' })).status).toBe(403);
    expect(rows("SELECT id FROM products WHERE id = 'P-QC'").length).toBe(0);
    expect((await call('ADMIN', 'POST', '/api/products', { id: 'P-QC', code: 'QC-1', name: 'b', department: 'QC', category: 'QC' })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/products/P-QC', { name: 'hijack' })).status).toBe(403); // existing row of another department
    expect((await call('L1', 'PUT', '/api/products/P-QC', { name: 'hijack', department: 'PD' })).status).toBe(403); // cannot move it to its own either
    expect(rows("SELECT name FROM products WHERE id = 'P-QC'")[0].name).toBe('b');
    // the bulk stock-sync route skips the rows the user cannot reach (T5.3e) instead of refusing the whole list
    const batch = await call('L1', 'PUT', '/api/products/batch', [{ id: 'P-PD', name: 'a2', department: 'PD' }, { id: 'P-QC', currentStock: 99 }]);
    expect(batch.status).toBe(200);
    expect(batch.json.skipped).toEqual(['P-QC']);
    expect(rows("SELECT name FROM products WHERE id = 'P-PD'")[0].name).toBe('a2');
    expect(rows("SELECT currentStock FROM products WHERE id = 'P-QC'")[0].currentStock).not.toBe(99);
    expect((await call('L1', 'PUT', '/api/products/batch', [{ id: 'P-PD', name: 'a3', department: 'PD' }])).status).toBe(200);
    expect((await call('L1', 'POST', '/api/products', { id: 'P-ALL', code: 'ALL-1', name: 'shared', department: 'ALL' })).status).toBe(200); // shared master data is open to everybody (client rule)
    expect((await call('ONLINE', 'POST', '/api/products', { id: 'P-ON', code: 'ON-1', name: 'o', department: 'QC' })).status).toBe(200); // online works across departments
    // a product category that is not a department code is just a label
    expect((await call('L1', 'POST', '/api/products', { id: 'P-LBL', code: 'LBL-1', name: 'x', department: 'PD', category: 'วัสดุสิ้นเปลือง' })).status).toBe(200);
    // vendors
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-PD', code: 'V1', name: 'v', department: 'PD' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-ALL', code: 'V2', name: 'v', department: 'ALL' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-QC', code: 'V3', name: 'v', department: 'QC' })).status).toBe(403);
    expect((await call('ADMIN', 'POST', '/api/vendors', { id: 'V-QC', code: 'V3', name: 'v', department: 'QC' })).status).toBe(200);
    expect((await call('L1', 'PUT', '/api/vendors/V-QC', { name: 'x' })).status).toBe(403);
    expect((await call('L1', 'PUT', '/api/vendors/V-PD', { name: 'v2', department: 'PD' })).status).toBe(200);
    // storage locations
    expect((await call('L1', 'POST', '/api/storage-locations', { id: 'L-PD', name: 'A', department: 'PD' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/storage-locations', { id: 'L-QC', name: 'B', department: 'QC' })).status).toBe(403);
    await call('ADMIN', 'POST', '/api/storage-locations', { id: 'L-QC', name: 'B', department: 'QC' });
    expect((await call('L1', 'POST', '/api/storage-locations', { id: 'L-QC', name: 'overwrite', department: 'PD' })).status).toBe(403); // overwrite of another department's row
    // body shape : an absurdly deep body is refused before it is used
    let deep = { v: 1 };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect((await call('L1', 'POST', '/api/products', { id: 'P-DEEP', code: 'D', name: 'd', department: 'PD', extra: deep })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/vendors', { id: 'V-DEEP', code: 'VD', name: 'd', department: 'PD', extra: deep })).status).toBe(400);
    expect((await call('L1', 'POST', '/api/storage-locations', { id: 'L-DEEP', name: 'd', department: 'PD', extra: deep })).status).toBe(400);
  });

  // ───────── users : no default / trivial passwords ─────────
  it('POST/PUT /api/users : a known default (any case) or a password shorter than 6 is refused ; a real one is hashed ; no password = unchanged', async () => {
    const base = { name: 'New', department: 'PD', roleId: 'REQUESTER_PD', level: 1 };
    for (const pw of ['password123', 'PASSWORD123', 'Admin123', 'admin123', '123456', 'abc12', 'x']) {
      const r = await call('ADMIN', 'POST', '/api/users', { ...base, id: `U-${pw}`, username: `u.${pw}`.toLowerCase(), password: pw });
      expect(r.status, pw).toBe(400);
      expect(r.json.error).toBe('กรุณาตั้งรหัสผ่านใหม่ ห้ามใช้รหัสเริ่มต้น');
    }
    expect(rows("SELECT id FROM users WHERE id LIKE 'U-%' AND id NOT IN ('U-L1','U-L2','U-ON','U-AD')").length).toBe(0);
    const ok = await call('ADMIN', 'POST', '/api/users', { ...base, id: 'U-NEW', username: 'new.user', password: 'Abcdef1!' });
    expect(ok.status).toBe(200);
    const h1 = rows("SELECT passwordHash, password FROM users WHERE id = 'U-NEW'")[0];
    expect(h1.passwordHash).toBeTruthy();
    expect(h1.password).toBe('');
    // edit without a password : the stored one stays ; edit to a default : refused and unchanged
    expect((await call('ADMIN', 'PUT', '/api/users/U-NEW', { ...base, id: 'U-NEW', username: 'new.user', name: 'Renamed' })).status).toBe(200);
    expect(rows("SELECT passwordHash FROM users WHERE id = 'U-NEW'")[0].passwordHash).toBe(h1.passwordHash);
    expect((await call('ADMIN', 'PUT', '/api/users/U-NEW', { ...base, id: 'U-NEW', username: 'new.user', password: 'Password123' })).status).toBe(400);
    expect(rows("SELECT passwordHash FROM users WHERE id = 'U-NEW'")[0].passwordHash).toBe(h1.passwordHash);
    expect((await call('ADMIN', 'PUT', '/api/users/U-NEW', { ...base, id: 'U-NEW', username: 'new.user', password: 'Another-Pass9' })).status).toBe(200);
    expect(rows("SELECT passwordHash FROM users WHERE id = 'U-NEW'")[0].passwordHash).not.toBe(h1.passwordHash);
  });

  // ───────── 6) + 7) login ─────────
  it('POST /api/auth : > 8 KB is refused with 413 before parsing (Content-Length or counted stream) ; the old prasert.mgr alias is gone', async () => {
    const big = JSON.stringify({ username: 'x', password: 'y'.repeat(9000) });
    const withCl = await call(null, 'POST', '/api/auth', big, { headers: { 'Content-Length': String(big.length) } });
    expect(withCl.status).toBe(413);
    const stream = new ReadableStream({
      start(c) { const enc = new TextEncoder(); for (let i = 0; i < 20; i++) c.enqueue(enc.encode('a'.repeat(1000))); c.close(); }
    });
    const noCl = await call(null, 'POST', '/api/auth', stream);
    expect(noCl.status).toBe(413);
    // a normal login body is unaffected
    expect((await call(null, 'POST', '/api/auth', { username: 'nobody', password: 'x' })).status).toBe(401);
    expect((await call(null, 'POST', '/api/auth', { username: '', password: 'x' })).status).toBe(400);
    expect((await call(null, 'POST', '/api/auth', 'not json')).status).toBe(400);

    // alias: prasert.mgr used to log in as prasert.pm
    const h = await hashPassword('Correct-Pass1');
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U-PM','prasert.pm','','P','PD','[\"PD\"]','REQUESTER_PD','REQUESTER',1,'ACTIVE',?,?,?,?)")
      .run(h.hash, h.salt, h.algo, h.iterations);
    expect((await call(null, 'POST', '/api/auth', { username: 'prasert.pm', password: 'Correct-Pass1' })).status).toBe(200);
    expect((await call(null, 'POST', '/api/auth', { username: 'prasert.mgr', password: 'Correct-Pass1' })).status).toBe(401);
  });
});

describe('T5.3b static / config', () => {
  it('wrangler.toml : Preview has its own D1 binding (never the production database) ; the example file too', () => {
    for (const f of ['wrangler.toml', 'wrangler.toml.example']) {
      const t = readRel(f);
      const prod = /\[\[d1_databases\]\][^[]*?database_name\s*=\s*"([^"]+)"[^[]*?database_id\s*=\s*"([^"]+)"/s.exec(t);
      const prev = /\[\[env\.preview\.d1_databases\]\][^[]*?binding\s*=\s*"DB"[^[]*?database_name\s*=\s*"([^"]+)"[^[]*?database_id\s*=\s*"([^"]+)"/s.exec(t);
      expect(prod, f).not.toBeNull();
      expect(prev, `${f} preview block`).not.toBeNull();
      expect(prev[1]).toBe('prpo-db-preview');
      expect(prev[1]).not.toBe(prod[1]);
      expect(prev[2]).not.toBe(prod[2]);
    }
    expect(readRel('wrangler.toml')).toContain('<PREVIEW_DATABASE_ID>');
  });

  it('vite : no source maps in the cloudflare bundle, every other mode unchanged', async () => {
    const cfg = (await import('../vite.config.js')).default;
    expect(cfg({ mode: 'cloudflare' }).build.sourcemap).toBe(false);
    expect(cfg({ mode: 'gas' }).build.sourcemap).toBe(true);
    expect(cfg({ mode: 'development' }).build.sourcemap).toBe(true);
    // the same single definition : VITE_BACKEND_MODE=cloudflare marks a Cloudflare build whatever the vite mode is
    const before = process.env.VITE_BACKEND_MODE;
    try {
      process.env.VITE_BACKEND_MODE = 'Cloudflare';
      expect(cfg({ mode: 'development' }).build.sourcemap).toBe(false);
      expect(cfg({ mode: 'development' }).define['import.meta.env.VITE_BACKEND_MODE']).toBe('"cloudflare"');
      process.env.VITE_BACKEND_MODE = 'mock';
      expect(cfg({ mode: 'development' }).build.sourcemap).toBe(true);
    } finally {
      if (before === undefined) delete process.env.VITE_BACKEND_MODE; else process.env.VITE_BACKEND_MODE = before;
    }
  });

  it('prepare-cloudflare.js never rewrites the root wrangler.toml / wrangler.toml.example', () => {
    const s = readRel('scripts', 'prepare-cloudflare.js');
    expect(s).not.toMatch(/writeFileSync\(\s*path\.join\(ROOT_DIR,\s*'wrangler/);
    expect(s).toMatch(/NEVER touches the root files/);
  });
});

describe('T5.3b cloudflare client build', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('MODE=cloudflare : no demo account credentials, no password shortcuts ; other modes keep them', async () => {
    vi.resetModules();
    vi.stubEnv('MODE', 'cloudflare');
    const cf = await import('../src/services/authService.js');
    expect(cf.IS_CLOUDFLARE_BUILD).toBe(true);
    expect(JSON.stringify(cf.DEFAULT_EMPLOYEE_ACCOUNTS)).not.toMatch(/password|pin|admin123|123456/i);
    expect(cf.DEFAULT_EMPLOYEE_ACCOUNTS.every((a) => !a.password && !a.pin)).toBe(true);
    expect(cf.DEFAULT_EMPLOYEE_ACCOUNTS[0]).toMatchObject({ roleId: 'REQUESTER_PD', level: 1 }); // pre-login code reading [0] keeps working
    // the offline login path accepts no shortcut password in this build (123456 for anyone, admin123 ...)
    vi.stubEnv('VITE_BACKEND_MODE', 'mock'); // force the local path of login()
    await expect(cf.authService.login('guest', '123456')).rejects.toThrow();

    // the same flag when only VITE_BACKEND_MODE says cloudflare (single definition, shared with vite.config.js)
    vi.resetModules();
    vi.stubEnv('MODE', 'test');
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const viaBackendMode = await import('../src/services/authService.js');
    expect(viaBackendMode.IS_CLOUDFLARE_BUILD).toBe(true);
    expect(viaBackendMode.DEFAULT_EMPLOYEE_ACCOUNTS.every((a) => !a.password && !a.pin)).toBe(true);

    vi.resetModules();
    vi.stubEnv('MODE', 'test');
    vi.stubEnv('VITE_BACKEND_MODE', '');
    const normal = await import('../src/services/authService.js');
    expect(normal.IS_CLOUDFLARE_BUILD).toBe(false);
    expect(normal.DEFAULT_EMPLOYEE_ACCOUNTS.length).toBe(6);
    expect(normal.DEFAULT_EMPLOYEE_ACCOUNTS[0].password).toBe('password123');
  });
});
