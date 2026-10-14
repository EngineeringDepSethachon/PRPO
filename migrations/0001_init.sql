-- ====================================================================
-- Migration 0001_init : ตารางหลัก 13 ตัว (อิงจาก d1_schema.sql โดยตัดคำสั่งลบตาราง/seed ออก)
-- ใช้ CREATE ... IF NOT EXISTS ทั้งหมด รันซ้ำได้ ไม่ทำลายข้อมูล
--
-- เทียบชีต GAS (gas/Config.gs SHEET_NAMES) -> ตาราง D1
--   Departments        -> departments
--   Users              -> users
--   StorageLocations   -> storage_locations
--   UsageUnits         -> usage_units
--   Products           -> products
--   Vendors            -> vendors
--   Budgets            -> budgets
--   BudgetTransactions -> budget_transactions
--   PRs                -> prs        (รายการสินค้าเก็บเป็น itemsJson)
--   POs                -> pos        (รายการสินค้าเก็บเป็น itemsJson)
--   StockLogs          -> stock_logs
--   AuditLogs          -> audit_logs
--   PRCounters         -> counters   (เลขรายปีต่อแผนก/ประเภทดู doc_counters ใน 0002)
-- ไม่มี seed data ใน migration (ข้อมูลตั้งต้นทำใน seed แยก)
-- ====================================================================

-- 1. departments
CREATE TABLE IF NOT EXISTS departments (
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

-- 2. users
CREATE TABLE IF NOT EXISTS users (
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

-- 3. storage_locations
CREATE TABLE IF NOT EXISTS storage_locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL
);

-- 4. usage_units
CREATE TABLE IF NOT EXISTS usage_units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    dot TEXT,
    color TEXT,
    status TEXT DEFAULT 'ACTIVE'
);

-- 5. products
CREATE TABLE IF NOT EXISTS products (
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

-- 6. vendors
CREATE TABLE IF NOT EXISTS vendors (
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

-- 7. budgets
CREATE TABLE IF NOT EXISTS budgets (
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

-- 8. budget_transactions
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

-- 9. prs
CREATE TABLE IF NOT EXISTS prs (
    id TEXT PRIMARY KEY,
    prNumber TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    requesterId TEXT,
    requesterName TEXT,
    status TEXT NOT NULL,
    totalAmount REAL DEFAULT 0,
    reason TEXT,
    itemsJson TEXT NOT NULL,
    timelineJson TEXT,
    attachmentsJson TEXT,
    approvalWorkflowJson TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 10. pos
CREATE TABLE IF NOT EXISTS pos (
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

-- 11. stock_logs
CREATE TABLE IF NOT EXISTS stock_logs (
    id TEXT PRIMARY KEY,
    productId TEXT NOT NULL,
    productCode TEXT,
    productName TEXT,
    type TEXT NOT NULL,              -- 'IN','OUT','ADJUST','RETURN'
    docType TEXT,                    -- 'GRN','ISSUE','ADJUST'
    docNo TEXT,
    referenceNo TEXT,
    poNo TEXT,
    quantity REAL NOT NULL,          -- จำนวน (เป็นบวกเสมอ)
    changeQty REAL,                  -- +รับ / -เบิก
    balance REAL NOT NULL,           -- ยอดคงเหลือหลังทำรายการ
    unit TEXT,
    department TEXT NOT NULL,
    location TEXT,
    issuedTo TEXT,
    issueUnit TEXT,
    unitCost REAL DEFAULT 0,         -- Moving Average Cost ณ เวลาทำรายการ
    totalCost REAL DEFAULT 0,
    actorId TEXT,
    actorName TEXT,
    performedBy TEXT,
    notes TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 12. audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entityType TEXT,
    entityId TEXT,
    performedBy TEXT,
    details TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 13. counters
CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    prefix TEXT,
    lastNumber INTEGER DEFAULT 0,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);
CREATE INDEX IF NOT EXISTS idx_products_department ON products(department);
CREATE INDEX IF NOT EXISTS idx_prs_department_status ON prs(department, status);
CREATE INDEX IF NOT EXISTS idx_prs_createdAt ON prs(createdAt);
CREATE INDEX IF NOT EXISTS idx_pos_prId ON pos(prId);
CREATE INDEX IF NOT EXISTS idx_pos_department_status ON pos(department, status);
CREATE INDEX IF NOT EXISTS idx_stock_logs_productId ON stock_logs(productId);
CREATE INDEX IF NOT EXISTS idx_stock_logs_createdAt ON stock_logs(createdAt);
CREATE INDEX IF NOT EXISTS idx_budgets_dept_year ON budgets(department, fiscalYear);
CREATE INDEX IF NOT EXISTS idx_budget_tx_dept_period ON budget_transactions(department, period);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entityType, entityId);
