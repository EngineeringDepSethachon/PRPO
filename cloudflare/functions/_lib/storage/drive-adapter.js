// Google Drive storage adapter : wraps functions/_lib/drive.js (logic unchanged) in the common storage interface (see storage/index.js).
// Needs the Service Account secrets ; without them every call fails with DRIVE_NOT_CONFIGURED (-> 503, same as before).

import {
  getAccessToken, ensureFolderPath, uploadFile, getFileMetadata, openFileMedia, trashFile, untrashFile,
  listFilePermissions, deleteFilePermission, resolveFolderParts, driveUrls
} from '../drive.js';

export function createDriveAdapter(env) {
  return {
    storage: 'drive',

    /** fails early (DRIVE_NOT_CONFIGURED / DRIVE_AUTH_FAILED) before any per-file work */
    async prepare() { await getAccessToken(env); return true; },

    async put({ name, mimeType, bytes, category, docRef, date }) {
      const when = date instanceof Date ? date : new Date(date || Date.now());
      const parts = resolveFolderParts(category, docRef, when);
      const token = await getAccessToken(env);
      const folderId = await ensureFolderPath(env, token, parts);
      const up = await uploadFile(env, token, { folderId, name, mimeType, bytes });
      return {
        fileId: up.fileId, storage: 'drive', objectKey: null, size: up.fileSize, mimeType: up.mimeType, name: up.fileName,
        folderId, folderPath: parts.join('/'),
        viewUrl: up.viewUrl, directUrl: up.directUrl, downloadUrl: up.downloadUrl, lh3Url: up.lh3Url, webViewLink: up.webViewLink,
        sharedPublic: up.sharedPublic
      };
    },

    /** -> { exists, trashed, inFolder, missing, size, mimeType, name }. Throws DriveError(status) on any Drive error (404 / 403 included : callers decide). */
    async head(ref) {
      const token = await getAccessToken(env);
      const meta = await getFileMetadata(token, ref.fileId);
      const trashed = Boolean(meta && meta.trashed);
      const inFolder = Boolean(meta && ref.folderId && Array.isArray(meta.parents) && meta.parents.includes(ref.folderId));
      return { exists: Boolean(meta) && !trashed && inFolder, trashed, inFolder, missing: !meta, size: Number(meta && meta.size), mimeType: (meta && meta.mimeType) || '', name: '' };
    },

    /** -> { body (stream), mimeType, size (null when unknown), name }. Throws DriveError(status) when Drive refuses. */
    async open(ref) {
      const token = await getAccessToken(env);
      const res = await openFileMedia(token, ref.fileId);
      const len = res.headers.get('Content-Length');
      return { body: res.body, mimeType: '', size: len && /^\d+$/.test(len) ? Number(len) : null, name: '' };
    },

    async trash(ref) {
      try { return await trashFile(env, await getAccessToken(env), ref.fileId); } catch { return false; }
    },

    async untrash(ref) {
      try { return await untrashFile(env, await getAccessToken(env), ref.fileId); } catch { return false; }
    },

    /** remove every "anyone" permission, then verify. -> { removed, stillPublic }. Throws DriveError on a Drive error. */
    async makePrivate(ref) {
      const token = await getAccessToken(env);
      let removed = 0;
      for (const p of await listFilePermissions(token, ref.fileId)) {
        if (p && p.type === 'anyone' && typeof p.id === 'string') { await deleteFilePermission(token, ref.fileId, p.id); removed += 1; }
      }
      const stillPublic = (await listFilePermissions(token, ref.fileId)).some((p) => p && p.type === 'anyone');
      return { removed, stillPublic };
    },

    publicUrl(ref) { return driveUrls(ref.fileId).viewUrl; }
  };
}
