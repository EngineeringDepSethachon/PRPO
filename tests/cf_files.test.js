// @vitest-environment node
// P5 phase 2 : GET /api/files/:id (authenticated download proxy). onRequest + migrated sqlite + mocked Google (token / metadata / alt=media).
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { _resetDriveCache } from '../functions/_lib/drive.js';
import { sanitizeWriteBody } from '../functions/_lib/sanitize.js';
import { _resetScanThrottle } from '../functions/_lib/filerefs.js';
import { MAX_DOWNLOADS_PER_HOUR, MAX_DOWNLOAD_BYTES_PER_HOUR, DOWNLOAD_WINDOW_MS, contentDisposition, safeContentType } from '../functions/_lib/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0007_attachments_upload.sql', '0008_ws3_hardening.sql', '0009_upload_attempts.sql', '0010_token_version.sql', '0011_file_refs.sql', '0013_attachments_storage.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const ROOT = 'ROOTFOLDER1234567890';
const FOLDER = 'FOLDERPD1234567890ab';

const PERSONAS = {
  PD: { id: 'U-PD', username: 'req.pd', name: 'Req PD', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  QC: { id: 'U-QC', username: 'req.qc', name: 'Req QC', department: 'QC', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 },
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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let pem;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

describe('files.js pure helpers', () => {
  it('safeContentType : allow-list only (image/jpg -> image/jpeg)', () => {
    expect(safeContentType('image/png')).toBe('image/png');
    expect(safeContentType('image/jpg')).toBe('image/jpeg');
    expect(safeContentType('Application/PDF; charset=x')).toBe('application/pdf');
    expect(safeContentType('text/html')).toBeNull();
    expect(safeContentType('image/svg+xml')).toBeNull();
    expect(safeContentType('')).toBeNull();
  });
  it('contentDisposition : no quote / CRLF / path, ASCII fallback + RFC 5987 filename*', () => {
    const h = contentDisposition('inline', 'ใบเสนอ"ราคา\r\n../x;y.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('inline; filename="')).toBe(true);
    const ascii = h.match(/filename="([^"]*)"/)[1];
    expect(ascii).toMatch(/^[\x20-\x7e]+$/); // eslint-disable-line no-control-regex
    expect(ascii).not.toMatch(/["\\/;]/);
    expect(h).toMatch(/filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(h).toContain('%E0%B9%83'); // Thai percent-encoded as UTF-8
  });
});

describe.skipIf(!DatabaseSync)('GET /api/files/:id (onRequest + migrated sqlite + mocked Google)', () => {
  let sdb; let env; let gcalls; let driveFiles; let pulls; const tokens = {};

  function installGoogle() {
    gcalls = [];
    pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      url = String(url); gcalls.push(url);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return jres({ access_token: 'tok', expires_in: 3600 });
      const m = url.match(/\/drive\/v3\/files\/([^?]+)\?(.*)$/);
      if (!m) return jres({}, 404);
      const f = driveFiles[decodeURIComponent(m[1])];
      if (!f) return jres({ error: { message: 'File not found: SECRET' } }, 404);
      if (m[2].includes('alt=media')) {
        if (f.mediaStatus) return jres({ error: { message: 'SECRET google detail' } }, f.mediaStatus);
        const bytes = f.bytes || PNG;
        let sent = false;
        const stream = new ReadableStream({ pull(c) { pulls++; if (sent) c.close(); else { sent = true; c.enqueue(bytes); } } }, { highWaterMark: 0 });
        return new Response(stream, { status: 200, headers: { 'Content-Type': f.mimeType || 'image/png', 'Content-Length': String(bytes.length) } });
      }
      return jres({ id: m[1], mimeType: f.mimeType || 'image/png', size: String((f.bytes || PNG).length), parents: f.parents || [FOLDER], trashed: Boolean(f.trashed) });
    }));
  }

  const get = async (who, p, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method: 'GET', headers }), env });
    return res;
  };
  const mediaCalls = () => gcalls.filter((u) => u.includes('alt=media')).length;

  const addPo = (poNumber, dept) => sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES (?,?,?,'ORDERED','[]')").run(`id-${poNumber}`, poNumber, dept);
  const addPr = (prNumber, dept, attachmentsJson = '[]') => sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES (?,?,?,'DRAFT','[]',?)").run(`id-${prNumber}`, prNumber, dept, attachmentsJson);
  const addAtt = (fileId, o = {}) => sdb.prepare(`INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, poNumber, docNo, docType, folderId, folderPath, uploadedBy, uploaderId, docRef, createdAtMs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`ATT-${fileId}`, fileId, o.fileName ?? 'photo 1.png', o.mimeType ?? 'image/png', 12, o.category ?? 'GRN', o.docRef ?? '', o.docRef ?? '', 'X',
    o.folderId ?? FOLDER, '03_GRN_Evidence/2026-10', 'u', o.uploaderId ?? 'U-PD', o.docRef ?? '', Date.now());

  const FID = 'FILEID1234567890abcd';

  beforeEach(async () => {
    _resetDriveCache();
    _resetScanThrottle();
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    addPo('PO-PD-2026-001', 'PD');
    addAtt(FID, { docRef: 'PO-PD-2026-001' });
    driveFiles = { [FID]: {} };
    installGoogle();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('401 without a token, nothing reaches Google', async () => {
    const res = await get(null, `/api/files/${FID}`);
    expect(res.status).toBe(401);
    expect(gcalls.length).toBe(0);
  });

  it('owner department : 200, streamed, safe headers', async () => {
    const res = await get('PD', `/api/files/${FID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toMatch(/^private/);
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="photo 1.png"; filename*=UTF-8\'\'photo%201.png');
    expect(res.headers.get('Content-Length')).toBe(String(PNG.length));
    expect(pulls).toBe(0); // the upstream body was handed over, not read into memory
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual(Array.from(PNG));
    expect(pulls).toBeGreaterThan(0);
    // the Drive call asks for the content only, with the service account token (never the user's)
    const media = gcalls.find((u) => u.includes('alt=media'));
    expect(media).toContain(`/files/${FID}?alt=media`);
  });

  it('other department : 404 (same as a missing file) and Drive content is never requested', async () => {
    const res = await get('QC', `/api/files/${FID}`);
    expect(res.status).toBe(404);
    const missing = await get('QC', '/api/files/DOESNOTEXIST123456789');
    expect(missing.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
    expect(mediaCalls()).toBe(0);
  });

  it('admin sees it', async () => {
    expect((await get('ADMIN', `/api/files/${FID}`)).status).toBe(200);
  });

  it('a Drive id that is not in attachments (not a project file) : 404 without any Google call', async () => {
    driveFiles.OTHERFILE1234567890xy = {};
    const res = await get('ADMIN', '/api/files/OTHERFILE1234567890xy');
    expect(res.status).toBe(404);
    expect(gcalls.length).toBe(0);
  });

  it('file bound to no existing document : only its uploader (while it has no document)', async () => {
    addAtt('ORPHAN1234567890abcdef', { docRef: '', category: 'PR', uploaderId: 'U-PD' });
    driveFiles.ORPHAN1234567890abcdef = {};
    expect((await get('QC', '/api/files/ORPHAN1234567890abcdef')).status).toBe(404);
    expect((await get('PD', '/api/files/ORPHAN1234567890abcdef')).status).toBe(200);
    // row points at a document that does not exist -> nobody but... nobody (not even the uploader)
    addAtt('DANGLING234567890abcdef', { docRef: 'PO-NOPE', uploaderId: 'U-PD' });
    driveFiles.DANGLING234567890abcdef = {};
    expect((await get('PD', '/api/files/DANGLING234567890abcdef')).status).toBe(404);
  });

  it('file stored on a PR the caller can see (attached before the PR had a number)', async () => {
    addAtt('EMBEDDED234567890abcde', { docRef: '', category: 'PR', uploaderId: 'U-QC' });
    driveFiles.EMBEDDED234567890abcde = {};
    addPr('PR-PD-2026-001', 'PD', JSON.stringify([{ fileId: 'EMBEDDED234567890abcde', name: 'x.png' }]));
    expect((await get('PD', '/api/files/EMBEDDED234567890abcde')).status).toBe(200);
    sdb.prepare('DELETE FROM prs').run();
    addPr('PR-QC-2026-001', 'QC', JSON.stringify([{ fileId: 'EMBEDDED234567890abcde' }]));
    expect((await get('PD', '/api/files/EMBEDDED234567890abcde')).status).toBe(404);
  });

  it('IDOR : an id typed into free text (extraJson.note / item description) of the caller\'s own PR grants nothing', async () => {
    addAtt('FOREIGN1234567890abcdef', { docRef: '', category: 'PR', uploaderId: 'U-PD' }); // PD file, no document yet
    driveFiles.FOREIGN1234567890abcdef = {};
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, extraJson) VALUES ('id-QC1','PR-QC-1','QC','DRAFT',?, '[]', ?)")
      .run(JSON.stringify([{ name: 'x', description: 'see FOREIGN1234567890abcdef' }]), JSON.stringify({ note: 'FOREIGN1234567890abcdef' }));
    expect((await get('QC', '/api/files/FOREIGN1234567890abcdef')).status).toBe(404);
    expect(mediaCalls()).toBe(0);
    // many decoy documents must not push a real holder out of the candidate page
    for (let i = 0; i < 70; i++) sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, extraJson) VALUES (?,?, 'QC','DRAFT','[]',?)").run(`d${i}`, `PR-D-${i}`, JSON.stringify({ note: 'FOREIGN1234567890abcdef' }));
    _resetScanThrottle();
    addPr('PR-PD-REAL', 'PD', JSON.stringify([{ fileId: 'FOREIGN1234567890abcdef', name: 'real.png' }]));
    expect((await get('PD', '/api/files/FOREIGN1234567890abcdef')).status).toBe(200);
    expect((await get('QC', '/api/files/FOREIGN1234567890abcdef')).status).toBe(404);
  });

  it('a row bound to a document is decided by that document only (another department\'s PR holding the id does not help)', async () => {
    addPr('PR-QC-HOLD', 'QC', JSON.stringify([{ fileId: FID, name: 'copy.png' }]));
    expect((await get('QC', `/api/files/${FID}`)).status).toBe(404);
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(200);
  });

  it('download byte ceiling per user : 429 once the hour is used up', async () => {
    const bucket = Math.floor(Date.now() / DOWNLOAD_WINDOW_MS) * DOWNLOAD_WINDOW_MS;
    sdb.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?,?,?)').run('dlb:U-PD', bucket, MAX_DOWNLOAD_BYTES_PER_HOUR);
    const res = await get('PD', `/api/files/${FID}`);
    expect(res.status).toBe(429);
    expect(mediaCalls()).toBe(0);
  });

  it('type comes from our allow-list : a stored html type becomes octet-stream + attachment', async () => {
    addAtt('HTMLFILE234567890abcdef', { docRef: 'PO-PD-2026-001', mimeType: 'text/html', fileName: 'evil.html' });
    driveFiles.HTMLFILE234567890abcdef = { mimeType: 'text/html', bytes: new TextEncoder().encode('<script>alert(1)</script>') };
    const res = await get('PD', '/api/files/HTMLFILE234567890abcdef');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('office files are always attachments ; ?download=1 forces attachment for images / PDF', async () => {
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    addAtt('SHEETFILE34567890abcdef', { docRef: 'PO-PD-2026-001', mimeType: XLSX, fileName: 'q.xlsx' });
    driveFiles.SHEETFILE34567890abcdef = { mimeType: XLSX };
    const x = await get('PD', '/api/files/SHEETFILE34567890abcdef');
    expect(x.headers.get('Content-Type')).toBe(XLSX);
    expect(x.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    await x.arrayBuffer();
    const d = await get('PD', `/api/files/${FID}?download=1`);
    expect(d.status).toBe(200);
    expect(d.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    await d.arrayBuffer();
    addAtt('PDFFILE1234567890abcdef', { docRef: 'PO-PD-2026-001', mimeType: 'application/pdf', fileName: 'q.pdf' });
    driveFiles.PDFFILE1234567890abcdef = { mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4') };
    const p = await get('PD', '/api/files/PDFFILE1234567890abcdef');
    expect(p.headers.get('Content-Type')).toBe('application/pdf');
    expect(p.headers.get('Content-Disposition')).toMatch(/^inline;/);
    await p.arrayBuffer();
  });

  it('file name with quotes / CRLF / Thai never breaks the header', async () => {
    addAtt('NAMEDFILE34567890abcdef', { docRef: 'PO-PD-2026-001', fileName: 'ใบ"เสนอ\r\nราคา.png' });
    driveFiles.NAMEDFILE34567890abcdef = {};
    const res = await get('PD', '/api/files/NAMEDFILE34567890abcdef');
    const cd = res.headers.get('Content-Disposition');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toMatch(/filename\*=UTF-8''/);
    expect(cd.match(/filename="([^"]*)"/)[1]).not.toContain('"');
    await res.arrayBuffer();
  });

  it('Drive side checks : wrong parent folder, trashed, missing, too big -> 404 ; Drive errors -> 502 without Google details', async () => {
    driveFiles[FID] = { parents: ['SOMEOTHERFOLDER123456'] };
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(404);
    driveFiles[FID] = { trashed: true };
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(404);
    driveFiles[FID] = { bytes: { length: 21 * 1024 * 1024 } };
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(404);
    delete driveFiles[FID];
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(404);
    driveFiles[FID] = { mediaStatus: 500 };
    const res = await get('PD', `/api/files/${FID}`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('SECRET');
  });

  it('Drive not configured -> 503', async () => {
    env.GOOGLE_SA_PRIVATE_KEY = '';
    const res = await get('PD', `/api/files/${FID}`);
    expect(res.status).toBe(503);
  });

  it('rate limit per user (own counter, uploads are not affected)', async () => {
    const bucket = Math.floor(Date.now() / DOWNLOAD_WINDOW_MS) * DOWNLOAD_WINDOW_MS;
    sdb.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?,?,?)').run('dl:U-PD', bucket, MAX_DOWNLOADS_PER_HOUR);
    expect((await get('PD', `/api/files/${FID}`)).status).toBe(429);
    expect(mediaCalls()).toBe(0);
    const up = sdb.prepare("SELECT n FROM upload_attempts WHERE userId = 'U-PD'").get();
    expect(up).toBeUndefined();
  });

  it('malformed / traversal ids : 404 or 400, never reach Google', async () => {
    expect((await get('PD', '/api/files/short')).status).toBe(404);
    expect((await get('PD', '/api/files/..%2f..%2fetc')).status).toBe(400);
    expect((await get('PD', '/api/files/a.b.c.d.e.f.g.h.i.j.k')).status).toBe(404);
    expect(gcalls.length).toBe(0);
  });

  it('write side uses the same rule : an id taken from a note cannot be attached ; a really held one can', async () => {
    const QC_USER = { userId: 'U-QC', department: 'QC', allowedDepartments: '["QC"]', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 };
    const ID = 'NOTEONLY1234567890abcdef';
    addAtt(ID, { docRef: '', category: 'PR', uploaderId: 'U-PD' });
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, extraJson) VALUES ('id-QCN','PR-QC-N','QC','DRAFT','[]',?)").run(JSON.stringify({ note: `${ID}` }));
    const mk = () => ({ attachments: [{ fileId: ID, id: ID, url: `https://drive.google.com/file/d/${ID}/view` }] });
    const b1 = mk();
    await sanitizeWriteBody(env.DB, b1, QC_USER);
    expect(b1.attachments[0].url).toBe('');
    expect(b1.attachments[0].fileId).toBe('');
    // the same id really held as a file by a QC PR : allowed
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-QCH','PR-QC-H','QC','DRAFT','[]',?)").run(JSON.stringify([{ fileId: ID, name: 'a.png' }]));
    _resetScanThrottle();
    const b2 = mk();
    await sanitizeWriteBody(env.DB, b2, QC_USER);
    expect(b2.attachments[0].fileId).toBe(ID);
  });

  // ---- round 2 : one definition of "file position" on both sides, file_refs index, binding, PR -> PO, delete ----
  const post = async (who, p, body, method = 'POST') => {
    const text = JSON.stringify(body);
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) }, body: text }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const dbOne = (q, ...p) => sdb.prepare(q).get(...p);
  const FX = ['FOREIGNAAAAAAAAAAAAAAAAAAA1', 'FOREIGNAAAAAAAAAAAAAAAAAAA2', 'FOREIGNAAAAAAAAAAAAAAAAAAA3', 'FOREIGNAAAAAAAAAAAAAAAAAAA4'];
  const dUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

  it('write + read agree : imageUrl / photo / settlementProofUrl / bare id of another department\'s file are cleared when saved, so they open nothing', async () => {
    for (const id of FX) { addAtt(id, { docRef: 'PO-PD-2026-001', uploaderId: 'U-PD' }); driveFiles[id] = {}; }
    const r = await post('QC', '/api/prs', {
      id: 'PR-ATK', department: 'QC', status: 'DRAFT',
      items: [{ name: 'x', imageUrl: dUrl(FX[0]) }],
      attachments: [{ name: 'p', photo: FX[1] }],
      settlementProofUrl: dUrl(FX[2]),
      images: [{ name: 'b', claimPhoto: FX[3] }]
    });
    expect(r.status).toBe(200);
    const stored = sdb.prepare("SELECT itemsJson, attachmentsJson, extraJson FROM prs WHERE id = 'PR-ATK'").get();
    const blob = `${stored.itemsJson}${stored.attachmentsJson}${stored.extraJson}`;
    for (const id of FX) {
      expect(blob).not.toContain(id);
      expect((await get('QC', `/api/files/${id}`)).status).toBe(404);
      expect(dbOne('SELECT COUNT(*) AS n FROM file_refs WHERE fileId = ?', id).n).toBe(0);
    }
    expect(mediaCalls()).toBe(0);
    // ... and the owner department can still use its own file in those fields
    const ok = await post('PD', '/api/prs', { id: 'PR-OWN', department: 'PD', status: 'DRAFT', items: [{ name: 'x', imageUrl: dUrl(FX[0]) }] });
    expect(ok.status).toBe(200);
    expect(sdb.prepare("SELECT itemsJson FROM prs WHERE id = 'PR-OWN'").get().itemsJson).toContain(FX[0]);
    expect(dbOne("SELECT COUNT(*) AS n FROM file_refs WHERE fileId = ? AND docTable = 'prs'", FX[0]).n).toBe(1);
  });

  it('fileIdsIn : counts the file positions (imageUrl, photo, settlementProofUrl, bare id, attachment objects) and nothing typed as free text', async () => {
    const { fileIdsIn } = await import('../functions/_lib/sanitize.js');
    const A = 'ZZZZZZZZZZZZZZZZZZZZZZZZZ1'; const B = 'ZZZZZZZZZZZZZZZZZZZZZZZZZ2'; const C = 'ZZZZZZZZZZZZZZZZZZZZZZZZZ3'; const D = 'ZZZZZZZZZZZZZZZZZZZZZZZZZ4'; const N = 'ZZZZZZZZZZZZZZZZZZZZZZZZZ5';
    const ids = fileIdsIn(JSON.stringify({ items: [{ imageUrl: dUrl(A), description: N }], attachments: [{ photo: B }], settlementProofUrl: dUrl(C), grAttachments: [{ fileId: D }], note: N }));
    expect([...ids].sort()).toEqual([A, B, C, D]);
    expect(fileIdsIn('{"photo":"BASE64_ATTACHMENT_STORED_IN_DRIVE"}').size).toBe(0);
  });

  it('saving a PR binds the saver\'s unbound uploads it holds ; other users\' uploads and files it does not hold stay unbound', async () => {
    addAtt('MYUPLOAD1234567890abcdefg', { docRef: '', category: 'PR', uploaderId: 'U-PD' });
    addAtt('NOTHELD1234567890abcdefgh', { docRef: '', category: 'PR', uploaderId: 'U-PD' });
    addAtt('OTHERS1234567890abcdefghi', { docRef: '', category: 'PR', uploaderId: 'U-QC' });
    const r = await post('PD', '/api/prs', { id: 'PR-BIND', department: 'PD', status: 'DRAFT', items: [], attachments: [{ fileId: 'MYUPLOAD1234567890abcdefg', name: 'a.png' }] });
    expect(r.status).toBe(200);
    const no = sdb.prepare("SELECT prNumber FROM prs WHERE id = 'PR-BIND'").get().prNumber;
    const docRef = (id) => sdb.prepare('SELECT docRef, docNo FROM attachments WHERE fileId = ?').get(id);
    expect(docRef('MYUPLOAD1234567890abcdefg')).toEqual({ docRef: no, docNo: no });
    expect(docRef('NOTHELD1234567890abcdefgh').docRef).toBe('');
    expect(docRef('OTHERS1234567890abcdefghi').docRef).toBe('');
    driveFiles.MYUPLOAD1234567890abcdefg = {};
    expect((await get('QC', '/api/files/MYUPLOAD1234567890abcdefg')).status).toBe(404);
    expect((await get('PD', '/api/files/MYUPLOAD1234567890abcdefg')).status).toBe(200);
  });

  it('PR -> PO : a file bound to a PR opens for whoever may use the PO that names that PR and holds the file ; an unrelated PO gives nothing', async () => {
    const F = 'PRFILE12345678901234567890';
    driveFiles[F] = {};
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('id-PRQ','QC001/2026','QC','APPROVED','[]')").run();
    addAtt(F, { docRef: 'QC001/2026', category: 'PR', uploaderId: 'U-QC' });
    expect((await get('PD', `/api/files/${F}`)).status).toBe(404);
    // unrelated PD PO holding the id : nothing
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-POX','PO-PD-X','OTHER/2026','PD','ORDERED','[]',?)").run(JSON.stringify({ prAttachments: [{ fileId: F }] }));
    _resetScanThrottle();
    expect((await get('PD', `/api/files/${F}`)).status).toBe(404);
    // the PO that really comes from QC001/2026 (made for PD)
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-POY','PO-PD-Y','QC001/2026','PD','ORDERED','[]',?)").run(JSON.stringify({ prAttachments: [{ fileId: F }] }));
    _resetScanThrottle();
    expect((await get('PD', `/api/files/${F}`)).status).toBe(200);
  });

  it('deleting a PR drops its index rows and marks its attachments ; a PR is matched by its number only', async () => {
    const r = await post('PD', '/api/prs', { id: 'PR-DEL', department: 'PD', status: 'DRAFT', items: [], attachments: [{ fileId: FID, name: 'a.png' }] });
    expect(r.status).toBe(200);
    const row = sdb.prepare("SELECT id, prNumber FROM prs WHERE id = 'PR-DEL'").get();
    addAtt('PRBYID12345678901234567890', { docRef: row.id, category: 'PR', uploaderId: 'U-PD' }); // docRef = the PR id, not its number
    driveFiles.PRBYID12345678901234567890 = {};
    expect((await get('PD', '/api/files/PRBYID12345678901234567890')).status).toBe(404);
    addAtt('PRBYNO12345678901234567890', { docRef: row.prNumber, category: 'PR', uploaderId: 'U-PD' });
    driveFiles.PRBYNO12345678901234567890 = {};
    expect((await get('PD', '/api/files/PRBYNO12345678901234567890')).status).toBe(200);
    expect(dbOne("SELECT COUNT(*) AS n FROM file_refs WHERE docId = 'PR-DEL'").n).toBeGreaterThan(0);
    const del = await post('ADMIN', '/api/prs/PR-DEL', {}, 'DELETE');
    expect(del.status).toBe(200);
    expect(dbOne("SELECT COUNT(*) AS n FROM file_refs WHERE docId = 'PR-DEL'").n).toBe(0);
    expect(dbOne('SELECT docGone FROM attachments WHERE fileId = ?', 'PRBYNO12345678901234567890').docGone).toBe(1);
    expect((await get('PD', '/api/files/PRBYNO12345678901234567890')).status).toBe(404);
  });

  it('documents saved before the index existed are found by the bounded scan, indexed, and the scan is throttled', async () => {
    const F = 'LEGACY12345678901234567890';
    driveFiles[F] = {};
    addAtt(F, { docRef: '', category: 'PR', uploaderId: 'U-QC' });
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-LEG','PD009/2026','PD','DRAFT','[]',?)").run(JSON.stringify([{ fileId: F }]));
    expect(dbOne('SELECT COUNT(*) AS n FROM file_refs WHERE fileId = ?', F).n).toBe(0);
    expect((await get('PD', `/api/files/${F}`)).status).toBe(200);
    expect(dbOne('SELECT COUNT(*) AS n FROM file_refs WHERE fileId = ?', F).n).toBe(1); // self-healed
    sdb.prepare("UPDATE prs SET attachmentsJson = '[]' WHERE id = 'id-LEG'").run(); // the index row is now stale : it grants nothing
    expect((await get('PD', `/api/files/${F}`)).status).toBe(404);
    expect(dbOne('SELECT COUNT(*) AS n FROM file_refs WHERE fileId = ?', F).n).toBe(0);
  });

  it('only GET is served', async () => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev/api/files/${FID}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.PD}`, 'Content-Type': 'application/json' }, body: '{}' }), env });
    expect(res.status).not.toBe(200);
    expect(mediaCalls()).toBe(0);
  });
});
