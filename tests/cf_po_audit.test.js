// @vitest-environment node
// M7-3 : PO audit_logs rows (GAS recordAuditLogEntry parity) : PO_CREATED / UPDATE_PO / GOODS_RECEIVED_FULL|PARTIAL / PO_SETTLED ; actor from the token ; same batch as the PO write.
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
const PASS = 'Audit#Pass1';
const YEAR = new Date().getFullYear();
const GR1 = 'GRN-PO-PD-2026-001-01';
const GR2 = 'GRN-PO-PD-2026-001-02';

function makeD1(sdb, hooks = {}) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) }),
    q
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => {
      hooks.batches?.push(stmts.map((s) => s.q));
      sdb.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        if (hooks.failAfter) throw new Error('boom');
        sdb.exec('COMMIT');
        return out;
      } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; }
    }
  };
}

const d = DatabaseSync ? describe : describe.skip;

d('PO audit_logs (M7-3)', () => {
  let sdb; let env; let hooks; const tok = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const audits = (action) => sdb.prepare("SELECT * FROM audit_logs WHERE entityType = 'po' AND action IN (" + (Array.isArray(action) ? action : [action]).map(() => '?').join(',') + ') ORDER BY rowid').all(...(Array.isArray(action) ? action : [action])).map((r) => ({ ...r, d: JSON.parse(r.details) }));
  const LINE = { productId: 'P1', code: 'C1', name: 'Item', qty: 5, purchaseQty: 5, price: 100 };
  const seedPo = (over = {}) => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',1,10,0,0,0)").run();
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('PO-G1', 'PO-PD-2026-001', 'PD001/2026', 'PD', over.status || 'ORDERED', 500, 35, 535, JSON.stringify([LINE]), '{}', '[]', JSON.stringify({ vat: 35, subtotal: 500 }), 'SELF');
  };
  const seedPr = (id, prNo) => sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES (?, ?, 'PD', 'PO_ISSUED', 1000, '[{\"productId\":\"SP1\",\"qty\":100}]')").run(id, prNo);
  const newPo = (over = {}) => ({ id: 'PO-N1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10, ...over });
  const recv = (grNumber, goodQty, extra = {}) => call('wh', 'POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty }], grNumber, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U1', 'wh', 'Warehouse', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1],
      ['U3', 'pm', 'Plant', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 3],
      ['U4', 'onl', 'Online', 'PUR', '["*"]', 'ONLINE_PURCHASER', 'PURCHASER', 2]
    ];
    for (const [id, username, name, dept, allowed, roleId, canon, level] of users) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,'',?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
        .run(id, username, name, dept, allowed, roleId, canon, level, rec.hash, rec.salt, rec.algo, rec.iterations);
    }
    hooks = { batches: [] };
    env = { DB: makeD1(sdb, hooks), AUTH_TOKEN_SECRET: SECRET };
    for (const [, username] of users) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env });
      tok[username] = (await r.json()).token;
    }
  });

  it('POST new row -> PO_CREATED (exact GAS comment, actor from the token, module PURCHASE) ; POST same id again -> UPDATE_PO', async () => {
    seedPr('PR1', `PD001/${YEAR}`);
    const a = await call('pm', 'POST', '/api/pos', newPo({ poNo: `PO-PD-${YEAR}-040`, actorName: 'Hacker' }));
    expect(a.status).toBe(200);
    const [c] = audits('PO_CREATED');
    expect(c).toMatchObject({ entityType: 'po', entityId: 'PO-N1', performedBy: 'U3' });
    expect(c.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(c.d).toMatchObject({ docNo: `PO-PD-${YEAR}-040`, comment: `สร้างใบสั่งซื้อ (PO) เลขที่ PO-PD-${YEAR}-040`, summary: `สร้างใบสั่งซื้อ (PO) เลขที่ PO-PD-${YEAR}-040`, status: 'ISSUED', actorName: 'Plant', module: 'PURCHASE' });
    expect(c.d.actorName).not.toBe('Hacker');
    const b = await call('pm', 'POST', '/api/pos', newPo({ poNo: `PO-PD-${YEAR}-040`, note: 'แก้ราคา' }));
    expect(b.status).toBe(200);
    expect(audits('PO_CREATED')).toHaveLength(1);
    const u = audits('UPDATE_PO');
    expect(u).toHaveLength(1);
    expect(u[0].d).toMatchObject({ comment: 'แก้ราคา', docNo: `PO-PD-${YEAR}-040`, actorName: 'Plant' });
  });

  it('PUT /api/pos/:id -> UPDATE_PO ; comment note > reason > comment > default ; PUT of a missing row writes no audit', async () => {
    seedPo();
    expect((await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '30 วัน', reason: 'เหตุผล', comment: 'c' })).status).toBe(200);
    expect((await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '45 วัน' })).status).toBe(200);
    expect((await call('pm', 'PUT', '/api/pos/PO-G1', { note: 'n', reason: 'r' })).status).toBe(200);
    const u = audits('UPDATE_PO');
    expect(u.map((x) => x.d.comment)).toEqual(['เหตุผล', 'ปรับปรุงข้อมูลใบสั่งซื้อ', 'n']);
    expect(u[0].d).toMatchObject({ docNo: 'PO-PD-2026-001', actorName: 'Plant', module: 'PURCHASE' });
    expect(u[0].performedBy).toBe('U3');
    await call('pm', 'PUT', '/api/pos/PO-NOPE', { paymentTerms: 'x' });
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PO-NOPE'").get().n).toBe(0);
  });

  it('UPDATE_PO comment : only strings count (objects / numbers are "not given") ; legacy settle without actualTotalAmount has no "ยอดจ่ายจริง" segment', async () => {
    seedPo();
    await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '1', note: { x: 1 }, reason: 5, comment: 'ok' });
    await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '2', note: { x: 1 }, reason: 5 });
    expect(audits('UPDATE_PO').map((x) => x.d.comment)).toEqual(['ok', 'ปรับปรุงข้อมูลใบสั่งซื้อ']);
    expect((await call('onl', 'POST', '/api/pos/PO-G1/settle', { refundAmount: 0 })).status).toBe(200);
    const [s] = audits('PO_SETTLED');
    expect(s.d.comment).toBe('ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿535');
  });

  it('UPDATE_PO details.status is the status really stored, not the body\'s', async () => {
    seedPo();
    await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: 'x' });
    expect(audits('UPDATE_PO')[0].d.status).toBe('ORDERED');
    const r = await call('pm', 'PUT', '/api/pos/PO-G1', { status: 'CANCELLED' });
    const last = audits('UPDATE_PO').pop();
    expect(last.d.status).toBe(sdb.prepare("SELECT status FROM pos WHERE id = 'PO-G1'").get().status);
    expect(r.status === 200 ? last.d.status : 'ORDERED').not.toBe(undefined);
  });

  it('PO write and its audit row travel in ONE db.batch ; a failing batch leaves neither', async () => {
    seedPo();
    hooks.batches.length = 0;
    await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '30 วัน' });
    const b = hooks.batches.find((qs) => qs.some((q) => /UPDATE pos SET/.test(q)));
    expect(b.length).toBe(2);
    expect(/audit_logs/.test(b[1])).toBe(true);
    hooks.failAfter = true;
    const before = sdb.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    await call('pm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '99 วัน' }).catch(() => null);
    expect(sdb.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n).toBe(before);
    expect(sdb.prepare("SELECT paymentTerms FROM pos WHERE id = 'PO-G1'").get().paymentTerms).toBe('30 วัน');
  });

  it('receive : partial -> GOODS_RECEIVED_PARTIAL, then the rest -> GOODS_RECEIVED_FULL (exact comments, same batch as the stock + PO write)', async () => {
    seedPo();
    hooks.batches.length = 0;
    expect((await recv(GR1, 2)).status).toBe(200);
    expect((await recv(GR2, 3)).status).toBe(200);
    const g = audits(['GOODS_RECEIVED_PARTIAL', 'GOODS_RECEIVED_FULL']);
    expect(g.map((x) => x.action)).toEqual(['GOODS_RECEIVED_PARTIAL', 'GOODS_RECEIVED_FULL']);
    expect(g[0].d).toMatchObject({ docNo: 'PO-PD-2026-001', comment: `ตรวจรับสินค้า เลขที่ ${GR1} บางส่วน`, status: 'PARTIAL', actorName: 'Warehouse', module: 'PURCHASE' });
    expect(g[1].d).toMatchObject({ comment: `ตรวจรับสินค้า เลขที่ ${GR2} ครบถ้วนแล้ว ปิดใบงาน`, status: 'CLOSED' });
    expect(g.map((x) => x.performedBy)).toEqual(['U1', 'U1']);
    const rb = hooks.batches.filter((qs) => qs.some((q) => /UPDATE pos SET/.test(q)));
    expect(rb).toHaveLength(2);
    for (const qs of rb) { expect(qs.some((q) => /INTO stock_logs/.test(q))).toBe(true); expect(qs.some((q) => /INTO audit_logs/.test(q))).toBe(true); expect(qs.some((q) => /INTO notifications/.test(q))).toBe(true); }
  });

  it('receive retry (same GRN) writes the audit row once ; a PO that is already closed or a refused receipt writes none', async () => {
    seedPo();
    expect((await recv(GR1, 2)).status).toBe(200);
    await recv(GR1, 2); // retry : stock logs exist already
    expect(audits(['GOODS_RECEIVED_PARTIAL', 'GOODS_RECEIVED_FULL'])).toHaveLength(1);
    expect((await recv(GR2, 99)).status).toBeGreaterThanOrEqual(400); // over the ordered qty
    expect(audits(['GOODS_RECEIVED_PARTIAL', 'GOODS_RECEIVED_FULL'])).toHaveLength(1);
    sdb.prepare("UPDATE pos SET status = 'CLOSED' WHERE id = 'PO-G1'").run();
    await recv('GRN-PO-PD-2026-001-03', 1); // a finished PO : whatever the response, nothing is written
    expect(audits(['GOODS_RECEIVED_PARTIAL', 'GOODS_RECEIVED_FULL'])).toHaveLength(1);
  });

  it('stockOnly receive (ReceivingModal flow) : PO left open -> ONE GOODS_RECEIVED_PARTIAL (once per GRN) ; PO finished (COMPLETED) -> none', async () => {
    seedPo();
    await call('wh', 'PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1, round: 1, items: [] }], items: [{ ...LINE, receivedQty: 5, goodQty: 5 }] });
    const body = { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', code: 'C1', goodQty: 5, defectiveQty: 0 }] };
    expect((await call('wh', 'POST', '/api/pos/PO-G1/receive', body)).status).toBe(200);
    expect((await call('wh', 'POST', '/api/pos/PO-G1/receive', body)).status).toBe(200);
    expect(audits(['GOODS_RECEIVED_PARTIAL'])).toHaveLength(1);
    expect(audits(['GOODS_RECEIVED_FULL'])).toHaveLength(0);
    sdb.prepare("UPDATE pos SET status = 'COMPLETED' WHERE id = 'PO-G1'").run();
    sdb.prepare("DELETE FROM audit_logs WHERE action LIKE 'GOODS_RECEIVED%'").run();
    await call('wh', 'POST', '/api/pos/PO-G1/receive', body);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'GOODS_RECEIVED%'").get().n).toBe(0);
  });

  it('settle -> PO_SETTLED (every time, incl. a re-settle) with the exact GAS comment (en-US numbers, savings, note)', async () => {
    seedPo();
    const s = await call('onl', 'POST', '/api/pos/PO-G1/settle', { actualTotalAmount: 400, settlementNote: 'โอนแล้ว' });
    expect(s.status).toBe(200);
    const [a] = audits('PO_SETTLED');
    expect(a.d).toMatchObject({ docNo: 'PO-PD-2026-001', comment: 'ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿535 | ยอดจ่ายจริง ฿400 | ประหยัดงบ ฿135 | โอนแล้ว', actorName: 'Online', module: 'PURCHASE' });
    expect(a.performedBy).toBe('U4');
    expect((await call('onl', 'POST', '/api/pos/PO-G1/settle', { actualTotalAmount: 1200 })).status).toBe(200);
    const all = audits(['PO_SETTLED', 'PO_SETTLEMENT_EDITED']);
    expect(all.map((x) => x.action)).toEqual(['PO_SETTLED', 'PO_SETTLED']);
    expect(all[1].d.comment).toBe('ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿535 | ยอดจ่ายจริง ฿1,200');
  });

  it('PO number renumbered after a lost race : the audit row carries the FINAL number, one row only', async () => {
    seedPr('PR1', `PD001/${YEAR}`);
    // the number the counter will issue first is already taken by another PO -> the server takes the next one
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('PO-TAKEN', ?, 'PD', 'ISSUED', '[]')").run(`PO-PD-${YEAR}-001`);
    const r = await call('pm', 'POST', '/api/pos', newPo({ id: 'PO-R1' }));
    expect(r.status).toBe(200);
    const finalNo = sdb.prepare("SELECT poNumber FROM pos WHERE id = 'PO-R1'").get().poNumber;
    expect(finalNo).not.toBe(`PO-PD-${YEAR}-001`);
    const c = audits('PO_CREATED').filter((x) => x.entityId === 'PO-R1');
    expect(c).toHaveLength(1);
    expect(c[0].d.docNo).toBe(finalNo);
    expect(c[0].d.comment).toBe(`สร้างใบสั่งซื้อ (PO) เลขที่ ${finalNo}`);
  });
});
