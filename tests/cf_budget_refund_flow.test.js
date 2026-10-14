// @vitest-environment node
// End-to-end of the REAL client refund flow against the REAL Cloudflare function (D1 = migrated sqlite) :
// src/services/budgetService.js creditDepartmentBudget  ->  PUT /api/budgets/:dept  ->  POST /api/budget-transactions (REFUND_SETTLEMENT row)
// -> next /api/bootstrap.  The client rolls its local credit back when either request fails, so BOTH must succeed for every role that can close a claim.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { budgetService } from '../src/services/budgetService';
import { storageService } from '../src/services/storageService';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';

const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    // like D1 batch: all statements run in ONE sqlite transaction, with no other request interleaved (each .all() body runs synchronously)
    batch: async (stmts) => {
      sdb.exec('BEGIN');
      try {
        const ps = stmts.map((s) => s.all());
        const out = await Promise.all(ps);
        sdb.exec('COMMIT');
        return out;
      } catch (e) {
        try { sdb.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    }
  };
}

describe.skipIf(!DatabaseSync)('creditDepartmentBudget (real client code) <-> Cloudflare function', () => {
  let sdb; let env; const tokens = {}; let calls;
  const one = (q, ...p) => sdb.prepare(q).get(...p);
  const all = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));

  const loginAs = (who) => localStorage.setItem('prpo_auth_session', JSON.stringify({ id: PERSONAS[who].id, token: tokens[who] }));

  // a PR with its PR_COMMITMENT and POs that carry the approvedTotal snapshot : the base of every refund cap (T4.6)
  const seedPoCap = (po, { pr = 'PR-X', dept = 'PD', approved = 1000, commit = approved } = {}) => {
    if (!sdb.prepare('SELECT id FROM prs WHERE prNumber = ?').get(pr)) {
      sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES (?, ?, ?, 'PO_ISSUED', ?, '[]')").run(`id-${pr}`, pr, dept, commit);
      sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES (?, ?, ?, 'PR_COMMITMENT', 'PR_COMMITMENT', ?, ?)").run(`K-${pr}`, dept, dept, -commit, pr);
    }
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES (?, ?, ?, ?, 'ORDERED', '[]', ?)")
      .run(`id-${po}`, po, pr, dept, JSON.stringify({ approvedTotal: approved }));
  };

  const seed = (used = 300, monthly = 1000) => {
    sdb.prepare("INSERT OR REPLACE INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,?,?,?,?)").run(monthly, monthly, used, monthly - used);
    if (!sdb.prepare("SELECT id FROM pos WHERE poNumber = 'PO-PD-X-001'").get()) {
      // PR-X (commitment 3000) carries three POs of 1000 each
      seedPoCap('PO-PD-X-001', { approved: 1000, commit: 3000 });
      seedPoCap('PO-PD-X-002', { approved: 1000 });
      seedPoCap('PO-PD-X-003', { approved: 1000 });
    }
    // the client's local copy (what bootstrap handed it)
    storageService.saveBudgets({ PD: { monthlyBudget: monthly, spent: used, actualExpense: used, variance: monthly - used, remainingBudget: monthly - used, pending: 0, history: {}, historicalSpent: {}, refundCredits: {} } });
  };

  beforeEach(async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    storageService.resetData();
    storageService.saveBudgetTransactions([]);
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    calls = [];
    global.fetch = async (url, init) => {
      const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, init), env });
      const text = await res.text();
      calls.push({ url, method: (init && init.method) || 'GET', status: res.status, body: text ? JSON.parse(text) : null });
      return new Response(text, { status: res.status, headers: res.headers });
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const credit = (amount, po = 'PO-PD-X-001') => budgetService.creditDepartmentBudget({ department: 'PD', amount, referencePo: po, storeKey: 'S1', actor: 'tester' });

  for (const who of ['L1', 'ONLINE', 'L2', 'L3', 'ADMIN']) {
    it(`${who}: PUT budgets/PD then POST the REFUND_SETTLEMENT ledger row both succeed ; D1 credited once ; bootstrap agrees`, async () => {
      seed(300, 1000);
      loginAs(who);
      const r = await credit(50);
      expect(r).toMatchObject({ success: true, alreadyReconciled: false, budgetSpent: 250, budgetRemaining: 750 });
      expect(calls.map((c) => `${c.method} ${c.url} ${c.status}`)).toEqual(['PUT /api/budgets/PD 200', 'POST /api/budget-transactions 200']);
      expect(calls[1].body).toMatchObject({ duplicate: true, serverManaged: true });

      // D1: totals moved by exactly 50, allocation untouched, one server-written ledger row (CLAIM_CREDIT), no REFUND_SETTLEMENT row from the client
      expect(one("SELECT monthlyBudget, totalUsed, totalRemaining FROM budgets WHERE id = 'PD'")).toMatchObject({ monthlyBudget: 1000, totalUsed: 250, totalRemaining: 750 });
      const ledger = all("SELECT type, actionType, amount, previousAmount, newAmount, dept FROM budget_transactions WHERE actionType != 'PR_COMMITMENT'");
      expect(ledger).toEqual([{ type: 'BUDGET_ROLLBACK', actionType: 'CLAIM_CREDIT', amount: 50, previousAmount: 300, newAmount: 250, dept: 'PD' }]);
      expect(all("SELECT id FROM budget_transactions WHERE actionType = 'REFUND_SETTLEMENT'").length).toBe(0); // so the settle cap never counts a claim credit

      // next bootstrap does not move it back
      const boot = await global.fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${tokens[who]}` } });
      const data = await boot.json();
      expect(data.budgets.PD).toMatchObject({ monthlyBudget: 1000, spent: 250, remainingBudget: 750 });
      expect(data.budgets.PD.refundCredits).not.toEqual({});
      expect(data.budgetTransactions.filter((t) => t.actionType === 'CLAIM_CREDIT').length).toBe(1);
    });
  }

  it('two refunds in a row (different POs) : each credited once, totals add up', async () => {
    seed(300, 1000);
    loginAs('ONLINE');
    await credit(50, 'PO-PD-X-001');
    await credit(20, 'PO-PD-X-002');
    expect(one("SELECT totalUsed, totalRemaining FROM budgets WHERE id = 'PD'")).toMatchObject({ totalUsed: 230, totalRemaining: 770 });
    expect(all("SELECT amount FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT' ORDER BY rowid").map((r) => r.amount)).toEqual([50, 20]);
  });

  it('budget writer (approver / admin) closing a REFUND claim : GAS apiSaveBudgets parity - the body figures are stored (totalUsed, totalRemaining, refundCredits)', async () => {
    seed(300, 1000);
    loginAs('L3');
    await credit(50);
    const row = one("SELECT totalUsed, totalRemaining, refundCreditsJson FROM budgets WHERE id = 'PD'");
    expect(row).toMatchObject({ totalUsed: 250, totalRemaining: 750 });
    expect(Object.values(JSON.parse(row.refundCreditsJson))).toEqual([50]);
  });

  it('two concurrent credit PUTs computed from the same stored figure : credited ONCE, the loser gets 409 and writes nothing', async () => {
    seed(300, 1000);
    let n = 0;
    const put = (who, sameKey = true) => global.fetch('/api/budgets/PD', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
      body: JSON.stringify({ monthlyBudget: 1000, spent: 250, actualExpense: 250, variance: 750, docNo: 'PO-PD-X-001', transactionId: sameKey ? 'REFUND_PO-PD-X-001_S1_50' : `K-${++n}` })
    });
    // (a) plain concurrency : whoever reads after the first commit sees credit 0 (applied:false) or a lower figure (409) - never a second credit
    const res = await Promise.all([put('L1'), put('ONLINE'), put('L1')]);
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(bodies.filter((b) => b.applied === true).length).toBe(1);
    expect(one("SELECT totalUsed, totalRemaining FROM budgets WHERE id = 'PD'")).toMatchObject({ totalUsed: 250, totalRemaining: 750 });
    expect(all("SELECT amount FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'")).toEqual([{ amount: 50 }]);

    // (b) the real race : every request has already read totalUsed = 300 (stale read forced) before any of them writes
    seed(300, 1000);
    sdb.prepare("DELETE FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'").run();
    const real = env.DB;
    env.DB = { ...real, prepare: (q) => (q.startsWith('SELECT monthlyBudget, totalUsed FROM budgets')
      ? { bind: () => ({ first: async () => ({ monthlyBudget: 1000, totalUsed: 300 }) }) } : real.prepare(q)) };
    let raced;
    try {
      raced = await Promise.all([put('L1', false), put('ONLINE', false), put('L1', false)]); // different keys : only the totalUsed guard can stop them
    } finally {
      env.DB = real;
    }
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(one("SELECT totalUsed, totalRemaining FROM budgets WHERE id = 'PD'")).toMatchObject({ totalUsed: 250, totalRemaining: 750 });
    expect(all("SELECT amount FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'")).toEqual([{ amount: 50 }]);
  });

  it('the CLAIM_CREDIT row is labelled with the PO / idempotency key of the client row ; after a bootstrap replaced the local ledger the same refund is NOT credited again', async () => {
    seed(300, 1000);
    loginAs('ONLINE');
    await credit(50, 'PO-PD-X-001');
    expect(all("SELECT docNo, poNumber, docType, transactionId, amount FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'"))
      .toEqual([{ docNo: 'PO-PD-X-001', poNumber: 'PO-PD-X-001', docType: 'PO', transactionId: 'REFUND_PO-PD-X-001_S1_50', amount: 50 }]);

    // reload: local ledger/budgets come from the server only (the client's own row was never stored)
    const boot = await (await global.fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${tokens.ONLINE}` } })).json();
    storageService.saveBudgetTransactions(boot.budgetTransactions);
    storageService.saveBudgets({ PD: { ...boot.budgets.PD, spent: boot.budgets.PD.spent } });
    calls.length = 0;
    const again = await credit(50, 'PO-PD-X-001');
    expect(again).toMatchObject({ success: true, alreadyReconciled: true });
    expect(calls.length).toBe(0);
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(250);

    // a ledger row labelled by somebody else is not touched : another user's refund with the same amount stays separate
    loginAs('L1');
    await credit(50, 'PO-PD-X-002');
    expect(all("SELECT docNo FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT' ORDER BY rowid").map((r) => r.docNo)).toEqual(['PO-PD-X-001', 'PO-PD-X-002']);
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(200);
  });

  describe('T4.6 refunds without the budget permission must name a real PO, within what the PO cut from the budget', () => {
    const raw = (who, path, method, body) => global.fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify(body) });
    const used = () => one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed;

    it('PUT credit: no PO / unknown PO / PO of another department are refused and nothing is written ; the client rolls back', async () => {
      seed(300, 1000);
      sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('QC','QC',2026,500,500,100,400)").run();
      seedPoCap('PO-QC-1', { pr: 'PR-QC', dept: 'QC', approved: 100 });
      for (const who of ['L1', 'ONLINE']) {
        loginAs(who);
        const body = { monthlyBudget: 1000, spent: 250, actualExpense: 250, variance: 750 };
        expect((await raw(who, '/api/budgets/PD', 'PUT', body)).status).toBe(400); // no docNo at all
        expect((await raw(who, '/api/budgets/PD', 'PUT', { ...body, docNo: 'PO-NOPE' })).status).toBe(400);
        expect((await raw(who, '/api/budgets/PD', 'PUT', { ...body, docNo: 'PO-QC-1' })).status).toBe(400); // QC's PO cannot credit PD's budget
        await expect(credit(50, 'PO-NOPE')).rejects.toThrow(); // the real client path
      }
      expect(used()).toBe(300);
      expect(all("SELECT id FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'").length).toBe(0);
      // requester of PD cannot use a PO of QC even for QC's own budget (department gate) ; the online purchaser can (works across departments)
      const qc = { monthlyBudget: 500, spent: 90 };
      expect((await raw('L1', '/api/budgets/QC', 'PUT', { ...qc, docNo: 'PO-QC-1' })).status).toBe(403);
      expect((await raw('ONLINE', '/api/budgets/QC', 'PUT', { ...qc, docNo: 'PO-QC-1' })).status).toBe(200);
    });

    it('total refunded per PO <= approvedTotal : several legitimate refunds (stores / claim rounds) pass, the one that would exceed the cap is refused, then settle and adjust see the same total', async () => {
      seedPoCap('PO-PD-S-001', { pr: 'PR-S', approved: 100, commit: 100 });
      seed(300, 1000);
      loginAs('ONLINE');
      const c = (amount, store) => budgetService.creditDepartmentBudget({ department: 'PD', amount, referencePo: 'PO-PD-S-001', storeKey: store, actor: 't' });
      await c(60, 'STORE-A'); // claim of store A
      await c(30, 'STORE-B'); // claim of store B on the same PO : a second refund of one PO is legitimate
      expect(used()).toBe(210);
      await expect(c(20, 'STORE-C')).rejects.toThrow(/เกินมูลค่า/); // 60 + 30 + 20 > 100
      expect(used()).toBe(210);
      await c(10, 'STORE-D'); // exactly up to the cap
      expect(used()).toBe(200);
      await expect(c(1, 'STORE-E')).rejects.toThrow(/ครบ|เกิน/);
      // other routes share the total : adjust rollback / top-up and settle
      const adj = (action, delta) => raw('ONLINE', '/api/budgets/adjust', 'POST', { dept: 'PD', action, delta, docNo: 'PO-PD-S-001' });
      expect((await adj('BUDGET_ROLLBACK', 1)).status).toBe(400);
      expect((await adj('TOP_UP', 1)).status).toBe(400);
      loginAs('L1');
      const settle = await raw('L1', '/api/pos/id-PO-PD-S-001/settle', 'POST', { refundAmount: 5 });
      expect(settle.status).toBe(200);
      expect((await settle.json()).refundDenied).toBe('NOTHING_LEFT'); // nothing left under the cap, the PO is still closed
      expect(used()).toBe(200);
      // a budget writer is not limited by the cap
      loginAs('L3');
      const w = await raw('L3', '/api/budgets/PD', 'PUT', { monthlyBudget: 1000, spent: 100, docNo: 'PO-PD-S-001' });
      expect(w.status).toBe(200);
      expect(used()).toBe(100);
    });

    it('adjust BUDGET_ROLLBACK / TOP_UP after a claim credit : the PR-level commitment is shared by the POs of the PR', async () => {
      seed(300, 1000); // PR-X commitment 3000, three POs of 1000
      loginAs('L1');
      const adj = (po, delta) => raw('L1', '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta, docNo: po });
      expect((await adj('PO-PD-X-001', 1000)).status).toBe(200);
      expect((await adj('PO-PD-X-001', 1)).status).toBe(400); // PO-001 is exhausted
      expect((await adj('PO-PD-X-002', 1000)).status).toBe(200);
      expect((await adj('PO-PD-X-003', 1000)).status).toBe(200);
      expect(all("SELECT docNo, actionType, actorUserId FROM budget_transactions WHERE type = 'BUDGET_ROLLBACK' ORDER BY rowid"))
        .toEqual([1, 2, 3].map((i) => ({ docNo: `PO-PD-X-00${i}`, actionType: 'BUDGET_ROLLBACK', actorUserId: 'U-L1' })));
    });

    it('a retry of the very same refund (same transactionId) is acknowledged without a second credit', async () => {
      seed(300, 1000);
      const body = { monthlyBudget: 1000, spent: 250, variance: 750, docNo: 'PO-PD-X-001', transactionId: 'REFUND_PO-PD-X-001_S1_50' };
      expect((await raw('ONLINE', '/api/budgets/PD', 'PUT', body)).status).toBe(200);
      const again = await raw('ONLINE', '/api/budgets/PD', 'PUT', { ...body, spent: 200 }); // client re-sends after a lost response
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ applied: false, duplicate: true });
      expect(used()).toBe(250);
    });

    it('TOP_UP (adjust) racing a PUT credit on the same PO near its cap : never budget without a ledger row', async () => {
      for (const order of [0, 1, 2]) {
        sdb.prepare('DELETE FROM budget_transactions').run();
        sdb.prepare('DELETE FROM pos').run();
        sdb.prepare('DELETE FROM prs').run();
        seedPoCap('PO-PD-R-001', { pr: 'PR-R', approved: 100, commit: 100 });
        seed(300, 1000); // seed() adds the PO-PD-X-* rows again after the delete
        const topUp = () => raw('ONLINE', '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'TOP_UP', delta: 70, docNo: 'PO-PD-R-001' });
        const credit = () => raw('L1', '/api/budgets/PD', 'PUT', { monthlyBudget: 1000, spent: 230, actualExpense: 230, variance: 770, docNo: 'PO-PD-R-001', transactionId: `K-R-${order}` });
        const pair = order === 0 ? [topUp(), credit()] : order === 1 ? [credit(), topUp()] : [topUp(), credit(), topUp()];
        const res = await Promise.all(pair);
        const ok = res.filter((r) => r.status === 200).length;
        expect(ok).toBe(1); // 70 + 70 > 100 : exactly one of them fits
        const b = one("SELECT monthlyBudget, totalUsed, totalRemaining FROM budgets WHERE id = 'PD'");
        const ledger = all("SELECT type, amount FROM budget_transactions WHERE docNo = 'PO-PD-R-001'");
        expect(ledger.length).toBe(1);
        // what the budget gained == what the ledger recorded (monthlyBudget grows on TOP_UP, totalUsed falls on a credit)
        expect((b.monthlyBudget - 1000) + (300 - b.totalUsed)).toBe(ledger[0].amount);
        expect(b.totalRemaining - 700).toBe(ledger[0].amount);
      }
    });

    it('the PR-level total counts POs that reference their PR by id only (prId), not just by number', async () => {
      seedPoCap('PO-PD-I-001', { pr: 'PR-I', approved: 100, commit: 100 });
      sdb.prepare("INSERT INTO pos (id, poNumber, prId, prNumber, department, status, itemsJson, extraJson) VALUES ('id-PO-PD-I-002', 'PO-PD-I-002', 'id-PR-I', NULL, 'PD', 'ORDERED', '[]', ?)")
        .run(JSON.stringify({ approvedTotal: 100 }));
      seed(300, 1000);
      const adj = (po, delta) => raw('ONLINE', '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta, docNo: po });
      expect((await adj('PO-PD-I-002', 100)).status).toBe(200); // the PO that only knows its PR by id
      expect((await adj('PO-PD-I-001', 1)).status).toBe(400); // the PR commitment (100) is already given back
    });

    describe('settle (POSettlementModal payload) refunds the savings the SERVER computes', () => {
      const settle = (po, body, who = 'ONLINE') => raw(who, `/api/pos/${po}/settle`, 'POST', body);
      // exactly the payload POSettlementModal.jsx builds (savingsAmount is the client's own figure)
      const payload = (actual, extra = {}) => ({
        actualTotalAmount: actual, savingsAmount: 99999, settlementNote: 'โอนแล้ว', settlementProofUrl: '', settledBy: 'someone else', settledAt: '2000-01-01T00:00:00Z',
        actualItems: [{ name: 'A', actualUnitPrice: 90 }, { name: 'B', actualUnitPrice: 0.5 }], user: { name: 'forged' }, ...extra
      });
      const poRow = (id) => one('SELECT * FROM pos WHERE id = ?', id);
      const ledger = (po) => all(`SELECT type, actionType, amount, docNo FROM budget_transactions WHERE docNo = '${po}' ORDER BY rowid`);
      const seedSettlePo = (po, opts = {}) => {
        seedPoCap(po, opts);
        sdb.prepare('UPDATE pos SET grandTotal = ?, itemsJson = ? WHERE poNumber = ?').run(opts.grand ?? 1000, JSON.stringify([{ name: 'A', price: 100, qty: 5 }, { name: 'B', price: 500, qty: 1 }]), po);
      };

      it('savings = approved value − paid : refunded through REFUND_SETTLEMENT, stored on the PO, status untouched, repeat = duplicate', async () => {
        seedSettlePo('PO-PD-T-001', { pr: 'PR-T', approved: 1000, commit: 1000 });
        seed(300, 1000);
        const r = await settle('PO-PD-T-001', payload(900));
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ success: true, settlementStatus: 'SETTLED', actualTotalAmount: 900, savingsAmount: 100, refundedAmount: 100 }); // not 99999
        expect(used()).toBe(200);
        expect(ledger('PO-PD-T-001')).toEqual([{ type: 'BUDGET_ROLLBACK', actionType: 'REFUND_SETTLEMENT', amount: 100, docNo: 'PO-PD-T-001' }]);
        const p = poRow('id-PO-PD-T-001');
        expect(p.status).toBe('ORDERED'); // GAS / client settlePO only set settlementStatus
        expect(p.actualTotalAmount).toBe(900);
        // what bootstrap hands the client
        const boot = await (await raw('L1', '/api/bootstrap', 'GET')).json();
        const bp = boot.pos.find((x) => x.id === 'id-PO-PD-T-001');
        expect(bp).toMatchObject({ status: 'ORDERED', settlementStatus: 'SETTLED', actualTotalAmount: 900, savingsAmount: 100, settledBy: 'Nat', settlementNote: 'โอนแล้ว' });
        expect(bp.settledAt).not.toBe('2000-01-01T00:00:00Z'); // time and identity come from the server
        expect(bp.actualItems.map((i) => i.actualUnitPrice)).toEqual([90, 0.5]); // explicit prices kept, items carry them too
        expect(bp.items.map((i) => i.actualUnitPrice)).toEqual([90, 0.5]);
        expect(bp.settleToken).toBeUndefined();
        // the same settlement again (a retry / double click) : accepted (it is an edit with the same figures), no second refund
        const again = await (await settle('PO-PD-T-001', payload(900))).json();
        expect(again).toMatchObject({ success: true, resettled: true, refundedAmount: 0 });
        expect(again.duplicate).toBeUndefined();
        expect(used()).toBe(200);
        expect(ledger('PO-PD-T-001').length).toBe(1);
        expect(poRow('id-PO-PD-T-001').actualTotalAmount).toBe(900);
      });

      it('"edit the actual amount" after closing (PODetailsModal) overwrites the settlement fields ; the budget is refunded by the FIRST settlement only (GAS) - nothing more, nothing pulled back', async () => {
        seedSettlePo('PO-PD-T-008', { pr: 'PR-T8', approved: 1000, commit: 1000 });
        seed(500, 1000);
        const bootPo = async () => (await (await raw('L1', '/api/bootstrap', 'GET')).json()).pos.find((x) => x.id === 'id-PO-PD-T-008');
        const first = await (await settle('PO-PD-T-008', payload(900, { settlementNote: 'รอบแรก' }))).json();
        expect(first).toMatchObject({ savingsAmount: 100, refundedAmount: 100 });
        expect(first.resettled).toBeUndefined();
        expect(used()).toBe(400);

        const lower = await settle('PO-PD-T-008', payload(800, { settlementNote: 'แก้เป็น 800' }), 'L1');
        expect(lower.status).toBe(200);
        // savings is recomputed from the latest amount (overwritten, like GAS) but no further refund is paid
        expect(await lower.json()).toMatchObject({ success: true, resettled: true, savingsAmount: 200, refundedAmount: 0 });
        expect(used()).toBe(400);
        expect(ledger('PO-PD-T-008').map((l) => l.amount)).toEqual([100]);
        expect(await bootPo()).toMatchObject({ actualTotalAmount: 800, savingsAmount: 200 });

        const higher = await (await settle('PO-PD-T-008', payload(850, { settlementNote: 'แก้เป็น 850' }))).json();
        expect(higher).toMatchObject({ resettled: true, savingsAmount: 150, refundedAmount: 0 }); // savings went down : no claw-back
        expect(higher.refundSkipped).toBeUndefined();
        expect(used()).toBe(400);
        expect(ledger('PO-PD-T-008').length).toBe(1);
        // reload shows the last figures, written by the editor
        expect(await bootPo()).toMatchObject({ actualTotalAmount: 850, savingsAmount: 150, settlementNote: 'แก้เป็น 850', settlementStatus: 'SETTLED', status: 'ORDERED', settledBy: 'Nat' });
        expect((await bootPo()).actualItems.length).toBe(2);

        // a bigger saving later still refunds nothing more (GAS refunds on the first settlement only)
        const deeper = await (await settle('PO-PD-T-008', payload(700))).json();
        expect(deeper).toMatchObject({ savingsAmount: 300, refundedAmount: 0 });
        expect(used()).toBe(400);
        expect(ledger('PO-PD-T-008').reduce((s, l) => s + l.amount, 0)).toBe(100);
      });

      it('two concurrent edits of a settled PO refund nothing and both overwrite (last write wins)', async () => {
        seedSettlePo('PO-PD-T-009', { pr: 'PR-T9', approved: 1000, commit: 1000 });
        seed(500, 1000);
        await settle('PO-PD-T-009', payload(900)); // refunds 100
        const res = await Promise.all([settle('PO-PD-T-009', payload(800)), settle('PO-PD-T-009', payload(800), 'L1'), settle('PO-PD-T-009', payload(800))]);
        const bodies = await Promise.all(res.map((r) => r.json()));
        expect(bodies.every((b) => b.success === true)).toBe(true);
        expect(bodies.reduce((s, b) => s + b.refundedAmount, 0)).toBe(0);
        expect(ledger('PO-PD-T-009').reduce((s, l) => s + l.amount, 0)).toBe(100); // only the first settlement's refund
        expect(used()).toBe(400);
        expect(poRow('id-PO-PD-T-009').actualTotalAmount).toBe(800);
      });

      it('paid MORE than approved : nothing is refunded and nothing extra is deducted (GAS) ; the negative savings is stored', async () => {
        seedSettlePo('PO-PD-T-002', { pr: 'PR-T2', approved: 1000, commit: 1000 });
        seed(300, 1000);
        const r = await (await settle('PO-PD-T-002', payload(1200))).json();
        expect(r).toMatchObject({ success: true, savingsAmount: -200, refundedAmount: 0 });
        expect(r.refundSkipped).toBeUndefined();
        expect(used()).toBe(300);
        expect(ledger('PO-PD-T-002')).toEqual([]);
        expect(poRow('id-PO-PD-T-002')).toMatchObject({ actualTotalAmount: 1200, status: 'ORDERED' });
      });

      it('what was already given back on the PO (online price drop via adjust / a claim credit) is not refunded a second time ; an extra deduction is part of the base', async () => {
        seedSettlePo('PO-PD-T-003', { pr: 'PR-T3', approved: 1000, commit: 1000 });
        seed(300, 1000);
        // acknowledge of an online order : price dropped by 100 -> adjust BUDGET_ROLLBACK 100
        expect((await raw('ONLINE', '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta: 100, docNo: 'PO-PD-T-003' })).status).toBe(200);
        const r = await (await settle('PO-PD-T-003', payload(900))).json(); // paid 900 = what is left after that rollback -> no savings left
        expect(r).toMatchObject({ savingsAmount: 0, refundedAmount: 0 });
        expect(used()).toBe(200);

        seedSettlePo('PO-PD-T-004', { pr: 'PR-T4', approved: 1000, commit: 1000 });
        expect((await raw('ONLINE', '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'BUDGET_DEDUCT', delta: -100, docNo: 'PO-PD-T-004' })).status).toBe(200);
        expect(used()).toBe(300);
        const d = await (await settle('PO-PD-T-004', payload(1000))).json(); // budget cut 1100, paid 1000 -> 100 comes back
        expect(d).toMatchObject({ savingsAmount: 100, refundedAmount: 100 });
        expect(used()).toBe(200);
      });

      it('savings above what the shared cap allows are clamped (refundClamped), the settlement is still recorded', async () => {
        seedSettlePo('PO-PD-T-005', { pr: 'PR-T5', approved: 1000, commit: 50 }); // the PR commitment is only 50
        seed(300, 1000);
        const r = await (await settle('PO-PD-T-005', payload(900))).json();
        expect(r).toMatchObject({ success: true, settlementStatus: 'SETTLED', savingsAmount: 100, refundedAmount: 50, refundClamped: true, refundRequested: 100 });
        expect(used()).toBe(250);
        expect(ledger('PO-PD-T-005').map((l) => l.amount)).toEqual([50]);
      });

      it('no server snapshot / no commitment : settled without a refund (refundDenied) ; invalid amounts are 400 ; a hostile proof link is refused', async () => {
        seed(300, 1000);
        sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, grandTotal) VALUES ('id-PO-OLD', 'PO-OLD', 'PD', 'ORDERED', '[]', 1000)").run();
        const old = await (await settle('PO-OLD', payload(900))).json();
        expect(old).toMatchObject({ success: true, settlementStatus: 'SETTLED', refundSkipped: true, refundDenied: 'NO_PR', refundedAmount: 0 });
        expect(old.savingsAmount).toBe(100); // figure shown comes from grandTotal like GAS, nothing is paid out
        expect(used()).toBe(300);
        seedSettlePo('PO-PD-T-006', { pr: 'PR-T6', approved: 1000, commit: 1000 });
        for (const bad of ['abc', -5, {}]) expect((await settle('PO-PD-T-006', payload(bad))).status, String(bad)).toBe(400);
        expect((await settle('PO-PD-T-006', payload(900, { settlementProofUrl: 'javascript:alert(1)' }))).status).toBe(400);
        expect(poRow('id-PO-PD-T-006').extraJson).not.toContain('SETTLED');
      });

      it('three concurrent FIRST settles with different amounts : the refund never exceeds the savings of the biggest one, and is paid at most once per euro', async () => {
        seedSettlePo('PO-PD-T-007', { pr: 'PR-T7', approved: 1000, commit: 1000 });
        seed(500, 1000);
        const res = await Promise.all([settle('PO-PD-T-007', payload(900)), settle('PO-PD-T-007', payload(800), 'L1'), settle('PO-PD-T-007', payload(700))]);
        const bodies = await Promise.all(res.map((r) => r.json()));
        expect(bodies.every((b) => b.success === true)).toBe(true);
        const total = ledger('PO-PD-T-007').reduce((s, l) => s + l.amount, 0);
        expect(total).toBeLessThanOrEqual(300); // largest savings requested (1000 − 700)
        expect(used()).toBe(500 - total);
        expect(bodies.reduce((s, b) => s + b.refundedAmount, 0)).toBe(total);
      });
    });

    it('two concurrent refunds that together exceed the cap : only one passes (the cap is re-checked inside the INSERT)', async () => {
      seedPoCap('PO-PD-C-001', { pr: 'PR-C', approved: 100, commit: 100 });
      seed(300, 1000);
      const adj = (who, delta) => raw(who, '/api/budgets/adjust', 'POST', { dept: 'PD', action: 'BUDGET_ROLLBACK', delta, docNo: 'PO-PD-C-001' });
      const res = await Promise.all([adj('L1', 70), adj('ONLINE', 70), adj('L1', 70)]);
      const statuses = res.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200).length).toBe(1);
      expect(statuses.every((s) => s === 200 || s === 400 || s === 409)).toBe(true);
      expect(used()).toBe(230);
    });
  });

  it('budget writer sending only actualExpense : totals are computed from it and the ledger row is written in the same batch as the upsert', async () => {
    seed(300, 1000);
    const put = (body) => global.fetch('/api/budgets/PD', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.L3}` }, body: JSON.stringify(body) });
    expect((await put({ monthlyBudget: 1000, actualExpense: 250 })).status).toBe(200);
    expect(one("SELECT totalUsed, totalRemaining FROM budgets WHERE id = 'PD'")).toMatchObject({ totalUsed: 250, totalRemaining: 750 });
    expect(all("SELECT amount FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'")).toEqual([{ amount: 50 }]);

    // ledger insert fails -> the upsert is rolled back too (one transaction)
    const real = env.DB;
    env.DB = { ...real, prepare: (q) => (q.includes('INSERT INTO budget_transactions') ? { bind: () => ({ all: async () => { throw new Error('ledger down'); }, run: async () => { throw new Error('ledger down'); } }) } : real.prepare(q)) };
    try {
      expect((await put({ monthlyBudget: 1000, actualExpense: 200 })).status).toBe(500);
    } finally {
      env.DB = real;
    }
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(250);
    expect(all("SELECT id FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT'").length).toBe(1);
  });

  it('stale client (D1 already lower than the client thinks) : PUT answers 409 and nothing is written ; the client rolls its local credit back', async () => {
    seed(300, 1000);
    sdb.prepare("UPDATE budgets SET totalUsed = 100, totalRemaining = 900 WHERE id = 'PD'").run(); // somebody else refunded in the meantime
    loginAs('L1');
    // local copy still says 300 -> credit(50) sends spent = 250 which is ABOVE the stored 100 -> 409
    await expect(credit(50)).rejects.toThrow();
    expect(calls[0]).toMatchObject({ method: 'PUT', status: 409 });
    expect(calls[0].body.error).toContain('รีเฟรช');
    expect(calls.length).toBe(1);
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'PD'").totalUsed).toBe(100);
    expect(all("SELECT id FROM budget_transactions WHERE actionType != 'PR_COMMITMENT'").length).toBe(0);
  });
});
