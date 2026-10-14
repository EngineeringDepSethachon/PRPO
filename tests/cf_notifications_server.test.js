// @vitest-environment node
// M7-2 : server-made notifications (GAS recordNotification parity) + per-user read state (notification_reads).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { isUserTargetOfNotification } from '../functions/_lib/extra.js';
import { hashPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Notif#Pass1';
const YEAR = new Date().getFullYear();
const GR1 = 'GRN-PO-PD-2026-001-01';
const GR2 = 'GRN-PO-PD-2026-001-02';

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { const r = sdb.prepare(q).run(...norm(p)); return { success: true, meta: { changes: Number(r.changes) } }; }, // D1 reports meta.changes
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    // D1 runs a batch as ONE atomic transaction and one after the other : same here (a queue), so two concurrent requests really serialise
    batch: (() => {
      let chain = Promise.resolve();
      const doBatch = async (stmts) => { sdb.exec('BEGIN'); try { const o = []; for (const s of stmts) o.push(await s.run()); sdb.exec('COMMIT'); return o; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } };
      return (stmts) => { const run = chain.then(() => doBatch(stmts)); chain = run.catch(() => {}); return run; };
    })()
  };
}

const d = DatabaseSync ? describe : describe.skip;

d('server notifications (M7-2)', () => {
  let sdb; let env; const tok = {}; const safe = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const notifs = (type) => sdb.prepare('SELECT * FROM notifications WHERE type = ? ORDER BY rowid').all(type).map((r) => ({ ...r }));
  const allNotifs = () => sdb.prepare('SELECT * FROM notifications ORDER BY rowid').all().map((r) => ({ ...r }));
  const seenBy = async (who) => (await call(who, 'GET', '/api/notifications')).json;
  const newPr = (over = {}) => ({ id: 'PR-N1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 100, items: [{ id: 'i1', name: 'x', qty: 1, price: 100 }], ...over });
  const LINE = { productId: 'P1', code: 'C1', name: 'Item', qty: 5, purchaseQty: 5, price: 100 };
  const seedPo = (over = {}) => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',1,10,0,0,0)").run();
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('PO-G1', 'PO-PD-2026-001', 'PD001/2026', over.dept || 'PD', over.status || 'ISSUED', 500, 35, 535, JSON.stringify([LINE]), '{}', '[]', JSON.stringify({ vat: 35, subtotal: 500 }), 'SELF');
  };
  const recv = (grNumber, goodQty, extra = {}) => call('wh', 'POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty }], grNumber, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U1', 'req', 'Req PD', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1],
      ['U6', 'reqqc', 'Req QC', 'QC', '["QC"]', 'REQUESTER_QC', 'REQUESTER', 1],
      ['U2', 'asst', 'Asst PD', 'PD', '["PD"]', 'ASST_MANAGER', 'REVIEWER', 2],
      ['U3', 'pm', 'Plant', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 3],
      ['U4', 'onl', 'Online', 'PUR', '["*"]', 'ONLINE_PURCHASER', 'PURCHASER', 2],
      ['U9', 'adm', 'Admin', 'ALL', '["*"]', 'ADMIN', 'ADMIN', 99]
    ];
    for (const [id, username, name, dept, allowed, roleId, canon, level] of users) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,'',?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
        .run(id, username, name, dept, allowed, roleId, canon, level, rec.hash, rec.salt, rec.algo, rec.iterations);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [, username] of users) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env });
      const j = await r.json();
      tok[username] = j.token; safe[username] = j.user;
    }
    tok.wh = tok.req;
  });

  it('PR submitted (new, not DRAFT) -> PR_SUBMITTED / Approver of the PR department, GAS text ; a DRAFT sends nothing', async () => {
    await call('req', 'POST', '/api/prs', newPr({ id: 'PR-D', prNo: `PD009/${YEAR}`, status: 'DRAFT' }));
    expect(allNotifs()).toHaveLength(0);
    expect((await call('req', 'POST', '/api/prs', newPr())).status).toBe(200);
    const [n] = notifs('PR_SUBMITTED');
    expect(n).toMatchObject({ title: 'มี PR รอการตรวจสอบ / อนุมัติ', message: `ใบขอซื้อ PD001/${YEAR} แผนก PD จาก Req PD รอการอนุมัติ`, targetRole: 'Approver', targetDepartment: 'PD', docRef: `PD001/${YEAR}`, status: 'unread', createdBy: 'SERVER' });
    expect(allNotifs()).toHaveLength(1);
  });

  it('recipients follow isUserTargetOfNotification for every role / department ; another department never sees it', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    const row = allNotifs()[0];
    const seen = {};
    for (const u of ['req', 'reqqc', 'asst', 'pm', 'onl', 'adm']) {
      seen[u] = (await seenBy(u)).some((x) => x.id === row.id);
      expect(seen[u], u).toBe(isUserTargetOfNotification(row, safe[u]));
    }
    expect(seen.asst).toBe(true);
    expect(seen.pm).toBe(true);
    expect(seen.adm).toBe(true);
    expect(seen.req).toBe(false); // a requester is not an Approver target
    expect(seen.reqqc).toBe(false); // other department
  });

  it('review sends nothing ; approve -> 2 PR_APPROVED rows (Requester + Purchaser) ; the PR department comes from the row, not the body', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    expect(notifs('PR_APPROVED')).toHaveLength(0);
    expect((await call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED', department: 'QC' })).status).toBe(200);
    const rows = notifs('PR_APPROVED');
    expect(rows.map((r) => [r.title, r.message, r.targetRole, r.targetDepartment])).toEqual([
      ['PR ได้รับการอนุมัติแล้ว', `ใบขอซื้อ PD001/${YEAR} ได้รับการอนุมัติเรียบร้อยแล้ว`, 'Requester', 'PD'],
      ['มี PR ใหม่ได้รับการอนุมัติ (พร้อมออก PO)', `ใบขอซื้อ PD001/${YEAR} แผนก PD ได้รับการอนุมัติแล้ว พร้อมดำเนินการจัดซื้อ`, 'Purchaser', 'PD']
    ]);
    // QC requester gets neither ; the PD requester gets the Requester one
    const qc = await seenBy('reqqc');
    expect(qc.some((x) => x.type === 'PR_APPROVED')).toBe(false);
    const pd = await seenBy('req');
    expect(pd.filter((x) => x.type === 'PR_APPROVED').map((x) => x.targetRole)).toEqual(['Requester']);
  });

  it('send back -> PR_REJECTED / Requester with the reason ; cancel -> PR_CANCELLED / ALL', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'ข้อมูลไม่ครบ' });
    expect(notifs('PR_REJECTED').map((r) => [r.title, r.message, r.targetRole])).toEqual([['PR ไม่อนุมัติ / ส่งกลับแก้ไข', `ใบขอซื้อ PD001/${YEAR} ถูกส่งกลับ: ข้อมูลไม่ครบ`, 'Requester']]);
    await call('req', 'PUT', '/api/prs/PR-N1', { status: 'SUBMITTED', action: 'RESUBMIT' });
    expect(allNotifs().map((r) => r.type)).toEqual(['PR_SUBMITTED', 'PR_REJECTED']); // resubmit : GAS sends nothing
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'CANCELLED', cancelReason: 'ไม่ต้องการแล้ว', comment: 'ไม่ต้องการแล้ว' });
    expect(notifs('PR_CANCELLED').map((r) => [r.title, r.message, r.targetRole])).toEqual([['PR ถูกยกเลิกและคืนงบประมาณแล้ว', `ใบขอซื้อ PD001/${YEAR} ถูกยกเลิก (ไม่ต้องการแล้ว) และคืนงบประมาณเรียบร้อยแล้ว`, 'ALL']]);
    // an unchanged status writes nothing more
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'CANCELLED' });
    expect(notifs('PR_CANCELLED')).toHaveLength(1);
  });

  it('PO : CANCELLED first time -> PO_CANCELLED ; ORDERED first time -> ONLINE_ORDERED ; new claimResolution -> PO_CLAIM_CLOSED (once per resolvedAt)', async () => {
    seedPo({ status: 'ISSUED' });
    await call('adm', 'PUT', '/api/pos/PO-G1', { status: 'ORDERED' });
    await call('adm', 'PUT', '/api/pos/PO-G1', { status: 'ORDERED' });
    expect(notifs('ONLINE_ORDERED').map((r) => [r.title, r.message, r.targetRole, r.targetDepartment, r.docRef])).toEqual([['สินค้าสั่งซื้อแล้ว (รอรับของ)', 'ใบสั่งซื้อ PO-PD-2026-001 ได้รับการยืนยันการสั่งซื้อแล้ว อยู่ระหว่างการจัดส่ง', 'Requester', 'PD', 'PO-PD-2026-001']]);
    // a claim resolution counts only when the server really stored it (claim open + closing status) ; a bare claimResolution is dropped by the claim guard -> nothing
    await call('adm', 'PUT', '/api/pos/PO-G1', { claimResolution: { type: 'REFUND', refundAmount: 1500 } });
    expect(notifs('PO_CLAIM_CLOSED')).toHaveLength(0);
    sdb.prepare("UPDATE pos SET extraJson = json_patch(extraJson, '{\"claimStatus\":\"PENDING_CLAIM\"}') WHERE id = 'PO-G1'").run();
    expect((await call('adm', 'PUT', '/api/pos/PO-G1', { status: 'COMPLETED', claimResolution: { type: 'REFUND', refundAmount: 1500 } })).status).toBe(200);
    expect(notifs('PO_CLAIM_CLOSED').map((r) => [r.title, r.message, r.targetRole])).toEqual([['เคลมสินค้าสำเร็จ / คืนเงินเรียบร้อย', 'ใบสั่งซื้อ PO-PD-2026-001 จัดการเคลมสำเร็จ ได้รับเงินคืน ฿1,500', 'Purchaser']]);
    await call('adm', 'PUT', '/api/pos/PO-G1', { paymentTerms: '30' });
    expect(notifs('PO_CLAIM_CLOSED')).toHaveLength(1);
    await call('adm', 'PUT', '/api/pos/PO-G1', { status: 'CANCELLED' });
    await call('adm', 'PUT', '/api/pos/PO-G1', { status: 'CANCELLED' });
    expect(notifs('PO_CANCELLED').map((r) => [r.title, r.message, r.targetRole, r.targetDepartment])).toEqual([['PO ถูกยกเลิกและคืนงบประมาณแล้ว', 'ใบสั่งซื้อ PO-PD-2026-001 ถูกยกเลิกและคืนงบประมาณเรียบร้อยแล้ว', 'ALL', 'PD']]);
  });

  it('a PO created by POST (apiCreatePO) sends no notification ; POST over an existing row follows apiSavePO', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('PR1', ?, 'PD', 'PO_ISSUED', 1000, '[]')").run(`PD001/${YEAR}`);
    const first = await call('adm', 'POST', '/api/pos', { id: 'PO-N', poNo: `PO-PD-${YEAR}-040`, prNo: `PD001/${YEAR}`, department: 'PD', status: 'ORDERED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM pos WHERE id = 'PO-N'").get().n).toBe(1);
    expect(allNotifs()).toHaveLength(0);
    const again = await call('adm', 'POST', '/api/pos', { id: 'PO-N', poNo: `PO-PD-${YEAR}-040`, prNo: `PD001/${YEAR}`, department: 'PD', status: 'CANCELLED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(again.status).toBe(200);
    expect(notifs('PO_CANCELLED')).toHaveLength(1);
  });

  it('receive : partial -> PO_CLAIM to Purchaser AND Requester ; full -> GOODS_RECEIVED / Purchaser ; a retry of the same GRN adds no row ; stockOnly sends nothing', async () => {
    seedPo({ status: 'ORDERED' });
    expect((await recv(GR1, 2)).status).toBe(200);
    const partial = notifs('PO_CLAIM');
    expect(partial.map((r) => [r.title, r.message, r.targetRole, r.targetDepartment])).toEqual([
      ['ตรวจรับสินค้าบางส่วน / มีรายการค้างรับ-รอเคลม', 'ใบสั่งซื้อ PO-PD-2026-001 ตรวจรับบางส่วน มีรายการค้างรับหรือรอเคลม', 'Purchaser', 'PD'],
      ['ตรวจรับสินค้าบางส่วน / มีรายการค้างรับ-รอเคลม', 'ใบสั่งซื้อ PO-PD-2026-001 ตรวจรับบางส่วน มีรายการค้างรับหรือรอเคลม', 'Requester', 'PD']
    ]);
    await recv(GR1, 2); // retry
    expect(notifs('PO_CLAIM')).toHaveLength(2);
    expect((await recv(GR2, 3)).status).toBe(200);
    expect(notifs('GOODS_RECEIVED').map((r) => [r.title, r.message, r.targetRole])).toEqual([['ตรวจรับสินค้าเข้าคลังเรียบร้อย', 'ใบสั่งซื้อ PO-PD-2026-001 ได้รับสินค้าครบถ้วนและเข้าคลังเรียบร้อยแล้ว', 'Purchaser']]);
    expect(allNotifs()).toHaveLength(3);
  });

  it('stockOnly receive (ReceivingModal flow) : PO left open -> PO_CLAIM to Purchaser + Requester once per GRN ; PO finished -> none', async () => {
    seedPo({ status: 'ORDERED' });
    await call('wh', 'PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1, round: 1, items: [] }], items: [{ ...LINE, receivedQty: 5, goodQty: 5 }] });
    const before = allNotifs().length;
    const r = await call('wh', 'POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', code: 'C1', goodQty: 5, defectiveQty: 0 }] });
    expect(r.status).toBe(200);
    expect(allNotifs().length).toBe(before + 2);
    expect(notifs('PO_CLAIM').map((n) => n.targetRole).sort()).toEqual(['Purchaser', 'Requester']);
    await call('wh', 'POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', code: 'C1', goodQty: 5, defectiveQty: 0 }] });
    expect(allNotifs().length).toBe(before + 2);
  });

  it('read state is per user : one user reading does not mark it read for others ; mark-read of a notification that is not yours is 404 and writes nothing', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    await call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' });
    const requesterRow = notifs('PR_APPROVED').find((r) => r.targetRole === 'Requester');
    const approverRow = notifs('PR_SUBMITTED')[0];
    // admin and the PD requester both see the Requester row
    expect((await seenBy('adm')).find((x) => x.id === requesterRow.id).isRead).toBe(false);
    expect((await call('req', 'PUT', `/api/notifications/${requesterRow.id}`, { isRead: true })).status).toBe(200);
    expect((await seenBy('req')).find((x) => x.id === requesterRow.id)).toMatchObject({ isRead: true, read: true, status: 'read' });
    expect((await seenBy('adm')).find((x) => x.id === requesterRow.id)).toMatchObject({ isRead: false, status: 'unread' });
    expect(sdb.prepare('SELECT status FROM notifications WHERE id = ?').get(requesterRow.id).status).toBe('unread'); // the shared column is untouched
    // IDOR : the requester is not a recipient of the Approver row
    const reads = () => sdb.prepare('SELECT COUNT(*) AS n FROM notification_reads').get().n;
    const before = reads();
    const forbidden = await call('req', 'PUT', `/api/notifications/${approverRow.id}`, { isRead: true });
    const missing = await call('req', 'PUT', '/api/notifications/NTF-NOPE', { isRead: true });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(forbidden.json).toEqual(missing.json);
    expect(reads()).toBe(before);
    // other department's requester cannot mark the PD requester's row either
    expect((await call('reqqc', 'PUT', `/api/notifications/${requesterRow.id}`, { isRead: true })).status).toBe(404);
    // mark unread again
    expect((await call('req', 'PUT', `/api/notifications/${requesterRow.id}`, { isRead: false })).status).toBe(200);
    expect((await seenBy('req')).find((x) => x.id === requesterRow.id).isRead).toBe(false);
  });

  it('cancel of a PR that was sent back before : the reason is the cancel reason of THIS request (client body shape), audit row and notification alike', async () => {
    await call('req', 'POST', '/api/prs', newPr({ reason: 'ซื้อของใช้สำนักงาน' }));
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'ข้อมูลไม่ครบ', rejectionReason: 'ข้อมูลไม่ครบ', returnComment: 'ข้อมูลไม่ครบ' });
    const stored = (await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-N1');
    expect(stored.rejectReason).toBe('ข้อมูลไม่ครบ');
    // what apiService.cancelPR sends in Cloudflare mode : the whole PR + cancelReason / comment (the old rejectReason is still in it)
    expect((await call('req', 'PUT', '/api/prs/PR-N1', { ...stored, status: 'CANCELLED', cancelReason: 'เปลี่ยนแผน', comment: 'เปลี่ยนแผน' })).status).toBe(200);
    const [c] = notifs('PR_CANCELLED');
    expect(c.message).toBe(`ใบขอซื้อ PD001/${YEAR} ถูกยกเลิก (เปลี่ยนแผน) และคืนงบประมาณเรียบร้อยแล้ว`);
    const audit = JSON.parse(sdb.prepare("SELECT details FROM audit_logs WHERE entityId = 'PR-N1' AND action = 'CANCEL'").get().details);
    expect(audit.comment).toBe('เปลี่ยนแผน');
    expect((await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-N1').reason).toBe('ซื้อของใช้สำนักงาน'); // the PR's purpose is not overwritten
  });

  it('send-back reason is the rejectReason of the request, not the PR purpose (`reason`)', async () => {
    await call('req', 'POST', '/api/prs', newPr({ reason: 'ซื้อของใช้สำนักงาน' }));
    const stored = (await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-N1');
    await call('asst', 'PUT', '/api/prs/PR-N1', { ...stored, status: 'REJECTED_TO_DRAFT', rejectReason: 'ราคาสูงเกินไป' });
    expect(notifs('PR_REJECTED')[0].message).toBe(`ใบขอซื้อ PD001/${YEAR} ถูกส่งกลับ: ราคาสูงเกินไป`);
  });

  it('two identical transitions at the same time (double PUT) leave ONE audit row and ONE notification ; both answer 200', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    const body = { status: 'REJECTED_TO_DRAFT', rejectReason: 'ข้อมูลไม่ครบ' };
    const [a, b] = await Promise.all([call('asst', 'PUT', '/api/prs/PR-N1', body), call('asst', 'PUT', '/api/prs/PR-N1', body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(notifs('PR_REJECTED')).toHaveLength(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-N1' AND action = 'SEND_BACK'").get().n).toBe(1);
    // a request that read an older status while the PR moved to ANOTHER status is a conflict, not a silent write
    const stale = await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'x' });
    expect(stale.status).toBe(200); // already in that status : no-op
    expect(notifs('PR_REJECTED')).toHaveLength(1);
    // approve twice at once
    await call('req', 'PUT', '/api/prs/PR-N1', { status: 'SUBMITTED', action: 'RESUBMIT' });
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    const ap = await Promise.all([call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' }), call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' })]);
    expect(ap.map((r) => r.status)).toEqual([200, 200]);
    expect(notifs('PR_APPROVED')).toHaveLength(2);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-N1' AND action = 'APPROVE'").get().n).toBe(1);
  });

  it('POST upsert of an existing PR : two identical transitions at once -> one audit row, one notification, both 200 ; two identical creates at once -> one CREATE + one PR_SUBMITTED', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    const cancel = newPr({ status: 'CANCELLED', cancelReason: 'เปลี่ยนแผน', comment: 'เปลี่ยนแผน' });
    const r = await Promise.all([call('adm', 'POST', '/api/prs', cancel), call('adm', 'POST', '/api/prs', cancel)]);
    expect(r.map((x) => x.status)).toEqual([200, 200]);
    expect(notifs('PR_CANCELLED')).toHaveLength(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-N1' AND action = 'CANCEL'").get().n).toBe(1);
    expect(sdb.prepare("SELECT status FROM prs WHERE id = 'PR-N1'").get().status).toBe('CANCELLED');
    const fresh = newPr({ id: 'PR-N2', prNo: `PD002/${YEAR}` });
    const c = await Promise.all([call('req', 'POST', '/api/prs', fresh), call('req', 'POST', '/api/prs', fresh)]);
    expect(c.every((x) => x.status === 200 || x.status === 409)).toBe(true); // a second "create" that raced the first gets 409 and does not overwrite it
    expect(c.some((x) => x.status === 200)).toBe(true);
    expect(notifs('PR_SUBMITTED').filter((n) => n.docRef === `PD002/${YEAR}`)).toHaveLength(1);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-N2' AND action = 'CREATE'").get().n).toBe(1);
  });

  it('a "new" PR whose id appeared while the request was running (read: absent) -> 409, the existing row is not overwritten', async () => {
    const real = env.DB;
    let gate;
    const held = new Promise((r) => { gate = r; });
    env.DB = { ...real, prepare: (q) => { const o = real.prepare(q); if (/SELECT id, prNumber, status, department, totalAmount, itemsJson/.test(q)) return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => { const row = await b.first(); await held; return row; } }; } }; return o; } };
    const second = call('req', 'POST', '/api/prs', newPr({ totalAmount: 777 })); // read: no PR-N1 yet, waits
    await new Promise((r) => setTimeout(r, 30));
    env.DB = real;
    expect((await call('req', 'POST', '/api/prs', newPr())).status).toBe(200);
    gate();
    expect((await second).status).toBe(409);
    expect(sdb.prepare("SELECT totalAmount FROM prs WHERE id = 'PR-N1'").get().totalAmount).toBe(100);
    expect(notifs('PR_SUBMITTED')).toHaveLength(1);
  });

  it('a save made on an older view after somebody else approved -> 409, status stays APPROVED, content untouched (PUT and POST upsert)', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    // two requests that both read the PR while it was REVIEWED : the approval wins, the content edit (same status sent) lands after it
    const real = env.DB;
    let gate;
    const held = new Promise((r) => { gate = r; });
    let first = true;
    env.DB = { ...real, prepare: (q) => { const o = real.prepare(q); if (/SELECT id, status, department, totalAmount, itemsJson/.test(q) && first) { first = false; return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => { const row = await b.first(); await held; return row; } }; } }; } return o; } };
    const edit = call('asst', 'PUT', '/api/prs/PR-N1', { totalAmount: 150, items: [{ id: 'i1', name: 'x', qty: 1, price: 150 }] }); // read REVIEWED, waits
    await new Promise((r) => setTimeout(r, 30));
    env.DB = real;
    expect((await call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' })).status).toBe(200);
    gate();
    const late = await edit;
    expect(late.status).toBe(409);
    const row = sdb.prepare("SELECT status, totalAmount FROM prs WHERE id = 'PR-N1'").get();
    expect(row).toMatchObject({ status: 'APPROVED', totalAmount: 100 });
  });

  it('a RESUBMIT (same status, content changed) that loses the race -> 409 and NO audit row is committed', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    const real = env.DB;
    let gate;
    const held = new Promise((r) => { gate = r; });
    env.DB = { ...real, prepare: (q) => { const o = real.prepare(q); if (/SELECT id, status, department, totalAmount, itemsJson/.test(q)) return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => { const row = await b.first(); await held; return row; } }; } }; return o; } };
    const resend = call('asst', 'PUT', '/api/prs/PR-N1', { action: 'RESUBMIT', totalAmount: 150, items: [{ id: 'i1', name: 'x', qty: 1, price: 150 }] }); // read SUBMITTED, waits
    await new Promise((r) => setTimeout(r, 30));
    env.DB = real;
    expect((await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' })).status).toBe(200);
    gate();
    expect((await resend).status).toBe(409);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-N1' AND action = 'RESUBMIT'").get().n).toBe(0);
    expect(sdb.prepare("SELECT totalAmount FROM prs WHERE id = 'PR-N1'").get().totalAmount).toBe(100);
  });

  it('POST upsert of an existing PR with a stale status read -> 409 ; an unchanged repeat is still accepted', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    await call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' });
    // a re-sync POST of the same PR as it is now (sequential, normal client) is fine
    expect((await call('adm', 'POST', '/api/prs', newPr({ status: 'APPROVED' }))).status).toBe(200);
    // a POST that read the PR as APPROVED while somebody cancels it : the upsert must not bring it back
    sdb.prepare("UPDATE prs SET status = 'SUBMITTED' WHERE id = 'PR-N1'").run();
    const real = env.DB;
    let gate;
    const held = new Promise((r) => { gate = r; });
    env.DB = { ...real, prepare: (q) => { const o = real.prepare(q); if (/SELECT id, prNumber, status, department, totalAmount, itemsJson/.test(q)) return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => { const row = await b.first(); await held; return row; } }; } }; return o; } };
    const stale = call('adm', 'POST', '/api/prs', newPr({ totalAmount: 555, items: [{ id: 'i1', name: 'x', qty: 1, price: 555 }] })); // read SUBMITTED, waits
    await new Promise((r) => setTimeout(r, 30));
    env.DB = real;
    sdb.prepare("UPDATE prs SET status = 'CANCELLED' WHERE id = 'PR-N1'").run();
    gate();
    expect((await stale).status).toBe(409);
    expect(sdb.prepare("SELECT status, totalAmount FROM prs WHERE id = 'PR-N1'").get()).toMatchObject({ status: 'CANCELLED', totalAmount: 100 });
  });

  it('PO : two identical ORDERED saves at the same time -> one ONLINE_ORDERED', async () => {
    seedPo({ status: 'ISSUED' });
    const r = await Promise.all([call('adm', 'PUT', '/api/pos/PO-G1', { status: 'ORDERED' }), call('adm', 'PUT', '/api/pos/PO-G1', { status: 'ORDERED' })]);
    expect(r.map((x) => x.status)).toEqual([200, 200]);
    expect(notifs('ONLINE_ORDERED')).toHaveLength(1);
  });

  it('PUT /api/notifications/read-all : marks only what the caller is a recipient of, for the caller only ; an old shared status = read stays read for everybody', async () => {
    await call('req', 'POST', '/api/prs', newPr());
    await call('asst', 'PUT', '/api/prs/PR-N1', { status: 'REVIEWED' });
    await call('pm', 'PUT', '/api/prs/PR-N1', { status: 'APPROVED' });
    const rows = allNotifs();
    const approverRow = rows.find((r) => r.type === 'PR_SUBMITTED');
    const requesterRow = rows.find((r) => r.type === 'PR_APPROVED' && r.targetRole === 'Requester');
    // the PD requester asks to mark both ids : the Approver row is not theirs and is ignored
    const res = await call('req', 'PUT', '/api/notifications/read-all', { ids: [approverRow.id, requesterRow.id, 'NTF-NOPE'] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, count: 1 });
    expect(sdb.prepare('SELECT notificationId, userId FROM notification_reads').all().map((r) => ({ ...r }))).toEqual([{ notificationId: requesterRow.id, userId: 'U1' }]);
    expect((await seenBy('adm')).find((x) => x.id === requesterRow.id).isRead).toBe(false);
    // no body = everything visible to the caller
    expect((await call('adm', 'PUT', '/api/notifications/read-all', {})).json.count).toBeGreaterThan(0);
    expect((await seenBy('adm')).every((x) => x.isRead)).toBe(true);
    expect((await seenBy('req')).find((x) => x.id === requesterRow.id).isRead).toBe(true);
    // legacy shared flag
    sdb.prepare("UPDATE notifications SET status = 'read' WHERE id = ?").run(approverRow.id);
    expect((await seenBy('asst')).find((x) => x.id === approverRow.id).isRead).toBe(true);
    expect((await seenBy('pm')).find((x) => x.id === approverRow.id).isRead).toBe(true);
  });

  it('PR + notification rows are one batch : a failing batch leaves neither', async () => {
    const real = env.DB;
    env.DB = { ...real, batch: async () => { throw new Error('boom'); } };
    const r = await call('req', 'POST', '/api/prs', newPr({ id: 'PR-ATOM' }));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(allNotifs()).toHaveLength(0);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM prs WHERE id = 'PR-ATOM'").get().c).toBe(0);
  });
});
