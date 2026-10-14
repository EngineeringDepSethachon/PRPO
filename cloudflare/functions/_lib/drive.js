// Google Drive client for Cloudflare Pages Functions (Service Account, WebCrypto + fetch only, no packages).
//
// Env (secrets via `wrangler pages secret put`, never commit):
//   GOOGLE_SA_CLIENT_EMAIL   service account email
//   GOOGLE_SA_PRIVATE_KEY    PEM PKCS8 private key ("\n" escaped is accepted)
//   DRIVE_ROOT_FOLDER_ID     id of the project folder shared with the service account (Editor)
//
// OAuth scope: https://www.googleapis.com/auth/drive (full), NOT drive.file.
// Reason: drive.file only grants access to files this app created/opened itself. The root folder is created by a
// human and merely shared to the service account, so with drive.file the SA could neither list nor create children in it
// (404). The SA can only reach what is explicitly shared with it, so the blast radius is that folder.
//
// Layout (parity with gas/Config.gs + src/services/driveService.js):
//   {root}/01_PR_Attachments|02_PO_Documents/{YYYY-MM}
//   {root}/03_GRN_Evidence|04_Claim_Evidence/{YYYY-MM}/{PO_NUMBER}

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

// Validation / sanitizing / error mapping live in storage/common.js (shared with the R2 backend) ; the same names are re-exported here so existing imports keep working.
import {
  DRIVE_CATEGORIES, MAX_FILE_SIZE_BYTES, ALLOWED_MIME_TYPES, DriveError, BIDI_RE, sanitizeFileName, validateUpload, publicError
} from './storage/common.js';
export { DRIVE_CATEGORIES, MAX_FILE_SIZE_BYTES, ALLOWED_MIME_TYPES, DriveError, sanitizeFileName, validateUpload, publicError };

// ---------- base64 / PEM helpers ----------
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- access token ----------
let tokenCache = null; // { key, token, exp(ms) }
export function _resetDriveCache() { tokenCache = null; }

function readCredentials(env) {
  const email = env && typeof env.GOOGLE_SA_CLIENT_EMAIL === 'string' ? env.GOOGLE_SA_CLIENT_EMAIL.trim() : '';
  const key = env && typeof env.GOOGLE_SA_PRIVATE_KEY === 'string' ? env.GOOGLE_SA_PRIVATE_KEY.trim() : '';
  if (!email || !key) {
    throw new DriveError('DRIVE_NOT_CONFIGURED',
      'Google Drive service account is not configured (GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY missing)');
  }
  return { email, key };
}

export async function getAccessToken(env) {
  const { email, key } = readCredentials(env);
  const now = Date.now();
  if (tokenCache && tokenCache.key === email && tokenCache.exp - 60_000 > now) return tokenCache.token;

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey('pkcs8', pemToDer(key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    // never echo the key material
    throw new DriveError('DRIVE_NOT_CONFIGURED', 'GOOGLE_SA_PRIVATE_KEY is not a valid PKCS8 PEM private key');
  }
  const iat = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: email, scope: DRIVE_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput)));
  const assertion = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new DriveError('DRIVE_AUTH_FAILED', `Google token exchange failed (${res.status}${data.error ? ' ' + data.error : ''})`, res.status);
  }
  tokenCache = { key: email, token: data.access_token, exp: now + (Number(data.expires_in) || 3600) * 1000 };
  return data.access_token;
}

// ---------- Drive REST helper ----------
async function driveFetch(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : 'request failed';
    throw new DriveError('DRIVE_API_ERROR', `${msg} (${res.status})`, res.status);
  }
  return data;
}

// Escape a literal for a Drive `q` string: backslash then single quote.
export function escapeQueryLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

function cleanSegment(part) {
  // eslint-disable-next-line no-control-regex
  const s = String(part == null ? '' : part).replace(/[\u0000-\u001f\u007f]/g, '').replace(BIDI_RE, '').replace(/[\\/]/g, '_').trim().slice(0, 200);
  if (!s || s === '.' || s === '..') throw new DriveError('VALIDATION_ERROR', 'invalid folder name');
  return s;
}

export async function ensureFolderPath(env, token, parts) {
  const rootId = env && env.DRIVE_ROOT_FOLDER_ID ? String(env.DRIVE_ROOT_FOLDER_ID).trim() : '';
  if (!rootId) throw new DriveError('DRIVE_NOT_CONFIGURED', 'DRIVE_ROOT_FOLDER_ID is not set');
  if (!ID_RE.test(rootId)) throw new DriveError('DRIVE_NOT_CONFIGURED', 'DRIVE_ROOT_FOLDER_ID is malformed');
  let parent = rootId;
  for (const raw of parts || []) {
    const name = cleanSegment(raw);
    const q = `name = '${escapeQueryLiteral(name)}' and '${parent}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const params = new URLSearchParams({
      q, fields: 'files(id,name)', pageSize: '1', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
    });
    const found = await driveFetch(`${API}/files?${params}`, token);
    if (found.files && found.files.length) { parent = found.files[0].id; continue; }
    const created = await driveFetch(`${API}/files?supportsAllDrives=true&fields=id`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] })
    });
    parent = created.id;
  }
  return parent;
}

/** Category + PO + date -> folder path parts, same rules as src/services/driveService.js. */
export function resolveFolderParts(category, poNumber = '', date = new Date()) {
  const cat = String(category || '').toUpperCase().trim();
  let folder = DRIVE_CATEGORIES.PR;
  if (cat.startsWith('01') || cat.includes('PR')) folder = DRIVE_CATEGORIES.PR;
  else if (cat.startsWith('02') || cat.includes('PO')) folder = DRIVE_CATEGORIES.PO;
  else if (cat.startsWith('03') || cat.includes('GRN') || cat.includes('RECEIV')) folder = DRIVE_CATEGORIES.GRN;
  else if (cat.startsWith('04') || cat.includes('CLAIM') || cat.includes('DISPUTE')) folder = DRIVE_CATEGORIES.CLAIM;
  const d = date instanceof Date ? date : new Date(date);
  // month in Asia/Bangkok (UTC+7, no DST), not the runtime's local zone (Workers run in UTC)
  const bkk = new Date((!isNaN(d.getTime()) ? d.getTime() : Date.now()) + 7 * 3600 * 1000);
  const ym = `${bkk.getUTCFullYear()}-${String(bkk.getUTCMonth() + 1).padStart(2, '0')}`;
  const po = String(poNumber || '').trim();
  const parts = [folder, ym];
  if (po && (folder === DRIVE_CATEGORIES.GRN || folder === DRIVE_CATEGORIES.CLAIM)) parts.push(po);
  return parts;
}

// ---------- upload ----------
export function driveUrls(fileId) {
  return {
    viewUrl: `https://drive.google.com/file/d/${fileId}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
    directUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`,
    lh3Url: `https://lh3.googleusercontent.com/d/${fileId}`
  };
}

/** File metadata used by the download proxy (GET /api/files/:id). Throws DriveError(status) on any Drive error. */
export async function getFileMetadata(token, fileId) {
  if (!ID_RE.test(String(fileId))) throw new DriveError('VALIDATION_ERROR', 'invalid fileId');
  return driveFetch(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,mimeType,size,parents,trashed`, token);
}

/** Open the file content as a stream (alt=media). Returns the upstream Response (body NOT read) ; throws DriveError(status) when not ok. */
export async function openFileMedia(token, fileId) {
  if (!ID_RE.test(String(fileId))) throw new DriveError('VALIDATION_ERROR', 'invalid fileId');
  const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new DriveError('DRIVE_API_ERROR', `media request failed (${res.status})`, res.status);
  }
  return res;
}

/** Best effort: move a file to trash (used when the D1 record could not be written). Never throws. */
export async function trashFile(env, token, fileId) {
  try {
    await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true })
    });
    return true;
  } catch {
    return false;
  }
}

/** Best effort: take a file back out of the Drive trash (orphan cleanup restore). Never throws. */
export async function untrashFile(env, token, fileId) {
  try {
    await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: false })
    });
    return true;
  } catch {
    return false;
  }
}

/** Permissions of a file -> [{id, type, role}] (admin unshare-public). Throws DriveError on any Drive error. */
export async function listFilePermissions(token, fileId) {
  if (!ID_RE.test(String(fileId))) throw new DriveError('VALIDATION_ERROR', 'invalid fileId');
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) { // bounded : never loops forever
    const data = await driveFetch(`${API}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=nextPageToken,permissions(id,type,role)&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, token);
    if (Array.isArray(data.permissions)) out.push(...data.permissions);
    if (!data.nextPageToken) return out;
    pageToken = data.nextPageToken;
  }
  throw new DriveError('DRIVE_API_ERROR', 'too many permission pages');
}

/** Remove one permission (admin unshare-public : only ever called for type:'anyone'). Throws DriveError on any Drive error. */
export async function deleteFilePermission(token, fileId, permissionId) {
  if (!ID_RE.test(String(fileId)) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(permissionId))) throw new DriveError('VALIDATION_ERROR', 'invalid id');
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, token, { method: 'DELETE' });
  return true;
}

export async function uploadFile(env, token, { folderId, name, mimeType, bytes }) {
  if (!folderId || !ID_RE.test(String(folderId))) throw new DriveError('VALIDATION_ERROR', 'invalid folderId');
  const v = validateUpload({ name, mimeType, bytes });

  const boundary = `prpo${crypto.randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ name: v.name, parents: [folderId] })}\r\n` +
    `--${boundary}\r\nContent-Type: ${v.mimeType}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  // Blob of the three parts : no extra Uint8Array copy of the file is built here
  const body = new Blob([head, v.bytes, tail]);

  const created = await driveFetch(
    `${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`, token, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });

  // No anyone-with-link permission any more (user decision 2026-10-13) : the file is opened only through the authenticated proxy GET /api/files/:id.
  // `sharedPublic` stays in the result (always false) because the attachments row and the client still read it.
  const sharedPublic = false;

  const urls = driveUrls(created.id);
  return {
    fileId: created.id,
    name: created.name || v.name,
    fileName: created.name || v.name,
    mimeType: v.mimeType,
    fileSize: v.bytes.length,
    webViewLink: created.webViewLink || urls.viewUrl,
    ...urls,
    sharedPublic
  };
}
