// POST /api/admin/cleanup-orphans and POST /api/admin/restore-orphan : orphan files in the project's Drive folder (P6). Called from
// functions/api/[[route]].js AFTER authentication and RBAC (rules 'admin-cleanup-orphans' / 'admin-restore-orphan' = ADMIN). Not a route (folder starts with "_").
//
// An orphan = a file /api/upload put in Drive whose document save never happened (the upload succeeded, the PR / PO save failed or was abandoned) :
//   - an `attachments` row written by the server (folderId set), uploaded more than `olderThanHours` ago (default and minimum 24 h), AND
//   - no document reference on the row (docRef / poNumber / docNo all empty), no other row of the same file with one, not marked yet, AND
//   - no file_refs index row, AND
//   - no stored PR / PO / PR line item holds the id in a file position (exact scan of the tables, filerefs.fileHeldByAnyDoc ; anything uncertain = held).
// DRY RUN BY DEFAULT : the body must say {"dryRun": false} (boolean) to act. Acting only MOVES the Drive file to the Drive trash (recoverable from
// the trash ; never a permanent delete) and marks the attachments row (docGone = 2) so it is not listed again and nobody can open it through the API.
// Order of an action (closes the race with a save that starts to use the file right now) : 1. claim the row with a conditional UPDATE (only while it
// is still unbound and unmarked) - from then on the write side refuses the id, 2. check the documents once more, 3. trash. Anything that goes wrong
// after the claim gives the row back (docGone = 0) except "already gone from Drive".
// POST /api/admin/restore-orphan {fileId} is the way back : untrash in Drive + docGone = 0.
// Bounded work per call (MAX_CHECKS_PER_RUN files verified, MAX_PER_RUN trashed). Dry run never talks to Drive.

import { getStorageFor, refOfRow } from './storage/index.js';
import { fileHeldByAnyDoc } from './filerefs.js';

export const MIN_AGE_HOURS = 24;
export const MAX_PER_RUN = 20;          // orphans listed / trashed per call
export const MAX_CHECKS_PER_RUN = 25;   // files verified per call (each check is several queries : keeps a call far below the subrequest ceiling)
const MAX_CANDIDATE_ROWS = 60;          // rows examined per call (most of them are normally held by a document)
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

export function parseCleanupBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const dryRun = b.dryRun !== false; // only a real boolean false turns it off
  const asked = Number(b.olderThanHours);
  const olderThanHours = Number.isFinite(asked) && asked >= MIN_AGE_HOURS ? Math.min(asked, 24 * 365) : MIN_AGE_HOURS;
  const askedLimit = Math.floor(Number(b.limit));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.min(askedLimit, MAX_PER_RUN) : MAX_PER_RUN;
  return { dryRun, olderThanHours, limit };
}

const UNBOUND_SQL = "COALESCE(docRef, '') = '' AND COALESCE(poNumber, '') = '' AND COALESCE(docNo, '') = ''";

export async function handleCleanupOrphans({ request, env, db, authUser, jsonResponse, errorResponse, audit }) {
  if (!db) return errorResponse('ฐานข้อมูลยังไม่พร้อมใช้งาน', 503);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const { dryRun, olderThanHours, limit } = parseCleanupBody(body);
  const before = Date.now() - olderThanHours * 3600 * 1000;

  let rows;
  try {
    rows = ((await db.prepare(`SELECT id, fileId, fileName, category, folderId, uploadedBy, createdAtMs, storage, objectKey FROM attachments a
      WHERE a.folderId IS NOT NULL AND a.folderId != ''
        AND COALESCE(a.docRef, '') = '' AND COALESCE(a.poNumber, '') = '' AND COALESCE(a.docNo, '') = ''
        AND COALESCE(a.docGone, 0) = 0
        AND a.createdAtMs IS NOT NULL AND a.createdAtMs < ?
        AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.fileId = a.fileId)
        AND NOT EXISTS (SELECT 1 FROM attachments b WHERE b.fileId = a.fileId AND b.id != a.id
          AND (COALESCE(b.docRef, '') != '' OR COALESCE(b.poNumber, '') != '' OR COALESCE(b.docNo, '') != '' OR COALESCE(b.docGone, 0) != 0))
      ORDER BY a.createdAtMs LIMIT ?`).bind(before, MAX_CANDIDATE_ROWS).all()).results) || [];
  } catch {
    return errorResponse('ฐานข้อมูลยังไม่พร้อมใช้งาน (ต้อง apply migration 0011 และ 0013)', 503);
  }

  const orphans = [];
  const seen = new Set();
  let checks = 0;
  let truncated = false;
  for (const r of rows) {
    if (orphans.length >= limit) break;
    if (seen.has(r.fileId)) continue;
    seen.add(r.fileId);
    if (checks >= MAX_CHECKS_PER_RUN) { truncated = true; break; } // stop before the query ceiling : run again for the rest
    checks += 1;
    if (await fileHeldByAnyDoc(db, r.fileId)) continue;
    orphans.push(r);
  }

  const now = Date.now();
  const view = (r) => ({ attachmentId: r.id, fileId: r.fileId, fileName: r.fileName, category: r.category, uploadedBy: r.uploadedBy, ageHours: Math.floor((now - Number(r.createdAtMs)) / 3600000) });
  const brief = (r) => ({ fileId: r.fileId, attachmentId: r.attachmentId || r.id, fileName: r.fileName });
  const out = { success: true, dryRun, olderThanHours, limit, examined: rows.length, checked: checks, truncated, orphanCount: orphans.length, orphans: orphans.map(view) };

  if (dryRun) {
    await audit('ORPHAN_CLEANUP_DRYRUN', 'attachment', '', { actorUserId: authUser.userId, found: orphans.length, files: orphans.map(brief) });
    return jsonResponse(out);
  }

  const trashed = [];
  const skipped = [];
  // each file is handled by the backend stored on its own row ; a backend that is not configured / not reachable stops the run before anything is changed
  const adapters = new Map(); // storage kind -> adapter
  try {
    for (const r of orphans) {
      const ref = refOfRow(r);
      if (!ref || adapters.has(ref.storage)) continue;
      const a = getStorageFor(r, env);
      await a.prepare();
      adapters.set(ref.storage, a);
    }
  } catch (e) {
    console.error('[orphans] storage not ready:', e && e.code ? e.code : 'ERROR');
    return errorResponse('ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน', 503);
  }
  const giveBack = (fileId) => db.prepare('UPDATE attachments SET docGone = 0 WHERE fileId = ? AND docGone = 2').bind(fileId).run().catch(() => {});
  for (const r of orphans) {
    const skip = async (reason, restore = true) => { if (restore) await giveBack(r.fileId); skipped.push({ ...brief(r), reason }); };
    // 1. claim : only while the row is still unbound and unmarked (a save that bound it meanwhile wins)
    const claimed = await db.prepare(`UPDATE attachments SET docGone = 2 WHERE fileId = ? AND ${UNBOUND_SQL} AND COALESCE(docGone, 0) = 0 RETURNING id`)
      .bind(r.fileId).first().catch(() => null);
    if (!claimed) { skipped.push({ ...brief(r), reason: 'CHANGED' }); continue; }
    // 2. a save may have started to hold the file between the first check and the claim
    if (await fileHeldByAnyDoc(db, r.fileId)) { await skip('HELD'); continue; }
    // 3. storage (the row's own backend) : only a file that still sits where the server put it (Drive : its upload folder ; R2 : its key)
    const ref = refOfRow(r);
    const st = ref ? adapters.get(ref.storage) : null;
    if (!st) { await skip('UNKNOWN_STORAGE'); continue; }
    let meta = null;
    try {
      meta = await st.head(ref);
    } catch (e) {
      if (e && (e.status === 404 || e.status === 403)) { await skip('NOT_IN_DRIVE', false); continue; } // already gone : the record stays closed
      await skip('DRIVE_ERROR');
      continue;
    }
    if (meta && meta.missing && ref.storage === 'r2') { await skip('NOT_IN_DRIVE', false); continue; }
    if (!meta || !meta.inFolder) { await skip('NOT_IN_UPLOAD_FOLDER'); continue; }
    if (!meta.trashed && !(await st.trash(ref))) { await skip('TRASH_FAILED'); continue; }
    trashed.push(view(r));
  }
  await audit('ORPHAN_CLEANUP', 'attachment', '', {
    actorUserId: authUser.userId, trashed: trashed.length, skipped: skipped.length,
    trashedFiles: trashed.map(brief), skippedFiles: skipped.map((s) => ({ fileId: s.fileId, attachmentId: s.attachmentId, fileName: s.fileName, reason: s.reason }))
  });
  return jsonResponse({ ...out, trashedCount: trashed.length, trashed, skipped });
}

/** POST /api/admin/restore-orphan { fileId } : undo one cleanup (Drive untrash + docGone = 0). Admin only ; only files the cleanup itself closed (docGone = 2). */
export async function handleRestoreOrphan({ request, env, db, authUser, jsonResponse, errorResponse, audit }) {
  if (!db) return errorResponse('ฐานข้อมูลยังไม่พร้อมใช้งาน', 503);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const fileId = body && typeof body.fileId === 'string' ? body.fileId.trim() : '';
  if (!FILE_ID_RE.test(fileId)) return errorResponse('ต้องระบุ fileId ที่ถูกต้อง', 400);
  const row = await db.prepare('SELECT id, fileId, fileName, folderId, storage, objectKey FROM attachments WHERE fileId = ? AND docGone = 2 LIMIT 1').bind(fileId).first().catch(() => null);
  if (!row) return errorResponse('ไม่พบไฟล์ที่ถูกย้ายเป็นไฟล์กำพร้า', 404);
  const ref = refOfRow(row);
  let st;
  try { st = ref ? getStorageFor(row, env) : null; if (st) await st.prepare(); } catch (e) {
    console.error('[orphans] storage not ready:', e && e.code ? e.code : 'ERROR');
    return errorResponse('ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน', 503);
  }
  if (!st) return errorResponse('ไม่พบไฟล์ในระบบจัดเก็บ', 404);
  let meta;
  try { meta = await st.head(ref); } catch (e) {
    if (e && (e.status === 404 || e.status === 403)) return errorResponse('ไม่พบไฟล์ใน Drive (อาจถูกลบถาวรแล้ว)', 404);
    return errorResponse('ไม่สามารถเข้าถึงระบบจัดเก็บไฟล์ได้', 502);
  }
  if (meta && meta.missing && ref.storage === 'r2') return errorResponse('ไม่พบไฟล์ในระบบจัดเก็บ (อาจถูกลบถาวรแล้ว)', 404);
  if (!meta || !meta.inFolder) return errorResponse('ไฟล์ไม่อยู่ในโฟลเดอร์อัปโหลดของระบบ', 409);
  if (meta.trashed && !(await st.untrash(ref))) return errorResponse('ไม่สามารถกู้ไฟล์จากถังขยะได้', 502);
  await db.prepare('UPDATE attachments SET docGone = 0 WHERE fileId = ? AND docGone = 2').bind(fileId).run();
  await audit('ORPHAN_RESTORE', 'attachment', row.id, { actorUserId: authUser.userId, fileId, attachmentId: row.id, fileName: row.fileName });
  return jsonResponse({ success: true, restored: { fileId, attachmentId: row.id, fileName: row.fileName } });
}
