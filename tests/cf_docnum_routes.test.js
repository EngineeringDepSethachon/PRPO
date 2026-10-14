// @vitest-environment node
// T3.2 router fallback (404/405) + route table, T3.3 server-issued document numbers (PR / PO / GRN), T3.5 added endpoints
// (usage-units, notifications, audit-logs, signatures, budgets/reset + PUT budgets/:dept, PUT storage-locations/:id, recalculate-mac)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { API_ROUTES, NOT_SERVED, classifyUnhandled } from '../functions/_lib/routes.js';
import { bangkokYear, bangkokMonth, formatDocNumber, formatGrnNumber, issueDocNumber } from '../functions/_lib/docnum.js';
import { computeMovingAverage, isUserTargetOfNotification } from '../functions/_lib/extra.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql', '0014_m7_audit_notify.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const YEAR = bangkokYear();

const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
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
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.all()); return out; }
  };
}

describe('T3.3 docnum (pure)', () => {
  it('formats are the GAS ones (SheetService.gs:769-777)', () => {
    expect(formatDocNumber('PR', 'pd', 2026, 1)).toBe('PD001/2026');
    expect(formatDocNumber('PO', 'PD', 2026, 12)).toBe('PO-PD-2026-012');
    expect(formatDocNumber('PO', ' qc ', 2027, 1234)).toBe('PO-QC-2027-1234');
    expect(formatDocNumber('XX', 'PD', 2026, 5)).toBe('XX-PD-2026-005');
    expect(formatGrnNumber('PO-PD-2026-003', 1)).toBe('GRN-PO-PD-2026-003-01');
    expect(formatGrnNumber('PO-PD-2026-003', 12)).toBe('GRN-PO-PD-2026-003-12');
  });

  it('year = Asia/Bangkok calendar year (UTC+7), not a constant', () => {
    expect(bangkokYear(Date.parse('2026-12-31T16:59:59Z'))).toBe(2026);
    expect(bangkokYear(Date.parse('2026-12-31T17:00:00Z'))).toBe(2027);
    expect(bangkokYear(Date.parse('2031-06-01T00:00:00Z'))).toBe(2031);
  });

  it('moving average = GAS algorithm (weighted, 2 decimals per step)', () => {
    expect(computeMovingAverage([{ quantity: 10, unitPrice: 5 }, { quantity: 10, unitPrice: 7 }])).toBe(6);
    expect(computeMovingAverage([{ quantity: 3, unitPrice: 10 }, { quantity: 1, unitCost: 3 }])).toBe(8.25);
    expect(computeMovingAverage([])).toBe(0);
  });
});

describe('T3.2 route table', () => {
  it('classifyUnhandled: unknown path -> 404, known path + wrong method -> 405 with Allow', () => {
    expect(classifyUnhandled('GET', '/api/nope')).toEqual({ status: 404 });
    expect(classifyUnhandled('DELETE', '/api/bootstrap').status).toBe(405);
    expect(classifyUnhandled('DELETE', '/api/bootstrap').allow).toEqual(['GET']);
    expect(classifyUnhandled('GET', '/api/usage-units/x').status).toBe(405);
  });

  it('every /api/... path the client (src/) calls has a handler in the table, or is listed as deliberately not served', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full); } else if (/\.(js|jsx)$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(here, '..', 'src'));
    const found = new Set();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(\/api\/[A-Za-z0-9_\-/${}.:]*)/g)) {
        let p = m[1].replace(/\$\{[^}]*\}/g, 'x').replace(/\/+$/, '');
        if (!p || p === '/api' || /\/api\/\*/.test(m[1])) continue;
        found.add(p);
      }
    }
    expect(found.size).toBeGreaterThan(20);
    const missing = [...found].filter((p) => !API_ROUTES.some((r) => r.re.test(p)) && !NOT_SERVED.some((r) => r.re.test(p)));
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!DatabaseSync)('T3.2/T3.3/T3.5 functional (onRequest + migrated sqlite)', () => {
  let sdb; let env; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const one = (q, ...p) => rows(q, ...p)[0];
  const call = async (who, method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
  });

  // ───────── T3.2 ─────────
  it('unknown path -> 404 JSON (not a silent 200) ; known path with unsupported method -> 405 + Allow', async () => {
    const a = await call('ADMIN', 'GET', '/api/does-not-exist');
    expect(a.status).toBe(404);
    expect(a.json).toMatchObject({ success: false, error: 'ไม่พบเส้นทาง API', path: '/api/does-not-exist' });
    const b = await call('ADMIN', 'GET', '/api/storage'); // mock-only blob: must not be cached by the client as app state
    expect(b.status).toBe(404);
    const c = await call('ADMIN', 'POST', '/api/upload', {}); // served since T2.1c (handler rejects this body: no Content-Length / no category)
    expect(c.status).toBeGreaterThanOrEqual(400);
    expect(c.status).not.toBe(404);
    const d = await call('ADMIN', 'PATCH', '/api/prs/x', {});
    expect(d.status).toBe(405); // allowed by rbac (PR_WRITE) but the router does not serve PATCH
    const e = await call('ADMIN', 'DELETE', '/api/bootstrap');
    expect(e.status).toBe(403); // unlisted write verbs stay fail-closed in rbac, before routing
    const f = await call('L1', 'GET', '/api/usage-units/U1'); // GET on /:id is not served
    expect(f.status).toBe(405);
    expect(f.headers.get('Allow')).toBe('PUT, DELETE');
    expect(f.json.success).toBe(false);
  });

  const SAMPLES = {
    auth: '/api/auth', bootstrap: '/api/bootstrap', health: '/api/health',
    prs: '/api/prs', 'pr-by-id': '/api/prs/x', pos: '/api/pos', 'po-by-id': '/api/pos/x', 'po-receive': '/api/pos/x/receive', 'po-settle': '/api/pos/x/settle',
    products: '/api/products', 'products-mac': '/api/products/recalculate-mac', 'product-by-id': '/api/products/x',
    vendors: '/api/vendors', 'vendor-by-id': '/api/vendors/x', 'storage-locations': '/api/storage-locations', 'storage-location-by-id': '/api/storage-locations/x',
    'usage-units': '/api/usage-units', 'usage-unit-by-id': '/api/usage-units/x', departments: '/api/departments', 'department-by-id': '/api/departments/x',
    users: '/api/users', 'user-by-id': '/api/users/x', 'stock-logs': '/api/stock-logs', 'stock-issue': '/api/stock/issue',
    budgets: '/api/budgets', 'budgets-adjust': '/api/budgets/adjust', 'budgets-allocate': '/api/budgets/allocate', 'budgets-reset': '/api/budgets/reset',
    'budget-by-dept': '/api/budgets/PD', 'budget-transactions': '/api/budget-transactions',
    notifications: '/api/notifications', 'notification-by-id': '/api/notifications/x', 'audit-logs': '/api/audit-logs',
    signatures: '/api/signatures', 'signature-by-role': '/api/signatures/APPROVER', upload: '/api/upload', files: '/api/files/x', 'admin-cleanup-orphans': '/api/admin/cleanup-orphans', 'admin-restore-orphan': '/api/admin/restore-orphan', 'admin-unshare-public': '/api/admin/unshare-public',
    me: '/api/me', 'me-password': '/api/me/password', logout: '/api/logout'
  };
  it('every table entry is really served : each (route, method) answers something other than the fallback 404/405', async () => {
    for (const r of API_ROUTES) {
      const sample = SAMPLES[r.id];
      expect(sample, `sample path for route ${r.id}`).toBeTruthy();
      expect(r.re.test(sample), `${r.id} sample matches its regex`).toBe(true);
      for (const method of r.methods) {
        const res = await call('ADMIN', method, sample, method === 'GET' ? undefined : {});
        const fallback = res.status === 405 || (res.status === 404 && res.json && res.json.error === 'ไม่พบเส้นทาง API');
        expect(fallback, `${method} ${sample} -> ${res.status} ${JSON.stringify(res.json)}`).toBe(false);
      }
    }
  });

  // ───────── T3.3 ─────────
  const seedPr = (id, prNo, { dept = 'PD', status = 'PO_ISSUED', total = 1000 } = {}) =>
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES (?, ?, ?, ?, ?, '[{\"productId\":\"SP1\",\"qty\":100}]')").run(id, prNo, dept, status, total);

  it('PR without a number : the server issues {DEPT}{NNN}/{YYYY} from doc_counters and returns it in body.pr', async () => {
    const a = await call('L1', 'POST', '/api/prs', { id: 'PR-A', department: 'PD', status: 'DRAFT', items: [] });
    expect(a.status).toBe(200);
    expect(a.json.prNo).toBe(`PD001/${YEAR}`);
    expect(a.json.pr).toMatchObject({ id: 'PR-A', prNumber: `PD001/${YEAR}`, prNo: `PD001/${YEAR}` });
    expect(a.json).toMatchObject({ issuedByServer: true, renumbered: false });
    const b = await call('L1', 'POST', '/api/prs', { id: 'PR-B', department: 'pd', status: 'DRAFT', items: [] });
    expect(b.json.prNo).toBe(`PD002/${YEAR}`);
    expect(one("SELECT prNumber FROM prs WHERE id = 'PR-B'").prNumber).toBe(`PD002/${YEAR}`);
    expect(one('SELECT lastNumber FROM doc_counters WHERE dept = ? AND docType = ? AND year = ?', 'PD', 'PR', YEAR).lastNumber).toBe(2);
  });

  it('a free client number is kept as it is (nothing renumbered, counter untouched)', async () => {
    const r = await call('L1', 'POST', '/api/prs', { id: 'PR-K', prNo: `PD050/${YEAR}`, department: 'PD', status: 'DRAFT', items: [] });
    expect(r.status).toBe(200);
    expect(r.json.prNo).toBe(`PD050/${YEAR}`);
    expect(r.json.issuedByServer).toBeUndefined();
    expect(rows('SELECT * FROM doc_counters').length).toBe(0);
  });

  it('a taken client number is renumbered by the server and the response says so (renumbered + requestedPrNo) ; existing PR untouched', async () => {
    seedPr('EX', `PD007/${YEAR}`, { status: 'SUBMITTED' });
    const r = await call('L1', 'POST', '/api/prs', { id: 'PR-N', prNo: `PD007/${YEAR}`, department: 'PD', status: 'DRAFT', items: [] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ renumbered: true, requestedPrNo: `PD007/${YEAR}` });
    expect(r.json.prNo).toBe(`PD008/${YEAR}`); // counter was seeded from the highest existing number
    expect(r.json.pr.prNo).toBe(`PD008/${YEAR}`);
    expect(one("SELECT prNumber FROM prs WHERE id = 'EX'").prNumber).toBe(`PD007/${YEAR}`);
  });

  it('the counter starts after the numbers the client already made (PD001..PD005 exist -> PD006)', async () => {
    for (let i = 1; i <= 5; i++) seedPr(`E${i}`, `PD${String(i).padStart(3, '0')}/${YEAR}`, { status: 'SUBMITTED' });
    seedPr('OLD', `PD099/${YEAR - 1}`, { status: 'SUBMITTED' }); // other year does not count
    seedPr('QC', `QC009/${YEAR}`, { dept: 'QC', status: 'SUBMITTED' }); // other department does not count
    const r = await call('L1', 'POST', '/api/prs', { id: 'PR-S', department: 'PD', status: 'DRAFT', items: [] });
    expect(r.json.prNo).toBe(`PD006/${YEAR}`);
  });

  it('20 concurrent PR requests : 20 distinct, gap-free numbers (no duplicates, no 409/500)', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call('L1', 'POST', '/api/prs', { id: `PR-C${i}`, department: 'PD', status: 'DRAFT', items: [] })));
    expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
    const nos = res.map((r) => r.json.prNo);
    expect(new Set(nos).size).toBe(20);
    expect([...nos].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `PD${String(i + 1).padStart(3, '0')}/${YEAR}`));
    expect(rows('SELECT prNumber FROM prs').length).toBe(20);
  });

  it('20 concurrent PR requests that all ask for the SAME number : one keeps it, the other 19 are renumbered uniquely', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call('L1', 'POST', '/api/prs', { id: `PR-D${i}`, prNo: `PD001/${YEAR}`, department: 'PD', status: 'DRAFT', items: [] })));
    expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
    const nos = res.map((r) => r.json.prNo);
    expect(new Set(nos).size).toBe(20);
    expect(res.filter((r) => r.json.renumbered).length).toBe(19);
    expect(rows('SELECT DISTINCT prNumber FROM prs').length).toBe(20);
  });

  it('departments count separately and the counter resets in a new year (Bangkok year boundary)', async () => {
    const db = env.DB;
    const t1 = Date.parse('2026-12-31T16:59:00Z'); // 23:59 Bangkok, still 2026
    const t2 = Date.parse('2026-12-31T17:00:00Z'); // 00:00 Bangkok, 2027
    expect((await issueDocNumber(db, { docType: 'PR', dept: 'PD', now: t1 })).docNo).toBe('PD001/2026');
    expect((await issueDocNumber(db, { docType: 'PR', dept: 'PD', now: t1 })).docNo).toBe('PD002/2026');
    expect((await issueDocNumber(db, { docType: 'PR', dept: 'PD', now: t2 })).docNo).toBe('PD001/2027');
    expect((await issueDocNumber(db, { docType: 'PR', dept: 'QC', now: t2 })).docNo).toBe('QC001/2027');
    expect((await issueDocNumber(db, { docType: 'PO', dept: 'PD', now: t2 })).docNo).toBe('PO-PD-2027-001');
    expect((await issueDocNumber(db, { docType: 'PO', dept: 'PD', now: t1 })).docNo).toBe('PO-PD-2026-001'); // PK (dept, docType, year): the 2026 row is its own
    expect(rows('SELECT dept, docType, year, lastNumber FROM doc_counters ORDER BY year, dept, docType').length).toBe(5);
  });

  it('PO without a number : issued as PO-{DEPT}-{YYYY}-{NNN} ; a taken client number is refused with 409 (never renumbered silently)', async () => {
    seedPr('P1', `PD001/${YEAR}`);
    const a = await call('L3', 'POST', '/api/pos', { id: 'PO-A', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(a.status).toBe(200);
    expect(a.json.poNo).toBe(`PO-PD-${YEAR}-001`);
    expect(a.json.issuedByServer).toBe(true);
    expect(one("SELECT poNumber FROM pos WHERE id = 'PO-A'").poNumber).toBe(`PO-PD-${YEAR}-001`);
    // client number, free
    const b = await call('L3', 'POST', '/api/pos', { id: 'PO-B', poNo: `PO-PD-${YEAR}-040`, prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(b.status).toBe(200);
    expect(b.json.poNo).toBe(`PO-PD-${YEAR}-040`);
    // client number, taken -> 409, nothing written
    const c = await call('L3', 'POST', '/api/pos', { id: 'PO-C', poNo: `PO-PD-${YEAR}-040`, prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(c.status).toBe(409);
    expect(rows("SELECT id FROM pos WHERE id = 'PO-C'").length).toBe(0);
    // re-sending the same PO (same id) is an update, not a clash
    const d = await call('L3', 'POST', '/api/pos', { id: 'PO-B', poNo: `PO-PD-${YEAR}-040`, prNo: `PD001/${YEAR}`, department: 'PD', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 10 });
    expect(d.status).toBe(200);
  });

  it('20 concurrent POs without a number : 20 distinct numbers', async () => {
    seedPr('P2', `PD002/${YEAR}`);
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call('L3', 'POST', '/api/pos', { id: `PO-X${i}`, prNo: `PD002/${YEAR}`, department: 'PD', status: 'ISSUED', items: [{ productId: 'SP1', qty: 1 }], totalAmount: 1 })));
    expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
    const nos = res.map((r) => r.json.poNo);
    expect(new Set(nos).size).toBe(20);
    expect([...nos].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `PO-PD-${YEAR}-${String(i + 1).padStart(3, '0')}`).sort());
  });

  it('GRN : client number kept ; absent -> GRN-{poNo}-{NN} with the next free round', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P7', code: 'C7', name: 'G', department: 'PD', currentStock: 0 });
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('RV','PO-RV','PD','ORDERED','[{\"productId\":\"P7\",\"qty\":10}]')").run();
    const r1 = await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 4 }] });
    expect(r1.status).toBe(200);
    const r2 = await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 3 }] });
    expect(r2.status).toBe(200);
    const r3 = await call('L1', 'POST', '/api/pos/RV/receive', { grNumber: 'GR-MINE-1', receivingItems: [{ productId: 'P7', goodQty: 1 }] });
    expect(r3.status).toBe(200);
    const r4 = await call('L1', 'POST', '/api/pos/RV/receive', { receivingItems: [{ productId: 'P7', goodQty: 1 }] });
    expect(r4.status).toBe(200);
    expect(rows("SELECT docNo FROM stock_logs WHERE poNo = 'PO-RV' ORDER BY rowid").map((x) => x.docNo)).toEqual(['GRN-PO-RV-01', 'GRN-PO-RV-02', 'GR-MINE-1', 'GRN-PO-RV-04']); // round = receipts so far + 1 (grnHistory.length + 1), a client-numbered receipt counts
  });

  it('GRN round : a receive that put nothing into stock still uses up its round (PO timeline counts)', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'P8', code: 'C8', name: 'G', department: 'PD', currentStock: 0 });
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('RW','PO-RW','PD','ORDERED','[{\"productId\":\"P8\",\"qty\":10}]')").run();
    expect((await call('L1', 'POST', '/api/pos/RW/receive', { receivingItems: [{ productId: 'P8', goodQty: 0, defectiveQty: 2 }] })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/pos/RW/receive', { receivingItems: [{ productId: 'P8', goodQty: 5 }] })).status).toBe(200);
    expect(rows("SELECT docNo FROM stock_logs WHERE poNo = 'PO-RW'").map((x) => x.docNo)).toEqual(['GRN-PO-RW-02']);
  });

  // ───────── T3.5 ─────────
  it('usage-units : CRUD, department filter, validation', async () => {
    const c = await call('L1', 'POST', '/api/usage-units', { name: 'กล่อง', department: 'pd', dot: 'bg-blue-500', color: 'blue' });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ name: 'กล่อง', department: 'PD', status: 'ACTIVE', dot: 'bg-blue-500' });
    expect(c.json.id).toMatch(/^UNIT-PD-/);
    const id = c.json.id;
    expect((await call('L1', 'POST', '/api/usage-units', { id: 'UNIT-QC-1', name: 'ถัง', department: 'QC' })).status).toBe(403); // not the user's department (client canAccessDepartmentData)
    await call('ADMIN', 'POST', '/api/usage-units', { id: 'UNIT-QC-1', name: 'ถัง', department: 'QC' });
    expect((await call('L1', 'PUT', '/api/usage-units/UNIT-QC-1', { name: 'x' })).status).toBe(403);
    expect((await call('L1', 'DELETE', '/api/usage-units/UNIT-QC-1')).status).toBe(403);
    expect((await call('L1', 'GET', '/api/usage-units')).json.length).toBe(2);
    expect((await call('L1', 'GET', '/api/usage-units?department=PD')).json.map((u) => u.id)).toEqual([id]);
    expect((await call('L1', 'GET', '/api/usage-units?department=ALL')).json.length).toBe(2);
    const u = await call('L1', 'PUT', `/api/usage-units/${id}`, { name: 'กล่องใหญ่' });
    expect(u.json).toMatchObject({ id, name: 'กล่องใหญ่', department: 'PD', color: 'blue' }); // fields not sent are kept
    const created = await call('L1', 'PUT', '/api/usage-units/UNIT-NEW', { name: 'ใหม่', department: 'PD' }); // PUT of an unknown id creates it (mock parity)
    expect(created.status).toBe(200);
    expect((await call('L1', 'POST', '/api/usage-units', { department: 'PD' })).status).toBe(400); // no name
    expect((await call('L1', 'POST', '/api/usage-units', { id: 'bad id!', name: 'x' })).status).toBe(400);
    expect((await call('L1', 'DELETE', `/api/usage-units/${id}`)).json).toEqual({ success: true, id });
    expect(rows('SELECT id FROM usage_units WHERE id = ?', id).length).toBe(0);
  });

  it('PUT /api/storage-locations/:id updates (and creates when absent) ; the client edit is no longer lost', async () => {
    await call('L1', 'POST', '/api/storage-locations', { id: 'LOC-1', name: 'A', department: 'PD' });
    const u = await call('L1', 'PUT', '/api/storage-locations/LOC-1', { name: 'B' });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ success: true, id: 'LOC-1', name: 'B', department: 'PD' });
    expect(one("SELECT name FROM storage_locations WHERE id = 'LOC-1'").name).toBe('B');
    expect((await call('L1', 'PUT', '/api/storage-locations/LOC-2', { name: 'C', department: 'QC' })).status).toBe(403); // other department
    expect((await call('ADMIN', 'PUT', '/api/storage-locations/LOC-2', { name: 'C', department: 'QC' })).json).toMatchObject({ id: 'LOC-2', department: 'QC' });
    expect((await call('L1', 'PUT', '/api/storage-locations/LOC-2', { name: 'D' })).status).toBe(403); // existing row of another department
  });

  it('notifications : POST (server id/time, always unread), GET filtered per user (GAS rule), PUT marks read only for a recipient', async () => {
    // M7-2 : the server makes notifications itself ; POST by hand is admin only, the id is always issued by the server, server event types are refused
    sdb.prepare("INSERT INTO notifications (id, timestamp, title, message, type, targetDepartment, targetRole, docRef, status) VALUES ('NTF-1', ?, 'PR ใหม่', 'm', 'PR_SUBMITTED', 'PD', 'REQUESTER', 'PD001/2026', 'unread')").run(new Date().toISOString());
    for (const who of ['L1', 'L2', 'L3', 'ONLINE']) expect((await call(who, 'POST', '/api/notifications', { title: 'x', message: 'y' })).status, who).toBe(403);
    const p = await call('ADMIN', 'POST', '/api/notifications', { id: 'NTF-GRN:PO-1:GRN-1-0', title: 'm', message: 'm', type: 'INFO', targetDept: 'PD', targetRole: 'REQUESTER', status: 'read' });
    expect(p.status).toBe(200);
    expect(p.json.id).not.toBe('NTF-GRN:PO-1:GRN-1-0'); // a caller can not reserve an id
    expect(p.json).toMatchObject({ status: 'unread', isRead: false, targetDepartment: 'PD', targetRole: 'REQUESTER' });
    expect(p.json.createdBy).toBeUndefined();
    expect(p.json.createdAtMs).toBeUndefined();
    for (const type of ['PR_APPROVED', 'po_cancelled', 'GOODS_RECEIVED', 'ONLINE_ORDERED']) expect((await call('ADMIN', 'POST', '/api/notifications', { title: 'x', type })).status, type).toBe(400);
    sdb.exec(`DELETE FROM notifications WHERE id = '${p.json.id}'`);
    const auto = await call('ADMIN', 'POST', '/api/notifications', { title: 'ทุกคน', message: 'hi' });
    expect(auto.json.id).toMatch(/^NTF-/);
    expect(auto.json).toMatchObject({ targetDepartment: 'ALL', targetRole: 'ALL' });
    expect((await call('ADMIN', 'POST', '/api/notifications', { title: 'x', message: 'y', department: 'QC' })).json.targetDepartment).toBe('QC');
    sdb.exec("DELETE FROM notifications WHERE title = 'x'");
    expect((await call('ADMIN', 'POST', '/api/notifications', [])).status).toBe(400);

    const l1 = (await call('L1', 'GET', '/api/notifications')).json;
    expect(l1.map((n) => n.id).sort()).toEqual([auto.json.id, 'NTF-1'].sort());
    const online = (await call('ONLINE', 'GET', '/api/notifications')).json;
    expect(online.map((n) => n.id)).toEqual([auto.json.id]); // REQUESTER-targeted notice is not for the online purchaser
    expect((await call('ADMIN', 'GET', '/api/notifications')).json.length).toBe(2);

    expect((await call('ONLINE', 'PUT', '/api/notifications/NTF-1', { isRead: true })).status).toBe(404); // M7-2 : not a recipient -> same answer as a missing id (IDOR)
    expect((await call('L1', 'PUT', '/api/notifications/NOPE', { isRead: true })).status).toBe(404);
    const r = await call('L1', 'PUT', '/api/notifications/NTF-1', { isRead: true, title: 'hacked' });
    expect(r.json).toMatchObject({ id: 'NTF-1', status: 'read', isRead: true, read: true, title: 'PR ใหม่' }); // the caller's own read mark ; nothing else moves
    expect(one("SELECT status, title FROM notifications WHERE id = 'NTF-1'")).toEqual({ status: 'unread', title: 'PR ใหม่' }); // the shared column stays (read state is per user, notification_reads)
    expect(one("SELECT userId FROM notification_reads WHERE notificationId = 'NTF-1'")).toEqual({ userId: 'U-L1' });
    expect((await call('L1', 'DELETE', '/api/notifications/NTF-1')).status).toBe(403); // not offered : fail closed
  });

  it('T3.8 notifications : createdBy from the token, role allow-list, per-user rate limit, GET returns the newest 200 matching rows', async () => {
    const a = await call('ADMIN', 'POST', '/api/notifications', { title: 't', targetRole: 'approver', createdBy: 'U-EVIL' });
    expect(a.status).toBe(200);
    expect(a.json.targetRole).toBe('APPROVER');
    expect(one('SELECT createdBy, createdAtMs FROM notifications WHERE id = ?', a.json.id)).toMatchObject({ createdBy: 'U-AD' });
    expect((await call('ADMIN', 'POST', '/api/notifications', { title: 't', targetRole: 'SUPERUSER' })).status).toBe(400);
    expect((await call('ADMIN', 'POST', '/api/notifications', { title: 't', targetRole: '<script>' })).status).toBe(400);
    // 1 used + 50 + 9 = 60 allowed, the next one is refused
    const batch = (n) => Array.from({ length: n }, (_, i) => ({ title: `n${i}`, targetRole: 'ALL' }));
    expect((await call('ADMIN', 'POST', '/api/notifications', batch(50))).status).toBe(200);
    expect((await call('ADMIN', 'POST', '/api/notifications', batch(9))).status).toBe(200);
    const limited = await call('ADMIN', 'POST', '/api/notifications', batch(1));
    expect(limited.status).toBe(429);

    // reading : 700 old rows addressed to everybody -> only the newest 200 come back, newest first
    const ins = sdb.prepare("INSERT INTO notifications (id, timestamp, title, targetDepartment, targetRole, status) VALUES (?, ?, ?, 'ALL', 'ALL', 'unread')");
    for (let i = 0; i < 700; i++) ins.run(`OLD-${i}`, new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString(), `old ${i}`);
    const g = (await call('ADMIN', 'GET', '/api/notifications')).json;
    expect(g.length).toBe(200);
    const ts = g.map((n) => n.timestamp);
    expect([...ts].sort().reverse()).toEqual(ts);
    expect(g.slice(0, 60).every((n) => !n.id.startsWith('OLD-'))).toBe(true); // the 60 fresh rows sit above the 2020 rows
    expect(g[60].id).toBe('OLD-699'); // then the newest of the old ones
    const since = (await call('ADMIN', 'GET', `/api/notifications?since=${encodeURIComponent('2999-01-01T00:00:00Z')}`)).json;
    expect(since).toEqual([]);
  });

  it('T3.8 audit-logs : rows are marked source=client, rate limited per user', async () => {
    expect((await call('L1', 'POST', '/api/audit-logs', { action: 'A1', docNo: 'D1' })).status).toBe(200);
    expect(one("SELECT source, performedBy FROM audit_logs WHERE action = 'A1'")).toEqual({ source: 'client', performedBy: 'U-L1' });
    const g = (await call('ADMIN', 'GET', '/api/audit-logs?action=A1')).json;
    expect(g[0].action).toBe('A1'); // read shape = GAS fields (no internal `source` flag) ; see cf_audit_logs_read.test.js
    const many = (n) => Array.from({ length: n }, () => ({ action: 'BULK' }));
    expect((await call('L1', 'POST', '/api/audit-logs', many(100))).status).toBe(200);
    expect((await call('L1', 'POST', '/api/audit-logs', many(19))).status).toBe(200); // 1 + 100 + 19 = 120
    expect((await call('L1', 'POST', '/api/audit-logs', many(1))).status).toBe(429);
    expect((await call('L2', 'POST', '/api/audit-logs', many(1))).status).toBe(200);
    // server-made audit rows (e.g. from a PR upsert) have no source and do not use up the client allowance
    await call('L2', 'POST', '/api/prs', { id: 'PR-AU', department: 'PD', status: 'DRAFT', items: [] });
    expect(one("SELECT source FROM audit_logs WHERE action = 'PR_UPSERT'").source).toBeNull();
  });

  it('T3.8 PR number sent by the client must look like {DEPT}{digits}/{current year} of that PR, else the server issues one', async () => {
    const bad = [`PD001/${YEAR - 1}`, `PD001/${YEAR + 1}`, `QC001/${YEAR}`, 'PR-123', `PD/${YEAR}`, `PDX001/${YEAR}`, `PD001/${YEAR} `, ''];
    for (let i = 0; i < bad.length; i++) {
      const r = await call('L1', 'POST', '/api/prs', { id: `PR-F${i}`, prNo: bad[i], department: 'PD', status: 'DRAFT', items: [] });
      expect(r.status).toBe(200);
      expect(r.json.prNo, `asked "${bad[i]}"`).toMatch(new RegExp(`^PD\\d{3}/${YEAR}$`));
      expect(r.json.prNo).not.toBe(bad[i].trim());
      expect(r.json.issuedByServer).toBe(true);
      expect(Boolean(r.json.renumbered)).toBe(Boolean(bad[i]));
    }
    const ok = await call('L1', 'POST', '/api/prs', { id: 'PR-OK', prNo: `PD777/${YEAR}`, department: 'PD', status: 'DRAFT', items: [] });
    expect(ok.json.prNo).toBe(`PD777/${YEAR}`);
  });

  it('T3.8 GET /api/budget-transactions : newest first, filters year / period / department / limit', async () => {
    const ins = sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, amount, period, targetMonth, createdAt) VALUES (?, ?, ?, 'TOP_UP', ?, ?, ?, ?)");
    ins.run('T1', 'PD', 'PD', 1, '2025-12', '2025-12', '2025-12-31T00:00:00Z');
    ins.run('T2', 'PD', 'PD', 2, '2026-01', '2026-01', '2026-01-05T00:00:00Z');
    ins.run('T3', 'QC', 'QC', 3, '2026-02', '2026-02', '2026-02-05T00:00:00Z');
    ins.run('T4', 'PD', 'DEPT-PD', 4, null, null, '2026-02-10T00:00:00Z');
    const ids = async (q) => (await call('L2', 'GET', `/api/budget-transactions${q}`)).json.map((t) => t.id);
    expect(await ids('')).toEqual(['T4', 'T3', 'T2', 'T1']);
    expect(await ids('?year=2026')).toEqual(['T4', 'T3', 'T2']); // a row without period falls back to its createdAt
    expect(await ids('?period=2026-02')).toEqual(['T4', 'T3']);
    expect(await ids('?department=pd')).toEqual(['T4', 'T2', 'T1']);
    expect(await ids('?year=2026&department=QC')).toEqual(['T3']);
    expect(await ids('?limit=2')).toEqual(['T4', 'T3']);
    expect(await ids('?year=abc&limit=zzz')).toEqual(['T4', 'T3', 'T2', 'T1']); // junk is ignored
  });

  it('isUserTargetOfNotification matches the GAS cases', () => {
    const req = { canonicalRole: 'REQUESTER', roleId: 'REQUESTER_PD', level: 1, department: 'PD' };
    const mgr = { canonicalRole: 'APPROVER', roleId: 'PLANT_MANAGER', level: 3, department: 'MGT' };
    expect(isUserTargetOfNotification({ targetDepartment: 'PD', targetRole: 'REQUESTER' }, req)).toBe(true);
    expect(isUserTargetOfNotification({ targetDepartment: 'QC', targetRole: 'REQUESTER' }, req)).toBe(false);
    expect(isUserTargetOfNotification({ targetDepartment: 'QC', targetRole: 'APPROVER' }, mgr)).toBe(true); // approvers cross departments
    expect(isUserTargetOfNotification({ targetDepartment: 'PD', targetRole: 'PURCHASER' }, { ...req, canOnlinePurchase: true })).toBe(true);
    expect(isUserTargetOfNotification({}, null)).toBe(true);
    expect(isUserTargetOfNotification({ targetDepartment: 'PD' }, null)).toBe(false);
  });

  it('audit-logs : any user POSTs (identity from the token), only admin reads', async () => {
    const p = await call('L1', 'POST', '/api/audit-logs', { action: 'USAGE_UNIT_CREATED', docType: 'USAGE_UNIT', docNo: 'UNIT-1', actor: 'someone-else', details: 'สร้างหน่วย', department: 'PD', id: 'client-1' });
    expect(p.status).toBe(200);
    expect((await call('L1', 'POST', '/api/audit-logs', { docNo: 'x' })).status).toBe(400); // no action
    expect((await call('L1', 'POST', '/api/audit-logs', [{ action: 'A' }, { action: 'B' }])).json.count).toBe(2);
    expect((await call('L1', 'GET', '/api/audit-logs')).status).toBe(403);
    expect((await call('L2', 'GET', '/api/audit-logs')).status).toBe(403);
    const g = await call('ADMIN', 'GET', '/api/audit-logs?docNo=UNIT-1');
    expect(g.status).toBe(200);
    expect(g.json.length).toBe(1);
    expect(g.json[0]).toMatchObject({ action: 'USAGE_UNIT_CREATED', module: 'MASTER', docNo: 'UNIT-1', targetRef: 'UNIT-1', actorName: 'Req', actor: { id: 'req.pd', name: 'Req', department: 'PD' }, details: 'สร้างหน่วย' }); // GAS read shape (M7-1a); actor = token user, not the client-sent 'someone-else'
    expect(one("SELECT details FROM audit_logs WHERE entityId = 'UNIT-1'").details).toContain('someone-else'); // kept as clientActor only
    expect((await call('ADMIN', 'GET', '/api/audit-logs?limit=2')).json.length).toBe(2);
  });

  it('signatures : everyone reads, only admin writes, raster data URLs / https only', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await call('L2', 'PUT', '/api/signatures/APPROVER', { signatureUrl: png })).status).toBe(403);
    expect((await call('L1', 'POST', '/api/signatures', { roleId: 'APPROVER', signatureUrl: png })).status).toBe(403);
    const ok = await call('ADMIN', 'PUT', '/api/signatures/APPROVER', { signatureUrl: png, name: 'ผู้จัดการ' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ roleId: 'APPROVER', name: 'ผู้จัดการ', signatureUrl: png, signature: png, updatedBy: 'U-AD' });
    const driveSig = 'https://drive.google.com/file/d/SIGFILEID1234567890ABC/view';
    expect((await call('ADMIN', 'POST', '/api/signatures', { roleId: 'APPROVER', signature: driveSig })).json.signatureUrl).toBe(driveSig);
    expect((await call('ADMIN', 'POST', '/api/signatures', { roleId: 'APPROVER', signature: 'https://x.example/s.png' })).status).toBe(400); // only Drive URLs (same rule as users)
    expect(one("SELECT name FROM signatures WHERE roleId = 'APPROVER'").name).toBe('ผู้จัดการ'); // name kept when not sent
    expect((await call('ADMIN', 'PUT', '/api/signatures/X', { signatureUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status).toBe(400);
    expect((await call('ADMIN', 'PUT', '/api/signatures/X', { signatureUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await call('ADMIN', 'POST', '/api/signatures', { roleId: 'bad role', signatureUrl: png })).status).toBe(400);
    const g = await call('L1', 'GET', '/api/signatures');
    expect(g.status).toBe(200);
    expect(g.json.map((s) => s.roleId)).toEqual(['APPROVER']);
  });

  it('budgets/reset acknowledges and writes NOTHING ; PUT /api/budgets/:dept upserts one department', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,100,100,40,60)").run();
    const before = rows('SELECT * FROM budgets');
    const r = await call('L2', 'POST', '/api/budgets/reset', { PD: { monthlyBudget: 999999, spent: 0 }, QC: { monthlyBudget: 5 } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, applied: false });
    expect(rows('SELECT * FROM budgets')).toEqual(before);
    expect((await call('L1', 'POST', '/api/budgets/reset', {})).status).toBe(403);

    const u = await call('L2', 'PUT', '/api/budgets/PD', { monthlyBudget: 500, spent: 40, history: { '2026-10': 500 } });
    expect(u.status).toBe(200);
    expect(one("SELECT monthlyBudget, totalUsed FROM budgets WHERE id = 'PD'")).toEqual({ monthlyBudget: 500, totalUsed: 40 });
    const n = await call('L2', 'PUT', '/api/budgets/dept-qc', { monthlyBudget: 70 });
    expect(n.json.id).toBe('QC');
    expect(one("SELECT fiscalYear, monthlyBudget FROM budgets WHERE id = 'QC'")).toEqual({ fiscalYear: YEAR, monthlyBudget: 70 }); // current year, not 2026
    expect((await call('L2', 'PUT', '/api/budgets/ALL', { monthlyBudget: 1 })).status).toBe(400);
    expect((await call('L2', 'PUT', '/api/budgets/PD', 'nope')).status).toBe(400);
    expect((await call('L1', 'PUT', '/api/budgets/PD', { monthlyBudget: 1 })).status).toBe(403);
    expect((await call('ONLINE', 'PUT', '/api/budgets/PD', { monthlyBudget: 1 })).status).toBe(403);
  });

  it('PUT /api/budgets/:dept for non-budget users = refund credit only (server computes it from D1) ; full upsert stays with budget writers', async () => {
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD','PD',2026,1000,1000,300,700)").run();
    sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('QC','QC',2026,500,500,100,400)").run();
    const row = () => one("SELECT monthlyBudget, totalUsed, totalRemaining, refundCreditsJson FROM budgets WHERE id = 'PD'");
    // T4.6: a refund names a real PO of the department : PR + commitment + PO with the approvedTotal snapshot
    for (const [dept, pr, po] of [['PD', 'PR-CP', 'PO-CP'], ['QC', 'PR-CQ', 'PO-CQ']]) {
      sdb.prepare("INSERT INTO prs (id, prNumber, department, status, totalAmount, itemsJson) VALUES (?, ?, ?, 'PO_ISSUED', 1000, '[]')").run(`id-${pr}`, pr, dept);
      sdb.prepare("INSERT INTO budget_transactions (id, dept, department, type, actionType, amount, docNo) VALUES (?, ?, ?, 'PR_COMMITMENT', 'PR_COMMITMENT', -1000, ?)").run(`K-${pr}`, dept, dept, pr);
      sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES (?, ?, ?, ?, 'ORDERED', '[]', ?)").run(`id-${po}`, po, pr, dept, JSON.stringify({ approvedTotal: 1000 }));
    }
    // client creditDepartmentBudget body : spent lowered by 50, variance/remaining raised, monthlyBudget unchanged ; totals in the body are not trusted
    const credit = { monthlyBudget: 1000, spent: 250, actualExpense: 250, variance: 999999, remainingBudget: 999999, refundCredits: { '2026-10': 123456 }, docNo: 'PO-CP' };
    expect((await call('ONLINE', 'PUT', '/api/budgets/PD', { ...credit, docNo: undefined })).status).toBe(400); // no PO named
    const o = await call('ONLINE', 'PUT', '/api/budgets/PD', credit);
    expect(o.status).toBe(200);
    expect(o.json).toMatchObject({ applied: true, credited: 50 });
    const r1 = row();
    expect(r1).toMatchObject({ monthlyBudget: 1000, totalUsed: 250, totalRemaining: 750 });
    expect(JSON.parse(r1.refundCreditsJson)).toEqual({ [bangkokMonth()]: 50 });
    // the same body again (adjust BUDGET_ROLLBACK or a retry already applied it) -> acknowledged, nothing more written
    const again = await call('ONLINE', 'PUT', '/api/budgets/PD', credit);
    expect(again.json).toMatchObject({ success: true, applied: false });
    expect(row()).toEqual(r1);
    // requester of the same department
    expect((await call('L1', 'PUT', '/api/budgets/PD', { ...credit, spent: 200 })).json.credited).toBe(50);
    expect(row()).toMatchObject({ totalUsed: 200, totalRemaining: 800 });
    // refused for non-writers: set the allocation, raise spent, other department (requester), wildcard
    expect((await call('ONLINE', 'PUT', '/api/budgets/PD', { monthlyBudget: 5000, spent: 100 })).status).toBe(403);
    const stale = await call('L1', 'PUT', '/api/budgets/PD', { monthlyBudget: 1000, spent: 900 }); // client's figure is older than D1 -> reload
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain('รีเฟรช');
    expect((await call('L1', 'PUT', '/api/budgets/PD', { monthlyBudget: 1000 })).status).toBe(403); // no spent figure
    expect((await call('L1', 'PUT', '/api/budgets/QC', { monthlyBudget: 500, spent: 50 })).status).toBe(403);
    expect(one("SELECT totalUsed FROM budgets WHERE id = 'QC'").totalUsed).toBe(100);
    expect((await call('L1', 'PUT', '/api/budgets/ALL', { spent: 0 })).status).toBe(400);
    expect((await call('L1', 'PUT', '/api/budgets/NOPE', { spent: 0 })).status).toBe(404);
    expect(row()).toMatchObject({ monthlyBudget: 1000, totalUsed: 200 });
    // the online purchaser works across departments
    expect((await call('ONLINE', 'PUT', '/api/budgets/QC', { monthlyBudget: 500, spent: 90, docNo: 'PO-CQ' })).json.credited).toBe(10);
    // a budget writer keeps the full upsert
    expect((await call('L2', 'PUT', '/api/budgets/PD', { monthlyBudget: 1500 })).status).toBe(200);
    expect(row().monthlyBudget).toBe(1500);
  });

  it('PUT/POST /api/budgets : unknown department refused when departments has data ; a D1 error is a 500, not a fake success', async () => {
    expect((await call('ADMIN', 'POST', '/api/departments', { code: 'PD', name: 'ผลิต' })).status).toBe(200);
    expect((await call('L2', 'PUT', '/api/budgets/ZZ', { monthlyBudget: 1 })).status).toBe(400);
    expect(rows("SELECT id FROM budgets WHERE id = 'ZZ'").length).toBe(0);
    const ok = await call('L2', 'PUT', '/api/budgets/PD', { monthlyBudget: 10 });
    expect(ok.status).toBe(200);
    const real = env.DB;
    env.DB = { ...real, prepare: (q) => (q.includes('INSERT INTO budgets') ? { bind: () => ({ run: async () => { throw new Error('D1 down'); } }) } : real.prepare(q)) };
    try {
      expect((await call('L2', 'PUT', '/api/budgets/PD', { monthlyBudget: 20 })).status).toBe(500);
      expect((await call('L2', 'POST', '/api/budgets', { PD: { monthlyBudget: 20 } })).status).toBe(500);
    } finally {
      env.DB = real;
    }
    expect(one("SELECT monthlyBudget FROM budgets WHERE id = 'PD'").monthlyBudget).toBe(10);
  });

  it('T3.7 budget month/year default to the current Asia/Bangkok month (no hard-coded 2026-10) ; a month sent by the client is used as is', async () => {
    const sign = async (iso) => {
      vi.setSystemTime(new Date(iso));
      for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await sign('2026-12-31T16:30:00Z'); // 23:30 Bangkok, Dec 2026
      expect(bangkokMonth()).toBe('2026-12');
      const a = await call('L2', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 100 });
      expect(a.status).toBe(200);
      expect(a.json.transaction.period).toBe('2026-12');
      expect(one("SELECT targetMonth, period FROM budget_transactions WHERE type = 'TOP_UP'")).toEqual({ targetMonth: '2026-12', period: '2026-12' });
      expect(one("SELECT fiscalYear FROM budgets WHERE id = 'PD'").fiscalYear).toBe(2026);

      await sign('2026-12-31T17:30:00Z'); // 00:30 Bangkok, Jan 2027
      expect(bangkokMonth()).toBe('2027-01');
      const b = await call('L2', 'POST', '/api/budgets/allocate', { allocations: { QC: 300 } }); // no period sent
      expect(b.status).toBe(200);
      expect(b.json.period).toBe('2027-01');
      expect(one("SELECT fiscalYear FROM budgets WHERE id = 'QC'").fiscalYear).toBe(2027);
      expect(JSON.parse(one("SELECT monthsJson FROM budgets WHERE id = 'QC'").monthsJson)).toEqual({ '2027-01': 300 });
      const c = await call('L2', 'POST', '/api/budgets/adjust', { dept: 'PD', newAmount: 900 }); // set-budget flow, no month
      expect(c.status).toBe(200);
      expect(one("SELECT targetMonth FROM budget_transactions WHERE id != ? AND typeLabel LIKE '%งบประมาณ%' ORDER BY rowid DESC LIMIT 1", a.json.transaction.id).targetMonth).toBe('2027-01');
      // explicit month from the client wins (the original mock does the same)
      const d = await call('L2', 'POST', '/api/budgets/adjust', { dept: 'PD', action: 'TOP_UP', delta: 5, targetMonth: '2026-03' });
      expect(d.json.transaction.period).toBe('2026-03');
      // bootstrap default history for a budget row without monthsJson uses the current month
      sdb.prepare("INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalUsed, totalRemaining) VALUES ('HR','HR',2027,50,0,50)").run();
      const boot = await call('L2', 'GET', '/api/bootstrap');
      expect(boot.json.budgets.HR.history).toEqual({ '2027-01': 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /api/products/recalculate-mac recomputes avgCost / totalValue from IN logs', async () => {
    await call('ADMIN', 'POST', '/api/products', { id: 'M1', code: 'MC1', name: 'ถุงมือ', department: 'PD', currentStock: 10 });
    const ins = sdb.prepare("INSERT INTO stock_logs (id, productId, productCode, productName, type, quantity, balance, department, unitPrice, createdAt) VALUES (?, 'M1', 'MC1', 'ถุงมือ', ?, ?, 0, 'PD', ?, ?)");
    ins.run('L-1', 'IN', 10, 5, '2026-01-01T00:00:00Z');
    ins.run('L-2', 'IN', 10, 7, '2026-02-01T00:00:00Z');
    ins.run('L-3', 'OUT', 5, 9, '2026-03-01T00:00:00Z'); // OUT never counts
    const r = await call('L1', 'POST', '/api/products/recalculate-mac', { productCode: 'mc1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, averageCost: 6, totalValue: 60 });
    expect(one("SELECT avgCost, totalValue FROM products WHERE id = 'M1'")).toEqual({ avgCost: 6, totalValue: 60 });
    expect((await call('L1', 'POST', '/api/products/recalculate-mac', { productId: 'nope' })).status).toBe(404);
    expect((await call('L1', 'POST', '/api/products/recalculate-mac', {})).status).toBe(400);
    // no IN history and no supplied figure -> unchanged
    await call('ADMIN', 'POST', '/api/products', { id: 'M2', code: 'MC2', name: 'x', department: 'PD', currentStock: 3 });
    const none = await call('L1', 'POST', '/api/products/recalculate-mac', { productId: 'M2' });
    expect(none.json.averageCost).toBe(0);
    expect(one("SELECT avgCost FROM products WHERE id = 'M2'").avgCost).toBe(0);
  });
});
