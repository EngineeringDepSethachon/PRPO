-- ====================================================================
-- Migration 0004_parity_columns : เติมคอลัมน์ให้ D1 ตรงกับฟิลด์ที่ frontend / GAS ใช้
-- อ้างอิง docs/parity.md หัวข้อ (e) D-1 และ D-2
-- ใช้ ALTER TABLE ADD COLUMN เท่านั้น ไม่มี DROP/DELETE/UPDATE ; ไม่แก้ 0001-0003
--
-- การแมปฟิลด์ (D-1 / D-2):
--   prs.extraJson  (TEXT, JSON object) เก็บฟิลด์ PR ที่ไม่มีคอลัมน์ เช่น
--                  purchaseChannel, vendorId, financials, memo, reviewedBy/At,
--                  approvedBy/At, rejectReason, cancelledBy/At, activityLog, poNumbers, workflowStatus
--   pos.extraJson  (TEXT, JSON object) เก็บฟิลด์ PO ที่ไม่มีคอลัมน์ เช่น
--                  purchaseChannel, financials, subtotal/vat, stakeholders,
--                  claim* (claimData, claimDetails, claimHistory, claimRound, claimStatus,
--                  storeClaims, claimResolution, totalRefunded, hasDispute), grnHistory,
--                  ngItems, receivedBy/receiverName/receiverSignature/receivingInfo/receivedAt,
--                  settlement*/actualTotalAmount/savingsAmount/actualItems,
--                  budgetPeriod/committedAmount/actualPaidAmount, orderStatus/subStatus, activityLog
--   prs.poNumber   (TEXT) คอลัมน์จริง ให้ query PR -> PO ได้โดยตรง (เก็บเลข PO หลักของ PR)
--   pos.isClosed   (INTEGER 0/1) คอลัมน์จริง ใช้กรองสถานะปิดงาน
--   products.avgCost (REAL) และ products.totalValue (REAL) คอลัมน์จริง ใช้กับ Moving Average Cost (MAC)
--                  (0001 ไม่มีคอลัมน์นี้ จึงเพิ่มที่นี่)
--
-- หมายเหตุ: ค่าใน extraJson อ่าน/เขียนผ่านโค้ดฝั่ง Functions (JSON.parse/stringify) ไม่ใช่ SQL
-- ค่าเริ่มต้น '{}' เป็นค่าคงที่ จึงใช้กับ ALTER ADD COLUMN ได้
-- ====================================================================

ALTER TABLE prs ADD COLUMN extraJson TEXT DEFAULT '{}';
ALTER TABLE prs ADD COLUMN poNumber TEXT;

ALTER TABLE pos ADD COLUMN extraJson TEXT DEFAULT '{}';
ALTER TABLE pos ADD COLUMN isClosed INTEGER DEFAULT 0;

ALTER TABLE products ADD COLUMN avgCost REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN totalValue REAL DEFAULT 0;
