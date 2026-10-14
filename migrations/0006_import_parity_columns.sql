-- ====================================================================
-- Migration 0006_import_parity_columns : คอลัมน์ที่ขาดจากการเทียบชีต GAS (พบจาก QA ของ importer T4.2)
-- ใช้ ALTER TABLE ADD COLUMN + CREATE INDEX IF NOT EXISTS เท่านั้น ไม่มี DROP/DELETE/UPDATE ; ไม่แก้ 0001-0005
--
-- budget_transactions : ledger BudgetView อ่าน amount ?? refundAmount ?? creditAmount, docNo || poNumber ;
--                       ตัวกันซ้ำ (budgetService.js:489-494, gas Code.gs:3639-3653) ใช้ transactionId / type + docNo
-- budgets             : pending / historicalSpent / refundCredits / month ของชีต Budgets
-- products / vendors / storage_locations : status + isActive (ปิดใช้งาน แยกจากลบ isDeleted) ;
--                       products.leadTimeDays / locationName ที่หน้า StockCard / QuickIssue ใช้
-- stock_logs          : เลือกเป็นคอลัมน์จริง (ไม่ใช้ extraJson) เพราะ GET ใช้ SELECT * คืนค่าให้ทันที
--                       ไม่ต้อง merge JSON ตอนอ่าน และกรอง/จัดเรียงตามคอลัมน์ได้
-- ====================================================================

-- budget_transactions
ALTER TABLE budget_transactions ADD COLUMN refundAmount REAL;
ALTER TABLE budget_transactions ADD COLUMN creditAmount REAL;
ALTER TABLE budget_transactions ADD COLUMN docType TEXT;
ALTER TABLE budget_transactions ADD COLUMN docNo TEXT;
ALTER TABLE budget_transactions ADD COLUMN poNumber TEXT;
ALTER TABLE budget_transactions ADD COLUMN transactionId TEXT;
ALTER TABLE budget_transactions ADD COLUMN actorRole TEXT;
CREATE INDEX IF NOT EXISTS idx_budget_tx_transactionId ON budget_transactions(transactionId);
CREATE INDEX IF NOT EXISTS idx_budget_tx_type_docNo ON budget_transactions(type, docNo);

-- budgets
ALTER TABLE budgets ADD COLUMN pendingAmount REAL DEFAULT 0;
ALTER TABLE budgets ADD COLUMN historicalSpentJson TEXT;   -- JSON object (ชีต historicalSpent)
ALTER TABLE budgets ADD COLUMN refundCreditsJson TEXT;     -- JSON object (ชีต refundCredits ต่อเดือน)
ALTER TABLE budgets ADD COLUMN month TEXT;

-- products
ALTER TABLE products ADD COLUMN leadTimeDays REAL;
ALTER TABLE products ADD COLUMN locationName TEXT;
ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'ACTIVE';
ALTER TABLE products ADD COLUMN isActive INTEGER DEFAULT 1;

-- vendors
ALTER TABLE vendors ADD COLUMN status TEXT DEFAULT 'ACTIVE';
ALTER TABLE vendors ADD COLUMN isActive INTEGER DEFAULT 1;

-- storage_locations
ALTER TABLE storage_locations ADD COLUMN isActive INTEGER DEFAULT 1;

-- stock_logs
ALTER TABLE stock_logs ADD COLUMN conversionRate REAL;
ALTER TABLE stock_logs ADD COLUMN unitPrice REAL;
ALTER TABLE stock_logs ADD COLUMN totalPrice REAL;
ALTER TABLE stock_logs ADD COLUMN locationId TEXT;
ALTER TABLE stock_logs ADD COLUMN date TEXT;
ALTER TABLE stock_logs ADD COLUMN grnNumber TEXT;
