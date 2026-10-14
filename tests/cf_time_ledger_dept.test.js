// @vitest-environment node
// D1 CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) leaves the server as ISO-Z ; document dates are untouched ;
// ledger rows stored as "ฝ่าย PD" (client labels) are visible to the PD requester, and new client rows are stored as "PD".
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { sqliteUtcToIso, utcIsoRow } from '../functions/_lib/timefmt.js';
import { ledgerDeptCode } from '../functions/_lib/rbac.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.all()); return o; } };
}

describe('timefmt (pure)', () => {
  it('converts only the SQLite UTC shape', () => {
    expect(sqliteUtcToIso('2026-10-12 15:58:00')).toBe('2026-10-12T15:58:00.000Z');
    expect(sqliteUtcToIso('2026-10-12T15:58:00.000Z')).toBe('2026-10-12T15:58:00.000Z');
    expect(sqliteUtcToIso('2026-10-12')).toBe('2026-10-12');
    expect(sqliteUtcToIso('')).toBe('');
    expect(sqliteUtcToIso(null)).toBe(null);
    expect(sqliteUtcToIso('not a date')).toBe('not a date');
  });
  it('utcIsoRow touches only the time columns', () => {
    const r = { createdAt: '2026-10-12 15:58:00', updatedAt: '2026-10-12T01:00:00.000Z', docDate: '2026-10-12 08:00:00', note: '2026-10-12 08:00:00' };
    expect(utcIsoRow(r)).toEqual({ createdAt: '2026-10-12T15:58:00.000Z', updatedAt: '2026-10-12T01:00:00.000Z', docDate: '2026-10-12 08:00:00', note: '2026-10-12 08:00:00' });
    expect(r.createdAt).toBe('2026-10-12 15:58:00'); // input untouched
  });
  it('ledgerDeptCode', () => {
    expect(['ฝ่าย PD', 'PD', 'pd', 'DEPT-PD', ' ฝ่ายPD ', '\tฝ่าย  PD\n', ' ฝ่ายDEPT-ALL'].map(ledgerDeptCode)).toEqual(['PD', 'PD', 'PD', 'PD', 'PD', 'PD', 'ALL']);
  });
});

describe.skipIf(!DatabaseSync)('D1 integration', () => {
  let sdb; let env; let token;
  const call = async (method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ledger = (id, dept, type) => sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, createdAt) VALUES (?,?,?,?,?,?,'2026-10-12T10:00:00.000Z')").run(id, dept, dept, type, type, -10);

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, title) VALUES ('U-1','req.pd','H','Req','PD','[\"PD\"]','REQUESTER_PD','REQUESTER',1,'ACTIVE','Req')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: 'U-1', userId: 'U-1', role: 'REQUESTER_PD', level: 1 }, SECRET);
  });

  it('PR / stock log times written by D1 defaults come out as ISO-Z ; a date-only field is left alone', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson, createdAt, updatedAt, extraJson) VALUES ('PR-1','PD001','PD','SUBMITTED',500,'[]','2026-10-12 15:58:00','2026-10-12 15:58:00', ?)").run(JSON.stringify({ docDate: '2026-10-12' }));
    sdb.prepare("INSERT INTO stock_logs (id, productId, type, quantity, balance, department, createdAt) VALUES ('SL-1','P-1','IN',1,1,'PD','2026-10-12 15:58:00')").run();
    const b = (await call('GET', '/api/bootstrap')).json;
    const pr = b.prs.find((x) => x.id === 'PR-1');
    expect(pr.createdAt).toBe('2026-10-12T15:58:00.000Z');
    expect(pr.updatedAt).toBe('2026-10-12T15:58:00.000Z');
    expect(pr.docDate).toBe('2026-10-12');
    expect(b.stockLogs.find((x) => x.id === 'SL-1').createdAt).toBe('2026-10-12T15:58:00.000Z');
    expect((await call('GET', '/api/prs')).json.find((x) => x.id === 'PR-1').createdAt).toBe('2026-10-12T15:58:00.000Z');
    // stored value is not rewritten
    expect(sdb.prepare("SELECT createdAt FROM prs WHERE id='PR-1'").get().createdAt).toBe('2026-10-12 15:58:00');
  });

  it('requester sees all 7 ledger rows including old "ฝ่าย PD" ones ; other departments stay hidden', async () => {
    ['ACTUAL_SPEND', 'PR_RELEASE', 'PO_CANCEL_REFUND', 'X1'].forEach((t, i) => ledger(`L-${i}`, 'ฝ่าย PD', t));
    ['PR_COMMITMENT', 'PR_COMMITMENT', 'BUDGET_ROLLBACK'].forEach((t, i) => ledger(`S-${i}`, 'PD', t));
    ledger('Q-1', 'QC', 'PR_COMMITMENT');
    const b = (await call('GET', '/api/bootstrap')).json;
    expect(b.budgetTransactions.map((t) => t.id).sort()).toEqual(['L-0', 'L-1', 'L-2', 'L-3', 'S-0', 'S-1', 'S-2']);
    expect((await call('GET', '/api/budget-transactions')).json).toHaveLength(7);
    expect((await call('GET', '/api/budget-transactions?department=PD')).json).toHaveLength(7);
    expect(sdb.prepare("SELECT COUNT(*) c FROM budget_transactions WHERE dept = 'ฝ่าย PD'").get().c).toBe(4); // old rows not rewritten
  });

  it('wildcard department spelled with the "ฝ่าย" prefix / stray whitespace is refused for a non-admin (ledger POST and budgets/adjust)', async () => {
    const variants = [' ฝ่ายALL', ' ฝ่าย ALL', ' ฝ่ายDEPT-ALL', '\tฝ่ายALL', 'ฝ่าย*', '\t ฝ่าย  both '];
    for (const [i, d] of variants.entries()) {
      const r = await call('POST', '/api/budget-transactions', { id: `TX-W${i}`, type: 'ACTUAL_SPEND', dept: d, department: d, amount: -5 });
      expect(r.status, JSON.stringify(d)).toBe(403);
      const a = await call('POST', '/api/budgets/adjust', { dept: d, action: 'BUDGET_ROLLBACK', delta: 5 });
      expect(a.status, JSON.stringify(d)).toBe(403);
    }
    expect(sdb.prepare("SELECT COUNT(*) c FROM budget_transactions WHERE id LIKE 'TX-W%'").get().c).toBe(0);
  });

  it('dept / department that are empty after normalising or disagree are refused ; nothing is stored', async () => {
    const bad = [{ dept: 'ฝ่าย', department: 'QC' }, { dept: ' ', department: 'QC' }, { dept: 'PD', department: 'QC' }, { dept: 'QC', department: 'ฝ่าย' }, { department: ' ' }];
    for (const [i, d] of bad.entries()) {
      const r = await call('POST', '/api/budget-transactions', { id: `TX-B${i}`, type: 'ACTUAL_SPEND', amount: -5, ...d });
      expect([400, 403], JSON.stringify(d)).toContain(r.status);
    }
    expect(sdb.prepare("SELECT COUNT(*) c FROM budget_transactions WHERE id LIKE 'TX-B%'").get().c).toBe(0);
  });

  it('real client shapes : "ฝ่าย PD" on one or both fields -> dept = department = PD', async () => {
    const shapes = [{ department: 'ฝ่าย PD' }, { dept: 'ฝ่าย PD', department: 'ฝ่าย PD' }, { dept: 'PD' }, { dept: 'ฝ่าย PD', department: 'PD' }];
    const types = ['ACTUAL_SPEND', 'PR_RELEASE', 'PO_CANCEL_REFUND', 'ACTUAL_SPEND'];
    for (const [i, s] of shapes.entries()) {
      const r = await call('POST', '/api/budget-transactions', { id: `TX-OK${i}`, type: types[i], amount: -5, ...s });
      expect(r.status, JSON.stringify(s)).toBe(200);
      expect({ ...sdb.prepare('SELECT dept, department FROM budget_transactions WHERE id = ?').get(`TX-OK${i}`) }).toEqual({ dept: 'PD', department: 'PD' });
    }
  });

  it('a client row sent as "ฝ่าย PD" is stored as PD', async () => {
    const r = await call('POST', '/api/budget-transactions', { id: 'TX-NEW', type: 'ACTUAL_SPEND', dept: 'ฝ่าย PD', department: 'ฝ่าย PD', amount: -5, docNo: 'PD001', docType: 'PR' });
    expect(r.status).toBe(200);
    const row = sdb.prepare("SELECT dept, department FROM budget_transactions WHERE id = 'TX-NEW'").get();
    expect({ ...row }).toEqual({ dept: 'PD', department: 'PD' });
  });
});
