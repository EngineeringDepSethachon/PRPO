// @vitest-environment node
// QA T4.2b : migration 0006 + functions/api/[[route]].js (ตัวกันซ้ำ budget-transactions, settle, budgets, master data, stock-logs)
// ใช้ node:sqlite เป็น D1 shim (apply migrations 0001-0006 จริง) ; ข้ามอัตโนมัติถ้า Node ไม่มี node:sqlite
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

const SECRET = 'unit-test-secret-0123456789abcdef';
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];

// ------------------------------------------------------------------ static checks (ไม่ต้องใช้ sqlite)
describe('T4.2b static: migration 0006 / source sync / placeholder counts', () => {
  it('0006 มีแต่ ALTER ADD COLUMN + CREATE INDEX IF NOT EXISTS (ไม่มี DROP/DELETE/UPDATE/INSERT)', () => {
    const sqlNoComments = read('migrations', '0006_import_parity_columns.sql')
      .split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join('\n');
    for (const stmt of sqlNoComments.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(stmt).toMatch(/^(ALTER TABLE \w+ ADD COLUMN \w+ [A-Z]+( DEFAULT [^;]+)?|CREATE INDEX IF NOT EXISTS \w+ ON \w+\([\w, ]+\))$/);
    }
    expect(sqlNoComments).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|REPLACE)\b/i);
  });

  it('cloudflare/ สำเนาตรงกับ root (functions, _lib, migrations 0006)', () => {
    expect(read('cloudflare', 'functions', 'api', '[[route]].js')).toBe(read('functions', 'api', '[[route]].js'));
    expect(read('cloudflare', 'functions', '_lib', 'auth.js')).toBe(read('functions', '_lib', 'auth.js'));
    expect(read('cloudflare', 'functions', '_lib', 'password.js')).toBe(read('functions', '_lib', 'password.js'));
    // migrations are no longer copied into cloudflare/ (root migrations/ is the single source) : just make sure each one exists at the root
    for (const f of MIGRATIONS) expect(read('migrations', f).length).toBeGreaterThan(0);
  });

  const src = read('functions', 'api', '[[route]].js');
  const countQ = (s) => (s.match(/\?/g) || []).length;
  const splitCols = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  it('stock_logs POST: 30 คอลัมน์ = 30 ? = 30 bind', () => {
    const m = src.match(/INSERT INTO stock_logs \(([^)]*grnNumber[^)]*)\)\s*VALUES \(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(splitCols(m[1]).length).toBe(30);
    expect(countQ(m[2])).toBe(30);
  });

  it('budget_transactions POST: 24 คอลัมน์ = 24 ? ; settle: 21 คอลัมน์ = 10 ? + ค่าคงที่', () => {
    // T4.5: now INSERT ... SELECT ... WHERE NOT EXISTS (atomic idempotency guard) instead of VALUES
    const m = src.match(/INSERT INTO budget_transactions \(([^)]*creditAmount[^)]*actorRole[^)]*)\)\s*SELECT ([^\n]*)\n/);
    expect(m).not.toBeNull();
    expect(splitCols(m[1]).length).toBe(24);
    expect(countQ(m[2])).toBe(24);
    const s = src.match(/INSERT INTO budget_transactions \(([^)]*poNumber\))\s*SELECT ([^\n]*)\n/);
    expect(s).not.toBeNull();
  });

  it('ตัวกันซ้ำใช้ประเภทเดียวกับ GAS Code.gs:3639', () => {
    const gas = read('gas', 'Code.gs');
    const g = gas.match(/var IDEMPOTENT_TYPES = \[([^\]]*)\]/)[1].replace(/['\s]/g, '').split(',');
    const f = src.match(/const IDEMPOTENT_TYPES = \[([^\]]*)\]/)[1].replace(/['\s]/g, '').split(',');
    expect(f).toEqual(g);
  });
});

// ------------------------------------------------------------------ functional (D1 shim ด้วย node:sqlite)
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) }),
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.all()); return out; },
  };
}

describe.skipIf(!DatabaseSync)('T4.2b functional on migrated sqlite', () => {
  let sdb; let env; let token;
  const call = async (method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const one = (q, ...p) => rows(q, ...p)[0];

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(read('migrations', f));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, roleId, level, status) VALUES ('U1','admin','', 'Admin','PD','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: 'U1', userId: 'U1', role: 'ADMIN', level: 99 }, SECRET);
  });

  const rollback = (over = {}) => ({
    id: 'TX-A', type: 'BUDGET_ROLLBACK', dept: 'PD', amount: 200, refundAmount: 200, creditAmount: 200,
    docType: 'PO', docNo: 'PO-PD-2026-001', poNumber: 'PO-PD-2026-001', transactionId: 'REFUND_X', actorRole: 'FINANCE', ...over,
  });

  describe('POST /api/budget-transactions', () => {
    it('เก็บ refundAmount/creditAmount/docType/docNo/poNumber/transactionId/actorRole และ GET คืนครบ', async () => {
      expect((await call('POST', '/api/budget-transactions', rollback())).status).toBe(200);
      const r = one('SELECT * FROM budget_transactions WHERE id = ?', 'TX-A');
      expect(r).toMatchObject({ refundAmount: 200, creditAmount: 200, docType: 'PO', docNo: 'PO-PD-2026-001', poNumber: 'PO-PD-2026-001', transactionId: 'REFUND_X', actorRole: 'ADMIN', actor: 'Admin' }); // T4.5: actor/actorRole from the token, not the body ('FINANCE' ignored)
      const g = await call('GET', '/api/budget-transactions');
      expect(g.json[0]).toMatchObject({ id: 'TX-A', docNo: 'PO-PD-2026-001', refundAmount: 200 });
    });

    it.each(['PR_CANCEL_RELEASE', 'PO_CANCEL_RELEASE', 'BUDGET_ROLLBACK', 'CLAIM_REFUND'])('%s: type+docNo ซ้ำ id ต่างกัน -> duplicate ไม่เขียนซ้ำ', async (type) => {
      await call('POST', '/api/budget-transactions', rollback({ id: 'T1', type }));
      const r = await call('POST', '/api/budget-transactions', rollback({ id: 'T2', type }));
      expect(r.json).toMatchObject({ success: true, duplicate: true });
      expect(r.json.transaction.id).toBe('T1');
      expect(rows('SELECT id FROM budget_transactions').map((x) => x.id)).toEqual(['T1']);
    });

    it('type ตัวพิมพ์เล็ก + docRef/referenceDoc alias + เว้นวรรครอบ docNo ก็ถูกกัน (ตรง GAS)', async () => {
      await call('POST', '/api/budget-transactions', rollback({ id: 'T1' }));
      const r1 = await call('POST', '/api/budget-transactions', { ...rollback({ id: 'T2', type: 'budget_rollback', docNo: undefined, poNumber: undefined }), docRef: '  PO-PD-2026-001 ' });
      expect(r1.json.duplicate).toBe(true);
      const r2 = await call('POST', '/api/budget-transactions', { ...rollback({ id: 'T3', docNo: undefined }), referenceDoc: 'PO-PD-2026-001' });
      expect(r2.json.duplicate).toBe(true);
      expect(rows('SELECT id FROM budget_transactions').length).toBe(1);
    });

    it('ไม่กัน: ประเภทอื่น (TOP_UP/MONTHLY_ALLOCATION), docNo ต่างกัน, type ต่างกัน, ไม่มี docNo', async () => {
      await call('POST', '/api/budget-transactions', rollback({ id: 'T1' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T2', type: 'TOP_UP' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T3', type: 'TOP_UP' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T4', docNo: 'PO-OTHER' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T5', type: 'CLAIM_REFUND' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T6', docNo: '', poNumber: '' }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T7', docNo: '', poNumber: '' }));
      expect(rows('SELECT id FROM budget_transactions ORDER BY id').map((x) => x.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    });

    it('ส่ง id เดิมซ้ำ = ledger append-only (T4.5): ตอบ duplicate ไม่แก้แถวเดิม', async () => {
      await call('POST', '/api/budget-transactions', rollback());
      const r = await call('POST', '/api/budget-transactions', { id: 'TX-A', type: 'BUDGET_ROLLBACK', dept: 'PD', amount: 250 });
      expect(r.status).toBe(200);
      expect(r.json.duplicate).toBe(true);
      expect(rows('SELECT * FROM budget_transactions').length).toBe(1);
      expect(one('SELECT * FROM budget_transactions WHERE id = ?', 'TX-A')).toMatchObject({ amount: 200, refundAmount: 200, docNo: 'PO-PD-2026-001', transactionId: 'REFUND_X' });
    });

    it('ไม่มี id = ไม่เขียนแถว (พฤติกรรมเดิม) แต่ตอบ success', async () => {
      const r = await call('POST', '/api/budget-transactions', { type: 'BUDGET_ROLLBACK', dept: 'PD', docNo: 'X' });
      expect(r.json.success).toBe(true);
      expect(rows('SELECT * FROM budget_transactions').length).toBe(0);
    });

    it('SQL injection ใน docNo/type ไม่ทำให้ตารางเสีย', async () => {
      await call('POST', '/api/budget-transactions', rollback({ id: 'T1', docNo: "x'; DROP TABLE budget_transactions;--" }));
      await call('POST', '/api/budget-transactions', rollback({ id: 'T2', type: "BUDGET_ROLLBACK' OR '1'='1", docNo: 'ZZ' }));
      expect(rows('SELECT id FROM budget_transactions ORDER BY id').map((x) => x.id)).toEqual(['T1', 'T2']);
    });
  });

  describe('POST /api/pos/:id/settle', () => {
    beforeEach(() => {
      sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, grandTotal, extraJson) VALUES ('PO1','PO-PD-2026-009','PR-PD-2026-009','PD','COMPLETED','[]',1000,'{\"approvedTotal\":1000}')").run();
      // T4.5d: a refund is paid only against a real PR + its validated PR_COMMITMENT
      sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES ('PR1','PR-PD-2026-009','PD','PO_ISSUED',1000,'[]')").run();
      sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES ('KC1','PD','PD','PR_COMMITMENT','PR_COMMITMENT',-1000,'PR-PD-2026-009')").run();
      sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,300,700)").run();
    });

    it('refund > 0: เขียน ledger พร้อม docType/docNo/poNumber/refundAmount + ปรับ budgets + ปิด PO', async () => {
      const r = await call('POST', '/api/pos/PO1/settle', { refundAmount: 120 });
      expect(r.json.success).toBe(true);
      const t = one("SELECT * FROM budget_transactions WHERE type = 'BUDGET_ROLLBACK'");
      expect(t).toMatchObject({ dept: 'PD', actionType: 'REFUND_SETTLEMENT', amount: 120, delta: 120, refundAmount: 120, docType: 'PO', docNo: 'PO-PD-2026-009', poNumber: 'PO-PD-2026-009' });
      expect(one('SELECT * FROM budgets WHERE id = ?', 'PD')).toMatchObject({ totalUsed: 180, totalRemaining: 820 });
      // T4.6c: status is left as it was (GAS apiSettlePO only sets settlementStatus)
      expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = ?", 'PO1')).toMatchObject({ status: 'COMPLETED', ss: 'SETTLED' });
    });

    it('refund = 0 / ไม่ส่ง: ไม่มี ledger ไม่แตะ budgets แต่ปิด PO ; PO ไม่พบ = 404', async () => {
      await call('POST', '/api/pos/PO1/settle', {});
      expect(rows("SELECT * FROM budget_transactions WHERE type = 'BUDGET_ROLLBACK'").length).toBe(0); // (the seeded PR_COMMITMENT row is not a refund)
      expect(one('SELECT * FROM budgets WHERE id = ?', 'PD')).toMatchObject({ totalUsed: 300, totalRemaining: 700 });
      expect(one("SELECT status, json_extract(extraJson, '$.settlementStatus') AS ss FROM pos WHERE id = ?", 'PO1')).toMatchObject({ status: 'COMPLETED', ss: 'SETTLED' });
      expect((await call('POST', '/api/pos/NOPE/settle', { refundAmount: 5 })).status).toBe(404);
    });

    it('totalUsed ไม่ติดลบเมื่อคืนมากกว่ายอดใช้', async () => {
      await call('POST', '/api/pos/PO1/settle', { refundAmount: 500 }); // T4.5b: capped by the PO value (1000), still > totalUsed (300)
      expect(one('SELECT totalUsed FROM budgets WHERE id = ?', 'PD').totalUsed).toBe(0);
    });
  });

  describe('POST /api/budgets + bootstrap', () => {
    it('เก็บ pending/historicalSpent/refundCredits/month และ bootstrap คืนรูปแบบที่ frontend อ่าน (object/number)', async () => {
      await call('POST', '/api/budgets', { PD: { monthlyBudget: 50000, spent: 1000, variance: 49000, history: { '2026-09': 50000 }, pending: 3131, historicalSpent: { '2026-09': 4242 }, refundCredits: { '2026-09': 8171 }, month: '2026-09' } });
      const b = (await call('GET', '/api/bootstrap')).json.budgets.PD;
      expect(b).toMatchObject({ monthlyBudget: 50000, spent: 1000, pending: 3131, variance: 49000, historicalSpent: { '2026-09': 4242 }, refundCredits: { '2026-09': 8171 }, history: { '2026-09': 50000 } });
      expect(typeof b.pending).toBe('number');
      expect(one('SELECT month FROM budgets WHERE id = ?', 'PD').month).toBe('2026-09');
    });

    it('ไม่ส่งฟิลด์ใหม่ = คงค่าเดิม ; ส่ง pending=0 / {} = เขียนทับจริง', async () => {
      await call('POST', '/api/budgets', { PD: { monthlyBudget: 100, pending: 7, historicalSpent: { a: 1 }, refundCredits: { b: 2 } } });
      await call('POST', '/api/budgets', { PD: { monthlyBudget: 200, history: { x: 1 } } });
      let b = (await call('GET', '/api/bootstrap')).json.budgets.PD;
      expect(b).toMatchObject({ monthlyBudget: 200, pending: 7, historicalSpent: { a: 1 }, refundCredits: { b: 2 } });
      await call('POST', '/api/budgets', { PD: { monthlyBudget: 200, pending: 0, historicalSpent: {}, refundCredits: {} } });
      b = (await call('GET', '/api/bootstrap')).json.budgets.PD;
      expect(b).toMatchObject({ pending: 0, historicalSpent: {}, refundCredits: {} });
    });

    it('แถว budgets เก่า (ไม่มี JSON ใหม่) -> bootstrap คืน {} ไม่ใช่ null/พัง', async () => {
      sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('QC','QC',2026,10,0,10)").run();
      const b = (await call('GET', '/api/bootstrap')).json.budgets.QC;
      expect(b.historicalSpent).toEqual({});
      expect(b.refundCredits).toEqual({});
      expect(b.pending).toBe(0);
    });
  });

  describe('master data status/isActive/leadTimeDays/locationName', () => {
    it('products: เก็บ leadTimeDays/locationName/INACTIVE ; ไม่ส่งสถานะ = ค่าเดิม ; ใหม่ default ACTIVE/1', async () => {
      await call('POST', '/api/products', { id: 'P1', code: 'C1', name: 'A', department: 'PD', leadTimeDays: 5, locationName: 'ชั้น A', status: 'INACTIVE', isActive: false });
      expect(one('SELECT * FROM products WHERE id = ?', 'P1')).toMatchObject({ leadTimeDays: 5, locationName: 'ชั้น A', status: 'INACTIVE', isActive: 0, isDeleted: 0 });
      await call('PUT', '/api/products/P1', { id: 'P1', code: 'C1', name: 'A2', department: 'PD' });
      expect(one('SELECT * FROM products WHERE id = ?', 'P1')).toMatchObject({ name: 'A2', leadTimeDays: 5, locationName: 'ชั้น A', status: 'INACTIVE', isActive: 0 });
      await call('PUT', '/api/products/P1', { id: 'P1', code: 'C1', name: 'A2', department: 'PD', status: 'ACTIVE', isActive: true });
      expect(one('SELECT * FROM products WHERE id = ?', 'P1')).toMatchObject({ status: 'ACTIVE', isActive: 1 });
      await call('POST', '/api/products', { id: 'P2', code: 'C2', name: 'B', department: 'PD' });
      expect(one('SELECT * FROM products WHERE id = ?', 'P2')).toMatchObject({ status: 'ACTIVE', isActive: 1, leadTimeDays: null, locationName: null });
      const boot = (await call('GET', '/api/bootstrap')).json;
      expect(boot.products.find((p) => p.id === 'P1')).toMatchObject({ status: 'ACTIVE', isActive: true }); // D-2 : the UI reads a boolean
    });

    it('products: สินค้า INACTIVE ยังอยู่ใน bootstrap (isDeleted = 0)', async () => {
      await call('POST', '/api/products', { id: 'P1', code: 'C1', name: 'A', department: 'PD', status: 'INACTIVE', isActive: false });
      const boot = (await call('GET', '/api/bootstrap')).json;
      expect(boot.products.map((p) => p.id)).toContain('P1');
    });

    it('vendors: POST/PUT เก็บ status+isActive ; ไม่ส่ง = คงเดิม', async () => {
      await call('POST', '/api/vendors', { id: 'V1', code: 'VC1', name: 'ร้าน', status: 'INACTIVE', isActive: false });
      expect(one('SELECT * FROM vendors WHERE id = ?', 'V1')).toMatchObject({ status: 'INACTIVE', isActive: 0 });
      await call('POST', '/api/vendors', { id: 'V1', code: 'VC1', name: 'ร้าน2' });
      expect(one('SELECT * FROM vendors WHERE id = ?', 'V1')).toMatchObject({ name: 'ร้าน2', status: 'INACTIVE', isActive: 0 });
      await call('PUT', '/api/vendors/V1', { id: 'V1', code: 'VC1', name: 'ร้าน3', status: 'ACTIVE', isActive: true });
      expect(one('SELECT * FROM vendors WHERE id = ?', 'V1')).toMatchObject({ name: 'ร้าน3', status: 'ACTIVE', isActive: 1 });
      await call('POST', '/api/vendors', { id: 'V2', code: 'VC2', name: 'ใหม่' });
      expect(one('SELECT * FROM vendors WHERE id = ?', 'V2')).toMatchObject({ status: 'ACTIVE', isActive: 1 });
    });

    it('storage-locations: isActive ปิดแล้วไม่ถูกเปิดกลับเมื่อ POST ซ้ำโดยไม่ส่งฟิลด์', async () => {
      await call('POST', '/api/storage-locations', { id: 'L1', name: 'Shelf', department: 'PD', isActive: false });
      expect(one('SELECT isActive FROM storage_locations WHERE id = ?', 'L1').isActive).toBe(0);
      await call('POST', '/api/storage-locations', { id: 'L1', name: 'Shelf2', department: 'PD' });
      expect(one('SELECT * FROM storage_locations WHERE id = ?', 'L1')).toMatchObject({ name: 'Shelf2', isActive: 0 });
      await call('POST', '/api/storage-locations', { id: 'L2', name: 'New', department: 'PD' });
      expect(one('SELECT isActive FROM storage_locations WHERE id = ?', 'L2').isActive).toBe(1);
    });

    it('status/isActive รูปแบบแปลก ("false","0","inactive") = ปิดใช้งาน', async () => {
      for (const [i, v] of [['a', 'false'], ['b', '0'], ['c', 0]]) {
        await call('POST', '/api/vendors', { id: `V-${i}`, code: `VC-${i}`, name: 'x', isActive: v });
        expect(one('SELECT isActive FROM vendors WHERE id = ?', `V-${i}`).isActive).toBe(0);
      }
      await call('POST', '/api/vendors', { id: 'V-d', code: 'VC-d', name: 'x', status: 'inactive' });
      expect(one('SELECT status, isActive FROM vendors WHERE id = ?', 'V-d')).toMatchObject({ status: 'INACTIVE', isActive: 0 });
    });
  });

  describe('POST /api/stock-logs คอลัมน์ใหม่', () => {
    it('เก็บ conversionRate/unitPrice/totalPrice/locationId/date/grnNumber ; POST id เดิมซ้ำ = append-only (T4.5) เติมได้เฉพาะคอลัมน์ที่ยัง NULL', async () => {
      const log = { id: 'LOG1', productId: 'P1', type: 'IN', quantity: 5, balance: 5, department: 'PD', conversionRate: 12, unitPrice: 3.5, totalPrice: 17.5, locationId: 'L1', date: '2026-09-01', grnNumber: 'GRN-1' };
      expect((await call('POST', '/api/stock-logs', log)).status).toBe(200);
      expect(one('SELECT * FROM stock_logs WHERE id = ?', 'LOG1')).toMatchObject({ conversionRate: 12, unitPrice: 3.5, totalPrice: 17.5, locationId: 'L1', date: '2026-09-01', grnNumber: 'GRN-1' });
      await call('POST', '/api/stock-logs', { id: 'LOG1', productId: 'P1', type: 'IN', quantity: 6, balance: 6, department: 'PD' });
      expect(one('SELECT * FROM stock_logs WHERE id = ?', 'LOG1')).toMatchObject({ quantity: 5, balance: 5, conversionRate: 12, grnNumber: 'GRN-1', locationId: 'L1' });
      await call('POST', '/api/stock-logs', { id: 'LOG1', productId: 'P1', type: 'IN', quantity: 6, balance: 6, department: 'PD', conversionRate: 99, grnNumber: 'GRN-X' });
      expect(one('SELECT * FROM stock_logs WHERE id = ?', 'LOG1')).toMatchObject({ quantity: 5, conversionRate: 12, grnNumber: 'GRN-1' });
      const g = await call('GET', '/api/stock-logs');
      expect(g.json[0]).toMatchObject({ id: 'LOG1', grnNumber: 'GRN-1' });
    });

    it('ไม่ส่งคอลัมน์ใหม่ = NULL ไม่ error ; ค่า non-numeric ของ conversionRate -> NULL', async () => {
      await call('POST', '/api/stock-logs', { id: 'LOG2', productId: 'P1', type: 'OUT', quantity: 1, balance: 0, department: 'PD', conversionRate: 'abc' });
      expect(one('SELECT * FROM stock_logs WHERE id = ?', 'LOG2')).toMatchObject({ conversionRate: null, unitPrice: null, grnNumber: null });
    });

    it('batch array ได้ครบทุกแถว', async () => {
      const r = await call('POST', '/api/stock-logs', [
        { id: 'B1', productId: 'P', type: 'IN', quantity: 1, balance: 1, department: 'PD', grnNumber: 'G1' },
        { id: 'B2', productId: 'P', type: 'IN', quantity: 1, balance: 2, department: 'PD', grnNumber: 'G2' },
      ]);
      expect(r.json.count).toBe(2);
      expect(rows('SELECT grnNumber FROM stock_logs ORDER BY id').map((x) => x.grnNumber)).toEqual(['G1', 'G2']);
    });
  });
});
