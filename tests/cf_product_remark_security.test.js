// @vitest-environment node
// kla follow-up (TC-004/008) : remark IDOR across departments, recalculate-mac ignores a client averageCost, CSV cell escaping
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { csvCell } from '../src/utils/csvSafe.js';

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

describe('product remark / recalculate-mac hardening', () => {
  let sdb; let env; let adminToken; let qcToken;
  const call = async (token, method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => sdb.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const addProd = (id, code, dept, avg = 0) => sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, avgCost, isDeleted) VALUES (?, ?, ?, ?, ?, 'ชิ้น', 'ชิ้น', 1, 10, 5, 0, ?, 0)").run(id, code, `N-${id}`, dept, dept, avg);

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin Boss','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-QC','qc','','QC Staff','QC','[\"QC\"]','QC_STAFF','QC_STAFF',2,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    adminToken = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    qcToken = await signToken({ sub: 'U-QC', userId: 'U-QC', role: 'QC_STAFF', level: 2 }, SECRET);
    addProd('P-QC', 'QC-1', 'QC');
    addProd('P-PD', 'PD-1', 'PD');
  });

  it('remark never lands on another department product (PUT path id A, body code B)', async () => {
    const r = await call(qcToken, 'PUT', '/api/products/P-QC', { id: 'P-QC', code: 'PD-1', department: 'QC', category: 'QC', name: 'x', remark: 'hack' });
    expect(row('P-PD').remark).toBeNull();
    expect(row('P-PD').remarkUpdatedBy).toBeNull();
    if (r.status === 200) expect(row('P-QC').remark).toBe('hack'); // the row the gate checked
    // a body that names the other department's row by id is refused outright
    const r2 = await call(qcToken, 'PUT', '/api/products/P-QC', { id: 'P-PD', code: 'PD-1', department: 'QC', remark: 'hack2' });
    expect(r2.status).toBe(400);
    expect(row('P-PD').remark).toBeNull();
    // POST of an existing id of another department
    const r3 = await call(qcToken, 'POST', '/api/products', { id: 'P-PD', code: 'PD-1', department: 'PD', remark: 'hack3' });
    expect(r3.status).toBe(403);
    expect(row('P-PD').remark).toBeNull();
  });

  it('a remark change writes a PRODUCT_REMARK_SET audit row with the actor from the token', async () => {
    const r = await call(adminToken, 'PUT', '/api/products/P-PD', { id: 'P-PD', code: 'PD-1', department: 'PD', category: 'PD', name: 'x', remark: 'note' });
    expect(r.status).toBe(200);
    const a = sdb.prepare("SELECT * FROM audit_logs WHERE action = 'PRODUCT_REMARK_SET'").all();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ entityId: 'P-PD', performedBy: 'U-AD' });
    await call(adminToken, 'PUT', '/api/products/P-PD', { id: 'P-PD', code: 'PD-1', department: 'PD', category: 'PD', name: 'x', remark: 'note' }); // unchanged -> no new audit
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PRODUCT_REMARK_SET'").get().n).toBe(1);
  });

  it('recalculate-mac ignores averageCost from the client when there is no IN history', async () => {
    addProd('P-AV', 'AV-1', 'PD', 5);
    const r = await call(adminToken, 'POST', '/api/products/recalculate-mac', { productId: 'P-AV', averageCost: 999 });
    expect(r.status).toBe(200);
    expect(row('P-AV').avgCost).toBe(5);
  });

  it('recalculate-mac: a product without a department is admin only', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-NO','NO-1','nodept','','',1,0)").run();
    expect((await call(qcToken, 'POST', '/api/products/recalculate-mac', { productId: 'P-NO' })).status).toBe(403);
    expect((await call(adminToken, 'POST', '/api/products/recalculate-mac', { productId: 'P-NO' })).status).toBe(200);
  });
});

describe('csvCell', () => {
  it('quotes, doubles quotes and neutralises formula starters', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@x')).toBe('"\'@x"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell('ปกติ')).toBe('"ปกติ"');
  });
});
