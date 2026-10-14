// @vitest-environment node
// QA (prae) : R2 file with a uuid fileId, attached to a PR through the same payload the client builds (cfAttachments.uploadAttachmentsForCloudflare),
// must stay openable through /api/files/:id after the PR is saved, for the owner department / admin, and stay hidden from other departments.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { fileIdsIn, fileRefOf } from '../functions/_lib/sanitize.js';
import { FILE_ID_RE } from '../functions/_lib/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = fs.readdirSync(path.join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const UUID = 'a1b2c3d4-0000-4000-8000-000000000001';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, o = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      store.set(key, { bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
      return { key, size: bytes.length };
    },
    async head(key) { const v = store.get(key); return v ? { key, size: v.bytes.length, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata } : null; },
    async get(key) { const v = store.get(key); return v ? { key, size: v.bytes.length, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata, body: new Response(v.bytes).body } : null; },
    async delete(key) { store.delete(key); }
  };
}

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.all()); return o; } };
}

const PERSONAS = {
  PD: { id: 'U-PD', username: 'req.pd', name: 'Req PD', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  QC: { id: 'U-QC', username: 'req.qc', name: 'Req QC', department: 'QC', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};

describe('uuid fileId regexes (pure)', () => {
  it('FILE_ID_RE accepts a 36-char uuid and rejects traversal / short ids', () => {
    expect(FILE_ID_RE.test(UUID)).toBe(true);
    expect(FILE_ID_RE.test('../etc/passwd')).toBe(false);
    expect(FILE_ID_RE.test('short')).toBe(false);
  });
  it('fileIdsIn finds the uuid in an attachment object (fileId position) ; fileRefOf takes a bare uuid and the exact proxy path only', () => {
    expect([...fileIdsIn([{ fileId: UUID, name: 'a.png', url: '' }], 'attachments')]).toContain(UUID);
    expect(fileRefOf(UUID)).toBe(UUID);
    expect(fileRefOf(`/api/files/${UUID}`)).toBe(UUID);
    expect(fileRefOf(`/api/files/${UUID}?download=1`)).toBe(UUID);
    for (const bad of [`/api/files/${UUID}/x`, `/api/files/../${UUID}`, `//evil.com/api/files/${UUID}`, `https://evil.com/api/files/${UUID}`, `/api/files/${UUID}?x=1`, '/api/files/short']) expect(fileRefOf(bad), bad).toBe('');
  });
});

describe.skipIf(!DatabaseSync)('R2 uuid file : upload -> save PR -> open', () => {
  let sdb; let env; let bucket; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const req = (who, method, p, body) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    if (text !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(text)); }
    return onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers, body: text }), env });
  };

  beforeAll(() => {});
  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(here, '..', 'migrations', f), 'utf8'));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    bucket = fakeBucket();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, FILES: bucket };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('new PR (no number yet) : upload as PR category, save PR with the client-shaped attachment, file still opens for PD + admin, not for QC', async () => {
    const up = await req('PD', 'POST', '/api/upload', {
      base64Data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png', fileName: 'a.png', category: 'PR', department: 'PD'
    });
    const uj = await up.json();
    expect(up.status).toBe(200);
    expect(uj.fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(uj.fileUrl).toBe(`/api/files/${uj.fileId}`);

    // same shape as cfAttachments.uploadAttachmentsForCloudflare output
    const att = {
      id: uj.attachmentId, fileId: uj.fileId, name: uj.fileName, fileName: uj.fileName, size: uj.fileSize, type: uj.mimeType, mimeType: uj.mimeType,
      url: uj.fileUrl, previewUrl: uj.directUrl || uj.fileUrl, viewUrl: uj.viewUrl, directUrl: '', lh3Url: '', downloadUrl: uj.downloadUrl, folderPath: uj.folderPath
    };
    const save = await req('PD', 'POST', '/api/prs', { id: 'PR-R2', department: 'PD', status: 'DRAFT', items: [], attachments: [att] });
    expect(save.status).toBe(200);

    const stored = rows("SELECT attachmentsJson FROM prs WHERE id = 'PR-R2' OR prNumber = 'PR-R2'");
    expect(stored.length).toBe(1);
    const parsed = JSON.parse(stored[0].attachmentsJson || '[]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].fileId).toBe(uj.fileId); // the uuid must survive sanitize

    expect((await req('PD', 'GET', `/api/files/${uj.fileId}`)).status).toBe(200);
    expect((await req('ADMIN', 'GET', `/api/files/${uj.fileId}`)).status).toBe(200);
    expect((await req('QC', 'GET', `/api/files/${uj.fileId}`)).status).toBe(404);
  });

  it('a document that references the R2 file by its /api/files/<id> URL only : the URL is kept, file_refs finds it, the file is not an orphan ; another department\'s copy of the URL is cut', async () => {
    const up = await req('PD', 'POST', '/api/upload', {
      base64Data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png', fileName: 'a.png', category: 'PR', department: 'PD'
    });
    const uj = await up.json();
    const url = `/api/files/${uj.fileId}`;
    const save = await req('PD', 'POST', '/api/prs', { id: 'PR-URL', department: 'PD', status: 'DRAFT', items: [{ name: 'x', imageUrl: url, images: [url] }], attachments: [] });
    expect(save.status).toBe(200);
    const items = JSON.parse(rows("SELECT itemsJson FROM prs WHERE id = 'PR-URL' OR prNumber = 'PR-URL'")[0].itemsJson);
    expect(items[0].imageUrl).toBe(url);
    expect(items[0].images).toEqual([url]);
    expect(rows('SELECT * FROM file_refs WHERE fileId = ?', uj.fileId).length).toBeGreaterThan(0);
    // old enough to be a candidate : only the document reference keeps it from being an orphan
    sdb.prepare('UPDATE attachments SET createdAtMs = ?').run(Date.now() - 3 * 24 * 3600 * 1000);
    const dry = await (await req('ADMIN', 'POST', '/api/admin/cleanup-orphans', {})).json();
    expect(dry.orphans.map((o) => o.fileId)).not.toContain(uj.fileId);
    expect((await req('PD', 'GET', url)).status).toBe(200);
    // QC cannot attach PD's file by writing its URL into a QC document
    const bad = await req('QC', 'POST', '/api/prs', { id: 'PR-QCURL', department: 'QC', status: 'DRAFT', items: [{ name: 'y', imageUrl: url, images: [url] }], attachments: [] });
    expect(bad.status).toBeLessThan(500);
    const qrows = rows("SELECT itemsJson FROM prs WHERE id = 'PR-QCURL' OR prNumber = 'PR-QCURL'");
    for (const r of qrows) expect(r.itemsJson).not.toContain(uj.fileId);
    expect((await req('QC', 'GET', url)).status).toBe(404);
    // other shapes are still cut
    const odd = await req('PD', 'POST', '/api/prs', { id: 'PR-ODD', department: 'PD', status: 'DRAFT', items: [{ name: 'z', imageUrl: `https://evil.example${url}`, images: [`${url}/x`, `//evil.example${url}`] }], attachments: [] });
    expect(odd.status).toBeLessThan(500);
    const oddItems = JSON.parse(rows("SELECT itemsJson FROM prs WHERE id = 'PR-ODD' OR prNumber = 'PR-ODD'")[0].itemsJson);
    expect(oddItems[0].imageUrl).toBe('');
    expect(oddItems[0].images).toEqual([]);
  });
});
