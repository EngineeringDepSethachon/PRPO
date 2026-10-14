// @vitest-environment node
// QA P4 round 3 : regression probes of the REAL client flows (ReceivingModal / OnlineOrderCard / PODetailsModal / workflowEngine.resolveClaim)
// against the claim-closing rule and the line guards of functions/api/[[route]].js. Cases marked `it.fails` document a bug that is still open :
// they pass while the bug exists and will turn red (remove `.fails`) once it is fixed.
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

describe('P4 round 3 QA : real client flows vs claim / line guards', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const extraOf = (id = 'PO-F1') => JSON.parse(sdb.prepare('SELECT extraJson FROM pos WHERE id = ?').get(id).extraJson || '{}');
  const rowOf = (id = 'PO-F1') => ({ ...sdb.prepare('SELECT * FROM pos WHERE id = ?').get(id) });
  const itemsOf = (id = 'PO-F1') => JSON.parse(rowOf(id).itemsJson);
  const seedPo = (over = {}, extra = {}, id = 'PO-F1') => {
    sdb.prepare('INSERT INTO pos (id, poNumber, prNumber, department, status, totalAmount, vatAmount, grandTotal, itemsJson, evidenceJson, timelineJson, extraJson, purchaseChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, `PO-PD-2026-${id.slice(-3)}`, 'PD001/2026', 'PD', over.status || 'ORDERED', 100, 0, 100,
        JSON.stringify(over.items || [{ productId: 'P1', code: 'C1', name: 'Item', qty: 10, price: 10 }]), '{}', '[]', JSON.stringify(extra), over.channel === undefined ? 'SELF' : over.channel);
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

  it('F1 ReceivingModal round 1 (fileClaim PUT, then updatePO PUT with the same claim) : no CLAIM_EDITED noise, the reporter stays, then the self-buy requester closes it', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 6, goodQty: 6 }] });
    const claim = { reason: 'broken', description: 'd', channel: 'SELF', disputeItems: [{ productId: 'P1', n: 1 }], items: [{ productId: 'P1', n: 1 }], attachments: ['a.jpg'], defectImages: ['a.jpg'] };
    const r1 = await call('U-L1', 'PUT', '/api/pos/PO-F1', { status: 'CLAIM_REPORTED', claimData: { ...claim, reportedBy: 'Pim Requester', reportedAt: '1/1/2026 10:00:00', channel: 'SELF' } });
    expect(r1.status).toBe(200);
    const r2 = await call('U-L1', 'PUT', '/api/pos/PO-F1', {
      status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'PENDING_CLAIM', hasDispute: true, isInClaim: true,
      claimData: { ...claim, reportedBy: 'Warehouse', reportedAt: '1/1/2026 10:00:05' }, claimDetails: { ...claim, reportedBy: 'Warehouse', reportedAt: 'x' },
      storeClaims: { shop: { isResolved: false, status: 'PENDING_CLAIM', claimStatus: 'PENDING_CLAIM', type: null, actionType: null, reason: 'broken', reportedAt: 't', reportedBy: 'Warehouse' } },
      items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 6, goodQty: 6, damagedQty: 2, shortageQty: 2, hasDispute: true }]
    });
    expect(r2.status).toBe(200);
    let e = extraOf();
    expect(e.claimData.reportedBy).toBe('Pim Requester');
    expect((e.claimHistory || []).filter((h) => h.action === 'CLAIM_EDITED' && h.field === 'claimData')).toHaveLength(0);
    // self-buy resolve RESEND by the requester : PARTIALLY_RECEIVED_IN_CLAIM -> WAITING_DELIVERY_ROUND_2 with claimData null
    const r3 = await call('U-L1', 'PUT', '/api/pos/PO-F1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'RESOLVED_WAITING_DELIVERY', claimData: null, claimResolution: { type: 'RESEND', refundAmount: 0, note: 'n', resolvedBy: 'client', resolvedAt: new Date().toISOString() } });
    expect(r3.status).toBe(200);
    e = extraOf();
    expect(e.claimData).toBeUndefined();
    expect(e.claimResolution).toMatchObject({ type: 'RESEND', resolvedBy: 'Pim Requester' });
    // round 2 : receiving raises received qty up to the ordered qty, and a new claim starts clean
    const r4 = await call('U-L1', 'PUT', '/api/pos/PO-F1', { status: 'PARTIALLY_RECEIVED_IN_CLAIM', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 10, goodQty: 10, damagedQty: 2, shortageQty: 0 }], claimData: { reason: 'again', reportedBy: 'W' } });
    expect(r4.status).toBe(200);
    expect(itemsOf()[0]).toMatchObject({ receivedQty: 10, goodQty: 10 });
    expect(extraOf().claimData.images).toBeUndefined();
  });

  it('F2 OnlineOrderCard : resolve (COMPLETED + refund items) then the second updatePO at the same status keeps the first refund figures and creates no duplicate history', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', channel: 'ONLINE', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 6, goodQty: 6, damagedQty: 2, shortageQty: 2, storeName: 'S1' }] },
      { claimData: { reason: 'broken', reportedBy: 'Owner' }, storeClaims: { 'shopee_s1': { isResolved: false, status: 'PENDING_CLAIM', reportedBy: 'Owner' } } });
    const resolvedItems = [{ productId: 'P1', qty: 10, price: 10, receivedQty: 6, goodQty: 6, damagedQty: 0, shortageQty: 0, refundedQty: 4, refundAmount: 40, claimResolution: 'REFUND', isSettled: true, storeName: 'S1' }];
    const sc = { 'shopee_s1': { status: 'RESOLVED', isResolved: true, type: 'REFUND', actionType: 'REFUND', refundAmount: 40, note: 'ok', resolvedBy: 'Online Buyer' } };
    const r1 = await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'COMPLETED', claimStatus: 'RESOLVED_REFUNDED', refundAmount: 40, claimData: null, claimResolution: { type: 'REFUND', refundAmount: 40 }, storeClaims: sc, items: resolvedItems });
    expect(r1.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
    const r2 = await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'COMPLETED', totalRefunded: 40, claimStatus: 'RESOLVED_REFUNDED', storeClaims: sc, items: resolvedItems.map((i) => ({ ...i, refundAmount: 40 })) });
    expect(r2.status).toBe(200);
    expect(itemsOf()[0]).toMatchObject({ refundedQty: 4, refundAmount: 40, claimResolution: 'REFUND' });
    const arch = (extraOf().claimHistory || []).filter((h) => h.action === 'CLAIM_DATA_ARCHIVED');
    expect(arch).toHaveLength(1);
  });

  // BUG A : the last store of a multi-store online claim is resolved while the stored status is already WAITING_DELIVERY_ROUND_2 (an earlier store was RESEND ->
  // workflowEngine.resolveClaim sets that status immediately) ; the status does not "change", so claimData / claimResolution are silently dropped.
  it('F3 multi-store : store A RESEND (status -> WAITING_DELIVERY_ROUND_2), then the last store B is resolved at the same status -> the claim must be closed', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', channel: 'ONLINE' }, { claimData: { reason: 'broken', reportedBy: 'Owner' } });
    const a = await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'IN_CLAIM', claimData: undefined, storeClaims: { A: { isResolved: true, status: 'WAITING_REPLACEMENT', type: 'RESEND' } } });
    expect(a.status).toBe(200);
    expect(extraOf().claimData).toBeDefined(); // not all stores resolved : stays (correct)
    const b = await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'REPLACEMENT_PENDING', claimData: null, claimResolution: { type: 'REFUND', refundAmount: 5 }, storeClaims: { B: { isResolved: true, status: 'RESOLVED', type: 'REFUND' } } });
    expect(b.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
    expect(extraOf().claimResolution).toMatchObject({ type: 'REFUND' });
  });

  // BUG B : ReceivingModal re-opens a store entry with type:null / actionType:null ; the server drops nulls so the old resolution type stays on a PENDING entry
  // (the client later reads storeClaims[*].type === 'REPLACEMENT' to decide hasPendingDeliveries of the NEXT resolution)
  it('F4 round 2 claim on the same store : the reset entry (type/actionType null) must not keep the previous resolution type', async () => {
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE' }, { storeClaims: { A: { isResolved: true, status: 'WAITING_REPLACEMENT', type: 'RESEND', actionType: 'RESEND', resolvedBy: 'Online Buyer' } } });
    const r = await call('U-L1', 'PUT', '/api/pos/PO-F1', { status: 'PARTIALLY_RECEIVED_IN_CLAIM', storeClaims: { A: { isResolved: false, status: 'PENDING_CLAIM', claimStatus: 'PENDING_CLAIM', type: null, actionType: null, reason: 'r2' } } });
    expect(r.status).toBe(200);
    const a = extraOf().storeClaims.A;
    expect(a.isResolved).toBe(false);
    expect(a.type == null).toBe(true);
    expect(a.actionType == null).toBe(true);
  });

  it('F5 online purchaser acknowledge (IN_PROGRESS_ONLINE -> ORDERED, qty/price changed) works ; a later correction by the online purchaser works ; a stale copy from the requester cannot revert it', async () => {
    seedPo({ status: 'IN_PROGRESS_ONLINE', channel: 'ONLINE', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 0 }] });
    expect((await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'ORDERED', items: [{ productId: 'P1', qty: 8, orderedQty: 8, purchaseQty: 8, actualQty: 8, price: 9, unitPrice: 9, actualPrice: 9, actUnitPrice: 9, receivedQty: 0 }] })).status).toBe(200);
    expect(itemsOf()[0]).toMatchObject({ qty: 8, price: 9 });
    // once ordered the lines are fixed for the online purchaser too (no screen edits an ordered line) ; a stale copy from the requester cannot revert it either
    expect((await call('U-ON', 'PUT', '/api/pos/PO-F1', { items: [{ productId: 'P1', qty: 7, orderedQty: 7, price: 9 }] })).status).toBe(200);
    expect(itemsOf()[0].qty).toBe(8);
    await call('U-L1', 'PUT', '/api/pos/PO-F1', { items: [{ productId: 'P1', qty: 99, price: 1, receivedQty: 0 }] });
    expect(itemsOf()[0]).toMatchObject({ qty: 8, price: 9 });
  });

  it('F6 short-close (status CLOSED, closedEarly, local items) keeps the received figures ; a later save with the same lines is not refused', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 4, goodQty: 4 }] });
    const r = await call('U-AD', 'PUT', '/api/pos/PO-F1', { status: 'CLOSED', closedEarly: true, shortCloseReason: 'x', closedBy: 'Pim', items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 4, goodQty: 4 }] });
    expect(r.status).toBe(200);
    expect(itemsOf()[0]).toMatchObject({ qty: 10, receivedQty: 4 });
    const l2 = await call('U-L2', 'PUT', '/api/pos/PO-F1', { items: [{ productId: 'P1', qty: 10, price: 10, receivedQty: 4, goodQty: 4 }] });
    expect(l2.status).toBe(200);
  });

  // BUG C : an ONLINE-procurement PO whose purchaseChannel was never stored is treated as self-buy by the server, so the online purchaser cannot close its claim
  // (workflowEngine.resolveClaim itself also reads purchaseChannel, but fileClaim / the hub treat "not SELF" as ONLINE)
  it('F8 claim of a PO without a stored purchaseChannel can be closed by the online purchaser', async () => {
    seedPo({ status: 'CLAIM_REPORTED', channel: null }, { claimData: { reason: 'broken', reportedBy: 'Owner' }, procurementType: 'ONLINE' });
    const r = await call('U-ON', 'PUT', '/api/pos/PO-F1', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'REFUND' } });
    expect(r.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
  });
});
