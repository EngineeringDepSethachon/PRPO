// @vitest-environment node
// QA edge cases for TC-008 (issue unit cost) and TC-007 (stock log view). Same harness as cf_tc007_tc008.test.js.
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

describe('stockLogView edge', () => {
  it('null / non-object passthrough, qty from negative changeQty, qty 0 kept', () => {
    expect(stockLogView(null)).toBe(null);
    expect(stockLogView({ changeQty: -5 }).qty).toBe(5);
    expect(stockLogView({ quantity: 0 }).qty).toBe(0);
  });
  it('adds no secret-looking fields', () => {
    const keys = Object.keys(stockLogView({ id: 'x', createdAt: '2026-01-01T00:00:00.000Z', quantity: 1, notes: 'n', productName: 'p', balance: 3 }));
    expect(keys.sort()).toEqual(['balance', 'balanceAfter', 'createdAt', 'date', 'id', 'name', 'note', 'notes', 'productName', 'qty', 'quantity', 'timestamp'].sort());
  });
});

describe('TC-008 issue cost cases', () => {
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
  });
  const addProd = (id, avg, std, stock) => sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, avgCost, currentStock, minStock, isDeleted) VALUES (?,?,?, 'PD','PD','ถัง','ลิตร',1,?,?,?,0,0)").run(id, `C-${id}`, `N-${id}`, std, avg, stock);

  it('avgCost > 0 wins over the latest IN price and the client unitCost', async () => {
    addProd('A', 134.29, 100, 10);
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, balance, unitPrice, department, createdAt) VALUES ('I1','A','IN',10,10,300,'PD','2026-02-01 00:00:00')").run();
    const r = await call('POST', '/api/stock/issue', { productId: 'A', quantity: 1, unitCost: 5, issuedTo: 'K1' });
    expect(r.json.logEntry.unitCost).toBe(134.29);
  });
  it('avgCost 0 and no IN history -> standard price', async () => {
    addProd('B', 0, 100, 10);
    const r = await call('POST', '/api/stock/issue', { productId: 'B', quantity: 1, issuedTo: 'K1' });
    expect(r.json.logEntry.unitCost).toBe(100);
  });
  it('recalculate-mac with no IN history leaves avgCost untouched ; ignores client averageCost only as GAS fallback', async () => {
    addProd('C', 0, 100, 10);
    const r = await call('POST', '/api/products/recalculate-mac', { productId: 'C' });
    expect(r.status).toBe(200);
    expect(sdb.prepare("SELECT avgCost FROM products WHERE id='C'").get().avgCost).toBe(0);
  });
});
