-- ====================================================================
-- Migration 0010_token_version : ยกเลิก token เก่าเมื่อเปลี่ยน/รีเซ็ตรหัสผ่าน + ล้างคอลัมน์ pin
-- (ไม่มี DROP ; mustChangePassword / passwordUpdatedAt มีอยู่แล้วใน 0003)
-- ====================================================================

-- token ที่ออกให้ผู้ใช้ฝัง tv = tokenVersion ; ไม่ตรงกับค่าใน DB = 401
-- (เปลี่ยนรหัสเอง / แอดมินรีเซ็ต -> tokenVersion + 1)
ALTER TABLE users ADD COLUMN tokenVersion INTEGER DEFAULT 0;

-- คอลัมน์ pin ไม่ใช้งานแล้ว : ล้างค่า (คงคอลัมน์ไว้เพื่อ schema เดิม)
UPDATE users SET pin = '';
