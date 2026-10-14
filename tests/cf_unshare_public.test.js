// Close anyone-with-link (user decision 2026-10-13) : POST /api/admin/unshare-public (dry run / act, mocked Google only) and
// POST /api/users without a roleId -> 400. Nothing here talks to a real Drive.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { _resetDriveCache } from '../functions/_lib/drive.js';
import { parseUnshareBody, MAX_PER_RUN } from '../functions/_lib/unshare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = fs.readdirSync(path.join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const ROOT = 'ROOTFOLDER1234567890';
const FOLDER = 'FOLDERPD1234567890ab';

const PERSONAS = {
  PD: { id: 'U-PD', username: 'req.pd', name: 'Req PD', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
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

let pem;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

describe('parseUnshareBody', () => {
  it('dry run unless dryRun === false (boolean) ; limit is clamped', () => {
    for (const b of [undefined, null, {}, [], { dryRun: 'false' }, { dryRun: 0 }, { dryRun: true }, 'x']) expect(parseUnshareBody(b).dryRun).toBe(true);
    expect(parseUnshareBody({ dryRun: false }).dryRun).toBe(false);
    expect(parseUnshareBody({ limit: 100000 }).limit).toBe(MAX_PER_RUN);
    expect(parseUnshareBody({ limit: 3 }).limit).toBe(3);
    expect(parseUnshareBody({}).limit).toBe(MAX_PER_RUN);
  });
});

describe.skipIf(!DatabaseSync)('POST /api/admin/unshare-public and POST /api/users roleId', () => {
  let sdb; let env; let gcalls; let driveFiles; const tokens = {};
  const F = { a: 'PUBLICFILE0123456789a', b: 'PUBLICFILE0123456789b', moved: 'MOVEDFILE0123456789ab', private: 'PRIVATEFILE0123456789', gas: 'GASOLDFILE0123456789ab', noperm: 'NOPERMFILE0123456789a', gone: 'GONEFILE0123456789abc' };

  const addAtt = (fileId, o = {}) => sdb.prepare(`INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, poNumber, docNo, docType, folderId, folderPath, uploadedBy, uploaderId, docRef, createdAtMs, docGone, sharedPublic)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`ATT-${fileId}`, fileId, 'p.png', 'image/png', 12, 'PR', '', '', 'X', o.folderId === undefined ? FOLDER : o.folderId, 'x', 'u', 'U-X', 'PD001/2026', Date.now(), o.docGone ?? 0, o.sharedPublic ?? 1);
  const shared = (id) => sdb.prepare('SELECT sharedPublic FROM attachments WHERE fileId = ?').get(id).sharedPublic;

  function installGoogle() {
    gcalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); const method = (init.method || 'GET').toUpperCase();
      gcalls.push({ url, method, body: init.body });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return jres({ access_token: 'tok', expires_in: 3600 });
      let m = url.match(/\/drive\/v3\/files\/([^/?]+)\/permissions\/([^?]+)\?/);
      if (m && method === 'DELETE') {
        const f = driveFiles[decodeURIComponent(m[1])];
        f.permissions = f.permissions.filter((p) => p.id !== decodeURIComponent(m[2]));
        return new Response(null, { status: 204 });
      }
      m = url.match(/\/drive\/v3\/files\/([^/?]+)\/permissions\?/);
      if (m && method === 'GET') return jres({ permissions: driveFiles[decodeURIComponent(m[1])].permissions });
      m = url.match(/\/drive\/v3\/files\/([^/?]+)\?/);
      if (!m) return jres({}, 404);
      const f = driveFiles[decodeURIComponent(m[1])];
      if (!f) return jres({ error: { message: 'not found' } }, 404);
      return jres({ id: m[1], mimeType: 'image/png', size: '12', parents: f.parents || [FOLDER], trashed: false });
    }));
  }
  const call = (who, body, url = '/api/admin/unshare-public', method = 'POST') => onRequest({
    request: new Request(`https://prpo.pages.dev${url}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env
  });

  beforeEach(async () => {
    _resetDriveCache();
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    addAtt(F.a); addAtt(F.b); addAtt(F.moved); addAtt(F.noperm); addAtt(F.gone);
    addAtt(F.private, { sharedPublic: 0 });          // already private (a new upload)
    addAtt(F.gas, { folderId: '' });                  // not a server upload : no folderId
    driveFiles = {
      [F.a]: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }, { id: 'user1', type: 'user', role: 'writer' }] },
      [F.b]: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] },
      [F.moved]: { parents: ['SOMEOTHERFOLDER1234567'], permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] },
      [F.noperm]: { permissions: [{ id: 'user1', type: 'user', role: 'writer' }] },
      [F.private]: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] },
      [F.gas]: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] }
    };
    installGoogle();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('only an admin : others get 403 and nothing reaches Google ; 401 without a token', async () => {
    expect((await call('PD', {})).status).toBe(403);
    expect((await call('PD', { dryRun: false })).status).toBe(403);
    expect(gcalls.length).toBe(0);
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/admin/unshare-public', { method: 'POST', body: '{}' }), env });
    expect(res.status).toBe(401);
  });

  it('DRY RUN is the default : lists only server uploads still marked public, never calls Google, changes nothing, audits', async () => {
    for (const body of [undefined, {}, { dryRun: true }, { dryRun: 'no' }]) {
      const res = await call('ADMIN', body);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.dryRun).toBe(true);
      expect(j.candidates.map((c) => c.fileId).sort()).toEqual([F.a, F.b, F.moved, F.noperm, F.gone].sort());
      expect(j.candidates.map((c) => c.fileId)).not.toContain(F.gas);
      expect(j.candidates.map((c) => c.fileId)).not.toContain(F.private);
    }
    expect(gcalls.length).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) c FROM attachments WHERE sharedPublic = 1').get().c).toBe(6); // 5 candidates + the legacy row without folderId
    expect(sdb.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'UNSHARE_PUBLIC_DRYRUN'").get().c).toBe(4);
  });

  it('dryRun:false : removes ONLY the anyone permission of files in the project folder, sets sharedPublic = 0, audits every file', async () => {
    const res = await call('ADMIN', { dryRun: false });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.dryRun).toBe(false);
    expect(j.unshared.map((x) => x.fileId).sort()).toEqual([F.a, F.b, F.noperm].sort());
    expect(j.unshared.find((x) => x.fileId === F.a).removedPermissions).toBe(1);
    expect(j.unshared.find((x) => x.fileId === F.noperm).removedPermissions).toBe(0);
    const reasons = Object.fromEntries(j.skipped.map((s) => [s.fileId, s.reason]));
    expect(reasons).toEqual({ [F.moved]: 'NOT_IN_UPLOAD_FOLDER', [F.gone]: 'NOT_IN_DRIVE' });

    // only DELETE of the anyone permission ; the user permission survives ; files outside the project are never touched
    const dels = gcalls.filter((c) => c.method === 'DELETE');
    expect(dels.length).toBe(2);
    for (const d of dels) expect(d.url).toContain('/permissions/anyoneWithLink');
    expect(driveFiles[F.a].permissions).toEqual([{ id: 'user1', type: 'user', role: 'writer' }]);
    expect(driveFiles[F.b].permissions).toEqual([]);
    expect(driveFiles[F.moved].permissions.length).toBe(1);
    expect(driveFiles[F.private].permissions.length).toBe(1);
    expect(driveFiles[F.gas].permissions.length).toBe(1);
    expect(gcalls.some((c) => c.url.includes(F.gas) || c.url.includes(F.private))).toBe(false);
    expect(gcalls.some((c) => c.method === 'POST' && c.url.includes('/permissions'))).toBe(false);

    expect([F.a, F.b, F.noperm].map(shared)).toEqual([0, 0, 0]);
    expect([F.moved, F.gone].map(shared)).toEqual([-1, -1]); // permanent skips are marked : not listed again
    expect(shared(F.gas)).toBe(1);

    const aud = JSON.parse(sdb.prepare("SELECT details FROM audit_logs WHERE action = 'UNSHARE_PUBLIC'").get().details);
    expect(aud.unsharedFiles.map((x) => x.fileId).sort()).toEqual([F.a, F.b, F.noperm].sort());
    expect(aud.skippedFiles.map((x) => x.fileId).sort()).toEqual([F.moved, F.gone].sort());

    // a second run lists nothing : the permanent skips no longer crowd out newer files
    const again = await (await call('ADMIN', {})).json();
    expect(again.candidates).toEqual([]);
  });

  it('a temporary Drive 403 (rate limit) is DRIVE_ERROR : the row stays public (1, not -1) and is retried ; only a 404 is final', async () => {
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u.includes(`/files/${F.a}?`) && (init.method || 'GET') === 'GET') return jres({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
      return orig(url, init);
    }));
    const j = await (await call('ADMIN', { dryRun: false })).json();
    expect(j.skipped.find((s) => s.fileId === F.a).reason).toBe('DRIVE_ERROR');
    expect(shared(F.a)).toBe(1);
    expect(j.skipped.find((s) => s.fileId === F.gone).reason).toBe('NOT_IN_DRIVE');
    expect(shared(F.gone)).toBe(-1);
  });

  it('files of deleted documents (docGone 1) and trashed orphans (docGone 2) are included too', async () => {
    addAtt('DELETEDDOC0123456789ab', { docGone: 1 }); addAtt('TRASHEDORPH0123456789a', { docGone: 2 });
    driveFiles.DELETEDDOC0123456789ab = { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] };
    driveFiles.TRASHEDORPH0123456789a = { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] };
    const j = await (await call('ADMIN', { dryRun: false })).json();
    expect(j.unshared.map((x) => x.fileId)).toEqual(expect.arrayContaining(['DELETEDDOC0123456789ab', 'TRASHEDORPH0123456789a']));
    expect(driveFiles.DELETEDDOC0123456789ab.permissions).toEqual([]);
    expect(driveFiles.TRASHEDORPH0123456789a.permissions).toEqual([]);
  });

  it('permissions are read page by page ; an anyone permission that is still there afterwards keeps the row public (STILL_PUBLIC)', async () => {
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url); const method = (init.method || 'GET').toUpperCase();
      if (u.includes(`/files/${F.a}/permissions?`) && method === 'GET') {
        // page 1: only a user ; page 2: the anyone permission
        if (!u.includes('pageToken=')) return jres({ permissions: [{ id: 'user1', type: 'user', role: 'writer' }], nextPageToken: 'P2' });
        return jres({ permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] });
      }
      if (u.includes(`/files/${F.a}/permissions/`) && method === 'DELETE') return new Response(null, { status: 204 }); // pretend, but it stays listed
      return orig(url, init);
    }));
    const j = await (await call('ADMIN', { dryRun: false })).json();
    expect(j.skipped.find((s) => s.fileId === F.a).reason).toBe('STILL_PUBLIC');
    expect(shared(F.a)).toBe(1);
  });

  it('limit caps how many files one call handles and says truncated', async () => {
    const j = await (await call('ADMIN', { dryRun: false, limit: 1 })).json();
    expect(j.limit).toBe(1);
    expect(j.truncated).toBe(true);
    expect(j.unshared.length + j.skipped.length).toBeLessThanOrEqual(1);
    expect(gcalls.filter((c) => c.method === 'DELETE').length).toBeLessThanOrEqual(1);
  });

  it('a Drive error on one file leaves its row public (retry later) and does not stop the others', async () => {
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (String(url).includes(`/files/${F.a}/permissions`) && (init.method || 'GET') === 'GET') return jres({ error: { message: 'boom' } }, 500);
      return orig(url, init);
    }));
    const j = await (await call('ADMIN', { dryRun: false })).json();
    expect(j.skipped.find((s) => s.fileId === F.a).reason).toBe('DRIVE_ERROR');
    expect(shared(F.a)).toBe(1);
    expect(shared(F.b)).toBe(0);
  });

  // ───────── POST /api/users : no default role ─────────
  const newUser = (o = {}) => ({ id: 'U-NEW', username: 'new.user', name: 'New User', password: 'Initial123', department: 'PD', ...o });

  it('POST /api/users without roleId -> 400 and nothing is created (no REQUESTER_PD default)', async () => {
    for (const o of [{}, { roleId: '' }, { roleId: '   ' }, { roleId: null }]) {
      const r = await call('ADMIN', newUser(o), '/api/users');
      expect(r.status).toBe(400);
    }
    expect(sdb.prepare("SELECT COUNT(*) c FROM users WHERE username = 'new.user'").get().c).toBe(0);
  });

  it('POST /api/users with a roleId still works ; an existing user updated without roleId keeps the stored role', async () => {
    const ok = await call('ADMIN', newUser({ roleId: 'ASST_MANAGER' }), '/api/users');
    expect(ok.status).toBeLessThan(300);
    expect(sdb.prepare("SELECT roleId FROM users WHERE username = 'new.user'").get().roleId).toBe('ASST_MANAGER');
    const upd = await call('ADMIN', { id: 'U-NEW', username: 'new.user', name: 'Renamed' }, '/api/users/U-NEW', 'PUT');
    expect(upd.status).toBeLessThan(300);
    expect(sdb.prepare("SELECT roleId, name FROM users WHERE username = 'new.user'").get()).toMatchObject({ roleId: 'ASST_MANAGER', name: 'Renamed' });
  });
});
