-- 0015 : index for the per-user per-minute rate limit of POST /api/stock/adjust and /api/stock/manual-in
--   (counts audit_logs rows of one user + action since a time). No DROP.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_action_time ON audit_logs(performedBy, action, createdAtMs);
