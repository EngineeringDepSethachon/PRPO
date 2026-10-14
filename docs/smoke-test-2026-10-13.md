# รายงานทดสอบใช้งานจริงแบบสวมบทบาท (Smoke test) — 2026-10-13

ผู้ทดสอบ: Claude (ตามคำขอของผู้ใช้) ; สภาพแวดล้อม: build `npm run build:cf` + `wrangler pages dev` บนเครื่อง (127.0.0.1:8788) ต่อ D1 local ที่ seed ด้วย `e2e/cf/global-setup.mjs` + เพิ่ม vendor/usage unit/admin ทดสอบ ; บัญชี fixture ของ e2e (e2e.req / e2e.asst / e2e.plant / e2e.online / e2e.admin)
ไม่แตะ Preview/Production ; ไม่ทดสอบแนบไฟล์ (รอ R2 adapter)

## ผลตามบทบาท

| บทบาท | สิ่งที่ทำ | ผล |
|---|---|---|
| ผู้ขอซื้อ PD (e2e.req) | สร้าง PR PD001/2026 สินค้า E2E-P1 ×5 ส่งเข้าระบบ | ✅ POST /api/prs 200, D1 status SUBMITTED, ยอด 535 (VAT 7%) |
| ผู้ช่วยผู้จัดการ (e2e.asst) | ตรวจทาน PR → ส่งต่อ Plant Mgr | ✅ PUT /api/prs 200, status REVIEWED |
| ผู้จัดการโรงงาน (e2e.plant) | อนุมัติ PR → ออก PO | ✅ status PO_ISSUED, PO-PD-2026-001 ISSUED, ledger PR_COMMITMENT/PR_RELEASE/ACTUAL_SPEND ถูกต้อง, หน้างบแสดงผูกพัน 535 |
| ผู้ขอซื้อ PD | ตรวจรับของ (GRN) ครบ 5 | ⚠️ สำเร็จบนหน้าจอ แต่ข้อมูลหลังบ้านผิด (บั๊ก G, F) |
| ผู้ขอซื้อ PD | เบิกจ่ายด่วน 3 ชิ้นไป Line 1 | ✅ POST /api/stock/issue 200, currentStock 10→7, stock log OUT ถูกต้อง |
| จัดซื้อออนไลน์ (e2e.online) | เปิด Dashboard, Online Hub, งบประมาณ | ✅ หน้าโหลดได้ (ไม่มีงานออนไลน์ค้าง) ; ⚠️ เห็นเมนูงบประมาณทั้งที่ role กำหนด canViewBudgetMenu=false (บั๊ก H) |
| แอดมิน (e2e.admin) | Master Data, ผู้ใช้, สร้างผู้ใช้ใหม่ smoke.user | ✅ PUT /api/users 200, D1 เก็บ hash เท่านั้น (password ว่าง) mustChangePassword=1, roleId บังคับ ; หน้า Master Data แสดงราคา/สต็อกถูกต้องหลังแก้ D-2 |

## บั๊กที่พบ (เรียงตามความรุนแรง)

### G — วิกฤต: ตรวจรับของ (GRN) บันทึก stock log ซ้ำ 2 แถว และไม่อัปเดตสต็อกสินค้า
- หลัง GRN 5 ชิ้น: `stock_logs` มี IN 2 แถวจาก GRN เดียวกัน (balance 15 และ 21) แต่ `products.currentStock` ยัง 10 และ `avgCost` ยัง 0 (รับที่ราคา 100 แล้ว MAC ไม่เปลี่ยน)
- network ตอน GRN: `POST /api/stock-logs` 1 ครั้ง + `PUT /api/pos/:id` 1 ครั้ง ไม่มี `/api/products/batch` → แถวที่ 2 น่าจะมาจาก handler รับของฝั่ง server (route ~บรรทัด 1981-1987) ที่ insert log เองอีกแถว ส่วน currentStock ไม่ถูกบวก
- balance 21 = 5 + 16 มาจาก fallback ที่ฝังไว้ `it.previousBalance || 16` ใน `src/services/storageService.js:2023-2024` (เลข 16 เป็น hard-code จากข้อมูลตัวอย่าง)
- ผลกระทบ: สต็อกจริงผิด, ประวัติซ้ำ, ต้นทุนเฉลี่ยไม่ขยับ → ต้องแก้ก่อนขึ้นจริง (parity.md ข้อ 18: ให้ server ปรับ currentStock + MAC ในธุรกรรมเดียว และ client ไม่ส่ง log ซ้ำ ; ตัด fallback 16)

### F — สูง: หลัง GRN ยอด PO เปลี่ยนจาก 535 เป็น 500 (VAT หาย) และสถานะเป็น "COMPLETED" ที่ไม่มีใน label map
- `pos.grandTotal` 535 → 500, `totalAmount`/`vatAmount` = 0 หลัง PUT ตอนรับของ ; รายการ PO โชว์ ฿500.00 และสถานะดิบ `COMPLETED` (constants PO_STATUS ไม่มีค่านี้ มีแต่ RECEIVED/CLOSED/COMPLETED_WITH_REFUND)
- ตรวจ: client ส่ง PO object ตอนรับของแบบไม่ครบฟิลด์ / server คำนวณ grandTotal ใหม่จาก items โดยไม่รวม VAT ; เทียบ GAS ว่าสถานะหลังรับครบควรเป็นอะไร

### A — สูง (UX/ข้อมูลหลอก): หลังล็อกอินแอปไม่เรียก /api/bootstrap จนกว่าจะรีเฟรชหน้า
- ครั้งแรกที่เปิดเว็บ client เซ็ตแคตาล็อกตัวอย่างลง localStorage (`prpo_data_version = prpo_clean_v16_empty_state`: สินค้า 20 ตัว PD-OIL-068…, แผนก PD/QC/WH/PUR/ENG, งบ 250,000/650,000) แล้วหลัง login ไม่ดึงข้อมูลจริง ผู้ใช้จึงเห็นสินค้า/แผนก/งบปลอม และสร้าง PR กับสินค้าปลอมได้ จนกว่าจะกดรีเฟรชหรือ F5
- bootstrap ก่อน login ได้ 401 แล้ว `apiService` "serving cached data" ; หลัง login สำเร็จต้องเรียก bootstrap ทันทีและล้างแคชตัวอย่างในโหมด cloudflare

### B — กลาง: โหมด cloudflare ยังยิง `POST /api/storage` (endpoint ของ mock backend) ตลอดเวลา
- 1 session ทดสอบ ~70 ครั้ง (401 ก่อน login, 404 หลัง login) ทุกครั้งที่ state เปลี่ยน ; เสีย request quota ของ Pages Functions (ฟรี 100k/วัน) และ console เต็มไปด้วย error
- ต้อง gate การ sync state blob ด้วย `isCloudflareMode()` (storageService)

### C — กลาง: กล่องงบในฟอร์มสร้าง PR แสดง "ใช้ไปแล้ว ฿79,000 / คงเหลือ ฿20,893" ทั้งที่ D1 ใช้ไป 1,000 และหน้างบประมาณแสดง 0 + ผูกพัน 535
- ตัวเลข 79%/79,000 คงที่ทุกบทบาท (Dashboard ก็ 79%) → น่าจะเป็นค่าตัวอย่าง/สูตรคงที่ ไม่ได้อ่านจาก `budgets`/ledger ที่ server ส่ง ; ให้ใช้แหล่งเดียวกับ BudgetView

### D — กลาง: `prs.timelineJson` และ `approvalWorkflowJson` ว่างตลอด flow และ audit_logs ไม่มีรายการตรวจทาน/อนุมัติ PR
- หลัง SUBMITTED→REVIEWED→PO_ISSUED: timeline = [] ; audit_logs มีแค่ PR_UPSERT (ตอนสร้าง) + BUDGET_TX + STOCK_LOG ; ไม่มีร่องรอยว่าใครตรวจ/อนุมัติเมื่อไร (PO detail แสดง timeline ได้ เพราะเก็บที่ PO) ; GAS เดิมเก็บ timeline ใน PR → parity + หลักฐานตรวจสอบ

### E — ต่ำ: รายการ PO แสดง "PR: -" ทั้งที่ `pos.prNumber` = PD001/2026 (UI อ่านชื่อฟิลด์อื่น เช่น prNo)
### H — ต่ำ: ONLINE_PURCHASER เห็นเมนู "งบประมาณ" และเปิดหน้าได้ ทั้งที่ role ตั้ง canViewBudgetMenu=false (ตรวจ server scope ว่ากรองข้อมูลแล้วหรือไม่)
### I — ต่ำ: label บทบาทในตารางผู้ใช้ไม่สม่ำเสมอ (Admin/Reviewer/Approver แต่ REQUESTER_PD/REQUESTER_QC แสดงดิบ)
### J — ต่ำ (fixture): ข้อความไทยใน `e2e/cf/seed.mjs` เป็น mojibake (à¸ˆà¸²à¸£à¸°à¸šà¸µ) ทำให้ชื่อสินค้า/แผนกในเทสต์เพี้ยน — ไฟล์ถูกบันทึกผิด encoding ควรแก้เป็น UTF-8 ; แผนก QC ไม่มีใน seed แต่ Dashboard มีแท็บ QC ตายตัว

## สิ่งที่ผ่านดี
- Auth: login/logout, token Bearer, 401 เมื่อไม่มี token ; สร้างผู้ใช้เก็บ hash อย่างเดียว ; บังคับ roleId
- Flow PR → ตรวจทาน → อนุมัติ → ออก PO: สถานะและ ledger งบถูกต้อง, เลขเอกสาร PD001/2026 / PO-PD-2026-001
- เบิกจ่ายด่วน: server อัปเดตสต็อกและ log ถูกต้อง
- D-2 (ราคา/สต็อก/ROP ใน Master Data) แก้แล้วจริง

## บั๊กไหนมีมาแต่เดิม / เกิดจากการย้าย (ตรวจเทียบ gas/Code.gs, archive/cloudflare-src, docs/parity.md)

| บั๊ก | ที่มา | หลักฐาน |
|---|---|---|
| G stock log ซ้ำ + สต็อกไม่ขยับ | **ย้ายทำให้เกิด** (ส่วน fallback `\|\| 16` มีในโค้ดเดิม แต่ไม่เคยออกฤทธิ์) | GAS เดิม `apiReceivePO` (Code.gs:2699-2774) คำนวณรับของ/GRN/สต็อกฝั่ง server เองตัวเดียว ; CF ให้ client POST /api/stock-logs **และ** PUT /api/pos ที่ server insert log อีกแถว (route ~1981-1987) โดย currentStock ไม่ถูกบวก ; `\|\| 16` อยู่ใน archive/cloudflare-src storageService.js:2026 ด้วย = โค้ดเดิม |
| F สถานะ `COMPLETED` | **เดิม** | parity.md บรรทัด 188: GAS เขียน `COMPLETED` หลังรับครบเอง และ constants ไม่มี label นี้มาแต่เดิม |
| F ยอด PO 535→500 | **ต้องตรวจเพิ่ม (น่าจะย้าย)** | CF PUT /api/pos ใช้ `COALESCE(?, grandTotal)` จากค่าที่ client ส่ง (route:2469,2497) ; GAS เดิมอ่าน `grandTotal \|\| totalAmount` ของเดิมไว้ (Code.gs:2851) ; ให้จับ body ที่ client ส่งตอนรับของว่า grandTotal=500 มาจากไหน |
| A โชว์ข้อมูลตัวอย่างหลัง login | **ผสม** | ตัว seed แคตาล็อกตัวอย่าง (`prpo_clean_v16_empty_state`, dataResetHelper) มีในโค้ดเดิมสำหรับโหมด mock ; แต่โหมด GAS โหลดข้อมูลจริงตั้งแต่เปิดแอป ส่วนโหมด CF ล็อกอินก่อนแล้วไม่เรียก bootstrap ซ้ำ = จุดใหม่จากการย้าย |
| B ยิง /api/storage | **เดิม แต่ย้ายไม่ได้ปิด** | `API_URL='/api/storage'` เป็นของ mock backend เดิม (storageService.js:10) ; โหมด CF ไม่ได้ gate ด้วย isCloudflareMode |
| C กล่องงบในฟอร์ม PR | **เดิม** (ตรรกะคำนวณฝั่ง client `apiService.calculateBudgetSummary` PRCreateView.jsx:524) แต่ในโหมด CF ไม่ได้ใช้ตัวเลขจาก server จึงเพี้ยน | ต้องเปลี่ยนให้ใช้ budgets/ledger จาก bootstrap เหมือน BudgetView |
| D timeline/audit ของ PR | **ย้ายยังไม่ครบ** | GAS เดิมไม่เก็บ timeline ใน PR แต่ประกอบจากชีต AuditLogs ตอนอ่าน (Code.gs:1316, 1382, 4454) ; CF ไม่เขียน audit ตอนตรวจ/อนุมัติ และ bootstrap ไม่ประกอบ timeline ให้ |
| E "PR: -" ในรายการ PO | **ย้าย** | bootstrap map `poNo: r.poNumber` แต่ไม่ map `prNo` (route:1621) UI เดิมอ่าน prNo |
| H เมนูงบของ online | **น่าจะเดิม** (เมนู client) | ตรวจ Sidebar config เทียบ archive ; ฝั่ง server CF กรองข้อมูลแล้ว (P4) |
| I label บทบาท | **เดิม** | ตารางผู้ใช้ map เฉพาะ role หลัก REQUESTER_PD/QC แสดงดิบมาแต่เดิม |
| J fixture mojibake | **ใหม่** (ไฟล์เทสต์ที่ทีมสร้าง) | e2e/cf/seed.mjs |

## ข้อเสนอลำดับแก้
1. G (GRN ซ้ำ/สต็อกไม่ขยับ) + F (ยอด PO/VAT/สถานะ) — บล็อกการขึ้นจริง
2. A (bootstrap หลัง login + ล้างข้อมูลตัวอย่าง) + B (เลิกยิง /api/storage)
3. C, D — ความถูกต้องของตัวเลขและหลักฐานตรวจสอบ
4. E, H, I, J
ทุกข้อ: เพิ่มเทสต์ vitest/e2e ที่จับเคสนี้ (โดยเฉพาะ GRN → currentStock/avgCost/stock_logs 1 แถว, ยอด PO คงเดิม) และ kla ตรวจ H
