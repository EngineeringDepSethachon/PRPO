// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getAccessToken, ensureFolderPath, uploadFile, escapeQueryLiteral, resolveFolderParts,
  sanitizeFileName, validateUpload, publicError, DriveError, _resetDriveCache, DRIVE_SCOPE, MAX_FILE_SIZE_BYTES
} from '../functions/_lib/drive.js';

const ROOT = 'ROOTFOLDER1234567890';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
let pem, publicKey, env;

function b64(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s);
}
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  publicKey = kp.publicKey;
  const der = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  pem = `-----BEGIN PRIVATE KEY-----\n${b64(der).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

beforeEach(() => {
  _resetDriveCache();
  env = { GOOGLE_SA_CLIENT_EMAIL: 'sa@proj.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('getAccessToken', () => {
  it('throws a configuration error without leaking key', async () => {
    await expect(getAccessToken({})).rejects.toThrow(/not configured/);
    const bad = { ...env, GOOGLE_SA_PRIVATE_KEY: 'SECRETGARBAGE' };
    const err = await getAccessToken(bad).catch((e) => e);
    expect(err.code).toBe('DRIVE_NOT_CONFIGURED');
    expect(err.message).not.toContain('SECRETGARBAGE');
  });

  it('builds a verifiable RS256 JWT, accepts escaped \\n, and caches the token', async () => {
    const fetchMock = vi.fn(async () => json({ access_token: 'tok1', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    env.GOOGLE_SA_PRIVATE_KEY = pem.trim().replace(/\n/g, '\\n');
    expect(await getAccessToken(env)).toBe('tok1');
    expect(await getAccessToken(env)).toBe('tok1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = form.get('assertion').split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims.iss).toBe(env.GOOGLE_SA_CLIENT_EMAIL);
    expect(claims.scope).toBe(DRIVE_SCOPE);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.exp - claims.iat).toBe(3600);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it('refreshes when near expiry and reports exchange failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'a', expires_in: 30 }))
      .mockResolvedValueOnce(json({ access_token: 'b', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getAccessToken(env)).toBe('a');
    expect(await getAccessToken(env)).toBe('b');
    _resetDriveCache();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_grant' }, 400)));
    await expect(getAccessToken(env)).rejects.toThrow(/token exchange failed \(400 invalid_grant\)/);
  });
});

describe('query escaping and folder path', () => {
  it('escapes quotes and backslashes', () => {
    expect(escapeQueryLiteral("a'b\\c")).toBe("a\\'b\\\\c");
  });

  it('finds existing folder, creates missing, escapes injection in q', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return json({ id: 'NEWFOLDERID' + calls.length });
      return calls.length === 1 ? json({ files: [{ id: 'EXISTINGID123' }] }) : json({ files: [] });
    }));
    const id = await ensureFolderPath(env, 'T', ['01_PR_Attachments', "x' or name contains '"]);
    const q1 = new URL(calls[0].url).searchParams.get('q');
    expect(q1).toContain(`'${ROOT}' in parents`);
    expect(q1).toContain("name = '01_PR_Attachments'");
    const q2 = new URL(calls[1].url).searchParams.get('q');
    expect(q2).toContain("name = 'x\\' or name contains \\''");
    expect(q2).toContain("'EXISTINGID123' in parents");
    const create = calls[2];
    expect(create.init.method).toBe('POST');
    expect(JSON.parse(create.init.body)).toEqual({
      name: "x' or name contains '", mimeType: 'application/vnd.google-apps.folder', parents: ['EXISTINGID123']
    });
    expect(create.init.headers.Authorization).toBe('Bearer T');
    expect(id).toBe('NEWFOLDERID3');
  });

  it('requires a root id and rejects bad names', async () => {
    await expect(ensureFolderPath({}, 'T', ['a'])).rejects.toThrow(/DRIVE_ROOT_FOLDER_ID/);
    await expect(ensureFolderPath(env, 'T', ['..'])).rejects.toThrow(/invalid folder name/);
  });

  it('maps category/po/date like the legacy system', () => {
    const d = new Date(Date.UTC(2026, 9, 5, 12));
    // month is Asia/Bangkok : 2026-09-30 18:00Z is already 1 Oct in Bangkok ; 2026-09-30 16:59Z is not
    expect(resolveFolderParts('PR', '', new Date(Date.UTC(2026, 8, 30, 17, 0)))[1]).toBe('2026-10');
    expect(resolveFolderParts('PR', '', new Date(Date.UTC(2026, 8, 30, 16, 59)))[1]).toBe('2026-09');
    expect(resolveFolderParts('PR', '', new Date(Date.UTC(2026, 11, 31, 20, 0)))[1]).toBe('2027-01');
    expect(resolveFolderParts('PR', 'PO-1', d)).toEqual(['01_PR_Attachments', '2026-10']);
    expect(resolveFolderParts('PO', '', d)).toEqual(['02_PO_Documents', '2026-10']);
    expect(resolveFolderParts('GRN', 'PO-1', d)).toEqual(['03_GRN_Evidence', '2026-10', 'PO-1']);
    expect(resolveFolderParts('claim', 'PO-1', d)).toEqual(['04_Claim_Evidence', '2026-10', 'PO-1']);
    expect(resolveFolderParts('zzz', '', d)[0]).toBe('01_PR_Attachments');
  });
});

describe('uploadFile', () => {
  it('sends multipart body then sets anyone-with-link reader and returns urls', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/upload/')) return json({ id: 'FILEID1234567890abcd', name: 'a.png', webViewLink: 'https://drive.google.com/file/d/FILEID1234567890abcd/view?usp=drivesdk' });
      return json({ id: 'perm' });
    }));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250]);
    const r = await uploadFile(env, 'T', { folderId: 'FOLDERID12345', name: 'a/b:c.png', mimeType: 'IMAGE/PNG', bytes });

    const up = calls[0];
    expect(up.url).toContain('uploadType=multipart');
    expect(up.url).toContain('supportsAllDrives=true');
    const ct = up.init.headers['Content-Type'];
    const boundary = ct.match(/boundary=(.+)$/)[1];
    expect(ct.startsWith('multipart/related')).toBe(true);
    expect(up.init.body).toBeInstanceOf(Blob); // multipart parts are not copied into one big Uint8Array
    const buf = new Uint8Array(await up.init.body.arrayBuffer());
    const text = new TextDecoder('latin1').decode(buf);
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--`)).toBe(true);
    expect(text).toContain('{"name":"a_b_c.png","parents":["FOLDERID12345"]}');
    expect(text).toContain('Content-Type: image/png');
    const idx = buf.length - `\r\n--${boundary}--`.length - 4;
    expect([...buf.slice(idx, idx + 4)]).toEqual([1, 2, 3, 250]);

    // no anyone-with-link permission call any more : the upload is the only request
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/permissions'))).toBe(false);

    expect(r.fileId).toBe('FILEID1234567890abcd');
    expect(r.directUrl).toBe('https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200');
    expect(r.lh3Url).toBe('https://lh3.googleusercontent.com/d/FILEID1234567890abcd');
    expect(r.viewUrl).toBe('https://drive.google.com/file/d/FILEID1234567890abcd/view');
    expect(r.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=FILEID1234567890abcd');
    expect(r.webViewLink).toContain('FILEID1234567890abcd');
    expect(r.sharedPublic).toBe(false);
  });

  it('never asks Drive for any permission (file stays private, opened through the proxy)', async () => {
    const f = vi.fn(async (url) =>
      String(url).includes('/upload/') ? json({ id: 'FILEID1234567890abcd', name: 'x.pdf' }) : json({ error: { message: 'no' } }, 403));
    vi.stubGlobal('fetch', f);
    const r = await uploadFile(env, 'T', { folderId: 'FOLDERID12345', name: 'x.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r.sharedPublic).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('surfaces Drive API errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'File not found' } }, 404)));
    await expect(uploadFile(env, 'T', { folderId: 'FOLDERID12345', name: 'x.pdf', mimeType: 'application/pdf', bytes: PDF }))
      .rejects.toThrow(/DRIVE_API_ERROR: File not found \(404\)/);
  });

  it('rejects before any network call when invalid', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const base = { folderId: 'FOLDERID12345', name: 'x', bytes: PDF };
    await expect(uploadFile(env, 'T', { ...base, mimeType: 'text/html' })).rejects.toThrow(/UNSUPPORTED_MEDIA_TYPE/);
    await expect(uploadFile(env, 'T', { ...base, mimeType: 'image/png', bytes: new Uint8Array(0) })).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(uploadFile(env, 'T', { ...base, mimeType: 'image/png', folderId: "x' y" })).rejects.toThrow(/invalid folderId/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('enforces size limit', () => {
    const big = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    expect(() => validateUpload({ name: 'a.pdf', mimeType: 'application/pdf', bytes: big })).toThrow(/FILE_TOO_LARGE/);
    expect(validateUpload({ name: 'a.pdf', mimeType: 'application/pdf; charset=x', bytes: Object.assign(new Uint8Array(MAX_FILE_SIZE_BYTES), PDF) }).mimeType)
      .toBe('application/pdf');
  });
  it('allows office types and accepts ArrayBuffer', () => {
    const t = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(validateUpload({ name: 'a.docx', mimeType: t, bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0]).buffer }).bytes).toBeInstanceOf(Uint8Array);
  });
  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/pass"wd?.png')).toBe('_.._etc_pass_wd_.png');
    expect(sanitizeFileName('  \u0000 ')).toMatch(/^file_\d+$/);
    expect(sanitizeFileName('ใบสั่งซื้อ.pdf')).toBe('ใบสั่งซื้อ.pdf');
    expect(sanitizeFileName('a'.repeat(300) + '.pdf').length).toBe(180);
    expect(sanitizeFileName('a'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
  });

  it('rejects content whose magic bytes do not match the declared mime (415)', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]);
    for (const m of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) {
      const e = (() => { try { validateUpload({ name: 'a', mimeType: m, bytes: exe }); } catch (x) { return x; } })();
      expect(e.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(publicError(e).status).toBe(415);
    }
    const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(validateUpload({ name: 'a.webp', mimeType: 'image/webp', bytes: riff }).name).toBe('a.webp');
    expect(() => validateUpload({ name: 'a.webp', mimeType: 'image/webp', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 1, 2, 3, 4]) })).toThrow(/UNSUPPORTED/);
    expect(validateUpload({ name: 'a.xls', mimeType: 'application/vnd.ms-excel', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]) }).name).toBe('a.xls');
    expect(validateUpload({ name: 'a.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]) }).name).toBe('a.jpg');
    expect(validateUpload({ name: 'a.gif', mimeType: 'image/gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0]) }).name).toBe('a.gif');
  });

  it('forces the extension to match the mime', () => {
    expect(validateUpload({ name: 'evil.exe', mimeType: 'application/pdf', bytes: PDF }).name).toBe('evil.pdf');
    expect(validateUpload({ name: 'noext', mimeType: 'application/pdf', bytes: PDF }).name).toBe('noext.pdf');
    expect(validateUpload({ name: 'a.PDF', mimeType: 'application/pdf', bytes: PDF }).name).toBe('a.PDF');
    expect(validateUpload({ name: 'a.jpeg', mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) }).name).toBe('a.jpeg');
    expect(validateUpload({ name: 'a.png', mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) }).name).toBe('a.jpg');
  });

  it('strips bidi / zero-width characters from names', () => {
    expect(sanitizeFileName('photo‮gpj.exe')).toBe('photogpj.exe');
    expect(sanitizeFileName('a​b⁦c⁩d‏.pdf')).toBe('abcd.pdf');
  });
});

describe('publicError', () => {
  it('maps codes to safe status and generic Thai messages', () => {
    const e = (code, msg) => new DriveError(code, msg);
    expect(publicError(e('VALIDATION_ERROR', 'x')).status).toBe(400);
    expect(publicError(e('FILE_TOO_LARGE', 'x')).status).toBe(413);
    expect(publicError(e('UNSUPPORTED_MEDIA_TYPE', 'x')).status).toBe(415);
    expect(publicError(e('DRIVE_NOT_CONFIGURED', 'GOOGLE_SA_PRIVATE_KEY')).status).toBe(503);
    expect(publicError(e('DRIVE_AUTH_FAILED', 'x')).status).toBe(502);
    const api = publicError(e('DRIVE_API_ERROR', 'secret internal File not found (404)'));
    expect(api.status).toBe(502);
    expect(JSON.stringify(api)).not.toMatch(/secret|404|GOOGLE/);
    expect(JSON.stringify(publicError(e('DRIVE_NOT_CONFIGURED', 'GOOGLE_SA_PRIVATE_KEY')))).not.toContain('GOOGLE');
    expect(publicError(new Error('boom')).status).toBe(500);
    expect(publicError(null).status).toBe(500);
  });
});
