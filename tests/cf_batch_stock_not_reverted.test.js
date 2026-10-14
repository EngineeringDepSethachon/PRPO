// @vitest-environment node
// /api/products/batch (client stock-sync : AppContext, InventoryContext, warehouseService, MasterDataView) must never write currentStock of an
// existing row from the client's cache : the server owns the balance (issue / adjust / manual-in / GRN receive). A NEW row takes its opening balance.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const GR1 = 'GRN-PO-PD-2026-001-01';

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => { sdb.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.all()); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } }
  };
}

const d = DatabaseSync ? describe : describe.skip;

d('products/batch never reverts the server-owned stock', () => {
  let sdb; let env; let tok;
  const call = async (method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const stock = (id) => Number(sdb.prepare('SELECT currentStock FROM products WHERE id = ?').get(id).currentStock);
  // what the client cache holds (loaded before the others moved stock)
  const cached = (id, code, bal, extra = {}) => ({ id, code, name: `Item ${code}`, category: 'PD', department: 'PD', purchaseUnit: 'box', stockUnit: 'pcs', conversionRate: 1, price: 10, stockBalance: bal, currentStock: bal, reorderPoint: 1, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin Boss','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    tok = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    for (const [id, code] of [['PX', 'C-X'], ['PY', 'C-Y']]) {
      sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, isDeleted) VALUES (?,?,?,'PD','PD','box','pcs',1,10,10,1,0)").run(id, code, `Item ${code}`);
    }
  });

  it('A loaded the page (X=10), B issued 6 of X, A syncs a batch (PUT and POST) -> X stays 4', async () => {
    const cache = [cached('PX', 'C-X', 10), cached('PY', 'C-Y', 10)];
    const iss = await call('POST', '/api/stock/issue', { productId: 'PX', quantity: 6 });
    expect(iss.status).toBe(200);
    expect(stock('PX')).toBe(4);
    expect((await call('PUT', '/api/products/batch', cache)).status).toBe(200);
    expect(stock('PX')).toBe(4);
    expect((await call('POST', '/api/products/batch', cache)).status).toBe(200);
    expect(stock('PX')).toBe(4);
    expect(stock('PY')).toBe(10);
  });

  it('manual-in / adjust by someone else then a stale batch (master data cleanup payload) -> balances unchanged, master fields still synced', async () => {
    expect((await call('POST', '/api/stock/manual-in', { productId: 'PX', quantity: 5, reason: 'รับเข้า', requestId: 'r1' })).status).toBe(200);
    expect((await call('POST', '/api/stock/adjust', { productId: 'PY', direction: 'OUT', quantity: 3, reason: 'ปรับ', requestId: 'r2' })).status).toBe(200);
    expect(stock('PX')).toBe(15);
    expect(stock('PY')).toBe(7);
    const r = await call('PUT', '/api/products/batch', [cached('PX', 'C-X', 10, { name: 'Renamed' }), cached('PY', 'C-Y', 10)]);
    expect(r.status).toBe(200);
    expect(stock('PX')).toBe(15);
    expect(stock('PY')).toBe(7);
    expect(sdb.prepare('SELECT name FROM products WHERE id = ?').get('PX').name).toBe('Renamed');
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'PRODUCT_STOCK_SET'").get().c).toBe(0);
  });

  it('a NEW row in the batch takes its opening balance (PUT and POST)', async () => {
    expect((await call('PUT', '/api/products/batch', [cached('PN1', 'C-N1', 7)])).status).toBe(200);
    expect((await call('POST', '/api/products/batch', [cached('PN2', 'C-N2', 3)])).status).toBe(200);
    expect(stock('PN1')).toBe(7);
    expect(stock('PN2')).toBe(3);
  });

  it('GRN receive (stockOnly, server adds stock) then the client batch carrying the pre-receive cache -> received stock kept ; a repeat of the GRN adds nothing', async () => {
    const LINE = { productId: 'PX', code: 'C-X', name: 'Item C-X', qty: 5, purchaseQty: 5, price: 100 };
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('PO-G1', 'PO-PD-2026-001', 'PD001/2026', 'PD', 'ORDERED', 500, 35, 535, JSON.stringify([LINE]), '{}', '[]', JSON.stringify({ vat: 35, subtotal: 500 }), 'SELF');
    const cache = [cached('PX', 'C-X', 10), cached('PY', 'C-Y', 10)];
    expect((await call('PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1, round: 1, items: [] }], items: [{ ...LINE, receivedQty: 5, goodQty: 5 }] })).status).toBe(200);
    const rec = await call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'PX', code: 'C-X', goodQty: 5, defectiveQty: 0 }] });
    expect(rec.status).toBe(200);
    expect(stock('PX')).toBe(15);
    // the client then syncs with its local copy (10 + 5 locally computed = 15, or the stale 10) : either way the server value stands
    expect((await call('PUT', '/api/products/batch', cache)).status).toBe(200);
    expect(stock('PX')).toBe(15);
    expect((await call('PUT', '/api/products/batch', [cached('PX', 'C-X', 99), cache[1]])).status).toBe(200);
    expect(stock('PX')).toBe(15);
    await call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'PX', code: 'C-X', goodQty: 5, defectiveQty: 0 }] });
    expect(stock('PX')).toBe(15);
  });
});
