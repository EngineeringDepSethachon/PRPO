// S4 : the server completes the PR (status/poStatus 'completed', GAS apiReceivePO step 10) in the same batch as the PO write that closes the PO
//  - POST /api/pos/:id/receive (last line received -> CLOSED)
//  - PUT /api/pos/:id with status COMPLETED / CLOSED (ReceivingModal, claim close, short-close : the client saves the final status itself)
// real SQL on node:sqlite with every migration applied
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Extra#Pass1';
const GR1 = 'GRN-PO-PD-2026-001-01';
const GR2 = 'GRN-PO-PD-2026-001-02';

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { const r = sdb.prepare(q).run(...norm(p)); return { success: true, meta: { changes: Number(r.changes) } }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => { sdb.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } }
  };
}

const d = DatabaseSync ? describe : describe.skip;

d('S4 PR cascade on PO close', () => {
  let sdb; let env; let token; let tokAdm;
  const callWith = async (tok, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const call = (method, p, body) => callWith(token, method, p, body);
  const callAdm = (method, p, body) => callWith(tokAdm, method, p, body);
  const pr = (id = 'PR-1') => ({ ...sdb.prepare('SELECT * FROM prs WHERE id = ?').get(id) });
  const po = (id = 'PO-S1') => ({ ...sdb.prepare('SELECT * FROM pos WHERE id = ?').get(id) });
  const LINE = { productId: 'P1', code: 'C1', name: 'Item', qty: 5, purchaseQty: 5, price: 100 };
  const seedPr = (over = {}) => {
    const r = { id: 'PR-1', prNumber: 'PD001/2026', department: 'PD', status: 'IN_PROGRESS_ONLINE', ...over };
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson, timelineJson, extraJson) VALUES (?,?,?,?,500,'[]','[]','{}')").run(r.id, r.prNumber, r.department, r.status);
  };
  const seedPo = (id = 'PO-S1', over = {}) => {
    const r = { poNumber: 'PO-PD-2026-001', prNumber: 'PD001/2026', department: 'PD', status: 'ORDERED', ...over };
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.poNumber, r.prNumber, r.department, r.status, 500, 35, 535, JSON.stringify([LINE]), '{}', '[]', '{}', 'SELF');
  };
  const receive = (id, gr, goodQty) => call('POST', `/api/pos/${id}/receive`, { receivingItems: [{ productId: 'P1', goodQty }], grNumber: gr });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U1','wh','', 'Warehouse','PD','[\"PD\"]','REQUESTER_PD','REQUESTER',1,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U5','adm','', 'Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',1,10,0,0,0)").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    const login = async (username) => (await (await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env })).json()).token;
    token = await login('wh');
    tokAdm = await login('adm');
  });

  it('S4a /receive : a partial round leaves the PR, the last round completes it (status, poStatus, poNumber, timeline entry) once', async () => {
    seedPr(); seedPo();
    expect((await receive('PO-S1', GR1, 2)).status).toBe(200);
    expect(po().status).toBe('PARTIAL');
    expect(pr().status).toBe('IN_PROGRESS_ONLINE');
    const r2 = await receive('PO-S1', GR2, 3);
    expect(r2.status).toBe(200);
    expect(po().status).toBe('CLOSED');
    const p = pr();
    expect(p.status).toBe('completed');
    expect(p.poNumber).toBe('PO-PD-2026-001');
    expect(JSON.parse(p.extraJson)).toMatchObject({ poStatus: 'completed' });
    expect(JSON.parse(p.extraJson).fullyReceivedAt).toBeTruthy();
    const tl = JSON.parse(p.timelineJson);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ action: 'ปิดเอกสาร (Closed)', user: 'Warehouse' });
    expect(tl[0].note).toContain('PO-PD-2026-001');
    // a repeat of the closing receipt is a no-op : nothing cascades twice
    const again = await receive('PO-S1', GR2, 3);
    expect(again.json.duplicate).toBe(true);
    expect(JSON.parse(pr().timelineJson)).toHaveLength(1);
  });

  it('S4b only an APPROVED / PO_ISSUED / IN_PROGRESS_ONLINE PR of the PO department is completed', async () => {
    seedPr({ status: 'CANCELLED' }); seedPo();
    await receive('PO-S1', GR1, 5);
    expect(po().status).toBe('CLOSED');
    expect(pr().status).toBe('CANCELLED');
    sdb.prepare("UPDATE prs SET status = 'PO_ISSUED', department = 'QC' WHERE id = 'PR-1'").run();
    seedPo('PO-S2', { poNumber: 'PO-PD-2026-002' });
    await receive('PO-S2', 'GRN-PO-PD-2026-002-01', 5);
    expect(pr().status).toBe('PO_ISSUED');
    sdb.prepare("UPDATE prs SET department = 'PD' WHERE id = 'PR-1'").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES ('PO-S3','PO-PD-2026-003','PD001/2026','PD','ORDERED',500,35,535,?, '{}','[]','{}','SELF')").run(JSON.stringify([LINE]));
    await receive('PO-S3', 'GRN-PO-PD-2026-003-01', 5);
    expect(pr().status).toBe('completed');
  });

  it('S4c GAS parity : the FIRST PO of a PR that closes completes the PR at once (siblings not looked at) and overwrites PR.poNumber ; a later PO does not cascade again', async () => {
    seedPr(); seedPo(); seedPo('PO-S2', { poNumber: 'PO-PD-2026-002' });
    sdb.prepare("UPDATE prs SET poNumber = 'OLD-PO' WHERE id = 'PR-1'").run();
    await receive('PO-S1', GR1, 5);
    expect(po().status).toBe('CLOSED');
    expect(pr()).toMatchObject({ status: 'completed', poNumber: 'PO-PD-2026-001' });
    await receive('PO-S2', 'GRN-PO-PD-2026-002-01', 5);
    expect(po('PO-S2').status).toBe('CLOSED');
    expect(JSON.parse(pr().timelineJson)).toHaveLength(1);
  });

  it('S4f audit row PR_COMPLETED_BY_PO only when the cascade really happened ; not in the PR timeline ; listed by /api/audit-logs ; no duplicate on retry', async () => {
    seedPr(); seedPo();
    await receive('PO-S1', GR1, 2);
    const rows = () => sdb.prepare("SELECT * FROM audit_logs WHERE action = 'PR_COMPLETED_BY_PO'").all().map((r) => ({ ...r }));
    expect(rows()).toHaveLength(0); // partial : no cascade -> no row
    await receive('PO-S1', GR2, 3);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ entityType: 'pr', entityId: 'PR-1', performedBy: 'U1' });
    expect(JSON.parse(r[0].details)).toMatchObject({ docNo: 'PD001/2026', poNumber: 'PO-PD-2026-001', actorName: 'Warehouse', module: 'PURCHASE', comment: 'ปิดเอกสาร (Closed) จาก PO PO-PD-2026-001' });
    await receive('PO-S1', GR2, 3); // duplicate
    expect(rows()).toHaveLength(1);
    // a PR that is not eligible : cascade does not happen, so no audit row either
    seedPr({ id: 'PR-2', prNumber: 'PD002/2026', status: 'CANCELLED' }); seedPo('PO-S2', { poNumber: 'PO-PD-2026-002', prNumber: 'PD002/2026' });
    await receive('PO-S2', 'GRN-PO-PD-2026-002-01', 5);
    expect(rows()).toHaveLength(1);
    // the PR timeline from audit rows (PR_AUDIT_ACTIONS only) does not pick it up
    const list = await callAdm('GET', '/api/prs');
    const mine = (Array.isArray(list.json) ? list.json : list.json.prs || []).find((x) => x.id === 'PR-1');
    expect(JSON.stringify(mine && mine.timeline || [])).not.toContain('PR_COMPLETED_BY_PO');
    const al = await callAdm('GET', '/api/audit-logs');
    expect(JSON.stringify(al.json)).toContain('PR_COMPLETED_BY_PO');
  });

  it('S4g the PR is found by the PO prId only when there is one ; prNumber is the fallback only without a prId', async () => {
    seedPr(); seedPr({ id: 'PR-X', prNumber: 'PDX/2026', status: 'IN_PROGRESS_ONLINE' });
    // prId points at PR-X although prNumber names PR-1 : only PR-X is touched
    seedPo('PO-S1', { prNumber: 'PD001/2026' });
    sdb.prepare("UPDATE pos SET prId = 'PR-X' WHERE id = 'PO-S1'").run();
    await receive('PO-S1', GR1, 5);
    expect(pr('PR-X').status).toBe('completed');
    expect(pr('PR-1').status).toBe('IN_PROGRESS_ONLINE');
    // a prId that matches nothing : no fallback to prNumber
    seedPo('PO-S2', { poNumber: 'PO-PD-2026-002', prNumber: 'PD001/2026' });
    sdb.prepare("UPDATE pos SET prId = 'NO-SUCH' WHERE id = 'PO-S2'").run();
    await receive('PO-S2', 'GRN-PO-PD-2026-002-01', 5);
    expect(pr('PR-1').status).toBe('IN_PROGRESS_ONLINE');
  });

  it('S4d PUT /api/pos/:id with a final status (ReceivingModal) completes the PR in the same write, once ; the client PR PUT that follows is not a conflict', async () => {
    seedPr(); seedPo('PO-S1', { status: 'WAITING_DELIVERY_ROUND_2' });
    const put = await call('PUT', '/api/pos/PO-S1', { status: 'COMPLETED', items: [{ ...LINE, receivedQty: 5, goodQty: 5 }] });
    expect(put.status).toBe(200);
    expect(pr().status).toBe('completed');
    expect(JSON.parse(pr().timelineJson)).toHaveLength(1);
    // the same save again / a later save of the closed PO does not cascade again
    expect((await call('PUT', '/api/pos/PO-S1', { status: 'COMPLETED' })).status).toBe(200);
    expect(JSON.parse(pr().timelineJson)).toHaveLength(1);
    // PODetailsModal / shortClosePO used to PUT the PR as completed themselves : same status as stored -> 200, never 409
    const prPut = await call('PUT', '/api/prs/PR-1', { status: 'completed', poStatus: 'completed' });
    expect(prPut.status).toBe(200);
    expect(pr().status).toBe('completed');
    // a PUT of the PR without a status (shortClosePO in cloudflare mode) leaves the server's status
    const prNoStatus = await call('PUT', '/api/prs/PR-1', { activityLog: [{ action: 'x' }] });
    expect(prNoStatus.status).toBe(200);
    expect(pr().status).toBe('completed');
  });

  it('S4e a PUT that is not a closing status (or whose PO has no PR) cascades nothing', async () => {
    seedPr(); seedPo('PO-S1', { status: 'ORDERED' });
    expect((await call('PUT', '/api/pos/PO-S1', { status: 'PARTIAL' })).status).toBe(200);
    expect(pr().status).toBe('IN_PROGRESS_ONLINE');
    seedPo('PO-S9', { poNumber: 'PO-PD-2026-009', prNumber: null });
    expect((await callAdm('PUT', '/api/pos/PO-S9', { status: 'CLOSED' })).status).toBe(200);
    expect(pr().status).toBe('IN_PROGRESS_ONLINE');
  });
});
