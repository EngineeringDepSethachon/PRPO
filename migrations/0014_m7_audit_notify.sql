-- 0014 : M7 audit timeline + notification read-state (no DROP, safe to re-run)
--   audit_logs.timestamp           : ORDER BY / range filter ของหน้า audit timeline
--   notification_reads             : สถานะ "อ่านแล้ว" แยกต่อผู้ใช้ (ไม่แก้แถว notifications เดิม)
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE TABLE IF NOT EXISTS notification_reads (notificationId TEXT NOT NULL, userId TEXT NOT NULL, readAt TEXT NOT NULL, PRIMARY KEY (notificationId, userId));
CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(userId);
