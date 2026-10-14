// @vitest-environment node
// M7-1a : GET /api/audit-logs returns the GAS recordAuditLogEntry field set (admin only), ISO-Z timestamps, correct order for mixed formats
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { auditModuleOf, auditIsoTime } from '../functions/_lib/extra.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
const GAS_FIELDS = ['action', 'actor', 'actorName', 'actorRole', 'changes', 'comment', 'createdAt', 'details', 'docNo', 'documentNo', 'id', 'module', 'note', 'prNo', 'reason', 'summary', 'targetRef', 'timestamp'];

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

describe('audit shape helpers (pure)', () => {
  it('module map', () => {
    // client moduleMap (auditService.js:211) literally ; GAS = PURCHASE ; unmapped = SYSTEM
    expect(['pr', 'po', 'PR', 'PO'].map(auditModuleOf)).toEqual(['PURCHASE', 'PURCHASE', 'PURCHASE', 'PURCHASE']);
    expect(['stock_log', 'STOCK'].map(auditModuleOf)).toEqual(['INVENTORY', 'INVENTORY']);
    expect(['product', 'vendor', 'location', 'usage_unit', 'department'].map(auditModuleOf)).toEqual(Array(5).fill('MASTER'));
    expect(['user', 'signature', 'auth'].map(auditModuleOf)).toEqual(['RBAC', 'RBAC', 'RBAC']);
    expect(['budget', 'budget_transaction'].map(auditModuleOf)).toEqual(['BUDGET', 'BUDGET']);
    expect(['grn', 'GRN', null, 'whatever'].map(auditModuleOf)).toEqual(['SYSTEM', 'SYSTEM', 'SYSTEM', 'SYSTEM']);
    expect(auditModuleOf('PURCHASE')).toBe('PURCHASE');
  });
  it('timestamps -> ISO-Z (D1 format is UTC)', () => {
    expect(auditIsoTime('2026-03-01 10:00:00')).toBe('2026-03-01T10:00:00.000Z');
    expect(auditIsoTime('2026-03-01T10:00:00.123Z')).toBe('2026-03-01T10:00:00.123Z');
    expect(auditIsoTime('2026-03-01T17:00:00+07:00')).toBe('2026-03-01T10:00:00.000Z');
    expect(auditIsoTime(null)).toBe('');
  });
});

describe.skipIf(!DatabaseSync)('GET /api/audit-logs (onRequest + migrated sqlite)', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ins = (id, action, type, entityId, by, details, ts) => sdb.prepare('INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) VALUES (?,?,?,?,?,?,?)').run(id, action, type, entityId, by, details, ts);

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, title) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?)")
        .run(u.id, u.username, 'SECRET-HASH', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level, `${u.name} title`);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
  });

  it('non-admin gets 403 (no body of rows)', async () => {
    ins('AL-1', 'CREATE', 'pr', 'PR-1', 'U-L1', '{}', '2026-03-01T00:00:00.000Z');
    for (const who of ['L1', 'L3']) {
      const r = await call(who, 'GET', '/api/audit-logs');
      expect(r.status, who).toBe(403);
      expect(Array.isArray(r.json)).toBe(false);
    }
    expect((await call('ADMIN', 'GET', '/api/audit-logs')).status).toBe(200);
  });

  it('internal duplicate actions (PR_UPSERT, STOCK_LOG) are hidden from the default list ; real events stay ; ?action= still finds them', async () => {
    ins('H-1', 'PR_UPSERT', 'pr', 'PR-1', 'U-AD', '{}', '2026-03-01T10:00:00.000Z');
    ins('H-2', 'STOCK_LOG', 'stock_log', 'SL-1', 'U-AD', '{}', '2026-03-01T10:01:00.000Z');
    ins('H-3', 'CREATE', 'pr', 'PR-1', 'U-AD', '{}', '2026-03-01T10:02:00.000Z');
    ins('H-4', 'PASSWORD_CHANGE', 'user', 'U-AD', 'U-AD', '{}', '2026-03-01T10:03:00.000Z');
    ins('H-5', 'BUDGET_TX', 'budget_transaction', 'T-1', 'U-AD', '{}', '2026-03-01T10:04:00.000Z');
    ins('H-6', 'PRODUCT_STOCK_SET', 'product', 'P-1', 'U-AD', '{}', '2026-03-01T10:05:00.000Z');
    const ids = (await call('ADMIN', 'GET', '/api/audit-logs')).json.map((x) => x.id).sort();
    expect(ids).toEqual(['H-3', 'H-4', 'H-5', 'H-6']);
    expect((await call('ADMIN', 'GET', '/api/audit-logs?action=PR_UPSERT')).json.map((x) => x.id)).toEqual(['H-1']);
    expect(sdb.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c).toBe(6); // nothing deleted
  });

  it('PR row (details.docNo / actorName / actorRole / comment) -> GAS fields exactly', async () => {
    ins('AL-PR1', 'APPROVE', 'pr', 'PR-ID-9', 'U-L3', JSON.stringify({ docNo: 'pd009/2026', comment: 'ok na', summary: 'ok na', status: 'APPROVED', actorName: 'Plant Mgr', actorRole: 'Plant Manager', roleKey: 'PLANT_MANAGER' }), '2026-03-01T10:00:00.000Z');
    const g = (await call('ADMIN', 'GET', '/api/audit-logs')).json;
    expect(g).toHaveLength(1);
    expect(Object.keys(g[0]).sort()).toEqual(GAS_FIELDS);
    expect(g[0]).toEqual({
      id: 'AL-PR1', timestamp: '2026-03-01T10:00:00.000Z', createdAt: '2026-03-01T10:00:00.000Z', action: 'APPROVE', module: 'PURCHASE',
      targetRef: 'PD009/2026', docNo: 'PD009/2026', documentNo: 'PD009/2026', prNo: 'PD009/2026', note: 'ok na', reason: 'ok na',
      actorName: 'Plant Mgr', actorRole: 'Plant Manager',
      actor: { id: 'plant.pm', name: 'Plant Mgr', role: 'Plant Manager', department: 'MGT' },
      summary: 'ok na', details: 'ok na', comment: 'ok na', changes: [{ field: 'บันทึกเหตุผล', before: '-', after: 'ok na' }]
    });
    // filter by the PR number stored in details as well as by entity id
    expect((await call('ADMIN', 'GET', '/api/audit-logs?docNo=pd009/2026')).json).toHaveLength(1); // exact match on the stored value as written
    ins('AL-PR2', 'CREATE', 'pr', 'PR-ID-9', 'U-L3', JSON.stringify({ docNo: 'PD009/2026' }), '2026-03-01T11:00:00.000Z');
    expect((await call('ADMIN', 'GET', '/api/audit-logs?docNo=PD009%2F2026')).json.map((x) => x.id)).toEqual(['AL-PR2']);
    expect((await call('ADMIN', 'GET', '/api/audit-logs?docNo=PR-ID-9')).json).toHaveLength(2);
  });

  it('helper audit() row (roleKey + details, user resolved from performedBy) and client row', async () => {
    ins('AUD-1', 'BUDGET_ADJUST', 'budget', 'PD', 'U-AD', JSON.stringify({ actorUserId: 'U-AD', action: 'ADD', amount: 5 }), '2026-03-02 08:00:00');
    ins('AUD-2', 'PRODUCT_STOCK_SET', 'product', 'P-1', 'U-AD', '{"from":1,"to":2}', '2026-03-02 09:00:00');
    ins('AUD-3', 'PASSWORD_CHANGE', 'user', 'U-L1', 'U-L1', '{}', '2026-03-02 10:00:00');
    ins('AUD-4', 'VENDOR_EDIT', 'vendor', 'V-1', 'U-L1', JSON.stringify({ roleKey: 'REQUESTER_PD', actor: 'Req', department: 'PD', clientActor: 'someone-else', text: 'edited vendor' }), '2026-03-02T11:00:00.000Z');
    const g = Object.fromEntries((await call('ADMIN', 'GET', '/api/audit-logs')).json.map((x) => [x.id, x]));
    for (const x of Object.values(g)) expect(Object.keys(x).sort()).toEqual(GAS_FIELDS);
    expect(g['AUD-1']).toMatchObject({ module: 'BUDGET', targetRef: 'PD', actorName: 'Admin', actorRole: 'Admin title', timestamp: '2026-03-02T08:00:00.000Z', summary: 'BUDGET_ADJUST บนเอกสาร PD', changes: [] });
    expect(g['AUD-1'].actor).toEqual({ id: 'admin', name: 'Admin', role: 'Admin title', department: 'ALL' });
    expect(g['AUD-2'].module).toBe('MASTER'); // client moduleMap : PRODUCT -> MASTER
    expect(g['AUD-3'].module).toBe('RBAC');
    expect(g['AUD-4']).toMatchObject({ module: 'MASTER', actorName: 'Req', summary: 'edited vendor', comment: 'edited vendor', docNo: 'V-1' });
    expect(g['AUD-4'].actor.department).toBe('PD');
    expect(g['AUD-4'].actor.id).toBe('req.pd'); // identity from the token-derived performedBy, never the client-sent actor
  });

  it('po row, GRN row (SYSTEM), stock_log row, bad / empty timestamps do not break the read', async () => {
    ins('P1', 'GOODS_RECEIVED_FULL', 'po', 'PO-ID-1', 'U-AD', JSON.stringify({ docNo: 'po-pd-2026-001', comment: 'ตรวจรับ', reason: 'เหตุผล X', actorName: 'Admin' }), '2026-04-01T00:00:00.000Z');
    ins('G1', 'GRN_CREATED', 'grn', 'GRN-1', 'U-AD', '{}', '2026-04-02T00:00:00.000Z');
    ins('S1', 'STOCK_ISSUE', 'stock_log', 'L-1', 'U-AD', '{"actorUserId":"U-AD"}', '2026-04-03T00:00:00.000Z');
    ins('BAD', 'X', 'pr', '1', 'U-AD', 'not json{', 'garbage-time');
    ins('EMPTY', 'X', 'pr', '1', 'U-AD', null, '');
    ins('NUL', 'X', null, null, null, null, null);
    const r = await call('ADMIN', 'GET', '/api/audit-logs');
    expect(r.status).toBe(200);
    const g = Object.fromEntries(r.json.map((x) => [x.id, x]));
    expect(g.P1).toMatchObject({ module: 'PURCHASE', docNo: 'PO-PD-2026-001', documentNo: 'PO-PD-2026-001', prNo: 'PO-PD-2026-001', note: 'ตรวจรับ', reason: 'เหตุผล X' });
    expect(g.G1.module).toBe('SYSTEM');
    expect(g.S1.module).toBe('INVENTORY');
    expect(g.BAD.timestamp).toBe('garbage-time');
    expect(g.EMPTY.timestamp).toBe('');
    expect(g.NUL).toMatchObject({ timestamp: '', module: 'SYSTEM', targetRef: '', actorName: 'ผู้ใช้งาน', actor: { id: 'USER' } });
    expect(r.json.slice(0, 3).map((x) => x.id)).toEqual(['S1', 'G1', 'P1']); // valid times first, newest first ; unparseable ones last
  });

  it('newest first when D1-format and ISO timestamps are mixed ; limit keeps the newest', async () => {
    ins('A', 'X', 'pr', '1', 'U-AD', '{}', '2026-03-01 10:00:00'); // 10:00Z
    ins('B', 'X', 'pr', '1', 'U-AD', '{}', '2026-03-01T09:30:00.000Z'); // text order would put it after A's ' ' < 'T'
    ins('C', 'X', 'pr', '1', 'U-AD', '{}', '2026-03-01T10:30:00.000Z');
    ins('D', 'X', 'pr', '1', 'U-AD', '{}', '2026-03-01 11:00:00');
    ins('E', 'X', 'pr', '1', 'U-AD', '{}', '2026-02-28T23:59:59.000Z');
    const g = (await call('ADMIN', 'GET', '/api/audit-logs')).json;
    expect(g.map((x) => x.id)).toEqual(['D', 'C', 'A', 'B', 'E']);
    expect(g.every((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x.timestamp))).toBe(true);
    expect((await call('ADMIN', 'GET', '/api/audit-logs?limit=2')).json.map((x) => x.id)).toEqual(['D', 'C']);
  });

  it('POST cannot forge server evidence : pr/po entities and server-owned actions are refused (400), no row written', async () => {
    const count = () => sdb.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
    const bad = [
      { docType: 'pr', docNo: 'PR-1', action: 'APPROVE' },
      { docType: 'PR', docNo: 'PR-1', action: 'whatever' },
      { entityType: 'Po', docNo: 'PO-1', action: 'x' },
      { module: 'pr', action: 'x' },
      { docType: 'VENDOR', action: 'approve' },
      { action: 'GOODS_RECEIVED_FULL' }, { action: ' po_settled ' }, { action: 'PASSWORD_CHANGE' }, { action: 'budget_adjust' }, { action: 'FILE_UPLOAD_ROLLBACK' }, { action: 'CANCEL' }, { action: 'PR_COMPLETED_BY_PO' }, { action: ' pr_completed_by_po ' }
    ];
    for (const b of bad) expect((await call('L1', 'POST', '/api/audit-logs', b)).status, JSON.stringify(b)).toBe(400);
    expect((await call('L1', 'POST', '/api/audit-logs', [{ action: 'OK1' }, { docType: 'pr', action: 'OK2' }])).status).toBe(400); // one bad entry refuses the batch
    expect(count()).toBe(0);
    // normal client names still work
    expect((await call('L1', 'POST', '/api/audit-logs', [{ action: 'LOGIN', docType: 'USER', docNo: 'req.pd' }, { action: 'PR_SUBMITTED', docType: 'WORKFLOW', docNo: 'X' }])).status).toBe(200);
    expect(count()).toBe(2);
  });

  it('client row : department / module come from the token user and the validated entityType, never from client values', async () => {
    expect((await call('L1', 'POST', '/api/audit-logs', { action: 'FAKE', docType: 'PURCHASE', docNo: 'D1', department: 'HACK-DEPT' })).status).toBe(200);
    expect((await call('L1', 'POST', '/api/audit-logs', { action: 'FAKE2', module: 'RBAC', docNo: 'D2', department: 'HACK-DEPT' })).status).toBe(200);
    const g = (await call('ADMIN', 'GET', '/api/audit-logs')).json;
    for (const x of g) {
      expect(x.actor.department).toBe('PD'); // users.department of the token user
      expect(JSON.stringify(x)).not.toContain('HACK-DEPT');
    }
    expect(g.find((x) => x.action === 'FAKE').module).toBe('SYSTEM'); // 'PURCHASE' sent by the client is not a trusted module
    expect(g.find((x) => x.action === 'FAKE2').module).toBe('SYSTEM');
  });

  it('does not leak secrets or internal fields', async () => {
    ins('S1', 'PR_UPSERT', 'pr', 'PR-1', 'U-L1', JSON.stringify({ roleKey: 'REQUESTER_PD', password: 'hunter2', token: 'tok-abc', passwordHash: 'h', requesterUserId: 'U-L1' }), '2026-03-01T00:00:00.000Z');
    const raw = JSON.stringify((await call('ADMIN', 'GET', '/api/audit-logs')).json);
    for (const bad of ['hunter2', 'tok-abc', 'SECRET-HASH', 'passwordHash', 'performedBy', 'entityType', 'entityId', 'roleKey', 'source', 'requesterUserId']) expect(raw).not.toContain(bad);
  });
});
