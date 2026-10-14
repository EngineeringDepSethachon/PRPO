// POST /api/upload : file -> the storage backend (Cloudflare R2 by default ; Google Drive through the Service Account when FILE_STORAGE=drive) + attachments row in D1.
// Called from functions/api/[[route]].js AFTER authentication + RBAC (rule 'misc-auth' = AUTH) ; document-level permission is checked here.
// Request body (what src/services/driveService.js sends) : JSON { base64Data, mimeType, fileName, category, poNumber, docNo, docType, [docRef], [department] }

import { validateUpload, publicError, DriveError, MAX_FILE_SIZE_BYTES } from './storage/common.js';
import { getStorage } from './storage/index.js';
import { canAccessDepartment, canEditPrContent, normalizeDeptCode, isWildcardDept, normalizeUser } from './rbac.js';

export const MAX_UPLOADS_PER_HOUR = 60;      // per user, successful uploads (attachments table)
export const MAX_ATTEMPTS_PER_HOUR = 120;    // per user, every request incl. rejected / failed ones (upload_attempts, migration 0009)
export const MAX_FILES_PER_DOC = 40;         // per category + document
export const RATE_WINDOW_MS = 60 * 60 * 1000;
// base64 inflates 4/3 ; 1.37 leaves room for JSON keys / data-url header / small metadata
export const MAX_JSON_BYTES = Math.ceil(MAX_FILE_SIZE_BYTES * 1.37) + 64 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_SIZE_BYTES / 3) * 4;
const FORBIDDEN_MSG = 'ไม่มีสิทธิ์ดำเนินการนี้';

// Largest data: URL string a PR / PO write may carry (client compresses item images to <=150 KB => ~205k chars). Bigger ones must go through /api/upload.
export const MAX_DATA_URL_CHARS = 400000;
export const DATA_URL_TOO_LARGE_MSG = 'รูปภาพที่ฝังในเอกสารมีขนาดใหญ่เกินไป กรุณาอัปโหลดไฟล์ผ่านระบบจัดเก็บไฟล์';

export const TOO_DEEP_MSG = 'โครงสร้างข้อมูลซ้อนลึกเกินไป';

/** -> 'deep' (nested over 12 levels / too many nodes) | 'big' (a "data:" string longer than max) | null */
export function inspectBody(value, max = MAX_DATA_URL_CHARS) {
  const stack = [[value, 0, '']];
  let visited = 0;
  let big = false;
  while (stack.length) {
    const [v, depth, key] = stack.pop();
    if (typeof v === 'string') {
      // signature fields are not rejected here : sanitize.js blanks an unsupported / too large signature so review / approve keep working
      if (v.length > max && /^data:/i.test(v.slice(0, 40).trimStart()) && !/signature/i.test(key)) big = true;
    } else if (v && typeof v === 'object') {
      if (depth >= 12 || visited++ >= 200000) return 'deep';
      for (const k of Object.keys(v)) stack.push([v[k], depth + 1, k]);
    }
  }
  return big ? 'big' : null;
}

/** -> { status, message } to answer with, or null. Too deep = 400 (own message), big embedded image = 413. */
export function checkBodyShape(value) {
  const r = inspectBody(value);
  if (r === 'deep') return { status: 400, message: TOO_DEEP_MSG };
  if (r === 'big') return { status: 413, message: DATA_URL_TOO_LARGE_MSG };
  return null;
}

export const hasOversizedDataUrl = (value, max = MAX_DATA_URL_CHARS) => inspectBody(value, max) !== null;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const CATEGORY_CODES = {
  PR: 'PR', '01_PR_ATTACHMENTS': 'PR',
  PO: 'PO', '02_PO_DOCUMENTS': 'PO',
  GRN: 'GRN', '03_GRN_EVIDENCE': 'GRN',
  CLAIM: 'CLAIM', '04_CLAIM_EVIDENCE': 'CLAIM'
};

function cleanStr(v, max) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function decodeBase64(b64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new DriveError('VALIDATION_ERROR', 'invalid base64');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  const SLICE = 1 << 20; // multiple of 4 ; avoids one giant binary string
  let o = 0;
  for (let i = 0; i < b64.length; i += SLICE) {
    const bin = atob(b64.slice(i, i + SLICE));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}

async function readBody(request) {
  const ct = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.includes('application/json')) throw new HttpError(415, 'รองรับเฉพาะการอัปโหลดแบบ JSON (base64)', 'UNSUPPORTED_MEDIA_TYPE');
  // size gate BEFORE reading the body : no Content-Length (chunked) or too large -> 413
  const lenHeader = request.headers.get('Content-Length');
  const len = lenHeader === null || lenHeader === '' ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len < 0 || len > MAX_JSON_BYTES) {
    throw new HttpError(413, `ขนาดคำขอเกินกำหนด (ไฟล์ไม่เกิน ${MAX_FILE_SIZE_BYTES / 1048576} MB)`, 'FILE_TOO_LARGE');
  }
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง', 'VALIDATION_ERROR'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง', 'VALIDATION_ERROR');
  return body;
}

async function findPo(db, ref) {
  return db.prepare('SELECT id, poNumber, department, status FROM pos WHERE poNumber = ? OR id = ? ORDER BY (poNumber = ?) DESC LIMIT 1')
    .bind(ref, ref, ref).first().catch(() => null);
}
async function findPr(db, ref) {
  return db.prepare('SELECT id, prNumber, department, status FROM prs WHERE prNumber = ? OR id = ? ORDER BY (prNumber = ?) DESC LIMIT 1')
    .bind(ref, ref, ref).first().catch(() => null);
}

/** Resolve + authorize the target document. -> { docRef, department } */
async function resolveTarget(db, authUser, category, body) {
  const ref = cleanStr(body.docRef || body.poNumber || body.docNo, 120);
  if (category === 'PR') {
    if (ref) {
      const pr = await findPr(db, ref);
      if (!pr) throw new HttpError(404, 'ไม่พบเอกสาร PR ที่อ้างอิง', 'NOT_FOUND');
      if (!canAccessDepartment(authUser, pr.department)) throw new HttpError(403, FORBIDDEN_MSG, 'FORBIDDEN');
      // files are attached to a PR only while its content can still be edited (client: PRCreateView = create / edit draft or review stage)
      if (!canEditPrContent(authUser, pr.status)) throw new HttpError(403, FORBIDDEN_MSG, 'FORBIDDEN');
      return { docRef: pr.prNumber, department: pr.department };
    }
    // attachment added while a new PR is still being created : own department only, no number-based folder
    const dept = cleanStr(body.department || authUser.department, 40);
    if (!dept || (isWildcardDept(dept) && !normalizeUser(authUser).isAdmin)) throw new HttpError(403, FORBIDDEN_MSG, 'FORBIDDEN');
    const code = normalizeDeptCode(dept);
    if (!canAccessDepartment(authUser, code)) throw new HttpError(403, FORBIDDEN_MSG, 'FORBIDDEN');
    return { docRef: '', department: code };
  }
  // PO / GRN / CLAIM : the PO must exist
  if (!ref) throw new HttpError(400, 'ต้องระบุเลขที่เอกสารอ้างอิง', 'VALIDATION_ERROR');
  const po = await findPo(db, ref);
  if (!po) throw new HttpError(404, 'ไม่พบเอกสาร PO ที่อ้างอิง', 'NOT_FOUND');
  if (!canAccessDepartment(authUser, po.department)) throw new HttpError(403, FORBIDDEN_MSG, 'FORBIDDEN');
  if (category === 'GRN' && String(po.status || '').toUpperCase() === 'CANCELLED') {
    throw new HttpError(409, 'PO นี้ถูกยกเลิกแล้ว ไม่สามารถแนบหลักฐานตรวจรับ', 'CONFLICT');
  }
  return { docRef: po.poNumber, department: po.department };
}

export async function handleUpload({ request, env, db, authUser, jsonResponse, errorResponse, audit, uid }) {
  const fail = (status, message, code) => {
    const res = errorResponse(message, status);
    return code ? new Response(JSON.stringify({ error: message, code, success: false }), { status, headers: res.headers }) : res;
  };
  try {
    if (!db) return fail(503, 'ฐานข้อมูลยังไม่พร้อมใช้งาน', 'DB_UNAVAILABLE');

    // rate limit on ATTEMPTS, before the body is read : failed / rejected requests count too (fail closed if the counter is unavailable)
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    const att = await db.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?, ?, 1) ON CONFLICT(userId, windowStart) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(authUser.userId, bucket).first().catch(() => null);
    if (!att) return fail(503, 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'DB_UNAVAILABLE');
    if (Number(att.n) === 1) await db.prepare('DELETE FROM upload_attempts WHERE windowStart < ?').bind(bucket - RATE_WINDOW_MS).run().catch(() => {});
    if (Number(att.n) > MAX_ATTEMPTS_PER_HOUR) return fail(429, 'อัปโหลดไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMITED');

    const body = await readBody(request);

    const category = CATEGORY_CODES[String(body.category || '').toUpperCase().trim()];
    if (!category) throw new HttpError(400, 'ประเภทเอกสารไม่ถูกต้อง', 'VALIDATION_ERROR');

    let b64 = typeof body.base64Data === 'string' ? body.base64Data : '';
    delete body.base64Data; // drop the second reference to the big string as early as possible
    let declaredMime = body.mimeType;
    const hdr = b64.slice(0, 200).match(/^data:([^;,]*)(;[^,]*)?;base64,/i);
    if (hdr) { b64 = b64.slice(hdr[0].length); if (hdr[1]) declaredMime = hdr[1]; }
    if (!b64) throw new DriveError('VALIDATION_ERROR', 'missing file data');
    if (b64.length > MAX_BASE64_CHARS) throw new DriveError('FILE_TOO_LARGE', 'file too large'); // before decode
    const bytes = decodeBase64(b64);
    b64 = ''; // let the big string go
    const v = validateUpload({ name: body.fileName || `file_${Date.now()}`, mimeType: declaredMime, bytes });

    const target = await resolveTarget(db, authUser, category, body);

    // rate limits (counted from attachments rows) : per user per hour, and per document
    const now = Date.now();
    const perUser = await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE uploaderId = ? AND createdAtMs > ?')
      .bind(authUser.userId, now - RATE_WINDOW_MS).first().catch(() => null);
    if (perUser && Number(perUser.n) >= MAX_UPLOADS_PER_HOUR) {
      return fail(429, 'อัปโหลดไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMITED');
    }
    if (target.docRef) {
      const perDoc = await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE category = ? AND docRef = ?')
        .bind(category, target.docRef).first().catch(() => null);
      if (perDoc && Number(perDoc.n) >= MAX_FILES_PER_DOC) {
        return fail(429, 'จำนวนไฟล์แนบของเอกสารนี้ถึงขีดจำกัดแล้ว', 'RATE_LIMITED');
      }
    }

    // the backend for NEW files comes from env.FILE_STORAGE (default r2) ; the key / folder is built on the server from allow-listed parts
    const storage = getStorage(env);
    const up = await storage.put({
      name: v.name, mimeType: v.mimeType, bytes: v.bytes, category, docRef: target.docRef, uploaderId: authUser.userId, date: new Date(now)
    });

    const attachmentId = `ATT-${uid()}`;
    const uploadedAt = new Date(now).toISOString();
    const folderPath = up.folderPath;
    const docType = cleanStr(body.docType || category, 50) || category;
    try {
      await db.prepare(`INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, poNumber, docNo, docType, viewUrl, directUrl, lh3Url, downloadUrl, folderId, folderPath, uploadedBy, uploadedAt, uploaderId, docRef, createdAtMs, sharedPublic, storage, objectKey)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(attachmentId, up.fileId, up.name, up.mimeType, up.size, category,
          category === 'PR' ? '' : target.docRef, target.docRef, docType,
          up.viewUrl, up.directUrl, up.lh3Url, up.downloadUrl, up.folderId, folderPath,
          authUser.name || authUser.username || authUser.userId, uploadedAt, authUser.userId, target.docRef, now, up.sharedPublic ? 1 : 0,
          up.storage, up.objectKey || null)
        .run();
    } catch {
      const trashed = await storage.trash(up); // no orphan : same as GAS TRANSACTION_FAILED (recoverable : Drive trash / R2 trash/ prefix)
      // trace of the rollback (ids / key only, never the content) ; best effort : the database that just failed may fail again
      try { await audit('FILE_UPLOAD_ROLLBACK', 'attachment', attachmentId, { category, docRef: target.docRef, fileId: up.fileId, storage: up.storage, objectKey: up.objectKey || null, trashed }); } catch { /* ignore */ }
      return fail(500, 'ไม่สามารถบันทึกประวัติไฟล์ได้', 'INTERNAL_ERROR');
    }
    await audit('FILE_UPLOAD', 'attachment', attachmentId, { category, docRef: target.docRef, fileId: up.fileId, size: up.size, storage: up.storage });

    return jsonResponse({
      success: true,
      attachmentId,
      fileId: up.fileId,
      fileUrl: v.mimeType.startsWith('image/') ? up.directUrl : up.viewUrl,
      viewUrl: up.viewUrl,
      directUrl: up.directUrl,
      lh3Url: up.lh3Url,
      downloadUrl: up.downloadUrl,
      fileName: up.name,
      mimeType: up.mimeType,
      fileSize: up.size,
      folderPath,
      sharedPublic: up.sharedPublic,
      uploadedAt
    });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.code);
    const pub = publicError(err);
    // only the code is logged : never the body, token or Google's message
    console.error('[upload] failed:', pub.code);
    return fail(pub.status, pub.message, pub.code);
  }
}
