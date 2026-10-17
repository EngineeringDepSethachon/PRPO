// @vitest-environment node
// Phase 3 / M10 T3 (FR-01) : the route side of the purchasing-checker step (role BUFFER "พี่สุ", status PENDING_BUFFER).
//   POST /api/prs + PUT /api/prs/:id (server decides PENDING_BUFFER / REVIEWED), prApprovalPatch stamps, audit BUFFER_FORWARD, notifications,
//   edits at PENDING_BUFFER (qty / price / link + total check), user upsert / formatSafeUser for roleId BUFFER.
// Decisions (docs/whiteboard.md 2026-10-17) : Q1 no ACTIVE BUFFER user -> the step is skipped ; Q6 reviewer / approver / admin send back or cancel, the BUFFER has no
// reject / cancel ; Q9 only the BUFFER role / admin edit at PENDING_BUFFER.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { isUserTargetOfNotification } from '../functions/_lib/extra.js';
import { prNotificationParams } from '../functions/_lib/notify.js';
import { hashPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Buffer#Pass1';
const YEAR = new Date().getFullYear();

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { const r = sdb.prepare(q).run(...norm(p)); return { success: true, meta: { changes: Number(r.changes) } }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: (() => {
      let chain = Promise.resolve();
      const doBatch = async (stmts) => { sdb.exec('BEGIN'); try { const o = []; for (const s of stmts) o.push(await s.run()); sdb.exec('COMMIT'); return o; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } };
      return (stmts) => { const run = chain.then(() => doBatch(stmts)); chain = run.catch(() => {}); return run; };
    })()
  };
}

const LINE = (over = {}) => ({ productId: 'P1', code: 'C1', name: 'Pen', qty: 2, purchaseQty: 2, price: 100, conversionRate: 1, unit: 'box', purchaseUnit: 'box', productUrl: 'https://shop.example/pen', ...over });
const LINES = () => [LINE(), LINE({ productId: 'P2', code: 'C2', name: 'Ink', qty: 1, purchaseQty: 1, price: 50, productUrl: '' })];
const FIN = (over = {}) => ({ subtotal: 250, itemDiscountTotal: 0, combinedDiscountType: 'fixed', combinedDiscountValue: 0, combinedDiscountAmount: 0, totalDiscount: 0, vatMode: 'NONE', vatAmount: 0, roundingAdj: 0, shippingCost: 0, grandTotal: 250, ...over });

const d = DatabaseSync ? describe : describe.skip;

d('BUFFER step (M10 T3)', () => {
  let sdb; let env; const tok = {}; const safe = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => ({ ...sdb.prepare('SELECT * FROM prs WHERE id = ?').get(id) });
  const extraOf = (id) => JSON.parse(row(id).extraJson || '{}');
  const itemsOf = (id) => JSON.parse(row(id).itemsJson || '[]');
  const audits = (id, action) => sdb.prepare('SELECT * FROM audit_logs WHERE entityType = ? AND entityId = ? AND action = ? ORDER BY rowid').all('pr', id, action).map((r) => ({ ...r, details: JSON.parse(r.details || '{}') }));
  const notifs = (type) => sdb.prepare('SELECT * FROM notifications WHERE type = ? ORDER BY rowid').all(type).map((r) => ({ ...r }));
  const seenBy = async (who) => (await call(who, 'GET', '/api/notifications')).json;
  const setBuffer = (status) => sdb.prepare("UPDATE users SET status = ? WHERE roleId = 'BUFFER'").run(status);
  let n = 0;
  // a SUBMITTED PR of the PD department (created by the requester) ; returns its id
  const submitted = async (over = {}) => {
    n += 1;
    const id = over.id || `PR-B${n}`;
    const r = await call('req', 'POST', '/api/prs', { id, prNo: `PD${String(n).padStart(3, '0')}/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN(), ...over });
    expect(r.status, 'create').toBe(200);
    return id;
  };
  // a PR parked at PENDING_BUFFER (an ACTIVE BUFFER user exists)
  const parked = async (over = {}) => {
    const id = await submitted(over);
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.status, 'review').toBe(200);
    expect(r.json.status).toBe('PENDING_BUFFER');
    return id;
  };
  // the BUFFER's own edit + forward
  const forward = (id, over = {}) => call('su', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', ...over });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U1', 'req', 'Req PD', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1],
      ['U2', 'asst', 'Asst PD', 'PD', '["PD"]', 'ASST_MANAGER', 'REVIEWER', 2],
      ['U-BF', 'su', 'Su Buffer', 'ALL', '["ALL"]', 'BUFFER', 'BUFFER', 2],
      ['U3', 'pm', 'Plant PM', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 3],
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
    n = 0;
  });

  // ───────────── (a) no ACTIVE BUFFER user : the step is skipped (Q1) ─────────────
  it('(a) no active BUFFER user: the reviewer pass stores REVIEWED, bufferSkipped true, the approver approves as before ; behaviour of an old flow', async () => {
    setBuffer('INACTIVE');
    const id = await submitted();
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, status: 'REVIEWED', bufferSkipped: true });
    expect(row(id).status).toBe('REVIEWED');
    expect(extraOf(id)).toMatchObject({ reviewerName: 'Asst PD' });
    expect(extraOf(id).reviewedBy).toMatchObject({ name: 'Asst PD' });
    expect(extraOf(id).bufferReviewedBy).toBeUndefined();
    expect(audits(id, 'REVIEW_FORWARD')).toHaveLength(1);
    expect(audits(id, 'REVIEW_FORWARD')[0].details.comment).toBe('ตรวจสอบผ่าน ส่งต่อ Plant Mgr'); // the old wording
    expect(audits(id, 'BUFFER_FORWARD')).toHaveLength(0);
    expect(notifs('PR_PENDING_BUFFER')).toHaveLength(0);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(row(id).status).toBe('APPROVED');
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").get().c).toBe(1);
  });

  it('(a) POST path too ; a client that asks for PENDING_BUFFER itself gets REVIEWED when there is no BUFFER user ; admin sends what he means', async () => {
    setBuffer('INACTIVE');
    const id1 = await submitted();
    const p1 = await call('asst', 'POST', '/api/prs', { id: id1, status: 'PENDING_BUFFER' });
    expect(p1.status).toBe(200);
    expect(p1.json).toMatchObject({ success: true, status: 'REVIEWED', bufferSkipped: true });
    expect(p1.json.pr.status).toBe('REVIEWED');
    expect(row(id1).status).toBe('REVIEWED');
    const id2 = await submitted();
    const p2 = await call('asst', 'PUT', `/api/prs/${id2}`, { status: 'PENDING_BUFFER' });
    expect(p2.json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    // admin : exactly what was sent, no skipping flag
    const id3 = await submitted();
    const p3 = await call('adm', 'PUT', `/api/prs/${id3}`, { status: 'PENDING_BUFFER' });
    expect(p3.status).toBe(200);
    expect(p3.json.status).toBe('PENDING_BUFFER');
    expect(p3.json.bufferSkipped).toBeUndefined();
    expect(row(id3).status).toBe('PENDING_BUFFER');
  });

  // ───────────── (b) an active BUFFER user : PENDING_BUFFER + a notification only the BUFFER (and admin) sees ─────────────
  it('(b) with an active BUFFER user the pass stores PENDING_BUFFER (PUT and POST, REVIEWED or PENDING_BUFFER asked) ; reviewer stamps are kept', async () => {
    const id = await submitted();
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, id, status: 'PENDING_BUFFER' });
    expect(r.json.bufferSkipped).toBeUndefined();
    expect(row(id).status).toBe('PENDING_BUFFER');
    const x = extraOf(id);
    expect(x.reviewedBy).toMatchObject({ name: 'Asst PD' });
    expect(x).toMatchObject({ reviewerName: 'Asst PD' });
    expect(typeof x.reviewedAt).toBe('string');
    expect(x.bufferReviewedBy).toBeUndefined();
    // the history keeps the reviewer's action under the name the PDF looks for
    expect(x.approvalHistory.map((h) => h.action)).toEqual(['SUBMITTED', 'REVIEWED']);
    const a = audits(id, 'REVIEW_FORWARD');
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ status: 'PENDING_BUFFER', comment: 'ส่งต่อผู้ตรวจสอบจัดซื้อ', actorName: 'Asst PD' });
    // POST path, PENDING_BUFFER asked
    const id2 = await submitted();
    const p = await call('asst', 'POST', '/api/prs', { id: id2, status: 'PENDING_BUFFER' });
    expect(p.json).toMatchObject({ success: true, status: 'PENDING_BUFFER' });
    expect(p.json.pr.status).toBe('PENDING_BUFFER');
    // POST path, REVIEWED asked
    const id3 = await submitted();
    expect((await call('asst', 'POST', '/api/prs', { id: id3, status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
    expect(row(id3).status).toBe('PENDING_BUFFER');
    // a batch carries the status of every PR
    const id4 = await submitted(); const id5 = await submitted();
    const batch = await call('asst', 'POST', '/api/prs', [{ id: id4, status: 'REVIEWED' }, { id: id5, status: 'REVIEWED' }]);
    expect(batch.json.results.map((q) => [q.id, q.status])).toEqual([[id4, 'PENDING_BUFFER'], [id5, 'PENDING_BUFFER']]);
  });

  it('(b) PR_PENDING_BUFFER notification: targetRole BUFFER, department of the PR ; only the BUFFER user and the admin see it', async () => {
    const id = await parked();
    const rows = notifs('PR_PENDING_BUFFER');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'มี PR รอผู้ตรวจสอบจัดซื้อตรวจสอบ', targetRole: 'BUFFER', targetDepartment: 'PD', docRef: `PD001/${YEAR}`, status: 'unread', createdBy: 'SERVER' });
    expect(rows[0].message).toContain('มี PR รอผู้ตรวจสอบจัดซื้อตรวจสอบ');
    const seen = {};
    for (const u of ['req', 'asst', 'su', 'pm', 'adm']) {
      seen[u] = (await seenBy(u)).some((q) => q.id === rows[0].id);
      expect(seen[u], u).toBe(isUserTargetOfNotification(rows[0], safe[u]));
    }
    expect(seen).toMatchObject({ su: true, adm: true, req: false, asst: false, pm: false });
    expect(id).toBeTruthy();
  });

  it('(b) the review-pass wording in prNotificationParams: nothing for a skipped pass, PR_PENDING_BUFFER for the BUFFER step', () => {
    expect(prNotificationParams('REVIEW_FORWARD', { dept: 'PD', prNo: 'X', requesterName: 'a', body: {}, status: 'REVIEWED' })).toEqual([]);
    expect(prNotificationParams('REVIEW_FORWARD', { dept: 'PD', prNo: 'X', requesterName: 'a', body: {} })).toEqual([]);
    expect(prNotificationParams('REVIEW_FORWARD', { dept: 'QC', prNo: 'X', requesterName: 'a', body: {}, status: 'PENDING_BUFFER' })).toMatchObject([{ type: 'PR_PENDING_BUFFER', targetRole: 'BUFFER', targetDept: 'QC' }]);
    expect(prNotificationParams('BUFFER_FORWARD', { dept: 'QC', prNo: 'X', requesterName: 'a', body: {}, status: 'REVIEWED' })).toMatchObject([{ targetRole: 'Approver', targetDept: 'QC', title: 'PR ผ่านการตรวจสอบจัดซื้อ รออนุมัติ' }]);
  });

  // ───────────── (c) the BUFFER edits and forwards ─────────────
  it('(c) the BUFFER edits qty / price / link + comment and forwards: REVIEWED, buffer stamps, reviewedBy kept, audit BUFFER_FORWARD with the diff, Approver notified', async () => {
    const id = await parked();
    const reviewedBefore = extraOf(id).reviewedBy;
    const items = [LINE({ qty: 3, purchaseQty: 3, unit: 'EVIL', conversionRate: 99, productUrl: 'https://shop.example/pen-v2' }), LINE({ productId: 'P2', code: 'C2', name: 'Ink', qty: 1, purchaseQty: 1, price: 90, productUrl: 'https://shop.example/ink' })];
    const r = await forward(id, { items, totalAmount: 390, financials: FIN({ subtotal: 390, grandTotal: 390 }), bufferComment: '  ปรับตามใบเสนอราคา  ' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, status: 'REVIEWED' });
    expect(r.json.bufferSkipped).toBeUndefined();
    expect(row(id).status).toBe('REVIEWED');
    expect(row(id).totalAmount).toBe(390);
    const stored = itemsOf(id);
    expect(stored[0]).toMatchObject({ qty: 3, purchaseQty: 3, price: 100, productUrl: 'https://shop.example/pen-v2', unit: 'box', conversionRate: 1 }); // unit / rate stay the stored ones
    expect(stored[1]).toMatchObject({ qty: 1, price: 90, productUrl: 'https://shop.example/ink' });
    const x = extraOf(id);
    expect(x.financials).toMatchObject({ subtotal: 390, grandTotal: 390, vatMode: 'NONE' });
    // the stamps: the BUFFER's own, from the token ; the reviewer's are untouched
    expect(x).toMatchObject({ bufferReviewedBy: 'Su Buffer', bufferReviewedById: 'U-BF', bufferComment: 'ปรับตามใบเสนอราคา' });
    expect(Number.isNaN(Date.parse(x.bufferReviewedAt))).toBe(false);
    expect(x.reviewedBy).toEqual(reviewedBefore);
    expect(x.reviewerName).toBe('Asst PD');
    expect(x.approvalHistory.map((h) => h.action)).toEqual(['SUBMITTED', 'REVIEWED', 'BUFFER_REVIEWED']);
    expect(x.approvalHistory[2]).toMatchObject({ actorName: 'Su Buffer', comment: 'ปรับตามใบเสนอราคา' });
    // audit
    const a = audits(id, 'BUFFER_FORWARD');
    expect(a).toHaveLength(1);
    expect(a[0].performedBy).toBe('U-BF');
    expect(a[0].details).toMatchObject({ status: 'REVIEWED', actorName: 'Su Buffer', bufferComment: 'ปรับตามใบเสนอราคา' });
    expect(a[0].details.comment).toBe('ผู้ตรวจสอบจัดซื้อส่งต่อผู้อนุมัติ : ปรับตามใบเสนอราคา');
    expect(a[0].details.changes).toEqual([
      { index: 0, productId: 'P1', name: 'Pen', field: 'qty', before: 2, after: 3 },
      { index: 0, productId: 'P1', name: 'Pen', field: 'productUrl', before: 'https://shop.example/pen', after: 'https://shop.example/pen-v2' },
      { index: 1, productId: 'P2', name: 'Ink', field: 'price', before: 50, after: 90 },
      { index: 1, productId: 'P2', name: 'Ink', field: 'productUrl', before: '', after: 'https://shop.example/ink' }
    ]);
    // the timeline (read back by every viewer) carries the same event, actor from the token
    const list = (await call('pm', 'GET', '/api/prs')).json;
    const pr = list.find((q) => q.id === id);
    const ev = pr.timeline.find((e) => e.action === 'BUFFER_FORWARD');
    expect(ev).toMatchObject({ actorName: 'Su Buffer', status: 'REVIEWED', bufferComment: 'ปรับตามใบเสนอราคา' });
    expect(ev.changes).toHaveLength(4);
    expect(pr.timeline.map((e) => e.action).filter((q) => ['REVIEW_FORWARD', 'BUFFER_FORWARD'].includes(q))).toEqual(['REVIEW_FORWARD', 'BUFFER_FORWARD']);
    expect(pr).toMatchObject({ bufferReviewedBy: 'Su Buffer', status: 'REVIEWED' });
    // notification: the Approver, not the BUFFER
    const nr = notifs('PR_SUBMITTED').filter((q) => q.title === 'PR ผ่านการตรวจสอบจัดซื้อ รออนุมัติ');
    expect(nr).toHaveLength(1);
    expect(nr[0]).toMatchObject({ targetRole: 'Approver', targetDepartment: 'PD' });
    expect((await seenBy('pm')).some((q) => q.id === nr[0].id)).toBe(true);
    expect((await seenBy('su')).some((q) => q.id === nr[0].id)).toBe(false);
    // the approver approves from REVIEWED as before (commitment from the NEW total)
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(sdb.prepare("SELECT amount FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").get().amount).toBe(-390);
  });

  it('(c) a forward without edits stamps and notifies too ; admin may forward in the BUFFER\'s place (buffer stamps, reviewedBy kept)', async () => {
    const id = await parked();
    const r = await call('adm', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', bufferComment: 'ปิดบัญชีพี่สุ ส่งต่อแทน' });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('REVIEWED');
    expect(extraOf(id)).toMatchObject({ bufferReviewedBy: 'Admin', reviewerName: 'Asst PD', bufferComment: 'ปิดบัญชีพี่สุ ส่งต่อแทน' });
    expect(audits(id, 'BUFFER_FORWARD')[0].details.changes).toEqual([]);
  });

  it('(c) a PR sent back to the reviewer and reviewed again starts the BUFFER step afresh (old buffer stamps cleared)', async () => {
    const id = await parked();
    expect((await forward(id, { bufferComment: 'ok' })).status).toBe(200);
    expect(extraOf(id).bufferReviewedBy).toBe('Su Buffer');
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'REJECTED_TO_L2' })).status).toBe(200);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
    const x = extraOf(id);
    expect(x.bufferReviewedBy).toBeUndefined();
    expect(x.bufferComment).toBeUndefined();
    expect(x.reviewedBy).toMatchObject({ name: 'Asst PD' });
  });

  // ───────────── (d) who may do what at PENDING_BUFFER ─────────────
  it('(d) the BUFFER cannot reject / cancel / approve / issue (403) ; the PR stays at PENDING_BUFFER (PUT and POST)', async () => {
    const id = await parked();
    for (const s of ['REJECTED_TO_DRAFT', 'REJECTED_TO_L2', 'CANCELLED', 'APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'SUBMITTED', 'DRAFT']) {
      expect((await call('su', 'PUT', `/api/prs/${id}`, { status: s })).status, `PUT ${s}`).toBe(403);
      expect((await call('su', 'POST', '/api/prs', { id, status: s })).status, `POST ${s}`).toBe(403);
    }
    expect(row(id).status).toBe('PENDING_BUFFER');
  });

  it('(d) edits at PENDING_BUFFER: requester / reviewer / approver get 403 (qty, price, total AND link) ; the BUFFER and admin may', async () => {
    const id = await parked();
    const qty = [LINE({ qty: 5, purchaseQty: 5 }), LINES()[1]];
    const link = [LINE({ productUrl: 'https://evil.example/' }), LINES()[1]];
    for (const who of ['req', 'asst', 'pm']) {
      expect((await call(who, 'PUT', `/api/prs/${id}`, { items: qty, totalAmount: 550 })).status, `${who} qty`).toBe(403);
      expect((await call(who, 'PUT', `/api/prs/${id}`, { items: link })).status, `${who} link`).toBe(403);
      expect((await call(who, 'PUT', `/api/prs/${id}`, { totalAmount: 1 })).status, `${who} total`).toBe(403);
      expect((await call(who, 'POST', '/api/prs', { id, items: link })).status, `${who} POST link`).toBe(403);
    }
    expect(itemsOf(id)[0].productUrl).toBe('https://shop.example/pen');
    expect(row(id).totalAmount).toBe(250);
    // an unchanged copy of the PR (the client sends the whole document back) is fine for the others
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { items: LINES(), totalAmount: 250 })).status).toBe(200);
    // the BUFFER edits without moving the PR, then admin too
    expect((await call('su', 'PUT', `/api/prs/${id}`, { items: link, totalAmount: 250 })).status).toBe(200);
    expect(itemsOf(id)[0].productUrl).toBe('https://evil.example/');
    expect(row(id).status).toBe('PENDING_BUFFER');
    expect((await call('adm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 4, purchaseQty: 4, productUrl: 'https://evil.example/' }), LINES()[1]], totalAmount: 450 })).status).toBe(200);
    expect(row(id).totalAmount).toBe(450);
  });

  it('(d) reviewer / approver / admin send back or cancel a PR parked at the BUFFER (Q6) ; the approver may send it back to the reviewer', async () => {
    const cases = [['asst', 'REJECTED_TO_DRAFT'], ['asst', 'CANCELLED'], ['pm', 'REJECTED_TO_DRAFT'], ['pm', 'CANCELLED'], ['pm', 'REJECTED_TO_L2'], ['adm', 'CANCELLED']];
    for (const [who, status] of cases) {
      const id = await parked();
      const r = await call(who, 'PUT', `/api/prs/${id}`, { status, ...(status.startsWith('REJECTED') ? { rejectReason: 'ไม่ครบ' } : {}) });
      expect(r.status, `${who} ${status}`).toBe(200);
      expect(r.json.status).toBe(status);
      expect(row(id).status).toBe(status);
    }
    // the reviewer cannot send it back to the reviewer queue (only the approver) nor approve ; a requester can do nothing
    const id = await parked();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REJECTED_TO_L2' })).status).toBe(403);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(403);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(403); // no skipping the BUFFER
    expect((await call('req', 'PUT', `/api/prs/${id}`, { status: 'CANCELLED' })).status).toBe(403);
    expect(row(id).status).toBe('PENDING_BUFFER');
  });

  it('(d) a stored level 3 on a BUFFER account does not make it an approver (the route clamps the level to 2)', async () => {
    const id = await parked();
    expect((await forward(id)).status).toBe(200);
    sdb.prepare("UPDATE users SET level = 3 WHERE id = 'U-BF'").run();
    expect((await call('su', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(403);
    expect((await call('su', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 5 } })).status).toBe(403);
    expect(row(id).status).toBe('REVIEWED');
  });

  // ───────────── (e) forged stamps are dropped ─────────────
  it('(e) a client cannot forge buffer stamps: on create, on the reviewer pass, on the forward and on later saves', async () => {
    const forged = { bufferReviewedBy: 'Mallory', bufferReviewedById: 'X', bufferReviewedAt: '2020-01-01T00:00:00.000Z', bufferComment: 'forged' };
    const id = await submitted(forged);
    expect(Object.keys(extraOf(id)).filter((k) => k.startsWith('buffer'))).toEqual([]);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', ...forged })).json.status).toBe('PENDING_BUFFER');
    expect(Object.keys(extraOf(id)).filter((k) => k.startsWith('buffer'))).toEqual([]);
    // the forward: the stamps are the token's, whatever the body says ; reviewedBy cannot be overwritten either
    const r = await forward(id, { ...forged, reviewedBy: { name: 'Mallory' }, reviewerName: 'Mallory', approvalHistory: [{ action: 'BUFFER_REVIEWED', comment: 'forged entry', timestamp: 'x' }, { action: 'REVIEWED', comment: 'forged review', timestamp: 'y' }] });
    expect(r.status).toBe(200);
    const x = extraOf(id);
    expect(x).toMatchObject({ bufferReviewedBy: 'Su Buffer', bufferReviewedById: 'U-BF', reviewerName: 'Asst PD' });
    expect(x.bufferComment).toBe('forged'); // the comment IS the BUFFER's to write ...
    expect(x.bufferReviewedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(x.reviewedBy.name).toBe('Asst PD');
    // ... and a forged review / BUFFER entry sent by the client is only accepted as the real transition's, with the token identity
    expect(x.approvalHistory.every((h) => ['Req PD', 'Asst PD', 'Su Buffer'].includes(h.actorName))).toBe(true);
    // later saves by anybody cannot touch them
    for (const who of ['req', 'asst', 'pm', 'su']) await call(who, 'PUT', `/api/prs/${id}`, { ...forged, bufferComment: 'later' });
    expect(extraOf(id)).toMatchObject({ bufferReviewedBy: 'Su Buffer', bufferReviewedById: 'U-BF', bufferComment: 'forged' });
    // the approval does not change them either
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED', ...forged })).status).toBe(200);
    expect(extraOf(id)).toMatchObject({ bufferReviewedBy: 'Su Buffer', bufferComment: 'forged' });
  });

  it('(e) body.note counts as the BUFFER\'s comment only when it differs from the PR\'s own note ; the comment is cut at 2000 characters', async () => {
    const id = await parked({ note: 'หมายเหตุผู้ขอ' });
    const r = await forward(id, { note: 'หมายเหตุผู้ขอ' });
    expect(r.status).toBe(200);
    expect(extraOf(id).bufferComment).toBeUndefined();
    const id2 = await parked({ note: 'หมายเหตุผู้ขอ' });
    await forward(id2, { bufferComment: 'x'.repeat(2500) });
    expect(extraOf(id2).bufferComment).toHaveLength(2000);
  });

  // ───────────── (f) edits at PENDING_BUFFER: the total must match the lines ─────────────
  it('(f) a total that does not match the lines is a 400 and nothing is written (also financials.grandTotal)', async () => {
    const id = await parked();
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]]; // 350
    const before = row(id);
    expect((await forward(id, { items, totalAmount: 999 })).status).toBe(400);
    expect((await forward(id, { items, totalAmount: 350.5 })).status).toBe(400);
    expect((await forward(id, { items, totalAmount: 350, financials: FIN({ grandTotal: 400 }) })).status).toBe(400);
    expect((await forward(id, { items })).status).toBe(400); // items changed, no total
    expect((await call('su', 'PUT', `/api/prs/${id}`, { totalAmount: 777 })).status).toBe(400); // a total alone, lines untouched
    expect((await call('adm', 'PUT', `/api/prs/${id}`, { items, totalAmount: 1 })).status).toBe(400); // admin is checked too
    expect(row(id).status).toBe('PENDING_BUFFER');
    expect(row(id).itemsJson).toBe(before.itemsJson);
    expect(row(id).totalAmount).toBe(250);
    // within a cent is fine
    expect((await forward(id, { items, totalAmount: 350.005, financials: FIN({ subtotal: 350, grandTotal: 350 }) })).status).toBe(200);
    expect(row(id).totalAmount).toBe(350);
  });

  it('(f) the stored VAT / discount / shipping settings drive the expected total ; the server rewrites financials', async () => {
    const id = await parked({ totalAmount: 267.5, financials: FIN({ vatMode: 'AFTER_DISCOUNT', vatAmount: 17.5, grandTotal: 267.5 }) });
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]]; // subtotal 350, VAT 24.5, total 374.5
    expect((await forward(id, { items, totalAmount: 350 })).status).toBe(400); // forgot the VAT
    expect((await forward(id, { items, totalAmount: 374.5, financials: FIN({ vatMode: 'NONE', vatAmount: 0, grandTotal: 374.5 }) })).status).toBe(200); // vatMode of the body is ignored
    expect(row(id).totalAmount).toBe(374.5);
    expect(extraOf(id).financials).toMatchObject({ subtotal: 350, vatMode: 'AFTER_DISCOUNT', vatAmount: 24.5, grandTotal: 374.5 });
    // a combined percent discount + shipping + rounding
    const id2 = await parked({ totalAmount: 255, financials: FIN({ combinedDiscountType: 'percent', combinedDiscountValue: 10, combinedDiscountAmount: 25, totalDiscount: 25, shippingCost: 30, grandTotal: 255 }) });
    // 350 - 10% = 315 + 30 = 345
    expect((await forward(id2, { items, totalAmount: 345 })).status).toBe(200);
    expect(extraOf(id2).financials).toMatchObject({ subtotal: 350, combinedDiscountAmount: 35, totalDiscount: 35, shippingCost: 30, grandTotal: 345 });
  });

  it('(f) a PR without financials: total = sum(qty x price - line discount) ; the stored line discount counts (absolute, or re-derived from its percent)', async () => {
    const id = await parked({ totalAmount: 230, financials: undefined, items: [LINE({ discountAmount: 20 }), LINES()[1]] });
    const items = [LINE({ qty: 3, purchaseQty: 3, discountAmount: 20 }), LINES()[1]]; // 350 - 20 = 330
    expect((await forward(id, { items, totalAmount: 350 })).status).toBe(400); // forgot the discount
    expect((await forward(id, { items, totalAmount: 330 })).status).toBe(200);
    expect(row(id).totalAmount).toBe(330);
    expect(extraOf(id).financials).toBeUndefined(); // nothing to rewrite
    const id2 = await parked({ totalAmount: 230, financials: undefined, items: [LINE({ discountAmount: 20, discountPercent: 10 }), LINES()[1]] });
    expect((await forward(id2, { items: [LINE({ qty: 3, purchaseQty: 3, discountAmount: 20, discountPercent: 10 }), LINES()[1]], totalAmount: 320 })).status).toBe(200); // 10% of 300 = 30
  });

  it('(f) lines are never added / removed / swapped (403) ; qty must be > 0 and price >= 0 (400) ; a changed link must be http(s) (400)', async () => {
    const id = await parked();
    const bad = async (items, code, label) => { expect((await forward(id, { items, totalAmount: 250 })).status, label).toBe(code); };
    await bad([LINE()], 403, 'removed');
    await bad([...LINES(), LINE({ productId: 'P3' })], 403, 'added');
    await bad([LINES()[1], LINES()[0]], 403, 'swapped');
    await bad([LINE({ qty: 0, purchaseQty: 0 }), LINES()[1]], 400, 'qty 0');
    await bad([LINE({ qty: -1, purchaseQty: -1 }), LINES()[1]], 400, 'qty -1');
    await bad([LINE({ price: -5 }), LINES()[1]], 400, 'price -5');
    await bad([LINE({ price: 'abc' }), LINES()[1]], 400, 'price text');
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.example/a', 'not a url', `https://x.example/${'a'.repeat(2100)}`]) {
      await bad([LINE({ productUrl: url }), LINES()[1]], 400, `url ${url.slice(0, 20)}`);
    }
    expect((await forward(id, { items: [LINE({ onlineUrl: 'javascript:alert(1)' }), LINES()[1]], totalAmount: 250 })).status).toBe(400);
    expect(row(id).status).toBe('PENDING_BUFFER');
    // clearing a link and setting an https / onlineUrl one is fine
    expect((await forward(id, { items: [LINE({ productUrl: '', onlineUrl: ' https://shop.example/o ' }), LINES()[1]], totalAmount: 250 })).status).toBe(200);
    expect(itemsOf(id)[0]).toMatchObject({ productUrl: '', onlineUrl: 'https://shop.example/o' });
  });

  it('(f) the checks apply only at PENDING_BUFFER: the reviewer still edits SUBMITTED / REVIEWED items as before', async () => {
    setBuffer('INACTIVE');
    const id = await submitted();
    const items = [LINE({ qty: 4, purchaseQty: 4 }), LINES()[1]];
    // kla round 2 : the total is checked against the lines at every editable status (a wrong total is a 400), the BUFFER-only rules (links ...) still apply only at PENDING_BUFFER
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { items, totalAmount: 1234 })).status).toBe(400);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { items, totalAmount: 450 })).status).toBe(200);
    expect(row(id).totalAmount).toBe(450);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.bufferSkipped).toBe(true);
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { items: LINES(), totalAmount: 250 })).status).toBe(200);
  });

  // ───────────── (g) an INACTIVE BUFFER user does not count ─────────────
  it('(g) only ACTIVE users with roleId BUFFER count: closed / look-alike accounts are ignored, one active account is enough', async () => {
    const rec = await hashPassword(PASS);
    const add = (id, username, roleId, status, level = 2) => sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,'',?,'ALL','[\"ALL\"]',?,?,?,?,?,?,?,?)")
      .run(id, username, username, roleId, roleId, level, status, rec.hash, rec.salt, rec.algo, rec.iterations);
    setBuffer('INACTIVE');
    add('U-BF3', 'su3', 'BUFFER_X', 'ACTIVE'); // look-alike roleId
    add('U-BF4', 'su4', 'BUFFER_Y', 'ACTIVE'); // look-alike roleId (the lower-case 'buffer' spelling IS the BUFFER role since M10 hardening : cf_buffer_hardening)
    sdb.prepare("UPDATE users SET title = 'BUFFER', positionKey = 'BUFFER' WHERE id = 'U2'").run(); // a title text is not a role
    let id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    add('U-BF2', 'su2', 'BUFFER', 'INACTIVE');
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.bufferSkipped).toBe(true);
    sdb.prepare("UPDATE users SET status = 'ACTIVE' WHERE id = 'U-BF2'").run();
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
  });

  it('(g) closing the BUFFER account while a PR waits: admin forwards, the reviewer / approver send it back (Q10)', async () => {
    const id = await parked();
    setBuffer('INACTIVE');
    expect((await forward(id)).status).toBe(401); // the closed account itself is out
    expect((await call('adm', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).status).toBe(200);
    expect(row(id).status).toBe('REVIEWED');
  });

  // ───────────── (h) repeated requests are idempotent ─────────────
  it('(h) the reviewer pass twice, and two at once: one status change, one audit row, one notification', async () => {
    const id = await submitted();
    const [a, b] = await Promise.all([call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' }), call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.json.status, b.json.status]).toEqual(['PENDING_BUFFER', 'PENDING_BUFFER']);
    const again = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' }); // sequential resend (the first response was lost)
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('PENDING_BUFFER');
    const again2 = await call('asst', 'POST', '/api/prs', { id, status: 'REVIEWED' });
    expect(again2.status).toBe(200);
    expect(again2.json.status).toBe('PENDING_BUFFER');
    expect(row(id).status).toBe('PENDING_BUFFER');
    expect(audits(id, 'REVIEW_FORWARD')).toHaveLength(1);
    expect(notifs('PR_PENDING_BUFFER')).toHaveLength(1);
    expect(extraOf(id).approvalHistory.filter((h) => h.action === 'REVIEWED')).toHaveLength(1);
  });

  it('(h) the BUFFER forward twice (and two at once): one BUFFER_FORWARD row, one Approver notification, stamps of the first', async () => {
    const id = await parked();
    const [a, b] = await Promise.all([forward(id, { bufferComment: 'first' }), forward(id, { bufferComment: 'first' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const stamp = extraOf(id).bufferReviewedAt;
    const again = await forward(id, { bufferComment: 'second' });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('REVIEWED');
    expect(audits(id, 'BUFFER_FORWARD')).toHaveLength(1);
    expect(notifs('PR_SUBMITTED').filter((q) => q.title === 'PR ผ่านการตรวจสอบจัดซื้อ รออนุมัติ')).toHaveLength(1);
    expect(extraOf(id)).toMatchObject({ bufferComment: 'first', bufferReviewedAt: stamp });
    expect(extraOf(id).approvalHistory.filter((h) => h.action === 'BUFFER_REVIEWED')).toHaveLength(1);
  });

  it('(h) the reviewer cannot forward a PR that waits at the BUFFER by sending REVIEWED again: it stays PENDING_BUFFER (no-op, not a skip)', async () => {
    const id = await parked();
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.json.status).toBe('PENDING_BUFFER');
    expect(row(id).status).toBe('PENDING_BUFFER');
    expect(extraOf(id).bufferReviewedBy).toBeUndefined();
    // the approver and the requester get a plain 403 for the same request
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).status).toBe(403);
    expect((await call('req', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).status).toBe(403);
  });

  // ───────────── (i) user upsert / formatSafeUser for the BUFFER role ─────────────
  it('(i) upsert of a BUFFER user: level 2 and the fixed flags, whatever the body asks (create and update) ; other roles are untouched', async () => {
    const body = { id: 'U-BF9', username: 'su9', name: 'Su Nine', department: 'PD', allowedDepartments: ['PD'], roleId: 'BUFFER', canonicalRole: 'APPROVER', level: 3, password: 'Abcdef123!',
      canReview: true, canFinalApprove: true, canSetBudget: true, canOnlinePurchase: true, canViewAllDepts: false, canViewBudget: true,
      canManageMaster: true, canDeleteMaster: true };
    const c = await call('adm', 'POST', '/api/users', body);
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ roleId: 'BUFFER', canonicalRole: 'BUFFER', level: 2, isAdmin: false, isApprover: false, isReviewer: false, canReview: false, canFinalApprove: false, canSetBudget: false, canOnlinePurchase: false, canViewAllDepts: true, canManageMaster: false, canDeleteMaster: false });
    expect(c.json.permissions).toMatchObject({ REVIEW: false, APPROVAL: false, ADMIN: false });
    expect({ ...sdb.prepare('SELECT level, canonicalRole, canReview, canFinalApprove, canSetBudget, canOnlinePurchase, canViewAllDepts, canManageMaster, canDeleteMaster FROM users WHERE id = ?').get('U-BF9') })
      .toEqual({ level: 2, canonicalRole: 'BUFFER', canReview: 0, canFinalApprove: 0, canSetBudget: 0, canOnlinePurchase: 0, canViewAllDepts: 1, canManageMaster: 0, canDeleteMaster: 0 });
    // an update (even to level 99 / canReview / canManageMaster) cannot lift it
    const u = await call('adm', 'PUT', '/api/users/U-BF9', { ...body, name: 'Su Nine B', level: 99 });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ level: 2, isAdmin: false, canReview: false, canFinalApprove: false, canManageMaster: false, canDeleteMaster: false });
    expect(sdb.prepare('SELECT level, name FROM users WHERE id = ?').get('U-BF9')).toMatchObject({ level: 2, name: 'Su Nine B' });
    // changing the role away from BUFFER gives the normal rules back
    const o = await call('adm', 'PUT', '/api/users/U-BF9', { id: 'U-BF9', username: 'su9', name: 'Su Nine', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 });
    expect(o.json).toMatchObject({ roleId: 'ASST_MANAGER', level: 2, canReview: true, isReviewer: true });
    // a plain reviewer is unchanged
    expect(safe.asst).toMatchObject({ level: 2, isReviewer: true });
  });

  it('(i) the login / bootstrap user of the BUFFER account: level 2, not a reviewer / approver / budget writer, sees every department', async () => {
    expect(safe.su).toMatchObject({ roleId: 'BUFFER', canonicalRole: 'BUFFER', level: 2, isAdmin: false, isApprover: false, isReviewer: false, isOnline: false,
      canReview: false, canFinalApprove: false, canSetBudget: false, canOnlinePurchase: false, canViewAllDepts: true, canManageMaster: false, canDeleteMaster: false });
    const boot = (await call('su', 'GET', '/api/bootstrap')).json;
    expect(boot.users.find((q) => q.id === 'U-BF')).toMatchObject({ level: 2, isReviewer: false, canReview: false });
    // stored flags / title text cannot turn it into a reviewer or an online purchaser, nor give it master-data write rights
    sdb.prepare("UPDATE users SET canReview = 1, canFinalApprove = 1, canSetBudget = 1, canOnlinePurchase = 1, canManageMaster = 1, canDeleteMaster = 1, title = 'ONLINE_PURCHASER APPROVER REVIEWER', level = 3 WHERE id = 'U-BF'").run();
    const me = (await call('su', 'GET', '/api/me')).json;
    expect(me.user).toMatchObject({ level: 2, isApprover: false, isReviewer: false, isOnline: false, canReview: false, canFinalApprove: false, canSetBudget: false, canOnlinePurchase: false, canManageMaster: false, canDeleteMaster: false });
    // and the master-data write routes stay closed to it (read still open)
    expect((await call('su', 'POST', '/api/products', { id: 'P-BF', code: 'P-BF', name: 'x' })).status).toBe(403);
    expect((await call('su', 'GET', '/api/products')).status).toBe(200);
  });
});
