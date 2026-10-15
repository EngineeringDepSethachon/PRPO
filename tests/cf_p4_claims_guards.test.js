// @vitest-environment node
// P4 re-check fixes : claim records are merged + stamped on the server (cannot be forged / erased), PO / PR upserts keep what is not sent,
// received quantities never go down, final-status evidence is add-only, log size caps, /receive input checks, empty ledger department.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';
import { buildViewer, filterLedger, filterStockLogs } from '../functions/_lib/scope.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
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
    batch: async (stmts) => { sdb.exec('BEGIN'); try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } }
  };
}

it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy(); });

describe('P4 re-check : claim stamping, upsert guards, caps', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body, raw) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const extraOf = (id = 'PO-C1') => JSON.parse(sdb.prepare('SELECT extraJson FROM pos WHERE id = ?').get(id).extraJson || '{}');
  const rowOf = (id = 'PO-C1') => ({ ...sdb.prepare('SELECT * FROM pos WHERE id = ?').get(id) });
  const seedPo = (over = {}, extra = {}, id = 'PO-C1') => {
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, over.poNumber || `PO-PD-2026-${id.slice(-3)}`, 'PD001/2026', 'PD', over.status || 'ORDERED', 100, 0, 100,
        JSON.stringify(over.items || [{ productId: 'P1', code: 'C1', name: 'Item', qty: 10, price: 10 }]), JSON.stringify(over.evidence || {}), '[]', JSON.stringify(extra), over.channel === undefined ? 'SELF' : over.channel);
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U-L1', 'req.pd', 'Pim Requester', 'PD', ['PD'], 'REQUESTER_PD', 'REQUESTER', 1],
      ['U-ON', 'online', 'Online Buyer', 'PUR', ['*'], 'ONLINE_PURCHASER', 'PURCHASER', 2],
      ['U-L2', 'asst.pd', 'Asst Manager', 'PD', ['PD'], 'ASST_MANAGER', 'REVIEWER', 2],
      ['U-AD', 'adm', 'Admin', 'ALL', ['*'], 'ADMIN', 'ADMIN', 99]
    ];
    for (const [id, username, name, department, depts, roleId, canon, level] of users) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
        .run(id, username, '', name, department, JSON.stringify(depts), roleId, canon, level, rec.hash, rec.salt, rec.algo, rec.iterations);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [id, username] of users.map((u) => [u[0], u[1]])) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env });
      tokens[id] = (await r.json()).token;
    }
  });

  // ── 1 claim stamping ──
  it('1a forged claim content without reportedBy : the stored owner is replaced by the token user (the key is stamped, not kept)', async () => {
    seedPo({}, { claimData: { reason: 'orig', reportedBy: 'Owner', reportedAt: '1/1/2026' } });
    const r = await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: { reason: 'FORGED' } });
    expect(r.status).toBe(200);
    expect(extraOf().claimData).toMatchObject({ reason: 'FORGED', reportedBy: 'Asst Manager' });
  });
  it('1a unchanged claim re-sent (stale copy) keeps the stored who / when', async () => {
    seedPo({}, { claimData: { reason: 'orig', reportedBy: 'Owner', reportedAt: '1/1/2026' } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: { reason: 'orig', reportedBy: 'Mallory', reportedAt: 'now' } });
    expect(extraOf().claimData).toMatchObject({ reason: 'orig', reportedBy: 'Owner', reportedAt: '1/1/2026' });
  });
  it('1a nested null cannot erase evidence', async () => {
    seedPo({}, { claimData: { reason: 'orig', description: 'photo-proof', reportedBy: 'Owner' } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: { description: null, reason: 'orig' } });
    expect(extraOf().claimData.description).toBe('photo-proof');
  });
  it('1b null / non-object claim keys keep the stored claim ; storeClaims {key:null} and an array are ignored', async () => {
    seedPo({}, { claimData: { reason: 'orig', reportedBy: 'Owner' }, claimDetails: { reason: 'd', reportedBy: 'Owner' }, inlineClaimData: { reason: 'i', reportedBy: 'Owner' }, storeClaims: { shop: { status: 'PENDING_CLAIM', reportedBy: 'Owner' } } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: null, claimDetails: 'x', inlineClaimData: null, storeClaims: { shop: null } });
    let e = extraOf();
    expect(e.claimData.reportedBy).toBe('Owner'); expect(e.claimDetails.reason).toBe('d'); expect(e.inlineClaimData.reason).toBe('i'); expect(e.storeClaims.shop.reportedBy).toBe('Owner');
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { storeClaims: [{ forged: true }] });
    e = extraOf();
    expect(Array.isArray(e.storeClaims)).toBe(false); expect(e.storeClaims.shop.reportedBy).toBe('Owner');
    // POST upsert goes through the same path
    await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', claimData: null, storeClaims: { shop: null } });
    expect(extraOf().claimData.reportedBy).toBe('Owner');
  });
  it('1c resolving a claim stamps resolvedBy only ; the reporter stays', async () => {
    seedPo({}, { storeClaims: { shop: { status: 'PENDING_CLAIM', reason: 'broken', reportedBy: 'Owner', reportedAt: '1/1/2026' } } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { storeClaims: { shop: { status: 'RESOLVED', isResolved: true, type: 'REFUND', refundAmount: 5, resolvedBy: 'Fake', resolvedAt: '2026-01-01T00:00:00.000Z', reportedBy: 'Fake2', reason: 'broken' } } });
    const s = extraOf().storeClaims.shop;
    expect(s).toMatchObject({ status: 'RESOLVED', resolvedBy: 'Asst Manager', reportedBy: 'Owner', reportedAt: '1/1/2026', reason: 'broken' });
    expect(s.resolvedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
  it('1 storeClaims entry keys: proto keys dropped, too many entries refused', async () => {
    seedPo({});
    const body = '{"storeClaims":{"__proto__":{"a":1},"shop":{"reason":"r","reportedBy":"x"}}}';
    const r = await call('U-L2', 'PUT', '/api/pos/PO-C1', undefined, body);
    expect(r.status).toBe(200);
    expect(JSON.stringify(extraOf())).not.toContain('__proto__');
    expect(extraOf().storeClaims.shop.reportedBy).toBe('Asst Manager');
    const many = {}; for (let i = 0; i < 101; i += 1) many[`s${i}`] = { reason: 'r' };
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { storeClaims: many })).status).toBe(413);
  });

  // ── 2 inspection ──
  it('2 claimEvidence / disputeInfo : inspector = token user, time = server, unchanged keeps the stored one ; claim keys are not plain extra fields', async () => {
    seedPo({});
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimEvidence: { inspectorName: 'Fake', inspectedAt: '2020-01-01T00:00:00.000Z', notes: 'dent' }, disputeInfo: { inspectorName: 'Fake', notes: 'dent' } });
    let e = extraOf();
    expect(e.claimEvidence.inspectorName).toBe('Asst Manager'); expect(e.claimEvidence.inspectedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(e.disputeInfo.inspectorName).toBe('Asst Manager');
    const at = e.claimEvidence.inspectedAt;
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimEvidence: { inspectorName: 'Fake', inspectedAt: 'zzz', notes: 'dent' }, disputeInfo: null });
    e = extraOf();
    expect(e.claimEvidence.inspectedAt).toBe(at); expect(e.disputeInfo.inspectorName).toBe('Asst Manager');
  });

  // ── 3 upsert guards ──
  it('3 POST upsert without items / evidence keeps the stored ones ; PUT keeps them too', async () => {
    seedPo({ evidence: { photos: ['a'] } });
    expect((await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', status: 'ORDERED', totalAmount: 100 })).status).toBe(200);
    let row = rowOf();
    expect(JSON.parse(row.itemsJson)).toHaveLength(1); expect(JSON.parse(row.evidenceJson)).toEqual({ photos: ['a'] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { vendorName: 'V' });
    row = rowOf(); expect(JSON.parse(row.itemsJson)).toHaveLength(1);
  });
  it('3 received quantities never go down (PUT and POST), may go up, negatives / NaN are 400', async () => {
    seedPo({ items: [{ productId: 'P1', qty: 10, price: 1, receivedQty: 6, goodQty: 5, defectiveQty: 1 }] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 10, price: 1, receivedQty: 0, goodQty: 0, defectiveQty: 0 }] });
    expect(JSON.parse(rowOf().itemsJson)[0]).toMatchObject({ receivedQty: 6, goodQty: 5, defectiveQty: 1 });
    await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', items: [{ productId: 'P1', qty: 10, price: 1, receivedQty: 2 }] });
    expect(JSON.parse(rowOf().itemsJson)[0].receivedQty).toBe(6);
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 10, price: 1, receivedQty: 8, goodQty: 7, defectiveQty: 1 }] });
    expect(JSON.parse(rowOf().itemsJson)[0]).toMatchObject({ receivedQty: 8, goodQty: 7 });
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', receivedQty: -1 }] })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', goodQty: 'abc' }] })).status).toBe(400);
  });
  it('3 actual unit price is fixed after the settlement ; before it, it can change', async () => {
    seedPo({ items: [{ productId: 'P1', qty: 1, price: 1, actualUnitPrice: 5 }] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 1, price: 1, actualUnitPrice: 6 }] });
    expect(JSON.parse(rowOf().itemsJson)[0].actualUnitPrice).toBe(6);
    sdb.prepare('UPDATE pos SET extraJson = ? WHERE id = ?').run(JSON.stringify({ settlementStatus: 'SETTLED' }), 'PO-C1');
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 1, price: 1, actualUnitPrice: 1 }] });
    expect(JSON.parse(rowOf().itemsJson)[0].actualUnitPrice).toBe(6);
  });
  it('3 final status : evidence / attachments can only be added to', async () => {
    seedPo({ status: 'CLOSED', evidence: { tags: ['a'], slip: 'x' } }, { attachments: [{ name: 'f1' }] });
    const pr = await call('U-AD', 'PUT', '/api/pos/PO-C1', { evidence: { tags: ['b'], slip: 'changed' }, attachments: [{ name: 'f2' }] });
    expect(pr.status).toBe(200);
    expect(JSON.parse(rowOf().evidenceJson)).toEqual({ tags: ['a', 'b'], slip: 'x' });
    expect(extraOf().attachments).toEqual([{ name: 'f1' }, { name: 'f2' }]);
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { evidence: {}, attachments: [] });
    expect(JSON.parse(rowOf().evidenceJson).tags).toEqual(['a', 'b']); expect(extraOf().attachments).toHaveLength(2);
  });
  it('3 PR : POST upsert without attachments / approvalWorkflow keeps them ; CANCELLED PR attachments are add-only', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson, attachmentsJson, approvalWorkflowJson, extraJson) VALUES ('PR-G1','PD009/2026','PD','REQUESTER_PD','R','SUBMITTED',0,'[]','[{\"name\":\"a\"}]','{\"step\":1}','{}')").run();
    await call('U-L2', 'POST', '/api/prs', { id: 'PR-G1', status: 'SUBMITTED' });
    let r = { ...sdb.prepare("SELECT attachmentsJson, approvalWorkflowJson FROM prs WHERE id='PR-G1'").get() };
    expect(JSON.parse(r.attachmentsJson)).toEqual([{ name: 'a' }]); expect(JSON.parse(r.approvalWorkflowJson)).toEqual({ step: 1 });
    sdb.prepare("UPDATE prs SET status='CANCELLED' WHERE id='PR-G1'").run();
    await call('U-AD', 'PUT', '/api/prs/PR-G1', { attachments: [{ name: 'b' }] });
    r = { ...sdb.prepare("SELECT attachmentsJson FROM prs WHERE id='PR-G1'").get() };
    expect(JSON.parse(r.attachmentsJson)).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  // ── 4 caps ──
  it('4 one log entry is cut to ~4KB ; a huge timeline / log is refused with 413 before it is written', async () => {
    seedPo({});
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { activityLog: [{ action: 'x', note: 'n'.repeat(3000), extra: 'e'.repeat(50000) }] });
    const log = extraOf().activityLog;
    expect(JSON.stringify(log[0]).length).toBeLessThanOrEqual(4096);
    const big = Array.from({ length: 200 }, (_, i) => ({ action: `a${i}`, note: 'z'.repeat(3500) }));
    const before = rowOf().timelineJson;
    const r = await call('U-L2', 'PUT', '/api/pos/PO-C1', { timeline: big });
    expect(r.status).toBe(413);
    expect(rowOf().timelineJson).toBe(before);
  });
  it('4 /receive : grnHistory keeps only the screen fields ; negative qty and a bad grNumber are 400 ; a good grNumber works', async () => {
    seedPo({});
    const base = { receivingItems: [{ productId: 'P1', goodQty: 2, defectiveQty: 1, huge: 'h'.repeat(20000), attachments: [{ a: 'b' }], __x: 1 }], note: 'n' };
    expect((await call('U-AD', 'POST', '/api/pos/PO-C1/receive', { ...base, grNumber: 'GRN-PO-PD-2026-001-01' })).status).toBe(200);
    const g = extraOf().grnHistory[0];
    expect(g.grnNumber).toBe('GRN-PO-PD-2026-001-01');
    expect(g.items[0]).toMatchObject({ productId: 'P1', goodQty: 2, defectiveQty: 1 });
    expect(g.items[0].huge).toBeUndefined(); expect(g.items[0].attachments).toBeUndefined();
    seedPo({}, {}, 'PO-C2');
    expect((await call('U-AD', 'POST', '/api/pos/PO-C2/receive', { receivingItems: [{ productId: 'P1', goodQty: -3 }] })).status).toBe(400);
    expect((await call('U-AD', 'POST', '/api/pos/PO-C2/receive', { receivingItems: [{ productId: 'P1', goodQty: 'abc' }] })).status).toBe(400);
    expect((await call('U-AD', 'POST', '/api/pos/PO-C2/receive', { receivingItems: [{ productId: 'P1', goodQty: 1 }], grNumber: 'evil<script>' })).status).toBe(400);
    expect((await call('U-AD', 'POST', '/api/pos/PO-C2/receive', { receivingItems: [{ productId: 'P1', goodQty: 1 }], grNumber: `GR-${'a'.repeat(200)}` })).status).toBe(400);
    expect((await call('U-AD', 'POST', '/api/pos/PO-C2/receive', { receivingItems: [{ productId: 'P1', goodQty: 1 }], grNumber: 'GR-PO-C2-1760000000000' })).status).toBe(200);
  });

  // ── QA round 1 ──
  it('QA1 quick-receive shape { productId, receivedThisTime } adds N to the stock and the line', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, department, currentStock, isDeleted) VALUES ('P1','C1','Item','PD',3,0)").run();
    seedPo({});
    const r = await call('U-AD', 'POST', '/api/pos/PO-C1/receive', { receivingItems: [{ productId: 'P1', receivedThisTime: 4 }], grNumber: 'GR-PO-C1-1760000000000' });
    expect(r.status).toBe(200);
    expect(sdb.prepare("SELECT currentStock FROM products WHERE id='P1'").get().currentStock).toBe(7);
    expect(JSON.parse(rowOf().itemsJson)[0]).toMatchObject({ receivedQty: 4, goodQty: 4 });
    expect(rowOf().status).toBe('PARTIAL');
    expect((await call('U-AD', 'POST', '/api/pos/PO-C1/receive', { receivingItems: [{ productId: 'P1', receivedThisTime: -1 }] })).status).toBe(400);
  });
  it('QA2 the same product on several lines is paired by position, not always with the first line', async () => {
    seedPo({ items: [{ productId: 'P1', storeName: 'A', qty: 10, receivedQty: 5 }, { productId: 'P1', storeName: 'B', qty: 10, receivedQty: 1 }] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', storeName: 'A', qty: 10, receivedQty: 5 }, { productId: 'P1', storeName: 'B', qty: 10, receivedQty: 2 }] });
    expect(JSON.parse(rowOf().itemsJson).map((x) => x.receivedQty)).toEqual([5, 2]);
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', storeName: 'A', qty: 10, receivedQty: 0 }, { productId: 'P1', storeName: 'B', qty: 10, receivedQty: 0 }] });
    expect(JSON.parse(rowOf().itemsJson).map((x) => x.receivedQty)).toEqual([5, 2]);
  });
  it('QA3 claimData null closes the claim only together with a closing status / claimResolution ; the old claim goes to claimHistory', async () => {
    seedPo({ status: 'CLAIM_REPORTED' }, { claimData: { reason: 'broken', images: ['u1'], reportedBy: 'Owner' } });
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { claimData: null });
    expect(extraOf().claimData.reason).toBe('broken');
    const r = await call('U-AD', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'REFUND' } });
    expect(r.status).toBe(200);
    const e = extraOf();
    expect(e.claimData).toBeUndefined();
    expect(e.claimHistory.at(-1)).toMatchObject({ action: 'CLAIM_DATA_ARCHIVED', claimData: { reason: 'broken', images: ['u1'], reportedBy: 'Owner' } });
    // a new claim starts clean (no old images)
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { status: 'CLAIM_REPORTED', claimData: { reason: 'again', reportedBy: 'x' } });
    expect(extraOf().claimData.images).toBeUndefined();
  });
  it('QA5 POST upsert without paymentTerms / deliveryDate / vendor keeps the stored ones', async () => {
    seedPo({});
    sdb.prepare("UPDATE pos SET paymentTerms='N30', deliveryDate='2026-02-01', vendorId='V1', vendorName='Vend' WHERE id='PO-C1'").run();
    expect((await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', status: 'ORDERED' })).status).toBe(200);
    expect(rowOf()).toMatchObject({ paymentTerms: 'N30', deliveryDate: '2026-02-01', vendorId: 'V1', vendorName: 'Vend' });
    await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', paymentTerms: 'N45', vendorName: 'New' });
    expect(rowOf()).toMatchObject({ paymentTerms: 'N45', vendorName: 'New', vendorId: 'V1' });
  });

  // ── round 3 ──
  const claimBase = { reason: 'broken', images: ['u1', 'u2'], reportedBy: 'Owner', reportedAt: '1/1/2026' };
  it('R3-1/2 closing a claim needs claim status + a closing status change + the right role ; claimResolution alone does nothing', async () => {
    seedPo({ status: 'CLAIM_REPORTED' }, { claimData: claimBase, requesterId: 'U-L1' }); // U-L1 owns the PO : may close its claim (decision 2026-10-14)
    // requester: claimResolution:{} + claimData:null without a status change
    await call('U-L1', 'PUT', '/api/pos/PO-C1', { claimResolution: {}, claimData: null });
    let e = extraOf();
    expect(e.claimData.reportedBy).toBe('Owner'); expect(e.claimResolution).toBeUndefined();
    // forged refund without closing
    await call('U-L1', 'PUT', '/api/pos/PO-C1', { claimResolution: { type: 'REFUND', refundAmount: 999999 } });
    expect(extraOf().claimResolution).toBeUndefined();
    // a PO that is NOT in a claim cannot have its (stale) claimData wiped by a status change
    seedPo({ status: 'ORDERED' }, { claimData: claimBase }, 'PO-C3');
    await call('U-L1', 'PUT', '/api/pos/PO-C3', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'X' } });
    e = extraOf('PO-C3'); expect(e.claimData.reason).toBe('broken'); expect(e.claimResolution).toBeUndefined();
    // the real close : self-buy requester, status CLAIM_REPORTED -> COMPLETED
    const r = await call('U-L1', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'REFUND', refundAmount: 5, resolvedBy: 'Fake', resolvedAt: '2020-01-01T00:00:00.000Z' } });
    expect(r.status).toBe(200);
    e = extraOf();
    expect(e.claimData).toBeUndefined();
    expect(e.claimResolution).toMatchObject({ type: 'REFUND', refundAmount: 5, resolvedBy: 'Pim Requester' });
    expect(e.claimResolution.resolvedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(e.claimHistory.some((h) => h.action === 'CLAIM_DATA_ARCHIVED' && h.claimData.images.length === 2)).toBe(true);
  });
  it('R3-1 online channel claims are closed by the online purchaser (or admin), not by a requester', async () => {
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: claimBase, requesterId: 'U-L2' }); // U-L2 owns the PO ; a non-owner L1 may not close the claim
    sdb.prepare("UPDATE pos SET purchaseChannel='ONLINE' WHERE id='PO-C1'").run();
    await call('U-L1', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null });
    expect(extraOf().claimData).toBeDefined();
    sdb.prepare("UPDATE pos SET status='CLAIM_PENDING' WHERE id='PO-C1'").run();
    const r = await call('U-ON', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null });
    expect(r.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
  });
  it('R3-3/9 an empty array cannot wipe images : the old claim goes to claimHistory (CLAIM_EDITED) and the reporter is re-stamped', async () => {
    seedPo({ status: 'CLAIM_REPORTED' }, { claimData: claimBase, storeClaims: { shop: { status: 'PENDING_CLAIM', attachments: ['a1'], reportedBy: 'Owner' } } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: { images: [] }, storeClaims: { shop: { attachments: [] } } });
    const e = extraOf();
    expect(e.claimData.reportedBy).toBe('Asst Manager');
    const edits = e.claimHistory.filter((h) => h.action === 'CLAIM_EDITED');
    expect(edits.find((h) => h.field === 'claimData').previous).toMatchObject({ images: ['u1', 'u2'], reportedBy: 'Owner' });
    expect(edits.find((h) => h.field === 'storeClaims.shop').previous.attachments).toEqual(['a1']);
    // unchanged resend archives nothing
    const n = e.claimHistory.length;
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimData: e.claimData });
    expect(extraOf().claimHistory.length).toBe(n);
  });
  it('R3-3 claimEvidence list is added to (inspector stamped), grAttachments add-only, claimPhoto set once', async () => {
    seedPo({}, { claimEvidence: [{ name: 'a' }], grAttachments: [{ name: 'g1' }], claimPhoto: 'p1' });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimEvidence: [], grAttachments: [{ name: 'g2' }], claimPhoto: 'p2' });
    let e = extraOf();
    expect(e.claimEvidence).toEqual([{ name: 'a' }]); expect(e.grAttachments).toEqual([{ name: 'g1' }, { name: 'g2' }]); expect(e.claimPhoto).toBe('p1');
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimEvidence: [{ name: 'a' }, { name: 'b', inspectorName: 'Fake' }], grAttachments: [] });
    e = extraOf();
    expect(e.claimEvidence).toHaveLength(2); expect(e.claimEvidence[1]).toMatchObject({ name: 'b', inspectorName: 'Asst Manager' });
    expect(e.grAttachments).toHaveLength(2);
  });
  it('R3-4 lines cannot be removed or re-keyed by a non-admin ; ordered qty / price are fixed after ordering ; received is capped at the ordered qty', async () => {
    const two = [{ productId: 'P1', qty: 10, price: 5, receivedQty: 0 }, { productId: 'P2', qty: 4, price: 2 }];
    seedPo({ status: 'ORDERED', items: two });
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [two[0]] })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ ...two[0], productId: 'PX' }, two[1]] })).status).toBe(400);
    expect(JSON.parse(rowOf().itemsJson)).toHaveLength(2);
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ ...two[0], qty: 99, price: 1, receivedQty: 50 }, two[1]] });
    expect(JSON.parse(rowOf().itemsJson)[0]).toMatchObject({ qty: 10, price: 5, receivedQty: 10 });
    // no new line after ordering (R4-5)
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [...two, { productId: 'P3', qty: 1, price: 1 }] })).status).toBe(400);
    expect(JSON.parse(rowOf().itemsJson)).toHaveLength(2);
    // before ordering (online : IN_PROGRESS_ONLINE) the online purchaser edits qty / price (acknowledgeOnlineTask)
    seedPo({ status: 'IN_PROGRESS_ONLINE', items: two }, {}, 'PO-C4');
    await call('U-ON', 'PUT', '/api/pos/PO-C4', { status: 'ORDERED', items: [{ ...two[0], qty: 8, price: 4 }, two[1]] });
    expect(JSON.parse(rowOf('PO-C4').itemsJson)[0]).toMatchObject({ qty: 8, price: 4 });
    // admin may correct
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { items: [{ ...two[0], qty: 12 }, two[1]] });
    expect(JSON.parse(rowOf().itemsJson)[0].qty).toBe(12);
  });
  it('R3-5 final status : claim / refund / price figures that are set cannot be changed by a non-admin', async () => {
    seedPo({ status: 'COMPLETED', items: [{ productId: 'P1', qty: 10, price: 5, refundAmount: 7, refundedQty: 2, claimResolution: 'REFUND', damagedQty: 0 }] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 10, price: 5, refundAmount: 0, refundedQty: 0, claimResolution: 'WRITE_OFF', damagedQty: 3 }] });
    expect(JSON.parse(rowOf().itemsJson)[0]).toMatchObject({ refundAmount: 7, refundedQty: 2, claimResolution: 'REFUND', damagedQty: 3 });
  });
  it('R3-6 the row size is checked on stored + patch : many saves with free keys end in 413', async () => {
    seedPo({});
    const keys = (tag, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${tag}x${i}`, 'v']));
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', keys('a', 151))).status).toBe(413);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', keys('b', 100))).status).toBe(200);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', keys('c', 100))).status).toBe(200);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', keys('d', 100))).status).toBe(413);
    expect(Object.keys(extraOf()).length).toBeLessThanOrEqual(300);
  });
  it('R3-7 admin changing qty / price of a closed PO is audited', async () => {
    seedPo({ status: 'CLOSED', items: [{ productId: 'P1', qty: 10, price: 5 }] });
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { items: [{ productId: 'P1', qty: 7, price: 6 }] });
    const row = sdb.prepare("SELECT details FROM audit_logs WHERE action = 'PO_ADMIN_ITEM_CHANGE'").get();
    expect(row).toBeTruthy();
    const d = JSON.parse(row.details);
    expect(d.changes.map((c) => c.field).sort()).toEqual(['price', 'qty']);
  });

  // ── round 4 (kla-security) ──
  it('R4-1 purchaseChannel of an existing PO : only an admin changes it (POST upsert and PUT)', async () => {
    seedPo({ channel: 'ONLINE' });
    await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', purchaseChannel: 'SELF' });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { purchaseChannel: 'SELF' });
    expect(rowOf().purchaseChannel).toBe('ONLINE');
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { purchaseChannel: 'SELF' });
    expect(rowOf().purchaseChannel).toBe('SELF');
  });
  it('R4-2 a stored claimEvidence list is not replaced by an object', async () => {
    seedPo({}, { claimEvidence: [{ name: 'a' }] });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { claimEvidence: { notes: 'x' } });
    expect(extraOf().claimEvidence).toEqual([{ name: 'a' }]);
  });
  it('R4-3/R5-1 up to 100 archived claim edits per save are kept (24 entries of a 12-store round 2 pass) ', async () => {
    const sc = {}; const body = {};
    for (let i = 0; i < 100; i += 1) { sc[`s${i}`] = { status: 'PENDING_CLAIM', reason: 'a', reportedBy: 'Owner' }; body[`s${i}`] = { reason: 'changed' }; }
    seedPo({ status: 'CLAIM_REPORTED' }, { storeClaims: sc });
    const r = await call('U-L2', 'PUT', '/api/pos/PO-C1', { storeClaims: body });
    expect(r.status).toBe(200);
    expect(extraOf().claimHistory.filter((h) => h.action === 'CLAIM_EDITED')).toHaveLength(100);
  });
  it('R4-4 PO level refundAmount / totalRefunded : only while closing a claim / resolving a store claim, finite, >= 0, <= PO value', async () => {
    seedPo({ status: 'CLAIM_PENDING' }, { storeClaims: { A: { isResolved: false, status: 'PENDING_CLAIM' } }, claimData: { reason: 'r', reportedBy: 'O' } });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { refundAmount: 50, totalRefunded: 50 }); // nothing is resolved in this save
    expect(extraOf().refundAmount).toBeUndefined(); expect(extraOf().totalRefunded).toBeUndefined();
    const part = await call('U-L2', 'PUT', '/api/pos/PO-C1', { refundAmount: 30, totalRefunded: 30, storeClaims: { A: { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 30 } } });
    expect(part.status).toBe(200);
    expect(extraOf()).toMatchObject({ refundAmount: 30, totalRefunded: 30 });
    // a claim that is no longer open (already resolved) cannot be given a refund figure
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { totalRefunded: 99, storeClaims: { A: { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 30 } } });
    expect(extraOf().totalRefunded).toBe(30);
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: { reason: 'r', reportedBy: 'O' }, requesterId: 'U-L2' }, 'PO-C2');
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null, totalRefunded: -5 })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null, totalRefunded: 100000 })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null, refundAmount: 60 })).status).toBe(200);
    expect(extraOf('PO-C2').refundAmount).toBe(60);
  });
  it('R4-6 self-buy close (decision 2026-10-14) : the requester who owns the PO, approver, admin ; a non-owner receiver / reviewer is refused ; the online purchaser closes ONLINE claims only', async () => {
    seedPo({ status: 'CLAIM_REPORTED' }, { claimData: claimBase, requesterId: 'U-L1' });
    // a reviewer of the department who does not own the PO : 403, the claim stays
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null })).status).toBe(403);
    expect(extraOf().claimData).toBeDefined();
    const r = await call('U-L1', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null });
    expect(r.status).toBe(200); expect(extraOf().claimData).toBeUndefined();
    // owner matched by name (PR row) when the PO carries no requesterId
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson, extraJson) VALUES ('PR-OWN','PD001/2026','PD','SOMEONE-ELSE','Pim Requester','PO_ISSUED',0,'[]','{}')").run();
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: claimBase }, 'PO-C4');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C4', { status: 'COMPLETED', claimData: null })).status).toBe(200);
    seedPo({ status: 'CLAIM_REPORTED', channel: null }, { claimData: claimBase }, 'PO-C2'); // no channel : not SELF = ONLINE
    await call('U-L1', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null });
    expect(extraOf('PO-C2').claimData).toBeDefined();
  });

  it('TC-010 (2026-10-15) round-2 receipt of an ONLINE PO : a requester who does not own the PR completes WAITING_DELIVERY_ROUND_2 -> COMPLETED (PO-PD-2026-004)', async () => {
    // PR / PO owned by the reviewer (U-L2) ; the online purchaser already resolved the claim (RESEND) ; U-L1 receives the replacement
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE', items: [{ productId: 'P1', code: 'C1', name: 'Item', qty: 10, orderedQty: 10, receivedQty: 9, remainingQty: 1, price: 10, claimResolution: 'REPLACEMENT', replacementPendingQty: 1 }] },
      { requesterId: 'U-L2', requestedBy: 'Asst Manager', claimStatus: 'REPLACEMENT_PENDING', claimResolution: { type: 'RESEND', resolvedBy: 'Online Buyer' } }, 'PO-R2');
    const r = await call('U-L1', 'PUT', '/api/pos/PO-R2', { status: 'COMPLETED', claimStatus: 'RESOLVED', isInClaim: false, hasUnresolvedClaim: false, items: [{ productId: 'P1', code: 'C1', name: 'Item', qty: 10, orderedQty: 10, receivedQty: 10, remainingQty: 0, price: 10 }] });
    expect(r.status).toBe(200);
    expect(rowOf('PO-R2').status).toBe('COMPLETED');
    // a claim that is really still open stays restricted for the same non-owner
    seedPo({ status: 'CLAIM_PENDING', channel: 'ONLINE' }, { claimData: claimBase, requesterId: 'U-L2' }, 'PO-R3');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-R3', { status: 'COMPLETED', claimData: null })).status).toBe(403);
  });

  it('R4-6b (2026-10-15) the requester who RECEIVED the goods and reported the claim closes it even when somebody else owns the PR (PO-PD-2026-003)', async () => {
    // PR / PO owned by the reviewer (U-L2) ; the claim was filed by U-L1 (name stamp as ReceivingModal writes it)
    seedPo({ status: 'PARTIALLY_RECEIVED_IN_CLAIM' }, { claimData: { ...claimBase, reportedBy: 'Pim Requester' }, requesterId: 'U-L2', requestedBy: 'Asst Manager' }, 'PO-C5');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C5', { status: 'COMPLETED', claimData: null })).status).toBe(200);
    // a "name (position)" stamp counts by its name part ; a store claim entry counts too ; an id stamp counts
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: { ...claimBase, reportedBy: 'Pim Requester (Requester)' }, requesterId: 'U-L2' }, 'PO-C6');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C6', { status: 'COMPLETED', claimData: null })).status).toBe(200);
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: claimBase, storeClaims: { s1: { isResolved: false, reportedBy: 'Pim Requester' } }, requesterId: 'U-L2' }, 'PO-C7');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C7', { status: 'COMPLETED', claimData: null })).status).toBe(200);
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: { ...claimBase, reportedById: 'U-L1' }, requesterId: 'U-L2' }, 'PO-C8');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C8', { status: 'COMPLETED', claimData: null })).status).toBe(200);
    // somebody who neither owns the PR nor reported the claim is still refused
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: { ...claimBase, reportedBy: 'Owner' }, requesterId: 'U-L2' }, 'PO-C9');
    expect((await call('U-L1', 'PUT', '/api/pos/PO-C9', { status: 'COMPLETED', claimData: null })).status).toBe(403);
    expect(extraOf('PO-C9').claimData).toBeDefined();
  });
  it('R4-A/B last store resolved at WAITING_DELIVERY_ROUND_2 closes the claim ; a re-opened store entry loses the old resolution and is not stamped as resolved', async () => {
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE' }, { claimStatus: 'IN_CLAIM', claimData: claimBase, storeClaims: { A: { isResolved: true, type: 'RESEND', resolvedBy: 'X' }, B: { isResolved: false, status: 'PENDING_CLAIM' } } });
    await call('U-ON', 'PUT', '/api/pos/PO-C1', { status: 'WAITING_DELIVERY_ROUND_2', claimData: null, storeClaims: { B: { isResolved: true, status: 'RESOLVED', type: 'REFUND' } } });
    expect(extraOf().claimData).toBeDefined(); // no claimResolution : not a close
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE' }, { claimStatus: 'IN_CLAIM', claimData: claimBase, storeClaims: { B: { isResolved: false, status: 'PENDING_CLAIM' } } }, 'PO-C2');
    await call('U-ON', 'PUT', '/api/pos/PO-C2', { status: 'WAITING_DELIVERY_ROUND_2', claimData: null, claimResolution: { type: 'REFUND' }, storeClaims: { B: { isResolved: true, status: 'RESOLVED', type: 'REFUND' } } });
    expect(extraOf('PO-C2').claimData).toBeUndefined();
    // re-open
    seedPo({ status: 'COMPLETED', channel: 'ONLINE' }, { storeClaims: { A: { isResolved: true, type: 'RESEND', actionType: 'RESEND', resolvedBy: 'X', resolvedAt: 't', note: 'n', refundAmount: 3 } } }, 'PO-C3');
    await call('U-L1', 'PUT', '/api/pos/PO-C3', { storeClaims: { A: { isResolved: false, status: 'PENDING_CLAIM', type: null, actionType: null, reason: 'r2', reportedBy: 'W' } } });
    const a = extraOf('PO-C3').storeClaims.A;
    expect(a).toMatchObject({ isResolved: false, status: 'PENDING_CLAIM', reason: 'r2', reportedBy: 'Pim Requester' });
    for (const k of ['type', 'actionType', 'resolvedBy', 'resolvedAt', 'note', 'refundAmount']) expect(a[k]).toBeUndefined();
    expect(extraOf('PO-C3').claimHistory.find((h) => h.field === 'storeClaims.A').previous.type).toBe('RESEND');
  });

  // ── round 5 ──
  it('R5-3 procurementType / channel of an existing PO : only an admin changes them ; a new PO takes them from the body', async () => {
    seedPo({ channel: 'ONLINE' }, { procurementType: 'ONLINE', channel: 'ONLINE' });
    await call('U-L2', 'PUT', '/api/pos/PO-C1', { procurementType: 'INTERNAL', channel: 'DIRECT' });
    await call('U-L2', 'POST', '/api/pos', { id: 'PO-C1', procurementType: 'INTERNAL', channel: 'DIRECT' });
    expect(extraOf()).toMatchObject({ procurementType: 'ONLINE', channel: 'ONLINE' });
    await call('U-AD', 'PUT', '/api/pos/PO-C1', { procurementType: 'INTERNAL' });
    expect(extraOf().procurementType).toBe('INTERNAL');
    // so a requester cannot turn an online claim into a self-buy one to close it
    seedPo({ status: 'CLAIM_REPORTED', channel: 'ONLINE' }, { claimData: claimBase, requesterId: 'REQUESTER_PD' }, 'PO-C2');
    await call('U-L1', 'PUT', '/api/pos/PO-C2', { procurementType: 'INTERNAL', status: 'COMPLETED', claimData: null });
    expect(extraOf('PO-C2').claimData).toBeDefined();
  });
  it('R5-4 refund ceiling : a PO with no grandTotal uses totalAmount, a PO with no value refuses any refund > 0', async () => {
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: claimBase, requesterId: 'U-L2' }); // U-L2 owns the PO ; a non-owner L1 may not close the claim
    sdb.prepare("UPDATE pos SET grandTotal = 0, totalAmount = 40 WHERE id='PO-C1'").run();
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null, refundAmount: 41 })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null, refundAmount: 40 })).status).toBe(200);
    seedPo({ status: 'CLAIM_PENDING' }, { claimData: claimBase, requesterId: 'U-L2' }, 'PO-C2');
    sdb.prepare("UPDATE pos SET grandTotal = 0, totalAmount = 0 WHERE id='PO-C2'").run();
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null, totalRefunded: 1 })).status).toBe(400);
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C2', { status: 'COMPLETED', claimData: null, totalRefunded: 0 })).status).toBe(200);
  });
  it('R5-2 claimResolution gets resolvedBy / resolvedAt from the token even when the client sent none', async () => {
    seedPo({ status: 'CLAIM_REPORTED' }, { claimData: claimBase, requesterId: 'U-L1' }); // U-L1 owns the PO : may close its claim (decision 2026-10-14)
    await call('U-L1', 'PUT', '/api/pos/PO-C1', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'WRITE_OFF' } });
    expect(extraOf().claimResolution).toMatchObject({ type: 'WRITE_OFF', resolvedBy: 'Pim Requester' });
    expect(extraOf().claimResolution.resolvedAt).toBeTruthy();
  });

  // ── extra : prototype keys ──
  it('proto / constructor / prototype keys are stripped from anything stored in extraJson', async () => {
    seedPo({});
    const raw = '{"meta":{"__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3},"ok":1},"activityLog":[{"action":"q","__proto__":{"p":1},"constructor":"c"}]}';
    expect((await call('U-L2', 'PUT', '/api/pos/PO-C1', undefined, raw)).status).toBe(200);
    const s = sdb.prepare('SELECT extraJson FROM pos WHERE id = ?').get('PO-C1').extraJson;
    expect(s).not.toMatch(/__proto__|"constructor"|"prototype"/);
    expect(extraOf().meta.ok).toBe(1);
  });
});

describe('5 ledger rows without a department', () => {
  const user = (over) => buildViewer({ userId: 'u', roleId: 'REQUESTER_PD', level: 1, department: 'PD', allowedDepartments: ['PD'], ...over });
  it('department falls back to dept ; an empty one goes only to the all-department viewers', () => {
    const rows = [{ id: 1, department: 'PD' }, { id: 2, dept: 'PD' }, { id: 3, department: 'QC' }, { id: 4 }, { id: 5, department: '  ' }];
    const lvl1 = filterLedger(user({}), rows).map((r) => r.id);
    expect(lvl1).toEqual([1, 2]);
    const admin = filterLedger(buildViewer({ userId: 'a', roleId: 'ADMIN', level: 99, role: 'admin', department: 'ALL', allowedDepartments: ['*'] }), rows).map((r) => r.id);
    expect(admin).toEqual([1, 2, 3, 4, 5]);
  });
  it('round 3 : stock logs without a department stay visible to everybody (the stock card / movement table show them) ; other departments are not', () => {
    const logs = [{ id: 1, department: 'PD' }, { id: 2 }, { id: 3, department: '' }, { id: 4, department: 'QC' }];
    expect(filterStockLogs(user({}), logs).map((l) => l.id)).toEqual([1, 2, 3]);
    expect(filterStockLogs(buildViewer({ userId: 'a', roleId: 'ADMIN', level: 99, role: 'admin', department: 'ALL', allowedDepartments: ['*'] }), logs).map((l) => l.id)).toEqual([1, 2, 3, 4]);
  });
});
