/**
 * Attachment URL helpers (logic only, no UI).
 *
 * blob: URLs only live inside the browser session that created them. They must never be sent to the server
 * and, when an old record carrying one is shown in a later session, the stable server URL (fileUrl) is used instead.
 */
import { isCloudflareMode } from '../config/backendMode.js';

const liveBlobUrls = new Set(); // blob: URLs created by THIS page session

export const isBlobUrl = (u) => typeof u === 'string' && u.startsWith('blob:');

/** Remember a blob: URL created in this session (call right after URL.createObjectURL). Returns the url. */
export const registerBlobUrl = (u) => {
  if (isBlobUrl(u)) liveBlobUrls.add(u);
  return u;
};

/** non-empty, and not a dead blob: URL from another session */
export const isUsableUrl = (u) => typeof u === 'string' && u !== '' && (!isBlobUrl(u) || liveBlobUrls.has(u));

/** First usable value among att[keys...] (keeps the caller's priority order). */
export const pickAttachmentUrl = (att, keys) => {
  if (typeof att === 'string') return isUsableUrl(att) ? att : '';
  if (!att) return '';
  for (const k of keys) {
    if (isUsableUrl(att[k])) return att[k];
  }
  return '';
};

const BLOB_FIELDS = ['localUrl', 'previewUrl', 'dataUrl', 'url'];

/**
 * Copy of the attachment list that is safe to send to the server in cloudflare mode : blob: values are
 * removed (previewUrl/dataUrl/url fall back to the server fileUrl). Other modes : returned untouched.
 */
export const attachmentsForServer = (list) => {
  if (!isCloudflareMode() || !Array.isArray(list)) return list;
  return list.map((a) => {
    if (typeof a === 'string') return isBlobUrl(a) ? '' : a;
    if (!a || typeof a !== 'object') return a;
    const out = { ...a };
    const fallback = [a.fileUrl, a.viewUrl, a.directUrl].find((u) => typeof u === 'string' && u && !isBlobUrl(u)) || '';
    for (const k of BLOB_FIELDS) {
      if (isBlobUrl(out[k])) {
        if (k === 'localUrl') delete out[k];
        else if (fallback) out[k] = fallback;
        else delete out[k];
      }
    }
    return out;
  }).filter((a) => a !== '');
};
