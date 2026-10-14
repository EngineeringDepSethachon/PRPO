// POST /api/admin/unshare-public : take the "anyone with the link" permission off project files that were uploaded before it was switched off.
// Called from functions/api/[[route]].js AFTER authentication and RBAC (rule 'admin-unshare-public' = ADMIN). Not a route (folder starts with "_").
//
// Only files that /api/upload itself put in the project's Drive folder are touched :
//   - an `attachments` row written by the server (folderId set), still marked sharedPublic = 1 (any docGone : files of deleted documents / trashed orphans are included), AND
//   - in Drive the file's parents still contain that very folderId (a file that moved elsewhere / a file that is not ours is skipped).
// Files of the old GAS system are never in `attachments` with a folderId, so they are never listed.
// Only permissions of type "anyone" are removed (never a user / group / domain permission). Afterwards the row gets sharedPublic = 0 ; a permanent skip (not in Drive / not in the upload folder) gets sharedPublic = -1 so it is not listed again.
// DRY RUN BY DEFAULT : the body must say {"dryRun": false} (boolean) to act ; a dry run never talks to Drive. Bounded per call (MAX_PER_RUN, default 20).

import { getStorageFor, refOfRow } from './storage/index.js';

export const MAX_PER_RUN = 20;
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

export function parseUnshareBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const dryRun = b.dryRun !== false; // only a real boolean false turns it off
  const asked = Math.floor(Number(b.limit));
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, MAX_PER_RUN) : MAX_PER_RUN;
  return { dryRun, limit };
}

export async function handleUnsharePublic({ request, env, db, authUser, jsonResponse, errorResponse, audit }) {
  if (!db) return errorResponse('ฐานข้อมูลยังไม่พร้อมใช้งาน', 503);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const { dryRun, limit } = parseUnshareBody(body);

  let rows;
  try {
    rows = ((await db.prepare(`SELECT MIN(id) AS id, fileId, MIN(fileName) AS fileName, MIN(folderId) AS folderId, MIN(createdAtMs) AS createdAtMs, MIN(COALESCE(storage, 'drive')) AS storage, MIN(objectKey) AS objectKey FROM attachments
      WHERE folderId IS NOT NULL AND folderId != '' AND COALESCE(sharedPublic, 1) = 1
      GROUP BY fileId ORDER BY MIN(createdAtMs) LIMIT ?`).bind(limit + 1).all()).results) || [];
  } catch {
    return errorResponse('ฐานข้อมูลยังไม่พร้อมใช้งาน', 503);
  }
  const truncated = rows.length > limit;
  rows = rows.slice(0, limit).filter((r) => FILE_ID_RE.test(String(r.fileId)));
  const brief = (r) => ({ fileId: r.fileId, attachmentId: r.attachmentId || r.id, fileName: r.fileName });
  const out = { success: true, dryRun, limit, truncated, candidateCount: rows.length, candidates: rows.map(brief) };

  if (dryRun) {
    await audit('UNSHARE_PUBLIC_DRYRUN', 'attachment', '', { actorUserId: authUser.userId, found: rows.length, files: rows.map(brief) });
    return jsonResponse(out);
  }

  // Drive credentials are needed only when at least one candidate is a Drive file ; R2 rows are always private and never touch a backend
  let drive = null;
  try {
    const firstDrive = rows.find((r) => r.storage === 'drive');
    if (firstDrive) { drive = getStorageFor(firstDrive, env); await drive.prepare(); }
  } catch (e) {
    console.error('[unshare] drive auth failed:', e && e.code ? e.code : 'ERROR');
    return errorResponse('ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน', 503);
  }

  const unshared = [];
  const skipped = [];
  for (const r of rows) {
    const skip = (reason) => { skipped.push({ ...brief(r), reason }); };
    // a permanent skip is marked (sharedPublic = -1) so the file is not listed again and cannot crowd out newer files ; DRIVE_ERROR / DB_ERROR are retried
    const skipForever = async (reason) => {
      skip(reason);
      await db.prepare('UPDATE attachments SET sharedPublic = -1 WHERE fileId = ? AND sharedPublic = 1').bind(r.fileId).run().catch(() => {});
    };
    const ref = refOfRow(r);
    if (!ref) { await skipForever('UNKNOWN_STORAGE'); continue; }
    if (ref.storage === 'r2') {
      // R2 objects are never public : nothing to remove. Only the flag is cleared so the row is not listed again.
      skip('ALWAYS_PRIVATE'); // same value the R2 adapter's makePrivate() reports
      await db.prepare('UPDATE attachments SET sharedPublic = 0 WHERE fileId = ? AND sharedPublic = 1').bind(r.fileId).run().catch(() => {});
      continue;
    }
    let meta = null;
    try {
      meta = await drive.head(ref);
    } catch (e) {
      // only 404 is final ; a 403 can be a temporary rate limit (the file is still public) -> retried next run
      if (e && e.status === 404) await skipForever('NOT_IN_DRIVE'); else skip('DRIVE_ERROR');
      continue;
    }
    if (!meta || !meta.inFolder) { await skipForever('NOT_IN_UPLOAD_FOLDER'); continue; }
    let removed = 0;
    try {
      // removes the "anyone" permissions, then verifies : one still there (e.g. a page that could not be read) -> not marked private, retried next run
      const res = await drive.makePrivate(ref);
      removed = res.removed;
      if (res.stillPublic) { skip('STILL_PUBLIC'); continue; }
    } catch {
      skip('DRIVE_ERROR');
      continue;
    }
    try {
      await db.prepare('UPDATE attachments SET sharedPublic = 0 WHERE fileId = ?').bind(r.fileId).run();
    } catch {
      skip('DB_ERROR');
      continue;
    }
    unshared.push({ ...brief(r), removedPermissions: removed });
  }
  await audit('UNSHARE_PUBLIC', 'attachment', '', {
    actorUserId: authUser.userId, unshared: unshared.length, skipped: skipped.length,
    unsharedFiles: unshared, skippedFiles: skipped
  });
  return jsonResponse({ ...out, unsharedCount: unshared.length, unshared, skipped });
}
