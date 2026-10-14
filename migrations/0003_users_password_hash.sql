-- ====================================================================
-- Migration 0003_users_password_hash : รองรับรหัสผ่านแบบ PBKDF2 ในตาราง users
-- (แยกจาก 0001 เพราะเป็น ALTER ; ไม่แก้ migration เดิมย้อนหลัง)
-- คอลัมน์ password เดิม (plaintext) คงไว้ก่อน เพื่อ migrate ข้อมูลทีหลัง
-- ====================================================================

ALTER TABLE users ADD COLUMN passwordHash TEXT;                 -- base64/hex ของ PBKDF2 derived key
ALTER TABLE users ADD COLUMN passwordSalt TEXT;                 -- salt สุ่มต่อ user
ALTER TABLE users ADD COLUMN passwordAlgo TEXT DEFAULT 'PBKDF2-SHA256';
ALTER TABLE users ADD COLUMN passwordIterations INTEGER;
ALTER TABLE users ADD COLUMN mustChangePassword INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN passwordUpdatedAt TEXT;
