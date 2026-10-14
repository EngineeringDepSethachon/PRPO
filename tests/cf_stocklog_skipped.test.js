// @vitest-environment node
// P2 : POST /api/stock-logs department gate (skip + `skipped`) and the cloudflare-mode client notice for `skipped`
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const P = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }) };
}

// node:sqlite is required : if it is missing these tests FAIL (never skip silently)
it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy(); });

describe('POST /api/stock-logs department gate', () => {
  let sdb; let env; const tokens = {};
  const ids = () => sdb.prepare('SELECT id FROM stock_logs ORDER BY id').all().map((r) => r.id);
  const post = async (who, body) => {
    const res = await onRequest({
      request: new Request('https://prpo.pages.dev/api/stock-logs', { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const log = (id, productId, extra = {}) => ({ id, productId, type: 'IN', quantity: 1, ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    for (const u of Object.values(P)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(P)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    const prod = sdb.prepare('INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES (?, ?, ?, ?, ?, 5, 0)');
    prod.run('P-PD', 'PD-A', 'pd product', 'PD', 'PD'); prod.run('P-QC', 'QC-A', 'qc product', 'QC', 'QC');
  });

  it('own-department rows are written, other-department rows are skipped and listed', async () => {
    const r = await post('L1', [log('L-1', 'P-PD'), log('L-2', 'P-QC'), log('L-3', 'P-PD')]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, count: 2, skipped: ['L-2'] });
    expect(ids()).toEqual(['L-1', 'L-3']);
  });

  it('a normal single-department flow has no `skipped` key ; admin writes every row', async () => {
    const own = await post('L1', log('L-1', 'P-PD'));
    expect(own.json).toMatchObject({ success: true, count: 1 });
    expect(own.json.skipped).toBeUndefined();
    const adm = await post('ADMIN', [log('L-2', 'P-QC'), log('L-3', 'P-PD')]);
    expect(adm.json.skipped).toBeUndefined();
    expect(ids()).toEqual(['L-1', 'L-2', 'L-3']);
  });

  it('unknown product : falls back to the department named on the log ; no department -> written', async () => {
    const r = await post('L1', [log('L-1', 'P-NONE', { department: 'QC' }), log('L-2', 'P-NONE', { department: 'PD' }), log('L-3', 'P-NONE')]);
    expect(r.json).toMatchObject({ count: 2, skipped: ['L-1'] });
    expect(ids()).toEqual(['L-2', 'L-3']);
  });

  it('a QC log id that is already stored is skipped silently (not listed) ; a new QC log id is listed', async () => {
    await post('ADMIN', log('L-OLD', 'P-QC'));
    const r = await post('L1', [log('L-OLD', 'P-QC'), log('L-NEW', 'P-QC'), log('L-PD', 'P-PD')]);
    expect(r.json).toMatchObject({ count: 1, skipped: ['L-NEW'] });
    const again = await post('L1', [log('L-OLD', 'P-QC'), log('L-PD', 'P-PD')]);
    expect(again.json.skipped).toBeUndefined();
  });

  it('products/batch : a normal PD sync that carries unchanged QC rows has no `skipped` ; really editing a QC row does', async () => {
    const call = async (method, body) => {
      const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/products/batch', { method, headers: { Authorization: `Bearer ${tokens.L1}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
      return res.json();
    };
    const full = (id, code, dept, stock, extra = {}) => ({ id, code, name: `n-${id}`, category: dept, department: dept, purchaseUnit: 'ชิ้น', usageUnit: 'ชิ้น', conversionRate: 1, minStock: 0, currentStock: stock, standardPrice: 9, locationId: '', ...extra });
    sdb.prepare("UPDATE products SET name='n-P-QC', purchaseUnit='ชิ้น', usageUnit='ชิ้น', conversionRate=1, minStock=0, currentStock=22, standardPrice=9, defaultLocationId='' WHERE id='P-QC'").run();
    const same = await call('PUT', [full('P-PD', 'PD-A', 'PD', 11), full('P-QC', 'QC-A', 'QC', 22)]);
    expect(same).toMatchObject({ success: true, count: 1 });
    expect(same.skipped).toBeUndefined();
    for (const change of [{ standardPrice: 10 }, { name: 'renamed' }, { status: 'INACTIVE' }, { minStock: 3 }, { usageUnit: 'กล่อง' }]) {
      const r = await call('PUT', [full('P-QC', 'QC-A', 'QC', 22, change)]);
      expect(r.skipped, JSON.stringify(change)).toEqual(['P-QC']);
    }
    // server-managed fields (stale localStorage copy of the stock) never count
    for (const change of [{ currentStock: 999 }, { stockBalance: 1 }, { avgCost: 5, totalValue: 77 }]) {
      const r = await call('PUT', [full('P-QC', 'QC-A', 'QC', 22, change)]);
      expect(r.skipped, JSON.stringify(change)).toBeUndefined();
    }
    // empty values are compared after the handler's defaults : '' unit -> 'ชิ้น', conversionRate 0 -> 1, empty category -> department
    const dflt = await call('PUT', [full('P-QC', 'QC-A', 'QC', 22, { purchaseUnit: '', usageUnit: '', conversionRate: 0, category: '' })]);
    expect(dflt.skipped).toBeUndefined();
    const created = await call('POST', [full('P-QC2', 'QC-B', 'QC', 1)]);
    expect(created.skipped).toEqual(['P-QC2']);
  });

  it('a log with no department and no known product is stored under the user\'s own department (not a blind PD)', async () => {
    sdb.prepare("UPDATE users SET department='QC', allowedDepartments='[\"QC\"]' WHERE id='U-L1'").run();
    const r = await post('L1', [log('L-1', 'P-NONE')]);
    expect(r.json).toMatchObject({ count: 1 });
    expect(sdb.prepare("SELECT department FROM stock_logs WHERE id='L-1'").get().department).toBe('QC');
    const adm = await post('ADMIN', [log('L-2', 'P-NONE')]); // ALL admin : no primary department -> PD
    expect(adm.json.count).toBe(1);
    expect(sdb.prepare("SELECT department FROM stock_logs WHERE id='L-2'").get().department).toBe('PD');
  });

  it('a log naming PD cannot be used to write against a QC product', async () => {
    const r = await post('L1', log('L-1', 'P-QC', { department: 'PD' }));
    expect(r.json).toMatchObject({ count: 0, skipped: ['L-1'] });
    expect(ids()).toEqual([]);
  });
});

describe('cloudflare client : `skipped` notice', () => {
  let cfGuard; let modalService; let warnSpy; let originalFetch;
  const resp = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body, clone() { return resp(body, ok); } });

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    originalFetch = global.fetch;
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    ({ modalService } = await import('../src/services/modalService'));
    cfGuard = await import('../src/services/cfGuard');
    warnSpy = vi.spyOn(modalService, 'warning').mockImplementation(() => Promise.resolve(true));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('products/batch + stock-logs skipped rows -> ONE warning with the total, Thai text', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(resp({ success: true, count: 1, skipped: ['A', 'B'] }))
      .mockResolvedValueOnce(resp({ success: true, count: 1, skipped: ['L1'] }));
    await cfGuard.cfWrite('t', '/api/products/batch', { method: 'PUT', body: '[]' });
    await cfGuard.cfBackground('l', '/api/stock-logs', { method: 'POST', body: '[]' });
    await vi.advanceTimersByTimeAsync(500);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('มีรายการของแผนกอื่น 3 รายการที่ไม่ได้บันทึก');
  });

  it('no notice when skipped is empty/missing, for other routes, or for failed responses', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(resp({ success: true, count: 1 }))
      .mockResolvedValueOnce(resp({ success: true, skipped: [] }))
      .mockResolvedValueOnce(resp({ success: true, skipped: ['X'] }))
      .mockResolvedValueOnce(resp({ error: 'x', skipped: ['X'] }, false));
    await cfGuard.cfWrite('t', '/api/products/batch', {});
    await cfGuard.cfWrite('t', '/api/stock-logs', {});
    await cfGuard.cfWrite('t', '/api/prs', {});
    await cfGuard.cfBackground('l', '/api/stock-logs', {});
    await vi.advanceTimersByTimeAsync(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('mock mode : never notifies', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    global.fetch = vi.fn().mockResolvedValue(resp({ success: true, skipped: ['A'] }));
    await cfGuard.cfWrite('t', '/api/products/batch', {});
    await vi.advanceTimersByTimeAsync(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
