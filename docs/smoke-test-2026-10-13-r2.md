# Smoke test รอบ 2 (สวมบทบาท) — 2026-10-13, หลังแก้ M6+M7

สภาพแวดล้อม: `npm run build:cf` + `wrangler pages dev` (127.0.0.1:8791) + D1 local `test-results/smoke-r2-d1` (migrations 0001-0014) ; ไม่แตะ remote/Preview/Production
บัญชี: e2e.req (Requester PD) / e2e.asst (Asst Mgr) / e2e.plant (Plant Mgr) / e2e.online (Online Purchaser) / e2e.admin (เพิ่มเอง, roleId ADMIN) / e2e.qc (แผนกอื่น)
ขอบเขต: ขั้นธุรกิจทดสอบระดับ API (HTTP จริงไป Functions) ; หน้าจอตรวจด้วย Playwright (msedge) ; ไม่ทดสอบแนบไฟล์ใหม่ (ครอบโดย e2e cf อยู่แล้ว)

## ผลรวม
- สคริปต์ role-play (รอบ 2 บน DB ที่มีข้อมูลรอบ 1 อยู่): 78 ผ่าน / 0 ไม่ผ่าน (รอบ 1 บนข้อมูลสดเป็นการซ้อมสคริปต์ ติดแค่ความคาดหวังของสคริปต์เอง ไม่ใช่บั๊กระบบ — ดูหมายเหตุท้ายตาราง)
- `npm run test:e2e:cf`: 12/12 ผ่าน
- UI Playwright 4 บทบาท (L1/ONLINE/ADMIN/QC): ผ่านโหลดหน้า ไม่มี error
- **บั๊กใหม่ระดับวิกฤต/สูง: ไม่พบ** ; บั๊กรอบแรก A-J ไม่กลับมา (ยกเว้นข้อสังเกต H ซึ่งเป็นพฤติกรรมเดิมตั้งใจ)

## ตารางผลแต่ละขั้น x บทบาท
(PR A = ออนไลน์ PD001/PD005, PO A = PO-PD-2026-00x ; PR B = ยกเลิก ; PR C/D = อนุมัติโดย admin)

| ขั้น | บทบาท | ผล | หลักฐาน |
|---|---|---|---|
| login 6 บัญชี | ทุกคน | ผ่าน | 200 + token |
| GET /api/audit-logs | L1,L2,L3,ON,QC | ผ่าน | 403 ทุกคน |
| GET /api/audit-logs | Admin | ผ่าน | 200 |
| สร้าง PR แบบร่าง | L1 | ผ่าน | audit `PR_DRAFTED` actor E2E Requester |
| แก้ร่าง (DRAFT->DRAFT) | L1 | ผ่าน | 200 ไม่มี audit ซ้ำ (ตามดีไซน์ ไม่ใช่การส่งใหม่) |
| ส่งร่าง (SUBMITTED) | L1 | ผ่าน | audit `RESUBMIT` |
| Requester ตรวจเอง | L1 | ผ่าน | 403 |
| ส่งกลับ (REJECTED_TO_DRAFT + เหตุผล) | L2 | ผ่าน | audit `SEND_BACK` actor Asst, timeline comment = เหตุผล ; แจ้งเตือน PR_REJECTED->Requester |
| ส่งใหม่หลังถูกส่งกลับ | L1 | ผ่าน | `RESUBMIT` ครั้งที่ 2 |
| ตรวจ (REVIEWED) | L2 | ผ่าน | `REVIEW_FORWARD` |
| Asst อนุมัติ | L2 | ผ่าน (ถูกปฏิเสธ) | 403 |
| อนุมัติ (IN_PROGRESS_ONLINE) | L3 | ผ่าน | `APPROVE` actor Plant ; แจ้งเตือน Requester + Purchaser ; PR_COMMITMENT 1 แถว |
| ออก PO | L3 | ผ่าน | `PO_CREATED`, prNo ปรากฏใน bootstrap/หน้า PO ("PR: PD005/2026") |
| สั่งซื้อ ORDERED | Online | ผ่าน | `UPDATE_PO` actor Online ; ONLINE_ORDERED->Requester |
| รับบางส่วน 2/5 | L1 | ผ่าน | สต็อก +2, IN log 1 แถว/GRN, PO grandTotal 535 คงเดิม, สถานะ PARTIAL, `GOODS_RECEIVED_PARTIAL`, PO_CLAIM->Purchaser+Requester |
| รับครบ 3/5 | L1 | ผ่าน | สต็อก +5 รวม, IN log รวม +2, avgCost 100, สถานะ CLOSED, 535, `GOODS_RECEIVED_FULL`, GOODS_RECEIVED->Purchaser |
| settle (online) | Online | ผ่าน | SETTLED, ledger REFUND_SETTLEMENT 20 แถวเดียว, `PO_SETTLED` |
| ยกเลิก PR B พร้อมเหตุผล | L1 สร้าง/L2 ตรวจ/L3 ยกเลิก | ผ่าน | CREATE, REVIEW_FORWARD, CANCEL (comment = เหตุผล) ; PR_CANCELLED(ALL) ; ไม่มี commitment ค้าง |
| (1) audit action/actor | Admin | ผ่าน | ลำดับ+ชื่อผู้กระทำตรงทุก PR/PO ; ไม่มี id ซ้ำ |
| (2) pr.timeline | L1 | ผ่าน | ตรง audit ทุกลำดับ/คน, ไม่ซ้ำ, ไม่รับ entry `AL-` ปลอมจาก client |
| (3) แจ้งเตือนตาม role/แผนก | ทุกคน | ผ่าน | Approver: L2,L3,AD ; Requester: L1,AD ; Purchaser: ON,AD ; ALL: L1,L2,L3,ON,AD ; **QC เห็น 0 รายการ** ; 1 แถวต่อเหตุการณ์ (ไม่ซ้ำ) |
| mark-read แยกรายคน | L1/L2/QC | ผ่าน | L1 อ่าน -> L2 ยัง unread ; read-all ของ L2 ไม่กระทบ L3 ; QC mark แจ้งเตือน PD = 404 |
| (4) ลายเซ็น | Admin | ผ่าน | อนุมัติก่อนล้าง: approverSignature มี ; ล้าง (signature '') แล้วอนุมัติด้วย token เดิม: ไม่มีลายเซ็นเก่าทั้ง approverSignature/approvedBy ; ลายเซ็น reviewer ของ Asst ยังอยู่ |
| ความปลอดภัยเสริม | L2/QC/L3 | ผ่าน | review ซ้ำพร้อมกัน 200/200 แต่ audit แถวเดียว ; QC ยุ่งกับ PR ของ PD = 403 ; ยกเลิกแล้วส่งใหม่ = 403 |

หมายเหตุรอบ 1 ของสคริปต์: ความคาดหวังเรื่องรูปแบบ audit (docNo=เลข PR ไม่ใช่ id) ในสคริปต์ผิด แก้แล้วจึงผ่านทั้งหมดในรอบ 2 ; รอบ 2 ปรับ fixture ให้ ONLINE/PLANT/ASST มี flag ตามที่หน้า admin สร้าง (ดูข้อสังเกต 2)

## ตรวจซ้ำบั๊กรอบแรก A-J
| บั๊ก | ผล | หลักฐาน |
|---|---|---|
| G stock log ซ้ำ/สต็อกไม่ขยับ | ไม่กลับมา | IN log 1 แถวต่อ GRN, สต็อก/avgCost ถูก |
| F ยอด PO 535->500 / สถานะ | ไม่กลับมา | PO คง ฿535 ทุกขั้น ; หน้า PO แสดง "ปิดยอดแล้ว / เสร็จสิ้น" |
| A ข้อมูลตัวอย่างหลัง login | ไม่กลับมา | session login เรียกแค่ `POST /api/auth` + `GET /api/bootstrap` ; e2e test 12 ผ่าน |
| B ยิง /api/storage | ไม่กลับมา | 0 ครั้งใน session ของ L1, ONLINE, ADMIN |
| C กล่องงบฟอร์ม PR | ไม่กลับมา | กล่องงบ/Dashboard ฿1,470 = BudgetView (ใช้จริง 1,070 + ผูกพัน 400) ตรงกัน ไม่ใช่ 79,000 |
| D timeline/audit PR | แก้แล้ว | ดูตารางด้านบน |
| E "PR: -" | แก้แล้ว | "PR: PD005/2026" |
| H เมนูงบของ online | ยังเห็นเมนู (เดิม ตั้งใจ) | Sidebar.jsx:176-186 มีคอมเมนต์ "Online Purchaser (Overview)" และเหมือน archive ทุกบรรทัด |
| I label บทบาท | แก้แล้ว | ตารางผู้ใช้แสดง Requester/Reviewer/Approver/Purchaser/Admin |
| J mojibake | ไม่พบ | ชื่อสินค้า/แผนกไทยแสดงถูก |

## (6) PUT /api/users ไม่ส่ง allowedDepartments
- ผลทดสอบ: ผู้ใช้ที่มี `["PD","QC"]` แล้ว PUT โดยไม่ส่งฟิลด์ -> เหลือ `["PD"]` (รีเซ็ตเป็นแผนกหลัก) — `functions/api/[[route]].js:3625-3627`
- GAS เดิม `apiUpsertUser` (gas/Code.gs:468-479) เรียก `upsertRecordById` (gas/SheetService.gs:641-678) ที่เขียนทั้งแถวทับด้วย payload ; ฟิลด์ที่ไม่ส่งถูกเขียนเป็นค่าว่าง (serializeRecordToRow :119-127) -> **เป็นพฤติกรรมเดิม (รีเซ็ต) ไม่ใช่บั๊กจากการย้าย** ; CF เบากว่า GAS (ได้ `[primaryDept]` แทนค่าว่าง และเก็บลายเซ็นไว้ถ้าไม่ส่ง)
- ผลกระทบจริงต่ำ: client เสมอส่ง allowedDepartments (UserCRUDModal.jsx:155-156, apiService.js:2104-2112) ; เกิดเฉพาะผู้เรียก API ตรง ๆ ผลข้างเคียงในแนวเดียวกัน: ไม่ส่ง `title` จะกลายเป็น "Officer"

## บั๊ก/ข้อสังเกตใหม่ (เรียงตามความรุนแรง) — ไม่มีวิกฤต/สูง
1. **ต่ำ (เดิม ตรงกับ GAS)** — ส่งร่าง/ส่งใหม่หลังถูกส่งกลับ ไม่มีแจ้งเตือน PR_SUBMITTED ไปหา Approver ฝั่ง server ; เฉพาะการสร้างเป็น SUBMITTED ตรง ๆ (CREATE) ที่แจ้ง — `functions/_lib/notify.js:28-34` (ตามคอมเมนต์ "GAS sends nothing for REVIEW, DRAFT or a re-submit" ; GAS ส่งเฉพาะ apiCreatePR gas/Code.gs:1522-1531) . ทำซ้ำ: L1 POST status DRAFT -> PUT SUBMITTED action RESUBMIT -> GET /api/notifications ของ L2 ไม่มี PR_SUBMITTED ของ PR นั้น. ถ้าต้องการให้แจ้งเตือนในเคสนี้ = เปลี่ยน business rule ต้อง ask ผู้ใช้
2. **ต่ำ (fixture ไม่ใช่โค้ด)** — ผู้ใช้ e2e ของ `e2e/cf/seed.mjs:47-50` ไม่ตั้ง flag `canViewAllDepts` ทำให้ Online (PUR) และ Plant (MGT) ไม่ได้รับแจ้งเตือนของแผนก PD ตามกฎ GAS (`isUserTargetOfNotification` extra.js:50) จนกว่าจะบันทึกผ่าน PUT /api/users (ซึ่ง default =1 สำหรับ level>=2/online) ; ผู้ใช้ที่สร้างผ่านหน้า admin ได้ flag ถูกอยู่แล้ว -> แนะนำใส่ flag ใน seed เพื่อให้ e2e ครอบแจ้งเตือนได้
3. **ต่ำ (เกิดจากการย้าย, เสียงรบกวน)** — audit มีแถว `PR_UPSERT` (route:2115) ปนกับเหตุการณ์จริง (CREATE/APPROVE...) ในหน้า Audit Logs ; GAS ไม่มี action นี้ และแถวใช้ id PR (PR-R2-D2) แทนเลขเอกสาร. ไม่กระทบความถูกต้อง
4. **ต่ำ (ข้อสังเกตเพื่อตรวจด้วย UI จริง)** — `budgets.PD.spent` จาก server (960) ต่างจาก BudgetView (ใช้จริง 1,070, ผูกพัน 400) ในข้อมูลที่สร้างด้วย API ตรง ๆ เพราะ sim ของฉันไม่ได้ยิง ledger ที่ client เป็นคนยิง (PR_RELEASE/ACTUAL_SPEND ตอนออก PO) และ PR สถานะ "รอสั่ง Online" ค้างเพราะ cascade ปิด PR/ช่องทาง PO (`purchaseChannel`) ก็เป็นงานฝั่ง client ; ยืนยันไม่ได้ว่าเป็นบั๊ก -> แนะนำให้รอบ UI จริงเทียบ spent ของ server กับ BudgetView หลัง flow เต็ม
5. **ต่ำ** — บทบาท actor ใน audit ของ admin เป็น "Officer" หลัง PUT user ที่ไม่ส่ง title (ดู (6)) ; ไม่กระทบสิทธิ์

ไม่พบ: ข้อมูลรั่วข้ามแผนก (QC), audit/notification ซ้ำ, ลายเซ็นเก่าค้าง, race จากการกดซ้ำ

## คำสั่งที่ใช้รัน
```
npm run build:cf
node test-results/smoke-r2/setup.mjs                 # migrations + seed (reuse buildSeedSql จาก e2e/cf/seed.mjs) + admin + ลายเซ็น -> test-results/smoke-r2-d1 (--local เท่านั้น)
npx wrangler pages dev dist --d1 DB=c64022bb-88eb-485f-94f7-dd9e9617e44c --r2 FILES --persist-to test-results/smoke-r2-d1 --port 8791 --ip 127.0.0.1 --binding AUTH_TOKEN_SECRET=<ค่า dev ของ playwright.cf.config.js> --binding ENVIRONMENT=dev --binding FILE_STORAGE=r2 --compatibility-flag nodejs_compat --show-interactive-dev-session=false
node test-results/smoke-r2/run.mjs [TAG] [flags] [out]   # รอบ 2: run.mjs 2 flags test-results/smoke-r2/results2.json
node test-results/smoke-r2/extra.mjs                  # concurrency / cross-dept / cancel
npx playwright test -c test-results/smoke-r2/ui.config.js   # UI 4 บทบาท
npm run test:e2e:cf                                   # 12 passed
```
สคริปต์/ผลดิบอยู่ใน `test-results/smoke-r2/` (run.mjs, results.json, results2.json, ui-*.json) ; server ที่เปิดไว้ปิดแล้ว (ตรวจแล้วพอร์ต 8791 ปิด) ; ไม่ได้แก้ src/ functions/ ; ไม่ได้ลบไฟล์ใด

---

## ตรวจยอดงบผ่านหน้าจอ (ติดตามข้อสังเกต 4 ข้างบน)

คำถาม: `budgets.PD.spent` ฝั่ง server (960) ต่างจาก BudgetView (ใช้จริง 1,070 / ผูกพัน 400) เพราะ (ก) สคริปต์ API ข้ามขั้นที่ client ทำ หรือ (ข) บั๊กจริง
สรุป: **ส่วนใหญ่ (ก)** — ตัวเลขที่หน้าจอแสดง (BudgetView, กล่องงบหน้าสร้าง PR, Dashboard) ถูกต้องและตรงกันทุกขั้นเมื่อทำ flow ผ่านหน้าจอจริง ; `budgets.totalUsed` ของ D1 เป็นตัวชี้วัดคนละชนิด (ตัวนับการปรับยอด) ไม่ใช่ "ยอดใช้จริง+ผูกพัน" ทั้งในระบบเดิมและ CF ; พบ (ข) จริง 2 เรื่องเล็ก (ดูท้ายหัวข้อ)

### วิธีทำ
Playwright (msedge) บน `wrangler pages dev` พอร์ต 8792 + D1 local `test-results/smoke-r2-ui-d1` (seed เดิม: budget PD 100,000 และ `totalUsed` ตั้งต้น 1,000 ของ fixture). ทุกขั้นกดผ่านหน้าจอจริง: L1 สร้าง PR ออนไลน์ -> L2 ตรวจ -> L3 อนุมัติ+ออก PO -> Online สั่งซื้อจริง (ราคา 90 แทน 100, ยอด 450 แทน PR 500) -> L1 รับของ 2/5 (ขาด 3 ส่งเรื่องเคลม) -> Online เคลมคืนเงิน 270 (PO COMPLETED) -> PR PD002 (300) L3 ยกเลิกพร้อมเหตุผลที่ REVIEWED -> PR PD003 (200) อนุมัติแล้วยกเลิก PO. ทุกขั้นดึงตารางจาก D1 (`dump.mjs`) เทียบกับตัวเลขบนหน้าจอ (L1 Dashboard + กล่องงบ, Plant BudgetView + Dashboard).

### ตารางเทียบทีละขั้น (PD, งบจัดสรร 100,000)
| ขั้น | D1 budgets.totalUsed / remaining | แถวใหม่ใน budget_transactions | BudgetView ใช้จริง / ผูกพัน / คงเหลือ | กล่องงบ PR = Dashboard "ใช้ไปแล้ว" |
|---|---|---|---|---|
| 00 baseline | 1,000 / 99,000 | - | 0 / 0 / 100,000 | 0 |
| S1 PD001 (500) ถูกตรวจ REVIEWED | 1,000 / 99,000 | - | 0 / 500 / 99,500 | 500 |
| S2 L3 อนุมัติ + ออก PO (online, 500) | 1,000 / 99,000 | PR_COMMITMENT -500 | 0 / 500 / 99,500 | 500 |
| S3 Online สั่งซื้อจริง 450 | 950 / 99,050 | PR_RELEASE +500, ACTUAL_SPEND -450, BUDGET_ROLLBACK +50 | 0 / 450 / 99,550 | 450 |
| S4 L1 รับ 2/5 + เปิดเคลม | 950 / 99,050 | - | 0 / 450 / 99,550 | 450 |
| S5 Online เคลมคืนเงิน 270 (PO COMPLETED) | 680 / 99,320 | BUDGET_ROLLBACK +270 | **180 / 0 / 99,820** | 180 |
| S6 PD002 (300) REVIEWED | 680 / 99,320 | - | 180 / 300 / 99,520 | 480 |
| S7 L3 ยกเลิก PD002 | 680 / 99,320 | - (ไม่มี PR_RELEASE เพราะไม่เคยมี commitment) | 180 / 0 / 99,820 | 180 |
| S8 PD003 (200) อนุมัติ | 680 / 99,320 | PR_COMMITMENT -200 | 180 / 200 / 99,620 | 380 |
| S9 ยกเลิก PO-002 | 680 / 99,320 | PO_CANCEL_REFUND +200 | 180 / 0 / 99,820 | 180 |

อ่านผล:
- ตัวเลขหน้าจอ = สูตรจากเอกสาร (`budgetService.calculatePeriodBudgetSummary`, budgetService.js:59-217: PO ปิดแล้ว = ใช้จริงสุทธิหลังหักคืน, PO ยังไม่ปิด/PR ที่ยังไม่มี PO = ผูกพัน) ตรงกันทั้ง BudgetView / กล่องงบ PR (PRCreateView.jsx:532 ผ่าน BudgetContext) / Dashboard ทุกขั้น และถูกตามการคำนวณมือ (เช่น S5: 450 - 270 = 180 ใช้จริง, คงเหลือ 100,000 - 180) ; ผ่านเกณฑ์ C ของรอบแรก
- D1 `totalUsed` ไม่เคยรวมยอดผูกพันหรือยอดสั่งจริง : `writePrCommitment` เขียนเฉพาะ ledger (route:56-64) ; แถว ACTUAL_SPEND/PR_RELEASE ที่ client ส่งเป็นแถวบัญชีอย่างเดียว ; ที่ขยับ `totalUsed` มีแค่ `BUDGET_ROLLBACK` (ลด 50 ตอนประหยัด, ลด 270 ตอนเคลมคืน) -> 1,000 - 50 - 270 = 680. ตัวเลข 960 รอบก่อนมาจากหลักการเดียวกัน (1,000 - 20 - 20)
- ทำไมเป็นของเดิม (ไม่ใช่การย้ายทำพัง): client เดิมเป็นผู้ขยับ `budgets.spent` เองเฉพาะตอนประหยัด/เกิน/คืน (workflowEngine.js:669-735, BudgetContext.jsx:22-100) แล้วส่งไปเก็บ ; GAS `apiSaveBudgets`/`apiAppendBudgetTransaction` (Code.gs:3543, 3578) เก็บตามที่ส่ง ไม่มีสูตรรวมผูกพัน/ใช้จริงในตารางงบ. หน้าจอ CF ไม่ใช้ `budgets.spent`/`remainingBudget` แสดงยอดใดเลย (ตรวจ 3 หน้าที่เกี่ยวข้อง)
- ความต่างที่เห็นรอบก่อน (Server 960 vs BudgetView 1,070/400) = สคริปต์ API ข้ามขั้น client (ไม่ได้ออก PO/สั่งซื้อ/รับของ/ปิด PO ตามจริง จึงไม่เกิด PR_RELEASE, สถานะ PO, ยอดคืน) + ค่าตั้งต้น 1,000 ใน fixture ที่หน้าจอไม่เอามานับ. ไม่มียอดหาย/ซ้ำใน ledger ในเส้นทางหน้าจอ (แต่ละเหตุการณ์ 1 แถว, PR ที่ยกเลิกก่อนอนุมัติไม่เกิดแถวคืนเงินปลอม)

### ข้อสังเกต/บั๊กจริงที่พบจากเส้นทางหน้าจอ (ทั้งหมดต่ำ)
1. **ledger แผนกเขียนไม่สม่ำเสมอ ("ฝ่าย PD" กับ "PD")** — แถวที่ client ส่ง (PR_RELEASE, ACTUAL_SPEND, PO_CANCEL_REFUND) เก็บ `department='ฝ่าย PD'` ตามที่ส่ง (functions/api/[[route]].js:4611-4612) ส่วนแถวที่ server เขียนใช้ `PD` (route:59-60). ผล: `/api/bootstrap` ให้ Requester PD เห็น ledger 4 จาก 7 แถว (แถว "ฝ่าย PD" ถูกกรองตามแผนก) ขณะที่ Asst/Plant/Online/Admin เห็นครบ 7 ; BudgetView ตัดคำนำหน้า "ฝ่าย" เอง (BudgetView.jsx:664) จึงไม่กระทบหน้าจอ ; GAS เก็บตามที่ client ส่ง (parity) แต่ CF มีการกรองตามแผนกที่ GAS ไม่มี -> ควร canonicalize ตอนเขียน (`normalizeDeptCode`)
2. **เวลา PR จาก D1 ไม่มี timezone** — `prs.createdAt` เป็น `YYYY-MM-DD HH:MM:SS` (UTC, ไม่มี Z; client ไม่ส่ง `requestedDate`, ดู workflowEngine.js:255,1032). แถว ledger ที่สร้างจาก PR ใน BudgetView แสดง 15:58 ทั้งที่สร้างตอน 22:58 เวลาไทย (แถวอื่นเป็น ISO และแสดง 23:03 ถูก), และ period ของ PR (budgetService.js:165-166 `createdAt.substring(0,7)`) นับตามเดือน UTC -> PR ที่สร้างเวลา 00:00-06:59 ของวันที่ 1 (เวลาไทย) จะไปอยู่เดือนก่อนในยอดงบ (อนุมานจากโค้ด ยังไม่ได้ทดสอบข้ามเดือนจริง). GAS ใช้ `createdAt` เป็น ISO จาก `apiCreatePR` -> ต้นเหตุเกิดจากการย้าย ; แนะนำให้ bootstrap ส่ง `createdAt` เป็น ISO หรือเติม `requestedDate`
3. **(เดิม ไม่ใช่งบ)** หลังเคลมคืนเงินปิด PO (สถานะ `COMPLETED`) สถานะ PR ยังเป็น "รอสั่ง Online" และหลังยกเลิก PO ของ PD003 ก็ยังเป็น "รอสั่ง Online" : logic ปิด PR ใน workflowEngine.js:3182-3185 เช็กแค่ `CLOSED/CANCELLED` (เหมือน archive บรรทัด 3178) ; ไม่กระทบยอดงบเพราะสูตรไม่นับ PR ที่มี PO ผูกอยู่ ; หน้ารายการ PO ยังแสดงสถานะดิบ `COMPLETED` (ไม่มี label) ตรงกับข้อสังเกต F รอบแรก
4. หน้า Login: กรอก username/password ทันทีหลังโหลด (<1 วินาที) แล้วกดเข้าสู่ระบบ ได้ข้อความ "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ทั้งที่รหัสถูก (เจอตอนสคริปต์เร็วเกินไป ใส่ wait 1.5 วินาทีแล้วผ่าน) ; ยังไม่ได้สืบสาเหตุ (สงสัยการเตรียม session/ipify ตอนโหลด) -> ควรให้ทีมตรวจแยก

### ไม่พบ
- ledger หาย/ซ้ำ/ยอดไม่ตรงในเส้นทางหน้าจอ (ทุกเหตุการณ์ 1 แถว) ; การยกเลิก PR ก่อนอนุมัติไม่สร้างแถวคืนเงิน (server กัน PR_RELEASE ที่ไม่มี commitment)
- ความต่างของสูตรระหว่างหน้าจอทั้ง 3 จุด (BudgetView / กล่องงบ PR / Dashboard)

### คำสั่งที่ใช้เพิ่ม
```
node test-results/smoke-r2/setup.mjs test-results/smoke-r2-ui-d1      # D1 local ใหม่ + seed
npx wrangler pages dev dist ... --persist-to test-results/smoke-r2-ui-d1 --port 8792 ...   # local เท่านั้น
node test-results/smoke-r2/prep.mjs                                    # PUT ผู้ใช้ให้ได้ flag เต็ม (ผ่าน API ของ admin)
npx playwright test -c test-results/smoke-r2/flow-ui.config.js flow-ui.spec.js -g "<ขั้น>"   # ขับหน้าจอทีละขั้น
node test-results/smoke-r2/dump.mjs                                    # dump budgets/budget_transactions/prs/pos จาก D1 local (wrangler d1 execute --local)
```
ผลดิบ: `test-results/smoke-r2/flow-ui-log.json` (หมายเหตุ: ค่า S1/S2 ในไฟล์นี้ถูกเขียนทับโดยการรันซ้ำ ใช้ตารางด้านบนซึ่งบันทึกจากเอาต์พุตตอนรันจริง). ปิด dev server พอร์ต 8792 แล้ว ; ไม่ได้แก้ src/ functions/ ; ไม่ได้ลบไฟล์ใด
