-- 0013 : attachments can live in two places at once (Cloudflare R2 now, Google Drive later) - docs/requirements-file-storage.md
-- Additive only (no DROP). Every existing row was stored in Drive, which is exactly what the default says.
ALTER TABLE attachments ADD COLUMN storage TEXT NOT NULL DEFAULT 'drive';   -- 'drive' | 'r2'
ALTER TABLE attachments ADD COLUMN objectKey TEXT;                           -- R2 key (NULL for drive rows)
ALTER TABLE attachments ADD COLUMN migratedFrom TEXT;                        -- 'r2:<key>' or 'drive:<id>' after a move (rollback trail)
CREATE INDEX IF NOT EXISTS idx_attachments_storage ON attachments(storage);
