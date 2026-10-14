// @vitest-environment node
// File storage adapters (docs/requirements-file-storage.md, stage A) : R2 + Drive adapters against a fake R2Bucket, and upload / files / orphans / unshare
// with the two storages mixed. Nothing remote is contacted (Google is a stubbed fetch, R2 is an in-memory fake).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { _resetDriveCache } from '../functions/_lib/drive.js';
import { _resetScanThrottle } from '../functions/_lib/filerefs.js';
import { getStorage, getStorageFor, refOfRow } from '../functions/_lib/storage/index.js';
import { createR2Adapter } from '../functions/_lib/storage/r2.js';
import { createDriveAdapter } from '../functions/_lib/storage/drive-adapter.js';
import { buildObjectKey, isSafeObjectKey, publicError, sha256Hex } from '../functions/_lib/storage/common.js';
import * as driveCompat from '../functions/_lib/drive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = fs.readdirSync(path.join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const ROOT = 'ROOTFOLDER1234567890';
const FOLDER = 'FOLDERPD1234567890ab';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const b64Of = (arr) => Buffer.from(arr).toString('base64');
const DAY = 24 * 3600 * 1000;

// ---------- fake R2Bucket : put / head / get / delete (no copy, like the real binding) ----------
function fakeBucket(opts = {}) {
  const store = new Map();
  const calls = [];
  const meta = (key, v) => ({ key, size: v.bytes.length, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata });
  return {
    store, calls, opts,
    async put(key, value, o = {}) {
      calls.push(['put', key]);
      if (opts.failPut && opts.failPut(key)) throw new Error('R2 boom prpo-files');
      let bytes;
      if (value instanceof Uint8Array) bytes = value;
      else bytes = new Uint8Array(await new Response(value).arrayBuffer());
      if (opts.truncatePut && opts.truncatePut(key)) bytes = bytes.slice(0, bytes.length - 1); // size will not match
      store.set(key, { bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
      return meta(key, store.get(key));
    },
    async head(key) { calls.push(['head', key]); if (opts.failHead) throw new Error('boom'); const v = store.get(key); return v ? meta(key, v) : null; },
    async get(key) {
      calls.push(['get', key]);
      if (opts.failGet) throw new Error('boom');
      const v = store.get(key);
      return v ? { ...meta(key, v), body: new Response(v.bytes).body } : null;
    },
    async delete(key) { calls.push(['delete', key]); if (opts.failDelete && opts.failDelete(key)) throw new Error('boom'); store.delete(key); }
  };
}
const seed = (bucket, key, bytes = PNG, mime = 'image/png') => bucket.store.set(key, { bytes, httpMetadata: { contentType: mime }, customMetadata: { name: 'p.png', mimeType: mime } });

let pem;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

describe('storage/common.js : object key', () => {
  const base = { category: 'GRN', docRef: 'PO-PD-2026-001', date: new Date('2026-10-13T05:00:00Z'), fileId: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'damaged 1.png' };
  it('<category>/<YYYY>/<MM>/<docRef>/<fileId>__<name> (month in Bangkok time)', () => {
    expect(buildObjectKey(base)).toBe('03_GRN_Evidence/2026/10/PO-PD-2026-001/a1b2c3d4-0000-4000-8000-000000000001__damaged_1.png');
  });
  it('no docRef -> _unassigned ; category only from the allow-list', () => {
    expect(buildObjectKey({ ...base, docRef: '' })).toContain('/_unassigned/');
    expect(buildObjectKey({ ...base, category: '03_GRN_Evidence' }).startsWith('03_GRN_Evidence/')).toBe(true);
    for (const bad of ['../x', 'RANDOM', '', 'PR/../..', null]) expect(() => buildObjectKey({ ...base, category: bad })).toThrow(/VALIDATION_ERROR/);
  });
  it('hostile docRef / name never produce "..", a slash inside a part, a backslash, control characters or a long key', () => {
    const hostile = [
      { docRef: '../../etc/passwd', name: '..\\..\\x/../evil.png' },
      { docRef: '..', name: '..' },
      { docRef: 'a/b\\c\u0000d‮', name: 'x\r\n/../../y.png' },
      { docRef: 'D'.repeat(5000), name: 'N'.repeat(5000) + '.png' },
      { docRef: 'ใบสั่งซื้อ/../ก', name: 'ไฟล์/../ข.png' }
    ];
    for (const h of hostile) {
      const key = buildObjectKey({ ...base, ...h });
      expect(isSafeObjectKey(key), key).toBe(true);
      expect(key.split('/')).toHaveLength(5);          // category / yyyy / mm / docRef / file : the hostile text added no segment
      expect(key).not.toMatch(/\.\.|\\/);
      expect(key.length).toBeLessThanOrEqual(700);
    }
  });
  it('Thai names keep their vowels / tone marks and the key stays within 1000 UTF-8 bytes', () => {
    const k = buildObjectKey({ ...base, docRef: 'ใบสั่งซื้อ-๑', name: 'ใบเสนอราคา ที่ ๑.pdf' });
    expect(k).toContain('ใบสั่งซื้อ-๑');
    expect(k.endsWith('__ใบเสนอราคา_ที่_๑.pdf')).toBe(true);
    const long = buildObjectKey({ ...base, docRef: 'ก'.repeat(500), name: 'ข้อความยาว'.repeat(200) + '.png' });
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(1000);
    expect(isSafeObjectKey(long)).toBe(true);
    expect(long.endsWith('.png')).toBe(true);
    expect(isSafeObjectKey('ก'.repeat(400))).toBe(false); // 1200 bytes
  });
  it('isSafeObjectKey rejects traversal / empty parts / absolute / control / too long', () => {
    for (const bad of ['', '/a/b', 'a//b', 'a/../b', 'a/./b', '../a', 'a\\b', 'a\u0001b', 'a/b/', 'x'.repeat(701), null, 5]) expect(isSafeObjectKey(bad), String(bad)).toBe(false);
    expect(isSafeObjectKey('01_PR_Attachments/2026/10/_unassigned/id__file.png')).toBe(true);
  });
});

describe('R2 adapter (fake bucket)', () => {
  let bucket; let r2;
  const input = (o = {}) => ({ name: 'damaged 1.png', mimeType: 'image/png', bytes: PNG, category: 'GRN', docRef: 'PO-PD-2026-001', uploaderId: 'U-PD', date: new Date('2026-10-13T05:00:00Z'), ...o });
  beforeEach(() => { bucket = fakeBucket(); r2 = createR2Adapter({ FILES: bucket }); });

  it('put : key, customMetadata (sha256 + size + name, mimeType, uploaderId, docRef, category, uploadedAt), contentType, proxy URLs only', async () => {
    const up = await r2.put(input());
    expect(up).toMatchObject({ storage: 'r2', size: PNG.length, mimeType: 'image/png', name: 'damaged 1.png' });
    expect(up.fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(up.objectKey).toBe(`03_GRN_Evidence/2026/10/PO-PD-2026-001/${up.fileId}__damaged_1.png`);
    const stored = bucket.store.get(up.objectKey);
    expect(Array.from(stored.bytes)).toEqual(Array.from(PNG));
    expect(stored.httpMetadata).toEqual({ contentType: 'image/png' });
    expect(stored.customMetadata).toEqual({
      name: 'damaged 1.png', mimeType: 'image/png', uploaderId: 'U-PD', docRef: 'PO-PD-2026-001', category: 'GRN',
      uploadedAt: '2026-10-13T05:00:00.000Z', sha256: await sha256Hex(PNG), size: String(PNG.length)
    });
    for (const u of [up.viewUrl, up.directUrl, up.downloadUrl, up.webViewLink, r2.publicUrl(up)]) expect(u).toBe(`/api/files/${up.fileId}`);
    expect(up.sharedPublic).toBe(false);
    expect(JSON.stringify(up)).not.toMatch(/https?:/);
  });

  it('put keeps the shared validation : wrong magic bytes / type / empty / too large -> nothing stored', async () => {
    await expect(r2.put(input({ bytes: new Uint8Array([1, 2, 3, 4]) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(r2.put(input({ mimeType: 'text/html' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(r2.put(input({ bytes: new Uint8Array(0) }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(r2.put(input({ category: 'EVIL' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(bucket.store.size).toBe(0);
  });

  it('put failure -> STORAGE_ERROR (502) without the R2 message ; size mismatch -> STORAGE_ERROR and the bad object is removed', async () => {
    bucket = fakeBucket({ failPut: () => true }); r2 = createR2Adapter({ FILES: bucket });
    const e1 = await r2.put(input()).catch((e) => e);
    expect(e1.code).toBe('STORAGE_ERROR');
    expect(String(e1.message)).not.toMatch(/prpo-files|boom/);
    expect(publicError(e1).status).toBe(502);
    bucket = fakeBucket({ truncatePut: () => true }); r2 = createR2Adapter({ FILES: bucket });
    await expect(r2.put(input())).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(bucket.store.size).toBe(0);
  });

  it('head / open : metadata, stream, missing -> exists:false / null ; unsafe or foreign keys are treated as missing', async () => {
    const up = await r2.put(input());
    const ref = { fileId: up.fileId, objectKey: up.objectKey, storage: 'r2' };
    expect(await r2.head(ref)).toMatchObject({ exists: true, size: PNG.length, mimeType: 'image/png', name: 'damaged 1.png', trashed: false });
    const o = await r2.open(ref);
    expect(o).toMatchObject({ size: PNG.length, mimeType: 'image/png' });
    expect(Array.from(new Uint8Array(await new Response(o.body).arrayBuffer()))).toEqual(Array.from(PNG));
    for (const k of ['', null, '../x', 'a//b', `trash/${up.objectKey}`, '01_PR_Attachments/2026/10/_unassigned/nothere__x.png']) {
      const r = { fileId: up.fileId, objectKey: k, storage: 'r2' };
      expect((await r2.head(r)).exists).toBe(false);
      expect(await r2.open(r)).toBeNull();
      expect(await r2.trash(r)).toBe(false);
    }
  });

  it('trash / untrash : get -> put (streamed) to trash/<key> -> verify -> delete the source ; and back ; content + metadata preserved', async () => {
    const up = await r2.put(input());
    const ref = { fileId: up.fileId, objectKey: up.objectKey, storage: 'r2' };
    bucket.calls.length = 0;
    expect(await r2.trash(ref)).toBe(true);
    expect(bucket.store.has(up.objectKey)).toBe(false);
    const moved = bucket.store.get(`trash/${up.objectKey}`);
    expect(Array.from(moved.bytes)).toEqual(Array.from(PNG));
    expect(moved.customMetadata.sha256).toBe(await sha256Hex(PNG));
    expect(moved.httpMetadata.contentType).toBe('image/png');
    // the delete of the source comes after the put AND the verification head of the copy
    const seq = bucket.calls.map((c) => c.join(' '));
    const iPut = seq.indexOf(`put trash/${up.objectKey}`);
    const iHead = seq.lastIndexOf(`head trash/${up.objectKey}`); // the first head (before the put) is the "never overwrite" check
    const iDel = seq.indexOf(`delete ${up.objectKey}`);
    expect(iPut).toBeGreaterThanOrEqual(0);
    expect(iHead).toBeGreaterThan(iPut);
    expect(iDel).toBeGreaterThan(iHead);
    expect(await r2.head(ref)).toMatchObject({ exists: false, trashed: true, inFolder: true });
    expect(await r2.trash(ref)).toBe(true); // idempotent : already in trash
    expect(await r2.untrash(ref)).toBe(true);
    expect(Array.from(bucket.store.get(up.objectKey).bytes)).toEqual(Array.from(PNG));
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(false);
    expect(await r2.head(ref)).toMatchObject({ exists: true, trashed: false });
    // the only deletes ever issued are sources of verified moves
    expect(bucket.calls.filter((c) => c[0] === 'delete').map((c) => c[1]).sort()).toEqual([up.objectKey, `trash/${up.objectKey}`].sort());
  });

  it('a failure half way never loses the file : put fails / copy size differs / delete of the source fails', async () => {
    const up = await r2.put(input());
    const ref = { fileId: up.fileId, objectKey: up.objectKey, storage: 'r2' };
    // 1. put to trash/ fails -> false, source untouched, no delete of the source
    bucket.opts.failPut = (k) => k.startsWith('trash/');
    bucket.calls.length = 0;
    expect(await r2.trash(ref)).toBe(false);
    expect(Array.from(bucket.store.get(up.objectKey).bytes)).toEqual(Array.from(PNG));
    expect(bucket.calls.some((c) => c[0] === 'delete' && c[1] === up.objectKey)).toBe(false);
    // 2. the copy has another size -> false, the bad copy is removed, source untouched
    bucket.opts.failPut = null; bucket.opts.truncatePut = (k) => k.startsWith('trash/');
    expect(await r2.trash(ref)).toBe(false);
    expect(bucket.store.has(up.objectKey)).toBe(true);
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(false);
    // 3. verified copy but the source cannot be deleted -> false, both copies exist (nothing lost), a retry succeeds
    bucket.opts.truncatePut = null; bucket.opts.failDelete = (k) => k === up.objectKey;
    expect(await r2.trash(ref)).toBe(false);
    expect(bucket.store.has(up.objectKey)).toBe(true);
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(true);
    bucket.opts.failDelete = null;
    expect(await r2.trash(ref)).toBe(true);
    expect(bucket.store.has(up.objectKey)).toBe(false);
    // untrash with a failing put leaves the trashed object where it is
    bucket.opts.failPut = (k) => k === up.objectKey;
    expect(await r2.untrash(ref)).toBe(false);
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(true);
    // get throws -> false, nothing changed
    bucket.opts.failPut = null; bucket.opts.failGet = true;
    expect(await r2.untrash(ref)).toBe(false);
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(true);
  });

  it('move verifies sha256 too, and never overwrites a different object at the destination', async () => {
    const up = await r2.put(input());
    const ref = { fileId: up.fileId, objectKey: up.objectKey, storage: 'r2' };
    // a different object already sits at trash/<key> : the move stops, both stay as they are
    bucket.store.set(`trash/${up.objectKey}`, { bytes: PNG, httpMetadata: { contentType: 'image/png' }, customMetadata: { sha256: 'deadbeef', size: String(PNG.length) } });
    expect(await r2.trash(ref)).toBe(false);
    expect(bucket.store.has(up.objectKey)).toBe(true);
    expect(bucket.store.get(`trash/${up.objectKey}`).customMetadata.sha256).toBe('deadbeef');
    bucket.store.delete(`trash/${up.objectKey}`);
    // the copy comes back with another sha256 (same size) : bad copy removed, source stays
    const origPut = bucket.put.bind(bucket);
    bucket.put = async (k, v, o) => origPut(k, v, k.startsWith('trash/') ? { ...o, customMetadata: { ...o.customMetadata, sha256: 'other' } } : o);
    expect(await r2.trash(ref)).toBe(false);
    expect(bucket.store.has(up.objectKey)).toBe(true);
    expect(bucket.store.has(`trash/${up.objectKey}`)).toBe(false);
  });

  it('makePrivate : nothing to do, reported as ALWAYS_PRIVATE', async () => {
    expect(await r2.makePrivate({ fileId: 'x' })).toMatchObject({ skipped: 'ALWAYS_PRIVATE' });
  });

  it('no binding -> STORAGE_NOT_CONFIGURED (503), message without bucket / binding names', () => {
    for (const env of [{}, { FILES: null }, { FILES: {} }]) {
      let err;
      try { createR2Adapter(env); } catch (e) { err = e; }
      expect(err.code).toBe('STORAGE_NOT_CONFIGURED');
      const pub = publicError(err);
      expect(pub.status).toBe(503);
      expect(JSON.stringify(pub) + err.message).not.toMatch(/prpo-files|FILES|bucket/i);
    }
  });
});

describe('storage/index.js : selection', () => {
  it('getStorage : default r2 ; r2 / drive (any case, trimmed) ; unknown value = not configured (no silent fallback)', () => {
    const FILES = fakeBucket();
    expect(getStorage({ FILES }).storage).toBe('r2');
    expect(getStorage({ FILES, FILE_STORAGE: '' }).storage).toBe('r2');
    expect(getStorage({ FILES, FILE_STORAGE: ' R2 ' }).storage).toBe('r2');
    expect(getStorage({ FILE_STORAGE: 'Drive' }).storage).toBe('drive');
    expect(() => getStorage({ FILES, FILE_STORAGE: 's3' })).toThrow(/STORAGE_NOT_CONFIGURED/);
    expect(() => getStorage({ FILE_STORAGE: 'r2' })).toThrow(/STORAGE_NOT_CONFIGURED/);
    expect(() => getStorage({})).toThrow(/STORAGE_NOT_CONFIGURED/);
  });
  it('getStorageFor : decided by the ROW, never by env.FILE_STORAGE ; unknown storage / R2 row without key -> null', () => {
    const FILES = fakeBucket();
    expect(getStorageFor({ fileId: 'F', storage: 'drive', folderId: 'x' }, { FILES, FILE_STORAGE: 'r2' }).storage).toBe('drive');
    expect(getStorageFor({ fileId: 'F', storage: 'r2', objectKey: 'a/b' }, { FILES, FILE_STORAGE: 'drive' }).storage).toBe('r2');
    expect(getStorageFor({ fileId: 'F' }, { FILES }).storage).toBe('drive'); // row from before migration 0013
    expect(getStorageFor({ fileId: 'F', storage: 'ipfs', objectKey: 'a' }, { FILES })).toBeNull();
    expect(getStorageFor({ fileId: 'F', storage: 'r2', objectKey: '' }, { FILES })).toBeNull();
    expect(getStorageFor({ fileId: 'F', storage: 'r2', objectKey: '   ' }, { FILES })).toBeNull();
    expect(getStorageFor({ fileId: 'F', storage: 'r2' }, { FILES })).toBeNull();
    expect(getStorageFor(null, { FILES })).toBeNull();
    expect(refOfRow({ fileId: 'F', storage: 'r2', objectKey: 'k/x', folderId: 'r2' })).toEqual({ fileId: 'F', objectKey: 'k/x', storage: 'r2', folderId: 'r2' });
  });
  it('drive.js still exports the shared names (existing imports keep working)', () => {
    for (const n of ['validateUpload', 'sanitizeFileName', 'publicError', 'ALLOWED_MIME_TYPES', 'MAX_FILE_SIZE_BYTES', 'DRIVE_CATEGORIES', 'DriveError']) expect(driveCompat[n], n).toBeDefined();
    expect(driveCompat.publicError).toBe(publicError);
  });
});

describe('Drive adapter (stubbed Google)', () => {
  let calls; let files;
  beforeEach(() => {
    _resetDriveCache();
    calls = []; files = { DRIVEFILE1234567890: { parents: [FOLDER], perms: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }, { id: 'u1', type: 'user', role: 'writer' }] } };
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); const method = (init.method || 'GET').toUpperCase(); calls.push({ url, method, body: init.body });
      const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return j({ access_token: 'tok', expires_in: 3600 });
      const pm = url.match(/\/files\/([^/?]+)\/permissions(?:\/([^?]+))?/);
      if (pm) {
        const f = files[pm[1]]; if (!f) return j({}, 404);
        if (method === 'DELETE') { f.perms = f.perms.filter((p) => p.id !== pm[2]); return j({}); }
        return j({ permissions: f.perms });
      }
      const m = url.match(/\/drive\/v3\/files\/([^?]+)\?/);
      if (m) {
        const f = files[decodeURIComponent(m[1])]; if (!f) return j({ error: { message: 'nf' } }, 404);
        if (method === 'PATCH') { f.trashed = JSON.parse(init.body).trashed; return j({ id: m[1] }); }
        if (url.includes('alt=media')) return new Response(PNG, { status: 200, headers: { 'Content-Length': String(PNG.length) } });
        return j({ id: m[1], mimeType: 'image/png', size: String(PNG.length), parents: f.parents, trashed: Boolean(f.trashed) });
      }
      return j({}, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const env = () => ({ GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT });
  const ref = { fileId: 'DRIVEFILE1234567890', storage: 'drive', folderId: FOLDER, objectKey: null };

  it('head / open / trash / untrash / makePrivate / publicUrl wrap the existing Drive calls', async () => {
    const d = createDriveAdapter(env());
    expect(await d.head(ref)).toMatchObject({ exists: true, inFolder: true, trashed: false, size: PNG.length });
    expect(await d.head({ ...ref, folderId: 'OTHERFOLDER1234567890' })).toMatchObject({ exists: false, inFolder: false });
    const o = await d.open(ref);
    expect(o.size).toBe(PNG.length);
    await o.body.cancel();
    expect(await d.trash(ref)).toBe(true);
    expect(files.DRIVEFILE1234567890.trashed).toBe(true);
    expect(await d.head(ref)).toMatchObject({ exists: false, trashed: true, inFolder: true });
    expect(await d.untrash(ref)).toBe(true);
    expect(await d.makePrivate(ref)).toEqual({ removed: 1, stillPublic: false });
    expect(files.DRIVEFILE1234567890.perms.map((p) => p.id)).toEqual(['u1']); // only the "anyone" permission was removed
    expect(d.publicUrl(ref)).toBe('https://drive.google.com/file/d/DRIVEFILE1234567890/view');
    await expect(d.head({ ...ref, fileId: 'NOTEXISTING1234567890' })).rejects.toMatchObject({ status: 404 });
  });
  it('without the Service Account : DRIVE_NOT_CONFIGURED (503, original message) and trash never throws', async () => {
    const d = createDriveAdapter({});
    await expect(d.prepare()).rejects.toMatchObject({ code: 'DRIVE_NOT_CONFIGURED' });
    expect(publicError({ code: 'DRIVE_NOT_CONFIGURED' })).toEqual({ status: 503, code: 'DRIVE_NOT_CONFIGURED', message: 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
    expect(await d.trash(ref)).toBe(false);
  });
});

// ---------- routes : upload / files / orphans / unshare with R2 and Drive mixed ----------
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb, hooks = {}) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { if (hooks.failRun && hooks.failRun(q)) throw new Error('db boom'); sdb.prepare(q).run(...norm(p)); return { success: true }; },
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

describe.skipIf(!DatabaseSync)('routes with mixed storage (R2 + Drive)', () => {
  let sdb; let env; let bucket; let gcalls; let driveFiles; const tokens = {};
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));

  function installGoogle() {
    gcalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); const method = (init.method || 'GET').toUpperCase(); gcalls.push({ url, method });
      const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return j({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/upload/drive/v3/files')) return j({ id: 'NEWDRIVEFILE1234567890' });
      const m = url.match(/\/drive\/v3\/files\/([^/?]+)\?/);
      if (m) {
        const f = driveFiles[decodeURIComponent(m[1])]; if (!f) return j({ error: { message: 'nf' } }, 404);
        if (method === 'PATCH') { f.trashed = JSON.parse(init.body).trashed; return j({ id: m[1] }); }
        if (url.includes('alt=media')) return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) } });
        return j({ id: m[1], mimeType: 'image/png', size: String(PNG.length), parents: f.parents || [FOLDER], trashed: Boolean(f.trashed) });
      }
      if (method === 'GET') return j({ files: [] });
      return j({ id: `FOLDER${gcalls.length}ABCDEFGH` });
    }));
  }

  const req = (who, method, p, body, extra = {}) => {
    const text = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { ...(extra.headers || {}) };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    if (text !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(text)); }
    return onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers, body: text }), env: extra.env || env });
  };
  const upload = (who, o = {}) => req(who, 'POST', '/api/upload', {
    base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'damaged 1.png', category: '03_GRN_Evidence',
    poNumber: 'PO-PD-2026-001', docNo: 'PO-PD-2026-001', docType: 'GRN_EVIDENCE', ...o
  });
  const addAtt = (fileId, o = {}) => sdb.prepare(`INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, poNumber, docNo, docType, folderId, folderPath, uploadedBy, uploaderId, docRef, createdAtMs, sharedPublic, storage, objectKey)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`ATT-${fileId}`, fileId, o.fileName ?? 'p.png', 'image/png', PNG.length, o.category ?? 'GRN', o.docRef ?? '', o.docRef ?? '', 'X',
    o.folderId ?? (o.storage === 'r2' ? 'r2' : FOLDER), 'x', 'u', o.uploaderId ?? 'U-PD', o.docRef ?? '', o.createdAtMs ?? Date.now(), o.sharedPublic ?? 0, o.storage ?? 'drive', o.objectKey ?? null);

  beforeEach(async () => {
    _resetDriveCache(); _resetScanThrottle();
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    bucket = fakeBucket();
    // FILE_STORAGE is NOT set : the default must be r2
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, FILES: bucket, GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('id-PO1','PO-PD-2026-001','PD','ORDERED','[]')").run();
    driveFiles = { DRIVEFILE1234567890: {} };
    installGoogle();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('migration 0013 : existing rows default to drive, new columns exist, no DROP', () => {
    const sql = readRel('migrations', '0013_attachments_storage.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).toMatch(/ADD COLUMN storage TEXT NOT NULL DEFAULT 'drive'/);
    sdb.prepare("INSERT INTO attachments (id, fileId, fileName) VALUES ('A1','OLDFILE1234567890','x.png')").run();
    expect(sdb.prepare("SELECT storage, objectKey, migratedFrom FROM attachments WHERE id = 'A1'").get()).toMatchObject({ storage: 'drive', objectKey: null, migratedFrom: null });
    expect(rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_attachments_storage'")).toHaveLength(1);
  });

  it('upload (default storage = r2) : object in the bucket, row storage/objectKey, proxy URLs, no Google call ; the file is read back through /api/files/:id', async () => {
    const res = await upload('PD');
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ success: true, mimeType: 'image/png', fileName: 'damaged 1.png', fileSize: PNG.length, sharedPublic: false });
    expect(j.fileUrl).toBe(`/api/files/${j.fileId}`);
    expect(j.viewUrl).toBe(`/api/files/${j.fileId}`);
    expect(j.folderPath).toMatch(/^03_GRN_Evidence\/\d{4}\/\d{2}\/PO-PD-2026-001$/);
    expect(gcalls).toHaveLength(0);
    const att = rows('SELECT * FROM attachments');
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ fileId: j.fileId, storage: 'r2', uploaderId: 'U-PD', docRef: 'PO-PD-2026-001', category: 'GRN', fileSize: PNG.length, sharedPublic: 0, folderId: 'r2' });
    expect(att[0].objectKey).toMatch(new RegExp(`^03_GRN_Evidence/\\d{4}/\\d{2}/PO-PD-2026-001/${j.fileId}__damaged_1\\.png$`));
    expect(bucket.store.has(att[0].objectKey)).toBe(true);
    expect(JSON.parse(rows("SELECT details FROM audit_logs WHERE action = 'FILE_UPLOAD'")[0].details)).toMatchObject({ storage: 'r2', fileId: j.fileId });

    const ok = await req('PD', 'GET', `/api/files/${j.fileId}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(ok.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(ok.headers.get('Cache-Control')).toMatch(/^private/);
    expect(ok.headers.get('Content-Length')).toBe(String(PNG.length));
    expect(ok.headers.get('Content-Disposition')).toMatch(/^inline; filename="damaged 1\.png"/);
    expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual(Array.from(PNG));
    expect(await (await req('PD', 'GET', `/api/files/${j.fileId}?download=1`)).headers.get('Content-Disposition')).toMatch(/^attachment;/);
    // P5 rules unchanged : other department 404 (same body as a missing file), admin may, no token 401
    const other = await req('QC', 'GET', `/api/files/${j.fileId}`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await (await req('QC', 'GET', '/api/files/DOESNOTEXIST123456789')).json());
    expect((await req('ADMIN', 'GET', `/api/files/${j.fileId}`)).status).toBe(200);
    expect((await req(null, 'GET', `/api/files/${j.fileId}`)).status).toBe(401);
    expect(gcalls).toHaveLength(0);
  });

  it('upload permission / validation rules are unchanged with r2 (other department 403, unknown PO 404, bad content 415) and nothing is stored', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('id-PO2','PO-QC-2026-001','QC','ORDERED','[]')").run();
    expect((await upload('PD', { poNumber: 'PO-QC-2026-001', docNo: 'PO-QC-2026-001' })).status).toBe(403);
    expect((await upload('PD', { poNumber: 'PO-NOPE', docNo: 'PO-NOPE' })).status).toBe(404);
    expect((await upload('PD', { base64Data: b64Of([1, 2, 3, 4, 5]) })).status).toBe(415);
    expect(bucket.store.size).toBe(0);
    expect(rows('SELECT * FROM attachments')).toHaveLength(0);
  });

  it('client-supplied objectKey / fileId / storage in the upload body are ignored', async () => {
    const j = await (await upload('PD', { objectKey: '../../evil', fileId: 'EVILFILEID1234567890', storage: 'drive', folderId: 'X' })).json();
    const att = rows('SELECT * FROM attachments')[0];
    expect(att.storage).toBe('r2');
    expect(att.fileId).toBe(j.fileId);
    expect(att.fileId).not.toBe('EVILFILEID1234567890');
    expect(att.objectKey).not.toMatch(/evil|\.\./);
  });

  it('docRef / file name with traversal text land inside the document folder only', async () => {
    await upload('PD', { fileName: '../../../x/..\\y.png' });
    const key = rows('SELECT objectKey FROM attachments')[0].objectKey;
    expect(isSafeObjectKey(key)).toBe(true);
    expect(key.split('/')).toHaveLength(5);
  });

  it('D1 insert fails after the put : the object is moved to trash/ (recoverable), not left public, not deleted', async () => {
    env = { ...env, DB: makeD1(sdb, { failRun: (q) => /INSERT INTO attachments/.test(q) }) };
    const res = await upload('PD');
    expect(res.status).toBe(500);
    const keys = [...bucket.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith('trash/03_GRN_Evidence/')).toBe(true);
    const aud = rows("SELECT details FROM audit_logs WHERE action = 'FILE_UPLOAD_ROLLBACK'");
    expect(aud).toHaveLength(1);
    const d = JSON.parse(aud[0].details);
    expect(d).toMatchObject({ storage: 'r2', trashed: true, objectKey: keys[0].slice('trash/'.length) });
    expect(aud[0].details).not.toMatch(/base64|iVBOR/);
  });

  it('FILE_STORAGE=r2 without the FILES binding : 503 with a clear but non-leaking message ; nothing written', async () => {
    const e = { DB: env.DB, AUTH_TOKEN_SECRET: SECRET, FILE_STORAGE: 'r2' };
    const res = await req('PD', 'POST', '/api/upload', { base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'a.png', category: 'GRN', poNumber: 'PO-PD-2026-001', docNo: 'PO-PD-2026-001' }, { env: e });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).code).toBe('STORAGE_NOT_CONFIGURED');
    expect(text).not.toMatch(/prpo-files|FILES|bucket|r2\.dev|binding/i);
    expect(rows('SELECT * FROM attachments')).toHaveLength(0);
    // unset FILE_STORAGE behaves the same (default r2)
    const res2 = await req('PD', 'POST', '/api/upload', { base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'a.png', category: 'GRN', poNumber: 'PO-PD-2026-001' }, { env: { DB: env.DB, AUTH_TOKEN_SECRET: SECRET } });
    expect(res2.status).toBe(503);
  });

  it('FILE_STORAGE=drive without the Service Account : 503 with the original publicError ; unknown value : 503', async () => {
    const res = await upload('PD');
    expect(res.status).toBe(200); // sanity : default works
    const e = { DB: env.DB, AUTH_TOKEN_SECRET: SECRET, FILE_STORAGE: 'drive', FILES: bucket };
    const body = { base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'a.png', category: 'GRN', poNumber: 'PO-PD-2026-001', docNo: 'PO-PD-2026-001' };
    const r1 = await req('PD', 'POST', '/api/upload', body, { env: e });
    expect(r1.status).toBe(503);
    const j1 = await r1.json();
    expect(j1.code).toBe('DRIVE_NOT_CONFIGURED');
    expect(j1.error).toBe('ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
    const r2 = await req('PD', 'POST', '/api/upload', body, { env: { ...e, FILE_STORAGE: 'dropbox' } });
    expect(r2.status).toBe(503);
    expect(rows('SELECT * FROM attachments')).toHaveLength(1);
  });

  it('FILE_STORAGE=drive uploads to Drive and records storage=drive, objectKey NULL (R2 untouched)', async () => {
    const res = await upload('PD', {}, undefined);
    expect(res.status).toBe(200);
    bucket.store.clear();
    const e = { ...env, FILE_STORAGE: 'drive' };
    const r = await req('PD', 'POST', '/api/upload', { base64Data: b64Of(PNG), mimeType: 'image/png', fileName: 'd.png', category: 'GRN', poNumber: 'PO-PD-2026-001', docNo: 'PO-PD-2026-001' }, { env: e });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.fileId).toBe('NEWDRIVEFILE1234567890');
    expect(j.viewUrl).toBe('https://drive.google.com/file/d/NEWDRIVEFILE1234567890/view');
    const att = rows("SELECT * FROM attachments WHERE fileId = 'NEWDRIVEFILE1234567890'")[0];
    expect(att).toMatchObject({ storage: 'drive', objectKey: null, folderPath: expect.stringMatching(/^03_GRN_Evidence\/\d{4}-\d{2}\/PO-PD-2026-001$/) });
    expect(bucket.calls.filter((c) => c[0] === 'put')).toHaveLength(1); // only the first (r2) upload ever touched the bucket
  });

  it('files : each row is read from ITS storage (drive + r2 mixed), whatever FILE_STORAGE says', async () => {
    addAtt('DRIVEFILE1234567890', { docRef: 'PO-PD-2026-001', storage: 'drive' });
    const key = '03_GRN_Evidence/2026/10/PO-PD-2026-001/R2FILE1234567890__p.png';
    seed(bucket, key);
    addAtt('R2FILE1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: key });
    for (const FILE_STORAGE of ['r2', 'drive', undefined]) {
      gcalls.length = 0; bucket.calls.length = 0;
      env = { ...env, FILE_STORAGE };
      const d = await req('PD', 'GET', '/api/files/DRIVEFILE1234567890');
      expect(d.status).toBe(200);
      expect(gcalls.some((c) => c.url.includes('alt=media'))).toBe(true);
      expect(bucket.calls).toHaveLength(0);
      const r = await req('PD', 'GET', '/api/files/R2FILE1234567890');
      expect(r.status).toBe(200);
      expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from(PNG));
      expect(gcalls.some((c) => c.url.includes('R2FILE1234567890'))).toBe(false);
    }
    // an R2 file is readable even when the Drive Service Account is not configured at all
    const bare = { DB: env.DB, AUTH_TOKEN_SECRET: SECRET, FILES: bucket };
    expect((await req('PD', 'GET', '/api/files/R2FILE1234567890', undefined, { env: bare })).status).toBe(200);
  });

  it('files : unknown storage -> 404 ; R2 row with an empty objectKey -> 404 (no fallback to env, no Drive call) ; missing object -> 404 ; trashed object -> 404', async () => {
    addAtt('WEIRDSTORAGE1234567', { docRef: 'PO-PD-2026-001', storage: 'ipfs', objectKey: 'a/b/c' });
    addAtt('EMPTYKEY1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: '' });
    addAtt('NULLKEY12345678901', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: null });
    addAtt('MISSINGOBJ1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: '03_GRN_Evidence/2026/10/PO-PD-2026-001/MISSING__p.png' });
    const tkey = '03_GRN_Evidence/2026/10/PO-PD-2026-001/TRASHED__p.png';
    seed(bucket, `trash/${tkey}`);
    addAtt('TRASHEDOBJ1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: tkey });
    for (const env2 of [env, { ...env, FILE_STORAGE: 'drive' }]) {
      for (const id of ['WEIRDSTORAGE1234567', 'EMPTYKEY1234567890', 'NULLKEY12345678901', 'MISSINGOBJ1234567890', 'TRASHEDOBJ1234567890']) {
        const res = await req('PD', 'GET', `/api/files/${id}`, undefined, { env: env2 });
        expect(res.status, id).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
      }
    }
    expect(gcalls.filter((c) => c.url.includes('/drive/v3/files/'))).toHaveLength(0);
  });

  it('files : R2 binding missing for an R2 row -> 503 without names ; R2 read error -> 502 without details', async () => {
    const key = '03_GRN_Evidence/2026/10/PO-PD-2026-001/R2FILE1234567890__p.png';
    seed(bucket, key);
    addAtt('R2FILE1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: key });
    const noBinding = await req('PD', 'GET', '/api/files/R2FILE1234567890', undefined, { env: { DB: env.DB, AUTH_TOKEN_SECRET: SECRET } });
    const t = await noBinding.text();
    expect(noBinding.status).toBe(503);
    expect(t).not.toMatch(/prpo-files|FILES|bucket/i);
    bucket.opts.failHead = true;
    const broken = await req('PD', 'GET', '/api/files/R2FILE1234567890');
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toMatch(/boom|prpo-files/);
  });

  const OLD = Date.now() - 3 * DAY;
  const callAdmin = (p, body) => req('ADMIN', 'POST', p, body);

  it('orphans : an R2 orphan goes to trash/ (never deleted), the row is closed, restore brings it back ; Drive + R2 in one run', async () => {
    const key = '01_PR_Attachments/2026/09/_unassigned/R2ORPHAN12345678__p.png';
    seed(bucket, key);
    addAtt('R2ORPHAN12345678', { category: 'PR', storage: 'r2', objectKey: key, createdAtMs: OLD });
    addAtt('DRIVEFILE1234567890', { category: 'PR', storage: 'drive', createdAtMs: OLD });
    // dry run : lists both, touches nothing
    const dry = await (await callAdmin('/api/admin/cleanup-orphans', {})).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.orphans.map((o) => o.fileId).sort()).toEqual(['DRIVEFILE1234567890', 'R2ORPHAN12345678']);
    expect(gcalls).toHaveLength(0);
    expect(bucket.calls).toHaveLength(0);

    const res = await callAdmin('/api/admin/cleanup-orphans', { dryRun: false });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.trashed.map((o) => o.fileId).sort()).toEqual(['DRIVEFILE1234567890', 'R2ORPHAN12345678']);
    expect(bucket.store.has(key)).toBe(false);
    expect(bucket.store.has(`trash/${key}`)).toBe(true);
    expect(driveFiles.DRIVEFILE1234567890.trashed).toBe(true);
    expect(gcalls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(rows("SELECT docGone FROM attachments WHERE fileId = 'R2ORPHAN12345678'")[0].docGone).toBe(2);
    // a closed orphan cannot be opened
    expect((await req('PD', 'GET', '/api/files/R2ORPHAN12345678')).status).toBe(404);

    // restore the R2 one
    const back = await callAdmin('/api/admin/restore-orphan', { fileId: 'R2ORPHAN12345678' });
    expect(back.status).toBe(200);
    expect(bucket.store.has(key)).toBe(true);
    expect(bucket.store.has(`trash/${key}`)).toBe(false);
    expect(rows("SELECT docGone FROM attachments WHERE fileId = 'R2ORPHAN12345678'")[0].docGone).toBe(0);
    expect((await req('PD', 'GET', '/api/files/R2ORPHAN12345678')).status).toBe(200);
    // and the Drive one, through its own adapter
    expect((await callAdmin('/api/admin/restore-orphan', { fileId: 'DRIVEFILE1234567890' })).status).toBe(200);
    expect(driveFiles.DRIVEFILE1234567890.trashed).toBe(false);
  });

  it('orphans : a failed move keeps the file and gives the row back ; an object that is gone is reported ; unknown storage is skipped', async () => {
    const key = '01_PR_Attachments/2026/09/_unassigned/R2ORPHAN12345678__p.png';
    seed(bucket, key);
    addAtt('R2ORPHAN12345678', { category: 'PR', storage: 'r2', objectKey: key, createdAtMs: OLD });
    addAtt('R2GONEOBJ1234567890', { category: 'PR', storage: 'r2', objectKey: '01_PR_Attachments/2026/09/_unassigned/GONE__p.png', createdAtMs: OLD - 1 });
    addAtt('WEIRDSTORAGE1234567', { category: 'PR', storage: 'ipfs', objectKey: 'a/b', createdAtMs: OLD - 2 });
    bucket.opts.failPut = (k) => k.startsWith('trash/');
    const j = await (await callAdmin('/api/admin/cleanup-orphans', { dryRun: false })).json();
    const reason = (id) => (j.skipped.find((s) => s.fileId === id) || {}).reason;
    expect(j.trashedCount).toBe(0);
    expect(reason('R2ORPHAN12345678')).toBe('TRASH_FAILED');
    expect(reason('R2GONEOBJ1234567890')).toBe('NOT_IN_DRIVE');
    expect(reason('WEIRDSTORAGE1234567')).toBe('UNKNOWN_STORAGE');
    expect(bucket.store.has(key)).toBe(true);                     // nothing lost
    const g = (id) => rows('SELECT docGone FROM attachments WHERE fileId = ?', id)[0].docGone;
    expect(g('R2ORPHAN12345678')).toBe(0);                        // row handed back
    expect(g('WEIRDSTORAGE1234567')).toBe(0);
    expect(g('R2GONEOBJ1234567890')).toBe(2);                     // already gone : stays closed (same as Drive 404)
  });

  it('orphans : an R2 run does not need the Drive Service Account ; a Drive row without it -> 503 and nothing changes', async () => {
    const key = '01_PR_Attachments/2026/09/_unassigned/R2ORPHAN12345678__p.png';
    seed(bucket, key);
    addAtt('R2ORPHAN12345678', { category: 'PR', storage: 'r2', objectKey: key, createdAtMs: OLD });
    const bare = { DB: env.DB, AUTH_TOKEN_SECRET: SECRET, FILES: bucket };
    const ok = await req('ADMIN', 'POST', '/api/admin/cleanup-orphans', { dryRun: false }, { env: bare });
    expect(ok.status).toBe(200);
    expect(bucket.store.has(`trash/${key}`)).toBe(true);
    addAtt('DRIVEFILE1234567890', { category: 'PR', storage: 'drive', createdAtMs: OLD });
    const no = await req('ADMIN', 'POST', '/api/admin/cleanup-orphans', { dryRun: false }, { env: bare });
    expect(no.status).toBe(503);
    expect(rows("SELECT docGone FROM attachments WHERE fileId = 'DRIVEFILE1234567890'")[0].docGone).toBe(0);
  });

  it('unshare-public : R2 rows are ALWAYS_PRIVATE (no backend call, no Drive credentials needed) ; Drive rows are handled as before', async () => {
    const key = '03_GRN_Evidence/2026/10/PO-PD-2026-001/R2PUBLIC1234567890__p.png';
    seed(bucket, key);
    addAtt('R2PUBLIC1234567890', { docRef: 'PO-PD-2026-001', storage: 'r2', objectKey: key, sharedPublic: 1, createdAtMs: OLD });
    const bare = { DB: env.DB, AUTH_TOKEN_SECRET: SECRET, FILES: bucket };
    const res = await req('ADMIN', 'POST', '/api/admin/unshare-public', { dryRun: false }, { env: bare });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.skipped).toEqual([expect.objectContaining({ fileId: 'R2PUBLIC1234567890', reason: 'ALWAYS_PRIVATE' })]);
    expect(j.unsharedCount).toBe(0);
    expect(bucket.calls).toHaveLength(0);                         // the object was not touched
    expect(bucket.store.has(key)).toBe(true);
    expect(gcalls).toHaveLength(0);
    expect(rows("SELECT sharedPublic FROM attachments WHERE fileId = 'R2PUBLIC1234567890'")[0].sharedPublic).toBe(0);
    // a Drive row with the permission still public in the same table
    addAtt('DRIVEFILE1234567890', { docRef: 'PO-PD-2026-001', storage: 'drive', sharedPublic: 1, createdAtMs: OLD });
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); const method = (init.method || 'GET').toUpperCase();
      const jj = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return jj({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/permissions')) {
        if (method === 'DELETE') { driveFiles.DRIVEFILE1234567890.anyone = false; return jj({}); }
        return jj({ permissions: driveFiles.DRIVEFILE1234567890.anyone === false ? [] : [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] });
      }
      return jj({ id: 'DRIVEFILE1234567890', mimeType: 'image/png', size: '12', parents: [FOLDER], trashed: false });
    }));
    const j2 = await (await callAdmin('/api/admin/unshare-public', { dryRun: false })).json();
    expect(j2.unshared.map((u) => u.fileId)).toEqual(['DRIVEFILE1234567890']);
    expect(rows("SELECT sharedPublic FROM attachments WHERE fileId = 'DRIVEFILE1234567890'")[0].sharedPublic).toBe(0);
  });
});
