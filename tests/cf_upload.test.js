// @vitest-environment node
// T2.1c : POST /api/upload (Google Drive via Service Account, all Google calls mocked) + T2.3 data-URL guard
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { classifyUnhandled } from '../functions/_lib/routes.js';
import { _resetDriveCache } from '../functions/_lib/drive.js';
import { hasOversizedDataUrl, MAX_JSON_BYTES, MAX_UPLOADS_PER_HOUR, MAX_FILES_PER_DOC, MAX_DATA_URL_CHARS } from '../functions/_lib/upload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0007_attachments_upload.sql', '0008_ws3_hardening.sql', '0009_upload_attempts.sql', '0010_token_version.sql', '0013_attachments_storage.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const ROOT = 'ROOTFOLDER1234567890';

const PERSONAS = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L1QC: { id: 'U-QC', username: 'req.qc', name: 'ReqQC', department: 'QC', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 },
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
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.all()); return o; } };
}
const jres = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const b64Of = (arr) => Buffer.from(arr).toString('base64');

let pem;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

describe('T2.3 data URL guard (pure)', () => {
  it('flags only big data: strings, deep', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_DATA_URL_CHARS);
    expect(hasOversizedDataUrl({ items: [{ images: [{ url: big }] }] })).toBe(true);
    expect(hasOversizedDataUrl([{ attachments: [big] }])).toBe(true);
    expect(hasOversizedDataUrl({ a: 'data:image/jpeg;base64,AAAA' })).toBe(false);
    expect(hasOversizedDataUrl({ a: 'x'.repeat(MAX_DATA_URL_CHARS + 10) })).toBe(false); // not a data URL (e.g. long note)
    expect(hasOversizedDataUrl({ a: 'https://drive.google.com/thumbnail?id=abc' })).toBe(false);
    expect(hasOversizedDataUrl(null)).toBe(false);
  });
  it('route table serves POST /api/upload only', () => {
    expect(classifyUnhandled('GET', '/api/upload').status).toBe(405);
    expect(classifyUnhandled('POST', '/api/upload').status).toBe(404); // reaches the fallback only if the handler did not answer
  });
});

describe.skipIf(!DatabaseSync)('POST /api/upload (onRequest + migrated sqlite + mocked Google)', () => {
  let sdb; let env; let gcalls; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));

  function installGoogle({ failUpload = false, failToken = false } = {}) {
    gcalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); gcalls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return failToken ? jres({ error: 'invalid_grant' }, 400) : jres({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/upload/drive/v3/files')) return failUpload ? jres({ error: { message: 'SECRET google detail' } }, 500) : jres({ id: 'FILEID1234567890abcd' });
      if (url.includes('/permissions')) return jres({ id: 'perm' });
      if ((init.method || 'GET') === 'GET') return jres({ files: [] });
      return jres({ id: `FOLDER${gcalls.length}ABCDEFGH` });
    }));
  }

  // opts.length : Content-Length header (default = real byte length) ; null = omit
  const upload = async (who, body, opts = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'Content-Type': opts.contentType || 'application/json' };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    const len = opts.length === undefined ? Buffer.byteLength(text) : opts.length;
    if (len !== null) headers['Content-Length'] = String(len);
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/upload', { method: 'POST', headers, body: text }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const goodBody = (extra = {}) => ({
    base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'damaged 1.png',
    category: '03_GRN_Evidence', poNumber: 'PO-PD-2026-001', docNo: 'PO-PD-2026-001', docType: 'GRN_EVIDENCE', ...extra
  });
  const addPo = (poNumber, dept, status = 'ORDERED') =>
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES (?,?,?,?,'[]')").run(`id-${poNumber}`, poNumber, dept, status);

  beforeEach(async () => {
    _resetDriveCache();
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, FILE_STORAGE: 'drive', GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    addPo('PO-PD-2026-001', 'PD');
    installGoogle();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('401 without token and nothing reaches Google', async () => {
    const r = await upload(null, goodBody());
    expect(r.status).toBe(401);
    expect(gcalls.length).toBe(0);
  });

  it('GRN evidence: uploads into 03_GRN_Evidence/{YYYY-MM}/{PO}, writes attachments, returns server URLs', async () => {
    const r = await upload('L1', goodBody());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      success: true, fileId: 'FILEID1234567890abcd', mimeType: 'image/png', fileName: 'damaged 1.png',
      directUrl: 'https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200',
      fileUrl: 'https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200',
      viewUrl: 'https://drive.google.com/file/d/FILEID1234567890abcd/view'
    });
    expect(r.json.folderPath).toMatch(/^03_GRN_Evidence\/\d{4}-\d{2}\/PO-PD-2026-001$/);
    // google: token, then 3 folder lookups + 3 creates, upload (no permission call : files are not shared publicly)
    const urls = gcalls.map((c) => c.url);
    expect(urls[0]).toContain('oauth2.googleapis.com/token');
    expect(urls.filter((u) => u.includes('/upload/drive/v3/files')).length).toBe(1);
    expect(urls.filter((u) => u.includes('/permissions')).length).toBe(0);
    const att = rows('SELECT * FROM attachments');
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ fileId: 'FILEID1234567890abcd', uploaderId: 'U-L1', docRef: 'PO-PD-2026-001', category: 'GRN', mimeType: 'image/png', fileSize: PNG.length, sharedPublic: 0 });
    expect(att[0].createdAtMs).toBeGreaterThan(0);
    expect(JSON.stringify(att[0])).not.toContain('base64');
    expect(rows("SELECT * FROM audit_logs WHERE action = 'FILE_UPLOAD'")).toHaveLength(1);
  });

  it('document permission: other department PO -> 403, unknown PO -> 404, admin may', async () => {
    addPo('PO-QC-2026-001', 'QC');
    expect((await upload('L1', goodBody({ poNumber: 'PO-QC-2026-001', docNo: 'PO-QC-2026-001' }))).status).toBe(403);
    expect((await upload('L1', goodBody({ poNumber: 'PO-NOPE', docNo: 'PO-NOPE' }))).status).toBe(404);
    expect((await upload('L1', goodBody({ poNumber: '', docNo: '' }))).status).toBe(400);
    expect(gcalls.length).toBe(0);
    expect((await upload('ADMIN', goodBody({ poNumber: 'PO-QC-2026-001', docNo: 'PO-QC-2026-001' }))).status).toBe(200);
  });

  it('category rules: PO docs need a real PO ; GRN on a cancelled PO -> 409 ; bad category -> 400', async () => {
    expect((await upload('L1', goodBody({ category: 'PO' }))).json.folderPath).toMatch(/^02_PO_Documents\/\d{4}-\d{2}$/);
    addPo('PO-PD-CANCEL', 'PD', 'CANCELLED');
    expect((await upload('L1', goodBody({ poNumber: 'PO-PD-CANCEL', docNo: 'PO-PD-CANCEL' }))).status).toBe(409);
    expect((await upload('L1', goodBody({ category: 'CLAIM', poNumber: 'PO-PD-CANCEL', docNo: 'PO-PD-CANCEL' }))).json.folderPath).toMatch(/^04_Claim_Evidence\/\d{4}-\d{2}\/PO-PD-CANCEL$/);
    expect((await upload('L1', goodBody({ category: 'BACKUPS' }))).status).toBe(400);
  });

  it('PR attachment before the PR exists : own department only, no number in the folder', async () => {
    const own = await upload('L1', goodBody({ category: 'PR', poNumber: '', docNo: '' }));
    expect(own.status).toBe(200);
    expect(own.json.folderPath).toMatch(/^01_PR_Attachments\/\d{4}-\d{2}$/);
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: '', docNo: '', department: 'QC' }))).status).toBe(403);
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: '', docNo: '', department: 'ALL' }))).status).toBe(403);
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: 'PD999/2026' }))).status).toBe(404); // a number that is not a PR
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('PR-1','PD001/2026','PD','DRAFT','[]')").run();
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(200);
    expect((await upload('L1QC', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(403);
    // a PR whose content is locked (approved) takes no more files, except from an admin
    sdb.prepare("UPDATE prs SET status = 'SUBMITTED' WHERE id = 'PR-1'").run(); // requester (level 1) can no longer edit a submitted PR
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(403);
    sdb.prepare("UPDATE prs SET status = 'APPROVED' WHERE id = 'PR-1'").run();
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(403);
    expect((await upload('ADMIN', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(200);
    sdb.prepare("UPDATE prs SET status = 'DRAFT' WHERE id = 'PR-1'").run();
    expect((await upload('L1', goodBody({ category: 'PR', poNumber: 'PD001/2026' }))).status).toBe(200);
  });

  it('attempt counter (migration 0009) runs before the body is read and counts rejected requests', async () => {
    for (let i = 0; i < 3; i++) await upload('L1', 'not json', { length: 8 }); // 400 each
    await upload('L1', goodBody(), { length: null });                          // 413
    await upload('L1', goodBody({ mimeType: 'text/html' }));                    // 415
    const n = () => rows("SELECT n FROM upload_attempts WHERE userId = 'U-L1'").reduce((s, r) => s + r.n, 0);
    expect(n()).toBe(5);
    sdb.exec("UPDATE upload_attempts SET n = 120 WHERE userId = 'U-L1'");
    const r = await upload('L1', 'garbage that is never parsed', { length: 5 });
    expect(r.status).toBe(429);
    expect(n()).toBe(121);
    expect((await upload('ADMIN', goodBody())).status).toBe(200); // other users unaffected
    // counter unavailable -> fail closed
    sdb.exec('DROP TABLE upload_attempts');
    expect((await upload('L1', goodBody())).status).toBe(503);
  });

  it('413 before parsing : Content-Length over the limit or missing ; base64 string too long even if the header lies', async () => {
    expect((await upload('L1', goodBody(), { length: MAX_JSON_BYTES + 1 })).status).toBe(413);
    expect((await upload('L1', goodBody(), { length: null })).status).toBe(413);
    const huge = JSON.stringify(goodBody({ base64Data: 'A'.repeat(Math.ceil(20 * 1048576 / 3) * 4 + 4) }));
    expect((await upload('L1', huge, { length: 100 })).status).toBe(413);
    expect(gcalls.length).toBe(0);
  });

  it('415 : wrong content type, mime not allowed, magic bytes not matching ; nothing sent to Google', async () => {
    expect((await upload('L1', goodBody(), { contentType: 'text/plain' })).status).toBe(415);
    expect((await upload('L1', goodBody({ mimeType: 'text/html' }))).status).toBe(415);
    const exe = await upload('L1', goodBody({ base64Data: b64Of([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) }));
    expect(exe.status).toBe(415);
    expect((await upload('L1', goodBody({ base64Data: '!!!notbase64' }))).status).toBe(400);
    expect(gcalls.length).toBe(0);
    expect(rows('SELECT * FROM attachments')).toHaveLength(0);
  });

  it('data URL header in base64Data is accepted', async () => {
    const r = await upload('L1', goodBody({ base64Data: `data:image/png;base64,${b64Of(PNG)}`, mimeType: undefined }));
    expect(r.status).toBe(200);
  });

  it('429 per user per hour and per document', async () => {
    const ins = sdb.prepare("INSERT INTO attachments (id, fileId, category, docRef, uploaderId, createdAtMs) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) ins.run(`A${i}`, `F${i}`, 'PO', 'OTHER', 'U-L1', Date.now() - 1000);
    expect((await upload('L1', goodBody())).status).toBe(429);
    expect((await upload('ADMIN', goodBody())).status).toBe(200); // other users unaffected
    sdb.exec('DELETE FROM attachments');
    for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) ins.run(`B${i}`, `F${i}`, 'PO', 'OTHER', 'U-L1', Date.now() - 2 * 3600 * 1000); // old rows do not count
    expect((await upload('L1', goodBody())).status).toBe(200);
    sdb.exec('DELETE FROM attachments');
    for (let i = 0; i < MAX_FILES_PER_DOC; i++) ins.run(`C${i}`, `F${i}`, 'GRN', 'PO-PD-2026-001', `U-${i}`, Date.now() - 10 * 3600 * 1000);
    const r = await upload('L1', goodBody());
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('RATE_LIMITED');
  });

  it('errors go through publicError : not configured 503, Google failure 502 without Google details or secrets', async () => {
    env = { ...env, GOOGLE_SA_PRIVATE_KEY: '' };
    const a = await upload('L1', goodBody());
    expect(a.status).toBe(503);
    expect(a.json.code).toBe('DRIVE_NOT_CONFIGURED');
    expect(JSON.stringify(a.json)).not.toMatch(/GOOGLE_SA|PRIVATE/);
    env = { ...env, GOOGLE_SA_PRIVATE_KEY: pem };
    _resetDriveCache();
    installGoogle({ failUpload: true });
    const b = await upload('L1', goodBody());
    expect(b.status).toBe(502);
    expect(JSON.stringify(b.json)).not.toMatch(/SECRET|google detail/i);
    expect(rows('SELECT * FROM attachments')).toHaveLength(0);
    _resetDriveCache();
    installGoogle({ failToken: true });
    expect((await upload('L1', goodBody())).status).toBe(502);
  });

  it('console never receives the request body or the token', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installGoogle({ failUpload: true });
    await upload('L1', goodBody());
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain(b64Of(PNG));
    expect(logged).not.toContain(tokens.L1);
    expect(logged).not.toMatch(/BEGIN PRIVATE|google detail/i);
    spy.mockRestore();
  });

  it('T2.3 : PR / PO writes with a big embedded data: image are rejected (413) ; Drive URLs are fine', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_DATA_URL_CHARS + 1);
    const call = async (method, p, body) => {
      const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens.ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
      return res.status;
    };
    expect(await call('POST', '/api/prs', { department: 'PD', items: [{ name: 'x', images: [{ url: big }] }] })).toBe(413);
    expect(await call('PUT', '/api/prs/PR-1', { attachments: [big] })).toBe(413);
    expect(await call('POST', '/api/pos', { department: 'PD', evidence: { photos: [big] } })).toBe(413);
    expect(await call('PUT', '/api/pos/x', { evidence: big })).toBe(413);
    expect(await call('POST', '/api/pos/x/receive', { items: [{ photo: big }] })).toBe(413);
    expect(await call('POST', '/api/prs', { department: 'PD', items: [{ name: 'x', images: [{ url: 'https://drive.google.com/thumbnail?id=abc&sz=w1200' }] }] })).not.toBe(413);
    expect(rows('SELECT * FROM prs')).toHaveLength(1); // only the Drive-URL one was stored
    expect(rows('SELECT attachmentsJson, itemsJson FROM prs').map((r) => r.itemsJson).join('')).not.toContain('data:image');
  });
});
