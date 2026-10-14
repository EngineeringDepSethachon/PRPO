-- ====================================================================
-- Migration 0002_missing_tables : ตารางที่ขาดเมื่อเทียบกับชีต GAS
--
-- เทียบชีต GAS (gas/Config.gs / gas/SheetService.gs SCHEMA_DEFINITIONS) -> ตาราง D1
--   Notifications -> notifications
--   Attachments   -> attachments   (เก็บ Drive fileId/url/folder + อ้างอิงเอกสาร ไม่เก็บ base64)
--   Signatures    -> signatures    (key = roleId)
--   AppConfig     -> app_config    (key/value)
--   PRItems       -> pr_items      (รายบรรทัดของ PR; ใน D1 หลักยังใช้ prs.itemsJson)
--   PRCounters    -> doc_counters  (dept + docType + year ตรงกับ generateSequentialDocId;
--                                   ตาราง counters จาก 0001 เก็บไว้เพื่อ compat)
--   (ใหม่)        -> login_attempts (ล็อก 5 ครั้ง / 15 นาที นับแยกต่อ user และต่อ IP)
-- ====================================================================

-- notifications (GAS: id,timestamp,title,message,type,targetDepartment,targetRole,docRef,status)
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    title TEXT,
    message TEXT,
    type TEXT,
    targetDepartment TEXT,
    targetRole TEXT,
    docRef TEXT,
    status TEXT DEFAULT 'UNREAD'
);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(targetDepartment, targetRole, status);
CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp);

-- attachments (GAS: id,fileId,fileName,mimeType,fileSize,category,poNumber,docNo,docType,
--              viewUrl,directUrl,lh3Url,downloadUrl,folderPath,uploadedBy,uploadedAt)
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    fileId TEXT NOT NULL,            -- Google Drive file id
    fileName TEXT,
    mimeType TEXT,
    fileSize INTEGER DEFAULT 0,
    category TEXT,                   -- PR / PO / GRN / CLAIM
    poNumber TEXT,
    docNo TEXT,                      -- เลขเอกสารที่อ้างอิง (PR/PO/GRN/CLM)
    docType TEXT,
    viewUrl TEXT,
    directUrl TEXT,
    lh3Url TEXT,
    downloadUrl TEXT,
    folderId TEXT,                   -- Drive folder id (โฟลเดอร์ใหม่เฉพาะโปรเจกต์)
    folderPath TEXT,
    uploadedBy TEXT,
    uploadedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_docNo ON attachments(docType, docNo);
CREATE INDEX IF NOT EXISTS idx_attachments_poNumber ON attachments(poNumber);
CREATE INDEX IF NOT EXISTS idx_attachments_fileId ON attachments(fileId);

-- signatures (GAS: roleId,name,signatureUrl,updatedAt,updatedBy)
CREATE TABLE IF NOT EXISTS signatures (
    roleId TEXT PRIMARY KEY,
    name TEXT,
    signatureUrl TEXT,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedBy TEXT
);

-- app_config (GAS: key,value,description,updatedAt)
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    description TEXT,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- pr_items (GAS PRItems)
CREATE TABLE IF NOT EXISTS pr_items (
    id TEXT PRIMARY KEY,
    prId TEXT NOT NULL,
    prNo TEXT,
    productId TEXT,
    productCode TEXT,
    name TEXT,
    purchaseUnit TEXT,
    stockUnit TEXT,
    conversionRate REAL DEFAULT 1,
    qty REAL DEFAULT 0,
    unit TEXT,
    price REAL DEFAULT 0,
    totalPrice REAL DEFAULT 0,
    department TEXT,
    notes TEXT,
    status TEXT,
    imageUrl TEXT,
    fileId TEXT,
    driveUrl TEXT,
    images TEXT,                     -- JSON
    attachments TEXT,                -- JSON
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pr_items_prId ON pr_items(prId);

-- doc_counters (GAS PRCounters: dept,docType,lastNumber,prefix,year,updatedAt)
-- ออกเลขแบบ atomic: INSERT ... ON CONFLICT(dept,docType,year) DO UPDATE SET lastNumber = lastNumber + 1 RETURNING lastNumber
CREATE TABLE IF NOT EXISTS doc_counters (
    dept TEXT NOT NULL,
    docType TEXT NOT NULL,
    year INTEGER NOT NULL,
    lastNumber INTEGER NOT NULL DEFAULT 0,
    prefix TEXT,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (dept, docType, year)
);

-- login_attempts : ล็อก 5 ครั้ง / 15 นาที
--   kind = 'USER' (identifier = username ตัวพิมพ์เล็ก) หรือ 'IP' (identifier = IP)
--   attemptedAt = epoch milliseconds ; นับ success = 0 ในช่วง 15 นาทีล่าสุด ; ล็อกอินสำเร็จให้ล้างของ USER นั้น
CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('USER', 'IP')),
    identifier TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    attemptedAt INTEGER NOT NULL,
    ip TEXT,
    userAgent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(kind, identifier, attemptedAt);
