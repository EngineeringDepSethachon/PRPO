-- ====================================================================
-- Migration 0005_budget_columns : เติมคอลัมน์จริงสำหรับฟิลด์งบประมาณ / ช่องทางซื้อ
-- ใช้ ALTER TABLE ADD COLUMN + CREATE INDEX IF NOT EXISTS เท่านั้น
-- ไม่มี DROP/DELETE/UPDATE ; ไม่แก้ 0001-0004
--
-- อ้างอิง GAS (ระบบเดิม):
--   gas/Code.gs:2443-2451  : poObj.budgetPeriod (YYYY-MM), committedAmount, actualPaidAmount
--   gas/Code.gs:2490       : committedAmount ใช้ในการคำนวณงบ
--   gas/Code.gs:2814       : actualPaidAmount จาก actualTotalAmount
--   gas/SheetService.gs:1024-1043 : คอลัมน์ budgetPeriod / committedAmount / actualPaidAmount /
--                                    purchaseChannel / actualTotalAmount ของชีต POs
--   prs.purchaseChannel    : ช่องทางซื้อของ PR (GAS enforce เป็น 'ONLINE' ที่ Code.gs:1021-1023, 1107)
--   prs.poNumber           : คอลัมน์จริงจาก 0004 ; เก็บเลข PO แบบ comma-joined ตาม GAS
--                            (ระบุว่า Code.gs:1691 ; หมายเหตุ: ตอนเขียนไฟล์นี้ยังไม่ยืนยันการ join ที่บรรทัดนั้น)
--
-- ฟิลด์ที่เคยอยู่ใน extraJson (pos.extraJson / prs.extraJson จาก 0004) เช่น budgetPeriod,
-- committedAmount, actualPaidAmount, actualTotalAmount, purchaseChannel
-- ตอนนี้ถูกเพิ่มเป็นคอลัมน์จริงแล้ว ; การย้ายค่าเดิมจาก extraJson -> คอลัมน์ยังไม่ได้ทำในไฟล์นี้
-- (ข้อกำหนดงานห้าม UPDATE ; ต้องทำเป็นขั้นตอนแยกที่ผู้ใช้อนุมัติ)
-- ค่าเริ่มต้น committedAmount/actualPaidAmount = 0 คงที่ จึงใช้กับ ALTER ADD COLUMN ได้
-- ====================================================================

-- pos : คอลัมน์งบประมาณ + ช่องทางซื้อ
ALTER TABLE pos ADD COLUMN budgetPeriod TEXT;                    -- 'YYYY-MM'
ALTER TABLE pos ADD COLUMN committedAmount REAL DEFAULT 0;
ALTER TABLE pos ADD COLUMN actualPaidAmount REAL DEFAULT 0;
ALTER TABLE pos ADD COLUMN actualTotalAmount REAL;
ALTER TABLE pos ADD COLUMN purchaseChannel TEXT;

-- prs : ช่องทางซื้อ
ALTER TABLE prs ADD COLUMN purchaseChannel TEXT;

-- Indexes (ชื่อคอลัมน์ department/status ตรงกับ 0001_init.sql)
-- หมายเหตุ: 0001 มี idx_prs_department_status และ idx_pos_department_status (คู่ 2 คอลัมน์)
-- ซึ่งไม่ซ้ำกับ index ตัวเดียว (status) ที่สร้างด้านล่าง
CREATE INDEX IF NOT EXISTS idx_pos_dept_period ON pos(department, budgetPeriod);
CREATE INDEX IF NOT EXISTS idx_prs_status ON prs(status);
