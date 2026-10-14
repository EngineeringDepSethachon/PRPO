// @vitest-environment node
// follow-up (QA low / kla low) on /api/products : opening balance only checked for NEW rows on single writes ;
// /batch count = rows really written ; id/code lookup is deterministic (exact id first, live row before a deleted one).
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

d('/api/products follow-up (low findings)', () => {
  let sdb; let env; let tok;
  const call = async (method, url, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => sdb.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const ins = (id, code, del = 0, stock = 10) => sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, standardPrice, currentStock, minStock, isDeleted) VALUES (?,?,?,'PD','PD','box','pcs',1,10,?,1,?)").run(id, code, `Item ${code}`, stock, del);
  const body = (id, code, extra = {}) => ({ id, code, name: `N ${code}`, category: 'PD', department: 'PD', purchaseUnit: 'box', stockUnit: 'pcs', conversionRate: 1, price: 10, reorderPoint: 1, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin Boss','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    tok = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
  });

  it('1 existing row + absurd stockBalance in body -> PUT and POST still 200, stock untouched', async () => {
    ins('PX', 'C-X');
    const put = await call('PUT', '/api/products/PX', body('PX', 'C-X', { stockBalance: 1e9, name: 'Renamed' }));
    expect(put.status).toBe(200);
    const post = await call('POST', '/api/products', body('PX', 'C-X', { stockBalance: 1e9 }));
    expect(post.status).toBe(200);
    expect(Number(row('PX').currentStock)).toBe(10);
    expect(row('PX').name).toBe('N C-X');
  });

  it('1 NEW row + absurd stockBalance -> 400 on PUT and POST, nothing inserted', async () => {
    expect((await call('POST', '/api/products', body('PN', 'C-N', { stockBalance: 1e9 }))).status).toBe(400);
    expect((await call('PUT', '/api/products/PM', body('PM', 'C-M', { stockBalance: 1e9 }))).status).toBe(400);
    expect(row('PN')).toBeUndefined();
    expect(row('PM')).toBeUndefined();
  });

  it('2 /batch count = rows written (deleted + refused-opening rows are not counted)', async () => {
    ins('PD1', 'C-D', 1);
    ins('PL', 'C-L');
    const rows = [body('PD1', 'C-D'), body('PL', 'C-L'), body('PNEW', 'C-NEW', { stockBalance: 5 }), body('PBAD', 'C-BAD', { stockBalance: 1e9 })];
    for (const m of ['POST', 'PUT']) {
      const r = await call(m, '/api/products/batch', rows);
      expect(r.status).toBe(200);
      expect(r.json.count).toBe(m === 'POST' ? 2 : 2);
      expect(r.json.skipped).toContain('PBAD');
      sdb.prepare("DELETE FROM products WHERE id = 'PNEW'").run();
    }
    expect(Number(row('PD1').isDeleted)).toBe(1);
  });

  it('3 id/code lookup prefers the exact id, then a live row over a deleted one (gate and handler agree)', async () => {
    ins('P1', 'DUP', 1);
    ins('P2', 'dup', 0);
    const r = await call('PUT', '/api/products/Dup', body('Dup', 'Dup', { name: 'Hit' }));
    expect(r.status).toBe(200);
    expect(row('P2').name).toBe('Hit');
    expect(Number(row('P1').isDeleted)).toBe(1);
    expect(row('P1').name).toBe('Item DUP');
  });
});
