// @vitest-environment node
// P7 phase 2 : stock-logs product lookup (id -> code -> name) + department gate, recalculate-mac log scoping, login_attempts sweep (0012), e2e secret guard
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken, hasSecret } from '../functions/_lib/auth.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const P = {
  PD: { id: 'U-PD', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const out = []; for (const s of stmts) { out.push(s.all ? await s.all() : await s.run()); } return out; } };
}

describe('P7 phase 2', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, url, body, method = 'POST') => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    expect(DatabaseSync, 'node:sqlite not available').toBeTruthy();
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    for (const u of Object.values(P)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(P)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    const prod = sdb.prepare('INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES (?, ?, ?, ?, ?, 10, 0)');
    prod.run('P-PD', 'SAME-1', 'Same Name', 'PD', 'PD'); prod.run('P-QC', 'QC-ONLY', 'Same Name', 'QC', 'QC'); prod.run('P-QC2', 'QC-TWO', 'qc two', 'QC', 'QC');
  });

  it('stock-logs : a PD user cannot write a log by the code / name of a QC-only product (no id)', async () => {
    const r = await call('PD', '/api/stock-logs', [
      { id: 'L-C', productCode: 'QC-ONLY', department: 'PD', type: 'IN', quantity: 1, unitCost: 1 },
      { id: 'L-N', productName: 'qc only never', department: 'PD', type: 'IN', quantity: 1 }
    ]);
    expect(r.json).toMatchObject({ skipped: ['L-C'], count: 1 });
  });

  it('stock-logs : name shared by PD and QC resolves to the PD product the user can reach ; productId is stored', async () => {
    const r = await call('PD', '/api/stock-logs', { id: 'L-1', productName: 'same name', type: 'IN', quantity: 2, unitCost: 5 });
    expect(r.json).toMatchObject({ success: true, count: 1 });
    const row = sdb.prepare("SELECT productId, department FROM stock_logs WHERE id='L-1'").get();
    expect(row).toMatchObject({ productId: 'P-PD', department: 'PD' });
  });

  it('stock-logs : a QC product id with a PD department on the log is still skipped', async () => {
    const r = await call('PD', '/api/stock-logs', { id: 'L-2', productId: 'P-QC', department: 'PD', type: 'IN', quantity: 1 });
    expect(r.json).toMatchObject({ count: 0, skipped: ['L-2'] });
  });

  it('recalculate-mac : another department\'s IN log (same code/name, by productId) does not move this MAC ; legacy logs without productId use code + department', async () => {
    const ins = sdb.prepare("INSERT INTO stock_logs (id, productId, productCode, productName, type, quantity, unitPrice, unitCost, department, createdAt, balance) VALUES (?,?,?,?, 'IN', ?, ?, ?, ?, ?, 0)");
    ins.run('G1', 'P-PD', 'SAME-1', 'Same Name', 10, 10, 10, 'PD', '2026-01-01T00:00:00Z');
    ins.run('G2', 'P-QC', 'SAME-1', 'Same Name', 10, 1000, 1000, 'PD', '2026-01-02T00:00:00Z'); // other product, forged department/code
    ins.run('G3', '', 'SAME-1', 'Same Name', 10, 30, 30, 'PD', '2026-01-03T00:00:00Z');         // legacy PD log without productId
    ins.run('G4', '', 'SAME-1', 'Same Name', 10, 9999, 9999, 'QC', '2026-01-04T00:00:00Z');     // legacy QC log without productId
    const r = await call('PD', '/api/products/recalculate-mac', { productId: 'P-PD' });
    expect(r.status).toBe(200);
    expect(r.json.averageCost).toBeCloseTo(20, 5); // (10*10 + 10*30) / 20
  });

  it('stock-logs : forged lower-case productId is stored as empty and cannot reach another department\'s MAC ; the log id is not a product id', async () => {
    sdb.prepare("UPDATE products SET id='PROD-123', code='K-123', name='k product', department='QC', category='QC' WHERE id='P-QC'").run();
    const r = await call('PD', '/api/stock-logs', [{ id: 'F-1', productId: 'prod-123', type: 'IN', quantity: 5, unitCost: 9999, department: 'PD' }, { id: 'PROD-123', type: 'IN', quantity: 5, unitCost: 9999, department: 'PD' }]);
    expect(r.json.count).toBe(2);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM stock_logs WHERE productId <> ''").get().c).toBe(0);
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, unitPrice, unitCost, department, createdAt, balance) VALUES ('Q1','PROD-123','IN',10,20,20,'QC','2026-01-01T00:00:00Z',0)").run();
    const m = await call('ADMIN', '/api/products/recalculate-mac', { productId: 'PROD-123' });
    expect(m.json.averageCost).toBeCloseTo(20, 5);
  });

  it('stock-logs : same name in two departments -> the log\'s own department wins, even for admin ; stored department is normalized', async () => {
    const r = await call('ADMIN', '/api/stock-logs', [{ id: 'A-1', productName: 'Same Name', department: 'qc', type: 'IN', quantity: 1 }, { id: 'A-2', productName: 'same name', department: 'dept-pd', type: 'IN', quantity: 1 }]);
    expect(r.json.count).toBe(2);
    expect(sdb.prepare("SELECT productId, department FROM stock_logs WHERE id='A-1'").get()).toMatchObject({ productId: 'P-QC', department: 'QC' });
    expect(sdb.prepare("SELECT productId, department FROM stock_logs WHERE id='A-2'").get()).toMatchObject({ productId: 'P-PD', department: 'PD' });
    const b = await call('ADMIN', '/api/stock-logs', { id: 'A-3', productName: 'Same Name', type: 'IN', quantity: 1 });
    expect(b.json.count).toBe(1);
    expect(sdb.prepare("SELECT productId FROM stock_logs WHERE id='A-3'").get().productId).toBe('P-PD'); // ambiguous : stable order by id
  });

  it('MAC parity : legacy log shapes give the same figure as the original GAS rule (reference port of apiRecalculateProductMAC)', async () => {
    const ins = sdb.prepare("INSERT INTO stock_logs (id, productId, productCode, productName, type, quantity, unitPrice, unitCost, department, createdAt, balance) VALUES (?,?,?,?, 'IN', ?, ?, ?, ?, ?, 0)");
    const rows = [
      ['H1', 'P-PD', 'SAME-1', 'Same Name', 10, 10, 10, 'PD', '2026-01-01T00:00:00Z'],
      ['H2', '', 'SAME-1', '', 5, 16, 16, '', '2026-01-02T00:00:00Z'],            // no productId, no department
      ['H3', 'SAME-1', 'SAME-1', 'Same Name', 5, 22, 22, 'ฝ่ายผลิต', '2026-01-03T00:00:00Z'], // productId = code, Thai department
      ['H4', 'old-import-7', '', 'same name', 5, 30, 30, 'dept-pd', '2026-01-04T00:00:00Z'],    // unknown id, matched by name
      ['H5', '', 'same-1', '', 0, 99, 99, 'PD', '2026-01-05T00:00:00Z']           // qty 0 : ignored
    ];
    rows.forEach((x) => ins.run(...x));
    // original rule (gas/Code.gs 768-803) over the same rows, productId compared as written
    const ref = (() => {
      const pId = 'p-pd'; const pCode = 'same-1'; const pName = 'same name';
      let stock = 0; let avg = 0;
      for (const x of rows) {
        const lId = String(x[1]).toLowerCase(); const lSku = String(x[2]).toLowerCase(); const lName = String(x[3]).toLowerCase();
        if (!((lId === pId) || (lSku === pCode || lId === pCode) || (lName === pName)) || !(x[4] > 0)) continue;
        const ns = stock + x[4]; let na = x[5];
        if (stock > 0 && ns > 0) na = (stock * avg + x[4] * x[5]) / ns;
        avg = Math.round((na + Number.EPSILON) * 100) / 100; stock = ns;
      }
      return avg;
    })();
    const r = await call('PD', '/api/products/recalculate-mac', { productId: 'P-PD' });
    expect(r.json.averageCost).toBeCloseTo(ref, 5);
  });

  it('MAC : a log whose productId is another EXISTING product is not counted even if its code matches ; unknown productId falls back to code/name + department', async () => {
    const ins = sdb.prepare("INSERT INTO stock_logs (id, productId, productCode, productName, type, quantity, unitPrice, unitCost, department, createdAt, balance) VALUES (?,?,?,?, 'IN', ?, ?, ?, ?, ?, 0)");
    ins.run('J1', 'P-PD', 'SAME-1', 'Same Name', 10, 10, 10, 'PD', '2026-01-01T00:00:00Z');
    ins.run('J2', 'P-QC2', 'SAME-1', 'Same Name', 10, 500, 500, 'PD', '2026-01-02T00:00:00Z'); // points at another real product
    ins.run('J3', 'ghost-id', 'SAME-1', '', 10, 30, 30, 'PD', '2026-01-03T00:00:00Z');         // id no product has : counted
    ins.run('J4', 'ghost-2', 'SAME-1', '', 10, 700, 700, 'dept-qc', '2026-01-04T00:00:00Z');   // other department (normalized) : not counted
    const r = await call('PD', '/api/products/recalculate-mac', { productId: 'P-PD' });
    expect(r.json.averageCost).toBeCloseTo(20, 5);
  });

  it('login_attempts : migration 0012 indexes exist ; the first attempt of a key sweeps rows older than 24h', async () => {
    const idx = sdb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='login_attempts'").all().map((x) => x.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_login_attempts_attemptedAt', 'idx_login_attempts_userAgent']));
    const old = Date.now() - 25 * 3600 * 1000;
    sdb.prepare("INSERT INTO login_attempts (kind, identifier, success, attemptedAt, ip, userAgent) VALUES ('USER','name:old',0,?, 'x','x')").run(old);
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nobody', password: 'wrong-pass' }) }), env });
    expect(res.status).toBe(401);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM login_attempts WHERE identifier='name:old'").get().c).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE attemptedAt > ?').get(old + 1).c).toBeGreaterThan(0);
  });

  it('hasSecret : the fixed e2e secret is refused unless ENVIRONMENT=dev', () => {
    const e2e = 'e2e-local-secret-' + 'x'.repeat(30);
    expect(hasSecret({ AUTH_TOKEN_SECRET: e2e })).toBe(false);
    expect(hasSecret({ AUTH_TOKEN_SECRET: e2e, ENVIRONMENT: 'production' })).toBe(false);
    expect(hasSecret({ AUTH_TOKEN_SECRET: e2e, ENVIRONMENT: 'dev' })).toBe(true);
    expect(hasSecret({ AUTH_TOKEN_SECRET: SECRET })).toBe(true);
  });
});
