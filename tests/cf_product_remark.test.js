// @vitest-environment node
// TC-004 : Product Remark is stored in D1 (migration 0017) through PUT /api/products/:id, returned by GET / bootstrap, gated by department
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql', '0017_product_remark.sql'];
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

describe('product remark over the API', () => {
  let sdb; let env; let adminToken; let qcToken;
  const call = async (token, method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => sdb.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const ui = (extra) => ({ id: 'P1', code: 'PD-1', name: 'Glue', category: 'PD', department: 'PD', purchaseUnit: 'ถัง', stockUnit: 'ลิตร', conversionRate: 20, price: 120, stockBalance: 10, reorderPoint: 2, locationId: 'LOC-1', ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin Boss','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-QC','qc','','QC Staff','QC','[\"QC\"]','QC_STAFF','QC_STAFF',2,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    adminToken = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    qcToken = await signToken({ sub: 'U-QC', userId: 'U-QC', role: 'QC_STAFF', level: 2 }, SECRET);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, defaultLocationId, isDeleted) VALUES ('P1','PD-1','Glue','PD','PD','ถัง','ลิตร',20,120,10,2,'LOC-1',0)").run();
  });

  it('PUT stores the remark, author/time come from the token, and GET + bootstrap return it', async () => {
    const r = await call(adminToken, 'PUT', '/api/products/P1', ui({ remark: '  เก็บในที่เย็น  ', remarkUpdatedBy: 'spoofed' }));
    expect(r.status).toBe(200);
    expect(r.json.remark).toBe('เก็บในที่เย็น');
    expect(row('P1')).toMatchObject({ remark: 'เก็บในที่เย็น' });
    expect(row('P1').remarkUpdatedBy).toContain('Admin Boss');
    expect(row('P1').remarkUpdatedBy).not.toContain('spoofed');
    expect(row('P1').remarkUpdatedAt).toBeTruthy();
    expect((await call(adminToken, 'GET', '/api/products')).json[0].remark).toBe('เก็บในที่เย็น');
    expect((await call(adminToken, 'GET', '/api/bootstrap')).json.products[0].remark).toBe('เก็บในที่เย็น');
  });

  it('saving the remark with a stale stockBalance after an issue does not revert the stock', async () => {
    sdb.prepare('UPDATE products SET currentStock = 4 WHERE id = ?').run('P1'); // someone issued 6 after the page was loaded (the page still has 10)
    const r = await call(adminToken, 'PUT', '/api/products/P1', ui({ remark: 'note', stockBalance: 10, currentStock: 10, avgCost: 999 }));
    expect(r.status).toBe(200);
    expect(row('P1')).toMatchObject({ remark: 'note', currentStock: 4 });
    expect(r.json.stockBalance).toBe(4);
    const p = await call(adminToken, 'POST', '/api/products', ui({ stockBalance: 10 })); // existing row through single POST : same rule
    expect(p.status).toBe(200);
    expect(row('P1').currentStock).toBe(4);
    const n = await call(adminToken, 'POST', '/api/products', ui({ id: 'P2', code: 'PD-2', stockBalance: 7 })); // a new product still takes its opening stock
    expect(n.status).toBe(200);
    expect(row('P2').currentStock).toBe(7);
  });

  it('a user without access to the department is refused and nothing is stored', async () => {
    const r = await call(qcToken, 'PUT', '/api/products/P1', ui({ remark: 'hack' }));
    expect(r.status).toBe(403);
    expect(row('P1').remark).toBeNull();
  });

  it('too long -> 400 ; clearing the remark works ; the bulk /batch sync never touches it', async () => {
    expect((await call(adminToken, 'PUT', '/api/products/P1', ui({ remark: 'x'.repeat(2001) }))).status).toBe(400);
    expect(row('P1').remark).toBeNull();
    await call(adminToken, 'PUT', '/api/products/P1', ui({ remark: 'abc' }));
    const b = await call(adminToken, 'POST', '/api/products/batch', [ui({ remark: 'stale copy' })]);
    expect(b.status).toBe(200);
    expect(row('P1').remark).toBe('abc');
    await call(adminToken, 'PUT', '/api/products/P1', ui({ remark: '' }));
    expect(row('P1').remark).toBe('');
  });
});
