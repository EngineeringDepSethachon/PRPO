// @vitest-environment node
// M10 T2/T3 hardening (kla-security findings on the BUFFER role "พี่สุ") : real onRequest + in-memory node:sqlite D1, same harness as cf_buffer_flow.test.js.
//  1. BUFFER cannot WRITE across departments / outside its allow-list (PO, master data, stock, budget ledger, budgets, signatures, users) ; it still READS every department
//  2. the discount / financials of a PR cannot be poisoned (by a level-1 user at PENDING_BUFFER, by the BUFFER itself) ; the totals are the server's
//  3. quantity / price aliases are written together
//  4. every link alias is locked from PENDING_BUFFER on (except the BUFFER at PENDING_BUFFER, and admin)
//  5. roleId 'buffer' is normalised / unknown roles are refused ;  6. BUFFER is never an online purchaser, always level 2 ;  7. one "active" rule
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';
import { authorize, normalizeUser, resolvePermissions, canAccessDepartment, BUFFER_WRITE_RULES } from '../functions/_lib/rbac.js';

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

d('BUFFER hardening (M10 T2/T3)', () => {
  let sdb; let env; const tok = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const row = (id) => ({ ...sdb.prepare('SELECT * FROM prs WHERE id = ?').get(id) });
  const extraOf = (id) => JSON.parse(row(id).extraJson || '{}');
  const itemsOf = (id) => JSON.parse(row(id).itemsJson || '[]');
  const commitments = () => sdb.prepare("SELECT amount FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT'").all().map((r) => ({ ...r }));
  let n = 0;
  const submitted = async (over = {}, who = 'req') => {
    n += 1;
    const id = over.id || `PR-H${n}`;
    const r = await call(who, 'POST', '/api/prs', { id, prNo: `PD${String(n).padStart(3, '0')}/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 250, reason: 'need pens', items: LINES(), financials: FIN(), ...over });
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
  const forward = (id, over = {}, who = 'su') => call(who, 'PUT', `/api/prs/${id}`, { status: 'REVIEWED', ...over });
  const pend = (id) => expect(row(id).status).toBe('PENDING_BUFFER');

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U1', 'req', 'Req PD', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1],
      ['U2', 'asst', 'Asst PD', 'PD', '["PD"]', 'ASST_MANAGER', 'REVIEWER', 2],
      ['U-BF', 'su', 'Su Buffer', 'ALL', '["ALL"]', 'BUFFER', 'BUFFER', 2],
      ['U-BP', 'sup', 'Su PD only', 'PD', '["PD"]', 'BUFFER', 'BUFFER', 2],
      ['U-BL', 'sulow', 'Su lower', 'PD', '["PD"]', 'buffer', 'BUFFER', 99], // legacy spelling + a level that would make an admin
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

  // ───────────── 1. the write allow-list ─────────────
  // [method, path, body, who-may] : every one is a write the level-2 rules alone would let a BUFFER do
  const WRITES = [
    ['PUT', '/api/pos/PO-X', { status: 'CANCELLED' }], ['PUT', '/api/pos/PO-X', { status: 'CLOSED' }], ['POST', '/api/pos', { id: 'PO-NEW', department: 'PD', items: [] }],
    ['POST', '/api/products', { id: 'PRD-1', code: 'X1', name: 'x', department: 'QC' }], ['PUT', '/api/products/PRD-1', { name: 'y', department: 'QC' }], ['DELETE', '/api/products/PRD-1'],
    ['POST', '/api/vendors', { id: 'V-1', code: 'V1', name: 'v', department: 'QC' }], ['PUT', '/api/vendors/V-1', { name: 'w', department: 'QC' }], ['DELETE', '/api/vendors/V-1'],
    ['POST', '/api/storage-locations', { id: 'LOC-1', name: 'l', department: 'QC' }], ['PUT', '/api/storage-locations/LOC-1', { name: 'm', department: 'QC' }], ['DELETE', '/api/storage-locations/LOC-1'],
    ['POST', '/api/usage-units', { id: 'UU-1', name: 'u', department: 'QC' }], ['PUT', '/api/usage-units/UU-1', { name: 'u2', department: 'QC' }], ['DELETE', '/api/usage-units/UU-1'],
    ['POST', '/api/stock/issue', { productId: 'PRD-1', quantity: 1 }], ['POST', '/api/stock/adjust', { productId: 'PRD-1', newStock: 5 }], ['POST', '/api/stock-logs', [{ id: 'L1', productId: 'PRD-1', quantity: 1 }]],
    ['POST', '/api/budget-transactions', { dept: 'QC', type: 'PR_RELEASE', amount: 100, delta: 100 }], ['POST', '/api/budget-transactions', { dept: 'QC', type: 'ACTUAL_SPEND', amount: -100 }],
    ['POST', '/api/budget-transactions', { dept: 'QC', type: 'PO_CANCEL_REFUND', amount: 100 }],
    ['PUT', '/api/budgets/QC', { spent: 0 }], ['POST', '/api/budgets/adjust', { dept: 'QC', action: 'TOP_UP', delta: 100 }], ['POST', '/api/budgets/allocate', { period: '2026-10', allocations: { QC: 5 } }],
    ['POST', '/api/budgets/reset', { period: '2026-10' }],
    ['POST', '/api/pos/PO-X/receive', { receivingItems: [] }], ['POST', '/api/pos/PO-X/settle', {}],
    ['POST', '/api/signatures', { roleId: 'APPROVER', signatureUrl: 'data:image/png;base64,iVBORw0KGgo=' }], ['PUT', '/api/signatures/APPROVER', { signatureUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    ['POST', '/api/users', { id: 'U-NEW', username: 'newbie', name: 'n', roleId: 'REQUESTER', password: 'Abcdef123!' }], ['DELETE', '/api/prs/PR-X']
  ];

  it('BUFFER writes outside the allow-list are 403 : PO, master data, stock, budget ledger, budgets, signatures, users (real routes, both BUFFER accounts)', async () => {
    for (const who of ['su', 'sup']) {
      for (const [m, p, b] of WRITES) {
        const r = await call(who, m, p, b);
        expect(r.status, `${who} ${m} ${p} ${JSON.stringify(b)}`).toBe(403);
      }
    }
    // nothing was written
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM budget_transactions').get().c).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM products').get().c).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM pos').get().c).toBe(0);
  });

  it('the same requests are NOT blocked by the allow-list for the other roles (the allow-list is the BUFFER\'s only)', () => {
    const asst = { id: 'U2', department: 'PD', roleId: 'ASST_MANAGER', level: 2 };
    expect(authorize(asst, 'POST', '/api/products')).toBe(true);
    expect(authorize(asst, 'POST', '/api/budget-transactions')).toBe(true);
    expect(authorize(asst, 'PUT', '/api/pos/PO-X')).toBe(true);
    expect(authorize(asst, 'POST', '/api/stock/issue')).toBe(true);
  });

  it('BUFFER allow-list table (authorize) : reads follow the normal rules, writes only PR / notifications / upload+files / own session / audit trail', () => {
    const su = { id: 'U-BF', department: 'ALL', allowedDepartments: '["ALL"]', roleId: 'BUFFER', canonicalRole: 'BUFFER', level: 2 };
    const allow = [
      ['GET', '/api/prs'], ['GET', '/api/pos'], ['GET', '/api/products'], ['GET', '/api/stock-logs'], ['GET', '/api/budgets'], ['GET', '/api/budget-transactions'], ['GET', '/api/bootstrap'],
      ['POST', '/api/prs'], ['PUT', '/api/prs/PR1'], ['PUT', '/api/notifications/N1'], ['POST', '/api/upload'], ['POST', '/api/files'], ['GET', '/api/files/abc'],
      ['POST', '/api/me/password'], ['POST', '/api/logout'], ['POST', '/api/audit-logs']
    ];
    const deny = [
      ['PUT', '/api/pos/PO1'], ['POST', '/api/pos'], ['POST', '/api/products'], ['PUT', '/api/products/P1'], ['DELETE', '/api/products/P1'], ['POST', '/api/vendors'], ['DELETE', '/api/vendors/V1'],
      ['POST', '/api/storage-locations'], ['DELETE', '/api/storage-locations/L1'], ['POST', '/api/usage-units'], ['PUT', '/api/usage-units/U1'], ['POST', '/api/stock/issue'], ['POST', '/api/stock/adjust'],
      ['POST', '/api/stock/manual-in'], ['POST', '/api/stock-logs'], ['POST', '/api/budget-transactions'], ['PUT', '/api/budgets/PD'], ['POST', '/api/budgets/adjust'], ['POST', '/api/budgets/allocate'],
      ['POST', '/api/signatures'], ['PUT', '/api/signatures/X'], ['POST', '/api/pos/PO1/receive'], ['POST', '/api/pos/PO1/settle'], ['POST', '/api/users'], ['DELETE', '/api/prs/PR1'], ['POST', '/api/notifications'],
      ['POST', '/api/admin/cleanup-orphans']
    ];
    for (const [m, p] of allow) expect(authorize(su, m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of deny) expect(authorize(su, m, p), `${m} ${p}`).toBe(false);
    expect([...BUFFER_WRITE_RULES].sort()).toEqual(['audit-write', 'misc-auth', 'prs-write']);
  });

  it('BUFFER still READS every department : PRs, POs, products, stock logs, budgets (also an account assigned to PD only)', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, department, currentStock) VALUES ('PRD-QC','QC-1','Qc item','QC',3)").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, prId, prNumber, department, status, itemsJson) VALUES ('PO-QC','POQC1','PR-QC','QC001','QC','ISSUED','[]')").run();
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, balance, department) VALUES ('SL-QC','PRD-QC','IN',3,3,'QC')").run();
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated) VALUES ('QC','QC',2026,100,100)").run();
    expect((await call('adm', 'POST', '/api/prs', { id: 'PR-QC', prNo: `QC001/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN() })).status).toBe(200);
    for (const who of ['su', 'sup']) {
      const ids = async (p) => (await call(who, 'GET', p)).json;
      expect((await ids('/api/prs')).some((x) => x.id === 'PR-QC'), `${who} prs`).toBe(true);
      expect((await ids('/api/pos')).some((x) => x.id === 'PO-QC'), `${who} pos`).toBe(true);
      expect((await ids('/api/products')).some((x) => x.id === 'PRD-QC'), `${who} products`).toBe(true);
      expect((await ids('/api/stock-logs')).some((x) => x.id === 'SL-QC'), `${who} stock-logs`).toBe(true);
      const b = await ids('/api/budgets');
      expect(JSON.stringify(b), `${who} budgets`).toContain('QC');
    }
    // the requester of PD does not see the QC PR (the scope is unchanged for the others)
    expect((await call('req', 'GET', '/api/prs')).json.some((x) => x.id === 'PR-QC')).toBe(false);
  });

  it('BUFFER writes only inside its own departments : a PD-only BUFFER cannot touch a QC PR (SUBMITTED) or create one ; the all-department BUFFER account follows its assignment', async () => {
    expect((await call('adm', 'POST', '/api/prs', { id: 'PR-QC', prNo: `QC001/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN() })).status).toBe(200);
    expect((await call('sup', 'PUT', '/api/prs/PR-QC', { reason: 'x' })).status).toBe(403);
    expect((await call('sup', 'POST', '/api/prs', { id: 'PR-QC2', prNo: `QC002/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES() })).status).toBe(403);
    expect((await call('sup', 'POST', '/api/prs', { id: 'PR-PD-OWN', prNo: `PD900/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 250, items: LINES() })).status).toBe(200); // creating its own PR (Q7)
    // canAccessDepartment : no more blanket "true" for the role
    const sup = { department: 'PD', allowedDepartments: '["PD"]', roleId: 'BUFFER', level: 2 };
    expect(canAccessDepartment(sup, 'QC')).toBe(false);
    expect(canAccessDepartment(sup, 'PD')).toBe(true);
  });

  it('the one cross-department write of the BUFFER stays : edit + forward of a PR parked at ITS step in another department', async () => {
    const id = 'PR-QC9';
    expect((await call('adm', 'POST', '/api/prs', { id, prNo: `QC009/${YEAR}`, department: 'QC', status: 'SUBMITTED', totalAmount: 250, items: LINES(), financials: FIN() })).status).toBe(200);
    expect((await call('adm', 'PUT', `/api/prs/${id}`, { status: 'PENDING_BUFFER' })).status).toBe(200);
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]];
    const r = await forward(id, { items, totalAmount: 350, bufferComment: 'ok' }, 'sup'); // the PD-only account
    expect(r.status).toBe(200);
    expect(row(id).status).toBe('REVIEWED');
    expect(row(id).totalAmount).toBe(350);
  });

  // ───────────── 2. discount / financials poisoning ─────────────
  // a PR with a PERCENT line discount (10% of 2 x 100 = 20) : stored total 230
  const DISC_LINES = () => [LINE({ discountPercent: 10, discountAmount: 20, total: 180 }), LINE({ productId: 'P2', code: 'C2', name: 'Ink', qty: 1, purchaseQty: 1, price: 50, productUrl: '' })];
  const DISC_FIN = (over = {}) => FIN({ subtotal: 250, itemDiscountTotal: 20, totalDiscount: 20, grandTotal: 230, ...over });
  const discPr = (over = {}) => parked({ totalAmount: 230, items: DISC_LINES(), financials: DISC_FIN(), ...over });

  it('poisoning step 1 (level-1 user at PENDING_BUFFER) : changed line discount / financials / reason / attachments / a line field are 403 and nothing is stored', async () => {
    const id = await discPr();
    const before = row(id);
    const bad = [
      { items: [{ ...DISC_LINES()[0], discountAmount: 200, discountPercent: 0 }, DISC_LINES()[1]] },
      { items: [{ ...DISC_LINES()[0], discountPercent: 100 }, DISC_LINES()[1]] },
      { items: [{ ...DISC_LINES()[0], name: 'Hacked' }, DISC_LINES()[1]] },
      { items: [{ ...DISC_LINES()[0], productRemark: 'free' }, DISC_LINES()[1]] },
      { items: [{ ...DISC_LINES()[0], discount: 150 }, DISC_LINES()[1]] },
      { financials: DISC_FIN({ combinedDiscountValue: 200, combinedDiscountAmount: 200, totalDiscount: 220, grandTotal: 30 }) },
      { financials: { grandTotal: 1 } },
      { financials: { combinedDiscountType: 'percent', combinedDiscountValue: 99 } },
      { reason: 'something else' },
      { purpose: 'something else' },
      { attachments: [{ id: 'A1', name: 'quote.pdf', url: 'https://x.example/q.pdf' }] },
      { totalAmount: 1 }
    ];
    for (const b of bad) expect((await call('req', 'PUT', `/api/prs/${id}`, b)).status, JSON.stringify(b)).toBe(403);
    // POST upsert path too
    expect((await call('req', 'POST', '/api/prs', { id, financials: { grandTotal: 1 } })).status).toBe(403);
    expect((await call('req', 'POST', '/api/prs', { id, items: [{ ...DISC_LINES()[0], discountAmount: 200, discountPercent: 0 }, DISC_LINES()[1]] })).status).toBe(403);
    // the reviewer / approver / BUFFER-less others too (they only send back or cancel)
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { financials: { grandTotal: 1 } })).status).toBe(403);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { reason: 'x' })).status).toBe(403);
    expect(row(id)).toEqual(before);
  });

  it('PR without stored financials : the client cannot add `financials` at PENDING_BUFFER (403) nor through the BUFFER\'s edit (dropped)', async () => {
    const id = await parked({ totalAmount: 250, financials: undefined });
    expect(extraOf(id).financials).toBeUndefined();
    expect((await call('req', 'PUT', `/api/prs/${id}`, { financials: FIN({ grandTotal: 1 }) })).status).toBe(403);
    const items = [LINE({ qty: 3, purchaseQty: 3 }), LINES()[1]];
    const r = await forward(id, { items, totalAmount: 350, financials: FIN({ grandTotal: 350, combinedDiscountValue: 300, totalDiscount: 300 }) });
    expect(r.status).toBe(200);
    expect(extraOf(id).financials).toBeUndefined();
    expect(row(id).totalAmount).toBe(350);
  });

  it('echo of what is stored is NOT a change : the reviewer sends the PR back with the full object (items, financials, reason, attachments) -> 200', async () => {
    const id = await discPr();
    const pr = (await call('asst', 'GET', '/api/prs')).json.find((x) => x.id === id);
    const r = await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REJECTED_TO_DRAFT', items: pr.items, financials: pr.financials, reason: pr.reason, attachments: pr.attachments, totalAmount: pr.totalAmount, rejectReason: 'ราคาไม่ตรง' });
    expect(r.status).toBe(200);
    expect(row(id).status).toBe('REJECTED_TO_DRAFT');
    expect(itemsOf(id)[0]).toMatchObject({ discountPercent: 10, discountAmount: 20 });
    expect(extraOf(id).financials).toMatchObject({ grandTotal: 230, totalDiscount: 20 });
  });

  it('poisoning step 2 (the BUFFER itself) : a poisoned discount / financials in the edit never reaches the stored PR ; the commitment at approval is the right amount', async () => {
    const id = await discPr();
    // qty 2 -> 3 : the stored 10% discount re-derives (30) ; total = 300 + 50 - 30 = 320
    const items = [{ ...DISC_LINES()[0], qty: 3, purchaseQty: 3, discountPercent: 100, discountAmount: 9999, total: 1, name: 'HACK', productRemark: 'x', productId: 'P1' }, DISC_LINES()[1]];
    // the poisoned totals are refused (they do not fit the STORED discount parameters)
    expect((await forward(id, { items, totalAmount: 1 })).status).toBe(400);
    expect((await forward(id, { items, totalAmount: 320, financials: DISC_FIN({ subtotal: 350, combinedDiscountValue: 300, totalDiscount: 330, grandTotal: 20 }) })).status).toBe(400);
    expect((await forward(id, { items, totalAmount: 20, financials: DISC_FIN({ grandTotal: 20 }) })).status).toBe(400);
    pend(id);
    // the honest total with the poisoned parameters in the body : accepted, but the body's parameters are ignored
    const ok = await forward(id, { items, totalAmount: 320, financials: DISC_FIN({ subtotal: 350, combinedDiscountType: 'percent', combinedDiscountValue: 99, grandTotal: 320 }), bufferComment: 'ok' });
    expect(ok.status).toBe(200);
    expect(row(id).totalAmount).toBe(320);
    expect(itemsOf(id)[0]).toMatchObject({ discountPercent: 10, discountAmount: 30, total: 270, name: 'Pen', productId: 'P1' });
    expect(itemsOf(id)[0].productRemark).toBeUndefined();
    expect(extraOf(id).financials).toMatchObject({ combinedDiscountType: 'fixed', combinedDiscountValue: 0, itemDiscountTotal: 30, totalDiscount: 30, grandTotal: 320, subtotal: 350 });
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect(commitments()).toEqual([{ amount: -320 }]);
  });

  it('one discount formula from the stored line : percent -> round2(qty x price x pct) per line ; fixed -> min(stored amount, qty x price) ; +/- 0.01', async () => {
    // fixed 150 on a 2 x 100 line ; the BUFFER lowers the price to 50 (gross 100 < 150) -> discount clamps to 100 : total = 0 + 50
    const a = await parked({ totalAmount: 100, items: [LINE({ discountAmount: 150 }), LINES()[1]], financials: FIN({ subtotal: 250, itemDiscountTotal: 150, totalDiscount: 150, grandTotal: 100 }) });
    expect((await forward(a, { items: [LINE({ price: 50, discountAmount: 150 }), LINES()[1]], totalAmount: 50 })).status).toBe(200);
    expect(itemsOf(a)[0]).toMatchObject({ discountAmount: 100, total: 0, price: 50 });
    // six percent lines of 10.10 at 5% : each rounded to the cent (0.505 -> 0.51) ; line 1 raised to 20.20 (1.01)
    const items = Array.from({ length: 6 }, (_, i) => LINE({ productId: `Q${i}`, code: `Q${i}`, name: `Q${i}`, qty: 1, purchaseQty: 1, price: 10.1, productUrl: '', discountPercent: 5, discountAmount: 0.51, total: 9.59 }));
    const b = await parked({ totalAmount: 57.54, items, financials: undefined });
    const sent = items.map((it, i) => (i === 0 ? { ...it, price: 20.2 } : it));
    // subtotal 20.2 + 5 x 10.1 = 70.7 ; discounts 1.01 + 5 x 0.51 = 3.56 -> 67.14
    expect((await forward(b, { items: sent, totalAmount: 67.14 })).status).toBe(200);
    expect(row(b).totalAmount).toBe(67.14);
  });

  // ───────────── 3. aliases ─────────────
  it('after the BUFFER edit every quantity / price alias is equal (quantity, orderedQty, purchaseQty, qty / unitPrice, estimatedPrice, price) ; name / productId / productRemark stay', async () => {
    const stale = (over = {}) => LINE({ quantity: 2, orderedQty: 2, unitPrice: 100, estimatedPrice: 100, productRemark: 'blue', ...over });
    const id = await parked({ totalAmount: 250, items: [stale(), LINES()[1]] });
    const r = await forward(id, { items: [{ ...stale(), qty: 3, purchaseQty: 3, quantity: 1, orderedQty: 99, price: 90, unitPrice: 5, estimatedPrice: 7, name: 'Other', productRemark: 'red' }, LINES()[1]], totalAmount: 320 });
    expect(r.status).toBe(200);
    const l = itemsOf(id)[0];
    expect([l.quantity, l.orderedQty, l.purchaseQty, l.qty]).toEqual([3, 3, 3, 3]);
    expect([l.unitPrice, l.estimatedPrice, l.price]).toEqual([90, 90, 90]);
    expect(l).toMatchObject({ name: 'Pen', productId: 'P1', productRemark: 'blue' });
    // the untouched line carries equal aliases too
    const m = itemsOf(id)[1];
    expect([m.quantity, m.orderedQty, m.purchaseQty, m.qty]).toEqual([1, 1, 1, 1]);
    expect([m.unitPrice, m.estimatedPrice, m.price]).toEqual([50, 50, 50]);
  });

  // ───────────── 4. links ─────────────
  const ALIASES = ['productUrl', 'onlineUrl', 'link', 'url', 'itemUrl', 'storeUrl'];
  const withLink = (k, v) => [LINE({ [k]: v }), LINES()[1]];

  it('links at PENDING_BUFFER : level 1 / reviewer / approver changing ANY alias is 403 (PUT and POST) ; the PR is untouched', async () => {
    const id = await parked({ items: [LINE({ link: 'https://shop.example/pen', url: 'https://shop.example/pen', itemUrl: 'https://shop.example/pen', storeUrl: 'https://shop.example' }), LINES()[1]] });
    const before = row(id);
    for (const who of ['req', 'asst', 'pm']) {
      for (const k of ALIASES) {
        expect((await call(who, 'PUT', `/api/prs/${id}`, { items: withLink(k, 'https://evil.example/') })).status, `${who} PUT ${k}`).toBe(403);
      }
    }
    expect((await call('req', 'POST', '/api/prs', { id, items: withLink('itemUrl', 'https://evil.example/') })).status).toBe(403);
    expect((await call('req', 'PUT', `/api/prs/${id}`, { items: withLink('link', '') })).status).toBe(403); // clearing is a change as well
    expect(row(id)).toEqual(before);
  });

  it('links after the BUFFER forward (REVIEWED) : the requester cannot change them (403) ; the reviewer can still edit qty but not a link ; admin can ; APPROVED likewise', async () => {
    const id = await parked({ items: [LINE({ link: 'https://shop.example/pen' }), LINES()[1]] });
    expect((await forward(id, { items: [LINE({ link: 'https://shop.example/pen', productUrl: 'https://shop.example/pen-v2' }), LINES()[1]], totalAmount: 250 })).status).toBe(200);
    expect(row(id).status).toBe('REVIEWED');
    expect(itemsOf(id)[0].productUrl).toBe('https://shop.example/pen-v2');
    for (const k of ALIASES) {
      expect((await call('req', 'PUT', `/api/prs/${id}`, { items: withLink(k, 'https://evil.example/') })).status, `req ${k}`).toBe(403);
      expect((await call('asst', 'PUT', `/api/prs/${id}`, { items: withLink(k, 'https://evil.example/') })).status, `asst ${k}`).toBe(403);
    }
    // the BUFFER, no longer at its step, cannot touch a link either
    expect((await call('su', 'PUT', `/api/prs/${id}`, { items: [LINE({ link: 'https://shop.example/pen', productUrl: 'https://evil.example/' }), LINES()[1]] })).status).toBe(403);
    expect(itemsOf(id)[0].productUrl).toBe('https://shop.example/pen-v2');
    // the reviewer's normal edit (qty) keeps working, the links come out as they were stored
    const q = await call('asst', 'PUT', `/api/prs/${id}`, { items: [{ ...itemsOf(id)[0], qty: 4, purchaseQty: 4 }, itemsOf(id)[1]], totalAmount: 450 });
    expect(q.status).toBe(200);
    expect(itemsOf(id)[0]).toMatchObject({ purchaseQty: 4, productUrl: 'https://shop.example/pen-v2', link: 'https://shop.example/pen' });
    // approved : still locked
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { status: 'APPROVED' })).status).toBe(200);
    expect((await call('req', 'PUT', `/api/prs/${id}`, { items: withLink('onlineUrl', 'https://evil.example/') })).status).toBe(403);
    expect((await call('pm', 'PUT', `/api/prs/${id}`, { items: withLink('url', 'https://evil.example/') })).status).toBe(403);
    // an admin is not restricted
    expect((await call('adm', 'PUT', `/api/prs/${id}`, { items: [{ ...itemsOf(id)[0], productUrl: 'https://admin.example/' }, itemsOf(id)[1]] })).status).toBe(200);
    expect(itemsOf(id)[0].productUrl).toBe('https://admin.example/');
  });

  it('links : the BUFFER sets productUrl / onlineUrl at PENDING_BUFFER ; the audit row lists every changed alias', async () => {
    const id = await parked();
    const r = await forward(id, { items: [LINE({ productUrl: 'https://shop.example/new', onlineUrl: 'https://shop.example/online', link: 'https://smuggled.example/' }), LINES()[1]], totalAmount: 250 });
    expect(r.status).toBe(200);
    expect(itemsOf(id)[0]).toMatchObject({ productUrl: 'https://shop.example/new', onlineUrl: 'https://shop.example/online' });
    expect(itemsOf(id)[0].link).toBeUndefined(); // an alias the BUFFER does not own is not taken from the body
    const a = sdb.prepare("SELECT details FROM audit_logs WHERE entityId = ? AND action = 'BUFFER_FORWARD'").all(id).map((x) => JSON.parse(x.details));
    expect(a[0].changes.map((c) => c.field).sort()).toEqual(['onlineUrl', 'productUrl']);
  });

  it('frozen statuses drop a `financials` sent by a caller who cannot edit the content ; the stored financials stay', async () => {
    const id = await discPr();
    expect((await forward(id)).status).toBe(200); // REVIEWED
    const stored = extraOf(id).financials;
    const r = await call('req', 'PUT', `/api/prs/${id}`, { financials: DISC_FIN({ combinedDiscountValue: 200, grandTotal: 30 }) });
    expect(r.status).toBe(200);
    expect(extraOf(id).financials).toEqual(stored);
    // and a line discount of a frozen PR is the stored one
    expect((await call('req', 'PUT', `/api/prs/${id}`, { items: [{ ...DISC_LINES()[0], discountAmount: 999, discountPercent: 0 }, DISC_LINES()[1]] })).status).toBe(200);
    expect(itemsOf(id)[0]).toMatchObject({ discountPercent: 10, discountAmount: 20 });
  });

  // ───────────── 5. roleId ─────────────
  it('user upsert : roleId is trimmed + upper-cased (\'buffer\' -> BUFFER, level 2) ; an unknown roleId is 400 ; known and already-held roles still work', async () => {
    const base = { username: 'newsu', name: 'New Su', department: 'PD', allowedDepartments: ['PD'], password: 'Abcdef123!', level: 99 };
    const c = await call('adm', 'POST', '/api/users', { ...base, id: 'U-N1', roleId: '  buffer ' });
    expect(c.status).toBe(200);
    expect(sdb.prepare('SELECT roleId, level, canonicalRole FROM users WHERE id = ?').get('U-N1')).toMatchObject({ roleId: 'BUFFER', level: 2, canonicalRole: 'BUFFER' });
    expect((await call('adm', 'POST', '/api/users', { ...base, id: 'U-N2', username: 'bad1', roleId: 'SUPERUSER' })).status).toBe(400);
    expect((await call('adm', 'POST', '/api/users', { ...base, id: 'U-N3', username: 'bad2', roleId: 'BUFFER_X' })).status).toBe(400);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM users WHERE id IN ('U-N2','U-N3')").get().c).toBe(0);
    for (const [i, roleId] of ['requester_pd', 'ASST_MANAGER', 'Plant_Manager', 'ONLINE_PURCHASER', 'REQUESTER_QC'].entries()) {
      const r = await call('adm', 'POST', '/api/users', { ...base, id: `U-K${i}`, username: `k${i}`, roleId, level: undefined });
      expect(r.status, roleId).toBe(200);
      expect(sdb.prepare('SELECT roleId FROM users WHERE id = ?').get(`U-K${i}`).roleId).toBe(roleId.toUpperCase());
    }
    // a role already held by a user row is accepted (legacy data) ; the stored role is kept when the body sends none
    sdb.prepare("UPDATE users SET roleId = 'LEGACY_ROLE' WHERE id = 'U1'").run();
    expect((await call('adm', 'PUT', '/api/users/U-K1', { id: 'U-K1', username: 'k1', name: 'K1', roleId: 'legacy_role' })).status).toBe(200);
    expect((await call('adm', 'PUT', '/api/users/U1', { id: 'U1', username: 'req', name: 'Req PD' })).status).toBe(200);
    expect(sdb.prepare('SELECT roleId FROM users WHERE id = ?').get('U1').roleId).toBe('LEGACY_ROLE');
  });

  // ───────────── 6. clamp / online ─────────────
  it('rbac.normalizeUser : BUFFER (any case) is level 2 and never admin / online, whatever the row says', () => {
    for (const level of [1, 2, 3, 5, 99, 120]) {
      expect(normalizeUser({ roleId: 'BUFFER', level })).toMatchObject({ isBuffer: true, isAdmin: false, level: 2 });
      expect(normalizeUser({ roleId: 'buffer', level })).toMatchObject({ isBuffer: true, isAdmin: false, level: 2 });
    }
    for (const u of [{ roleId: 'BUFFER', level: 2, positionKey: 'ONLINE_PURCHASER' }, { roleId: 'BUFFER', level: 2, title: 'Online Purchaser ONLINE_PURCHASER' }, { roleId: 'BUFFER', level: 2, canonicalRole: 'PURCHASER' }]) {
      expect(normalizeUser(u).isOnlineServer, JSON.stringify(u)).toBe(false);
      const p = resolvePermissions(u);
      expect(p).toMatchObject({ onlineish: false, canOnlinePurchase: false, isBuffer: true, level: 2 });
      expect(p, JSON.stringify(u)).toMatchObject({ canManageMaster: false, canDeleteMaster: false }); // M10: master data read-only
      expect(authorize(u, 'POST', '/api/products'), JSON.stringify(u)).toBe(false);
      expect(authorize(u, 'DELETE', '/api/vendors/V1'), JSON.stringify(u)).toBe(false);
    }
    // others keep their rules
    expect(normalizeUser({ roleId: 'ONLINE_PURCHASER', level: 2 }).isOnlineServer).toBe(true);
    expect(resolvePermissions({ roleId: 'ASST_MANAGER', level: 2, department: 'PD' })).toMatchObject({ canManageMaster: true, canDeleteMaster: true, isBuffer: false });
    expect(normalizeUser({ roleId: 'ADMIN', level: 99 })).toMatchObject({ isAdmin: true, isBuffer: false, level: 99 });
    expect(normalizeUser({ roleId: 'X', level: 99 })).toMatchObject({ isAdmin: true, level: 99 });
    expect(authorize({ roleId: 'BUFFER', level: 2, positionKey: 'ONLINE_PURCHASER' }, 'POST', '/api/pos/PO1/settle')).toBe(false);
    expect(authorize({ roleId: 'BUFFER', level: 99 }, 'POST', '/api/users')).toBe(false); // a stored 99 is not an admin
  });

  it('route : a BUFFER row stored with level 99 / roleId \'buffer\' signs in as level 2, is not an admin (users API 403), and still works as the checker', async () => {
    const me = (await call('sulow', 'GET', '/api/me')).json;
    expect(me.user).toMatchObject({ level: 2, isAdmin: false, isBuffer: true });
    expect((await call('sulow', 'POST', '/api/users', { id: 'U-Z', username: 'zz', name: 'z', roleId: 'REQUESTER', password: 'Abcdef123!' })).status).toBe(403);
    expect((await call('sulow', 'GET', '/api/audit-logs')).status).toBe(403);
    // stored level 3 / 99 on the canonical BUFFER row as well
    sdb.prepare("UPDATE users SET level = 99 WHERE id = 'U-BF'").run();
    expect((await call('su', 'POST', '/api/users', { id: 'U-Z', username: 'zz', name: 'z', roleId: 'REQUESTER', password: 'Abcdef123!' })).status).toBe(403);
    expect((await call('su', 'PUT', '/api/pos/PO-X', { status: 'CANCELLED' })).status).toBe(403);
    const id = await parked();
    expect((await forward(id)).status).toBe(200);
  });

  // ───────────── 7. one "active" rule ─────────────
  it('BUFFER count uses the login\'s rule : status ACTIVE, or isActive 1 / true with a blank status ; a closed account and look-alikes do not count', async () => {
    sdb.exec('ALTER TABLE users ADD COLUMN isActive INTEGER'); // the sheet-import schema carries it
    const closeAll = () => sdb.prepare("UPDATE users SET status = 'INACTIVE', isActive = 0 WHERE UPPER(roleId) = 'BUFFER'").run();
    closeAll();
    let id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    // isActive = 1, status blank -> counted (same as the login would let him in)
    sdb.prepare("UPDATE users SET status = '', isActive = 1 WHERE id = 'U-BP'").run();
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
    // and that account can indeed sign in (the two rules agree)
    const login = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sup', password: PASS }) }), env });
    expect(login.status).toBe(200);
    // status ACTIVE alone (isActive null) -> counted
    closeAll();
    sdb.prepare("UPDATE users SET status = 'ACTIVE', isActive = NULL WHERE id = 'U-BF'").run();
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
    // isActive = 0 / unknown status -> not counted ; the legacy spelling 'buffer' counts
    closeAll();
    sdb.prepare("UPDATE users SET status = 'SUSPENDED', isActive = 0 WHERE id = 'U-BF'").run();
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json).toMatchObject({ status: 'REVIEWED', bufferSkipped: true });
    sdb.prepare("UPDATE users SET status = 'ACTIVE', isActive = 1 WHERE id = 'U-BL'").run();
    id = await submitted();
    expect((await call('asst', 'PUT', `/api/prs/${id}`, { status: 'REVIEWED' })).json.status).toBe('PENDING_BUFFER');
  });
});
