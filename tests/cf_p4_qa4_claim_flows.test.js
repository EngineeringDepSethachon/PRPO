// @vitest-environment node
// QA P4 round 4 : claim flows of the real client screens against functions/api/[[route]].js
//  - ReceivingModal round 2 on MANY stores (each store is stored under 2 keys : group key + store name -> 2 CLAIM_EDITED archives per store, cap 20)
//  - OnlineOrderCard multi-store resolve : PO level refundAmount / totalRefunded written at the right moment, second updatePO does not change them
//  - PODetailsModal self-buy resolve (RESEND / CLOSE_WITH_REFUND / CLOSE_NO_ACTION) by the requester
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

describe('P4 round 4 QA : ReceivingModal / OnlineOrderCard / PODetailsModal claim flows', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const extraOf = (id = 'PO-G1') => JSON.parse(sdb.prepare('SELECT extraJson FROM pos WHERE id = ?').get(id).extraJson || '{}');
  const seedPo = (over = {}, extra = {}, id = 'PO-G1') => {
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
      ['U-ON', 'online', 'Online Buyer', 'PUR', ['*'], 'ONLINE_PURCHASER', 'PURCHASER', 2]
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

  // ReceivingModal writes every reset entry under TWO keys (`${platform}_${store}` and the store name) and workflowEngine.resolveClaim / OnlineOrderCard
  // wrote both resolved. Round 2 therefore re-opens 2 entries per store -> 2 CLAIM_EDITED archives per store ; 11 stores = 22 > cap 20 -> 413.
  const resolvedPair = (i) => { const e = { isResolved: true, status: 'RESOLVED', type: 'REFUND', actionType: 'REFUND', refundAmount: 1, resolvedBy: 'X', resolvedAt: 't' }; return { [`shopee_s${i}`]: e, [`S${i}`]: e }; };
  const resetPair = (i) => { const e = { isResolved: false, status: 'PENDING_CLAIM', claimStatus: 'PENDING_CLAIM', type: null, actionType: null, reason: 'r2', reportedBy: 'W' }; return { [`shopee_s${i}`]: e, [`S${i}`]: e }; };
  const storesObj = (n, fn) => { let o = {}; for (let i = 0; i < n; i += 1) o = { ...o, ...fn(i) }; return o; };

  it('G1 round 2 on 10 stores (20 entries) is accepted', async () => {
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE' }, { storeClaims: storesObj(10, resolvedPair) });
    const r = await call('U-L1', 'PUT', '/api/pos/PO-G1', { status: 'PARTIALLY_RECEIVED_IN_CLAIM', storeClaims: storesObj(10, resetPair) });
    expect(r.status).toBe(200);
    expect(extraOf().storeClaims.shopee_s9.isResolved).toBe(false);
  });

  // BUG (open) : a receiving round that re-opens 11 stores is refused with 413, after the GRN was already posted by /receive
  it('G2 round 2 on 12 stores (24 entries) must not be refused', async () => {
    seedPo({ status: 'WAITING_DELIVERY_ROUND_2', channel: 'ONLINE' }, { storeClaims: storesObj(12, resolvedPair) });
    const r = await call('U-L1', 'PUT', '/api/pos/PO-G1', { status: 'PARTIALLY_RECEIVED_IN_CLAIM', storeClaims: storesObj(12, resetPair) });
    expect(r.status).toBe(200);
  });

  it('G3 OnlineOrderCard multi-store : store A refund (not last) writes PO refund figures, last store WRITE_OFF closes, second updatePO cannot change the figures', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', channel: 'ONLINE' },
      { claimData: { reason: 'broken', reportedBy: 'Owner' }, claimStatus: 'PENDING_CLAIM', storeClaims: { shopee_a: { isResolved: false, status: 'PENDING_CLAIM' }, shopee_b: { isResolved: false, status: 'PENDING_CLAIM' } } });
    const a = { isResolved: true, status: 'RESOLVED', type: 'REFUND', actionType: 'REFUND', refundAmount: 40, note: 'n' };
    const r1 = await call('U-ON', 'PUT', '/api/pos/PO-G1', { status: 'PARTIALLY_RECEIVED_IN_CLAIM', claimStatus: 'IN_CLAIM', refundAmount: 40, totalRefunded: 40, storeClaims: { shopee_a: a, shopee_b: { isResolved: false, status: 'PENDING_CLAIM' } } });
    expect(r1.status).toBe(200);
    expect(extraOf()).toMatchObject({ refundAmount: 40, totalRefunded: 40 });
    expect(extraOf().claimData).toBeDefined();
    const b = { isResolved: true, status: 'RESOLVED', type: 'WRITE_OFF', actionType: 'WRITE_OFF', refundAmount: 0 };
    const r2 = await call('U-ON', 'PUT', '/api/pos/PO-G1', { status: 'COMPLETED', claimStatus: 'RESOLVED', refundAmount: 40, totalRefunded: 40, claimData: null, claimResolution: { type: 'WRITE_OFF', refundAmount: 0 }, storeClaims: { shopee_a: a, shopee_b: b } });
    expect(r2.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
    expect(extraOf()).toMatchObject({ refundAmount: 40, totalRefunded: 40 });
    expect(extraOf().claimResolution).toMatchObject({ type: 'WRITE_OFF', resolvedBy: 'Online Buyer' });
    const r3 = await call('U-ON', 'PUT', '/api/pos/PO-G1', { status: 'COMPLETED', totalRefunded: 80, refundAmount: 80, storeClaims: { shopee_a: a, shopee_b: b } });
    expect(r3.status).toBe(200);
    expect(extraOf()).toMatchObject({ refundAmount: 40, totalRefunded: 40 });
  });

  it('G4 online RESEND then REFUND of the last store : refund figures of the last store are written, claim closes at the same status', async () => {
    seedPo({ status: 'PARTIALLY_RECEIVED_IN_CLAIM', channel: 'ONLINE' },
      { claimData: { reason: 'broken', reportedBy: 'Owner' }, claimStatus: 'PENDING_CLAIM', storeClaims: { A: { isResolved: false, status: 'PENDING_CLAIM' }, B: { isResolved: false, status: 'PENDING_CLAIM' } } });
    expect((await call('U-ON', 'PUT', '/api/pos/PO-G1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'IN_CLAIM', refundAmount: 0, storeClaims: { A: { isResolved: true, status: 'WAITING_REPLACEMENT', type: 'RESEND', actionType: 'RESEND' } } })).status).toBe(200);
    const r = await call('U-ON', 'PUT', '/api/pos/PO-G1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'REPLACEMENT_PENDING', refundAmount: 25, totalRefunded: 25, claimData: null, claimResolution: { type: 'REFUND', refundAmount: 25 }, storeClaims: { A: { isResolved: true, type: 'RESEND' }, B: { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 25 } } });
    expect(r.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
    expect(extraOf()).toMatchObject({ refundAmount: 25, totalRefunded: 25 });
  });

  it('G5 self-buy (PODetailsModal) RESEND by the requester : status WAITING_DELIVERY_ROUND_2, claim cleared, refundAmount 0', async () => {
    seedPo({ status: 'CLAIM_REPORTED', channel: 'SELF' }, { claimData: { reason: 'broken', reportedBy: 'Owner' }, requesterId: 'REQUESTER_PD', claimStatus: 'PENDING_CLAIM' });
    const r = await call('U-L1', 'PUT', '/api/pos/PO-G1', { status: 'WAITING_DELIVERY_ROUND_2', claimStatus: 'RESOLVED_WAITING_DELIVERY', refundAmount: 0, claimData: null, claimResolution: { type: 'RESEND', refundAmount: 0, note: 'n' } });
    expect(r.status).toBe(200);
    expect(extraOf().claimData).toBeUndefined();
    expect(extraOf().refundAmount).toBe(0);
    expect(extraOf().claimResolution).toMatchObject({ type: 'RESEND', resolvedBy: 'Pim Requester' });
  });

  it('G6 self-buy CLOSE_WITH_REFUND by the requester writes the PO refund ; above the PO value = 400 ; CLOSE_NO_ACTION closes', async () => {
    const mk = (id) => seedPo({ status: 'CLAIM_REPORTED', channel: 'SELF' }, { claimData: { reason: 'broken', reportedBy: 'Owner' }, requesterId: 'REQUESTER_PD' }, id);
    mk('PO-G1'); mk('PO-G2'); mk('PO-G3');
    const ok = await call('U-L1', 'PUT', '/api/pos/PO-G1', { status: 'COMPLETED', claimStatus: 'RESOLVED_REFUNDED', refundAmount: 30, totalRefunded: 30, claimData: null, claimResolution: { type: 'CLOSE_WITH_REFUND', refundAmount: 30 } });
    expect(ok.status).toBe(200);
    expect(extraOf('PO-G1')).toMatchObject({ refundAmount: 30, totalRefunded: 30 });
    const big = await call('U-L1', 'PUT', '/api/pos/PO-G2', { status: 'COMPLETED', refundAmount: 150, totalRefunded: 150, claimData: null, claimResolution: { type: 'CLOSE_WITH_REFUND', refundAmount: 150 } });
    expect(big.status).toBe(400);
    expect(extraOf('PO-G2').claimData).toBeDefined();
    const none = await call('U-L1', 'PUT', '/api/pos/PO-G3', { status: 'COMPLETED', claimData: null, claimResolution: { type: 'CLOSE_NO_ACTION', refundAmount: 0 } });
    expect(none.status).toBe(200);
    expect(extraOf('PO-G3').claimData).toBeUndefined();
  });

  it('G7 a requester cannot close an ONLINE claim nor write refund figures on it', async () => {
    seedPo({ status: 'CLAIM_REPORTED', channel: 'ONLINE' }, { claimData: { reason: 'broken', reportedBy: 'Owner' }, requesterId: 'REQUESTER_PD' });
    await call('U-L1', 'PUT', '/api/pos/PO-G1', { status: 'COMPLETED', refundAmount: 50, totalRefunded: 50, claimData: null, claimResolution: { type: 'REFUND', refundAmount: 50 } });
    expect(extraOf().claimData).toBeDefined();
    expect(extraOf().refundAmount).toBeUndefined();
    expect(extraOf().claimResolution).toBeUndefined();
  });
});
