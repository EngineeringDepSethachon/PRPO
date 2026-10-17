// @vitest-environment node
// kla-security round 2 on the PR write routes (POST /api/prs upsert, PUT /api/prs/:id) : real onRequest + in-memory node:sqlite D1, same harness as cf_buffer_hardening.test.js.
//  1. `items` that is not an array of objects is a 400 (any role, any status) - it used to skip every lock and be written as JSON
//  2. a total / grandTotal that is not a finite number >= 0 is a 400 (it used to compare as "no change" and be stored as NULL)
//  3. the BUFFER at PENDING_BUFFER writes only its allow-list into another department's PR (reason / attachments locked, nothing else reaches the row)
//  4. the amounts are the server's : total + financials computed from the lines, limits on the financials, grandTotal never below 0
//  5. the BUFFER cannot nibble the total 0.01 at a time ;  6. the top-level financial keys never reach extraJson
//  7. regression : reviewer edits, the real PRCreateView payload through every step, ONLINE PRs, unchanged echoes
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const LINES = () => [LINE(), LINE({ productId: 'P2', code: 'C2', name: 'Ink', qty: 1, purchaseQty: 1, price: 50, productUrl: '' })]; // 200 + 50 = 250
const FIN = (over = {}) => ({ subtotal: 250, itemDiscountTotal: 0, combinedDiscountType: 'fixed', combinedDiscountValue: 0, combinedDiscountAmount: 0, totalDiscount: 0, vatMode: 'NONE', vatAmount: 0, roundingAdj: 0, shippingCost: 0, grandTotal: 250, ...over });
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const d = DatabaseSync ? describe : describe.skip;

d('PR write hardening (kla round 2)', () => {
  vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 }); // the loops over every role x status x bad value run many requests (slow when the whole suite runs in parallel)
  let sdb; let env; const tok = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // the raw JSON text is sent as it is (1e999 parses to Infinity on the server ; JSON.stringify would turn it into null)
  const callRaw = async (who, method, p, text) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: text }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => ({ ...sdb.prepare('SELECT * FROM prs WHERE id = ?').get(id) });
  const extraOf = (id) => JSON.parse(row(id).extraJson || '{}');
  const itemsOf = (id) => JSON.parse(row(id).itemsJson || '[]');
  const commitments = () => sdb.prepare("SELECT amount FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").all().map((r) => ({ ...r }));
  const setStatus = (id, s) => sdb.prepare('UPDATE prs SET status = ? WHERE id = ?').run(s, id);
  let n = 0;
  const body = (over = {}) => {
    n += 1;
    return { id: `PR-W${n}`, prNo: `PD${String(n).padStart(3, '0')}/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 250, reason: 'need pens', purchaseChannel: 'SELF', items: LINES(), financials: FIN(), ...over };
  };
  const create = async (over = {}, who = 'req') => {
    const b = body(over);
    const r = await call(who, 'POST', '/api/prs', b);
    expect(r.status, `create ${JSON.stringify(r.json)}`).toBe(200);
    return b.id;
  };
  const parked = async (over = {}) => {
    const id = await create(over);
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' });
    expect(r.json.status).toBe('PENDING_BUFFER');
    return id;
  };

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

  // ───────────── 1. items must be an array of objects ─────────────
  const BAD_ITEMS = [{ '0': { productId: 'P1', qty: 1, price: 1 } }, 'x', 5, true, [1], ['x'], [null], [[]], [{ productId: 'P1', qty: 2, price: 100 }, 'x']];

  it('items that is not an array of objects is a 400 on POST (new PR and upsert) and PUT, in every status, for every role - nothing is written', async () => {
    const id = await create();
    const before = JSON.stringify(row(id));
    for (const status of ['DRAFT', 'SUBMITTED', 'REVIEWED', 'PENDING_BUFFER', 'APPROVED', 'PO_ISSUED']) {
      setStatus(id, status);
      const snap = JSON.stringify(row(id));
      for (const who of ['req', 'asst', 'su', 'pm', 'adm']) {
        for (const items of BAD_ITEMS) {
          const put = await call(who, 'PUT', `/api/prs/${id}`, { items });
          expect(put.status, `PUT ${who} ${status} ${JSON.stringify(items)}`).toBe(400);
          const post = await call(who, 'POST', '/api/prs', { id, department: 'PD', items });
          expect(post.status, `POST ${who} ${status} ${JSON.stringify(items)}`).toBe(400);
        }
      }
      expect(JSON.stringify(row(id)), `row untouched at ${status}`).toBe(snap);
    }
    setStatus(id, 'SUBMITTED');
    expect(JSON.stringify(row(id))).toBe(before);
    // a NEW PR with a bad items is refused too (and not created)
    for (const items of BAD_ITEMS) {
      const r = await call('req', 'POST', '/api/prs', body({ id: `PR-NEWBAD-${Math.abs(JSON.stringify(items).length)}-${n}`, items }));
      expect(r.status, JSON.stringify(items)).toBe(400);
    }
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c).toBe(1);
  });

  it('the attack that used to work : an object as items on an APPROVED PR (reviewer / approver) and on a PR at PENDING_BUFFER (BUFFER) no longer rewrites the lines', async () => {
    const id = await create();
    setStatus(id, 'APPROVED');
    expect((await call('req', 'PUT', `/api/prs/${id}`, { items: { 0: { productId: 'P1', qty: 1, price: 1 } }, totalAmount: 250 })).status).toBe(400);
    expect(itemsOf(id)).toHaveLength(2);
    setStatus(id, 'PENDING_BUFFER');
    expect((await call('su', 'PUT', `/api/prs/${id}`, { items: 'free text into every department' })).status).toBe(400);
    expect(itemsOf(id)).toHaveLength(2);
  });

  // ───────────── 2. totals must be finite numbers >= 0 ─────────────
  it('totalAmount / total / grandTotal that are not finite numbers >= 0 are a 400 on POST and PUT, in every status, for every role', async () => {
    const id = await create();
    const BAD = ['"abc"', '"NaN"', '"Infinity"', '"-Infinity"', '-1', '-0.01', '1e999', '-1e999', '[]', '{}', 'true', '[5]'];
    for (const status of ['DRAFT', 'SUBMITTED', 'REVIEWED', 'PENDING_BUFFER', 'APPROVED']) {
      setStatus(id, status);
      const snap = JSON.stringify(row(id));
      for (const key of ['totalAmount', 'total', 'grandTotal']) {
        for (const v of BAD) {
          for (const who of ['req', 'asst', 'su', 'pm', 'adm']) {
            const put = await callRaw(who, 'PUT', `/api/prs/${id}`, `{"${key}":${v}}`);
            expect(put.status, `PUT ${who} ${status} ${key}=${v}`).toBe(400);
          }
          const post = await callRaw('pm', 'POST', '/api/prs', `{"id":"${id}","department":"PD","${key}":${v}}`);
          expect(post.status, `POST ${status} ${key}=${v}`).toBe(400);
        }
      }
      expect(JSON.stringify(row(id)), `row untouched at ${status}`).toBe(snap);
    }
    // a new PR with a bad total is refused, not stored with NULL
    for (const v of BAD) {
      const r = await callRaw('req', 'POST', '/api/prs', `{"id":"PR-NEWT-${v.length}","department":"PD","status":"SUBMITTED","totalAmount":${v},"items":${JSON.stringify(LINES())}}`);
      expect(r.status, v).toBe(400);
    }
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c).toBe(1);
  });

  it('a NaN total can no longer slip past the content lock : an approver at APPROVED cannot zero the budget commitment path (400, commitment unchanged)', async () => {
    const id = await create();
    setStatus(id, 'REVIEWED');
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED', totalAmount: 'abc' })).status).toBe(400);
    expect(row(id).status).toBe('REVIEWED');
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(row(id).totalAmount).toBe(250);
    expect(commitments().map((c) => c.amount)).toEqual([-250]);
  });

  // ───────────── 3. the BUFFER's allow-list at PENDING_BUFFER ─────────────
  describe('BUFFER allow-list (another department\'s PR)', () => {
    const seedQc = async () => {
      const id = 'PR-QC-W';
      const r = await call('adm', 'POST', '/api/prs', {
        id, prNo: `QC001/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, reason: 'qc reason', purchaseChannel: 'SELF', items: LINES(), financials: FIN(),
        attachments: [{ id: 'ATT-1', name: 'quote.pdf', url: 'https://files.example/quote.pdf' }], approvalWorkflow: { level: 'L2' }, note: 'original note', specUrl: 'https://spec.example/a'
      });
      expect(r.status).toBe(200);
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { status: 'PENDING_BUFFER' })).status).toBe(200);
      expect(row(id).status).toBe('PENDING_BUFFER');
      return id;
    };
    const snapshot = (id) => { const r = row(id); return { reason: r.reason, purchaseChannel: r.purchaseChannel, poNumber: r.poNumber, attachmentsJson: r.attachmentsJson, approvalWorkflowJson: r.approvalWorkflowJson, extra: JSON.parse(r.extraJson || '{}'), totalAmount: r.totalAmount }; };

    it('PUT : purchaseChannel / poNumber / approvalWorkflow / extra keys are dropped - the stored values stay (status -> REVIEWED still works)', async () => {
      const id = await seedQc();
      const before = snapshot(id);
      const r = await call('su', 'PUT', `/api/prs/${id}`, {
        status: 'REVIEWED', purchaseChannel: 'ONLINE', poNumber: 'PO-HACK', approvalWorkflow: { level: 'NONE', skip: true },
        note: 'hacked note', specUrl: 'https://evil.example/', injected: 'x', requestedBy: 'Somebody', vendorId: 'V-EVIL', memo: { forged: true }, department: 'PD'
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const after = snapshot(id);
      expect(after.purchaseChannel).toBe(before.purchaseChannel);
      expect(after.poNumber).toBe(before.poNumber);
      expect(after.approvalWorkflowJson).toBe(before.approvalWorkflowJson);
      expect(after.reason).toBe(before.reason);
      expect(after.attachmentsJson).toBe(before.attachmentsJson);
      const x = after.extra;
      expect(x.injected).toBeUndefined(); expect(x.vendorId).toBeUndefined(); expect(x.memo).toBeUndefined();
      expect(x.specUrl).toBe('https://spec.example/a');
      expect(x.note).toBe('original note');
      expect(x.requestedBy).toBe(before.extra.requestedBy);
      expect(row(id).department).toBe('QC');
      expect(row(id).status).toBe('REVIEWED');
    });

    it('PUT : the same attack WITHOUT a status change leaves the row as it was', async () => {
      const id = await seedQc();
      const before = snapshot(id);
      const r = await call('su', 'PUT', `/api/prs/${id}`, { purchaseChannel: 'ONLINE', poNumber: 'PO-HACK', approvalWorkflow: { x: 1 }, injected: 'x', note: 'n' });
      expect(r.status).toBe(200);
      expect(snapshot(id)).toEqual(before);
      expect(row(id).status).toBe('PENDING_BUFFER');
    });

    it('a different reason / purpose, or attachments that are not the stored ones, are a 403 (like the other roles) - nothing is written', async () => {
      const id = await seedQc();
      const before = snapshot(id);
      for (const b of [
        { reason: 'rewritten' }, { purpose: 'rewritten' }, { attachments: [{ id: 'ATT-X', name: 'evil.exe', url: 'https://evil.example/x' }] },
        { attachments: [] }, { attachments: [{ id: 'ATT-1', name: 'quote.pdf', url: 'https://files.example/quote.pdf' }, { id: 'ATT-2', name: 'more', url: 'https://evil.example/m' }] }
      ]) {
        expect((await call('su', 'PUT', `/api/prs/${id}`, b)).status, JSON.stringify(b)).toBe(403);
        expect((await call('su', 'POST', '/api/prs', { id, ...b })).status, `POST ${JSON.stringify(b)}`).toBe(403);
      }
      expect(snapshot(id)).toEqual(before);
    });

    it('a repeat of the stored reason / attachments is accepted and changes nothing', async () => {
      const id = await seedQc();
      const before = snapshot(id);
      const r = await call('su', 'PUT', `/api/prs/${id}`, { reason: 'qc reason', attachments: [{ id: 'ATT-1', name: 'quote.pdf', url: 'https://files.example/quote.pdf' }] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(snapshot(id)).toEqual(before);
    });

    it('POST (upsert) without a reason does not blank it ; purchaseChannel / poNumber / extra keys of the body are dropped there too', async () => {
      const id = await seedQc();
      const before = snapshot(id);
      const r = await call('su', 'POST', '/api/prs', { id, status: 'REVIEWED', purchaseChannel: 'ONLINE', poNumber: 'PO-HACK', approvalWorkflow: { x: 1 }, injected: 'x' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const after = snapshot(id);
      expect(after.reason).toBe('qc reason');
      expect(after.purchaseChannel).toBe(before.purchaseChannel);
      expect(after.poNumber).toBe(before.poNumber);
      expect(after.approvalWorkflowJson).toBe(before.approvalWorkflowJson);
      expect(after.attachmentsJson).toBe(before.attachmentsJson);
      expect(after.extra.injected).toBeUndefined();
      expect(row(id).status).toBe('REVIEWED');
    });

    it('what the BUFFER may do still works : qty / price / links, total, status, comment', async () => {
      const id = await seedQc();
      const items = [LINE({ qty: 4, purchaseQty: 4, productUrl: 'https://shop.example/pen2' }), LINES()[1]];
      const r = await call('su', 'PUT', `/api/prs/${id}`, { items, totalAmount: 450, status: 'REVIEWED', bufferComment: 'checked, qty fixed' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(row(id)).toMatchObject({ status: 'REVIEWED', totalAmount: 450 });
      expect(itemsOf(id)[0]).toMatchObject({ qty: 4, purchaseQty: 4, productUrl: 'https://shop.example/pen2' });
      expect(extraOf(id).bufferComment).toBe('checked, qty fixed');
      expect(extraOf(id).financials).toMatchObject({ subtotal: 450, grandTotal: 450 });
    });
  });

  // ───────────── 4. the amounts are the server's ─────────────
  describe('amounts computed by the server', () => {
    it('a requester cannot lower the total below the lines : DRAFT / SUBMITTED, POST (new + upsert) and PUT -> 400, nothing written', async () => {
      for (const st of ['DRAFT', 'SUBMITTED']) {
        const low = await call('req', 'POST', '/api/prs', body({ status: st, totalAmount: 10, financials: FIN({ grandTotal: 10 }) }));
        expect(low.status, `new ${st}`).toBe(400);
        expect(low.json.error || low.json.message || '').toContain('ยอดรวม');
      }
      expect(sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c).toBe(0);
      const id = await create({ status: 'DRAFT' });
      expect((await call('req', 'PUT', `/api/prs/${id}`, { totalAmount: 1 })).status).toBe(400); // lines unchanged, total lowered
      expect((await call('req', 'PUT', `/api/prs/${id}`, { totalAmount: 1, financials: FIN({ grandTotal: 1 }) })).status).toBe(400);
      expect((await call('req', 'POST', '/api/prs', { id, department: 'PD', status: 'DRAFT', totalAmount: 1 })).status).toBe(400);
      const cheap = [LINE({ qty: 1, purchaseQty: 1, price: 1 }), LINES()[1]];
      expect((await call('req', 'PUT', `/api/prs/${id}`, { items: cheap, totalAmount: 250 })).status).toBe(400); // lines cheaper, old total kept up : still not the lines' total
      expect((await call('req', 'PUT', `/api/prs/${id}`, { items: cheap, totalAmount: 51 })).status).toBe(200); // the honest figure
      expect(row(id).totalAmount).toBe(51);
      expect(row(id).itemsJson).toContain('"price":1');
    });

    it('the server writes its OWN figure : a total sent within 0.01 is stored as the computed one ; not sent -> the computed one', async () => {
      const a = await create({ totalAmount: 250.009, financials: FIN({ grandTotal: 250.009 }) });
      expect(row(a).totalAmount).toBe(250);
      expect(extraOf(a).financials).toMatchObject({ subtotal: 250, grandTotal: 250 });
      const b = await create({ totalAmount: undefined, financials: undefined });
      expect(row(b).totalAmount).toBe(250);
      const c = await create({ totalAmount: undefined }); // financials sent, total not
      expect(row(c).totalAmount).toBe(250);
      const e = await create({ totalAmount: undefined, financials: FIN({ vatMode: 'AFTER_DISCOUNT', hasVat: true, grandTotal: undefined }) });
      expect(row(e).totalAmount).toBe(267.5); // 250 + 7% VAT
      expect(extraOf(e).financials).toMatchObject({ vatMode: 'AFTER_DISCOUNT', vatAmount: 17.5, grandTotal: 267.5 });
    });

    it('financials outside the limits are a 400 : discounts, combined discount, shipping, rounding, vat mode, line figures', async () => {
      const bad = [
        ['discountPercent 101', { items: [LINE({ discountPercent: 101 }), LINES()[1]] }],
        ['discountPercent -1', { items: [LINE({ discountPercent: -1 }), LINES()[1]] }],
        ['discountAmount above the line', { items: [LINE({ discountAmount: 201 }), LINES()[1]] }],
        ['discountAmount negative', { items: [LINE({ discountAmount: -5 }), LINES()[1]] }],
        ['discountAmount NaN', { items: [LINE({ discountAmount: 'abc' }), LINES()[1]] }],
        ['price negative', { items: [LINE({ price: -100 }), LINES()[1]] }],
        ['price NaN', { items: [LINE({ price: 'abc' }), LINES()[1]] }],
        ['qty negative', { items: [LINE({ qty: -2, purchaseQty: -2 }), LINES()[1]] }],
        ['qty huge', { items: [LINE({ qty: 1e12, purchaseQty: 1e12 }), LINES()[1]] }],
        ['combined percent 101', { financials: FIN({ combinedDiscountType: 'percent', combinedDiscountValue: 101 }) }],
        ['combined percent -1', { financials: FIN({ combinedDiscountType: 'percent', combinedDiscountValue: -1 }) }],
        ['combined fixed above the subtotal', { financials: FIN({ combinedDiscountType: 'fixed', combinedDiscountValue: 251 }) }],
        ['combined type unknown', { financials: FIN({ combinedDiscountType: 'weird', combinedDiscountValue: 5 }) }],
        ['shipping negative', { financials: FIN({ shippingCost: -5 }) }],
        ['rounding +2', { financials: FIN({ roundingAdj: 2 }) }],
        ['rounding -2', { financials: FIN({ roundingAdj: -2 }) }],
        ['rounding NaN', { financials: FIN({ roundingAdj: 'abc' }) }],
        ['vatMode unknown', { financials: FIN({ vatMode: 'WEIRD' }) }],
        ['financials is not an object', { financials: 'x' }],
        ['financials.grandTotal negative', { financials: FIN({ grandTotal: -5 }) }]
      ];
      for (const [label, over] of bad) {
        const r = await call('req', 'POST', '/api/prs', body({ ...over }));
        expect(r.status, `new : ${label}`).toBe(400);
      }
      expect(sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c).toBe(0);
      const id = await create({ status: 'DRAFT' });
      for (const [label, over] of bad) {
        const r = await call('req', 'PUT', `/api/prs/${id}`, over);
        expect(r.status, `PUT : ${label}`).toBe(400);
      }
      expect(row(id).totalAmount).toBe(250);
      expect(itemsOf(id)[0].price).toBe(100);
    });

    it('the limits hold when somebody else edits : the reviewer at SUBMITTED / REVIEWED and the approver at REVIEWED', async () => {
      const id = await create();
      expect((await call('asst', 'PUT', `/api/prs/${id}`, { financials: FIN({ shippingCost: -50, grandTotal: 200 }), totalAmount: 200 })).status).toBe(400);
      setStatus(id, 'REVIEWED');
      expect((await call('pm', 'PUT', `/api/prs/${id}`, { financials: FIN({ roundingAdj: -9, grandTotal: 241 }), totalAmount: 241 })).status).toBe(400);
      expect((await call('pm', 'PUT', `/api/prs/${id}`, { items: [LINE({ discountPercent: 150 }), LINES()[1]], totalAmount: 0 })).status).toBe(400);
      expect(row(id).totalAmount).toBe(250);
    });

    it('grandTotal is never negative : a discount bigger than the PR gives 0 (a negative total is refused)', async () => {
      const over = {
        items: [LINE({ discountAmount: 200 }), LINE({ productId: 'P2', code: 'C2', name: 'Ink', qty: 1, purchaseQty: 1, price: 50, productUrl: '', discountAmount: 50 })],
        financials: FIN({ vatMode: 'BEFORE_DISCOUNT', hasVat: true, combinedDiscountType: 'fixed', combinedDiscountValue: 250, grandTotal: undefined })
      };
      expect((await call('req', 'POST', '/api/prs', body({ ...over, totalAmount: -232.5 }))).status).toBe(400);
      const id = await create({ ...over, totalAmount: 0 });
      expect(row(id).totalAmount).toBe(0);
      expect(extraOf(id).financials.grandTotal).toBe(0);
      expect(extraOf(id).financials.grandTotal).toBeGreaterThanOrEqual(0);
    });

    it('an admin editing an existing PR is not restricted on the amounts (as before) but the shape still applies', async () => {
      const id = await create();
      setStatus(id, 'APPROVED');
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { totalAmount: 90 })).status).toBe(200);
      expect(row(id).totalAmount).toBe(90);
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { totalAmount: 'abc' })).status).toBe(400);
      expect(row(id).totalAmount).toBe(90);
    });
  });

  // ───────────── 5. the BUFFER cannot nibble the total ─────────────
  it('BUFFER repeating a total 0.005 below the stored one (lines unchanged) never moves it ; a total 0.02 away is a 400', async () => {
    const id = await parked();
    for (let i = 0; i < 5; i += 1) {
      const r = await call('su', 'PUT', `/api/prs/${id}`, { totalAmount: 249.995 });
      expect(r.status, `round ${i}`).toBe(200);
      expect(row(id).totalAmount).toBe(250);
    }
    const viaPost = await call('su', 'POST', '/api/prs', { id, totalAmount: 249.995, status: 'PENDING_BUFFER' });
    expect(viaPost.status).toBe(200);
    expect(row(id).totalAmount).toBe(250);
    expect((await call('su', 'PUT', `/api/prs/${id}`, { totalAmount: 249.98 })).status).toBe(400);
    expect(row(id).totalAmount).toBe(250);
    // and when the BUFFER forwards the PR it hands on the stored figure
    expect((await call('su', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', totalAmount: 250.004 })).status).toBe(200);
    expect(row(id).totalAmount).toBe(250);
    expect(commitments()).toHaveLength(0);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(commitments().map((c) => c.amount)).toEqual([-250]);
  });

  it('a non-owner (the requester) repeating a total 0.004 away at PENDING_BUFFER does not move it either', async () => {
    const id = await parked();
    expect((await call('req', 'PUT', `/api/prs/${id}`, { totalAmount: 250.004 })).status).toBe(200);
    expect(row(id).totalAmount).toBe(250);
  });

  // ───────────── 6. the top-level financial keys ─────────────
  it('vatMode / combinedDiscountType / combinedDiscountValue / roundingAdj / shippingCost / hasVat / subtotal / vat never reach extraJson (POST new, POST upsert, PUT)', async () => {
    const KEYS = { vatMode: 'AFTER_DISCOUNT', combinedDiscountType: 'percent', combinedDiscountValue: 10, roundingAdj: 0.5, shippingCost: 30, hasVat: true, subtotal: 1, vat: 99, vatAmount: 5, grandTotal: 3, itemDiscountTotal: 7, totalDiscount: 8, combinedDiscountAmount: 9 };
    // with these as the settings of a PR whose figures match them, via financials : 250 - 10% = 225 ; +7% = 15.75 ; +0.5 + 30 = 271.25
    const id = await create({ ...KEYS, vatAmount: undefined, grandTotal: undefined, subtotal: undefined, itemDiscountTotal: undefined, totalDiscount: undefined, combinedDiscountAmount: undefined, vat: undefined, financials: undefined, totalAmount: undefined });
    const x = extraOf(id);
    for (const k of Object.keys(KEYS)) expect(x[k], k).toBeUndefined();
    const id2 = await create({ ...KEYS, financials: FIN({ vatMode: 'NONE' }) });
    for (const k of Object.keys(KEYS)) expect(extraOf(id2)[k], `${k} (financials sent)`).toBeUndefined();
    expect((await call('req', 'POST', '/api/prs', { id: id2, department: 'PD', ...KEYS })).status).toBe(200);
    expect((await call('asst', 'PUT', `/api/prs/${id2}`, { ...KEYS })).status).toBe(200);
    for (const k of Object.keys(KEYS)) expect(extraOf(id2)[k], `${k} (after PUT)`).toBeUndefined();
    expect(row(id2).totalAmount).toBe(250); // the top-level copies changed nothing
  });

  // ───────────── 7. regression : the flows that must keep working ─────────────
  describe('regression', () => {
    it('reviewer edits qty / price at SUBMITTED and REVIEWED : the total follows (financials rewritten), links stay locked from REVIEWED', async () => {
      const id = await create();
      const r1 = await call('asst', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 4, purchaseQty: 4 }), LINES()[1]], totalAmount: 450, financials: FIN({ subtotal: 450, grandTotal: 450 }) });
      expect(r1.status, JSON.stringify(r1.json)).toBe(200);
      expect(row(id).totalAmount).toBe(450);
      expect(extraOf(id).financials).toMatchObject({ subtotal: 450, grandTotal: 450 });
      setStatus(id, 'REVIEWED');
      const r2 = await call('pm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 4, purchaseQty: 4, price: 90 }), LINES()[1]], totalAmount: 410 });
      expect(r2.status, JSON.stringify(r2.json)).toBe(200);
      expect(row(id).totalAmount).toBe(410);
      expect(itemsOf(id)[0]).toMatchObject({ price: 90, qty: 4 });
      expect((await call('pm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 4, purchaseQty: 4, price: 90, productUrl: 'https://evil.example/' }), LINES()[1]], totalAmount: 410 })).status).toBe(403);
      // the same edit without sending a total : the server's own figure
      expect((await call('pm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 1, purchaseQty: 1, price: 90 }), LINES()[1]] })).status).toBe(200);
      expect(row(id).totalAmount).toBe(140);
    });

    it('a status-only move and an unchanged echo of the whole PR do not touch the amounts (also for an old PR whose total does not match its lines)', async () => {
      sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson, extraJson) VALUES ('PR-OLD', 'OLD-1', 'PD', 'REQUESTER_PD', 'Old', 'SUBMITTED', 999, ?, ?)")
        .run(JSON.stringify(LINES()), JSON.stringify({ financials: FIN({ grandTotal: 999, roundingAdj: 5 }) }));
      const view = (await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-OLD');
      const echo = await call('asst', 'PUT', '/api/prs/PR-OLD', { ...view, status: 'REVIEWED' });
      expect(echo.status, JSON.stringify(echo.json)).toBe(200);
      expect(row('PR-OLD').totalAmount).toBe(999);
      expect(JSON.parse(row('PR-OLD').extraJson).financials.roundingAdj).toBe(5);
    });

    // the payload workflowEngine.createPR builds from PRCreateView (SELF, VAT, a percent combined discount, line discounts, shipping, rounding)
    const clientPayload = ({ channel = 'SELF', hasVat = true, discountPercent = 5, combinedType = 'percent', combinedValue = 10, shipping = 30, rounding = 0.5 } = {}) => {
      const raw = [
        { productId: 'P1', code: 'C1', name: 'Pen', qty: 3, price: 33.33, discountPercent, unit: 'box', conversionRate: 1 },
        { productId: 'P2', code: 'C2', name: 'Ink', qty: 7, price: 12.5, discountPercent: 0, discountAmount: 4.25, unit: 'pcs', conversionRate: 1 }
      ];
      const items = raw.map((it) => {
        const gross = it.price * it.qty;
        const discountAmount = it.discountAmount || (it.discountPercent > 0 ? r2(gross * (it.discountPercent / 100)) : 0);
        return { ...it, purchaseQty: it.qty, stockQty: it.qty, purchaseUnit: it.unit, stockUnit: it.unit, discountPercent: it.discountPercent, discountAmount, total: Math.max(0, gross - discountAmount), productUrl: '' };
      });
      const subtotal = items.reduce((s, i) => s + i.purchaseQty * i.price, 0);
      const itemDisc = items.reduce((s, i) => s + i.discountAmount, 0);
      const net = Math.max(0, subtotal - itemDisc);
      const isSelf = channel === 'SELF';
      let fin; let total;
      if (isSelf) {
        const cAmount = combinedType === 'percent' ? net * (combinedValue / 100) : combinedValue;
        const totalDiscount = itemDisc + cAmount;
        const netAll = Math.max(0, subtotal - totalDiscount);
        const vatAmount = hasVat ? parseFloat((netAll * 0.07).toFixed(2)) : 0;
        total = parseFloat((netAll + vatAmount + rounding + shipping).toFixed(2));
        fin = { subtotal, itemDiscountTotal: itemDisc, combinedDiscountType: combinedType, combinedDiscountValue: combinedValue, combinedDiscountAmount: cAmount, totalDiscount, vatMode: hasVat ? 'AFTER_DISCOUNT' : 'NONE', vatAmount, roundingAdj: rounding, shippingCost: shipping, grandTotal: total };
      } else {
        total = subtotal; // the create view sends the plain subtotal for an ONLINE PR and createPR keeps it
        fin = { subtotal, itemDiscountTotal: itemDisc, combinedDiscountType: 'fixed', combinedDiscountValue: 0, combinedDiscountAmount: 0, totalDiscount: itemDisc, vatMode: 'NONE', vatAmount: 0, roundingAdj: 0, shippingCost: 0, grandTotal: total };
      }
      return { items, financials: fin, totalAmount: total, hasVat: isSelf ? hasVat : false, purchaseChannel: channel, channel };
    };

    it('the real client payload (SELF, VAT 7%, percent combined discount, line discounts, shipping, rounding) is created and passes review -> BUFFER -> approval with the client\'s own total', async () => {
      const cp = clientPayload();
      const id = await create({ ...cp });
      expect(row(id).totalAmount).toBeCloseTo(cp.totalAmount, 2);
      expect(extraOf(id).financials).toMatchObject({ vatMode: 'AFTER_DISCOUNT', shippingCost: 30, roundingAdj: 0.5 });
      expect(extraOf(id).financials.grandTotal).toBeCloseTo(cp.totalAmount, 2);
      const stored = row(id).totalAmount;
      expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
      // the BUFFER (and then the approver) send the whole PR back, as the client does : nothing changes
      let view = (await call('su', 'GET', '/api/prs')).json.find((x) => x.id === id);
      const fwd = await call('su', 'PUT', `/api/prs/${id}`, { ...view, status: 'REVIEWED' });
      expect(fwd.status, JSON.stringify(fwd.json)).toBe(200);
      expect(row(id).totalAmount).toBe(stored);
      view = (await call('pm', 'GET', '/api/prs')).json.find((x) => x.id === id);
      const ap = await call('pm', 'PUT', `/api/prs/${id}`, { ...view, status: 'APPROVED' });
      expect(ap.status, JSON.stringify(ap.json)).toBe(200);
      expect(row(id).status).toBe('APPROVED');
      expect(commitments().map((c) => c.amount)).toEqual([-stored]);
    });

    it('the client payload variants : no VAT, fixed combined discount, an ONLINE PR (total = plain subtotal), a draft saved then submitted (updatePR)', async () => {
      for (const v of [{ hasVat: false }, { combinedType: 'fixed', combinedValue: 15 }, { combinedValue: 0, shipping: 0, rounding: 0 }, { discountPercent: 0 }, { channel: 'ONLINE' }]) {
        const cp = clientPayload(v);
        const id = await create({ ...cp, status: 'DRAFT' });
        expect(row(id).totalAmount, JSON.stringify(v)).toBeCloseTo(cp.totalAmount, 2);
        // the requester submits it : updatePR sends the whole PR again with the new status
        const put = await call('req', 'PUT', `/api/prs/${id}`, { ...cp, status: 'SUBMITTED', action: 'RESUBMIT' });
        expect(put.status, `${JSON.stringify(v)} ${JSON.stringify(put.json)}`).toBe(200);
        expect(row(id).status).toBe('SUBMITTED');
        expect(row(id).totalAmount, JSON.stringify(v)).toBeCloseTo(cp.totalAmount, 2);
      }
    });

    it('a draft edited by its requester : new lines + the new total pass, the old total with the new lines is a 400', async () => {
      const cp = clientPayload();
      const id = await create({ ...cp, status: 'DRAFT' });
      const next = clientPayload({ shipping: 10 });
      const bad = await call('req', 'PUT', `/api/prs/${id}`, { ...next, totalAmount: cp.totalAmount, financials: { ...next.financials, grandTotal: cp.totalAmount } });
      expect(bad.status).toBe(400);
      const ok = await call('req', 'PUT', `/api/prs/${id}`, next);
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(row(id).totalAmount).toBeCloseTo(next.totalAmount, 2);
    });

    it('a PR with no lines keeps the total as sent (nothing to compute from) ; a PR without financials is checked against its lines', async () => {
      const a = await create({ items: [], financials: undefined, totalAmount: 5000 });
      expect(row(a).totalAmount).toBe(5000);
      const b = await create({ financials: undefined, totalAmount: 250 });
      expect(row(b).totalAmount).toBe(250);
      expect(extraOf(b).financials).toBeUndefined();
      const bad = await call('req', 'POST', '/api/prs', body({ financials: undefined, totalAmount: 1 }));
      expect(bad.status).toBe(400);
    });
  });

  // ───────────── 8. kla round 3 : normalizeLine (one function for every write of PR lines) ─────────────
  describe('normalizeLine (kla round 3)', () => {
    const one = (over = {}) => [LINE({ productUrl: '', ...over })]; // 2 x 100 = 200 unless overridden
    const fin = (sub, over = {}) => FIN({ subtotal: sub, grandTotal: sub, ...over });
    const auditRows = (action) => sdb.prepare('SELECT * FROM audit_logs WHERE action = ?').all(action).map((r) => ({ ...r, details: JSON.parse(r.details || '{}') }));
    const count = () => sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c;
    const draft = (over = {}) => create({ status: 'DRAFT', items: one(), totalAmount: 200, financials: fin(200), ...over });
    const snap = (id) => { const r = row(id); return JSON.stringify([r.itemsJson, r.totalAmount, r.extraJson, r.status]); };

    it('1. names of ONE figure that disagree are a 400 (qty : purchaseQty / qty / quantity / orderedQty ; price : price / unitPrice / estimatedPrice) - new PR, PUT, POST upsert, requester and admin - nothing written', async () => {
      const bad = [
        ['quantity 1000', { purchaseQty: 1, qty: 1, quantity: 1000 }],
        ['orderedQty 3', { purchaseQty: 2, qty: 2, orderedQty: 3 }],
        ['purchaseQty vs qty', { purchaseQty: 1, qty: 2 }],
        ['text vs number', { purchaseQty: 2, qty: '3' }],
        ['unitPrice', { unitPrice: 1 }],
        ['estimatedPrice', { estimatedPrice: 99 }]
      ];
      const id = await draft();
      const before = snap(id);
      for (const [label, over] of bad) {
        const items = one(over);
        expect((await call('req', 'POST', '/api/prs', body({ id: `PR-NEW-${n}`, items, totalAmount: 200, financials: fin(200) }))).status, `new ${label}`).toBe(400);
        for (const who of ['req', 'adm']) {
          expect((await call(who, 'PUT', `/api/prs/${id}`, { items })).status, `PUT ${who} ${label}`).toBe(400);
          expect((await call(who, 'POST', '/api/prs', { id, department: 'PD', items })).status, `POST ${who} ${label}`).toBe(400);
        }
      }
      expect(count()).toBe(1);
      expect(snap(id)).toBe(before);
      // the attack of the finding : {purchaseQty 1, qty 1, quantity 1000} used to give an amount of 100 and a PO ceiling of 1000
      expect((await call('req', 'POST', '/api/prs', body({ items: one({ purchaseQty: 1, qty: 1, quantity: 1000, price: 100 }), totalAmount: 100 }))).status).toBe(400);
    });

    it('2. names that agree : the server writes ONE number over every name (qty x4, price x3), stockQty = qty x conversionRate, text numbers become numbers, total is the server\'s', async () => {
      const id = await create({
        items: [LINE({ purchaseQty: '3', qty: 3, price: ' 100.50 ', unitPrice: 100.5, conversionRate: '12', stockQty: 999, total: 1, productUrl: '' })],
        totalAmount: 301.5, financials: fin(301.5)
      });
      const l = itemsOf(id)[0];
      expect([l.purchaseQty, l.qty, l.quantity, l.orderedQty]).toEqual([3, 3, 3, 3]);
      expect([l.price, l.unitPrice, l.estimatedPrice]).toEqual([100.5, 100.5, 100.5]);
      expect(l).toMatchObject({ conversionRate: 12, stockQty: 36, total: 301.5 });
      expect(row(id).totalAmount).toBe(301.5);
      // an admin edit goes through the same function : every name follows
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { items: [{ ...l, qty: 5, purchaseQty: 5, quantity: 5, orderedQty: 5 }], totalAmount: 502.5 })).status).toBe(200);
      const m = itemsOf(id)[0];
      expect([m.purchaseQty, m.qty, m.quantity, m.orderedQty]).toEqual([5, 5, 5, 5]);
      expect(m).toMatchObject({ stockQty: 60, total: 502.5 });
    });

    it('3. qty must be > 0 and <= 1e7 : 0 / -1 / "0" / 1e8 / text / empty are a 400 (new PR, PUT by the requester and by the admin)', async () => {
      const id = await draft();
      const before = snap(id);
      for (const v of [0, -1, '0', 1e8, 10000001, 'abc', '', '1e3', '0x10']) {
        const items = one({ purchaseQty: v, qty: v });
        expect((await call('req', 'POST', '/api/prs', body({ id: `PR-Q-${n}`, items, totalAmount: 0 }))).status, `new ${JSON.stringify(v)}`).toBe(400);
        expect((await call('req', 'PUT', `/api/prs/${id}`, { items, totalAmount: 0 })).status, `PUT req ${JSON.stringify(v)}`).toBe(400);
        expect((await call('adm', 'PUT', `/api/prs/${id}`, { items })).status, `PUT adm ${JSON.stringify(v)}`).toBe(400);
      }
      expect(snap(id)).toBe(before);
      expect(count()).toBe(1);
      // the limits themselves are fine
      expect((await call('req', 'PUT', `/api/prs/${id}`, { items: one({ purchaseQty: 1e7, qty: 1e7, price: 0 }), totalAmount: 0 })).status).toBe(200);
    });

    it('4. PR -> PO : the PO line gets the quantity the amounts used ; the PO ceiling reads the qty names in the same order (never the highest)', async () => {
      const mkApproved = async () => { const id = await create(); setStatus(id, 'APPROVED'); return id; }; // 2 x Pen + 1 x Ink
      const po = (prId, n2, lines) => ({ id: `PO-W-${n2}`, poNo: `PO-PD-${YEAR}-9${String(n2).padStart(2, '0')}`, prId, prNo: row(prId).prNumber, department: 'PD', status: 'ISSUED', vendorName: 'V', totalAmount: 250, grandTotal: 250, purchaseChannel: 'SELF', items: lines });
      const pen = (over = {}) => ({ productId: 'P1', code: 'C1', name: 'Pen', price: 100, ...over });
      const ink = (over = {}) => ({ productId: 'P2', code: 'C2', name: 'Ink', price: 50, qty: 1, purchaseQty: 1, ...over });
      // honest
      const a = await mkApproved();
      expect((await call('pm', 'POST', '/api/pos', po(a, 1, [pen({ qty: 2, purchaseQty: 2 }), ink()]))).status).toBe(200);
      expect(JSON.parse(sdb.prepare('SELECT itemsJson FROM pos WHERE id = ?').get('PO-W-1').itemsJson).map((x) => x.qty)).toEqual([2, 1]);
      // over the PR's qty (3 > 2) : 400
      const b = await mkApproved();
      expect((await call('pm', 'POST', '/api/pos', po(b, 2, [pen({ qty: 3, purchaseQty: 3 }), ink()]))).status).toBe(400);
      // a PO line whose names disagree : read as the PR reads it (purchaseQty first = 1, not the 1000 of another name) and written with that one figure
      const c = await mkApproved();
      expect((await call('pm', 'POST', '/api/pos', po(c, 3, [pen({ purchaseQty: 1, qty: 1, quantity: 1000, orderedQty: 1000 }), ink()]))).status).toBe(200);
      const pl = JSON.parse(sdb.prepare('SELECT itemsJson FROM pos WHERE id = ?').get('PO-W-3').itemsJson)[0];
      expect([pl.purchaseQty, pl.qty, pl.quantity, pl.orderedQty]).toEqual([1, 1, 1, 1]);
      // and the PR line itself : the 1000 can no longer be stored on the PR side
      expect((await call('req', 'POST', '/api/prs', body({ items: [LINE({ purchaseQty: 1, qty: 1, quantity: 1000, productUrl: '' })], totalAmount: 100 }))).status).toBe(400);
    });

    it('5. a discount key cut out of the lines is a change : amounts are recomputed from the lines (editor), or the write is a 403 (a role that cannot edit)', async () => {
      const disc = () => [LINE({ qty: 1, purchaseQty: 1, price: 1000, discountAmount: 900, productUrl: '' })]; // total 100
      const stripped = () => [LINE({ qty: 1, purchaseQty: 1, price: 1000, productUrl: '' })]; // 1000 without the discount keys
      const mk = (status) => create({ status, items: disc(), totalAmount: 100, financials: fin(1000, { itemDiscountTotal: 900, totalDiscount: 900, grandTotal: 100 }) });
      // L1 at DRAFT (PUT and POST upsert), the total is not sent : recomputed to 1000
      for (const via of ['PUT', 'POST']) {
        const id = await mk('DRAFT');
        expect(row(id).totalAmount).toBe(100);
        const r = via === 'PUT' ? await call('req', 'PUT', `/api/prs/${id}`, { items: stripped() }) : await call('req', 'POST', '/api/prs', { id, department: 'PD', items: stripped() });
        expect(r.status, `${via} ${JSON.stringify(r.json)}`).toBe(200);
        expect(row(id).totalAmount).toBe(1000);
        expect(itemsOf(id)[0].discountAmount).toBeUndefined();
        expect(itemsOf(id)[0].total).toBe(1000);
        expect(extraOf(id).financials).toMatchObject({ subtotal: 1000, itemDiscountTotal: 0, grandTotal: 1000 });
      }
      // the old total sent along with the stripped lines is a mismatch (400)
      const id2 = await mk('DRAFT');
      expect((await call('req', 'PUT', `/api/prs/${id2}`, { items: stripped(), totalAmount: 100 })).status).toBe(400);
      expect(row(id2).totalAmount).toBe(100);
      // the reviewer at REVIEWED : the new amount
      const id3 = await mk('SUBMITTED'); setStatus(id3, 'REVIEWED');
      expect((await call('asst', 'PUT', `/api/prs/${id3}`, { items: stripped() })).status).toBe(200);
      expect(row(id3).totalAmount).toBe(1000);
      // a role that cannot edit the lines (requester at SUBMITTED, reviewer / approver at APPROVED) : 403, nothing written
      const id4 = await mk('SUBMITTED');
      const s4 = snap(id4);
      expect((await call('req', 'PUT', `/api/prs/${id4}`, { items: stripped() })).status).toBe(403);
      expect((await call('req', 'POST', '/api/prs', { id: id4, department: 'PD', items: stripped() })).status).toBe(403);
      expect(snap(id4)).toBe(s4);
      setStatus(id4, 'APPROVED');
      const s5 = snap(id4);
      for (const who of ['req', 'asst', 'pm']) expect((await call(who, 'PUT', `/api/prs/${id4}`, { items: stripped() })).status, who).toBe(403);
      expect(snap(id4)).toBe(s5);
      // ... and the plain echo of the stored PR is still fine for them
      const view = (await call('pm', 'GET', '/api/prs')).json.find((x) => x.id === id4);
      expect((await call('pm', 'PUT', `/api/prs/${id4}`, { items: view.items, status: 'APPROVED' })).status).toBe(200);
      expect(row(id4).totalAmount).toBe(100);
    });

    it('6. the line discount has ONE rule : percent gives the amount ; percent + an amount that disagrees is a 400 ; consistent or single -> both written', async () => {
      const mk = async (over, ok = 200) => {
        const r = await call('req', 'POST', '/api/prs', body({ status: 'DRAFT', items: [LINE({ productUrl: '', ...over })], totalAmount: undefined, financials: undefined }));
        expect(r.status, JSON.stringify(over)).toBe(ok);
        return ok === 200 ? itemsOf(`PR-W${n}`)[0] : null;
      };
      expect(await mk({ discountPercent: 10, discountAmount: 20 })).toMatchObject({ discountPercent: 10, discountAmount: 20, total: 180 });
      expect(await mk({ discountPercent: 10 })).toMatchObject({ discountPercent: 10, discountAmount: 20, total: 180 }); // the amount comes from the percent
      expect(await mk({ discountPercent: 10, discountAmount: 20.01 })).toMatchObject({ discountPercent: 10, discountAmount: 20 }); // a cent apart : the percent's figure is written
      const only = await mk({ discountAmount: 20 });
      expect(only).toMatchObject({ discountAmount: 20, total: 180 });
      expect(only.discountPercent).toBeUndefined();
      expect(await mk({ discountPercent: 0, discountAmount: 10 })).toMatchObject({ discountAmount: 10, total: 190 }); // what PRCreateView sends for an amount typed by hand
      for (const over of [{ discountPercent: 10, discountAmount: 50 }, { discountPercent: 10, discountAmount: 20.02 }, { discountPercent: 50, discountAmount: 0.5 }, { discountAmount: 200.02 }, { discountPercent: 100.5 }]) {
        await mk(over, 400);
      }
      expect(await mk({ discountAmount: 200 })).toMatchObject({ discountAmount: 200, total: 0 }); // the whole line
      // the PR total follows the server's amounts : 200 - 20 = 180, VAT off
      const id = await create({ status: 'DRAFT', items: [LINE({ discountPercent: 10, discountAmount: 20, productUrl: '' })], totalAmount: undefined, financials: undefined });
      expect(row(id).totalAmount).toBe(180);
    });

    it('7. a NEW PR whose settings come as top-level keys (no financials) : the amounts use them AND financials are written (the used values leave a trace)', async () => {
      const top = { financials: undefined, totalAmount: undefined, combinedDiscountType: 'percent', combinedDiscountValue: 10, shippingCost: 30, roundingAdj: '0.5' };
      const id = await create({ ...top }); // 250 - 10% = 225 + 30 + 0.5
      expect(row(id).totalAmount).toBe(255.5);
      expect(extraOf(id).financials).toMatchObject({ combinedDiscountType: 'percent', combinedDiscountValue: 10, combinedDiscountAmount: 25, shippingCost: 30, roundingAdj: 0.5, grandTotal: 255.5 });
      for (const k of ['combinedDiscountType', 'combinedDiscountValue', 'shippingCost', 'roundingAdj']) expect(extraOf(id)[k], k).toBeUndefined();
      // a total that ignores the settings is a mismatch
      expect((await call('req', 'POST', '/api/prs', body({ ...top, totalAmount: 250 }))).status).toBe(400);
      expect((await call('req', 'POST', '/api/prs', body({ ...top, totalAmount: 255.5 }))).status).toBe(200);
      // no settings at all and no financials : still no financials (nothing was used)
      const plain = await create({ financials: undefined, totalAmount: undefined });
      expect(extraOf(plain).financials).toBeUndefined();
      expect(row(plain).totalAmount).toBe(250);
    });

    it('8. figures are read one way : only a number or a plain decimal text ("0x3E8", "1000abc", "", "1e3", "1,000", "-5" are a 400) - line figures, financials, totals', async () => {
      const id = await draft();
      const before = snap(id);
      for (const v of ['0x3E8', '1000abc', '', '1e3', '1,000', '-5', ' ', 'Infinity', 'NaN', '.5', '5.', {}, [3], true]) {
        const s = JSON.stringify(v);
        for (const patch of [{ price: v }, { purchaseQty: v, qty: v }, { discountPercent: v }, { discountAmount: v }, { conversionRate: v }]) {
          expect((await call('req', 'PUT', `/api/prs/${id}`, { items: one(patch), totalAmount: 200 })).status, `PUT ${Object.keys(patch)[0]} ${s}`).toBe(400);
        }
        expect((await call('req', 'POST', '/api/prs', body({ id: `PR-S-${n}`, items: one({ price: v }), totalAmount: 200 }))).status, `new price ${s}`).toBe(400);
        expect((await call('req', 'PUT', `/api/prs/${id}`, { totalAmount: v })).status, `total ${s}`).toBe(400);
        for (const key of ['shippingCost', 'roundingAdj', 'combinedDiscountValue']) {
          expect((await call('req', 'PUT', `/api/prs/${id}`, { financials: fin(200, { [key]: v }) })).status, `financials.${key} ${s}`).toBe(400);
        }
      }
      expect(snap(id)).toBe(before);
      expect(count()).toBe(1);
      // plain decimal texts are fine and stored as numbers
      const ok = await call('req', 'PUT', `/api/prs/${id}`, { items: one({ price: ' 100.00 ', purchaseQty: '2', qty: 2 }), totalAmount: '199.50', financials: fin(200, { shippingCost: '0', roundingAdj: '-0.5', grandTotal: '199.5' }) });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(itemsOf(id)[0]).toMatchObject({ price: 100, purchaseQty: 2, qty: 2 });
      expect(row(id).totalAmount).toBe(199.5);
      expect(extraOf(id).financials).toMatchObject({ roundingAdj: -0.5, shippingCost: 0, grandTotal: 199.5 });
    });

    it('9. total / lineTotal / stockQty / discountAmount of a line are the server\'s : the client\'s values are overwritten (new PR, editor, a caller who cannot edit)', async () => {
      const id = await create({ items: [LINE({ total: 1, lineTotal: 2, stockQty: 5000, productUrl: '' })], totalAmount: 200, financials: fin(200) });
      expect(itemsOf(id)[0]).toMatchObject({ total: 200, lineTotal: 200, stockQty: 2 });
      expect((await call('asst', 'PUT', `/api/prs/${id}`, { items: [{ ...itemsOf(id)[0], total: 7, lineTotal: 7, stockQty: 1 }] })).status).toBe(200);
      expect(itemsOf(id)[0]).toMatchObject({ total: 200, lineTotal: 200, stockQty: 2 });
      // the requester at SUBMITTED cannot edit : an echo with tampered derived values is accepted but the values stay the server's
      setStatus(id, 'APPROVED');
      expect((await call('req', 'PUT', `/api/prs/${id}`, { items: [{ ...itemsOf(id)[0], total: 1, lineTotal: 1, stockQty: 99 }] })).status).toBe(200);
      expect(itemsOf(id)[0]).toMatchObject({ total: 200, lineTotal: 200, stockQty: 2 });
      expect(row(id).totalAmount).toBe(200);
    });

    it('10. an admin that sets a total different from the lines\' leaves an audit row PR_TOTAL_OVERRIDE { expected, given } ; an honest total / an unchanged echo does not', async () => {
      const id = await create();
      setStatus(id, 'APPROVED');
      expect(auditRows('PR_TOTAL_OVERRIDE')).toHaveLength(0);
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { totalAmount: 90 })).status).toBe(200);
      expect(row(id).totalAmount).toBe(90);
      const a = auditRows('PR_TOTAL_OVERRIDE');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ entityType: 'pr', entityId: id });
      expect(a[0].details).toMatchObject({ expected: 250, given: 90 });
      // the same figure sent again (nothing moves) and a PUT without a total : no new row
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { totalAmount: 90 })).status).toBe(200);
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { reason: 'note only' })).status).toBe(200);
      expect(auditRows('PR_TOTAL_OVERRIDE')).toHaveLength(1);
      // the honest total, and a new line set with its own honest total : none
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { totalAmount: 250 })).status).toBe(200);
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 4, purchaseQty: 4, productUrl: 'https://shop.example/pen' }), LINES()[1]], totalAmount: 450 })).status).toBe(200);
      expect(auditRows('PR_TOTAL_OVERRIDE')).toHaveLength(1);
      // lines changed + a total that does not follow them : a second row with the new expected figure
      expect((await call('adm', 'PUT', `/api/prs/${id}`, { items: [LINE({ qty: 1, purchaseQty: 1, productUrl: 'https://shop.example/pen' }), LINES()[1]], totalAmount: 10 })).status).toBe(200);
      const b = auditRows('PR_TOTAL_OVERRIDE');
      expect(b).toHaveLength(2);
      expect(b.map((x) => x.details.expected).sort()).toEqual([150, 250]);
      expect(b.map((x) => x.details.given).sort()).toEqual([10, 90]);
      // POST upsert path is audited too
      expect((await call('adm', 'POST', '/api/prs', { id, department: 'PD', totalAmount: 5 })).status).toBe(200);
      expect(auditRows('PR_TOTAL_OVERRIDE')).toHaveLength(3);
    });

    it('11. old PRs : a PR sent back as it is is never refused for its old figures (names that already disagree, text figures) ; a changed old line is judged by the rules', async () => {
      const old = [
        { productId: 'P1', code: 'C1', name: 'Pen', purchaseQty: 1, qty: 1, quantity: 1000, price: '1,234.50', conversionRate: 1, discountPercent: '', productUrl: '' },
        { productId: 'P2', code: 'C2', name: 'Ink', purchaseQty: 1, qty: 1, price: 50, productUrl: '' }
      ];
      sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson, extraJson) VALUES ('PR-OLD3', 'OLD-3', 'PD', 'REQUESTER_PD', 'Old', 'SUBMITTED', 1284.5, ?, ?)")
        .run(JSON.stringify(old), JSON.stringify({ financials: FIN({ subtotal: 1284.5, grandTotal: 1284.5 }) }));
      const view = (await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-OLD3');
      const echo = await call('asst', 'PUT', '/api/prs/PR-OLD3', { ...view, status: 'REVIEWED' });
      expect(echo.status, JSON.stringify(echo.json)).toBe(200);
      expect(row('PR-OLD3').totalAmount).toBe(1284.5);
      expect(itemsOf('PR-OLD3')[0].quantity).toBe(1000); // untouched
      // a line of it that CHANGES must obey the rules : the other name (1000) now disagrees with the new qty -> 400
      setStatus('PR-OLD3', 'SUBMITTED');
      expect((await call('asst', 'PUT', '/api/prs/PR-OLD3', { items: [{ ...old[0], purchaseQty: 2, qty: 2 }, old[1]], totalAmount: 100 })).status).toBe(400);
    });
  });
});
