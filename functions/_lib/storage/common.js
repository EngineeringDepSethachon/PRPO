// Shared by every storage backend (R2, Drive) : upload validation, file-name / object-key sanitizing, error mapping.
// Moved out of drive.js (which re-exports the same names, so existing imports keep working). No imports : safe from circular dependencies.

// Same as gas/Config.gs CONFIG.DEFAULTS.MAX_FILE_SIZE_BYTES (20 MB) and ALLOWED_MIME_TYPES.
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

// category code -> folder / key prefix (same names as the Drive folders)
export const DRIVE_CATEGORIES = {
  PR: '01_PR_Attachments',
  PO: '02_PO_Documents',
  GRN: '03_GRN_Evidence',
  CLAIM: '04_Claim_Evidence'
};

export class DriveError extends Error {
  constructor(code, message, status) {
    super(`${code}: ${message}`);
    this.name = 'DriveError';
    this.code = code;
    if (status) this.status = status;
  }
}
export const StorageError = DriveError; // backend-neutral name, same class (codes: STORAGE_NOT_CONFIGURED, STORAGE_ERROR, ...)

// Bidi override/isolate + zero-width/direction marks (filename spoofing, e.g. "gpj.exe" shown as "exe.jpg").
export const BIDI_RE = /[‪-‮⁦-⁩​-‏﻿]/g;

const MIME_EXTS = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/jpg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/msword': ['doc']
};

const startsWith = (b, sig, off = 0) => sig.every((v, i) => b[off + i] === v);
const MAGIC = {
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  'ooxml': (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  'ole': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])
};
function magicKey(mime) {
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime.startsWith('application/vnd.openxmlformats-officedocument')) return 'ooxml';
  if (mime === 'application/vnd.ms-excel' || mime === 'application/msword') return 'ole';
  return mime;
}

export function sanitizeFileName(name) {
  // eslint-disable-next-line no-control-regex
  let s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').replace(BIDI_RE, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '');
  if (s.length > 180) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s || `file_${Date.now()}`;
}

export function validateUpload({ name, mimeType, bytes }) {
  const mime = String(mimeType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    throw new DriveError('UNSUPPORTED_MEDIA_TYPE', `file type "${mime}" is not allowed`);
  }
  let data = bytes;
  if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new DriveError('VALIDATION_ERROR', 'file content is empty or not binary');
  }
  if (data.length > MAX_FILE_SIZE_BYTES) {
    throw new DriveError('FILE_TOO_LARGE',
      `file is ${(data.length / 1048576).toFixed(2)} MB, limit is ${MAX_FILE_SIZE_BYTES / 1048576} MB`);
  }
  if (!MAGIC[magicKey(mime)](data)) {
    throw new DriveError('UNSUPPORTED_MEDIA_TYPE', 'file content does not match its declared type');
  }
  // Extension must belong to the mime; otherwise replace it so the stored name matches the verified type.
  let fname = sanitizeFileName(name);
  const exts = MIME_EXTS[mime];
  const dot = fname.lastIndexOf('.');
  const ext = dot > 0 ? fname.slice(dot + 1).toLowerCase() : '';
  if (!exts.includes(ext)) {
    fname = `${dot > 0 ? fname.slice(0, dot) : fname}.${exts[0]}`;
  }
  return { name: fname, mimeType: mime, bytes: data };
}

/** Map an error to a safe HTTP response. Never exposes Google / R2 / config details (no bucket name, no binding name). */
export function publicError(err) {
  const code = err && err.code;
  switch (code) {
    case 'VALIDATION_ERROR':
      return { status: 400, code, message: 'ข้อมูลไฟล์ไม่ถูกต้อง' };
    case 'FILE_TOO_LARGE':
      return { status: 413, code, message: `ขนาดไฟล์เกินกำหนด (สูงสุด ${MAX_FILE_SIZE_BYTES / 1048576} MB)` };
    case 'UNSUPPORTED_MEDIA_TYPE':
      return { status: 415, code, message: 'ไม่อนุญาตให้อัปโหลดไฟล์ประเภทนี้ หรือเนื้อหาไฟล์ไม่ตรงกับประเภทที่ระบุ' };
    case 'DRIVE_NOT_CONFIGURED':
      return { status: 503, code, message: 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ' };
    case 'STORAGE_NOT_CONFIGURED':
      return { status: 503, code, message: 'ระบบจัดเก็บไฟล์ยังไม่ได้ตั้งค่าที่เก็บไฟล์ กรุณาติดต่อผู้ดูแลระบบ' };
    case 'DRIVE_API_ERROR':
    case 'DRIVE_AUTH_FAILED':
    case 'STORAGE_ERROR':
      return { status: 502, code, message: 'ไม่สามารถบันทึกไฟล์ลงระบบจัดเก็บได้ กรุณาลองใหม่ภายหลัง' };
    default:
      return { status: 500, code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในระบบ' };
  }
}

// ---------- object key (R2) ----------
export const MAX_OBJECT_KEY_CHARS = 700; // R2 limit is 1024 bytes ; Thai names are 3 bytes / char in UTF-8 -> keep well below

/** Resolve a category code ('PR', '03_GRN_Evidence', ...) to its folder name through the allow-list. Anything else throws (never a free-form segment). */
export function categoryFolder(category) {
  const c = String(category == null ? '' : category).trim();
  const up = c.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DRIVE_CATEGORIES, up)) return DRIVE_CATEGORIES[up];
  const hit = Object.values(DRIVE_CATEGORIES).find((v) => v.toUpperCase() === up);
  if (hit) return hit;
  throw new DriveError('VALIDATION_ERROR', 'invalid category');
}

export const MAX_OBJECT_KEY_BYTES = 1000; // R2 limit is 1024 bytes (UTF-8)
const utf8Len = (s) => new TextEncoder().encode(s).length;

/** cut to at most `max` UTF-8 bytes on a code point boundary */
function truncBytes(s, max) {
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = utf8Len(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** One key segment : no slash / backslash / control / bidi, no "." / ".." , letters, marks (Thai vowels / tone marks), digits . _ - only (others -> "_"). Bounded in BYTES. */
export function cleanKeySegment(part, maxBytes = 100) {
  // eslint-disable-next-line no-control-regex
  let s = String(part == null ? '' : part).replace(/[\u0000-\u001f\u007f]/g, '').replace(BIDI_RE, '');
  s = truncBytes(s.replace(/[^\p{L}\p{M}\p{N}._-]/gu, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '_'), maxBytes);
  return s || '_';
}

/** file-name part of a key : base cut by bytes, the (short) extension is kept so the key still ends with the verified type */
function cleanKeyName(name, maxBytes = 300) {
  const clean = sanitizeFileName(name);
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? `.${cleanKeySegment(clean.slice(dot + 1), 20)}` : '';
  const base = cleanKeySegment(ext ? clean.slice(0, dot) : clean, maxBytes - utf8Len(ext));
  return `${base}${ext}`;
}

/** true when `key` is a well-formed key this code could have produced : no "..", no empty / "." segment, no backslash, no control / bidi, bounded length. */
export function isSafeObjectKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_OBJECT_KEY_CHARS || utf8Len(key) > MAX_OBJECT_KEY_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(key) || new RegExp(BIDI_RE.source).test(key)) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** <category folder>/<YYYY>/<MM>/<docRef or _unassigned>/<fileId>__<name>. Month in Asia/Bangkok (same as the Drive folders). Server-side only. */
export function buildObjectKey({ category, docRef, date, fileId, name }) {
  const folder = categoryFolder(category);
  const d = date instanceof Date ? date : new Date(date);
  const bkk = new Date((!isNaN(d.getTime()) ? d.getTime() : Date.now()) + 7 * 3600 * 1000);
  const yyyy = String(bkk.getUTCFullYear());
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  const ref = String(docRef == null ? '' : docRef).trim() ? cleanKeySegment(docRef, 120) : '_unassigned';
  const id = cleanKeySegment(fileId, 64);
  const file = `${id}__${cleanKeyName(name)}`;
  const key = [folder, yyyy, mm, ref, file].join('/');
  if (!isSafeObjectKey(key)) throw new DriveError('VALIDATION_ERROR', 'invalid object key');
  return key;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
