// @vitest-environment node
// kla-security fixes (Cloudflare mode) : opening stock validation + trimmed code + audit on /api/products, /batch never revives a deleted product,
// googleusercontent host allow-list, getDriveFileViewUrl host check
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { isReservedAuditEntry } from '../functions/_lib/extra.js';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn() } }));
import { isDriveUrl } from '../src/services/driveService.js';
import { getDriveFileViewUrl } from '../src/utils/driveHelper.js';

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

describe.skipIf(!DatabaseSync)('products opening stock / batch hardening', () => {
  let sdb; let env; let token;
  const call = async (method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const count = () => sdb.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const byCode = (c) => sdb.prepare('SELECT * FROM products WHERE code = ?').get(c);
  const audits = () => sdb.prepare("SELECT * FROM audit_logs WHERE action = 'PRODUCT_CREATE'").all();
  const ui = (extra) => ({ id: 'N1', code: 'NEW-1', name: 'Glue', category: 'PD', department: 'PD', purchaseUnit: 'ถัง', stockUnit: 'ลิตร', conversionRate: 1, price: 10, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin Boss','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, isDeleted) VALUES ('P1','ABC','Old','PD','PD','ชิ้น','ชิ้น',1,5,3,0,0)").run();
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, isDeleted) VALUES ('PX','GONE','Deleted','PD','PD','ชิ้น','ชิ้น',1,5,0,0,1)").run();
  });

  it.each([[-5], ['abc'], [1e8], ['1e3'], [{}]])('POST single with opening stock %j -> 400, nothing stored', async (bad) => {
    const before = count();
    const r = await call('POST', '/api/products', ui({ stockBalance: bad }));
    expect(r.status).toBe(400);
    expect(count()).toBe(before);
  });

  it('PUT single with negative / NaN-like opening stock -> 400', async () => {
    expect((await call('PUT', '/api/products/N1', ui({ stockBalance: -1 }))).status).toBe(400);
    expect((await call('PUT', '/api/products/N1', ui({ currentStock: 'x' }))).status).toBe(400);
    expect(byCode('NEW-1')).toBeUndefined();
  });

  it('valid opening stock is rounded to 4 dp and audited (PRODUCT_CREATE, actor from the token)', async () => {
    const r = await call('POST', '/api/products', ui({ stockBalance: '12.345678' }));
    expect(r.status).toBe(200);
    expect(byCode('NEW-1').currentStock).toBe(12.3457);
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0].performedBy).toBe('U-AD');
    expect(a[0].entityId).toBe('N1');
    expect(JSON.parse(a[0].details)).toMatchObject({ openingStock: 12.3457, code: 'NEW-1' });
  });

  it('PUT creating a new row with stock > 0 is audited too ; opening 0 / not sent writes no audit', async () => {
    await call('PUT', '/api/products/N2', ui({ id: 'N2', code: 'NEW-2', stockBalance: 4 }));
    await call('POST', '/api/products', ui({ id: 'N3', code: 'NEW-3', stockBalance: 0 }));
    await call('POST', '/api/products', ui({ id: 'N4', code: 'NEW-4' }));
    expect(audits().map((x) => x.entityId)).toEqual(['N2']);
    expect(byCode('NEW-3').currentStock).toBe(0);
  });

  it('PRODUCT_CREATE is a reserved action : a client cannot forge it through POST /api/audit-logs', () => {
    expect(isReservedAuditEntry({ action: 'PRODUCT_CREATE', entityType: 'product' })).toBe(true);
  });

  it('code with trailing spaces finds the existing row (no duplicate, stock of the existing row kept)', async () => {
    const r = await call('POST', '/api/products', { id: 'ZZ', code: 'ABC ', name: 'Old2', category: 'PD', department: 'PD', stockBalance: 999 });
    expect(r.status).toBe(200);
    expect(count()).toBe(2);
    expect(byCode('ABC')).toMatchObject({ id: 'P1', name: 'Old2', currentStock: 3 });
    const b = await call('POST', '/api/products/batch', [{ id: 'YY', code: ' ABC', name: 'Old3', category: 'PD', department: 'PD', stockBalance: 500 }]);
    expect(b.status).toBe(200);
    expect(count()).toBe(2);
    expect(byCode('ABC').currentStock).toBe(3);
  });

  it('a new row is inserted with the trimmed code', async () => {
    await call('POST', '/api/products', ui({ code: '  TRIM-1  ', stockBalance: 1 }));
    expect(byCode('TRIM-1')).toBeTruthy();
    expect(byCode('  TRIM-1  ')).toBeUndefined();
  });

  it('/batch : a new row with a bad opening balance is skipped (reported), the others are written', async () => {
    const b = await call('POST', '/api/products/batch', [ui({ id: 'B1', code: 'B-1', stockBalance: -3 }), ui({ id: 'B2', code: 'B-2', stockBalance: 6 }), ui({ id: 'B3', code: 'B-3', stockBalance: 'NaN' })]);
    expect(b.status).toBe(200);
    expect(b.json.skipped).toEqual(['B1', 'B3']);
    expect(byCode('B-1')).toBeUndefined();
    expect(byCode('B-3')).toBeUndefined();
    expect(byCode('B-2').currentStock).toBe(6);
    expect(audits().map((x) => x.entityId)).toEqual(['B2']);
  });

  it('/batch never revives a deleted product ; single POST / PUT keep the old behaviour', async () => {
    const b = await call('POST', '/api/products/batch', [{ id: 'PX', code: 'GONE', name: 'Back', category: 'PD', department: 'PD' }]);
    expect(b.status).toBe(200);
    expect(sdb.prepare("SELECT isDeleted, name FROM products WHERE id = 'PX'").get()).toMatchObject({ isDeleted: 1, name: 'Deleted' });
    const bp = await call('PUT', '/api/products/batch', [{ id: 'PX', code: 'GONE', name: 'Back', category: 'PD', department: 'PD' }]);
    expect(bp.status).toBe(200);
    expect(sdb.prepare("SELECT isDeleted FROM products WHERE id = 'PX'").get().isDeleted).toBe(1);
    const s = await call('PUT', '/api/products/PX', { id: 'PX', code: 'GONE', name: 'Back', category: 'PD', department: 'PD' });
    expect(s.status).toBe(200);
    expect(sdb.prepare("SELECT isDeleted, name FROM products WHERE id = 'PX'").get()).toMatchObject({ isDeleted: 0, name: 'Back' });
  });

  it('cloudflare/functions copy carries the same fixes', () => {
    const a = fs.readFileSync(path.join(rootDir, 'functions/api/[[route]].js'), 'utf8');
    const c = fs.readFileSync(path.join(rootDir, 'cloudflare/functions/api/[[route]].js'), 'utf8');
    expect(c).toBe(a);
    expect(fs.readFileSync(path.join(rootDir, 'cloudflare/functions/_lib/extra.js'), 'utf8')).toContain("'PRODUCT_CREATE'");
  });
});

describe('googleusercontent host allow-list', () => {
  const ID = 'FILEID1234567890abcd';
  it.each(['lh3', 'lh4', 'lh5', 'lh6'])('accepts %s.googleusercontent.com', (h) => {
    expect(isDriveUrl(`https://${h}.googleusercontent.com/d/${ID}`)).toBe(true);
  });
  it('accepts drive.usercontent.google.com', () => {
    expect(isDriveUrl(`https://drive.usercontent.google.com/download?id=${ID}`)).toBe(true);
  });
  it.each(['sites.googleusercontent.com', 'docs.googleusercontent.com', 'googleusercontent.com', 'lh7.googleusercontent.com', 'evil.googleusercontent.com', 'lh3.googleusercontent.com.evil.com'])('rejects %s', (h) => {
    expect(isDriveUrl(`https://${h}/x/${ID}`)).toBe(false);
  });
});

describe('getDriveFileViewUrl', () => {
  const ID = 'FILEID1234567890abcdefg';
  it('object : a foreign viewUrl / driveUrl is ignored, the URL is rebuilt from fileId', () => {
    expect(getDriveFileViewUrl({ viewUrl: 'https://evil.test/?u=drive.google.com', fileId: ID })).toBe(`https://drive.google.com/file/d/${ID}/view`);
    expect(getDriveFileViewUrl({ driveUrl: 'javascript:alert(1)', fileId: ID })).toBe(`https://drive.google.com/file/d/${ID}/view`);
  });
  it('object : foreign viewUrl without a fileId -> empty', () => {
    expect(getDriveFileViewUrl({ viewUrl: 'https://evil.test/drive.google.com/file/d/x/view' })).toBe('');
  });
  it('object : a real Drive viewUrl is returned as is', () => {
    const u = `https://drive.google.com/file/d/${ID}/view`;
    expect(getDriveFileViewUrl({ viewUrl: u })).toBe(u);
    expect(getDriveFileViewUrl({ driveUrl: u })).toBe(u);
  });
  it('string : hostname is checked, substring tricks are refused', () => {
    expect(getDriveFileViewUrl(`https://evil.test/drive.google.com/file/d/${ID}/view`)).toBe('');
    expect(getDriveFileViewUrl(`https://evil.test/?x=drive.google.com&id=${ID}`)).toBe('');
    expect(getDriveFileViewUrl(`https://drive.google.com.evil.test/file/d/${ID}/view`)).toBe('');
  });
  it('string : real Drive URLs, lh3 URLs and raw ids still resolve', () => {
    const u = `https://drive.google.com/file/d/${ID}/view`;
    expect(getDriveFileViewUrl(u)).toBe(u);
    expect(getDriveFileViewUrl(`https://drive.google.com/open?id=${ID}`)).toBe(u);
    expect(getDriveFileViewUrl(`https://lh3.googleusercontent.com/d/${ID}`)).toBe(u);
    const raw = `${ID}hijklmnop`; // raw ids are 25+ chars
    expect(getDriveFileViewUrl(raw)).toBe(`https://drive.google.com/file/d/${raw}/view`);
  });
});
