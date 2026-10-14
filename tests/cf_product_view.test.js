// @vitest-environment node
// D-2 : products leave the server with BOTH the D1 names and the names the screens read (price / stockBalance / reorderPoint / unit ...)
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { productView } from '../functions/_lib/products.js';

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
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }) };
}

it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available').toBeTruthy(); });

describe('productView (pure)', () => {
  it('maps D1 names to UI names and keeps the D1 names', () => {
    const v = productView({ id: 'P', usageUnit: 'ลิตร', purchaseUnit: 'ถัง', standardPrice: 120, currentStock: 10, minStock: 2, defaultLocationId: 'L1', isActive: 1, status: null, avgCost: null, totalValue: null, leadTimeDays: null });
    expect(v).toMatchObject({ price: 120, standardPrice: 120, stockBalance: 10, currentStock: 10, reorderPoint: 2, minStock: 2, unit: 'ลิตร', stockUnit: 'ลิตร', purchaseUnit: 'ถัง', locationId: 'L1', defaultLocationId: 'L1', status: 'ACTIVE', isActive: true, avgCost: 0, averageCost: 0, totalValue: 0, leadTimeDays: 7 });
  });
  it('inactive rows -> isActive false ; fail-safe cost from the latest IN price', () => {
    expect(productView({ id: 'P', isActive: 0, status: 'INACTIVE' }).isActive).toBe(false);
    const v = productView({ id: 'P', currentStock: 4, avgCost: 0, totalValue: 0 }, 25);
    expect(v).toMatchObject({ avgCost: 25, averageCost: 25, totalValue: 100 });
    expect(productView({ id: 'P', currentStock: 0, avgCost: 0 }, 25).avgCost).toBe(0);
  });
});

describe('products over the API', () => {
  let sdb; let env; let token;
  const call = async (method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => sdb.prepare('SELECT * FROM products WHERE id = ?').get(id);

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, defaultLocationId, isDeleted) VALUES ('P1','PD-1','Glue','PD','PD','ถัง','ลิตร',20,120,10,2,'LOC-1',0)").run();
  });

  it('bootstrap and GET /api/products carry 120 / 10 / 2 under the UI names', async () => {
    const boot = await call('GET', '/api/bootstrap');
    for (const p of [boot.json.products[0], boot.json.inventory[0], (await call('GET', '/api/products')).json[0]]) {
      expect(p).toMatchObject({ price: 120, standardPrice: 120, stockBalance: 10, currentStock: 10, reorderPoint: 2, minStock: 2, unit: 'ลิตร', stockUnit: 'ลิตร', locationId: 'LOC-1', isActive: true, status: 'ACTIVE' });
    }
  });

  it('fail-safe : stock > 0 and avgCost 0 -> latest positive IN price', async () => {
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, balance, unitPrice, department, createdAt) VALUES ('S1','P1','IN',5,5,100,'PD','2026-01-01'),('S2','P1','IN',5,10,130,'PD','2026-02-01')").run();
    const p = (await call('GET', '/api/products')).json[0];
    expect(p).toMatchObject({ avgCost: 130, averageCost: 130, totalValue: 1300 });
  });

  it('PUT from a UI-shaped payload round-trips into the D1 columns and the response shows the UI names', async () => {
    const ui = { id: 'P1', code: 'PD-1', name: 'Glue 2', category: 'PD', department: 'PD', purchaseUnit: 'ถัง', stockUnit: 'ลิตร', unit: 'ลิตร', conversionRate: 20, price: 150, stockBalance: 10, reorderPoint: 4, locationId: 'LOC-1', isActive: true, status: 'ACTIVE' };
    const r = await call('PUT', '/api/products/P1', ui);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ price: 150, stockBalance: 10, reorderPoint: 4, unit: 'ลิตร', name: 'Glue 2' });
    expect(row('P1')).toMatchObject({ standardPrice: 150, currentStock: 10, minStock: 4, usageUnit: 'ลิตร', purchaseUnit: 'ถัง', defaultLocationId: 'LOC-1', name: 'Glue 2' });
  });

  it('both names sent : the UI name wins (a client spread edits only the UI names)', async () => {
    const view = (await call('GET', '/api/products')).json[0];
    const r = await call('PUT', '/api/products/P1', { ...view, reorderPoint: 9, stockBalance: 33, price: 77, stockUnit: 'กก.', unit: 'กก.' });
    expect(r.status).toBe(200);
    expect(row('P1')).toMatchObject({ minStock: 9, currentStock: 33, standardPrice: 77, usageUnit: 'กก.' });
    const p = await call('POST', '/api/products', { ...view, reorderPoint: 5, stockBalance: 12, price: 80 });
    expect(p.status).toBe(200);
    expect(row('P1')).toMatchObject({ minStock: 5, currentStock: 12, standardPrice: 80 });
  });

  it('PUT : locationId null / "" clears the location, key absent keeps it', async () => {
    const base = { id: 'P1', code: 'PD-1', name: 'Glue', category: 'PD', department: 'PD' };
    await call('PUT', '/api/products/P1', base);
    expect(row('P1').defaultLocationId).toBe('LOC-1');
    await call('PUT', '/api/products/P1', { ...base, locationId: null });
    expect(row('P1').defaultLocationId).toBe('');
    sdb.prepare("UPDATE products SET defaultLocationId='LOC-1' WHERE id='P1'").run();
    await call('PUT', '/api/products/P1', { ...base, locationId: '' });
    expect(row('P1').defaultLocationId).toBe('');
  });

  it('isActive=false through the API deactivates the row and the views show it', async () => {
    const r = await call('PUT', '/api/products/P1', { id: 'P1', code: 'PD-1', name: 'Glue', category: 'PD', department: 'PD', isActive: false });
    expect(r.json).toMatchObject({ isActive: false, status: 'INACTIVE' });
    expect(row('P1')).toMatchObject({ isActive: 0, status: 'INACTIVE' });
    expect((await call('GET', '/api/products')).json[0]).toMatchObject({ isActive: false, status: 'INACTIVE' });
  });

  it('issue-stock returns the product in the same shape (UI + D1 names)', async () => {
    const r = await call('POST', '/api/stock/issue', { productId: 'P1', quantity: 3, issuedTo: 'Line1' });
    expect(r.status).toBe(200);
    expect(r.json.product).toMatchObject({ stockBalance: 7, currentStock: 7, price: 120, reorderPoint: 2, unit: 'ลิตร', isActive: true });
  });

  it('POST of a new UI-shaped product stores it ; POST update without price/stock keeps them', async () => {
    const created = await call('POST', '/api/products', { id: 'P2', code: 'PD-2', name: 'New', category: 'PD', department: 'PD', purchaseUnit: 'กล่อง', stockUnit: 'ชิ้น', unit: 'ชิ้น', conversionRate: 12, price: 30, stockBalance: 7, reorderPoint: 3, locationId: '' });
    expect(created.json).toMatchObject({ price: 30, stockBalance: 7, reorderPoint: 3, unit: 'ชิ้น' });
    expect(row('P2')).toMatchObject({ standardPrice: 30, currentStock: 7, minStock: 3, usageUnit: 'ชิ้น' });
    await call('POST', '/api/products', { id: 'P1', code: 'PD-1', name: 'Glue renamed', category: 'PD', department: 'PD' });
    expect(row('P1')).toMatchObject({ name: 'Glue renamed', standardPrice: 120, currentStock: 10 });
  });
});
