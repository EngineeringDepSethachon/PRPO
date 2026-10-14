// @vitest-environment node
// TC-008 : issue cost = moving average cost (not the standard price) ; recalculate-mac persists avgCost in D1
// TC-007 : stock log rows reach the screens with timestamp / date / qty (UI names) next to the D1 names
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { stockLogView } from '../functions/_lib/stocklogs.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; } };
}

describe('stockLogView (pure)', () => {
  it('adds timestamp / date / qty / note next to the D1 names', () => {
    const v = stockLogView({ id: 'L', type: 'OUT', quantity: 3, changeQty: -3, createdAt: '2026-10-14T03:00:00.000Z', notes: 'x', date: null });
    expect(v).toMatchObject({ createdAt: '2026-10-14T03:00:00.000Z', timestamp: '2026-10-14T03:00:00.000Z', date: '2026-10-14T03:00:00.000Z', qty: 3, quantity: 3, note: 'x' });
  });
  it('never overwrites a value the row already has', () => {
    const v = stockLogView({ createdAt: '2026-10-14T03:00:00.000Z', timestamp: 'T', date: 'D', qty: 9, quantity: 3, note: 'n', notes: 'x' });
    expect(v).toMatchObject({ timestamp: 'T', date: 'D', qty: 9, note: 'n' });
  });
});

describe('TC-007 / TC-008 over the API', () => {
  let sdb; let env; let token;
  const call = async (method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    // standard price 100 ; avgCost never stored (0) ; two receipts 10 @ 100 then 4 @ 200 -> MAC 128.57
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, avgCost, currentStock, minStock, isDeleted) VALUES ('P1','PD-1','Glue','PD','PD','ถัง','ลิตร',1,100,0,14,2,0)").run();
    sdb.prepare("INSERT INTO stock_logs (id, productId, productCode, productName, type, quantity, balance, unitPrice, department, createdAt) VALUES ('S1','P1','PD-1','Glue','IN',10,10,100,'PD','2026-01-01 00:00:00'),('S2','P1','PD-1','Glue','IN',4,14,200,'PD','2026-02-01 00:00:00')").run();
  });

  it('TC-008 : issue is costed at the latest IN price fail-safe (not the standard price) when avgCost is empty', async () => {
    const r = await call('POST', '/api/stock/issue', { productId: 'P1', quantity: 2, issuedTo: 'ห้อง K1' });
    expect(r.status).toBe(200);
    expect(r.json.logEntry.unitCost).toBe(200);
    expect(sdb.prepare("SELECT unitCost, totalCost FROM stock_logs WHERE type = 'OUT'").get()).toMatchObject({ unitCost: 200, totalCost: 400 });
  });

  it('TC-008 : recalculate-mac stores the MAC in D1 and the next issue uses it ; a client unitCost is ignored', async () => {
    const rc = await call('POST', '/api/products/recalculate-mac', { productId: 'P1' });
    expect(rc.status).toBe(200);
    expect(rc.json.product.avgCost).toBeCloseTo(128.57, 2);
    expect(sdb.prepare('SELECT avgCost FROM products WHERE id = ?').get('P1').avgCost).toBeCloseTo(128.57, 2);
    const r = await call('POST', '/api/stock/issue', { productId: 'P1', quantity: 1, unitCost: 1, issuedTo: 'ห้อง K1' });
    expect(r.json.logEntry.unitCost).toBeCloseTo(128.57, 2);
  });

  it('TC-007 : GET /api/stock-logs and bootstrap rows carry timestamp / date (ISO-Z) / qty for the statistics and history', async () => {
    await call('POST', '/api/stock/issue', { productId: 'P1', quantity: 3, issuedTo: 'ห้อง K1', location: 'ห้อง K1' });
    const list = (await call('GET', '/api/stock-logs')).json;
    const out = list.find((l) => l.type === 'OUT');
    expect(out).toMatchObject({ qty: 3, quantity: 3 });
    expect(out.timestamp).toBe(out.createdAt);
    expect(Number.isNaN(Date.parse(out.timestamp))).toBe(false);
    const inLog = list.find((l) => l.id === 'S2');
    expect(inLog.timestamp).toBe('2026-02-01T00:00:00.000Z');
    expect(inLog.qty).toBe(4);
    const boot = (await call('GET', '/api/bootstrap')).json;
    expect(boot.stockLogs.find((l) => l.type === 'OUT')).toMatchObject({ qty: 3 });
  });
});
