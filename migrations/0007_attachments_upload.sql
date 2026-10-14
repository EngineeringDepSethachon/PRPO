-- 0007: /api/upload (Google Drive Service Account) - extra columns on attachments
--   uploaderId   = users.id ของผู้อัปโหลด (uploadedBy เดิมเก็บชื่อ/อีเมลตาม GAS)
--   docRef       = เลขเอกสารที่ server ตรวจแล้วว่ามีจริง (prNumber / poNumber) ; ว่างได้เฉพาะ category PR ที่แนบก่อนสร้างเอกสาร
--   createdAtMs  = epoch ms ใช้ทำ rate limit ต่อผู้ใช้ (ไม่พึ่งรูปแบบ text ของ uploadedAt)
--   sharedPublic = 1 ถ้าตั้ง anyone-with-link สำเร็จ
ALTER TABLE attachments ADD COLUMN uploaderId TEXT;
ALTER TABLE attachments ADD COLUMN docRef TEXT;
ALTER TABLE attachments ADD COLUMN createdAtMs INTEGER;
ALTER TABLE attachments ADD COLUMN sharedPublic INTEGER DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_attachments_uploader_time ON attachments(uploaderId, createdAtMs);
CREATE INDEX IF NOT EXISTS idx_attachments_category_docRef ON attachments(category, docRef);
