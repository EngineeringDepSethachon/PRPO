-- ====================================================================
-- Cloudflare D1 SQL Schema & Seed Data for PRPO_PDQC
-- Database ID: d2e63ef5-b69f-4bf0-8220-13a17682a9db
-- Database Name: prpo-db
-- ====================================================================

-- 1. Departments Master Table
DROP TABLE IF EXISTS departments;
CREATE TABLE departments (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    nameEn TEXT,
    prefix TEXT,
    description TEXT,
    monthlyBudget REAL DEFAULT 0,
    isActive INTEGER DEFAULT 1,
    color TEXT,
    managerName TEXT,
    createdAt TEXT,
    updatedAt TEXT
);

-- 2. Users & Authentication Table
DROP TABLE IF EXISTS users;
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    employeeId TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password TEXT NOT NULL,
    pin TEXT,
    name TEXT NOT NULL,
    employeeName TEXT,
    displayName TEXT,
    position TEXT,
    department TEXT NOT NULL,
    primaryDepartment TEXT,
    allowedDepartments TEXT, -- JSON Array string e.g. ["PD"]
    roleId TEXT NOT NULL,
    canonicalRole TEXT,
    positionKey TEXT,
    title TEXT,
    level INTEGER DEFAULT 1,
    status TEXT DEFAULT 'ACTIVE',
    pictureUrl TEXT,
    signature TEXT,
    canCreatePR INTEGER DEFAULT 1,
    canSubmitPR INTEGER DEFAULT 1,
    canDeleteOwnDraft INTEGER DEFAULT 1,
    canReview INTEGER DEFAULT 0,
    canFinalApprove INTEGER DEFAULT 0,
    canOnlinePurchase INTEGER DEFAULT 0,
    canReceiveGoods INTEGER DEFAULT 0,
    canCloseOwnPO INTEGER DEFAULT 0,
    canManageMaster INTEGER DEFAULT 1,
    canDeleteMaster INTEGER DEFAULT 0,
    canViewBudget INTEGER DEFAULT 0,
    canViewBudgetMenu INTEGER DEFAULT 0,
    canSetBudget INTEGER DEFAULT 0,
    canViewAllDepts INTEGER DEFAULT 0,
    description TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 3. Storage Locations Table
DROP TABLE IF EXISTS storage_locations;
CREATE TABLE storage_locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL
);

-- 4. Usage Units Table
DROP TABLE IF EXISTS usage_units;
CREATE TABLE usage_units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    dot TEXT,
    color TEXT,
    status TEXT DEFAULT 'ACTIVE'
);

-- 5. Products Catalog Table
DROP TABLE IF EXISTS products;
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    purchaseUnit TEXT,
    usageUnit TEXT,
    conversionRate REAL DEFAULT 1,
    minStock REAL DEFAULT 0,
    currentStock REAL DEFAULT 0,
    standardPrice REAL DEFAULT 0,
    defaultLocationId TEXT,
    isDirectUsage INTEGER DEFAULT 0,
    department TEXT NOT NULL,
    isDeleted INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 6. Vendors / Suppliers Table
DROP TABLE IF EXISTS vendors;
CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    contactPerson TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    taxId TEXT,
    paymentTerm TEXT,
    department TEXT,
    isDeleted INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 7. Budgets Management Table
DROP TABLE IF EXISTS budgets;
CREATE TABLE budgets (
    id TEXT PRIMARY KEY,
    department TEXT NOT NULL,
    fiscalYear INTEGER NOT NULL,
    monthlyBudget REAL DEFAULT 0,
    totalAllocated REAL DEFAULT 0,
    totalUsed REAL DEFAULT 0,
    totalRemaining REAL DEFAULT 0,
    monthsJson TEXT, -- Monthly breakdown JSON
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 7.1 Budget Transactions & Ledger Table
CREATE TABLE IF NOT EXISTS budget_transactions (
    id TEXT PRIMARY KEY,
    dept TEXT NOT NULL,
    department TEXT NOT NULL,
    departmentName TEXT,
    type TEXT NOT NULL,          -- 'MONTHLY_ALLOCATION', 'TOP_UP', 'SET_BUDGET', 'BUDGET_ROLLBACK', etc.
    actionType TEXT,
    typeLabel TEXT,
    amount REAL DEFAULT 0,
    delta REAL DEFAULT 0,
    previousAmount REAL DEFAULT 0,
    newAmount REAL DEFAULT 0,
    isAllocation INTEGER DEFAULT 0,
    actor TEXT,
    note TEXT,
    targetMonth TEXT,            -- 'YYYY-MM'
    period TEXT,                 -- 'YYYY-MM'
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    date TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 8. Purchase Requests (PR) Table
DROP TABLE IF EXISTS prs;
CREATE TABLE prs (
    id TEXT PRIMARY KEY,
    prNumber TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    requesterId TEXT,
    requesterName TEXT,
    status TEXT NOT NULL,
    totalAmount REAL DEFAULT 0,
    reason TEXT,
    itemsJson TEXT NOT NULL, -- Full JSON Array of requested items
    timelineJson TEXT,       -- Timeline tracking JSON
    attachmentsJson TEXT,    -- Document attachments JSON
    approvalWorkflowJson TEXT, -- Signature approvals JSON
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Purchase Orders (PO) Table
DROP TABLE IF EXISTS pos;
CREATE TABLE pos (
    id TEXT PRIMARY KEY,
    poNumber TEXT NOT NULL UNIQUE,
    prId TEXT,
    prNumber TEXT,
    department TEXT NOT NULL,
    vendorId TEXT,
    vendorName TEXT,
    totalAmount REAL DEFAULT 0,
    vatAmount REAL DEFAULT 0,
    grandTotal REAL DEFAULT 0,
    status TEXT NOT NULL,
    itemsJson TEXT NOT NULL,
    paymentTerms TEXT,
    deliveryDate TEXT,
    timelineJson TEXT,
    evidenceJson TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 10. Inventory Stock Logs Table
DROP TABLE IF EXISTS stock_logs;
CREATE TABLE stock_logs (
    id TEXT PRIMARY KEY,
    productId TEXT NOT NULL,
    productCode TEXT,                -- รหัสสินค้า เช่น PD-OIL-068
    productName TEXT,                -- ชื่อสินค้า
    type TEXT NOT NULL,              -- 'IN'=รับเข้า, 'OUT'=เบิกจ่าย, 'ADJUST'=ปรับสต็อก, 'RETURN'=คืนของ
    docType TEXT,                    -- 'GRN'=ใบรับสินค้า, 'ISSUE'=เบิกจ่าย, 'ADJUST'=ปรับ
    docNo TEXT,                      -- เลขที่เอกสาร เช่น GRN-PO-PD-001, REQ-1234
    referenceNo TEXT,                -- เลขอ้างอิง (PO No, PR No)
    poNo TEXT,                       -- เลขที่ PO ที่อ้างอิง (สำหรับ GRN)
    quantity REAL NOT NULL,          -- จำนวนที่รับ/เบิก (เป็นบวกเสมอ)
    changeQty REAL,                  -- ±จำนวนที่เปลี่ยนแปลง (ลบ=เบิก, บวก=รับ)
    balance REAL NOT NULL,           -- ยอดคงเหลือหลังทำรายการ
    unit TEXT,                       -- หน่วยของสินค้า เช่น ชิ้น, ลิตร, ม้วน
    department TEXT NOT NULL,        -- แผนกของสินค้า เช่น PD, QC
    location TEXT,                   -- ห้อง/หน่วยที่เบิกใช้งาน เช่น 'ห้อง K1', 'Lab เคมี'
    issuedTo TEXT,                   -- ชื่อห้อง/หน่วยงานที่รับของ
    issueUnit TEXT,                  -- ID หน่วยใช้งาน (usage unit id หรือ name)
    unitCost REAL DEFAULT 0,         -- ต้นทุนต่อหน่วย ณ เวลาเบิก (Moving Average Cost)
    totalCost REAL DEFAULT 0,        -- มูลค่ารวม = quantity × unitCost
    actorId TEXT,                    -- ID/username ผู้ทำรายการ
    actorName TEXT,                  -- ชื่อผู้ทำรายการ
    performedBy TEXT,                -- ชื่อผู้ทำรายการ (backward compat)
    notes TEXT,                      -- หมายเหตุ/เหตุผลการเบิก
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 11. Audit Logs Table
DROP TABLE IF EXISTS audit_logs;
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entityType TEXT,
    entityId TEXT,
    performedBy TEXT,
    details TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 12. Document Running Number Counters Table
DROP TABLE IF EXISTS counters;
CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    prefix TEXT,
    lastNumber INTEGER DEFAULT 0,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ====================================================================
-- SEED INITIAL MASTER DATA
-- ====================================================================

-- Departments
INSERT INTO departments (id, code, name, nameEn, prefix, description, monthlyBudget, isActive, color, managerName, createdAt) VALUES
('DEPT-PD', 'PD', 'ฝ่ายผลิต', 'Production', 'PD', 'รับผิดชอบกระบวนการแปรรูป ควบคุมการผลิต และดูแลไลน์ผลิตสินค้า', 250000, 1, 'blue', 'คุณประเสริฐ ยิ่งยง', CURRENT_TIMESTAMP),
('DEPT-QC', 'QC', 'ฝ่ายควบคุมคุณภาพ', 'Quality Control & Lab', 'QC', 'ตรวจสอบคุณภาพ วัตถุดิบ สารเคมี บรรจุภัณฑ์ และงานแล็บวิเคราะห์', 150000, 1, 'amber', 'ดร. กรรณิการ์ จิตเจริญ', CURRENT_TIMESTAMP),
('DEPT-WH', 'WH', 'ฝ่ายคลังสินค้า', 'Warehouse & Inventory', 'WH', 'บริหารคลังจัดเก็บสินค้า วัตถุดิบ ชิ้นส่วน และตรวจรับกระจายสต็อก', 120000, 1, 'emerald', 'คุณสมคิด คลังทอง', CURRENT_TIMESTAMP),
('DEPT-PUR', 'PUR', 'ฝ่ายจัดซื้อ', 'Procurement & Sourcing', 'PUR', 'จัดหาผู้จัดจำหน่าย เปรียบเทียบราคา จัดซื้อพัสดุและอุปกรณ์', 100000, 1, 'purple', 'คุณสุดา จัดหาดี', CURRENT_TIMESTAMP),
('DEPT-ENG', 'ENG', 'ฝ่ายวิศวกรรมและซ่อมบำรุง', 'Engineering & Maintenance', 'ENG', 'ดูแลรักษาเครื่องจักร ระบบสาธารณูปโภค และงานซ่อมบำรุงโรงงาน', 180000, 1, 'cyan', 'วิศวกร ช่างทอง', CURRENT_TIMESTAMP);

-- Users
INSERT INTO users (
    id, employeeId, username, email, password, pin, name, employeeName, displayName,
    position, department, primaryDepartment, allowedDepartments, roleId, canonicalRole,
    positionKey, title, level, status,
    canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
    canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
    canSetBudget, canViewAllDepts, description
) VALUES
('USR-0001', 'EMP-PD-001', 'wichai.pd', 'wichai@company.com', 'password123', 'password123', 'คุณวิชัย (PD)', 'คุณวิชัย สุขใจ', 'Wichai (PD)', 'เจ้าหน้าที่ฝ่ายผลิต', 'PD', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 'REQUESTER_PD', 'Requester (PD)', 1, 'ACTIVE', 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 'สร้าง/ส่ง PR ฝ่ายผลิต, เบิกจ่ายสินค้า, ตรวจรับของเข้าสต็อก'),
('USR-0002', 'EMP-QC-001', 'somying.qc', 'somying@company.com', 'password123', 'password123', 'คุณสมหญิง (QC)', 'คุณสมหญิง รักดี', 'Somying (QC)', 'เจ้าหน้าที่ฝ่ายควบคุมคุณภาพ (QC)', 'QC', 'QC', '["QC"]', 'REQUESTER_QC', 'REQUESTER', 'REQUESTER_QC', 'Requester (QC)', 1, 'ACTIVE', 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 'สร้าง/ส่ง PR ฝ่าย QC/Lab, เบิกจ่ายสารเคมี, ตรวจรับของ'),
('USR-0003', 'EMP-MGR-001', 'somchai.am', 'somchai.am@company.com', 'password123', 'password123', 'คุณสมชาย (Asst. Mgr)', 'คุณสมชาย มุ่งมั่น', 'Somchai (Asst Mgr)', 'ผู้ช่วยผู้จัดการฝ่ายผลิต (Asst. Manager)', 'PD', 'PD', '["PD","QC"]', 'ASST_MANAGER', 'REVIEWER', 'REVIEWER', 'Assistant Manager', 2, 'ACTIVE', 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 'ตรวจทาน PR (Level 1 Reviewer), ดูแลฝ่ายผลิต (PD) และฝ่ายควบคุมคุณภาพ (QC)'),
('USR-0004', 'EMP-PUR-001', 'nat.on', 'nat.on@company.com', 'password123', 'password123', 'คุณนัท (Online Purchaser)', 'คุณนัท จัดซื้อ', 'Nat (Online)', 'เจ้าหน้าที่จัดซื้อออนไลน์', 'PUR', 'PUR', '["*"]', 'ONLINE_PURCHASER', 'PURCHASER', 'ONLINE_PURCHASER', 'Online Purchaser', 2, 'ACTIVE', 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 'จัดการสั่งซื้อออนไลน์ Shopee/Lazada, บันทึกราคาจริง, ปิด PO Online'),
('USR-0005', 'EMP-MGR-002', 'prasert.pm', 'prasert.pm@company.com', 'password123', 'password123', 'คุณประเสริฐ (Plant Mgr)', 'คุณประเสริฐ ยิ่งยง', 'Prasert (Plant Mgr)', 'ผู้จัดการโรงงาน (Plant Manager)', 'MGT', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 'APPROVER', 'Plant Manager', 3, 'ACTIVE', 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 'อนุมัติสั่งซื้อ (Final Approver), ออก PO อัตโนมัติ, คุมงบประมาณ'),
('USR-0006', 'EMP-WH-001', 'somkid.wh', 'somkid.wh@company.com', 'password123', 'password123', 'คุณสมคิด (Warehouse)', 'คุณสมคิด คลังทอง', 'Somkid (WH)', 'หัวหน้าแผนกคลังสินค้า', 'WH', 'WH', '["WH","PD","QC"]', 'WAREHOUSE', 'WAREHOUSE', 'WAREHOUSE', 'Warehouse Supervisor', 2, 'ACTIVE', 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0, 1, 'ตรวจรับของ (GRN), บันทึกเข้าสต็อก, จัดการคลัง'),
('USR-0007', 'EMP-ADM-001', 'admin', 'admin@company.com', 'password123', 'password123', 'ผู้ดูแลระบบ (Admin)', 'นายแอดมิน สูงสุด', 'Admin System', 'ผู้ดูแลระบบส่วนกลาง', 'ALL', 'ALL', '["*"]', 'ADMIN', 'ADMIN', 'ADMIN', 'System Administrator', 99, 'ACTIVE', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'ผู้ดูแลระบบ สิทธิ์สูงสุดในการจัดการข้อมูลทุกส่วน');

-- Storage Locations
INSERT INTO storage_locations (id, name, department) VALUES
('LOC-PD-001', 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)', 'PD'),
('LOC-PD-002', 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)', 'PD'),
('LOC-PD-003', 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)', 'PD'),
('LOC-PD-004', 'ห้องแพ็คเกจจิ้ง', 'PD'),
('LOC-QC-001', 'ตู้เก็บสารเคมีทดสอบ (Lab 1)', 'QC'),
('LOC-QC-002', 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)', 'QC'),
('LOC-QC-003', 'ตู้ควบคุมอุณหภูมิ 4°C (Cold Storage)', 'QC'),
('LOC-GEN-001', 'คลังพัสดุกลาง', 'ALL');

-- Usage Units
INSERT INTO usage_units (id, name, department, dot, color, status) VALUES
('UNIT-PD-001', 'ห้อง K1', 'PD', 'bg-blue-500', 'bg-blue-50 text-blue-700 border-blue-200/80', 'ACTIVE'),
('UNIT-PD-002', 'ห้อง K2', 'PD', 'bg-violet-500', 'bg-violet-50 text-violet-700 border-violet-200/80', 'ACTIVE'),
('UNIT-PD-003', 'ห้องผลไม้', 'PD', 'bg-emerald-500', 'bg-emerald-50 text-emerald-700 border-emerald-200/80', 'ACTIVE'),
('UNIT-PD-004', 'ห้องแพ็ค', 'PD', 'bg-amber-500', 'bg-amber-50 text-amber-700 border-amber-200/80', 'ACTIVE'),
('UNIT-PD-005', 'ออฟฟิศ PD', 'PD', 'bg-slate-500', 'bg-slate-100 text-slate-700 border-slate-200/80', 'ACTIVE'),
('UNIT-QC-001', 'Lab เคมี', 'QC', 'bg-cyan-500', 'bg-cyan-50 text-cyan-700 border-cyan-200/80', 'ACTIVE'),
('UNIT-QC-002', 'Lab จุลชีววิทยา', 'QC', 'bg-teal-500', 'bg-teal-50 text-teal-700 border-teal-200/80', 'ACTIVE'),
('UNIT-QC-003', 'ห้อง Sensory', 'QC', 'bg-fuchsia-500', 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/80', 'ACTIVE');

-- Products Master Data
INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, isDirectUsage, department) VALUES
('PROD-PD-001', 'PD-OIL-068', 'น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)', 'PD', 'ถัง (200L)', 'ลิตร', 200, 2, 5, 14500, 'LOC-PD-001', 0, 'PD'),
('PROD-PD-002', 'PD-BLT-B52', 'สายพานลำเลียง V-Belt B-52 (เกรดอาหาร ทนความร้อน)', 'PD', 'เส้น', 'เส้น', 1, 10, 24, 450, 'LOC-PD-002', 0, 'PD'),
('PROD-PD-003', 'PD-GLV-NIT', 'ถุงมือไนไตรสีฟ้า Food Grade (Size L, 100 ชิ้น/กล่อง)', 'PD', 'กล่อง', 'กล่อง', 1, 20, 65, 180, 'LOC-PD-003', 1, 'PD'),
('PROD-PD-004', 'PD-FLM-LLD', 'ฟิล์มยืดพันพาเลท LLDPE 15 ไมครอน (500 มม. x 300 ม.)', 'PD', 'ม้วน', 'ม้วน', 1, 30, 80, 220, 'LOC-PD-004', 1, 'PD'),
('PROD-QC-001', 'QC-CHM-ET70', 'แอลกอฮอล์สำหรับฆ่าเชื้อ 70% Ethyl Alcohol (Food Grade)', 'QC', 'แกลลอน (20L)', 'ลิตร', 20, 5, 12, 1250, 'LOC-QC-001', 0, 'QC'),
('PROD-QC-002', 'QC-MED-PCA', 'อาหารเลี้ยงเชื้อ Plate Count Agar (PCA) 500g', 'QC', 'ขวด', 'ขวด', 1, 3, 7, 2800, 'LOC-QC-002', 0, 'QC'),
('PROD-QC-003', 'QC-KIT-ATP', 'ชุดทดสอบความสะอาดพื้นผิว ATP Surface Swab Test (100 ชิ้น)', 'QC', 'กล่อง', 'กล่อง', 1, 2, 4, 8500, 'LOC-QC-003', 1, 'QC');

-- Vendors Master Data
INSERT INTO vendors (id, code, name, contactPerson, phone, email, address, taxId, paymentTerm, department) VALUES
('VND-001', 'V-INDUSUP', 'บริษัท สยามอินดัสเทรียล ซัพพลาย จำกัด', 'คุณสมเกียรติ มั่งมี', '02-789-4561', 'sales@siamindusup.co.th', '123/45 ถนนบางนา-ตราด กม.18 ต.บางโฉลง อ.บางพลี จ.สมุทรปราการ 10540', '0105556012345', 'เครดิต 30 วัน', 'PD'),
('VND-002', 'V-QCLAB', 'บริษัท ควอลิตี้ แล็ป แอนด์ เคมีคอล จำกัด', 'คุณนฤมล วิทยากร', '02-345-6789', 'contact@qclabchem.com', '88/9 อาคารเคมีพลาซ่า ถนนพระราม 3 แขวงบางโพงพาง เขตยานนาวา กรุงเทพฯ 10120', '0105558098765', 'เครดิต 45 วัน', 'QC'),
('VND-003', 'V-PACKPRO', 'บริษัท แพ็คเกจจิ้ง โปร ซัพพลาย จำกัด', 'คุณสุชาติ ห่อทอง', '02-987-6543', 'info@packpro.co.th', '555 หมู่ 4 นิคมอุตสาหกรรมบางปู ต.แพรกษา อ.เมือง จ.สมุทรปราการ 10280', '0105557045678', 'เครดิต 30 วัน', 'PD');

-- Counters for PR/PO
INSERT INTO counters (name, prefix, lastNumber) VALUES
('PR_PD', 'PR-PD', 100),
('PR_QC', 'PR-QC', 100),
('PO', 'PO', 50);
