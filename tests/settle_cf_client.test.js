// @vitest-environment node
// T4.6e: the REAL client settle flow (apiService.settlePO -> workflowEngine.settlePO) against the real Cloudflare function (migrated sqlite as D1).
//  - cloudflare mode : editing the actual amount of an already settled PO overwrites the figures but does not credit the LOCAL budget again ;
//    the server's answer (refundedAmount) reaches the caller (the settle modal prints it)
//  - mock mode       : unchanged legacy behaviour (the local budget is credited on every settle)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { apiService } from '../src/services/apiService';
import { workflowEngine } from '../src/services/workflowEngine';
import { storageService } from '../src/services/storageService';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const ONLINE = { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 };

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
    batch: async (stmts) => {
      sdb.exec('BEGIN');
      try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; }
    }
  };
}

const localPo = () => ({
  id: 'id-PO-S-1', poNo: 'PO-S-1', poNumber: 'PO-S-1', department: 'PD', status: 'RECEIVED', grandTotal: 1000,
  items: [{ name: 'A', price: 500, qty: 2 }]
});
const payload = (actual) => ({ actualTotalAmount: actual, savingsAmount: 1000 - actual, settlementNote: '', settlementProofUrl: '', actualItems: [{ actualUnitPrice: actual / 2 }] });
const spent = () => storageService.getBudgets().PD.spent;

describe.skipIf(!DatabaseSync)('settlePO client flow', () => {
  let sdb; let env; let token;

  beforeEach(async () => {
    storageService.resetData();
    storageService.saveBudgetTransactions([]);
    storageService.saveBudgets({ PD: { monthlyBudget: 1000, spent: 500, actualExpense: 500, variance: 500, remainingBudget: 500, pending: 0, history: {}, historicalSpent: {}, refundCredits: {} } });
    storageService.savePOs([localPo()]);
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
      .run(ONLINE.id, ONLINE.username, '', ONLINE.name, ONLINE.department, '["*"]', ONLINE.roleId, ONLINE.canonicalRole, ONLINE.level);
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,1000,500,500)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('id-PR-S', 'PR-S', 'PD', 'PO_ISSUED', 1000, '[]')").run();
    sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES ('K-PR-S', 'PD', 'PD', 'PR_COMMITMENT', 'PR_COMMITMENT', -1000, 'PR-S')").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, grandTotal, extraJson) VALUES ('id-PO-S-1', 'PO-S-1', 'PR-S', 'PD', 'RECEIVED', ?, 1000, ?)")
      .run(JSON.stringify([{ name: 'A', price: 500, qty: 2 }]), JSON.stringify({ approvedTotal: 1000 }));
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: ONLINE.id, userId: ONLINE.id, role: ONLINE.roleId, level: ONLINE.level }, SECRET);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ id: ONLINE.id, token }));
    global.fetch = async (url, init) => {
      const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, init), env });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: res.headers });
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('cloudflare: first settle credits the local budget and returns the server answer ; editing the amount later does NOT credit the local budget again', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const first = await apiService.settlePO('id-PO-S-1', payload(900), ONLINE);
    expect(first.settlementResult).toMatchObject({ success: true, refundedAmount: 100, savingsAmount: 100 });
    expect(spent()).toBe(400); // local: 500 − 100
    expect(sdb.prepare("SELECT totalUsed FROM budgets WHERE id = 'PD'").get().totalUsed).toBe(400);

    const edit = await apiService.settlePO('id-PO-S-1', payload(800), ONLINE); // "edit the actual amount"
    expect(edit.settlementResult).toMatchObject({ success: true, resettled: true, refundedAmount: 0, savingsAmount: 200 });
    expect(edit.actualTotalAmount).toBe(800); // the PO figures are overwritten locally
    expect(spent()).toBe(400); // local budget NOT credited a second time
    expect(sdb.prepare("SELECT totalUsed FROM budgets WHERE id = 'PD'").get().totalUsed).toBe(400); // and neither is the server's
    expect(storageService.getBudgetTransactions().filter((t) => String(t.id).startsWith('BTX-SAVINGS')).length).toBe(1);
  });

  it('cloudflare: the message figure comes from the server (refundedAmount 0 on an edit, the clamped amount when the cap cut it)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    sdb.prepare("UPDATE prs SET totalAmount = 50 WHERE id = 'id-PR-S'").run();
    sdb.prepare("UPDATE budget_transactions SET amount = -50 WHERE id = 'K-PR-S'").run(); // the PR only committed 50
    const r = await apiService.settlePO('id-PO-S-1', payload(900), ONLINE);
    expect(r.settlementResult).toMatchObject({ savingsAmount: 100, refundedAmount: 50, refundClamped: true });
    // this is what POSettlementModal prints : refundedAmount, not the 100 it computed itself
    expect(r.settlementResult.refundedAmount).toBeLessThan(100);
  });

  it('mock mode: unchanged - the local budget is credited on every settle, and no server answer is attached', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const first = await apiService.settlePO('id-PO-S-1', payload(900), ONLINE);
    expect(first.settlementResult).toBeUndefined();
    expect(spent()).toBe(400);
    await workflowEngine.settlePO('id-PO-S-1', payload(800), ONLINE);
    expect(spent()).toBe(200); // credited again (legacy behaviour kept for mock / gas)
  });
});
