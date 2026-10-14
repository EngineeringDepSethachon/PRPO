// @vitest-environment node
// S1 : Stock Adjustment (+/-) and Manual Stock-In on Cloudflare : POST /api/stock/adjust and /api/stock/manual-in
// (server owns balance + stock_logs + audit in one db.batch ; department gate ; RBAC ; no negative ; replay of the same requestId is a no-op)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';
import { authorize } from '../functions/_lib/rbac.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Extra#Pass1';

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

d('S1 manual stock movements (adjust / manual-in)', () => {
  let sdb; let env; const tok = {};
  const call = async (who, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method: 'POST', headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const prod = (id = 'P1') => ({ ...sdb.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  const logs = (id = 'P1') => sdb.prepare('SELECT * FROM stock_logs WHERE productId = ? ORDER BY rowid').all(id).map((r) => ({ ...r }));
  const audits = () => sdb.prepare("SELECT * FROM audit_logs WHERE action IN ('STOCK_ADJUST','STOCK_MANUAL_IN')").all();
  const ADJ = '/api/stock/adjust';
  const MIN = '/api/stock/manual-in';
  const addUser = (rec, id, username, dept, allowed, roleId, canon, level) => sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,'',?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
    .run(id, username, username, dept, allowed, roleId, canon, level, rec.hash, rec.salt, rec.algo, rec.iterations);

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    addUser(rec, 'U1', 'wh', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1);
    addUser(rec, 'U2', 'whqc', 'QC', '["QC"]', 'REQUESTER_QC', 'REQUESTER', 1);
    addUser(rec, 'U3', 'asst', 'ALL', '["*"]', 'ASST_MANAGER', 'REVIEWER', 2);
    addUser(rec, 'U4', 'onl', 'PUR', '["*"]', 'ONLINE_PURCHASER', 'PURCHASER', 2);
    addUser(rec, 'U5', 'pm', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 3);
    addUser(rec, 'U6', 'adm', 'ALL', '["*"]', 'ADMIN', 'ADMIN', 99);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P1','C1','Glue','PD','PD','box','pcs',1,10,25,20,0)").run();
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('PQ','C2','Reagent','QC','QC','box','pcs',1,7,5,5,0)").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const u of ['wh', 'whqc', 'asst', 'onl', 'pm', 'adm']) {
      tok[u] = (await (await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) }), env })).json()).token;
    }
  });

  it('adjust + : balance 10 -> 14, ONE log (IN, ADJ-IN-, balance 14), audit row, MAC untouched, actor from the token', async () => {
    const r = await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: 4, reason: 'ตรวจนับประจำปี (Physical Count Diff)', customNote: 'นับใหม่', requestId: 'r1', actorName: 'HACKER' });
    expect(r.status).toBe(200);
    expect(prod()).toMatchObject({ currentStock: 14, avgCost: 25 });
    const l = logs();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ type: 'IN', docType: 'ADJUST', quantity: 4, changeQty: 4, balance: 14, department: 'PD', actorName: 'wh', actorId: 'REQUESTER_PD' });
    expect(l[0].docNo).toMatch(/^ADJ-IN-\d{6}-[0-9a-f]{4}$/);
    expect(l[0].notes).toBe('[ปรับปรุงสต็อก + เพิ่ม] ตรวจนับประจำปี (Physical Count Diff) — นับใหม่');
    expect(audits()).toHaveLength(1);
    expect(r.json.updatedProduct).toMatchObject({ stockBalance: 14, currentStock: 14 });
    expect(r.json.logEntry).toMatchObject({ balanceAfter: 14, type: 'IN' });
  });

  it('adjust - : 10 -> 7, OUT log with changeQty -3 ; more than the balance -> 400 with the modal message, nothing written', async () => {
    const ok = await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 3, reason: 'สินค้าชำรุด', requestId: 'r2' });
    expect(ok.status).toBe(200);
    expect(prod().currentStock).toBe(7);
    expect(logs()[0]).toMatchObject({ type: 'OUT', changeQty: -3, balance: 7 });
    const bad = await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 8, reason: 'x', requestId: 'r3' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('ไม่สามารถปรับลด (8) ได้มากกว่ายอดคงเหลือปัจจุบัน (7)');
    expect(prod().currentStock).toBe(7);
    expect(logs()).toHaveLength(1);
    // exactly the balance is allowed (down to zero)
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 7, reason: 'x', requestId: 'r4' })).status).toBe(200);
    expect(prod().currentStock).toBe(0);
  });

  it('manual-in : +6 -> 16, IN log MAN-IN-, balance 16, MAC untouched (the form has no price)', async () => {
    const r = await call('wh', MIN, { productId: 'P1', quantity: 6, reason: 'รับของยืม', requestId: 'm1' });
    expect(r.status).toBe(200);
    expect(prod()).toMatchObject({ currentStock: 16, avgCost: 25 });
    const l = logs();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ type: 'IN', quantity: 6, balance: 16 });
    expect(l[0].docNo).toMatch(/^MAN-IN-\d{6}-[0-9a-f]{4}$/);
    expect(l[0].notes).toBe('[รับเข้าด้วยตนเอง] รับของยืม');
    expect(audits()[0]).toMatchObject({ action: 'STOCK_MANUAL_IN', performedBy: 'U1' });
  });

  it('replay of the same requestId does not add twice (adjust and manual-in) ; another requestId does', async () => {
    const body = { productId: 'P1', direction: 'IN', quantity: 5, reason: 'x', requestId: 'same' };
    expect((await call('wh', ADJ, body)).status).toBe(200);
    const again = await call('wh', ADJ, body);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    await call('wh', MIN, { productId: 'P1', quantity: 2, reason: 'x', requestId: 'same' });
    await call('wh', MIN, { productId: 'P1', quantity: 2, reason: 'x', requestId: 'same' });
    expect(prod().currentStock).toBe(17);
    expect(logs()).toHaveLength(2);
    await call('wh', MIN, { productId: 'P1', quantity: 2, reason: 'x', requestId: 'other' });
    expect(prod().currentStock).toBe(19);
  });

  it('a requestId of another user is its own key (cannot be replayed into / blocked by someone else)', async () => {
    await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'k' });
    const r = await call('adm', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'k' });
    expect(r.json.duplicate).toBeUndefined();
    expect(prod().currentStock).toBe(12);
  });

  it('cross-department : PD warehouse cannot touch a QC product (403, nothing changed) ; QC warehouse can ; admin can', async () => {
    for (const [p, b] of [[ADJ, { direction: 'IN' }], [MIN, {}]]) {
      const r = await call('wh', p, { productId: 'PQ', quantity: 1, reason: 'x', requestId: `x${p}`, ...b });
      expect(r.status).toBe(403);
    }
    expect(prod('PQ').currentStock).toBe(7);
    expect(logs('PQ')).toHaveLength(0);
    expect((await call('whqc', MIN, { productId: 'PQ', quantity: 3, reason: 'x', requestId: 'q1' })).status).toBe(200);
    expect(prod('PQ').currentStock).toBe(10);
    expect((await call('adm', ADJ, { productId: 'P1', direction: 'OUT', quantity: 1, reason: 'x', requestId: 'a1' })).status).toBe(200);
  });

  it('roles : online purchaser and plant manager are refused (as the screen hides the buttons) ; asst manager and admin are allowed', () => {
    const mkU = (o) => ({ userId: o.id, roleKey: o.roleId, ...o });
    const asst = mkU({ id: 'U3', roleId: 'ASST_MANAGER', level: 2, department: 'ALL', allowedDepartments: ['*'] });
    const onl = mkU({ id: 'U4', roleId: 'ONLINE_PURCHASER', level: 2, department: 'PUR', allowedDepartments: ['*'] });
    const pm = mkU({ id: 'U5', roleId: 'PLANT_MANAGER', level: 3, department: 'MGT', allowedDepartments: ['*'] });
    const wh = mkU({ id: 'U1', roleId: 'REQUESTER_PD', level: 1, department: 'PD', allowedDepartments: ['PD'] });
    const adm = mkU({ id: 'U6', roleId: 'ADMIN', level: 99, department: 'ALL', allowedDepartments: ['*'] });
    for (const p of [ADJ, MIN]) {
      expect(authorize(asst, 'POST', p)).toBe(true);
      expect(authorize(wh, 'POST', p)).toBe(true);
      expect(authorize(adm, 'POST', p)).toBe(true);
      expect(authorize(onl, 'POST', p)).toBe(false);
      expect(authorize(pm, 'POST', p)).toBe(false);
    }
  });

  it('a level-2 user who is not ASST_MANAGER / online / receiver is refused (matches the screen button)', () => {
    const other = { userId: 'U9', roleKey: 'SECTION_MGR', roleId: 'SECTION_MGR', level: 2, department: 'PD', allowedDepartments: ['PD'] };
    for (const p of [ADJ, MIN]) expect(authorize(other, 'POST', p)).toBe(false);
  });

  it('log carries the storage point : location = its name, locationId = defaultLocationId', async () => {
    sdb.prepare("INSERT INTO storage_locations (id, name, department) VALUES ('LOC-1','Shelf A','PD')").run();
    sdb.prepare("UPDATE products SET defaultLocationId = 'LOC-1' WHERE id = 'P1'").run();
    await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'loc1' });
    expect(logs()[0]).toMatchObject({ location: 'Shelf A', locationId: 'LOC-1' });
  });

  it('same requestId on another product / direction is a NEW movement ; log id does not carry raw user input', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P2','C3','Tape','PD','PD','box','pcs',1,10,1,1,0)").run();
    await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: 1, reason: 'x', requestId: 'same' });
    await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 1, reason: 'x', requestId: 'same' });
    await call('wh', ADJ, { productId: 'P2', direction: 'IN', quantity: 1, reason: 'x', requestId: 'same' });
    await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'same' });
    expect(prod('P1').currentStock).toBe(11);
    expect(prod('P2').currentStock).toBe(11);
    const ids = sdb.prepare('SELECT id FROM stock_logs').all().map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^LOG-(ADJIN|ADJOUT|MIN)-[0-9a-f]{32}$/);
  });

  it('qty shape : 1e300 / 0.00001 / true / [5] / "5abc" / 1e-7 / 5.12345 / 10000001 -> 400 ; "5" and 5.1234 pass ; adjust and issue alike', async () => {
    const bad = [1e300, 0.00001, true, [5], '5abc', '1e3', 10000001, '', null, { a: 1 }, -2, '0x10'];
    let n = 0;
    for (const q of bad) {
      const r = await call('wh', MIN, { productId: 'P1', quantity: q, reason: 'x', requestId: `q${n++}` });
      expect(r.status, JSON.stringify(q)).toBe(400);
    }
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 1e300 })).status).toBe(400);
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: [1] })).status).toBe(400);
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 0.00001 })).status).toBe(400);
    expect(prod().currentStock).toBe(10);
    expect(logs()).toHaveLength(0);
    expect((await call('wh', MIN, { productId: 'P1', quantity: '5', reason: 'x', requestId: 'ok1' })).status).toBe(200);
    expect((await call('wh', MIN, { productId: 'P1', quantity: 5.1234, reason: 'x', requestId: 'ok2' })).status).toBe(200);
    expect(prod().currentStock).toBe(20.1234);
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: '2' })).status).toBe(200);
  });

  it('extra decimals are ROUNDED to 4 dp, never refused ; "issue all" of a float balance always fits (issue, adjust-)', async () => {
    sdb.prepare("UPDATE products SET currentStock = 0.30000000000000004 WHERE id = 'P1'").run();
    const all = await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 0.30000000000000004 });
    expect(all.status).toBe(200);
    expect(prod().currentStock).toBe(0);
    // balance a hair BELOW the typed value
    sdb.prepare("UPDATE products SET currentStock = 0.29999999999999993 WHERE id = 'P1'").run();
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 0.3 })).status).toBe(200);
    expect(prod().currentStock).toBe(0);
    sdb.prepare("UPDATE products SET currentStock = 0.30000000000000004 WHERE id = 'P1'").run();
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 0.30000000000000004, reason: 'x', requestId: 'fl1' })).status).toBe(200);
    expect(prod().currentStock).toBe(0);
    // typed 0.33333 -> recorded 0.3333
    sdb.prepare("UPDATE products SET currentStock = 5 WHERE id = 'P1'").run();
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 0.33333 })).status).toBe(200);
    expect(prod().currentStock).toBe(4.6667);
    expect((await call('wh', MIN, { productId: 'P1', quantity: '0.33333', reason: 'x', requestId: 'fl2' })).status).toBe(200);
    expect(prod().currentStock).toBe(5);
    expect(sdb.prepare("SELECT quantity FROM stock_logs WHERE type = 'OUT' AND docType = 'ISSUE'").all().map((r) => r.quantity)).toContain(0.3333);
    // real shortage still refused ; invalid input says why
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 6 })).status).toBe(400);
    const why = await call('wh', '/api/stock/issue', { productId: 'P1', quantity: 0.00001 });
    expect(why.status).toBe(400);
    expect(why.json.error).toContain('มากกว่า 0');
    expect((await call('wh', '/api/stock/issue', { productId: 'P1', quantity: true })).json.error).toContain('ตัวเลข');
  });

  it('A : a movement refused INSIDE the transaction (stock taken between check and write) leaves no log, no stock change and NO audit row', async () => {
    const real = env.DB;
    env = { ...env, DB: { prepare: real.prepare, batch: async (stmts) => { sdb.prepare("UPDATE products SET currentStock = 2 WHERE id = 'P1'").run(); return real.batch(stmts); } } };
    const r = await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 5, reason: 'x', requestId: 'race1' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('ไม่สามารถปรับลด (5) ได้มากกว่ายอดคงเหลือปัจจุบัน (2)');
    expect(prod().currentStock).toBe(2);
    expect(logs()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it('B : when the rate-limit query fails the request is refused with 503 (never let through), nothing written', async () => {
    const real = env.DB;
    env = { ...env, DB: { batch: real.batch, prepare: (q) => (/FROM audit_logs WHERE performedBy/.test(q) ? { bind: () => ({ first: async () => { throw new Error('D1 down'); } }) } : real.prepare(q)) } };
    const r = await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'b1' });
    expect(r.status).toBe(503);
    expect(r.json.error).toContain('ลองใหม่');
    expect(prod().currentStock).toBe(10);
    expect(logs()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it('rate limit : 30 movements per user per minute, then 429 ; another user is not affected', async () => {
    for (let i = 0; i < 30; i++) expect((await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: `rl${i}` })).status).toBe(200);
    const r = await call('wh', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'rl-over' });
    expect(r.status).toBe(429);
    expect(prod().currentStock).toBe(40);
    expect((await call('adm', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'rl-adm' })).status).toBe(200);
  });

  it('roles over the API : online purchaser and plant manager get 403 and nothing changes', async () => {
    for (const who of ['onl', 'pm']) {
      expect((await call(who, MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: who })).status).toBe(403);
    }
    expect((await call('asst', MIN, { productId: 'P1', quantity: 1, reason: 'x', requestId: 'as' })).status).toBe(200);
    expect(prod().currentStock).toBe(11);
  });

  it('validation : bad qty / direction / reason / unknown product -> 4xx, no write', async () => {
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: 0, reason: 'x' })).status).toBe(400);
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: -2, reason: 'x' })).status).toBe(400);
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: 'abc', reason: 'x' })).status).toBe(400);
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'SIDEWAYS', quantity: 1, reason: 'x' })).status).toBe(400);
    expect((await call('wh', ADJ, { productId: 'P1', direction: 'IN', quantity: 1, reason: '' })).status).toBe(400);
    expect((await call('wh', MIN, { productId: 'NOPE', quantity: 1, reason: 'x' })).status).toBe(404);
    expect(prod().currentStock).toBe(10);
    expect(logs()).toHaveLength(0);
  });

  it('manual-in ignores a client-sent direction OUT (it can only add) and fractions are kept (4 dp)', async () => {
    await call('wh', MIN, { productId: 'P1', direction: 'OUT', quantity: 1.25, reason: 'x', requestId: 'f1' });
    expect(prod().currentStock).toBe(11.25);
    expect(logs()[0]).toMatchObject({ type: 'IN', changeQty: 1.25 });
  });

  it('the log is not written when the stock moved under it (in-batch guard) : no row, stock unchanged', async () => {
    // a trigger-less way to simulate the race : the batch guard is `currentStock + delta >= 0` evaluated inside the transaction
    sdb.prepare("UPDATE products SET currentStock = 2 WHERE id = 'P1'").run();
    const r = await call('wh', ADJ, { productId: 'P1', direction: 'OUT', quantity: 3, reason: 'x', requestId: 'g1' });
    expect(r.status).toBe(400);
    expect(logs()).toHaveLength(0);
    expect(prod().currentStock).toBe(2);
  });

  it('the stock-logs list the client reads after the reload carries the new row', async () => {
    await call('wh', MIN, { productId: 'P1', quantity: 2, reason: 'x', requestId: 'v1' });
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/stock-logs', { method: 'GET', headers: { Authorization: `Bearer ${tok.wh}` } }), env });
    const list = await res.json();
    expect(list.some((x) => x.productId === 'P1' && x.type === 'IN' && x.balance === 12)).toBe(true);
  });
});
