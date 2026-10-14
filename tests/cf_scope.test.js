// @vitest-environment node
// P4 : the read endpoints send each user the UNION of what the original screens of that user can show (functions/_lib/scope.js).
// For every persona the server's answer is compared with the REAL client functions (canAccessDepartmentData, hasDepartmentAccess, matchDepartment,
// canSeeWorkspaceDocument, isDashboardMultiDeptUser, resolveUserPermissions, normalizeRole, notificationService.isNotificationTarget) :
//   server set == union of what the screens show  (nothing missing, nothing extra)
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare'); // the client's admin rule is the server one in this mode (adminRule.js)

const { onRequest } = await import('../functions/api/[[route]].js');
const { hashPassword } = await import('../functions/_lib/password.js');
const { isUserTargetOfNotification } = await import('../functions/_lib/extra.js');
const { canAccessDepartmentData, matchDepartment, hasDepartmentAccess, isDashboardMultiDeptUser } = await import('../src/utils/permissions.js');
const { resolveUserPermissions } = await import('../src/config/constants.js');
const { normalizeRole } = await import('../src/context/AuthContext.jsx');
const { canSeeWorkspaceDocument } = await import('../src/services/workspaceService.js');
const { notificationService } = await import('../src/services/notificationService.js');

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Persona#Pass1';

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

// persona = [key, id, username, name, department, allowedDepartments, roleId, canonicalRole, level, email]
const PERSONAS = {
  L1_PD: ['U-L1PD', 'l1.pd', 'Pim PD', 'PD', ['PD'], 'REQUESTER_PD', 'REQUESTER', 1],
  L1_QC: ['U-L1QC', 'l1.qc', 'Qui QC', 'QC', ['QC'], 'REQUESTER_QC', 'REQUESTER', 1],
  L1_MULTI: ['U-L1M', 'l1.multi', 'Mali Multi', 'PD', ['PD', 'WH'], 'REQUESTER_PD', 'REQUESTER', 1],
  L2_PD: ['U-L2PD', 'l2.pd', 'Asst PD', 'PD', ['PD'], 'ASST_MANAGER', 'REVIEWER', 2],
  L2_MULTI: ['U-L2M', 'l2.multi', 'Asst Multi', 'PD', ['PD', 'QC'], 'ASST_MANAGER', 'REVIEWER', 2],
  L2_STAR: ['U-L2S', 'l2.star', 'Asst Star', 'PD', ['*'], 'ASST_MANAGER', 'REVIEWER', 2],
  L3_MGT: ['U-L3', 'l3.mgt', 'Plant MGT', 'MGT', ['MGT'], 'PLANT_MANAGER', 'APPROVER', 3],
  L3_STAR: ['U-L3S', 'l3.star', 'Plant Star', 'MGT', ['*'], 'PLANT_MANAGER', 'APPROVER', 3],
  ONLINE_STAR: ['U-ONS', 'on.star', 'Online Star', 'PUR', ['*'], 'ONLINE_PURCHASER', 'PURCHASER', 2],
  ONLINE_PUR: ['U-ONP', 'on.pur', 'Online Pur', 'PUR', ['PUR'], 'ONLINE_PURCHASER', 'PURCHASER', 2],
  PURCHASER: ['U-PUR', 'pur.l2', 'Purchaser', 'PUR', ['PUR'], 'PURCHASER', 'PURCHASER', 2],
  ADMIN: ['U-AD', 'adm', 'Admin', 'ALL', ['*'], 'ADMIN', 'ADMIN', 99],
  ALL_USER: ['U-ALL', 'all.user', 'All User', 'ALL', ['ALL'], 'REQUESTER_PD', 'REQUESTER', 1],
  L2_WH: ['U-L2WH', 'l2.wh', 'Asst WH', 'WH', ['WH'], 'ASST_MANAGER', 'REVIEWER', 2],
  L2_ENG: ['U-L2ENG', 'l2.eng', 'Asst ENG', 'ENG', ['ENG'], 'ASST_MANAGER', 'REVIEWER', 2]
};
const DEPTS = ['PD', 'QC', 'WH', 'MGT', 'PUR', 'ENG', 'ALL', 'BOTH', 'DEPT-QC'];

// node:sqlite is required : if it is missing these tests FAIL (never skip silently)
it('node:sqlite is available (the P4 scope tests need it)', () => {
  expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy();
});

describe('P4 server scope == the screens', () => {
  let sdb; let env; let sessions; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ids = (list) => (list || []).map((x) => x.id).sort();

  // the session the client holds after login + the first bootstrap revalidation (authService CF branch + AuthContext + AppContext)
  const clientSession = (u) => {
    const perms = resolveUserPermissions(u);
    const base = {
      id: u.id, username: u.username, employeeId: u.employeeId, name: u.name, employeeName: u.employeeName || u.name, displayName: u.displayName || u.name,
      primaryDepartment: u.primaryDepartment || u.department, department: u.department, departments: perms.departments, assignedDepartments: perms.departments,
      allowedDepartments: perms.departments, roleId: u.roleId, positionKey: u.positionKey || u.roleId, title: u.title, level: u.level || 1,
      email: u.email, isAdmin: u.isAdmin, ...perms, role: perms, rolePermissions: perms
    };
    const s = { ...base, canonicalRole: normalizeRole(base) };
    return { ...s, ...perms, role: s.isAdmin || s.roleId === 'ADMIN' || s.level >= 99 || s.username === 'admin' ? 'admin' : String(s.roleId || 'user').toLowerCase() };
  };

  beforeAll(() => { vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare'); });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    for (const [k, [id, username, name, department, depts, roleId, canon, level]] of Object.entries(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, email, passwordHash, passwordSalt, passwordAlgo, passwordIterations, signature) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?)")
        .run(id, username, '', name, department, JSON.stringify(depts), roleId, canon, level, `${username}@corp.test`, rec.hash, rec.salt, rec.algo, rec.iterations, `sig-${k}`);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    sessions = {};
    for (const [k, p] of Object.entries(PERSONAS)) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: p[1], password: PASS }) }), env });
      const j = await r.json();
      tokens[k] = j.token;
      sessions[k] = clientSession(j.user);
    }
    // documents of every department ; some created by a persona in ANOTHER department
    const prCols = sdb.prepare('PRAGMA table_info(prs)').all().map((c) => c.name);
    const poCols = sdb.prepare('PRAGMA table_info(pos)').all().map((c) => c.name);
    const ins = (table, cols, row) => {
      const keys = Object.keys(row).filter((k) => cols.includes(k));
      sdb.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
    };
    DEPTS.forEach((d, i) => {
      ins('prs', prCols, { id: `PR-${d}`, prNumber: `PRN-${i}`, department: d, status: 'SUBMITTED', totalAmount: 1, itemsJson: '[]', requesterId: 'U-NOBODY', requesterName: 'someone else', extraJson: JSON.stringify({ requestedBy: 'someone else' }) });
      ins('pos', poCols, { id: `PO-${d}`, poNumber: `PON-${i}`, department: d, status: 'ISSUED', totalAmount: 1, itemsJson: '[]', purchaseChannel: 'FACTORY' });
    });
    // created by L1_PD (name / username / requesterId) in QC and WH ; by L1_QC in MGT ; an online-channel PO in WH
    // the creator lives in D1 as extraJson.requestedBy (written by POST /api/prs) or, for old rows, only as the requesterName column (read back as requestedBy)
    ins('prs', prCols, { id: 'PR-X-NAME', prNumber: 'PRN-X1', department: 'QC', status: 'SUBMITTED', totalAmount: 1, itemsJson: '[]', requesterName: 'Pim PD', extraJson: JSON.stringify({ requestedBy: 'Pim PD' }), requesterId: 'U-OTHER' });
    ins('prs', prCols, { id: 'PR-X-LEGACY', prNumber: 'PRN-X4', department: 'QC', status: 'SUBMITTED', totalAmount: 1, itemsJson: '[]', requesterName: 'pim pd', requesterId: 'U-OTHER' });
    ins('prs', prCols, { id: 'PR-X-ID', prNumber: 'PRN-X2', department: 'WH', status: 'SUBMITTED', totalAmount: 1, itemsJson: '[]', requesterId: 'U-L1PD', requesterName: 'x' });
    ins('prs', prCols, { id: 'PR-X-QC', prNumber: 'PRN-X3', department: 'MGT', status: 'SUBMITTED', totalAmount: 1, itemsJson: '[]', requesterName: 'x', extraJson: JSON.stringify({ requestedBy: 'l1.qc' }), requesterId: 'x' });
    ins('pos', poCols, { id: 'PO-X-ONLINE', poNumber: 'PON-X1', department: 'WH', status: 'IN_PROGRESS_ONLINE', totalAmount: 1, itemsJson: '[]', purchaseChannel: 'ONLINE' });
    ins('pos', poCols, { id: 'PO-X-NAME', poNumber: 'PON-X2', department: 'QC', status: 'ISSUED', totalAmount: 1, itemsJson: '[]', purchaseChannel: 'FACTORY', extraJson: JSON.stringify({ createdBy: 'Pim PD' }) });
    for (const d of DEPTS) {
      sdb.prepare('INSERT INTO stock_logs (id, productId, type, department, quantity, balance, createdAt) VALUES (?,?,?,?,?,?,?)').run(`LOG-${d}`, `P-${d}`, 'IN', d, 1, 1, new Date().toISOString());
      sdb.prepare('INSERT INTO budgets (id, department, fiscalYear, monthlyBudget) VALUES (?,?,?,?)').run(`BUD-${d}`, d, 2026, 1000);
      sdb.prepare('INSERT INTO budget_transactions (id, dept, department, type, amount, createdAt) VALUES (?,?,?,?,?,?)').run(`TX-${d}`, d, d, 'TOP_UP', 1, new Date().toISOString());
    }
  });

  // ───────── what the screens show, built ONLY from the real client functions ─────────
  const screens = {
    pr: (s, d) => {
      const doc = { ...d, docType: 'PR' };
      return canAccessDepartmentData(s, d.department) // PRListView
        || hasDepartmentAccess(s, d.department) // KPICards ('ALL' tab)
        || canSeeWorkspaceDocument(doc, s) // WorkspaceView
        || (isDashboardMultiDeptUser(s) && (matchDepartment(d.department, 'PD') || matchDepartment(d.department, 'QC'))) // KPICards PD / QC tab
        || screens.budget(s, d.department); // BudgetView / budget cards : computed on the client from this department's PRs / POs
    },
    po: (s, d) => {
      const doc = { ...d, docType: 'PO' };
      const online = s.roleId === 'ONLINE_PURCHASER' || s.id === 'ONLINE_PURCHASER';
      return (online ? d.purchaseChannel === 'ONLINE' : canAccessDepartmentData(s, d.department)) // POListView
        || hasDepartmentAccess(s, d.department)
        || canSeeWorkspaceDocument(doc, s)
        || (isDashboardMultiDeptUser(s) && (matchDepartment(d.department, 'PD') || matchDepartment(d.department, 'QC')))
        || screens.budget(s, d.department);
    },
    // QuickIssueView / StockCardView / StockMovementTable
    log: (s, l) => Boolean(s.canViewAllDepts) || canAccessDepartmentData(s, l.department),
    // BudgetView.userAssignedDepts (isSuperAdminOrApprover includes level >= 2 / admin ; canViewAllDepts ; online) + the dashboard tabs
    budget: (s, dept) => (Number(s.level) >= 2 || s.roleId === 'ADMIN' || s.isAdmin === true || Boolean(s.canViewAllDepts) || s.roleId === 'ONLINE_PURCHASER')
      || canAccessDepartmentData(s, dept)
      || (isDashboardMultiDeptUser(s) && (matchDepartment(dept, 'PD') || matchDepartment(dept, 'QC')))
  };

  it('PR list : server == union of the screens, for every persona', async () => {
    // the documents as a client holds them : extraJson fields on top level, requestedBy falling back to requesterName
    const all = sdb.prepare('SELECT * FROM prs').all().map((r) => { const e = r.extraJson ? JSON.parse(r.extraJson) : {}; return { ...e, ...r, prNo: r.prNumber, requestedBy: e.requestedBy || r.requesterName || '' }; });
    for (const k of Object.keys(PERSONAS)) {
      const expected = ids(all.filter((d) => screens.pr(sessions[k], d)));
      const got = await call(k, 'GET', '/api/prs');
      expect(got.status, k).toBe(200);
      expect(ids(got.json), `PR list of ${k}`).toEqual(expected);
      const boot = await call(k, 'GET', '/api/bootstrap');
      expect(ids(boot.json.prs), `bootstrap PRs of ${k}`).toEqual(expected);
    }
  });

  it('PO list : server == union of the screens, for every persona', async () => {
    const all = sdb.prepare('SELECT * FROM pos').all().map((r) => ({ ...(r.extraJson ? JSON.parse(r.extraJson) : {}), ...r, poNo: r.poNumber }));
    for (const k of Object.keys(PERSONAS)) {
      const expected = ids(all.filter((d) => screens.po(sessions[k], d)));
      const got = await call(k, 'GET', '/api/pos');
      expect(ids(got.json), `PO list of ${k}`).toEqual(expected);
      const boot = await call(k, 'GET', '/api/bootstrap');
      expect(ids(boot.json.pos), `bootstrap POs of ${k}`).toEqual(expected);
    }
  });

  it('stock logs : server == QuickIssue / StockCard rule', async () => {
    const all = sdb.prepare('SELECT * FROM stock_logs').all();
    for (const k of Object.keys(PERSONAS)) {
      const expected = ids(all.filter((l) => screens.log(sessions[k], l)));
      expect(ids((await call(k, 'GET', '/api/stock-logs')).json), `stock logs of ${k}`).toEqual(expected);
      expect(ids((await call(k, 'GET', '/api/bootstrap')).json.stockLogs), `bootstrap logs of ${k}`).toEqual(expected);
    }
  });

  it('budgets and the ledger : server == BudgetView / dashboard rule', async () => {
    for (const k of Object.keys(PERSONAS)) {
      const wanted = DEPTS.filter((d) => screens.budget(sessions[k], d));
      const boot = (await call(k, 'GET', '/api/bootstrap')).json;
      expect(Object.keys(boot.budgets || {}).sort(), `bootstrap budgets of ${k}`).toEqual([...wanted].sort());
      expect((await call(k, 'GET', '/api/budgets')).json.map((b) => b.department).sort(), `budgets of ${k}`).toEqual([...wanted].sort());
      expect((await call(k, 'GET', '/api/budget-transactions')).json.map((t) => t.department).sort(), `ledger of ${k}`).toEqual([...wanted].sort());
      expect(boot.budgetTransactions.map((t) => t.department).sort(), `bootstrap ledger of ${k}`).toEqual([...wanted].sort());
    }
  });

  it('budget cards : calculatePeriodBudgetSummary on the filtered bootstrap == on the whole database, for every department the user sees', async () => {
    const { budgetService } = await import('../src/services/budgetService.js');
    const month = new Date().toISOString().slice(0, 7);
    const at = `${month}-10T08:00:00.000Z`;
    const prCols = sdb.prepare('PRAGMA table_info(prs)').all().map((c) => c.name);
    const poCols = sdb.prepare('PRAGMA table_info(pos)').all().map((c) => c.name);
    const ins = (table, cols, row) => {
      const keys = Object.keys(row).filter((k) => cols.includes(k));
      sdb.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
    };
    sdb.prepare('DELETE FROM budgets').run();
    ['PD', 'QC', 'WH', 'PUR', 'ENG', 'MGT'].forEach((d, i) => {
      sdb.prepare('INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, monthsJson) VALUES (?,?,?,?,?)').run(`BUD2-${d}`, d, 2026, 5000, JSON.stringify({ [month]: 5000 }));
      ins('pos', poCols, { id: `PO-B-${d}-C`, poNumber: `PBC-${i}`, department: d, status: 'CLOSED', totalAmount: 700 + i, grandTotal: 700 + i, itemsJson: '[]', createdAt: at, purchaseChannel: 'FACTORY' });
      ins('pos', poCols, { id: `PO-B-${d}-I`, poNumber: `PBI-${i}`, department: d, status: 'ISSUED', totalAmount: 300 + i, grandTotal: 300 + i, itemsJson: '[]', createdAt: at, purchaseChannel: 'FACTORY' });
      ins('prs', prCols, { id: `PR-B-${d}`, prNumber: `PBR-${i}`, department: d, status: 'SUBMITTED', totalAmount: 100 + i, itemsJson: '[]', createdAt: at });
    });
    const summaryOf = (boot) => budgetService.calculatePeriodBudgetSummary(month, boot.prs, boot.pos, boot.budgets).current;
    const whole = summaryOf((await call('ADMIN', 'GET', '/api/bootstrap')).json);
    expect(whole.WH.actualSpent).toBeGreaterThan(0); // the fixture really produces figures
    for (const k of Object.keys(PERSONAS)) {
      const boot = (await call(k, 'GET', '/api/bootstrap')).json;
      const mine = summaryOf(boot);
      const shown = Object.keys(boot.budgets || {}).filter((d) => ['PD', 'QC', 'WH', 'PUR', 'ENG', 'MGT'].includes(d));
      for (const d of shown) expect(mine[d], `${k} sees the ${d} card`).toEqual(whole[d]); // actualSpent / committed / totals identical, never a silent 0
    }
    // the reported case : a single-department assistant manager sees the budget of every department with the real figures
    const wh = summaryOf((await call('L2_WH', 'GET', '/api/bootstrap')).json);
    expect(wh.ENG.actualSpent).toBe(whole.ENG.actualSpent);
    expect(wh.PD.committed).toBe(whole.PD.committed);
  });

  it('documents created by the user (requestedBy = own e-mail / name / username) : server rule == WorkspaceView rule', () => {
    // D1 has no requestedBy / createdBy / applicantName1 column, so these fields are absent on rows read from D1 ; the rule is ported for documents that carry them
    return import('../functions/_lib/scope.js').then(({ buildViewer, canSeeDocument }) => {
      for (const k of ['L1_PD', 'L1_QC', 'L1_MULTI', 'L2_PD', 'L3_MGT', 'ADMIN']) {
        const p = PERSONAS[k];
        const authUser = { id: p[0], userId: p[0], username: p[1], name: p[2], email: `${p[1]}@corp.test`, department: p[3], allowedDepartments: JSON.stringify(p[4]), roleId: p[5], canonicalRole: p[6], level: p[7] };
        const v = buildViewer(authUser);
        for (const field of ['requestedBy', 'applicantName1', 'createdBy']) {
          for (const value of [authUser.email, authUser.name, authUser.username.toUpperCase(), 'somebody else']) {
            for (const dept of ['PD', 'QC', 'WH', 'MGT']) {
              const doc = { id: 'x', department: dept, [field]: value };
              const sess = sessions[k];
              const expected = screens.pr(sess, doc);
              expect(canSeeDocument(v, doc), `${k} ${field}=${value} dept ${dept}`).toBe(expected);
            }
          }
        }
      }
    });
  });

  it('cross-department IDOR : every endpoint that takes a document / product id refuses another department (403) and changes nothing', async () => {
    const poId = 'PO-QC'; // department QC
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-QCX', 'QC-X', 'n', 'QC', 'QC', 10, 0)").run();
    sdb.prepare("UPDATE pos SET status='CLOSED' WHERE id='PO-DEPT-QC'").run();
    const stockBefore = sdb.prepare("SELECT currentStock FROM products WHERE id='P-QCX'").get().currentStock;
    const receiveBody = { receivingItems: [{ productId: 'P-QCX', goodQty: 1 }] };
    const attempts = [
      ['POST', `/api/pos/${poId}/receive`, receiveBody],
      ['POST', '/api/receive-goods', { poId, ...receiveBody }],
      ['POST', '/api/receive', { poId, ...receiveBody }],
      ['POST', '/api/grn', { poId, ...receiveBody }],
      ['POST', '/api/inventory/receive', { poId, ...receiveBody }],
      ['POST', '/api/pos/PON-5/receive', receiveBody], // by PO number (PO-DEPT-QC is closed : the department is still checked FIRST)
      ['POST', `/api/pos/${poId}/settle`, { actualTotalAmount: 0 }],
      ['PUT', `/api/pos/${poId}`, { status: 'CANCELLED' }],
      ['PUT', '/api/prs/PR-QC', { note: 'x' }],
      ['POST', '/api/stock/issue', { productId: 'P-QCX', quantity: 1 }],
      ['POST', '/api/inventory/issue', { productCode: 'QC-X', quantity: 1 }]
    ];
    for (const who of ['L1_PD', 'L2_PD']) {
      for (const [method, p, body] of attempts) {
        const r = await call(who, method, p, body);
        expect(r.status, `${who} ${method} ${p}`).toBe(403);
      }
    }
    expect(sdb.prepare("SELECT currentStock FROM products WHERE id='P-QCX'").get().currentStock).toBe(stockBefore); // nothing moved
    expect(sdb.prepare("SELECT status FROM pos WHERE id='PO-QC'").get().status).toBe('ISSUED');
    // the same calls from the right department are not blocked by the gate
    const own = await call('L1_QC', 'POST', `/api/pos/${poId}/receive`, receiveBody);
    expect(own.status).not.toBe(403);
    const issue = await call('L1_QC', 'POST', '/api/stock/issue', { productId: 'P-QCX', quantity: 1 });
    expect(issue.status).toBe(200);
  });

  it('P4f receive : only lines of THIS PO move stock, the product is the PO line\'s (not the body\'s), another department\'s product is refused', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-PDX', 'PD-X', 'pd item', 'PD', 'PD', 10, 0)").run();
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-QCY', 'QC-Y', 'qc item', 'QC', 'QC', 10, 0)").run();
    const stock = (id) => sdb.prepare('SELECT currentStock FROM products WHERE id = ?').get(id).currentStock;
    sdb.prepare("UPDATE pos SET itemsJson = ? WHERE id = 'PO-PD'").run(JSON.stringify([{ id: 'L1', productId: 'P-PDX', code: 'PD-X', name: 'pd item', qty: 5 }]));
    // a body line that is not on the PO (it names a QC product) moves nothing ; with no matching line at all -> 400
    const stray = await call('L1_PD', 'POST', '/api/pos/PO-PD/receive', { receivingItems: [{ productId: 'P-QCY', goodQty: 3 }] });
    expect(stray.status).toBe(400);
    expect(stock('P-QCY')).toBe(10);
    // one valid line + one stray line : only the valid one is received, the stray one is reported
    const mixed = await call('L1_PD', 'POST', '/api/pos/PO-PD/receive', { receivingItems: [{ productId: 'P-PDX', goodQty: 2 }, { productId: 'P-QCY', goodQty: 3 }] });
    expect(mixed.status).toBe(200);
    expect(mixed.json.skipped).toEqual(['P-QCY']);
    expect(stock('P-PDX')).toBe(12);
    expect(stock('P-QCY')).toBe(10);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM stock_logs WHERE productId = 'P-QCY'").get().c).toBe(0);
    // a PO of my own department whose LINE points at another department's product : refused before anything is written
    sdb.prepare("UPDATE pos SET itemsJson = ?, status = 'ISSUED' WHERE id = 'PO-PD'").run(JSON.stringify([{ id: 'L1', productId: 'P-QCY', code: 'QC-Y', name: 'qc item', qty: 5 }]));
    const before = sdb.prepare("SELECT updatedAt, itemsJson FROM pos WHERE id = 'PO-PD'").get();
    const cross = await call('L1_PD', 'POST', '/api/pos/PO-PD/receive', { receivingItems: [{ productId: 'P-QCY', goodQty: 3 }] });
    expect(cross.status).toBe(403);
    expect(stock('P-QCY')).toBe(10);
    expect(sdb.prepare("SELECT updatedAt, itemsJson FROM pos WHERE id = 'PO-PD'").get()).toEqual(before);
  });

  it('P4f settle checks the department BEFORE the status ; a new PO id cannot equal another PO\'s number ; stock issue falls back to category, none -> admin only', async () => {
    sdb.prepare("UPDATE pos SET status = 'CANCELLED' WHERE id = 'PO-QC'").run();
    expect((await call('L1_PD', 'POST', '/api/pos/PO-QC/settle', { actualTotalAmount: 0 })).status).toBe(403); // not 409 : the status of another department's PO is not revealed
    // PO id = an existing PO number
    const clash = await call('ADMIN', 'POST', '/api/pos', { id: 'PON-0', poNo: 'PO-NEW-1', department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [] });
    expect(clash.status).toBe(409);
    // stock issue : department empty -> category decides ; neither -> admin only
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-CAT', 'CAT-1', 'n', 'QC', '', 10, 0)").run();
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-NONE', 'NONE-1', 'n', '', '', 10, 0)").run();
    expect((await call('L1_PD', 'POST', '/api/stock/issue', { productId: 'P-CAT', quantity: 1 })).status).toBe(403);
    expect((await call('L1_QC', 'POST', '/api/stock/issue', { productId: 'P-CAT', quantity: 1 })).status).toBe(200);
    expect((await call('L1_PD', 'POST', '/api/stock/issue', { productId: 'P-NONE', quantity: 1 })).status).toBe(403);
    expect((await call('ADMIN', 'POST', '/api/stock/issue', { productId: 'P-NONE', quantity: 1 })).status).toBe(200);
  });

  it('privileged users still get the whole picture (totals / dashboards unchanged) ; a plain L1 does not', async () => {
    for (const k of ['ADMIN', 'L3_MGT', 'L3_STAR', 'ONLINE_STAR', 'PURCHASER']) {
      const boot = (await call(k, 'GET', '/api/bootstrap')).json;
      expect(Object.keys(boot.budgets).length, k).toBe(DEPTS.length);
      expect(boot.stockLogs.length >= 1, k).toBe(true);
    }
    const adminBoot = (await call('ADMIN', 'GET', '/api/bootstrap')).json;
    expect(adminBoot.prs.length).toBe(sdb.prepare('SELECT COUNT(*) AS c FROM prs').get().c);
    expect(adminBoot.pos.length).toBe(sdb.prepare('SELECT COUNT(*) AS c FROM pos').get().c);
    const l1 = (await call('L1_QC', 'GET', '/api/bootstrap')).json;
    expect(l1.prs.some((p) => p.department === 'PD')).toBe(false); // a QC requester does not get the PD PRs
    expect(l1.stockLogs.some((l) => l.department === 'PD')).toBe(false);
  });

  it('reference data stays complete : products / vendors / departments / users of every department', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-QC','QC-1','n','QC','QC',1,0)").run();
    sdb.prepare("INSERT INTO departments (id, code, name, isActive) VALUES ('DEPT-QC','QC','qc',1)").run();
    const boot = (await call('L1_PD', 'GET', '/api/bootstrap')).json;
    expect(boot.products.map((p) => p.id)).toContain('P-QC');
    expect(boot.departments.map((d) => d.code)).toContain('QC');
    expect(boot.users.length).toBe(Object.keys(PERSONAS).length);
  });

  it('users : signatures of everybody are kept (printed on PR / PO) ; e-mail of OTHER people only for the admin', async () => {
    const asL1 = (await call('L1_PD', 'GET', '/api/bootstrap')).json.users;
    expect(asL1.every((u) => typeof u.signature === 'string' && u.signature.startsWith('sig-'))).toBe(true);
    expect(asL1.find((u) => u.id === 'U-L1PD').email).toBe('l1.pd@corp.test'); // own e-mail stays
    expect(asL1.filter((u) => u.id !== 'U-L1PD').every((u) => !('email' in u))).toBe(true);
    const list = (await call('L1_PD', 'GET', '/api/users')).json;
    expect(list.filter((u) => u.id !== 'U-L1PD').every((u) => !('email' in u))).toBe(true);
    const asAdmin = (await call('ADMIN', 'GET', '/api/users')).json;
    expect(asAdmin.every((u) => u.email && u.email.endsWith('@corp.test'))).toBe(true);
    const sensitive = ['password', 'passwordHash', 'passwordSalt', 'pin', 'tokenVersion', 'mustChangePassword'];
    for (const u of asAdmin) for (const f of sensitive) expect(u, f).not.toHaveProperty(f);
  });

  it('notifications : the server never hides a notification the client rule shows (assigned departments included)', () => {
    const NOTIFS = [];
    for (const dept of ['ALL', 'PD', 'QC', 'WH', 'MGT', 'PUR']) {
      for (const role of ['ALL', 'REQUESTER', 'APPROVER', 'PURCHASER', 'REVIEWER']) NOTIFS.push({ id: `${dept}-${role}`, targetDepartment: dept, targetRole: role });
    }
    for (const [k, s] of Object.entries(sessions)) {
      const u = PERSONAS[k];
      // the viewer the server hands to the notification rule (formatSafeUser of the stored row)
      const viewer = { id: u[0], username: u[1], roleId: u[5], canonicalRole: u[6], level: u[7], department: u[3], assignedDepartments: u[4], departments: u[4], isAdmin: u[7] >= 99,
        canViewAllDepts: s.canViewAllDepts, canReview: s.canReview, canFinalApprove: s.canFinalApprove, canOnlinePurchase: s.canOnlinePurchase };
      for (const n of NOTIFS) {
        if (notificationService.isNotificationTarget(n, s)) expect(isUserTargetOfNotification(n, viewer), `${k} / ${n.id}`).toBe(true);
      }
    }
  });
});
