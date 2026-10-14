# Smoke test รอบ 3 (ทุกบทบาท + ภาษา) — 2026-10-14

ผู้ทดสอบ: Claude ตามคำสั่งผู้ใช้ ; สภาพแวดล้อม: build `npm run build:cf` เดียวกับที่ deploy production + `wrangler pages dev` บน localhost:8788 ต่อ D1/R2 local ที่ seed ด้วย `e2e/cf/global-setup.mjs` ; บัญชี fixture e2e.req / e2e.asst / e2e.plant / e2e.online / e2e.qc / e2e.must + e2e.admin (เพิ่มเองใน local)
รูปประกอบ: `docs/smoke-screenshots-2026-10-14/` (ชื่อไฟล์อ้างในตาราง)
ไม่ได้ทดสอบบน production เพราะต้อง login ด้วยรหัสจริง (ผู้ใช้ทำเองตาม runbook ขั้น 6)

## สิ่งที่ทำวันนี้นอกจากทดสอบ (M2)
- migrations 0013-0014 apply แล้วทั้ง `prpo-db` และ `prpo-db-preview` (backup ก่อนทำ: `C:\Users\Admin\prpo-backups\prpo-db-20261014-pre0013.sql`)
- ข้ามขั้น 4 (ผู้ใช้ยืนยันว่าไม่มีข้อมูลในชีตที่ต้องย้าย)
- deploy Preview (`https://preview.prpo-pdqc.pages.dev`) และ Production (`https://prpo-pdqc.pages.dev`) ; `/api/health` = 401, header CSP / X-Frame-Options DENY / nosniff ครบ
- สร้างแอดมิน production `admin` (ADMIN level 99, allowedDepartments ["*"]) ผู้ใช้ตั้งรหัสเองผ่าน `scripts/set-user-password.js` (hash อย่างเดียว, mustChangePassword=1, ไฟล์ SQL ลบแล้ว)
- commit `903ee19` (505 ไฟล์) ; **git push ถูกปฏิเสธสิทธิ์ 3 ครั้ง ผู้ใช้ต้อง push เอง**
- ลบไฟล์ temp: 4 ไฟล์ใน docs ไม่มีอยู่แล้ว ; `tests/_dbg_sig.test.js` และ `vt_tmp_out.json` ถูก permission บล็อก (ไม่ได้ commit ทั้งสอง) ผู้ใช้ลบเอง
- **ยังไม่ตัด GAS** (ต้องใช้บัญชี Google ของผู้ใช้ที่ script.google.com → Manage deployments → Archive)

## ผลตามโมดูล

| โมดูล | ผล | หมายเหตุ |
|---|---|---|
| Login / รหัสผิด / บังคับเปลี่ยนรหัส (e2e.must) | ✅ | ข้อความไทยถูกต้อง ; bootstrap ทันทีหลัง login ; ไม่มี /api/storage แล้ว |
| เปลี่ยนรหัสจากเมนูโปรไฟล์ | ✅ | POST /api/me/password 200 |
| Master Data: ผู้ขาย / จุดจัดเก็บ / สินค้า / แผนก / หน่วยเบิก / ผู้ใช้ | ✅ บันทึกได้ | S10 สร้างสินค้า+ผู้ขายยิง save 2 ครั้ง ; รันรหัสสินค้าอัตโนมัติได้ "1" (รูป 06, 17) |
| PR ออนไลน์ + รูปสินค้า → ตรวจทาน → อนุมัติ → Online Hub บันทึกราคาจริง → GRN + หลักฐาน | ✅ | ledger ถูก (commit 200 → actual 95 + rollback 105) ; MAC 91.25 ถูก ; หลักฐาน GRN ขึ้น R2 เปิดผ่าน /api/files ได้ (รูป 15) |
| PR ภายใน + ใบเสนอราคา PDF + เอกสารรวม → ส่งกลับแก้ไข → แก้/ส่งใหม่ → อนุมัติ → PO | ✅ | timeline/audit PR ครบ (รูป 14) ; ใบเสนอราคาขึ้น R2 ; เอกสารรวมและรูปสินค้า **เป็น base64 ใน PR** (S6) |
| GRN บางส่วน + NG + เคลม (เปลี่ยนสินค้า) → รับรอบ 2 | ⚠️ | สต็อก/MAC ถูก (16, 93.44) แต่ PO ค้าง PARTIALLY_RECEIVED_IN_CLAIM ทั้งที่รับครบ (S3) ; ไม่มี audit รับของ / แถว IN_NG (S8) |
| PO PDF (ฟอนต์ไทย) | ✅ | สร้าง PDF 114 KB โหลดฟอนต์จาก /fonts/THSarabunNew*.ttf (ดักจับ blob ไม่ได้ดาวน์โหลด) |
| งบประมาณ: Plant Mgr จัดสรร QC 50,000 | ✅ | budgets + MONTHLY_ALLOCATION + audit BUDGET_ALLOCATE |
| งบประมาณ: แอดมินจัดสรร | ❌ | ไม่มีปุ่ม เห็น "รอการจัดสรรงบประมาณจาก Asst. Manager" (S2, รูป 04) |
| คลัง: ปรับปรุงยอด (+/-) และรับเข้าคลัง Manual | ❌ | ปิดหน้าต่างเงียบ ๆ ไม่ยิง API ยอดไม่เปลี่ยน (S1, รูป 10-13) |
| เบิกจ่ายด่วน | ✅ (ทดสอบ 13 ต.ค.) | QC ไม่มีหน่วยเบิกจึงเบิกไม่ได้ (ต้องให้แอดมินเพิ่มก่อน) |
| สิทธิ์ข้ามแผนก (e2e.qc) | ✅ | bootstrap ไม่ส่ง PR/PO ของ PD ; เห็นสินค้าทุกแผนก (เดิม) |
| Audit Log (admin) | ⚠️ | ข้อมูลจริงจาก server 26 แถว ; ปุ่ม "ล้างประวัติธุรกรรมจำลอง" ยังโชว์ (S9, รูป 03) ; ไม่มีรายการสร้างผู้ขาย/สินค้า |
| แจ้งเตือน | ❌ | server สร้าง 16 แถว แต่ไม่มีกระดิ่ง/รายการในหน้าจอ (S5) |
| ภาษา | ⚠️ | ภาษาไทยทั่วไปถูกต้องทุกหน้า (fixture mojibake หายแล้ว) ; ยังมีรหัสสถานะดิบ 3 จุด (S3, รูป 05, 16) ; login บอก "อายุ 24 ชั่วโมง" แต่ token 8 ชม. (รูป 01) |

## บั๊ก (เรียงตามความรุนแรง)

| # | ระดับ | อาการ | หลักฐาน / สาเหตุ |
|---|---|---|---|
| S1 | สูง | ปรับปรุงยอดสต็อก (+/-) และ รับเข้าคลัง Manual ในโหมด CF ไม่บันทึกและไม่แจ้ง error | ไม่มี request ใด ๆ หลังกดยืนยัน ; D1 E2E-QC1 ยัง 7 ; `StockAdjustmentModal.jsx:93-94` และ `ManualStockInModal.jsx:84-85` เขียน `storageService.saveProducts/saveStockLogs` (localStorage) แล้ว bootstrap ทับ ; server มีแค่ /api/stock/issue และ /api/inventory/receive (ผูก PO) |
| S2 | สูง | แอดมินกดจัดสรรงบไม่ได้ (production มีแต่ admin คนเดียวตอนนี้) | bootstrap `[[route]].js:1489` ตั้ง `canOnlinePurchase = true` ให้ isAdmin → `BudgetView.jsx:126` return false ก่อนเช็ค ADMIN |
| S3 | กลาง | รับของรอบ 2 ครบ 4/4 แล้ว PO ยัง `PARTIALLY_RECEIVED_IN_CLAIM` ; ป้ายสถานะดิบ `WAITING_DELIVERY_ROUND_2`, `PARTIALLY_RECEIVED_IN_CLAIM` ในรายการ PO และ `REJECTED_TO_DRAFT` บนหัวฟอร์มแก้ PR | รูป 05, 09, 16 ; ฟอร์มรอบ 2 ยังบังคับเลือก "แนวทางแก้ไขเคลม" (PENDING ค่าเริ่มต้น) |
| S4 | กลาง | PR ออนไลน์ค้างสถานะ "รอสั่ง Online" (IN_PROGRESS_ONLINE) หลัง PO รับครบ (COMPLETED) | parity.md บรรทัด 160 บอกต้อง cascade เป็น completed ; เส้นทาง /receive ไม่ cascade PR |
| S5 | กลาง | ไม่มี UI แจ้งเตือน: Sidebar คำนวณ unreadBadgeCount แต่ไม่ render กระดิ่ง ; NotificationBell/Drawer ไม่ถูก mount ที่ใด | `Sidebar.jsx:370-393` มีแค่ปุ่มรีเฟรช ; D1 notifications 16 แถว |
| S6 | กลาง | รูปสินค้าต่อรายการ (PR ออนไลน์) และ "เอกสาร/รูปภาพประกอบรวม" เก็บเป็น data:image base64 ใน itemsJson/PR ไม่ขึ้น R2 (ใบเสนอราคา/หลักฐาน GRN/NG ขึ้น R2 ถูก) | itemsJson ยาว 6.9 KB ต่อรูป 64px ; ลิงก์เอกสารรวมเป็น `data:image/jpeg;base64` ; ขัด requirements-file-storage.md |
| S7 | กลาง | หลังส่ง PR สำเร็จ ฟอร์มไม่ล้าง: ขึ้นเลขใหม่ (PD003/2026) พร้อมข้อมูล/ไฟล์เดิม เสี่ยงส่งซ้ำ ; ตอน resubmit ก็เปลี่ยนจากโหมดแก้เป็น "สร้างใหม่" พร้อมข้อมูลเดิม | สังเกตได้ทั้ง 3 ครั้งที่ส่ง |
| S8 | ต่ำ-กลาง | รับของผ่าน /receive ไม่เขียน audit GOODS_RECEIVED (Audit Log หมวดคลัง = 0) ; stock_logs ไม่มีแถว IN_NG ของชำรุด และ grnNumber ว่างทุกแถว | audit_logs มีแค่ UPDATE_PO + FILE_UPLOAD ; parity a.3 ระบุ IN/IN_NG + grNumber |
| S9 | ต่ำ | Audit Log มีปุ่ม "ล้างประวัติธุรกรรมจำลอง (Reset Mock Transactions)" ในโหมด CF (ล้าง localStorage แล้ว reload — ไม่ทำลายข้อมูล แต่ทำให้สับสน) | `AuditLogView.jsx:286-293` ; รูป 03 |
| S10 | ต่ำ | สร้างสินค้า/ผู้ขาย ยิง save 2 ครั้ง: products POST สำเร็จแล้วตามด้วย uncaught "รหัสสินค้านี้มีอยู่ในระบบแล้ว (1)" ; vendors POST + PUT ; bootstrap ซ้ำ 3 ครั้งต่อการกระทำ | console error ; network |
| L1 | ต่ำ | หน้า login: "เซสชันปลอดภัย อายุการใช้งาน 24 ชั่วโมง" แต่ token 8 ชม. | รูป 01 |
| L2 | ต่ำ | "รันรหัสสินค้าอัตโนมัติตามแผนก" ให้รหัส "1" ไม่ใช่รูปแบบแผนก | รูป 06, 17 |
| L3 | ต่ำ | กล่องงบในฟอร์ม PR นับ PR ที่ถูกส่งกลับแก้ไข (REJECTED_TO_DRAFT) เป็นยอดผูกพัน (ใช้ไปแล้ว 416 = 95 + 321) | ledger ไม่มี commitment ของ PR นั้น |
| L4 | ต่ำ | Online Hub ช่อง "฿ ___" ต่อบรรทัดคือ "ยอดรวมบรรทัด" ไม่ใช่ราคาต่อหน่วย (กรอก 95 ได้ 2 × 47.50) ไม่มี label | รูป 07 |
| L5 | ต่ำ | BudgetView ยังมี hard-code username 'kallayani' / 'somchai' ในสิทธิ์จัดสรรงบ (`BudgetView.jsx:148-150`) | ควรลบ |
| L6 | ต่ำ | หัวหน้าคลัง "3 SKUs" นับทุกแผนก ขณะ QC เห็น 1 ; dropdown จุดเก็บโชว์จุดของแผนกอื่น ; แท็บแผนก Master Data โชว์ "งบประมาณ/เดือน ฿0" ทั้งที่ PD มี 100,000 | — |

## ข้อสังเกต (ไม่ใช่บั๊ก)
- ผู้ขอซื้อระดับ 1 เปิด PR ของแผนกตัวเองได้ครบ ; ผู้ช่วย/ผู้จัดการเห็นปุ่ม "แก้ไข" PR ที่ถูกส่งกลับ (DRAFT ทุกคนแก้ได้ ตาม parity)
- GRN ที่มี NG บังคับแนบรูปและระบุอาการ (ดีแล้ว) ; เคลมแบบเปลี่ยนสินค้าบังคับใส่วันคาดรับ
- ERR_INVALID_URL ใน console หลายครั้ง = พรีวิว PDF/ไฟล์ที่ไม่ใช่รูป (ไม่กระทบการใช้งาน)

## ลำดับแก้ที่แนะนำ
1. S1 + S2 (บล็อกการใช้งานจริง: คลังแก้ยอดไม่ได้, แอดมินตั้งงบไม่ได้)
2. S3 + S4 + S5 (สถานะเอกสารและการแจ้งเตือน)
3. S6 + S7 + S8
4. S9, S10, L1-L6
ทุกข้อควรมีเทสต์ vitest/e2e จับ (โดยเฉพาะ S1: adjust/manual-in ต้องยิง API และ D1 เปลี่ยน ; S2: admin เห็นปุ่มจัดสรร)
