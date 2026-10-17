// @vitest-environment node
// QA (prae) for Phase 3 / M10 T2+T3 (FR-01 BUFFER "พี่สุ", status PENDING_BUFFER) : edge cases NOT covered by cf_buffer_rbac / cf_buffer_flow.
// Same harness as tests/cf_buffer_flow.test.js (real onRequest + in-memory node:sqlite D1). Test file only - no production code is touched.
//
// Tests tagged [SPEC GAP] assert the behaviour the spec asks for and are EXPECTED TO FAIL while the bug listed in the QA report is open.
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

d('QA BUFFER step - extra edge cases (M10 T2+T3)', () => {
  let sdb; let env; const tok = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => ({ ...sdb.prepare('SELECT * FROM prs WHERE id = ?').get(id) });
  const extraOf = (id) => JSON.parse(row(id).extraJson || '{}');
  const itemsOf = (id) => JSON.parse(row(id).itemsJson || '[]');
  const audits = (id, action) => sdb.prepare('SELECT * FROM audit_logs WHERE entityType = ? AND entityId = ? AND action = ? ORDER BY rowid').all('pr', id, action).map((r) => ({ ...r, details: JSON.parse(r.details || '{}') }));
  const notifs = (type) => sdb.prepare('SELECT * FROM notifications WHERE type = ? ORDER BY rowid').all(type).map((r) => ({ ...r }));
  const commitments = () => sdb.prepare("SELECT amount FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").all().map((r) => ({ ...r }));
  const setBuffer = (status) => sdb.prepare("UPDATE users SET status = ? WHERE roleId = 'BUFFER'").run(status);
  let n = 0;
  const submitted = async (over = {}) => {
    n += 1;
    const id = over.id || `PR-Q${n}`;
    const r = await call('req', 'POST', '/api/prs', { id, prNo: `PD${String(n).padStart(3, '0')}/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN(), ...over });
    expect(r.status, 'create').toBe(200);
    return id;
  };
  const parked = async (over = {}) => {
    const id = await submitted(over);
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.status, 'review').toBe(200);
    expect(r.json.status).toBe('PENDING_BUFFER');
    return id;
  };
  const forward = (id, over = {}) => call('su', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', ...over });
  const pend = (id) => expect(row(id).status).toBe('PENDING_BUFFER');

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
      tok[username] = (await r.json()).token;
    }
    n = 0;
  });

  // ───────────── (1) closing / re-roling the BUFFER account through the real user API ends the step (Q1 / Q10) ─────────────
  it('Q1: DELETE /api/users (soft delete) of the only BUFFER user -> the next reviewer pass skips the step ; the PR parked before is forwarded by admin', async () => {
    const waiting = await parked();
    expect((await call('adm', 'DELETE', '/api/users/U-BF')).status).toBe(200);
    const id = await submitted();
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.json).toMatchObject({ success: true, status: 'REVIEWED', bufferSkipped: true });
    expect(audits(id, 'REVIEW_FORWARD')[0].details.comment).toBe('ตรวจสอบผ่าน ส่งต่อ Plant Mgr');
    // the old one is still parked (Q10) ; admin forwards in the account's place
    pend(waiting);
    expect((await call('adm', 'PUT', `/api/prs/${waiting}`, { status: 'REVIEWED', bufferComment: 'ปิดบัญชี' })).status).toBe(200);
    expect(row(waiting).status).toBe('REVIEWED');
  });

  it('Q1: changing the role of the only BUFFER user to a reviewer role (PUT /api/users) stops counting him', async () => {
    const u = await call('adm', 'PUT', '/api/users/U-BF', { id: 'U-BF', username: 'su', name: 'Su Buffer', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 });
    expect(u.status).toBe(200);
    const id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
  });

  it('Q1: every BUFFER account INACTIVE + reviewer asks PENDING_BUFFER on POST and on a batch -> REVIEWED, bufferSkipped on each', async () => {
    setBuffer('INACTIVE');
    const a = await submitted(); const b = await submitted();
    const one = await call('asst', 'POST', '/api/prs', { id: a, status: 'PENDING_BUFFER' });
    expect(one.json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    const batch = await call('asst', 'POST', '/api/prs', [{ id: b, status: 'PENDING_BUFFER' }]);
    expect(batch.json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    expect(notifs('PR_PENDING_BUFFER')).toHaveLength(0);
  });

  // ───────────── (2) forward after the PR has moved on / by admin ─────────────
  it('the BUFFER cannot forward (or edit) a PR once it is REVIEWED / APPROVED : 403 and nothing changes', async () => {
    const id = await parked();
    expect((await forward(id)).status).toBe(200);
    const rowAfter = row(id);
    // already REVIEWED : sending REVIEWED again is a no-op (same status) but a content edit is refused
    expect((await forward(id)).status).toBe(200);
    expect((await forward(id, { items: [LINE({ qty: 9, purchaseQty: 9 }), LINES()[1]], totalAmount: 950 })).status).toBe(403);
    expect(row(id).itemsJson).toBe(rowAfter.itemsJson);
    expect(audits(id, 'BUFFER_FORWARD')).toHaveLength(1);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect((await forward(id)).status).toBe(403); // APPROVED -> REVIEWED
    expect(row(id).status).toBe('APPROVED');
  });

  it('admin forwards in the BUFFER\'s place: stamps / audit actor are the admin\'s (token), the reviewer\'s stamps stay', async () => {
    const id = await parked();
    const before = extraOf(id).reviewedBy;
    const r = await call('adm', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.status).toBe(200);
    expect(extraOf(id)).toMatchObject({ bufferReviewedBy: 'Admin', bufferReviewedById: 'U9', reviewerName: 'Asst PD' });
    expect(extraOf(id).reviewedBy).toEqual(before);
    const a = audits(id, 'BUFFER_FORWARD');
    expect(a).toHaveLength(1);
    expect(a[0].performedBy).toBe('U9');
    expect(a[0].details.comment).toContain('ผู้ตรวจสอบจัดซื้อส่งต่อผู้อนุมัติ');
    expect(a[0].details.changes).toEqual([]);
  });

  it('bufferComment that is not a string is ignored (no stored value, no crash)', async () => {
    const id = await parked();
    const r = await forward(id, { bufferComment: { a: 1 } });
    expect(r.status).toBe(200);
    expect(extraOf(id).bufferComment).toBeUndefined();
    expect(extraOf(id).bufferReviewedBy).toBe('Su Buffer');
  });

  // ───────────── (3) links ─────────────
  it('links: scheme variants that must be refused (case, whitespace, tab inside, protocol-relative, file, vbscript, empty host) -> 400, PR untouched', async () => {
    const id = await parked();
    const before = row(id);
    const bad = ['JavaScript:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', '//evil.example/x', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'https://', 'data:text/html;base64,AAAA', 'blob:https://x.example/1', 'mailto:a@b.c'];
    for (const url of bad) {
      for (const key of ['productUrl', 'onlineUrl']) {
        const r = await forward(id, { items: [LINE({ [key]: url }), LINES()[1]], totalAmount: 250 });
        expect(r.status, `${key} ${JSON.stringify(url)}`).toBe(400);
      }
    }
    // the same on the 2nd line (index 1)
    expect((await forward(id, { items: [LINES()[0], { ...LINES()[1], productUrl: 'javascript:alert(1)' }], totalAmount: 250 })).status).toBe(400);
    expect(row(id).itemsJson).toBe(before.itemsJson);
    pend(id);
  });

  it('links: http / https with query + fragment are accepted (200) and stored', async () => {
    const id = await parked();
    const r = await forward(id, { items: [LINE({ productUrl: 'http://shop.example/a?x=1&y=2#frag' }), { ...LINES()[1], productUrl: 'https://shop.example/ink' }], totalAmount: 250 });
    expect(r.status).toBe(200);
    expect(itemsOf(id)[0].productUrl).toContain('shop.example/a?x=1');
    expect(itemsOf(id)[1].productUrl).toContain('shop.example/ink');
    expect(row(id).status).toBe('REVIEWED');
  });

  // ───────────── (4) totals ─────────────
  it('totals: off by 0.02 (either side), by a whole unit, NaN / Infinity / text -> 400 ; financials.grandTotal off by 0.02 -> 400 ; nothing written', async () => {
    const id = await parked();
    const before = row(id);
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]]; // 350
    for (const t of [350.02, 349.98, 351, 349, 'abc', 'Infinity', '1e999']) {
      expect((await forward(id, { items, totalAmount: t })).status, `total ${t}`).toBe(400);
    }
    expect((await forward(id, { items, totalAmount: 350, financials: FIN({ subtotal: 350, grandTotal: 350.02 }) })).status).toBe(400);
    expect((await forward(id, { items, totalAmount: 350, financials: FIN({ subtotal: 350, grandTotal: 'x' }) })).status).toBe(400);
    expect(row(id).itemsJson).toBe(before.itemsJson);
    expect(row(id).totalAmount).toBe(250);
    pend(id);
  });

  it('totals: absurd qty / price are refused (400) ; decimals are computed (2.5 x 100.10 + 50 = 300.25)', async () => {
    const id = await parked();
    expect((await forward(id, { items: [LINE({ qty: 1e12, purchaseQty: 1e12 }), LINES()[1]], totalAmount: 1 })).status).toBe(400);
    expect((await forward(id, { items: [LINE({ price: 1e10 }), LINES()[1]], totalAmount: 1 })).status).toBe(400);
    const id2 = await parked();
    const r = await forward(id2, { items: [LINE({ qty: 2.5, purchaseQty: 2.5, price: 100.1 }), LINES()[1]], totalAmount: 300.25 });
    expect(r.status).toBe(200);
    expect(row(id2).totalAmount).toBe(300.25);
    expect(itemsOf(id2)[0]).toMatchObject({ qty: 2.5, purchaseQty: 2.5, price: 100.1 });
  });

  // ───────────── (5) POST parity of the BUFFER edit ─────────────
  it('POST /api/prs: the BUFFER edit + forward goes through the same checks as PUT (200 / 400 / 403) and an invalid batch member writes nothing', async () => {
    const id = await parked();
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]];
    expect((await call('su', 'POST', '/api/prs', { id, status: 'REVIEWED', items, totalAmount: 999 })).status).toBe(400);
    expect((await call('su', 'POST', '/api/prs', { id, status: 'REVIEWED', items: [LINE({ productUrl: 'javascript:alert(1)' }), LINES()[1]], totalAmount: 250 })).status).toBe(400);
    expect((await call('asst', 'POST', '/api/prs', { id, items, totalAmount: 350 })).status).toBe(403); // the reviewer cannot edit here
    pend(id);
    const ok = await call('su', 'POST', '/api/prs', { id, status: 'REVIEWED', items, totalAmount: 350, bufferComment: 'via post' });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('REVIEWED');
    expect(row(id).totalAmount).toBe(350);
    expect(extraOf(id)).toMatchObject({ bufferReviewedBy: 'Su Buffer', bufferComment: 'via post', reviewerName: 'Asst PD' });
    expect(audits(id, 'BUFFER_FORWARD')[0].details.changes).toEqual([{ index: 0, productId: 'P1', name: 'Pen', field: 'qty', before: 2, after: 3 }]);
    // batch : the 2nd member is invalid -> 400 and the 1st is NOT forwarded
    const a = await parked(); const b = await parked();
    const r = await call('su', 'POST', '/api/prs', [{ id: a, status: 'REVIEWED', bufferComment: 'x' }, { id: b, status: 'REVIEWED', items: [LINE({ productUrl: 'javascript:alert(1)' }), LINES()[1]], totalAmount: 250 }]);
    expect(r.status).toBe(400);
    pend(a); pend(b);
    expect(audits(a, 'BUFFER_FORWARD')).toHaveLength(0);
  });

  // ───────────── (6) another department : the BUFFER reads it, edits nothing outside PENDING_BUFFER ─────────────
  it('BUFFER reads a QC PR (every department) but cannot change qty / total / status of it at SUBMITTED ; the PD requester does not see it', async () => {
    n += 1;
    const id = 'PR-QC1';
    const c = await call('adm', 'POST', '/api/prs', { id, prNo: `QC00${n}/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN() });
    expect(c.status).toBe(200);
    expect((await call('su', 'GET', '/api/prs')).json.some((q) => q.id === id)).toBe(true);
    expect((await call('req', 'GET', '/api/prs')).json.some((q) => q.id === id)).toBe(false);
    const before = row(id);
    const items = [LINE({ qty: 5, purchaseQty: 5 }), LINES()[1]];
    expect((await call('su', 'PUT', `/api/prs/${id}`, { items, totalAmount: 550 })).status).toBe(403);
    expect((await call('su', 'PUT', `/api/prs/${id}`, { totalAmount: 1 })).status).toBe(403);
    expect((await call('su', 'POST', '/api/prs', { id, items, totalAmount: 550 })).status).toBe(403);
    for (const s of ['REVIEWED', 'PENDING_BUFFER', 'CANCELLED', 'REJECTED_TO_DRAFT', 'APPROVED']) {
      expect((await call('su', 'PUT', `/api/prs/${id}`, { status: s })).status, s).toBe(403);
    }
    expect(row(id).status).toBe('SUBMITTED');
    expect(row(id).itemsJson).toBe(before.itemsJson);
    expect(row(id).totalAmount).toBe(250);
  });

  it('[SPEC GAP] BUFFER changing only a product LINK of another department\'s SUBMITTED PR must be refused (Q9: edits only at PENDING_BUFFER)', async () => {
    n += 1;
    const id = 'PR-QC2';
    expect((await call('adm', 'POST', '/api/prs', { id, prNo: `QC00${n}/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN() })).status).toBe(200);
    const r = await call('su', 'PUT', `/api/prs/${id}`, { items: [LINE({ productUrl: 'https://evil.example/' }), LINES()[1]], totalAmount: 250 });
    expect(r.status).toBe(403);
    expect(itemsOf(id)[0].productUrl).toBe('https://shop.example/pen');
  });

  // ───────────── (7) integrity of the other line fields at PENDING_BUFFER ─────────────
  it('[SPEC GAP] BUFFER cannot move a line DISCOUNT (only qty / price / link are his): a changed discountAmount is refused or ignored, never stored', async () => {
    const id = await parked({ totalAmount: 230, financials: undefined, items: [LINE({ discountAmount: 20 }), LINES()[1]] });
    const r = await forward(id, { items: [LINE({ qty: 3, purchaseQty: 3, discountAmount: 500 }), LINES()[1]], totalAmount: 330 });
    expect([200, 400, 403]).toContain(r.status);
    if (r.status === 200) expect(itemsOf(id)[0].discountAmount).toBe(20);
    else pend(id);
  });

  // ───────────── (8) audit / timeline forging ─────────────
  it('a client cannot write a BUFFER_FORWARD audit row (POST /api/audit-logs, any case / padding / entityType pr) nor a timeline entry with an audit id', async () => {
    const id = await parked();
    for (const body of [
      { action: 'BUFFER_FORWARD', entityType: 'pr', entityId: id },
      { action: ' buffer_forward ', entityType: 'audit', entityId: id },
      { action: 'WHATEVER', entityType: 'PR', entityId: id },
      { action: 'WHATEVER', docType: 'pr', entityId: id }
    ]) {
      for (const who of ['req', 'su', 'asst', 'pm']) expect((await call(who, 'POST', '/api/audit-logs', body)).status, `${who} ${JSON.stringify(body)}`).toBe(400);
    }
    // a batch with one innocent row and one forged row is refused as a whole
    expect((await call('req', 'POST', '/api/audit-logs', [{ action: 'VIEW', entityType: 'user', entityId: 'x' }, { action: 'BUFFER_FORWARD', entityType: 'pr', entityId: id }])).status).toBe(400);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE UPPER(TRIM(action)) = 'BUFFER_FORWARD'").get().c).toBe(0);
    // timeline entry carrying an audit id is dropped before the merge
    const forged = { id: 'AL-999-forged', action: 'BUFFER_FORWARD', actorName: 'Mallory', comment: 'forged-by-client' };
    expect((await call('req', 'PUT', `/api/prs/${id}`, { timeline: [forged] })).status).toBe(200);
    const pr = (await call('pm', 'GET', '/api/prs')).json.find((q) => q.id === id);
    expect(pr.timeline.some((e) => e.id === 'AL-999-forged' || e.comment === 'forged-by-client' || e.actorName === 'Mallory')).toBe(false);
    pend(id);
  });

  it('send-back at the BUFFER by the reviewer: SEND_BACK audit + PR_REJECTED notification, no BUFFER stamps, the BUFFER cannot pick the PR up afterwards', async () => {
    const id = await parked();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REJECTED_TO_DRAFT', rejectReason: 'ราคาไม่ตรง' })).status).toBe(200);
    expect(audits(id, 'SEND_BACK')).toHaveLength(1);
    expect(notifs('PR_REJECTED')).toHaveLength(1);
    expect(extraOf(id).bufferReviewedBy).toBeUndefined();
    expect((await forward(id)).status).toBe(403); // REJECTED_TO_DRAFT -> REVIEWED
    expect(row(id).status).toBe('REJECTED_TO_DRAFT');
  });

  // ───────────── (9) Q7 : budget + reads ─────────────
  it('Q7: the BUFFER cannot allocate / reset / adjust / PUT a department budget (403) but reads budgets, PRs, POs and stock logs', async () => {
    expect((await call('su', 'POST', '/api/budgets/allocate', { period: '2026-10', allocations: { PD: 5 } })).status).toBe(403);
    expect((await call('su', 'POST', '/api/budgets/reset', { period: '2026-10' })).status).toBe(403);
    expect((await call('su', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 100 })).status).toBe(403);
    expect((await call('su', 'PUT', '/api/budgets/PD', { spent: 0 })).status).toBe(403);
    for (const p of ['/api/budgets', '/api/prs', '/api/pos', '/api/stock-logs', '/api/bootstrap']) expect((await call('su', 'GET', p)).status, p).toBe(200);
  });

  // ───────────── (10) regression : an old PR that is already REVIEWED ─────────────
  it('regression: a PR already REVIEWED (created before BUFFER existed) is approved once, ledger written once, even when approved twice ; the reviewer cannot push it back to the BUFFER', async () => {
    const id = await submitted();
    sdb.prepare("UPDATE prs SET status = 'REVIEWED' WHERE id = ?").run(id); // legacy row: no buffer stamps
    const again = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(again.status).toBe(200);
    expect(again.json.bufferSkipped).toBeUndefined();
    expect(row(id).status).toBe('REVIEWED');
    expect(notifs('PR_PENDING_BUFFER')).toHaveLength(0);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(row(id).status).toBe('APPROVED');
    expect(commitments()).toEqual([{ amount: -250 }]);
    expect(extraOf(id).bufferReviewedBy).toBeUndefined();
    // legacy REVIEWED can still be sent back by the approver
    const id2 = await submitted();
    sdb.prepare("UPDATE prs SET status = 'REVIEWED' WHERE id = ?").run(id2);
    expect((await call('pm', 'PUT', `/api/prs/${id2}`, { status: 'REJECTED_TO_L2' })).status).toBe(200);
  });
});
