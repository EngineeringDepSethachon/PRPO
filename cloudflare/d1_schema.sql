-- DEPRECATED: à¹ƒà¸Šà¹‰à¹„à¸Ÿà¸¥à¹Œà¹ƒà¸™ migrations/ à¹à¸—à¸™ (à¸­à¸¢à¹ˆà¸²à¹ƒà¸Šà¹‰à¹„à¸Ÿà¸¥à¹Œà¸™à¸µà¹‰à¸à¸±à¸šà¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ˆà¸£à¸´à¸‡ à¹€à¸žà¸£à¸²à¸°à¸¡à¸µ DROP TABLE)
-- ====================================================================
-- Cloudflare D1 SQL Schema & Seed Data for PRPO_PDQC
-- Database ID: c64022bb-88eb-485f-94f7-dd9e9617e44c
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
-- NOTE: remark / remarkUpdatedAt / remarkUpdatedBy (and avgCost, leadTimeDays ...) are added by migrations/0017 (and 0004, 0006) ALTER TABLE on top of this
-- baseline, so they are NOT repeated here (a duplicate column would make the ALTER fail).

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
    productCode TEXT,                -- à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸² à¹€à¸Šà¹ˆà¸™ PD-OIL-068
    productName TEXT,                -- à¸Šà¸·à¹ˆà¸­à¸ªà¸´à¸™à¸„à¹‰à¸²
    type TEXT NOT NULL,              -- 'IN'=à¸£à¸±à¸šà¹€à¸‚à¹‰à¸², 'OUT'=à¹€à¸šà¸´à¸à¸ˆà¹ˆà¸²à¸¢, 'ADJUST'=à¸›à¸£à¸±à¸šà¸ªà¸•à¹‡à¸­à¸, 'RETURN'=à¸„à¸·à¸™à¸‚à¸­à¸‡
    docType TEXT,                    -- 'GRN'=à¹ƒà¸šà¸£à¸±à¸šà¸ªà¸´à¸™à¸„à¹‰à¸², 'ISSUE'=à¹€à¸šà¸´à¸à¸ˆà¹ˆà¸²à¸¢, 'ADJUST'=à¸›à¸£à¸±à¸š
    docNo TEXT,                      -- à¹€à¸¥à¸‚à¸—à¸µà¹ˆà¹€à¸­à¸à¸ªà¸²à¸£ à¹€à¸Šà¹ˆà¸™ GRN-PO-PD-001, REQ-1234
    referenceNo TEXT,                -- à¹€à¸¥à¸‚à¸­à¹‰à¸²à¸‡à¸­à¸´à¸‡ (PO No, PR No)
    poNo TEXT,                       -- à¹€à¸¥à¸‚à¸—à¸µà¹ˆ PO à¸—à¸µà¹ˆà¸­à¹‰à¸²à¸‡à¸­à¸´à¸‡ (à¸ªà¸³à¸«à¸£à¸±à¸š GRN)
    quantity REAL NOT NULL,          -- à¸ˆà¸³à¸™à¸§à¸™à¸—à¸µà¹ˆà¸£à¸±à¸š/à¹€à¸šà¸´à¸ (à¹€à¸›à¹‡à¸™à¸šà¸§à¸à¹€à¸ªà¸¡à¸­)
    changeQty REAL,                  -- Â±à¸ˆà¸³à¸™à¸§à¸™à¸—à¸µà¹ˆà¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¹à¸›à¸¥à¸‡ (à¸¥à¸š=à¹€à¸šà¸´à¸, à¸šà¸§à¸=à¸£à¸±à¸š)
    balance REAL NOT NULL,           -- à¸¢à¸­à¸”à¸„à¸‡à¹€à¸«à¸¥à¸·à¸­à¸«à¸¥à¸±à¸‡à¸—à¸³à¸£à¸²à¸¢à¸à¸²à¸£
    unit TEXT,                       -- à¸«à¸™à¹ˆà¸§à¸¢à¸‚à¸­à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸² à¹€à¸Šà¹ˆà¸™ à¸Šà¸´à¹‰à¸™, à¸¥à¸´à¸•à¸£, à¸¡à¹‰à¸§à¸™
    department TEXT NOT NULL,        -- à¹à¸œà¸™à¸à¸‚à¸­à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸² à¹€à¸Šà¹ˆà¸™ PD, QC
    location TEXT,                   -- à¸«à¹‰à¸­à¸‡/à¸«à¸™à¹ˆà¸§à¸¢à¸—à¸µà¹ˆà¹€à¸šà¸´à¸à¹ƒà¸Šà¹‰à¸‡à¸²à¸™ à¹€à¸Šà¹ˆà¸™ 'à¸«à¹‰à¸­à¸‡ K1', 'Lab à¹€à¸„à¸¡à¸µ'
    issuedTo TEXT,                   -- à¸Šà¸·à¹ˆà¸­à¸«à¹‰à¸­à¸‡/à¸«à¸™à¹ˆà¸§à¸¢à¸‡à¸²à¸™à¸—à¸µà¹ˆà¸£à¸±à¸šà¸‚à¸­à¸‡
    issueUnit TEXT,                  -- ID à¸«à¸™à¹ˆà¸§à¸¢à¹ƒà¸Šà¹‰à¸‡à¸²à¸™ (usage unit id à¸«à¸£à¸·à¸­ name)
    unitCost REAL DEFAULT 0,         -- à¸•à¹‰à¸™à¸—à¸¸à¸™à¸•à¹ˆà¸­à¸«à¸™à¹ˆà¸§à¸¢ à¸“ à¹€à¸§à¸¥à¸²à¹€à¸šà¸´à¸ (Moving Average Cost)
    totalCost REAL DEFAULT 0,        -- à¸¡à¸¹à¸¥à¸„à¹ˆà¸²à¸£à¸§à¸¡ = quantity Ã— unitCost
    actorId TEXT,                    -- ID/username à¸œà¸¹à¹‰à¸—à¸³à¸£à¸²à¸¢à¸à¸²à¸£
    actorName TEXT,                  -- à¸Šà¸·à¹ˆà¸­à¸œà¸¹à¹‰à¸—à¸³à¸£à¸²à¸¢à¸à¸²à¸£
    performedBy TEXT,                -- à¸Šà¸·à¹ˆà¸­à¸œà¸¹à¹‰à¸—à¸³à¸£à¸²à¸¢à¸à¸²à¸£ (backward compat)
    notes TEXT,                      -- à¸«à¸¡à¸²à¸¢à¹€à¸«à¸•à¸¸/à¹€à¸«à¸•à¸¸à¸œà¸¥à¸à¸²à¸£à¹€à¸šà¸´à¸
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
('DEPT-PD', 'PD', 'à¸à¹ˆà¸²à¸¢à¸œà¸¥à¸´à¸•', 'Production', 'PD', 'à¸£à¸±à¸šà¸œà¸´à¸”à¸Šà¸­à¸šà¸à¸£à¸°à¸šà¸§à¸™à¸à¸²à¸£à¹à¸›à¸£à¸£à¸¹à¸› à¸„à¸§à¸šà¸„à¸¸à¸¡à¸à¸²à¸£à¸œà¸¥à¸´à¸• à¹à¸¥à¸°à¸”à¸¹à¹à¸¥à¹„à¸¥à¸™à¹Œà¸œà¸¥à¸´à¸•à¸ªà¸´à¸™à¸„à¹‰à¸²', 250000, 1, 'blue', 'à¸„à¸¸à¸“à¸›à¸£à¸°à¹€à¸ªà¸£à¸´à¸ à¸¢à¸´à¹ˆà¸‡à¸¢à¸‡', CURRENT_TIMESTAMP),
('DEPT-QC', 'QC', 'à¸à¹ˆà¸²à¸¢à¸„à¸§à¸šà¸„à¸¸à¸¡à¸„à¸¸à¸“à¸ à¸²à¸ž', 'Quality Control & Lab', 'QC', 'à¸•à¸£à¸§à¸ˆà¸ªà¸­à¸šà¸„à¸¸à¸“à¸ à¸²à¸ž à¸§à¸±à¸•à¸–à¸¸à¸”à¸´à¸š à¸ªà¸²à¸£à¹€à¸„à¸¡à¸µ à¸šà¸£à¸£à¸ˆà¸¸à¸ à¸±à¸“à¸‘à¹Œ à¹à¸¥à¸°à¸‡à¸²à¸™à¹à¸¥à¹‡à¸šà¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œ', 150000, 1, 'amber', 'à¸”à¸£. à¸à¸£à¸£à¸“à¸´à¸à¸²à¸£à¹Œ à¸ˆà¸´à¸•à¹€à¸ˆà¸£à¸´à¸', CURRENT_TIMESTAMP),
('DEPT-WH', 'WH', 'à¸à¹ˆà¸²à¸¢à¸„à¸¥à¸±à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²', 'Warehouse & Inventory', 'WH', 'à¸šà¸£à¸´à¸«à¸²à¸£à¸„à¸¥à¸±à¸‡à¸ˆà¸±à¸”à¹€à¸à¹‡à¸šà¸ªà¸´à¸™à¸„à¹‰à¸² à¸§à¸±à¸•à¸–à¸¸à¸”à¸´à¸š à¸Šà¸´à¹‰à¸™à¸ªà¹ˆà¸§à¸™ à¹à¸¥à¸°à¸•à¸£à¸§à¸ˆà¸£à¸±à¸šà¸à¸£à¸°à¸ˆà¸²à¸¢à¸ªà¸•à¹‡à¸­à¸', 120000, 1, 'emerald', 'à¸„à¸¸à¸“à¸ªà¸¡à¸„à¸´à¸” à¸„à¸¥à¸±à¸‡à¸—à¸­à¸‡', CURRENT_TIMESTAMP),
('DEPT-PUR', 'PUR', 'à¸à¹ˆà¸²à¸¢à¸ˆà¸±à¸”à¸‹à¸·à¹‰à¸­', 'Procurement & Sourcing', 'PUR', 'à¸ˆà¸±à¸”à¸«à¸²à¸œà¸¹à¹‰à¸ˆà¸±à¸”à¸ˆà¸³à¸«à¸™à¹ˆà¸²à¸¢ à¹€à¸›à¸£à¸µà¸¢à¸šà¹€à¸—à¸µà¸¢à¸šà¸£à¸²à¸„à¸² à¸ˆà¸±à¸”à¸‹à¸·à¹‰à¸­à¸žà¸±à¸ªà¸”à¸¸à¹à¸¥à¸°à¸­à¸¸à¸›à¸à¸£à¸“à¹Œ', 100000, 1, 'purple', 'à¸„à¸¸à¸“à¸ªà¸¸à¸”à¸² à¸ˆà¸±à¸”à¸«à¸²à¸”à¸µ', CURRENT_TIMESTAMP),
('DEPT-ENG', 'ENG', 'à¸à¹ˆà¸²à¸¢à¸§à¸´à¸¨à¸§à¸à¸£à¸£à¸¡à¹à¸¥à¸°à¸‹à¹ˆà¸­à¸¡à¸šà¸³à¸£à¸¸à¸‡', 'Engineering & Maintenance', 'ENG', 'à¸”à¸¹à¹à¸¥à¸£à¸±à¸à¸©à¸²à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸ˆà¸±à¸à¸£ à¸£à¸°à¸šà¸šà¸ªà¸²à¸˜à¸²à¸£à¸“à¸¹à¸›à¹‚à¸ à¸„ à¹à¸¥à¸°à¸‡à¸²à¸™à¸‹à¹ˆà¸­à¸¡à¸šà¸³à¸£à¸¸à¸‡à¹‚à¸£à¸‡à¸‡à¸²à¸™', 180000, 1, 'cyan', 'à¸§à¸´à¸¨à¸§à¸à¸£ à¸Šà¹ˆà¸²à¸‡à¸—à¸­à¸‡', CURRENT_TIMESTAMP);

-- Users
-- SECURITY: the users seed rows (with plaintext default passwords) were removed.
-- Create the first admin out-of-band (hash with functions/_lib/password.js) or use
-- ALLOW_DEV_SEED=true + DEV_SEED_PASSWORD for local dev only (see .dev.vars.example).

-- Storage Locations
INSERT INTO storage_locations (id, name, department) VALUES
('LOC-PD-001', 'à¸Šà¸±à¹‰à¸™à¸§à¸²à¸‡ A-01 (à¸ªà¸²à¸£à¸«à¸¥à¹ˆà¸­à¸¥à¸·à¹ˆà¸™ & à¸™à¹‰à¸³à¸¡à¸±à¸™)', 'PD'),
('LOC-PD-002', 'à¸Šà¸±à¹‰à¸™à¸§à¸²à¸‡ A-02 (à¸­à¸°à¹„à¸«à¸¥à¹ˆà¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸ˆà¸±à¸à¸£ & à¸ªà¸²à¸¢à¸žà¸²à¸™)', 'PD'),
('LOC-PD-003', 'à¸•à¸¹à¹‰à¹€à¸à¹‡à¸šà¸­à¸¸à¸›à¸à¸£à¸“à¹Œà¸„à¸§à¸²à¸¡à¸›à¸¥à¸­à¸”à¸ à¸±à¸¢ (PPE)', 'PD'),
('LOC-PD-004', 'à¸«à¹‰à¸­à¸‡à¹à¸žà¹‡à¸„à¹€à¸à¸ˆà¸ˆà¸´à¹‰à¸‡', 'PD'),
('LOC-QC-001', 'à¸•à¸¹à¹‰à¹€à¸à¹‡à¸šà¸ªà¸²à¸£à¹€à¸„à¸¡à¸µà¸—à¸”à¸ªà¸­à¸š (Lab 1)', 'QC'),
('LOC-QC-002', 'à¸Šà¸±à¹‰à¸™à¸§à¸²à¸‡à¸­à¸²à¸«à¸²à¸£à¹€à¸¥à¸µà¹‰à¸¢à¸‡à¹€à¸Šà¸·à¹‰à¸­ (Media Shelf B)', 'QC'),
('LOC-QC-003', 'à¸•à¸¹à¹‰à¸„à¸§à¸šà¸„à¸¸à¸¡à¸­à¸¸à¸“à¸«à¸ à¸¹à¸¡à¸´ 4Â°C (Cold Storage)', 'QC'),
('LOC-GEN-001', 'à¸„à¸¥à¸±à¸‡à¸žà¸±à¸ªà¸”à¸¸à¸à¸¥à¸²à¸‡', 'ALL');

-- Usage Units
INSERT INTO usage_units (id, name, department, dot, color, status) VALUES
('UNIT-PD-001', 'à¸«à¹‰à¸­à¸‡ K1', 'PD', 'bg-blue-500', 'bg-blue-50 text-blue-700 border-blue-200/80', 'ACTIVE'),
('UNIT-PD-002', 'à¸«à¹‰à¸­à¸‡ K2', 'PD', 'bg-violet-500', 'bg-violet-50 text-violet-700 border-violet-200/80', 'ACTIVE'),
('UNIT-PD-003', 'à¸«à¹‰à¸­à¸‡à¸œà¸¥à¹„à¸¡à¹‰', 'PD', 'bg-emerald-500', 'bg-emerald-50 text-emerald-700 border-emerald-200/80', 'ACTIVE'),
('UNIT-PD-004', 'à¸«à¹‰à¸­à¸‡à¹à¸žà¹‡à¸„', 'PD', 'bg-amber-500', 'bg-amber-50 text-amber-700 border-amber-200/80', 'ACTIVE'),
('UNIT-PD-005', 'à¸­à¸­à¸Ÿà¸Ÿà¸´à¸¨ PD', 'PD', 'bg-slate-500', 'bg-slate-100 text-slate-700 border-slate-200/80', 'ACTIVE'),
('UNIT-QC-001', 'Lab à¹€à¸„à¸¡à¸µ', 'QC', 'bg-cyan-500', 'bg-cyan-50 text-cyan-700 border-cyan-200/80', 'ACTIVE'),
('UNIT-QC-002', 'Lab à¸ˆà¸¸à¸¥à¸Šà¸µà¸§à¸§à¸´à¸—à¸¢à¸²', 'QC', 'bg-teal-500', 'bg-teal-50 text-teal-700 border-teal-200/80', 'ACTIVE'),
('UNIT-QC-003', 'à¸«à¹‰à¸­à¸‡ Sensory', 'QC', 'bg-fuchsia-500', 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/80', 'ACTIVE');

-- Products Master Data
INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, isDirectUsage, department) VALUES
('PROD-PD-001', 'PD-OIL-068', 'à¸™à¹‰à¸³à¸¡à¸±à¸™à¹„à¸®à¸”à¸£à¸­à¸¥à¸´à¸à¸­à¸¸à¸•à¸ªà¸²à¸«à¸à¸£à¸£à¸¡ (Hydraulic Oil ISO VG 68)', 'PD', 'à¸–à¸±à¸‡ (200L)', 'à¸¥à¸´à¸•à¸£', 200, 2, 5, 14500, 'LOC-PD-001', 0, 'PD'),
('PROD-PD-002', 'PD-BLT-B52', 'à¸ªà¸²à¸¢à¸žà¸²à¸™à¸¥à¸³à¹€à¸¥à¸µà¸¢à¸‡ V-Belt B-52 (à¹€à¸à¸£à¸”à¸­à¸²à¸«à¸²à¸£ à¸—à¸™à¸„à¸§à¸²à¸¡à¸£à¹‰à¸­à¸™)', 'PD', 'à¹€à¸ªà¹‰à¸™', 'à¹€à¸ªà¹‰à¸™', 1, 10, 24, 450, 'LOC-PD-002', 0, 'PD'),
('PROD-PD-003', 'PD-GLV-NIT', 'à¸–à¸¸à¸‡à¸¡à¸·à¸­à¹„à¸™à¹„à¸•à¸£à¸ªà¸µà¸Ÿà¹‰à¸² Food Grade (Size L, 100 à¸Šà¸´à¹‰à¸™/à¸à¸¥à¹ˆà¸­à¸‡)', 'PD', 'à¸à¸¥à¹ˆà¸­à¸‡', 'à¸à¸¥à¹ˆà¸­à¸‡', 1, 20, 65, 180, 'LOC-PD-003', 1, 'PD'),
('PROD-PD-004', 'PD-FLM-LLD', 'à¸Ÿà¸´à¸¥à¹Œà¸¡à¸¢à¸·à¸”à¸žà¸±à¸™à¸žà¸²à¹€à¸¥à¸— LLDPE 15 à¹„à¸¡à¸„à¸£à¸­à¸™ (500 à¸¡à¸¡. x 300 à¸¡.)', 'PD', 'à¸¡à¹‰à¸§à¸™', 'à¸¡à¹‰à¸§à¸™', 1, 30, 80, 220, 'LOC-PD-004', 1, 'PD'),
('PROD-QC-001', 'QC-CHM-ET70', 'à¹à¸­à¸¥à¸à¸­à¸®à¸­à¸¥à¹Œà¸ªà¸³à¸«à¸£à¸±à¸šà¸†à¹ˆà¸²à¹€à¸Šà¸·à¹‰à¸­ 70% Ethyl Alcohol (Food Grade)', 'QC', 'à¹à¸à¸¥à¸¥à¸­à¸™ (20L)', 'à¸¥à¸´à¸•à¸£', 20, 5, 12, 1250, 'LOC-QC-001', 0, 'QC'),
('PROD-QC-002', 'QC-MED-PCA', 'à¸­à¸²à¸«à¸²à¸£à¹€à¸¥à¸µà¹‰à¸¢à¸‡à¹€à¸Šà¸·à¹‰à¸­ Plate Count Agar (PCA) 500g', 'QC', 'à¸‚à¸§à¸”', 'à¸‚à¸§à¸”', 1, 3, 7, 2800, 'LOC-QC-002', 0, 'QC'),
('PROD-QC-003', 'QC-KIT-ATP', 'à¸Šà¸¸à¸”à¸—à¸”à¸ªà¸­à¸šà¸„à¸§à¸²à¸¡à¸ªà¸°à¸­à¸²à¸”à¸žà¸·à¹‰à¸™à¸œà¸´à¸§ ATP Surface Swab Test (100 à¸Šà¸´à¹‰à¸™)', 'QC', 'à¸à¸¥à¹ˆà¸­à¸‡', 'à¸à¸¥à¹ˆà¸­à¸‡', 1, 2, 4, 8500, 'LOC-QC-003', 1, 'QC');

-- Vendors Master Data
INSERT INTO vendors (id, code, name, contactPerson, phone, email, address, taxId, paymentTerm, department) VALUES
('VND-001', 'V-INDUSUP', 'à¸šà¸£à¸´à¸©à¸±à¸— à¸ªà¸¢à¸²à¸¡à¸­à¸´à¸™à¸”à¸±à¸ªà¹€à¸—à¸£à¸µà¸¢à¸¥ à¸‹à¸±à¸žà¸žà¸¥à¸²à¸¢ à¸ˆà¸³à¸à¸±à¸”', 'à¸„à¸¸à¸“à¸ªà¸¡à¹€à¸à¸µà¸¢à¸£à¸•à¸´ à¸¡à¸±à¹ˆà¸‡à¸¡à¸µ', '02-789-4561', 'sales@siamindusup.co.th', '123/45 à¸–à¸™à¸™à¸šà¸²à¸‡à¸™à¸²-à¸•à¸£à¸²à¸” à¸à¸¡.18 à¸•.à¸šà¸²à¸‡à¹‚à¸‰à¸¥à¸‡ à¸­.à¸šà¸²à¸‡à¸žà¸¥à¸µ à¸ˆ.à¸ªà¸¡à¸¸à¸—à¸£à¸›à¸£à¸²à¸à¸²à¸£ 10540', '0105556012345', 'à¹€à¸„à¸£à¸”à¸´à¸• 30 à¸§à¸±à¸™', 'PD'),
('VND-002', 'V-QCLAB', 'à¸šà¸£à¸´à¸©à¸±à¸— à¸„à¸§à¸­à¸¥à¸´à¸•à¸µà¹‰ à¹à¸¥à¹‡à¸› à¹à¸­à¸™à¸”à¹Œ à¹€à¸„à¸¡à¸µà¸„à¸­à¸¥ à¸ˆà¸³à¸à¸±à¸”', 'à¸„à¸¸à¸“à¸™à¸¤à¸¡à¸¥ à¸§à¸´à¸—à¸¢à¸²à¸à¸£', '02-345-6789', 'contact@qclabchem.com', '88/9 à¸­à¸²à¸„à¸²à¸£à¹€à¸„à¸¡à¸µà¸žà¸¥à¸²à¸‹à¹ˆà¸² à¸–à¸™à¸™à¸žà¸£à¸°à¸£à¸²à¸¡ 3 à¹à¸‚à¸§à¸‡à¸šà¸²à¸‡à¹‚à¸žà¸‡à¸žà¸²à¸‡ à¹€à¸‚à¸•à¸¢à¸²à¸™à¸™à¸²à¸§à¸² à¸à¸£à¸¸à¸‡à¹€à¸—à¸žà¸¯ 10120', '0105558098765', 'à¹€à¸„à¸£à¸”à¸´à¸• 45 à¸§à¸±à¸™', 'QC'),
('VND-003', 'V-PACKPRO', 'à¸šà¸£à¸´à¸©à¸±à¸— à¹à¸žà¹‡à¸„à¹€à¸à¸ˆà¸ˆà¸´à¹‰à¸‡ à¹‚à¸›à¸£ à¸‹à¸±à¸žà¸žà¸¥à¸²à¸¢ à¸ˆà¸³à¸à¸±à¸”', 'à¸„à¸¸à¸“à¸ªà¸¸à¸Šà¸²à¸•à¸´ à¸«à¹ˆà¸­à¸—à¸­à¸‡', '02-987-6543', 'info@packpro.co.th', '555 à¸«à¸¡à¸¹à¹ˆ 4 à¸™à¸´à¸„à¸¡à¸­à¸¸à¸•à¸ªà¸²à¸«à¸à¸£à¸£à¸¡à¸šà¸²à¸‡à¸›à¸¹ à¸•.à¹à¸žà¸£à¸à¸©à¸² à¸­.à¹€à¸¡à¸·à¸­à¸‡ à¸ˆ.à¸ªà¸¡à¸¸à¸—à¸£à¸›à¸£à¸²à¸à¸²à¸£ 10280', '0105557045678', 'à¹€à¸„à¸£à¸”à¸´à¸• 30 à¸§à¸±à¸™', 'PD');

-- Counters for PR/PO
INSERT INTO counters (name, prefix, lastNumber) VALUES
('PR_PD', 'PR-PD', 100),
('PR_QC', 'PR-QC', 100),
('PO', 'PO', 50);
