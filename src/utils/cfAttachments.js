/**
 * Cloudflare mode : files picked in FileUploader (PDF / big files) are uploaded to Google Drive through /api/upload
 * when the document is saved, and only {fileId, url, name, mimeType, size} is stored in the PR (never a full-file data URL).
 * Images too (S6) : the compressed data URL is uploaded and replaced by the file reference. Other modes : returned untouched.
 */
import { useEffect, useState } from 'react';
import { isCloudflareMode, backendFetch, getAuthToken, SESSION_INVALID_EVENT, SESSION_GONE_EVENT } from '../config/backendMode.js';
import { uploadFileToDrive } from '../services/driveService.js';
import { modalService } from '../services/modalService.js';
import { isBlobUrl, pickAttachmentUrl } from './attachmentUrls.js';

export const INLINE_IMAGE_MAX_CHARS = 250000; // > compressed 150 KB image (~205k chars of base64), well below the server limit (400k)

const isBlobLike = (v) => typeof Blob !== 'undefined' && v instanceof Blob;

// S6 (docs/requirements-file-storage.md) : in cloudflare mode every picked file, images included, goes to the file store (R2) ; no new data:image in a document
const IMG_DATA_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const needsDrive = (f) => !!f && isBlobLike(f.file) && !f.fileId;

/** { base64Data, mimeType } of the (compressed) inline image of an uploader item, or null (not an image / no usable data URL -> upload the File). */
function imageDataOf(f) {
  for (const v of [f && f.url, f && f.dataUrl, f && f.previewUrl]) {
    const m = typeof v === 'string' ? v.match(IMG_DATA_RE) : null;
    if (m) return { base64Data: m[2].replace(/\s/g, ''), mimeType: m[1].toLowerCase(), src: v };
  }
  return null;
}

/** Without a File : a lingering blob: URL is meaningless to the server, so drop it from the url fields. */
const dropBlobs = (f) => {
  if (!f || typeof f !== 'object') return f;
  const out = { ...f };
  for (const k of ['previewUrl', 'url', 'dataUrl', 'localUrl']) {
    if (isBlobUrl(out[k])) out[k] = k === 'localUrl' ? undefined : (out.dataUrl && !isBlobUrl(out.dataUrl) ? out.dataUrl : '');
  }
  return out;
};

// ───────────────────────── viewing files : GET /api/files/:id (cloudflare mode only) ─────────────────────────
// Why fetch -> blob: URL (and not a signed URL / token in the query string) : <img src> and <a href> cannot send the Authorization header, and a token
// in a URL ends up in history, logs and the Referer header. Fetching with the normal Bearer header (backendFetch) keeps the token where every other
// API call keeps it, needs no new secret / endpoint / expiry logic, and the server still checks the owner document on every request. The blob: URL
// lives only in this page (same origin, not shareable) and is dropped when the session ends.
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const PLACEHOLDER_RE = /BASE64_|STORED_IN_DRIVE/;
const URL_ID_RES = [/\/file\/d\/([A-Za-z0-9_-]{10,128})/, /[?&]id=([A-Za-z0-9_-]{10,128})/, /googleusercontent\.com\/d\/([A-Za-z0-9_-]{10,128})/];
const idFromUrl = (u) => {
  if (typeof u !== 'string' || !u || PLACEHOLDER_RE.test(u)) return null;
  // R2 file (FILE_STORAGE=r2) : the stored url is our own authenticated proxy path (files/:id under the API, no Drive host) ; the id is verified by the server on every request
  const r2 = u.match(/^\/api\/files\/([A-Za-z0-9_-]{10,128})(?:\?download=1)?$/);
  if (r2) return r2[1];
  if (!/^https:\/\/(drive|lh3)\.google(usercontent)?\.com\//.test(u)) return null;
  for (const re of URL_ID_RES) { const m = u.match(re); if (m) return m[1]; }
  return null;
};

/** true when `u` is our own authenticated file proxy path (an R2 file in cloudflare mode) - never a Google Drive link */
export const isProxyFileUrl = (u) => typeof u === 'string' && /^\/api\/files\/[A-Za-z0-9_-]{10,128}(?:\?download=1)?$/.test(u);

/** Drive file id of an attachment that must be shown through the proxy, or null (not cloudflare mode / local preview / no Drive file). */
export function driveFileIdOf(att) {
  if (!isCloudflareMode() || !att) return null;
  if (typeof att === 'string') return idFromUrl(att);
  if (typeof att !== 'object') return null;
  const local = pickAttachmentUrl(att, ['localUrl', 'previewUrl', 'dataUrl']);
  if (/^(blob:|data:)/.test(local)) return null; // a file picked in this session is shown from memory
  if (typeof att.fileId === 'string' && FILE_ID_RE.test(att.fileId) && !PLACEHOLDER_RE.test(att.fileId)) return att.fileId;
  for (const k of ['url', 'viewUrl', 'directUrl', 'fileUrl', 'previewUrl', 'downloadUrl', 'lh3Url']) {
    const id = idFromUrl(att[k]);
    if (id) return id;
  }
  return null;
}

const proxyPromises = new Map(); // `${hash(token)}|${id}` -> Promise<blob: url> ; a different login never reuses another user's entry
const proxyUrls = new Map();     // same key -> resolved blob: url (lets the hook answer synchronously on re-render)
let cacheEpoch = 0;              // bumped on every clear : a download that finishes after a clear is revoked, not stored
let cacheOwner = '';             // hash of the token the cache was filled with

// FNV-1a (two seeds) : the raw token is never used as a map key
const tokenHash = (t) => {
  if (!t) return '';
  let a = 0x811c9dc5; let b = 0x01000193;
  for (let i = 0; i < t.length; i++) {
    a = Math.imul(a ^ t.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ t.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(36) + b.toString(36);
};

/** Drop every cached blob: URL (sign-out / session ended / token changed). */
export function clearProxiedFileCache() {
  cacheEpoch += 1;
  for (const u of proxyUrls.values()) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  proxyUrls.clear();
  proxyPromises.clear();
}
// the token rotated (password change) or the user changed : blob: copies fetched under the old one are dropped
const proxyKey = (id) => {
  const owner = tokenHash(getAuthToken());
  if (owner !== cacheOwner) { cacheOwner = owner; clearProxiedFileCache(); }
  return `${owner}|${id}`;
};
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener(SESSION_INVALID_EVENT, clearProxiedFileCache);
  window.addEventListener(SESSION_GONE_EVENT, clearProxiedFileCache);
}

/** -> Promise<blob: url> of the file (fetched once per session). Rejects with an Error carrying .status. */
export function getProxiedFileUrl(fileId) {
  const key = proxyKey(fileId);
  if (proxyPromises.has(key)) return proxyPromises.get(key);
  const epoch = cacheEpoch;
  const p = (async () => {
    const safeId = encodeURIComponent(fileId);
    const res = await backendFetch(`/api/files/${safeId}`);
    if (!res.ok) { const e = new Error(`file ${res.status}`); e.status = res.status; throw e; }
    const blob = await res.blob();
    if (epoch !== cacheEpoch) { const e = new Error('session changed'); e.status = 0; throw e; } // cleared meanwhile : nothing is created / kept
    const url = URL.createObjectURL(blob);
    proxyUrls.set(key, url);
    return url;
  })();
  proxyPromises.set(key, p);
  // a 404 is final for this session (e.g. an old Drive link that is not a project file) ; anything else (429 / 5xx / network) may be retried
  p.catch((e) => { if ((!e || e.status !== 404) && proxyPromises.get(key) === p) proxyPromises.delete(key); });
  return p;
}

/**
 * React hook : { url, state: 'off' | 'loading' | 'ready' | 'error', fileId }.
 * 'off' = not cloudflare mode / nothing to proxy -> the caller keeps its existing URL logic. 'error' -> the caller falls back to its old URL.
 * imagesOnly : skip files whose known type is not an image (thumbnails of PDFs are an icon, no download needed).
 */
export function useProxiedFileUrl(att, { imagesOnly = false, enabled = true } = {}) {
  const fileId = enabled ? driveFileIdOf(att) : null;
  const mime = att && typeof att === 'object' ? String(att.mimeType || att.type || '') : '';
  const id = fileId && !(imagesOnly && mime && !mime.startsWith('image/')) ? fileId : '';
  const [res, setRes] = useState({ id: '', owner: '', epoch: -1, url: '', state: 'off' });
  // proxyKey() drops the cache when the token changed ; owner / epoch then differ from the ones stored in `res`, so a blob: URL that was revoked is
  // never handed out and the file is fetched again with the new token
  const cached = id ? proxyUrls.get(proxyKey(id)) : undefined;
  const owner = id ? tokenHash(getAuthToken()) : '';
  const epoch = cacheEpoch;
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    getProxiedFileUrl(id)
      .then((url) => { if (alive) setRes({ id, owner, epoch, url, state: 'ready' }); })
      .catch(() => { if (alive) setRes({ id, owner, epoch, url: '', state: 'error' }); });
    return () => { alive = false; };
  }, [id, owner, epoch]);
  if (!id) return { url: '', state: 'off', fileId: null };
  if (cached) return { url: cached, state: 'ready', fileId: id };
  if (res.id !== id || res.owner !== owner || res.epoch !== epoch) return { url: '', state: 'loading', fileId: id };
  return { url: res.state === 'ready' ? '' : res.url, state: res.state === 'ready' ? 'error' : res.state, fileId: id };
}

/**
 * Open (download = false) the file in a new tab, or save it (download = true), through the proxy.
 * @returns {Promise<boolean>} false when it could not be done (caller may fall back to the old link)
 */
export async function openProxiedFile(att, { download = false } = {}) {
  const id = driveFileIdOf(att);
  if (!id || typeof window === 'undefined') return false;
  // a file the browser cannot show (not an image / PDF, when the type is known) is saved with its original name instead of a blank tab
  if (!download && att && typeof att === 'object') {
    const mime = String(att.mimeType || att.type || '').toLowerCase();
    if (mime && !mime.startsWith('image/') && mime !== 'application/pdf') download = true;
  }
  // the tab must be opened inside the click handler (popup blockers), the content is put in once it has arrived
  const win = download ? null : window.open('', '_blank');
  if (!download && !win) return false;
  try {
    const url = await getProxiedFileUrl(id);
    if (download) {
      const a = document.createElement('a');
      a.href = url;
      a.download = (att && typeof att === 'object' && (att.name || att.fileName)) || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      try { win.opener = null; } catch { /* ignore */ }
      win.location.href = url;
    }
    return true;
  } catch (e) {
    try { if (win) win.close(); } catch { /* ignore */ }
    // 404 = "not a project file / not visible to you" (the server answers both the same, to hide whether a file exists) : the caller keeps the old
    // Drive link for legacy files (limitation : a new private file the user may not see also lands here). Any other refusal (401/403/429/5xx) is
    // told to the user and the Drive link is NOT tried (a new file is private there, Google would only show an access-request page).
    if (e && e.status === 401) return true; // session ended : backendFetch already raised SESSION_INVALID_EVENT (AuthContext shows its own notice)
    if (e && e.status && e.status !== 404) {
      modalService.warning('ไม่สามารถเปิดไฟล์ได้', 'ไม่สามารถเปิดไฟล์ได้ หรือไม่มีสิทธิ์เข้าถึงไฟล์นี้');
      return true;
    }
    return false;
  }
}

/**
 * Cloudflare mode : per-line product images ({url|previewUrl: data:image/...}, no File) are uploaded to the file store and replaced by
 * {fileId, url: /api/files/:id}. images and attachments of a line hold the same pictures, so each one is uploaded once.
 * Images that already have a fileId / a non-data URL (old PRs, uploaded earlier) are untouched ; unsupported data URLs (svg ...) are left as is.
 * Other modes : the same items array is returned.
 */
export async function uploadItemImagesForCloudflare(items, { category = 'PR', docRef = '', department = '', docType = 'PR_ITEM_IMAGE' } = {}) {
  if (!isCloudflareMode() || !Array.isArray(items)) return items;
  const done = new Map(); // data URL -> uploaded reference (same picture in images + attachments / twice in the form)
  const one = async (img) => {
    if (!img || typeof img !== 'object' || img.fileId) return img;
    const parsed = imageDataOf(img);
    if (!parsed) return img;
    const key = parsed.src || ''; // the exact data URL that is uploaded (url / dataUrl / previewUrl) ; empty -> no dedupe
    if (key && done.has(key)) return done.get(key);
    const res = await uploadFileToDrive({
      base64Data: parsed.base64Data, mimeType: parsed.mimeType, fileName: img.name || img.fileName || 'image.jpg',
      category, poNumber: docRef, docNo: docRef, docType, department
    });
    const ref = {
      name: res.fileName || img.name || '',
      fileId: res.fileId,
      mimeType: res.mimeType || parsed.mimeType,
      size: res.fileSize || img.size || 0,
      url: res.fileUrl,
      previewUrl: res.previewUrl || res.fileUrl,
      driveUrl: '',
      lh3Url: res.lh3Url || ''
    };
    if (key) done.set(key, ref);
    return ref;
  };
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') { out.push(item); continue; }
    const next = { ...item };
    for (const k of ['images', 'attachments']) {
      if (!Array.isArray(item[k])) continue;
      const list = [];
      for (const img of item[k]) list.push(await one(img));
      next[k] = list;
    }
    out.push(next);
  }
  return out;
}

/**
 * @param {Array} files FileUploader items ({file, name, type, size, url, previewUrl, dataUrl, ...})
 * @param {{category?: string, docRef?: string, department?: string, docType?: string}} opts
 * @returns {Promise<Array>} items where oversized / non-image files were replaced by Drive references
 */
export async function uploadAttachmentsForCloudflare(files, { category = 'PR', docRef = '', department = '', docType = '' } = {}) {
  if (!isCloudflareMode() || !Array.isArray(files)) return files;
  const out = [];
  for (const f of files) {
    if (!needsDrive(f)) { out.push(dropBlobs(f)); continue; }
    // an image already compressed by the form (data URL) is uploaded from that data (small) ; otherwise the picked File itself
    const img = imageDataOf(f);
    const res = await uploadFileToDrive({
      ...(img ? { base64Data: img.base64Data, mimeType: img.mimeType, fileName: f.name || f.fileName || 'image.jpg' } : { file: f.file }),
      category,
      poNumber: docRef,
      docNo: docRef,
      docType: docType || category,
      department
    });
    // eslint-disable-next-line no-unused-vars
    const { file: _file, dataUrl: _d, localUrl: _l, ...rest } = f;
    out.push({
      ...rest,
      id: res.attachmentId || res.fileId,
      fileId: res.fileId,
      name: res.fileName || f.name,
      fileName: res.fileName || f.name,
      size: res.fileSize || f.size,
      fileSize: res.fileSize || f.size,
      type: res.mimeType || f.type,
      mimeType: res.mimeType || f.type,
      url: res.fileUrl,
      previewUrl: res.previewUrl || res.fileUrl,
      viewUrl: res.viewUrl,
      directUrl: res.previewUrl || '',
      lh3Url: res.lh3Url || '',
      downloadUrl: res.downloadUrl || '',
      folderPath: res.folderPath || '',
      uploadedAt: res.uploadedAt
    });
  }
  return out;
}
