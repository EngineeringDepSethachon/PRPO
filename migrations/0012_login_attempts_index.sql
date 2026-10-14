-- 0012 : login_attempts housekeeping indexes (no DROP, safe to re-run)
--   attemptedAt : periodic "DELETE ... WHERE attemptedAt < now-24h"
--   userAgent   : "DELETE ... WHERE userAgent = <nonce>" (the per-attempt marker) without a full scan
CREATE INDEX IF NOT EXISTS idx_login_attempts_attemptedAt ON login_attempts(attemptedAt);
CREATE INDEX IF NOT EXISTS idx_login_attempts_userAgent ON login_attempts(userAgent);
