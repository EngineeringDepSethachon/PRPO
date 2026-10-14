// Write-side sanitizing of file / link fields in PR, PO, receive and settle bodies (T2.1c kla finding). Key table: docs/parity.md ("ช่อง URL/ไฟล์").
//   file URL fields (attachments, images, quotationFiles, grAttachments, evidence photos, settlementProofUrl ...) accept only :
//     https://drive.google.com/... , https://docs.google.com/... , https://lh3.googleusercontent.com/... (+ drive.usercontent.google.com),
//     data:image/(png|jpeg|webp|gif);base64 (and data:application/pdf for legacy small PDFs), a bare Drive file id / legacy placeholder.
//   anything else is cut to '' (the flow keeps working) ; 400 only for javascript: vbscript: file: data:text/html and svg data.
//   external links (onlineUrl, productUrl, onlineLink, link, itemUrl, storeUrl, specUrl, quotationUrl, url outside attachments) : the http(s) URL
//     is kept (or extracted from free text such as "Shopee: https://..") ; scheme-less text kept ; other schemes (mailto:, line://) cut to ''.
//   signature fields : data:image or Drive URL or plain text kept ; foreign http(s) cut ; dangerous schemes 400.
//   a fileId is kept only when the file is in attachments for a document the caller may reach (or was uploaded by the caller), or already sits
//   in a stored PR / PO the caller may reach ; otherwise the file's Drive URLs are cleared.

import { normalizeUser } from './rbac.js';
import { attachmentRowAccess, fileIdsHeldByDocs } from './filerefs.js'; // (filerefs imports fileIdsIn from here : only used at call time)

export const MAX_DEPTH = 12;
export const MAX_DATA_URL_CHARS = 400000;
export const TOO_DEEP_MSG = 'โครงสร้างข้อมูลซ้อนลึกเกินไป';

const FILE_URL_KEYS = new Set([
  'previewurl', 'dataurl', 'fileurl', 'viewurl', 'directurl', 'lh3url', 'downloadurl', 'driveurl', 'thumbnailurl', 'localurl',
  'settlementproofurl', 'claimphoto', 'photo', 'proofurl', 'imageurl', 'photourl'
]);
// signature fields : any key ending in "signature" (signature, requesterSignature, reviewerSignature, approverSignature, receiverSignature ...) + signatureUrl
const isSignatureKey = (lk) => lk.endsWith('signature') || lk === 'signatureurl';
// specUrl : PRCreateView stores the first quotation's FILE NAME ; viewers (PO/PR details, OnlineOrderCard) open it as a "link" -> external-link group
const STORE_LINK_KEYS = new Set(['onlineurl', 'producturl', 'onlinelink', 'link', 'itemurl', 'storeurl', 'specurl', 'quotationurl']);
// arrays whose elements are file objects / file URLs
const ATTACH_ARRAY_KEYS = new Set([
  'attachments', 'images', 'quotationfiles', 'generalattachments', 'defectimages', 'photos', 'files', 'receiptphotos', 'evidencephotos',
  'evidenceattachments', 'grattachments', 'prattachments'
]);
const DRIVE_URL_FIELDS = ['url', 'previewUrl', 'viewUrl', 'directUrl', 'lh3Url', 'downloadUrl', 'driveUrl', 'fileUrl', 'thumbnailUrl'];

const DRIVE_HOST_RE = /^https:\/\/(drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com|lh[3-6]\.googleusercontent\.com)\//i;
// R2 files are referenced by the relative proxy URL /api/files/<id> (storage/r2.js publicUrl) : this exact shape only, no host, no other path
const R2_FILE_URL_RE = /^\/api\/files\/([A-Za-z0-9_-]{10,128})(\?download=1)?$/;
const DATA_OK_RE = /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=\s]*$/i;
const BARE_ID_RE = /^[A-Za-z0-9_-]{10,80}$/; // Drive file id or the old "STORED_IN_DRIVE"-style placeholders
// the only values refused with 400 (never in signature fields). SVG data URLs are NOT refused : the client's own demo item images are
// SVG data URLs (FALLBACK_SEED_ATTACHMENTS) - they are simply not stored by the file-field rule (cut to '').
const DANGEROUS_RE = /^\s*(javascript|vbscript|file)\s*:|^\s*data:text\/html/i;
const SCHEME_RE = /^\s*([a-z][a-z0-9+.-]*):(?!\d)/i;
const KNOWN_NON_HTTP_SCHEMES = new Set(['mailto', 'line', 'ftp', 'blob', 'data']);
const HTTP_IN_TEXT_RE = /https?:\/\/[^\s"'<>]+/i;

class Bad extends Error { constructor(status, message) { super(message); this.status = status; } }
const BAD_LINK = 'ลิงก์ไม่ถูกต้อง';
const TOO_BIG_MSG = 'รูปภาพที่ฝังในเอกสารมีขนาดใหญ่เกินไป กรุณาอัปโหลดไฟล์ผ่านระบบจัดเก็บไฟล์';

function checkDataSize(s) {
  if (s.length > MAX_DATA_URL_CHARS) throw new Bad(413, TOO_BIG_MSG);
}

// value as the browser would see it for scheme purposes : leading control chars / blanks removed, tab / CR / LF removed everywhere
// ("java\tscript:" and "\u0001javascript:" are still javascript:)
// eslint-disable-next-line no-control-regex
const normForCheck = (v) => String(v).replace(/[\t\r\n]/g, '').replace(/^[\u0000- ]+/, '').trim();

/** -> cleaned value ('' = dropped). Throws Bad for dangerous schemes / oversized data. */
export function checkFileUrl(v) {
  const s = normForCheck(v);
  if (!s) return '';
  if (/^blob:/i.test(s)) return ''; // dead after the page session ; harmless, just not stored
  if (DANGEROUS_RE.test(s)) throw new Bad(400, BAD_LINK);
  if (/^data:/i.test(s)) {
    if (!DATA_OK_RE.test(s)) return ''; // svg, bmp, tiff ... : not stored, flow continues
    checkDataSize(s);
    return s;
  }
  if (DRIVE_HOST_RE.test(s)) return s;
  if (R2_FILE_URL_RE.test(s)) return s; // our own authenticated proxy path ; its id is verified like a Drive id (driveIdFromUrl)
  if (BARE_ID_RE.test(s)) return s;
  return '';
}

/** external link / free text. -> value to store. Throws Bad (400) only for javascript: vbscript: file: data:text/html. */
export function checkStoreLink(v) {
  const s = normForCheck(v);
  if (!s) return v;
  if (DANGEROUS_RE.test(s)) throw new Bad(400, BAD_LINK);
  if (/^https?:\/\//i.test(s)) return v;
  const m = s.match(SCHEME_RE);
  if (m) {
    if (KNOWN_NON_HTTP_SCHEMES.has(m[1].toLowerCase())) return ''; // mailto: line:// ftp:// blob: data: -> cut silently
    // free text that merely looks like "word:" ("Shopee: ร้าน A") stays as typed ; a URL inside it is the only thing kept if there is one
    const inText = s.match(HTTP_IN_TEXT_RE);
    return inText ? inText[0] : v;
  }
  return v; // scheme-less ("shopee.co.th/p/1", a file name) : the client adds https:// when it opens it
}

/** Signature fields never fail the request (review / approve must keep working) : unsupported -> '' . */
function checkSignature(v) {
  const s = normForCheck(v);
  if (!s) return v;
  if (DANGEROUS_RE.test(s) || /^blob:/i.test(s)) return '';
  if (/^data:/i.test(s)) return DATA_OK_RE.test(s) && s.length <= MAX_DATA_URL_CHARS ? s : ''; // svg / bmp / too large
  if (/^https?:\/\//i.test(s)) return DRIVE_HOST_RE.test(s) ? s : '';
  return v; // plain text (typed name, id)
}

const SIGNATURE_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;
export const SIGNATURE_BAD_MSG = 'รูปลายเซ็นไม่ถูกต้อง ต้องเป็นไฟล์ PNG, JPG หรือ WebP ขนาดไม่เกิน ~300 KB กรุณาอัปโหลดหรือวาดลายเซ็นใหม่';
/** Saving a user's e-signature (POST/PUT /api/users). -> error message (400) or ''. */
export function checkUserSignature(v) {
  if (typeof v !== 'string') return SIGNATURE_BAD_MSG;
  const s = normForCheck(v);
  if (!s) return '';
  if (s.length <= MAX_DATA_URL_CHARS && SIGNATURE_DATA_RE.test(s)) return '';
  if (DRIVE_HOST_RE.test(s)) return '';
  return SIGNATURE_BAD_MSG;
}

// the client keeps the Drive file id in `fileId` and often also in `id` (PRCreateView sanitizeAttachment: id = f.id || f.fileId) -> check both
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{25,}$/;
const URL_ID_RES = [/\/d\/([A-Za-z0-9_-]{20,})/, /[?&]id=([A-Za-z0-9_-]{20,})/];
/** Drive file id inside a Drive / lh3 / docs URL ('' when the value is not such a URL). */
export function driveIdFromUrl(u) {
  const s = normForCheck(u);
  const r2 = s.match(R2_FILE_URL_RE);
  if (r2) return r2[1];
  if (!DRIVE_HOST_RE.test(s)) return '';
  for (const re of URL_ID_RES) { const m = s.match(re); if (m) return m[1]; }
  return '';
}
const PLACEHOLDER_RE = /BASE64_|STORED_IN_DRIVE/;
/**
 * THE one definition of "this value points at a Drive file" for a file field : the id inside a Drive / lh3 / docs URL, or a bare Drive id.
 * The write side (walk -> allowedFileIds) and the read side (fileIdsIn -> file_refs / GET /api/files/:id) both use it, so what can open a file is
 * exactly what was checked when it was written.
 */
export function fileRefOf(v) {
  if (typeof v !== 'string') return '';
  const s = normForCheck(v);
  const fromUrl = driveIdFromUrl(s);
  if (fromUrl) return fromUrl;
  return DRIVE_ID_RE.test(s) && !PLACEHOLDER_RE.test(s) ? s : '';
}
/** every Drive id an attachment object points at : [{ field, id }] (fileId, id, and the id inside each URL field) */
function driveRefs(node) {
  const out = [];
  if (typeof node.fileId === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(node.fileId)) out.push({ field: 'fileId', id: node.fileId });
  if (typeof node.id === 'string' && DRIVE_ID_RE.test(node.id)) out.push({ field: 'id', id: node.id });
  for (const f of DRIVE_URL_FIELDS) {
    if (typeof node[f] === 'string') { const id = driveIdFromUrl(node[f]); if (id) out.push({ field: f, id }); }
  }
  return out;
}

// keys whose value may arrive as a JSON STRING instead of an array / object ('[]' columns written by older clients) : parsed and walked
const JSON_STRING_ARRAY_KEYS = new Set([...ATTACH_ARRAY_KEYS, 'items']);
const JSON_STRING_OBJECT_KEYS = new Set(['evidence', 'claimevidence', 'storeclaims']);
function parseJsonField(v, wantArray) {
  const t = v.trim();
  if (!t || (t[0] !== '[' && t[0] !== '{')) return undefined; // not JSON : caller decides
  try {
    const p = JSON.parse(t);
    return p && typeof p === 'object' ? p : (wantArray ? [] : {});
  } catch {
    return wantArray ? [] : {}; // unparsable -> empty, never stored as a raw string
  }
}

function walk(node, depth, key, inAttach, st) {
  if (depth > MAX_DEPTH) throw new Bad(400, TOO_DEEP_MSG);
  if (Array.isArray(node)) {
    const attachArr = ATTACH_ARRAY_KEYS.has(String(key).toLowerCase());
    for (let i = node.length - 1; i >= 0; i--) {
      const el = node[i];
      if (typeof el === 'string') {
        if (attachArr) {
          const c = checkFileUrl(el);
          if (c === '') { node.splice(i, 1); continue; }
          node[i] = c;
          const id = driveIdFromUrl(c);
          if (id) st.strRefs.push({ arr: node, value: c, id });
        } else if (/^(javascript|vbscript)\s*:/i.test(normForCheck(el))) {
          throw new Bad(400, BAD_LINK);
        }
      } else if (el && typeof el === 'object') {
        walk(el, depth + 1, key, attachArr, st);
      }
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (inAttach) st.fileObjs.push(node);
  for (const k of Object.keys(node)) {
    let v = node[k];
    const lk = k.toLowerCase();
    if (typeof v === 'string') {
      // JSON text where a list / object belongs : parse, then it is checked like the real thing (depth keeps counting)
      const asArray = JSON_STRING_ARRAY_KEYS.has(lk);
      if (asArray || JSON_STRING_OBJECT_KEYS.has(lk)) {
        const parsed = parseJsonField(v, asArray);
        if (parsed !== undefined) {
          node[k] = parsed;
          walk(parsed, depth + 1, k, false, st);
          continue;
        }
        if (ATTACH_ARRAY_KEYS.has(lk)) { node[k] = checkFileUrl(v); continue; } // a single file URL given as text
      }
      if (FILE_URL_KEYS.has(lk) || (lk === 'url' && inAttach)) {
        node[k] = checkFileUrl(v);
        const id = fileRefOf(node[k]);
        if (id) st.keyRefs.push({ node, key: k, id }); // verified like attachment ids (a file field that is not allowed is cleared)
      } else if (isSignatureKey(lk)) node[k] = checkSignature(v);
      else if (STORE_LINK_KEYS.has(lk) || lk === 'url') node[k] = checkStoreLink(v);
    } else if (v && typeof v === 'object') {
      walk(v, depth + 1, k, false, st);
    }
  }
}

/** the same checks for one stand-alone URL field (users.pictureUrl). -> { value } | { status, message } */
export function sanitizeUrlField(v) {
  try {
    // users.pictureUrl is rendered by a plain <img src> (no Authorization header) : the /api/files/ proxy path cannot work there and there is no
    // profile-picture upload yet -> only the Drive allow-list + data:image as before. If a profile upload is added: ProxiedImg + verify the id.
    if (R2_FILE_URL_RE.test(normForCheck(v))) return { value: '' };
    return { value: checkFileUrl(v) };
  } catch (e) {
    if (e instanceof Bad) return { status: e.status, message: e.message };
    throw e;
  }
}

/**
 * Drive ids a stored document / line item REALLY holds as files : the same positions walk() treats as files (file objects inside the attachment arrays,
 * Drive URLs in those arrays, the single file-URL fields). An id that only appears inside free text (note, description, name ...) is NOT included -
 * a substring match must never grant access (a user can type any id into a free-text field of his own document).
 * @param {string|object} value JSON text or parsed value ; hintKey : the column / key the value came from (e.g. 'attachments')
 * @returns {Set<string>}
 */
export function fileIdsIn(value, hintKey = '') {
  const out = new Set();
  const visit = (node, depth, key, inAttach) => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const attachArr = ATTACH_ARRAY_KEYS.has(String(key).toLowerCase());
      for (const el of node) {
        if (typeof el === 'string') {
          if (attachArr) { const id = driveIdFromUrl(el); if (id) out.add(id); }
        } else if (el && typeof el === 'object') visit(el, depth + 1, key, attachArr);
      }
      return;
    }
    if (inAttach) for (const r of driveRefs(node)) out.add(r.id);
    for (const k of Object.keys(node)) {
      const v = node[k];
      const lk = k.toLowerCase();
      if (typeof v === 'string') {
        const asArray = JSON_STRING_ARRAY_KEYS.has(lk);
        if (asArray || JSON_STRING_OBJECT_KEYS.has(lk)) {
          const parsed = parseJsonField(v, asArray);
          if (parsed !== undefined) { visit(parsed, depth + 1, k, false); continue; }
        }
        if (FILE_URL_KEYS.has(lk) || (lk === 'url' && inAttach)) {
          const id = fileRefOf(v);
          if (id) out.add(id);
        }
      } else if (v && typeof v === 'object') visit(v, depth + 1, k, false);
    }
  };
  const parsed = typeof value === 'string' ? parseJsonField(value, true) : value;
  if (parsed && typeof parsed === 'object') visit(parsed, 0, hintKey, false);
  return out;
}

// ── fileId scope ──
// Same rule as GET /api/files/:id (filerefs.attachmentRowAccess : a PR row by prNumber, a PO row by poNumber-first, a deleted PR only through a PO made
// from it), plus the write-side extras : an admin, and the uploader himself. The stored-document search (a full table scan when the file_refs
// index has no answer : legacy / imported ids, rows without a document) is a quota-limited fallback - see makeScanGate.
export const MAX_FALLBACK_SCANS_PER_REQUEST = 5;  // ids per request that may trigger a fallback scan ; further ids are not scanned (= not allowed -> cleared)
export const MAX_FALLBACK_SCANS_PER_MINUTE = 20;  // per user, counted in D1 (upload_attempts, key `fs:<userId>`, minute window) - shared by all isolates
export const FALLBACK_SCAN_WINDOW_MS = 60 * 1000;

/**
 * async () => boolean : may ONE more fallback scan run for this request/user ? Fails closed (no counter = no scan).
 * gate.reason is set to 'quota' | 'db' whenever the answer is false, so the caller can tell "refused for lack of quota / counter" (undecided : the
 * request is answered 429 / 503 and nothing is cut) from "checked and not allowed" (the field is cleared as before).
 */
function makeScanGate(db, authUser) {
  let used = 0;
  const gate = async () => {
    if (used >= MAX_FALLBACK_SCANS_PER_REQUEST) { gate.reason = 'quota'; return false; }
    used += 1;
    const bucket = Math.floor(Date.now() / FALLBACK_SCAN_WINDOW_MS) * FALLBACK_SCAN_WINDOW_MS;
    const row = await db.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?, ?, 1) ON CONFLICT(userId, windowStart) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(`fs:${authUser.userId}`, bucket).first().catch(() => null);
    if (!row) { gate.reason = 'db'; return false; }
    // only this key's old minute rows (the hourly upload / download counters share the table and must stay)
    if (Number(row.n) === 1) await db.prepare("DELETE FROM upload_attempts WHERE userId LIKE 'fs:%' AND windowStart < ?").bind(bucket - FALLBACK_SCAN_WINDOW_MS).run().catch(() => {});
    if (Number(row.n) > MAX_FALLBACK_SCANS_PER_MINUTE) { gate.reason = 'quota'; return false; }
    return true;
  };
  gate.reason = null;
  return gate;
}

async function fileIdAllowed(db, authUser, id, scanGate) {
  const atts = ((await db.prepare('SELECT * FROM attachments WHERE fileId = ? LIMIT 10').bind(id).all()).results) || [];
  return Boolean(await attachmentRowAccess(db, authUser, id, atts, {
    uploaderAlways: true, admin: normalizeUser(authUser).isAdmin && atts.length > 0, noRowsFallback: true, scanGate
  }));
}

export const QUOTA_MSG = 'ตรวจสอบไฟล์แนบบ่อยเกินไป กรุณารอสักครู่แล้วลองบันทึกใหม่';
export const UNVERIFIED_MSG = 'ระบบตรวจสอบไฟล์แนบยังไม่พร้อมใช้งาน กรุณาลองบันทึกใหม่ภายหลัง';

/**
 * -> { allowed: Set, undecided: 'quota' | 'db' | null }
 *  - an id the stored document being saved ALREADY holds (`held`) is allowed with no check at all (a re-save keeps its own files) ;
 *  - the others are checked (attachments rows, then the quota-limited stored-document search) : false = checked and not allowed (the field is cleared) ;
 *  - an id that could not be decided (no quota left / counter or database error) makes `undecided` non-null : the caller answers 429 / 503 and
 *    writes NOTHING, instead of silently dropping a link that may be legitimate.
 */
async function verifyFileIds(db, authUser, ids, held) {
  const allowed = new Set();
  const gate = makeScanGate(db, authUser);
  let undecided = null;
  let checked = 0;
  for (const id of ids) {
    if (held.has(id)) { allowed.add(id); continue; }
    if (checked++ >= 100) continue; // more than 100 distinct new ids in one body : the rest is not allowed
    gate.reason = null;
    try {
      if (await fileIdAllowed(db, authUser, id, gate)) allowed.add(id);
      else if (gate.reason) undecided = undecided === 'db' ? 'db' : gate.reason;
    } catch {
      undecided = 'db';
      break;
    }
  }
  return { allowed, undecided };
}

const DOC_KEY_FIELDS = ['id', 'poId', 'prId', 'prNumber', 'prNo', 'poNumber', 'poNo'];
/** ids / numbers in the body (and the URL's :id) that name stored documents */
function docKeysOf(body, hint) {
  const keys = new Set();
  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of DOC_KEY_FIELDS) if (typeof o[k] === 'string' && o[k].trim() && o[k].length <= 300) keys.add(o[k].trim());
  };
  if (Array.isArray(body)) body.slice(0, 50).forEach(take); else take(body);
  if (hint && typeof hint.docKey === 'string' && hint.docKey.trim()) keys.add(hint.docKey.trim());
  return [...keys];
}

/**
 * Mutates body in place. -> null when fine, or { status, message } to answer with (nothing is changed in that case for the 429 / 503 answers).
 * hint.docKey : the stored document the request edits (the :id of a PUT / receive / settle) ; documents named by the body itself count too.
 */
export async function sanitizeWriteBody(db, body, authUser, hint = {}) {
  const st = { fileObjs: [], strRefs: [], keyRefs: [] };
  try {
    walk(body, 0, '', false, st);
  } catch (e) {
    if (e instanceof Bad) return { status: e.status, message: e.message };
    throw e;
  }
  if (db && authUser) {
    const objs = st.fileObjs.map((o) => ({ o, refs: driveRefs(o) })).filter((x) => x.refs.length);
    if (objs.length || st.strRefs.length || st.keyRefs.length) {
      const ids = new Set();
      for (const x of objs) for (const r of x.refs) ids.add(r.id);
      for (const s of st.strRefs) ids.add(s.id);
      for (const s of st.keyRefs) ids.add(s.id);
      const held = await fileIdsHeldByDocs(db, authUser, docKeysOf(body, hint));
      const { allowed, undecided } = await verifyFileIds(db, authUser, ids, held);
      if (undecided === 'quota') return { status: 429, message: QUOTA_MSG };
      if (undecided) return { status: 503, message: UNVERIFIED_MSG };
      for (const { o, refs } of objs) {
        const unknown = refs.filter((r) => !allowed.has(r.id));
        if (!unknown.length) continue;
        // one foreign / unverifiable id : none of this attachment's Drive URLs is kept
        for (const f of DRIVE_URL_FIELDS) {
          if (typeof o[f] === 'string' && o[f] && !/^data:/i.test(normForCheck(o[f]))) o[f] = '';
        }
        for (const r of unknown) if (r.field === 'fileId' || r.field === 'id') o[r.field] = '';
      }
      for (const s of st.strRefs) {
        if (allowed.has(s.id)) continue;
        const i = s.arr.indexOf(s.value);
        if (i >= 0) s.arr.splice(i, 1);
      }
      for (const s of st.keyRefs) {
        if (!allowed.has(s.id)) s.node[s.key] = ''; // single file fields (imageUrl, photo, settlementProofUrl ...) : same rule
      }
    }
  }
  return null;
}
