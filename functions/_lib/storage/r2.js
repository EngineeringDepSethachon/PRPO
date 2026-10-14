// Cloudflare R2 storage adapter (binding env.FILES). Private bucket only : no r2.dev / public URL, files are read through GET /api/files/:id.
// Interface = storage/index.js (put / head / open / trash / untrash / makePrivate / publicUrl).
//
// The R2 binding has no copy and no rename : trash / untrash = get -> put (streamed) to the new key -> verify the copy (exists, same size)
// -> only then delete the source. A failure before the delete leaves the source untouched (nothing is lost). There is no permanent delete
// of a user file anywhere in this module ; the only deletes are (a) the source of a verified move and (b) our own half-written copy of a failed put / move.

import {
  StorageError, validateUpload, buildObjectKey, isSafeObjectKey, sha256Hex
} from './common.js';

export const TRASH_PREFIX = 'trash/';

function bucketOf(env) {
  const b = env && env.FILES;
  if (!b || typeof b.put !== 'function' || typeof b.get !== 'function' || typeof b.head !== 'function' || typeof b.delete !== 'function') {
    // no bucket / binding name in the message : it reaches logs only as a code
    throw new StorageError('STORAGE_NOT_CONFIGURED', 'object storage binding is not available');
  }
  return b;
}

export const r2PublicUrl = (fileId) => `/api/files/${encodeURIComponent(String(fileId))}`;

/** key of the object for a ref, or '' when the ref has no usable key (callers treat it as "not found"). */
function keyOf(ref) {
  const k = ref && typeof ref.objectKey === 'string' ? ref.objectKey : '';
  return isSafeObjectKey(k) && !k.startsWith(TRASH_PREFIX) ? k : '';
}

export function createR2Adapter(env) {
  const bucket = bucketOf(env);

  // move src -> dst (get + streamed put + verify + delete source). true = moved (or already there) ; false = nothing changed that could lose data.
  async function move(src, dst) {
    let obj;
    try { obj = await bucket.get(src); } catch { return false; }
    if (!obj) {
      // source missing : fine when the destination already holds it (idempotent), otherwise there is nothing to move
      try { return Boolean(await bucket.head(dst)); } catch { return false; }
    }
    const size = Number(obj.size);
    const sha = obj.customMetadata && obj.customMetadata.sha256;
    const same = (o) => Boolean(o) && Number(o.size) === size && ((o.customMetadata && o.customMetadata.sha256) === sha);
    // the destination is never overwritten silently : an identical object already there (earlier attempt whose delete failed) is reused,
    // anything else stops the move and the source stays
    let existing;
    try { existing = await bucket.head(dst); } catch { return false; }
    if (existing) {
      if (!same(existing)) return false;
      try { await obj.body?.cancel(); } catch { /* ignore */ }
    } else {
      try {
        await bucket.put(dst, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
        const copy = await bucket.head(dst);
        if (!same(copy)) {
          // our own bad copy (size or sha256 differs) : remove it, the source stays
          try { await bucket.delete(dst); } catch { /* ignore */ }
          return false;
        }
      } catch {
        try { await bucket.delete(dst); } catch { /* ignore */ }
        return false;
      }
    }
    try { await bucket.delete(src); } catch { return false; } // both exist : the file is safe, the caller may retry
    return true;
  }

  return {
    storage: 'r2',

    /** nothing to prepare (binding already checked) ; same hook as the Drive adapter (token) */
    async prepare() { return true; },

    async put({ name, mimeType, bytes, category, docRef, uploaderId, date }) {
      const v = validateUpload({ name, mimeType, bytes });
      const fileId = crypto.randomUUID();
      const when = date instanceof Date ? date : new Date(date || Date.now());
      const objectKey = buildObjectKey({ category, docRef, date: when, fileId, name: v.name }); // server-side only, sanitized per segment
      const sha256 = await sha256Hex(v.bytes);
      const size = v.bytes.length;
      const customMetadata = {
        name: v.name,
        mimeType: v.mimeType,
        uploaderId: String(uploaderId == null ? '' : uploaderId).slice(0, 100),
        docRef: String(docRef == null ? '' : docRef).slice(0, 120),
        category: String(category == null ? '' : category).slice(0, 40),
        uploadedAt: when.toISOString(),
        sha256,
        size: String(size)
      };
      let res;
      try {
        res = await bucket.put(objectKey, v.bytes, { httpMetadata: { contentType: v.mimeType }, customMetadata });
      } catch {
        throw new StorageError('STORAGE_ERROR', 'object put failed');
      }
      // verify what R2 reports before the row is written : a short / failed write must not become an attachment
      if (!res || (res.size !== undefined && Number(res.size) !== size)) {
        try { await bucket.delete(objectKey); } catch { /* ignore */ }
        throw new StorageError('STORAGE_ERROR', 'object size mismatch');
      }
      const url = r2PublicUrl(fileId);
      return {
        fileId, storage: 'r2', objectKey, size, mimeType: v.mimeType, name: v.name, sha256,
        // the client + attachments row keep their URL columns ; all of them are the authenticated proxy (never a bucket URL)
        folderId: 'r2', folderPath: objectKey.split('/').slice(0, -1).join('/'),
        viewUrl: url, directUrl: url, downloadUrl: url, lh3Url: '', webViewLink: url, sharedPublic: false
      };
    },

    /** -> { exists, size, mimeType, name, trashed, inFolder, missing } . Never throws for a missing object. */
    async head(ref) {
      const key = keyOf(ref);
      if (!key) return { exists: false, trashed: false, inFolder: false, missing: true };
      let o;
      try { o = await bucket.head(key); } catch { throw new StorageError('STORAGE_ERROR', 'object head failed'); }
      if (o) {
        return {
          exists: true, trashed: false, inFolder: true, missing: false, size: Number(o.size),
          mimeType: (o.httpMetadata && o.httpMetadata.contentType) || (o.customMetadata && o.customMetadata.mimeType) || '',
          name: (o.customMetadata && o.customMetadata.name) || ''
        };
      }
      let t;
      try { t = await bucket.head(TRASH_PREFIX + key); } catch { throw new StorageError('STORAGE_ERROR', 'object head failed'); }
      if (t) return { exists: false, trashed: true, inFolder: true, missing: false, size: Number(t.size) };
      return { exists: false, trashed: false, inFolder: false, missing: true };
    },

    /** -> { body (stream), mimeType, size, name } or null when the object is not there. The body is not buffered. */
    async open(ref) {
      const key = keyOf(ref);
      if (!key) return null;
      let o;
      try { o = await bucket.get(key); } catch { throw new StorageError('STORAGE_ERROR', 'object get failed'); }
      if (!o) return null;
      return {
        body: o.body,
        mimeType: (o.httpMetadata && o.httpMetadata.contentType) || (o.customMetadata && o.customMetadata.mimeType) || '',
        size: Number(o.size),
        name: (o.customMetadata && o.customMetadata.name) || ''
      };
    },

    /** move to trash/<key> (recoverable). true / false, never throws. */
    async trash(ref) {
      const key = keyOf(ref);
      return key ? move(key, TRASH_PREFIX + key) : false;
    },

    /** move back from trash/<key>. true / false, never throws. */
    async untrash(ref) {
      const key = keyOf(ref);
      return key ? move(TRASH_PREFIX + key, key) : false;
    },

    /** R2 objects are never public */
    async makePrivate() { return { skipped: 'ALWAYS_PRIVATE', removed: 0, stillPublic: false }; },

    publicUrl(ref) { return r2PublicUrl(ref && ref.fileId); }
  };
}
