// GET /api/files/:id : authenticated download / inline view of a file stored in the project's Google Drive folder (P5 phase 2, Fable condition 4).
// Called from functions/api/[[route]].js AFTER authentication + RBAC (rule 'misc-auth' = AUTH). Not a route (folder starts with "_").
//
// Authorization (IDOR guard) : :id is a Drive file id. It is served only when
//   1. the file is in `attachments` (written by /api/upload = a file the SERVER put in the project folder, never an arbitrary Drive id), AND
//   2. the caller may see a document the file belongs to, by the same READ rule the list endpoints use (scope.canSeeDocument : the union of what
//      the original screens of that user show, built on canAccessDepartment / clientCanAccessDepartmentData) :
//        - the document the attachments row points to (docRef / poNumber / docNo), or
//        - any PR / PO / PR line item that has the id stored in its JSON (a PR attached before it had a number, copied PR -> PO, re-saved documents), or
//        - the uploader himself while the row has no document yet (new PR still being created).
//   Anything else = 404 with the same body as a missing file (never says that the file exists).
// Delivery : streamed from Drive (alt=media), never buffered ; content type from our own allow-list (the type validated at upload), nosniff,
// safe Content-Disposition (inline only for images / PDF), private cache, CSP sandbox.

import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, sanitizeFileName } from './storage/common.js';
import { getStorageFor, refOfRow } from './storage/index.js';
import { attachmentRowAccess } from './filerefs.js';

export const MAX_DOWNLOADS_PER_HOUR = 1500; // per user, every request (thumbnails of a long list included) ; own counter key, same table as uploads
export const MAX_DOWNLOAD_BYTES_PER_HOUR = 2 * 1024 * 1024 * 1024; // per user, from Drive metadata sizes (key `dlb:<userId>`)
export const DOWNLOAD_WINDOW_MS = 60 * 60 * 1000;
export const FILE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const NOT_FOUND_MSG = 'ไม่พบไฟล์';

/** allow-listed content type or null. image/jpg is the same thing as image/jpeg. */
export function safeContentType(mime) {
  let m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpg') m = 'image/jpeg';
  return ALLOWED_MIME_TYPES.includes(m) || m === 'image/jpeg' ? m : null;
}

/** RFC 6266 / 5987 : ASCII fallback + UTF-8 filename*. The name is sanitized first (no quotes, slashes, control or bidi characters). */
export function contentDisposition(kind, name) {
  const clean = sanitizeFileName(name);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;%]/g, '_') || 'file';
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** -> the attachments row to serve, or null (not a project file / not visible to this user). The rule itself : filerefs.attachmentRowAccess */
export async function findAuthorizedAttachment(db, authUser, fileId) {
  const atts = ((await db.prepare('SELECT * FROM attachments WHERE fileId = ? LIMIT 10').bind(fileId).all()).results) || [];
  if (!atts.length) return null;
  return attachmentRowAccess(db, authUser, fileId, atts);
}

export async function handleFileDownload({ request, env, db, authUser, corsHeaders, fileId }) {
  const jsonErr = (status, message, code) => new Response(JSON.stringify({ error: message, ...(code ? { code } : {}), success: false }), { status, headers: corsHeaders });
  const notFound = () => jsonErr(404, NOT_FOUND_MSG, 'NOT_FOUND');
  try {
    if (!FILE_ID_RE.test(String(fileId || ''))) return notFound();
    if (!db) return jsonErr(503, 'ฐานข้อมูลยังไม่พร้อมใช้งาน', 'DB_UNAVAILABLE');

    // rate limit BEFORE any lookup (guessing ids is throttled too) ; fail closed when the counter is unavailable
    const bucket = Math.floor(Date.now() / DOWNLOAD_WINDOW_MS) * DOWNLOAD_WINDOW_MS;
    const att = await db.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?, ?, 1) ON CONFLICT(userId, windowStart) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(`dl:${authUser.userId}`, bucket).first().catch(() => null);
    if (!att) return jsonErr(503, 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'DB_UNAVAILABLE');
    if (Number(att.n) === 1) await db.prepare('DELETE FROM upload_attempts WHERE windowStart < ?').bind(bucket - DOWNLOAD_WINDOW_MS).run().catch(() => {});
    if (Number(att.n) > MAX_DOWNLOADS_PER_HOUR) return jsonErr(429, 'เปิดไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMITED');

    let row;
    try { row = await findAuthorizedAttachment(db, authUser, fileId); } catch { return jsonErr(503, 'ฐานข้อมูลยังไม่พร้อมใช้งาน', 'DB_UNAVAILABLE'); }
    if (!row || !row.folderId) return notFound();

    // the backend is the one stored on the ROW (never env.FILE_STORAGE) ; unknown storage / an R2 row without a key = 404, no fallback
    const ref = refOfRow(row);
    const storage = ref ? getStorageFor(row, env) : null;
    if (!ref || !storage) return notFound();
    let meta;
    try { meta = await storage.head(ref); } catch (e) {
      if (e && (e.status === 404 || e.status === 403)) return notFound();
      throw e;
    }
    // must still be in the very place the server put it (Drive : its upload folder), not trashed, within the upload size limit
    if (!meta || !meta.exists) return notFound();
    if (Number(meta.size) > MAX_FILE_SIZE_BYTES) return notFound();

    // byte ceiling per user per hour (Drive size from metadata, counted before the content is requested) ; fail closed
    const size = Math.max(1, Math.floor(Number(meta.size) || 0));
    const bytes = await db.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?, ?, ?) ON CONFLICT(userId, windowStart) DO UPDATE SET n = n + ? RETURNING n')
      .bind(`dlb:${authUser.userId}`, bucket, size, size).first().catch(() => null);
    if (!bytes) return jsonErr(503, 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'DB_UNAVAILABLE');
    if (Number(bytes.n) > MAX_DOWNLOAD_BYTES_PER_HOUR) return jsonErr(429, 'เปิดไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMITED');

    let upstream;
    try { upstream = await storage.open(ref); } catch (e) {
      if (e && (e.status === 404 || e.status === 403)) return notFound();
      throw e;
    }
    if (!upstream) return notFound();

    // our own record of the type (validated against the magic bytes at upload) ; Drive's type only if ours is missing ; both through the allow-list
    const type = safeContentType(row.mimeType) || safeContentType(meta.mimeType);
    const wantDownload = new URL(request.url).searchParams.get('download') === '1';
    const inline = Boolean(type && INLINE_TYPES.has(type)) && !wantDownload;
    const headers = new Headers();
    for (const [k, v] of Object.entries(corsHeaders || {})) if (k.toLowerCase() !== 'content-type') headers.set(k, v);
    headers.set('Content-Type', type || 'application/octet-stream');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.fileName || `file_${fileId.slice(0, 8)}`));
    headers.set('Cache-Control', 'private, max-age=300');
    headers.set('Vary', 'Origin, Authorization');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Referrer-Policy', 'no-referrer');
    if (Number.isFinite(upstream.size) && upstream.size >= 0) headers.set('Content-Length', String(upstream.size));
    return new Response(upstream.body, { status: 200, headers }); // streamed, not buffered
  } catch (err) {
    console.error('[files] failed:', err && err.code ? err.code : 'INTERNAL_ERROR'); // never Google's message / the token
    const code = err && err.code;
    if (code === 'DRIVE_NOT_CONFIGURED') return jsonErr(503, 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', code);
    if (code === 'STORAGE_NOT_CONFIGURED') return jsonErr(503, 'ระบบจัดเก็บไฟล์ยังไม่ได้ตั้งค่าที่เก็บไฟล์ กรุณาติดต่อผู้ดูแลระบบ', code);
    if (code === 'DRIVE_API_ERROR' || code === 'DRIVE_AUTH_FAILED' || code === 'STORAGE_ERROR') return jsonErr(502, 'ไม่สามารถเปิดไฟล์จากระบบจัดเก็บได้ กรุณาลองใหม่ภายหลัง', code);
    return jsonErr(500, 'เกิดข้อผิดพลาดภายในระบบ', 'INTERNAL_ERROR');
  }
}
