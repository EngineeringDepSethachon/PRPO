// File storage selector. Two interchangeable backends behind one interface (docs/requirements-file-storage.md) :
//   'r2'    Cloudflare R2, binding env.FILES (default when FILE_STORAGE is not set)
//   'drive' Google Drive through the Service Account (functions/_lib/drive.js, unchanged)
//
// Adapter interface (all async) :
//   put({ name, mimeType, bytes, category, docRef, uploaderId, date }) -> { fileId, storage, objectKey, size, mimeType, name, folderId, folderPath, viewUrl, directUrl, downloadUrl, lh3Url, webViewLink, sharedPublic }
//   head(ref)    -> { exists, trashed, inFolder, missing, size, mimeType, name }
//   open(ref)    -> { body, mimeType, size, name }  (R2 : null when the object is gone)
//   trash(ref) / untrash(ref) -> boolean (never throws)
//   makePrivate(ref) -> { removed, stillPublic } | { skipped: 'ALWAYS_PRIVATE' }
//   publicUrl(ref) -> string
//   prepare()    -> throws when the backend is not configured / not reachable
// ref = { fileId, objectKey, storage, folderId } taken from an `attachments` row. NEVER from the client.

import { StorageError } from './common.js';
import { createR2Adapter } from './r2.js';
import { createDriveAdapter } from './drive-adapter.js';

export const STORAGE_KINDS = Object.freeze(['r2', 'drive']);

/** adapter for NEW files, chosen by env.FILE_STORAGE (default 'r2'). Unknown value = not configured (fail closed, no silent fallback). */
export function getStorage(env) {
  const raw = env && env.FILE_STORAGE != null ? String(env.FILE_STORAGE).trim().toLowerCase() : '';
  const kind = raw || 'r2';
  if (kind === 'r2') return createR2Adapter(env);
  if (kind === 'drive') return createDriveAdapter(env);
  throw new StorageError('STORAGE_NOT_CONFIGURED', 'unknown storage backend');
}

/** ref of an attachments row ; null when the row has no usable location (unknown storage, R2 row without objectKey) -> callers answer 404. */
export function refOfRow(row) {
  if (!row || typeof row !== 'object') return null;
  const storage = row.storage == null || row.storage === '' ? 'drive' : String(row.storage); // rows from before migration 0013 are Drive files
  if (!STORAGE_KINDS.includes(storage)) return null;
  const objectKey = typeof row.objectKey === 'string' ? row.objectKey : '';
  if (storage === 'r2' && !objectKey.trim()) return null;
  return { fileId: row.fileId, objectKey: objectKey || null, storage, folderId: row.folderId || '' };
}

/** adapter for an EXISTING file, chosen by the row's own `storage` column (never by env.FILE_STORAGE). null = unknown / unusable row. */
export function getStorageFor(row, env) {
  const ref = refOfRow(row);
  if (!ref) return null;
  return ref.storage === 'r2' ? createR2Adapter(env) : createDriveAdapter(env);
}
