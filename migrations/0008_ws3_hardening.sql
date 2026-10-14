-- 0008: WS3 hardening columns (ADD COLUMN / CREATE INDEX IF NOT EXISTS only ; nothing is dropped or rewritten)
--   notifications.createdBy / createdAtMs : who posted it (token user id) + epoch ms for the per-user rate limit of POST /api/notifications
--   budget_transactions.actorUserId       : users.id behind a server-written CLAIM_CREDIT row (matched by id, never by display name)
--   audit_logs.source / createdAtMs       : 'client' for rows posted through POST /api/audit-logs (server-made rows stay NULL) + rate limit time
ALTER TABLE notifications ADD COLUMN createdBy TEXT;
ALTER TABLE notifications ADD COLUMN createdAtMs INTEGER;
CREATE INDEX IF NOT EXISTS idx_notifications_creator_time ON notifications(createdBy, createdAtMs);
ALTER TABLE budget_transactions ADD COLUMN actorUserId TEXT;
ALTER TABLE audit_logs ADD COLUMN source TEXT;
ALTER TABLE audit_logs ADD COLUMN createdAtMs INTEGER;
CREATE INDEX IF NOT EXISTS idx_audit_source_user_time ON audit_logs(source, performedBy, createdAtMs);
