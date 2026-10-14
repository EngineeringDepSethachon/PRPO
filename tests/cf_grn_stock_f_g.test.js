// @vitest-environment node
// Smoke-test bugs G (GRN stock) and F (PO amounts / status after goods receipt), server side of the real ReceivingModal flow :
//   PUT /api/pos/:id (the modal saves the PO with its grnHistory + received qty)  ->  POST /api/pos/:id/receive { stockOnly:true, grNumber, receivingItems }
// plus the quick-receive path (POST /receive without stockOnly), the ceilings / status gates / conversion lock found by the security + parity review.
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

d('GRN stock (G) and PO amounts / status (F)', () => {
  let sdb; let env; let token; let tokPm; let tokOnl; let tokAdm;
  const callWith = async (tok, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const call = (method, p, body) => callWith(token, method, p, body);
  const callPm = (method, p, body) => callWith(tokPm, method, p, body);
  const callOnl = (method, p, body) => callWith(tokOnl, method, p, body);
  const callAdm = (method, p, body) => callWith(tokAdm, method, p, body);
  const prod = (id = 'P1') => ({ ...sdb.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  const logs = (id = 'P1') => sdb.prepare("SELECT * FROM stock_logs WHERE productId = ? AND type = 'IN' ORDER BY rowid").all(id).map((r) => ({ ...r }));
  const po = () => ({ ...sdb.prepare('SELECT * FROM pos WHERE id = ?').get('PO-G1') });
  const all = () => sdb.prepare('SELECT * FROM stock_logs ORDER BY rowid').all().map((r) => ({ ...r }));
  const LINE = { productId: 'P1', code: 'C1', name: 'Item', qty: 5, purchaseQty: 5, price: 100 };
  const seed = ({ stock = 10, avg = 0, std = 0, conv = 1, items, status = 'ORDERED' } = {}) => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, standardPrice, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',?,?,?,?,0)").run(conv, stock, avg, std);
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('PO-G1', 'PO-PD-2026-001', 'PD001/2026', 'PD', status, 500, 35, 535,
        JSON.stringify(items || [LINE]), '{}', '[]', JSON.stringify({ vat: 35, subtotal: 500 }), 'SELF');
  };
  // what ReceivingModal does first : save the PO with the GRN entry + the cumulative received qty of the line
  const saveGrn = (grs, cumGood, line = LINE, extra = {}) => call('PUT', '/api/pos/PO-G1', {
    grnHistory: grs.map((g, i) => ({ grnNumber: g, round: i + 1, items: [] })),
    items: [{ ...line, receivedQty: cumGood, goodQty: cumGood }], ...extra
  });
  const stockReceive = (grNumber, goodQty, extra = {}) => call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber, receivingItems: [{ productId: 'P1', code: 'C1', goodQty, defectiveQty: 0, ...extra }] });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U1','wh','', 'Warehouse','PD','[\"PD\"]','REQUESTER_PD','REQUESTER',1,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U3','pm','', 'Plant','MGT','[\"*\"]','PLANT_MANAGER','APPROVER',3,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U4','onl','', 'Online','PUR','[\"*\"]','ONLINE_PURCHASER','PURCHASER',2,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES ('U5','adm','', 'Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE',?,?,?,?)")
      .run(rec.hash, rec.salt, rec.algo, rec.iterations);
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    const login =async (username) => (await (await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env })).json()).token;
    token = await login('wh');
    tokPm = await login('pm');
    tokOnl = await login('onl');
    tokAdm = await login('adm');
  });

  it('G1 full receive of 5 : ONE IN log (balance 15), stock 10 -> 15, MAC as GAS (10@0 + 5@100 = 33.33), PO row untouched by the stock call', async () => {
    seed();
    expect((await saveGrn([GR1], 5)).status).toBe(200);
    const r = await stockReceive(GR1, 5);
    expect(r.status).toBe(200);
    expect(prod()).toMatchObject({ currentStock: 15, avgCost: 33.33 });
    const l = logs();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ quantity: 5, balance: 15, docNo: GR1, conversionRate: 1 });
    expect(po()).toMatchObject({ grandTotal: 535, totalAmount: 500, vatAmount: 35 });
    expect(r.json.products[0]).toMatchObject({ currentStock: 15, stockBalance: 15, avgCost: 33.33 });
    expect(r.json.stockLogs).toHaveLength(1);
  });

  it('G1b MAC uses the standard price when there is no avg (10@80 + 5@100 = 86.67) ; no stock -> the incoming cost', async () => {
    seed({ stock: 10, avg: 0, std: 80 });
    await saveGrn([GR1], 5);
    await stockReceive(GR1, 5);
    expect(prod().avgCost).toBe(86.67);
  });

  it('G1c nothing in stock -> the incoming cost becomes the average', async () => {
    seed({ stock: 0, avg: 40 });
    await saveGrn([GR1], 5);
    await stockReceive(GR1, 5);
    expect(prod()).toMatchObject({ currentStock: 5, avgCost: 100 });
  });

  it('G2 retry / double click with the same GRN number adds nothing ; a NEW GRN number that is not on the PO is refused', async () => {
    seed();
    await saveGrn([GR1], 5);
    await stockReceive(GR1, 5);
    const again = await stockReceive(GR1, 5);
    expect(again.status).toBe(200);
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(1);
    const forged = await stockReceive('GRN-PO-PD-2026-001-99', 5);
    expect(forged.status).toBe(409);
    expect(prod().currentStock).toBe(15);
  });

  it('G3 two partial rounds : weighted average and balances follow ; the second round needs its own GRN on the PO and room on the line', async () => {
    seed({ stock: 10, avg: 50 });
    await saveGrn([GR1], 2);
    await stockReceive(GR1, 2);        // (10*50 + 2*100) / 12 = 58.33
    expect(prod()).toMatchObject({ currentStock: 12, avgCost: 58.33 });
    expect((await stockReceive(GR2, 3)).status).toBe(409); // GR2 is not on the PO yet
    await saveGrn([GR1, GR2], 5);
    expect((await stockReceive(GR2, 4)).status).toBe(409);  // more than the line holds (5 - 2 = 3 left)
    expect((await stockReceive(GR2, 3)).status).toBe(200);  // (12*58.33 + 3*100) / 15 = 66.66
    const p = prod();
    expect(p.currentStock).toBe(15);
    expect(p.avgCost).toBeCloseTo(66.66, 1);
    expect(logs().map((x) => x.balance)).toEqual([12, 15]);
    expect((await stockReceive(GR2, 3)).status).toBe(200); // same GRN again : no change
    expect(prod().currentStock).toBe(15);
  });

  it('G4 defective goods are not stocked (only goodQty)', async () => {
    seed();
    await saveGrn([GR1], 3, { ...LINE, damagedQty: 2 });
    await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 3, defectiveQty: 2 }] });
    expect(prod().currentStock).toBe(13);
    expect(logs().find((x) => x.type === 'IN').quantity).toBe(3);
  });

  it('S8 stock log rows carry grnNumber (= GRN) ; defective goods add an IN_NG row (qty, no stock), once per GRN, bound by the damaged qty of the saved line', async () => {
    seed();
    await saveGrn([GR1], 3, { ...LINE, damagedQty: 2 });
    const body = { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 3, defectiveQty: 2, defectReason: 'แตก' }] };
    const r = await call('POST', '/api/pos/PO-G1/receive', body);
    expect(r.status).toBe(200);
    expect(r.json.stockLogs).toHaveLength(2);
    const l = all();
    const inRow = l.find((x) => x.type === 'IN');
    const ng = l.find((x) => x.type === 'IN_NG');
    expect(inRow).toMatchObject({ grnNumber: GR1, docNo: GR1, quantity: 3, balance: 13 });
    expect(ng).toMatchObject({ grnNumber: GR1, docNo: GR1, docType: 'GRN', quantity: 2, balance: 13, poNo: 'PO-PD-2026-001' });
    expect(prod().currentStock).toBe(13);
    // retry : nothing again
    expect((await call('POST', '/api/pos/PO-G1/receive', body)).status).toBe(200);
    expect(all()).toHaveLength(2);
    expect(prod().currentStock).toBe(13);
    // more defective than the PO line holds : refused, nothing written
    await saveGrn([GR1, GR2], 4, { ...LINE, damagedQty: 2 });
    const over = await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR2, receivingItems: [{ productId: 'P1', goodQty: 1, defectiveQty: 2 }] });
    expect(over.status).toBe(409); // 5 ordered - 4 good = 1 not yet received good : 2 defective is too many
    expect(all()).toHaveLength(2);
    expect(prod().currentStock).toBe(13);
  });

  it('S8c an old GRN row with empty grnNumber is shown with docNo as grnNumber (stored row unchanged)', async () => {
    seed();
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, docType, docNo, quantity, balance, department) VALUES ('OLD1','P1','IN','GRN',?,1,11,'PD')").run(GR1);
    const r = await call('GET', '/api/stock-logs');
    expect(r.json.find((x) => x.id === 'OLD1').grnNumber).toBe(GR1);
    expect(all().find((x) => x.id === 'OLD1').grnNumber).toBeNull();
  });

  it('S8d stockOnly receipt that leaves the PO open : ONE GOODS_RECEIVED_PARTIAL audit + PO_CLAIM to Purchaser and Requester of the PO department ; a retry adds nothing', async () => {
    seed();
    await saveGrn([GR1], 2, LINE, { status: 'PARTIAL' });
    const audits = () => sdb.prepare("SELECT * FROM audit_logs WHERE action LIKE 'GOODS_RECEIVED%'").all().map((r) => ({ ...r }));
    const ntf = () => sdb.prepare("SELECT * FROM notifications WHERE type = 'PO_CLAIM' ORDER BY targetRole").all().map((r) => ({ ...r }));
    expect((await stockReceive(GR1, 2)).status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: 'GOODS_RECEIVED_PARTIAL', entityType: 'po', entityId: 'PO-G1', performedBy: 'U1' });
    expect(JSON.parse(audits()[0].details).comment).toBe(`ตรวจรับสินค้า เลขที่ ${GR1} บางส่วน`);
    expect(ntf().map((n) => [n.targetRole, n.targetDepartment, n.docRef])).toEqual([['Purchaser', 'PD', 'PO-PD-2026-001'], ['Requester', 'PD', 'PO-PD-2026-001']]);
    expect((await stockReceive(GR1, 2)).status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(ntf()).toHaveLength(2);
    // next round = its own GRN -> its own audit
    await saveGrn([GR1, GR2], 3, LINE, { status: 'PARTIAL' });
    expect((await stockReceive(GR2, 1)).status).toBe(200);
    expect(audits()).toHaveLength(2);
  });

  it('S8e stockOnly receipt that finishes the PO (COMPLETED) writes no audit and no notification ; a refused receipt writes none either', async () => {
    seed();
    await saveGrn([GR1], 5, LINE, { status: 'COMPLETED' });
    expect((await stockReceive(GR1, 5)).status).toBe(200);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'GOODS_RECEIVED%'").get().n).toBe(0);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type IN ('PO_CLAIM','GOODS_RECEIVED')").get().n).toBe(0);
  });

  it('S8f IN_NG ceiling is the server figure (ordered - stock logged - IN_NG logged), never the damagedQty a client PUT sets ; damagedQty is a number >= 0 clamped to the ordered qty and can go down / stay (claim flow)', async () => {
    seed();
    // a client inflating damagedQty : clamped to the ordered qty (5), and not used as the ceiling anyway
    const put = await saveGrn([GR1], 4, { ...LINE, damagedQty: 99 });
    expect(put.status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0].damagedQty).toBe(5);
    // ordered 5 - good 4 = 1 left for IN_NG : 2 is refused, 1 passes
    const bad = await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 4, defectiveQty: 2 }] });
    expect(bad.status).toBe(409);
    expect(all()).toHaveLength(0);
    expect(prod().currentStock).toBe(10);
    const ok = await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 4, defectiveQty: 1 }] });
    expect(ok.status).toBe(200);
    expect(all().map((x) => x.type).sort()).toEqual(['IN', 'IN_NG']);
    // only 1 not received good is left : 2 defective is refused, absurd figures too (1e7 : 409, above the request cap : 400)
    await saveGrn([GR1, GR2], 4, { ...LINE, damagedQty: 1 });
    const ngReq = (n) => call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR2, receivingItems: [{ productId: 'P1', goodQty: 0, defectiveQty: n }] });
    expect((await ngReq(2)).status).toBe(409);
    expect((await ngReq(1e7)).status).toBe(409);
    expect((await ngReq(1e9)).status).toBe(400);
    // negative / non numeric damagedQty : 400 ; claim REFUND / WRITE_OFF reset to 0 and REPLACEMENT keeps it : both saves pass
    expect((await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, receivedQty: 4, goodQty: 4, damagedQty: -1 }] })).status).toBe(400);
    expect((await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, receivedQty: 4, goodQty: 4, damagedQty: 'x' }] })).status).toBe(400);
    expect((await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, receivedQty: 4, goodQty: 4, damagedQty: 1 }] })).status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0].damagedQty).toBe(1);
    expect((await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, receivedQty: 4, goodQty: 4, damagedQty: 0 }] })).status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0].damagedQty).toBe(0);
  });

  it('S8i claim REPLACEMENT round 2 : ordered 10, round 1 good 8 + defective 2, round 2 good 1 + defective 1 (the replacement is defective again) -> both IN_NG rows exist', async () => {
    const line10 = { ...LINE, qty: 10, purchaseQty: 10 };
    seed({ items: [line10] });
    await saveGrn([GR1], 8, { ...line10, damagedQty: 2 });
    expect((await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 8, defectiveQty: 2 }] })).status).toBe(200);
    await saveGrn([GR1, GR2], 9, { ...line10, damagedQty: 3 });
    const r2 = await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR2, receivingItems: [{ productId: 'P1', goodQty: 1, defectiveQty: 1 }] });
    expect(r2.status).toBe(200);
    expect(all().filter((x) => x.type === 'IN_NG').map((x) => [x.docNo, x.quantity])).toEqual([[GR1, 2], [GR2, 1]]);
    expect(prod().currentStock).toBe(19);
  });

  it('S8g stockOnly with nothing to book (no line / 0 good and 0 defective) is 400 and writes no audit / notification ; a PO row without department sends no notification', async () => {
    seed({ status: 'PARTIAL' });
    await saveGrn([GR1], 0, LINE, { status: 'PARTIAL' });
    expect((await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [] })).status).toBe(400);
    expect((await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 0, defectiveQty: 0 }] })).status).toBe(400);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'GOODS_RECEIVED%'").get().n).toBe(0);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'PO_CLAIM'").get().n).toBe(0);
    await saveGrn([GR1], 2, LINE, { status: 'PARTIAL' });
    sdb.prepare("UPDATE pos SET department = '' WHERE id = 'PO-G1'").run();
    await stockReceive(GR1, 2).catch(() => null);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM notifications").get().n).toBe(0);
  });

  it('S8h long GRN numbers that share the first 60+ characters get different notification ids ; a retry reuses them', async () => {
    seed();
    const longGr = (n) => `GRN-${'A'.repeat(70)}-${n}`;
    await saveGrn([longGr(1), longGr(2)], 2, LINE, { status: 'PARTIAL' });
    expect((await stockReceive(longGr(1), 1)).status).toBe(200);
    expect((await stockReceive(longGr(2), 1)).status).toBe(200);
    expect((await stockReceive(longGr(2), 1)).status).toBe(200);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'PO_CLAIM'").get().n).toBe(4);
  });

  it('S8b defective-only line (good 0) writes just the IN_NG row ; full receive (not stockOnly) writes IN + IN_NG with grnNumber, the stock gets the good qty only', async () => {
    seed();
    await saveGrn([GR1], 0, { ...LINE, damagedQty: 1 });
    expect((await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 0, defectiveQty: 1 }] })).status).toBe(200);
    expect(all().map((x) => x.type)).toEqual(['IN_NG']);
    expect(prod().currentStock).toBe(10);
    const full = await call('POST', '/api/pos/PO-G1/receive', { grNumber: GR2, receivingItems: [{ productId: 'P1', goodQty: 2, defectiveQty: 1 }] });
    expect(full.status).toBe(200);
    const l = all().filter((x) => x.docNo === GR2);
    expect(l.map((x) => x.type).sort()).toEqual(['IN', 'IN_NG']);
    expect(l.every((x) => x.grnNumber === GR2)).toBe(true);
    expect(prod().currentStock).toBe(12);
  });

  it('G5 conversion : 2 boxes x 12 pcs at 120 per box -> +24 pcs, cost 10 per pc ; conversion cannot be re-set by a save, nor be out of range', async () => {
    const line = { productId: 'P1', code: 'C1', name: 'Item', qty: 2, price: 120, conversionRate: 12 };
    seed({ stock: 0, avg: 0, items: [line] });
    // a receiver raising the conversion before the receipt : the stored one stays
    const hack = await call('PUT', '/api/pos/PO-G1', { items: [{ ...line, conversionRate: 9000 }] });
    expect(hack.status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0].conversionRate).toBe(12);
    const huge = await call('PUT', '/api/pos/PO-G1', { items: [{ ...line, conversionRate: 1e6 }] });
    expect(huge.status).toBe(400);
    await saveGrn([GR1], 2, line);
    await stockReceive(GR1, 2);
    expect(prod()).toMatchObject({ currentStock: 24, avgCost: 10 });
    expect(logs()[0]).toMatchObject({ quantity: 24, balance: 24, conversionRate: 12 });
  });

  it('G6 quick receive (POST /receive without stockOnly) : partial -> PARTIAL, the next round is accepted, then CLOSED ; over the ordered qty / DRAFT refused', async () => {
    seed();
    const r1 = await call('POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty: 2 }], grNumber: GR1 });
    expect(r1.status).toBe(200);
    expect(po().status).toBe('PARTIAL');
    expect(prod()).toMatchObject({ currentStock: 12, avgCost: 16.67 });
    const over = await call('POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty: 4 }], grNumber: GR2 });
    expect(over.status).toBe(400);
    expect(prod().currentStock).toBe(12);
    const r2 = await call('POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty: 3 }], grNumber: GR2 });
    expect(r2.status).toBe(200);
    expect(po()).toMatchObject({ status: 'CLOSED', grandTotal: 535 });
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(2);
    const again = await call('POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty: 5 }], grNumber: 'GRN-PO-PD-2026-001-03' });
    expect(again.json.duplicate).toBe(true);
    expect(prod().currentStock).toBe(15);
  });

  it('G7 status gates, GRN number and cancelled PO', async () => {
    seed({ status: 'DRAFT' });
    expect((await call('POST', '/api/pos/PO-G1/receive', { receivingItems: [{ productId: 'P1', goodQty: 1 }], grNumber: GR1 })).status).toBe(409);
    await saveGrn([GR1], 5).catch(() => null);
    expect((await stockReceive(GR1, 1)).status).toBe(409);
    expect(prod().currentStock).toBe(10);
    sdb.prepare("UPDATE pos SET status = 'ORDERED' WHERE id = 'PO-G1'").run();
    const noGr = await call('POST', '/api/pos/PO-G1/receive', { stockOnly: true, receivingItems: [{ productId: 'P1', goodQty: 1 }] });
    expect(noGr.status).toBe(400);
    sdb.prepare("UPDATE pos SET status = 'CANCELLED' WHERE id = 'PO-G1'").run();
    expect((await stockReceive(GR1, 1)).status).toBe(409);
    expect(prod().currentStock).toBe(10);
  });

  it('G8 the same product twice in one request is ONE receipt (quantities added), repeating it in any order adds nothing', async () => {
    seed();
    await saveGrn([GR1], 5);
    const body = { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 2 }, { code: 'C1', goodQty: 3 }] };
    expect((await call('POST', '/api/pos/PO-G1/receive', body)).status).toBe(200);
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(1);
    expect(logs()[0].quantity).toBe(5);
    expect((await call('POST', '/api/pos/PO-G1/receive', { ...body, receivingItems: [...body.receivingItems].reverse() })).status).toBe(200);
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(1);
  });

  it('G9 race : two different GRNs asking for the room of one -> exactly one adds stock', async () => {
    seed();
    await saveGrn([GR1, GR2], 5);
    const [a, b] = await Promise.all([stockReceive(GR1, 5), stockReceive(GR2, 5)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(prod().currentStock).toBe(15);
    expect(logs()).toHaveLength(1);
  });

  it('G10 absurd quantities are refused', async () => {
    seed();
    await saveGrn([GR1], 5);
    expect((await stockReceive(GR1, 1e9)).status).toBe(400);
    await stockReceive(GR1, Number.NaN); // JSON null -> no quantity -> nothing stocked
    expect(prod().currentStock).toBe(10);
  });

  it('G11 from the first receivable status (ISSUED / PO_ISSUED) a receiver cannot raise the ordered qty / price, nor the received qty above the order', async () => {
    for (const st of ['ISSUED', 'PO_ISSUED']) {
      sdb.exec('DELETE FROM pos; DELETE FROM products; DELETE FROM stock_logs;');
      seed({ status: st });
      const r = await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, qty: 500, purchaseQty: 500, orderedQty: 500, price: 9999, receivedQty: 500, goodQty: 500 }], grnHistory: [{ grnNumber: GR1 }] });
      expect(r.status).toBe(200);
      const it = JSON.parse(po().itemsJson)[0];
      expect(it).toMatchObject({ qty: 5, purchaseQty: 5, price: 100 });
      expect(it.goodQty).toBe(5); // capped at the stored ordered qty
      expect((await stockReceive(GR1, 6)).status).toBe(409);
      expect(prod().currentStock).toBe(10);
    }
  });

  it('G12 the ceiling is the good qty : defective goods in receivedQty give no room', async () => {
    seed();
    await call('PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1 }], items: [{ ...LINE, receivedQty: 5, goodQty: 2, defectiveQty: 3 }] });
    expect((await stockReceive(GR1, 3)).status).toBe(409);
    expect((await stockReceive(GR1, 2)).status).toBe(200);
    expect(prod().currentStock).toBe(12);
  });

  it('G13 POST /api/stock-logs ignores receipt rows (GRN docType, LOG: ids) : they cannot reserve ids nor eat a PO ceiling', async () => {
    seed();
    const r = await call('POST', '/api/stock-logs', [
      { id: `LOG:PO-G1:${GR1}:0`, productId: 'P1', type: 'IN', docType: 'GRN', quantity: 5, balance: 15 },
      { id: 'MOV-x', productId: 'P1', type: 'IN', docType: 'GRN', quantity: 5, balance: 15 },
      { id: 'MOV-manual', productId: 'P1', type: 'IN', docType: 'MANUAL_IN', quantity: 1, balance: 11 }
    ]);
    expect(r.status).toBe(200);
    expect(r.json.ignored).toHaveLength(2);
    expect(r.json.count).toBe(1);
    expect(logs().map((l) => l.id)).toEqual(['MOV-manual']);
    await saveGrn([GR1], 5);
    expect((await stockReceive(GR1, 5)).status).toBe(200);
    expect(prod().currentStock).toBe(15);
  });

  it('G14 full receive repeated with the same GRN while the PO is PARTIAL adds nothing the second time', async () => {
    seed();
    const body = { receivingItems: [{ productId: 'P1', goodQty: 2 }], grNumber: GR1 };
    expect((await call('POST', '/api/pos/PO-G1/receive', body)).status).toBe(200);
    const again = await call('POST', '/api/pos/PO-G1/receive', body);
    expect(again.json.duplicate).toBe(true);
    expect(prod().currentStock).toBe(12);
    expect(JSON.parse(po().itemsJson)[0].receivedQty).toBe(2);
    expect(JSON.parse(po().extraJson).grnHistory).toHaveLength(1);
    expect(logs()).toHaveLength(1);
  });

  it('F1 the PO save keeps the amounts when the client does not resend them, and COMPLETED (GAS apiReceivePO status) is stored as sent', async () => {
    seed();
    await saveGrn([GR1], 5);
    await stockReceive(GR1, 5);
    const put = await call('PUT', '/api/pos/PO-G1', { status: 'COMPLETED', items: [{ ...LINE, receivedQty: 5, goodQty: 5 }] });
    expect(put.status).toBe(200);
    expect(po()).toMatchObject({ status: 'COMPLETED', grandTotal: 535, totalAmount: 500, vatAmount: 35 });
    // stock call repeated after the PO is COMPLETED : still idempotent
    expect((await stockReceive(GR1, 5)).status).toBe(200);
    expect(prod().currentStock).toBe(15);
  });

  it('F2 a new PO posted with the client shape stores consistent amounts ; a negative / non-numeric amount is refused', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','Warehouse','APPROVED',500,'[]')").run();
    sdb.prepare("UPDATE prs SET itemsJson = ? WHERE id = 'PR-1'").run(JSON.stringify([{ productId: 'P1', qty: 5, price: 100, conversionRate: 2 }]));
    const bad = await callPm('POST', '/api/pos', { id: 'PO-BAD', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', grandTotal: -5, items: [{ productId: 'P1', qty: 5 }] });
    expect(bad.status).toBe(400);
    const r = await callPm('POST', '/api/pos', { id: 'PO-NEW', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', subtotal: 500, vat: 35, grandTotal: 535, items: [{ productId: 'P1', qty: 5, price: 100, conversionRate: 9000 }] });
    expect(r.status).toBe(200);
    const row = sdb.prepare('SELECT totalAmount, vatAmount, grandTotal, itemsJson FROM pos WHERE id = ?').get('PO-NEW');
    expect({ totalAmount: row.totalAmount, vatAmount: row.vatAmount, grandTotal: row.grandTotal }).toEqual({ totalAmount: 500, vatAmount: 35, grandTotal: 535 });
    expect(JSON.parse(row.itemsJson)[0].conversionRate).toBe(2); // conversion comes from the PR line, not the body
  });

  it('G15 creating a PO : only the PR approver (not the requester), first status ISSUED / IN_PROGRESS_ONLINE, lines from the PR, total qty of the PR\'s POs within the PR (split PO passes)', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','Warehouse','APPROVED',500,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 6, price: 10 }, { productId: 'P2', qty: 4, price: 10 }]));
    const po = (id, items, over = {}) => ({ id, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items, ...over });
    expect((await call('POST', '/api/pos', po('A', [{ productId: 'P1', qty: 1 }]))).status).toBe(403); // requester
    expect((await callPm('POST', '/api/pos', po('A', [{ productId: 'P1', qty: 1 }], { status: 'ORDERED' }))).status).toBe(400); // first status
    expect((await callPm('POST', '/api/pos', po('A', [{ productId: 'PX', qty: 1 }]))).status).toBe(400); // not a PR product
    expect((await callPm('POST', '/api/pos', po('A', [{ productId: 'P1', qty: 7 }]))).status).toBe(400); // over the PR qty
    expect((await callPm('POST', '/api/pos', po('A', [{ productId: 'P1', qty: 4 }, { productId: 'P2', qty: 4 }]))).status).toBe(200);
    // split PO : the rest of the PR goes to a second PO ; one more unit does not
    expect((await callPm('POST', '/api/pos', po('B', [{ productId: 'P1', qty: 3 }]))).status).toBe(400);
    expect((await callPm('POST', '/api/pos', po('B', [{ productId: 'P1', qty: 2 }]))).status).toBe(200);
    // a cancelled PO gives its qty back
    sdb.prepare("UPDATE pos SET status = 'CANCELLED' WHERE id = 'B'").run();
    expect((await callPm('POST', '/api/pos', po('C', [{ productId: 'P1', qty: 2 }]))).status).toBe(200);
    // one request with two split POs counts both
    sdb.prepare("UPDATE pos SET status = 'CANCELLED'").run();
    const two = await callPm('POST', '/api/pos', [po('D', [{ productId: 'P1', qty: 4 }]), po('E', [{ productId: 'P1', qty: 3 }])]);
    expect(two.status).toBe(400);
  });

  it('G16 a PO past the ordering step cannot be moved back to DRAFT to unlock its lines (403) ; lines keep their position (swap = 400)', async () => {
    seed({ status: 'PARTIAL', items: [LINE, { productId: 'P2', code: 'C2', name: 'B', qty: 3, price: 5 }] });
    expect((await call('PUT', '/api/pos/PO-G1', { status: 'DRAFT' })).status).toBe(403);
    expect((await call('PUT', '/api/pos/PO-G1', { status: 'SUBMITTED' })).status).toBe(403);
    expect(po().status).toBe('PARTIAL');
    const swapped = await call('PUT', '/api/pos/PO-G1', { items: [{ productId: 'P2', code: 'C2', name: 'B', qty: 3, price: 5 }, LINE] });
    expect(swapped.status).toBe(400);
    expect(JSON.parse(po().itemsJson)[0].productId).toBe('P1');
  });

  it('G17 once goods are received nobody but admin can change qty / price / actual price - the online purchaser can before (ordering status, nothing received)', async () => {
    seed({ status: 'IN_PROGRESS_ONLINE', items: [{ ...LINE, actualPrice: 100 }] });
    expect((await callOnl('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, qty: 4, purchaseQty: 4, price: 90, actualPrice: 90 }] })).status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0]).toMatchObject({ qty: 4, price: 90 });
    // received now : locked for the online purchaser as well
    sdb.prepare("UPDATE pos SET itemsJson = ? WHERE id = 'PO-G1'").run(JSON.stringify([{ ...LINE, qty: 4, purchaseQty: 4, price: 90, actualPrice: 90, receivedQty: 2, goodQty: 2 }]));
    await callOnl('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, qty: 1, purchaseQty: 1, price: 1, actualPrice: 1, receivedQty: 2, goodQty: 2 }] });
    expect(JSON.parse(po().itemsJson)[0]).toMatchObject({ qty: 4, price: 90, actualPrice: 90 });
    // and a GRN on the PO counts as started even when the line shows nothing
    sdb.prepare("UPDATE pos SET itemsJson = ?, status = 'PARTIAL', extraJson = ? WHERE id = 'PO-G1'").run(JSON.stringify([{ ...LINE }]), JSON.stringify({ grnHistory: [{ grnNumber: GR1 }] }));
    await call('PUT', '/api/pos/PO-G1', { items: [{ ...LINE, qty: 50, actualPrice: 1 }] });
    expect(JSON.parse(po().itemsJson)[0]).toMatchObject({ qty: 5 });
    expect(JSON.parse(po().itemsJson)[0].actualPrice).toBeUndefined();
  });

  it('G19 PO status is normalised (trim + upper-case) at the single entry : the transition rules see the real status, unknown / non-string values are 400', async () => {
    seed({ status: 'PARTIAL' });
    for (const s of ['draft', ' Draft ', 'SUBMITTED ', 'pending_approval']) expect((await call('PUT', '/api/pos/PO-G1', { status: s })).status).toBe(403);
    for (const s of ['bogus', 'ORDERED;', 7, { a: 1 }, ['DRAFT']]) expect((await call('PUT', '/api/pos/PO-G1', { status: s })).status).toBe(400);
    expect(po().status).toBe('PARTIAL');
    // a legacy lower-case status in the DB is read normalised : moving it back is refused as well
    sdb.prepare("UPDATE pos SET status = ' partial ' WHERE id = 'PO-G1'").run();
    expect((await call('PUT', '/api/pos/PO-G1', { status: 'draft' })).status).toBe(403);
    // the value that is stored is the normalised one
    expect((await call('PUT', '/api/pos/PO-G1', { status: ' claim_reported ' })).status).toBe(200);
    expect(po().status).toBe('CLAIM_REPORTED');
    // the same through the POST upsert
    expect((await call('POST', '/api/pos', { id: 'PO-G1', status: ' Draft ' })).status).toBe(403);
    expect((await call('POST', '/api/pos', { id: 'PO-G1', status: 'nope' })).status).toBe(400);
  });

  it('G20 qty keys of a new PO line are one figure (the highest sent) and the PR ceiling uses it ; conflicting keys cannot hide a big qty', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 6 }]));
    const mk = (id, line) => ({ id, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [line] });
    expect((await callPm('POST', '/api/pos', mk('A', { productId: 'P1', qty: 1, purchaseQty: 1, orderedQty: 99 }))).status).toBe(400);
    expect((await callPm('POST', '/api/pos', mk('A', { productId: 'P1', qty: 99, purchaseQty: 1 }))).status).toBe(400);
    expect((await callPm('POST', '/api/pos', mk('A', { productId: 'P1', qty: 2, purchaseQty: 4, orderedQty: 3 }))).status).toBe(200);
    expect(JSON.parse(sdb.prepare("SELECT itemsJson FROM pos WHERE id = 'A'").get().itemsJson)[0]).toMatchObject({ qty: 4, purchaseQty: 4, orderedQty: 4 });
  });

  it('G21 a PO cancelled after a partial receipt still counts what it received : a new PO cannot take the whole PR again ; the PR-level stock ceiling holds', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 6 }]));
    const mk = (id, qty) => ({ id, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty }] });
    expect((await callPm('POST', '/api/pos', mk('A', 6))).status).toBe(200);
    // 4 received (partial), then the PO is cancelled (the web allows it)
    sdb.prepare("UPDATE pos SET status = 'PARTIAL', itemsJson = ? WHERE id = 'A'").run(JSON.stringify([{ productId: 'P1', qty: 6, purchaseQty: 6, orderedQty: 6, receivedQty: 4, goodQty: 4 }]));
    expect((await callPm('PUT', '/api/pos/A', { status: 'CANCELLED' })).status).toBe(200);
    expect((await callPm('POST', '/api/pos', mk('B', 3))).status).toBe(400); // 4 received + 3 > 6
    expect((await callPm('POST', '/api/pos', mk('B', 2))).status).toBe(200);
    // PR-level ceiling on the stock itself : a PO the server did not limit (admin-made) cannot add more than the PR holds over all its POs
    sdb.prepare("UPDATE pos SET poNumber = 'PO-A-NO' WHERE id = 'A'").run();
    sdb.prepare("UPDATE pos SET poNumber = 'PO-B-NO' WHERE id = 'B'").run();
    seed();
    sdb.prepare("UPDATE pos SET prNumber = 'PD001/2026' WHERE id = 'PO-G1'").run();
    sdb.prepare("UPDATE prs SET itemsJson = ? WHERE id = 'PR-1'").run(JSON.stringify([{ productId: 'P1', qty: 5 }]));
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, docType, docNo, poNo, quantity, balance, department) VALUES ('LOG:A:GRN-A:0','P1','IN','GRN','GRN-A','A',3,13,'PD')").run();
    sdb.prepare("UPDATE stock_logs SET poNo = 'PO-A-NO'").run();
    await saveGrn([GR1], 5);
    expect((await stockReceive(GR1, 5)).status).toBe(409); // 3 already in from the PR's other PO + 5 > 5
    expect(prod().currentStock).toBe(10);
    await saveGrn([GR1], 2);
    expect((await stockReceive(GR1, 2)).status).toBe(200);
    expect(prod().currentStock).toBe(12);
  });

  it('G22 a PR approved with no stored lines : a non-admin cannot issue a PO for it (400), admin can', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,'[]')").run();
    const body = (id) => ({ id, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 1 }] });
    const r = await callPm('POST', '/api/pos', body('A'));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('admin');
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM pos").get().n).toBe(0);
  });

  it('G23 no step back : ORDERED -> ISSUED / IN_PROGRESS_ONLINE, DRAFT -> ISSUED and a finished PO -> ORDERED / PARTIAL are 403 ; the claim flow can still re-open a finished PO', async () => {
    seed({ status: 'ORDERED' });
    for (const s of ['ISSUED', 'IN_PROGRESS_ONLINE', 'PO_ISSUED']) expect((await call('PUT', '/api/pos/PO-G1', { status: s })).status).toBe(403);
    expect((await call('PUT', '/api/pos/PO-G1', { status: 'IN_DELIVERY' })).status).toBe(200);
    sdb.prepare("UPDATE pos SET status = 'DRAFT' WHERE id = 'PO-G1'").run();
    expect((await call('PUT', '/api/pos/PO-G1', { status: 'ISSUED' })).status).toBe(403);
    for (const done of ['COMPLETED', 'CLOSED']) {
      sdb.prepare('UPDATE pos SET status = ? WHERE id = ?').run(done, 'PO-G1');
      for (const s of ['ORDERED', 'PARTIAL', 'IN_DELIVERY']) expect((await call('PUT', '/api/pos/PO-G1', { status: s })).status).toBe(403);
      for (const s of ['CLAIM_REPORTED', 'CLAIM_PENDING', 'WAITING_DELIVERY_ROUND_2', 'COMPLETED_WITH_REFUND']) {
        sdb.prepare('UPDATE pos SET status = ? WHERE id = ?').run(done, 'PO-G1');
        expect((await call('PUT', '/api/pos/PO-G1', { status: s })).status).toBe(200);
      }
    }
  });

  it('G25 an approved PR keeps its stored qty / price / conversion whatever the body says ; lines cannot be added, removed or swapped', async () => {
    const lines = [{ productId: 'P1', qty: 6, purchaseQty: 6, orderedQty: 6, price: 10, conversionRate: 2 }, { productId: 'P2', qty: 3, purchaseQty: 3, price: 5 }];
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)").run(JSON.stringify(lines));
    const hack = [{ ...lines[0], orderedQty: 600, qty: 6, conversionRate: 9999, conversionRatio: 9999, unitPrice: 1, note: 'kept' }, { ...lines[1], orderedQty: 50, conversionRate: 77 }];
    const r = await callPm('PUT', '/api/prs/PR-1', { items: hack });
    expect(r.status).toBe(200);
    const saved = JSON.parse(sdb.prepare("SELECT itemsJson FROM prs WHERE id = 'PR-1'").get().itemsJson);
    expect(saved[0]).toMatchObject({ qty: 6, orderedQty: 6, conversionRate: 2, note: 'kept' });
    expect(saved[0].conversionRatio).toBeUndefined();
    expect(saved[0].unitPrice).toBeUndefined();
    expect(saved[1].orderedQty).toBeUndefined();
    expect(saved[1].conversionRate).toBeUndefined();
    expect((await callPm('PUT', '/api/prs/PR-1', { items: [...lines, { productId: 'P3', qty: 1 }] })).status).toBe(403);
    expect((await callPm('PUT', '/api/prs/PR-1', { items: [lines[0]] })).status).toBe(403);
    expect((await callPm('PUT', '/api/prs/PR-1', { items: [lines[1], lines[0]] })).status).toBe(403);
  });

  it('G26 online purchaser : may change qty / price of the PO at IN_PROGRESS_ONLINE, may not change the line conversion nor add a line', async () => {
    seed({ status: 'IN_PROGRESS_ONLINE', items: [{ ...LINE, conversionRate: 3 }] });
    const ok = await callOnl('PUT', '/api/pos/PO-G1', { status: 'ORDERED', items: [{ ...LINE, qty: 4, purchaseQty: 4, price: 90, conversionRate: 500 }] });
    expect(ok.status).toBe(200);
    expect(JSON.parse(po().itemsJson)[0]).toMatchObject({ qty: 4, price: 90, conversionRate: 3 });
    sdb.prepare("UPDATE pos SET status = 'IN_PROGRESS_ONLINE' WHERE id = 'PO-G1'").run();
    expect((await callOnl('PUT', '/api/pos/PO-G1', { items: [{ ...LINE }, { productId: 'P9', qty: 1 }] })).status).toBe(400);
  });

  it('G27 receipt uses the line conversion, else 1 (never the product\'s) ; a new PO snapshots the product\'s conversion onto lines the PR has none for', async () => {
    seed({ conv: 12 });                      // product master says 12, the PO line carries none
    await saveGrn([GR1], 5);
    await stockReceive(GR1, 5);
    expect(prod().currentStock).toBe(15);    // +5 x 1
    sdb.exec('DELETE FROM pos; DELETE FROM stock_logs;');
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 5 }]));
    expect((await callPm('POST', '/api/pos', { id: 'NEW', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 5 }] })).status).toBe(200);
    expect(JSON.parse(sdb.prepare("SELECT itemsJson FROM pos WHERE id = 'NEW'").get().itemsJson)[0].conversionRate).toBe(12);
  });

  it('G28 the PR-level stock ceiling also pairs POs that reference the PR by id only', async () => {
    seed();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)").run(JSON.stringify([{ productId: 'P1', qty: 5 }]));
    sdb.prepare("INSERT INTO pos (id, poNumber, prId, department, status, itemsJson) VALUES ('OTH','PO-OTH','PR-1','PD','PARTIAL','[]')").run();
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, docType, docNo, poNo, quantity, balance, department) VALUES ('LOG:OTH:G:0','P1','IN','GRN','G','PO-OTH',4,14,'PD')").run();
    await saveGrn([GR1], 5);
    expect((await stockReceive(GR1, 5)).status).toBe(409); // 4 in from OTH (by prId) + 5 > 5
    expect(prod().currentStock).toBe(10);
  });

  it('G29 the same product on two PR rows with different rates (box x12 + piece x1) : the PO lines pair with their own rows, receiving each line gives sum(qty x rate), over-receipt is refused', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',1,0,0,0)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 2, price: 120, conversionRate: 12 }, { productId: 'P1', qty: 10, price: 10, conversionRate: 1 }]));
    const lines = [{ productId: 'P1', qty: 2, price: 120, conversionRate: 777 }, { productId: 'P1', qty: 10, price: 10, conversionRate: 777 }];
    expect((await callPm('POST', '/api/pos', { id: 'PO-G1', poNumber: 'PO-PD-2026-001', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: lines })).status).toBe(200);
    expect(JSON.parse(po().itemsJson).map((l) => l.conversionRate)).toEqual([12, 1]);
    // a split PO that holds only the piece row pairs with the piece row (its rate is the hint) and a third copy of the box row does not fit
    expect((await callPm('POST', '/api/pos', { id: 'PO-S', poNumber: 'PO-S', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 1, conversionRate: 1 }] })).status).toBe(400);
    // receive : both lines in one request, by lineIndex, then the repeat of the product without lineIndex goes to the next line
    const put = await call('PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1 }], items: [{ ...lines[0], conversionRate: 12, receivedQty: 2, goodQty: 2 }, { ...lines[1], conversionRate: 1, receivedQty: 10, goodQty: 10 }] });
    expect(put.status).toBe(200);
    const r = await call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 2 }, { productId: 'P1', goodQty: 10 }] });
    expect(r.status).toBe(200);
    expect(prod().currentStock).toBe(2 * 12 + 10);
    expect(logs().map((l) => l.quantity).sort((a, b) => a - b)).toEqual([10, 24]);
    // nothing more can come in : not through the lines, nor through the PR ceiling
    expect((await call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR1, receivingItems: [{ productId: 'P1', goodQty: 1, lineIndex: 0 }] })).status).toBe(200); // same GRN : idempotent
    expect(prod().currentStock).toBe(34);
    await call('PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1 }, { grnNumber: GR2 }], items: [{ ...lines[0], conversionRate: 12, receivedQty: 2, goodQty: 2 }, { ...lines[1], conversionRate: 1, receivedQty: 10, goodQty: 10 }] });
    expect((await call('POST', '/api/pos/PO-G1/receive', { poId: 'PO-G1', stockOnly: true, grNumber: GR2, receivingItems: [{ productId: 'P1', goodQty: 1, lineIndex: 1 }] })).status).toBe(409);
    expect(prod().currentStock).toBe(34);
  });

  it('G31 prRowIndex : written by the server at PO creation, used to count what older POs took (no re-pairing by rate), a client value has no effect', async () => {
    const mkPr = (rows) => sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)").run(JSON.stringify(rows));
    const mk = (id, line) => ({ id, poNumber: `PO-${id}`, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [line] });
    const idxOf = (id) => JSON.parse(sdb.prepare('SELECT itemsJson FROM pos WHERE id = ?').get(id).itemsJson)[0].prRowIndex;
    // (a) PR rows with no rate : the product's rate (12) is snapshotted on PO1's line ; PO2 must land on the other row, not be refused / re-paired by rate
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',12,0,0,0)").run();
    mkPr([{ productId: 'P1', qty: 3 }, { productId: 'P1', qty: 3, conversionRate: 1 }]);
    expect((await callPm('POST', '/api/pos', mk('A', { productId: 'P1', qty: 3, prRowIndex: 1 }))).status).toBe(200); // the client's prRowIndex is ignored
    expect(idxOf('A')).toBe(0);
    expect((await callPm('POST', '/api/pos', mk('B', { productId: 'P1', qty: 3, conversionRate: 12 }))).status).toBe(200);
    expect(idxOf('B')).toBe(1);
    expect((await callPm('POST', '/api/pos', mk('C', { productId: 'P1', qty: 1 }))).status).toBe(400);
    // the stored index cannot be moved by a save
    await callPm('PUT', '/api/pos/A', { items: [{ productId: 'P1', qty: 3, prRowIndex: 1 }] });
    expect(idxOf('A')).toBe(0);
    // (b) two rows of the same product with the same rate, split into two POs : the second is not refused
    sdb.exec('DELETE FROM pos; DELETE FROM prs;');
    mkPr([{ productId: 'P1', qty: 3, conversionRate: 2 }, { productId: 'P1', qty: 3, conversionRate: 2 }]);
    expect((await callPm('POST', '/api/pos', mk('D', { productId: 'P1', qty: 3 }))).status).toBe(200);
    expect((await callPm('POST', '/api/pos', mk('E', { productId: 'P1', qty: 3 }))).status).toBe(200);
    expect([idxOf('D'), idxOf('E')]).toEqual([0, 1]);
    expect((await callPm('POST', '/api/pos', mk('F', { productId: 'P1', qty: 1 }))).status).toBe(400);
  });

  it('G32 PR-level stock ceiling : a PR row with no rate takes the rate snapshotted on its paired PO line', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',12,0,0,0)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)").run(JSON.stringify([{ productId: 'P1', qty: 3 }]));
    expect((await callPm('POST', '/api/pos', { id: 'PO-G1', poNumber: 'PO-PD-2026-001', prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 3, price: 10 }] })).status).toBe(200);
    const line = JSON.parse(po().itemsJson)[0];
    expect(line).toMatchObject({ conversionRate: 12, prRowIndex: 0 });
    await call('PUT', '/api/pos/PO-G1', { grnHistory: [{ grnNumber: GR1 }], items: [{ ...line, receivedQty: 3, goodQty: 3 }] });
    expect((await stockReceive(GR1, 3)).status).toBe(200);
    expect(prod().currentStock).toBe(36); // 3 x 12 within the PR's 3 x 12
  });

  const twoPoSetup = async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, isDeleted) VALUES ('P1','C1','Item','PD','PD','box','pcs',12,0,0,0)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-1','PD001/2026','PD','U1','W','APPROVED',500,?)").run(JSON.stringify([{ productId: 'P1', qty: 3 }, { productId: 'P1', qty: 3 }]));
    for (const id of ['PO-G1', 'PO-G2']) {
      const r = await callPm('POST', '/api/pos', { id, poNumber: `PO-${id}`, prNumber: 'PD001/2026', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 3, price: 10 }] });
      expect(r.status).toBe(200);
    }
  };
  const receiveAll = async (id, gr) => {
    const line = JSON.parse(sdb.prepare('SELECT itemsJson FROM pos WHERE id = ?').get(id).itemsJson)[0];
    await call('PUT', `/api/pos/${id}`, { grnHistory: [{ grnNumber: gr }], items: [{ ...line, receivedQty: 3, goodQty: 3 }] });
    return call('POST', `/api/pos/${id}/receive`, { poId: id, stockOnly: true, grNumber: gr, receivingItems: [{ productId: 'P1', goodQty: 3 }] });
  };

  it('G33 PR rows with no rate, one PO per row (snapshot 12 on both) : both POs can be received in full (72), nothing beyond', async () => {
    await twoPoSetup();
    expect((await receiveAll('PO-G1', 'GRN-A-01')).status).toBe(200);
    expect((await receiveAll('PO-G2', 'GRN-B-01')).status).toBe(200);
    expect(prod().currentStock).toBe(72);
    // one more unit (a line the server did not size : direct row) is over the PR's 72
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('PO-G3','PO-G3','PD001/2026','PD','ISSUED',?,?)")
      .run(JSON.stringify([{ productId: 'P1', qty: 1, purchaseQty: 1, orderedQty: 1, conversionRate: 12, prRowIndex: 0, receivedQty: 1, goodQty: 1 }]), JSON.stringify({ grnHistory: [{ grnNumber: 'GRN-C-01' }] }));
    expect((await call('POST', '/api/pos/PO-G3/receive', { poId: 'PO-G3', stockOnly: true, grNumber: 'GRN-C-01', receivingItems: [{ productId: 'P1', goodQty: 1 }] })).status).toBe(409);
    expect(prod().currentStock).toBe(72);
  });

  it('G34 older POs with no prRowIndex and a PR with no rate : the PR-level ceiling still finds the snapshotted rate (re-pairing, else the rate of the line being received)', async () => {
    await twoPoSetup();
    for (const id of ['PO-G1', 'PO-G2']) {
      const l = JSON.parse(sdb.prepare('SELECT itemsJson FROM pos WHERE id = ?').get(id).itemsJson);
      l.forEach((x) => { delete x.prRowIndex; });
      sdb.prepare('UPDATE pos SET itemsJson = ? WHERE id = ?').run(JSON.stringify(l), id);
    }
    expect((await receiveAll('PO-G1', 'GRN-A-01')).status).toBe(200);
    expect((await receiveAll('PO-G2', 'GRN-B-01')).status).toBe(200);
    expect(prod().currentStock).toBe(72);
  });

  it('G30 admin POST of a PO also gets conversionRate written onto its lines (own valid figure kept, else PR row / product snapshot / 1)', async () => {
    seed({ conv: 12 });
    sdb.exec('DELETE FROM pos;');
    expect((await callAdm('POST', '/api/pos', { id: 'AD1', poNumber: 'PO-AD1', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 2 }] })).status).toBe(200);
    expect((await callAdm('POST', '/api/pos', { id: 'AD2', poNumber: 'PO-AD2', department: 'PD', status: 'ISSUED', items: [{ productId: 'P1', qty: 2, conversionRate: 5 }, { productId: 'NOPE', qty: 1 }] })).status).toBe(200);
    expect(JSON.parse(sdb.prepare("SELECT itemsJson FROM pos WHERE id = 'AD1'").get().itemsJson)[0].conversionRate).toBe(12);
    expect(JSON.parse(sdb.prepare("SELECT itemsJson FROM pos WHERE id = 'AD2'").get().itemsJson).map((l) => l.conversionRate)).toEqual([5, 1]);
  });

  it('G24 an IN row posted to /api/stock-logs with no docType is an ADJUST row, never GRN', async () => {
    seed();
    await call('POST', '/api/stock-logs', [{ id: 'M-IN', productId: 'P1', type: 'IN', quantity: 1, balance: 11 }]);
    expect(sdb.prepare("SELECT docType FROM stock_logs WHERE id = 'M-IN'").get().docType).toBe('ADJUST');
  });

  it('G18 docType of a client stock row is compared normalised : " grn ", "Goods_Receipt", "GRN-EVIDENCE" are receipt rows too ; other types still pass', async () => {
    seed();
    const r = await call('POST', '/api/stock-logs', [
      { id: 'M1', productId: 'P1', type: 'IN', docType: ' grn ', quantity: 1 },
      { id: 'M2', productId: 'P1', type: 'IN', docType: 'Goods_Receipt', quantity: 1 },
      { id: 'M3', productId: 'P1', type: 'IN', docType: 'GRN-EVIDENCE', quantity: 1 },
      { id: 'M4', productId: 'P1', type: 'OUT', docType: 'ISSUE', quantity: 1 },
      { id: 'M5', productId: 'P1', type: 'IN', docType: 'INITIAL-BALANCE', quantity: 1 }
    ]);
    expect(r.json.ignored).toHaveLength(3);
    expect(r.json.count).toBe(2);
  });
});
