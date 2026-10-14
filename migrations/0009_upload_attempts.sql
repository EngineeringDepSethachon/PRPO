-- 0009: per-user counter of /api/upload ATTEMPTS (successful or not) in one-hour buckets.
-- The check runs BEFORE the request body is read, so a user who keeps sending bad / rejected files is throttled too.
CREATE TABLE IF NOT EXISTS upload_attempts (
    userId TEXT NOT NULL,
    windowStart INTEGER NOT NULL,   -- epoch ms of the start of the hour bucket
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, windowStart)
);
