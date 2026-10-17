# Phase 3 — Post-Production Workflow & UX/UI (SRS 2026-10-16) — Fable อนุมัติ cmvc242gq1f336 (2026-10-17) ; ผู้ใช้ตอบ Q1-Q10 แล้ว

สเปก: `C:\Users\Admin\Downloads\system_requirement_specification_phase_3.md` (FR-01 role "พี่สุ", FR-02 หมายเหตุสินค้าใน PR, FR-03 ยกเครื่องการ์ดงานออนไลน์, FR-04 ขยายฟอนต์)
ฐานปัจจุบัน: v1.0.0 production ใช้งานจริงแล้ว → ทุก FR ต้องขึ้น preview ก่อน และออกเวอร์ชันตาม docs/CHANGELOG.md ; ห้ามทำให้ PR/PO เดิมแสดงผลผิด

## ข้อเท็จจริงจากการสำรวจโค้ด (2026-10-17)
- PR flow จริง: `DRAFT → SUBMITTED → REVIEWED (= รออนุมัติ Plant Mgr) → APPROVED → PO_ISSUED / IN_PROGRESS_ONLINE` (constants.js:345) ; ชื่อสถานะใน SRS (PENDING_REVIEW/PENDING_APPROVAL) ไม่มีในระบบ → ใช้ชื่อจริง
- สิทธิ์ตัดสินจาก level เป็นหลัก (resolveUserPermissions client/server), reviewer = level 2 ที่ไม่ใช่ online purchaser, approver = level ≥ 3 ; role ที่เลือกได้ในหน้า Admin: UserMasterView ROLE_OPTIONS + UserCRUDModal (สองสำเนา)
- transition บังคับทั้ง client (workflowEngine.canAction/updatePRStatus, PRDetailsModal ปุ่ม) และ server (rbac.PR_FLOWS/ACTORS/canTransitionPR, route POST/PUT /api/prs + prApprovalPatch + audit + notify.js + writePrCommitment ตอน REVIEWED→APPROVED)
- แก้ qty/ราคาตอนอนุมัติมีอยู่แล้ว (PRDetailsModal canApproverEdit, workflowEngine.editPRItems, server canEditPrContent level ≥ 2 ใน SUBMITTED/REVIEWED/REJECTED_TO_L2) แต่ยังไม่มีช่องแก้ลิงก์ และไม่คำนวณ financials/grandTotal ใหม่ ; งบผูกพันคำนวณสดจาก totalAmount จนกว่าจะอนุมัติ (server เขียน ledger ครั้งเดียวตอนอนุมัติ) → แก้ยอดก่อนอนุมัติไม่ต้องแก้ ledger
- หมายเหตุสินค้า: `products.remark` (migration 0017) ส่งมากับ bootstrap แล้ว แต่ PR item ไม่คัดลอก และไม่มีที่แสดงนอก StockCard/ProductRemarkDrawer
- การ์ดงานออนไลน์: OnlineOrderCard.jsx รูป w-8/w-7, ลิงก์เป็นไอคอน w-3 ; ImageLightboxModal มีอยู่แล้ว (เปิดจาก OnlineOrderCard/PRDetailsModal)
- ฟอนต์: ไม่มี fontSize override ใน tailwind.config ; นับได้ text-xs 1137, text-sm 244, text-[11px] 330, text-[10px] 175, text-[9px] 11 ใน src

## การออกแบบที่เสนอ
### FR-01 role "พี่สุ" (BUFFER)
- roleId ใหม่ `BUFFER` (ป้าย "ผู้ตรวจสอบจัดซื้อ (พี่สุ)"), level 2, department ALL, canViewAllDepts=1, canReview=0, canFinalApprove=0, canOnlinePurchase=0 ; เพิ่มใน constants.ROLES, ROLE_OPTIONS ทั้งสองหน้า, resolvePermissions (client+server) ให้รู้จัก `isBuffer` จาก roleId ไม่ใช่ level, NOTIFICATION_ROLES, scope.buildViewer (เห็นทุกแผนก)
- สถานะใหม่ `PENDING_BUFFER` ("รอพี่สุตรวจสอบ") แทรกก่อน REVIEWED: `SUBMITTED → PENDING_BUFFER (reviewer กดผ่าน) → REVIEWED (พี่สุกดส่งต่อ) → APPROVED` ; REVIEWED ยังหมายถึง "รออนุมัติ" เหมือนเดิม จึงไม่ต้องแตะ approve guard / ledger / PO
- **server เป็นผู้เลือกเท่านั้น** ตอน reviewer กดผ่าน (ไม่เชื่อสถานะจาก client): ถ้ามีผู้ใช้ ACTIVE roleId BUFFER อย่างน้อย 1 คน → PENDING_BUFFER ไม่งั้น → REVIEWED (ข้ามอัตโนมัติ) [Q1] ; ใช้กับ PR ทุกใบ ภายใน+ออนไลน์ [Q2]
- สิทธิ์พี่สุที่ PENDING_BUFFER: แก้ qty / price / onlineUrl(productUrl) + คอมเมนต์ ; ปุ่มเดียว "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ" → REVIEWED พร้อมประทับ `bufferReviewedBy/ById/At`, `bufferComment` (extraJson ไม่ต้อง migration), audit `BUFFER_FORWARD`, แจ้งเตือน Approver ; ไม่มี reject/cancel (canAction/canCancelPR false, server PR_FLOWS actor buffer มีแค่ PENDING_BUFFER→REVIEWED)
- ใครตีกลับ/ยกเลิก PR ที่ค้างที่พี่สุ: Approver (level ≥ 3), Admin **และ Reviewer** [Q6]
- **RBAC level 2 (เงื่อนไข Fable):** isBuffer ตัดสินจาก roleId ; ตัด isBuffer ออกจาก reviewer (canReview) และจัดสรรงบ/ตรวจทานแทน reviewer ไม่ได้ แต่ดูงบ/สร้าง PR/ดูสต๊อกทุกแผนกได้ [Q7] ; พี่สุแก้ PR ได้เฉพาะสถานะ PENDING_BUFFER ; ที่ PENDING_BUFFER แก้ได้เฉพาะพี่สุ+admin (reviewer level 2 แก้ไม่ได้) [Q9] — ทั้ง client (canApproverEdit/editPRItems) และ server (canEditPrContent) ; เทสต์ตาราง cf_rbac ครอบทุก actor × สถานะใหม่
- แก้ยอด: **server recompute** totalAmount + financials.grandTotal (ตามส่วนลด/VAT เดิม) ไม่รับยอดรวมจาก client ; client คำนวณแสดงผลด้วยสูตรเดียวกัน ; productUrl ต้องเป็น http/https เท่านั้น (server ตรวจ) ; itemFingerprint ให้รู้จัก url เพื่อ audit ค่าที่เปลี่ยน (ก่อน/หลัง) ใน timeline
- ไม่เพิ่มพี่สุใน PDF PO (timeline อย่างเดียว) [Q8] ; ปิดบัญชีพี่สุขณะมี PR ค้าง → admin ส่งต่อแทน หรือ reviewer/approver ตีกลับ ไม่เพิ่มปุ่มใหม่ [Q10]
- ไล่ทุกจุดที่ enumerate สถานะ PR ให้รู้จัก PENDING_BUFFER: ป้าย/สี, filter, dashboard/รายงาน, To-Do, scope, export, ผูกพันงบ (นับเหมือน SUBMITTED/REVIEWED)
- **โหมด GAS:** ไม่รองรับ PENDING_BUFFER — production ใช้ Cloudflare ตั้งแต่ go-live 2026-10-16 GAS ไม่ใช่ backend production แล้ว จึงไม่ทำ parity (mock dev ทำตามเท่าที่ workflowEngine ใช้ร่วม)
- To-Do: isTaskForMe(PENDING_BUFFER) = buffer เท่านั้น ; reviewer เห็นใน "รอผู้อื่น" ; approver เห็น in-progress ; แจ้งเตือนใหม่ `PR_PENDING_BUFFER` → targetRole BUFFER
- ความเข้ากันได้: PR เก่าสถานะ REVIEWED/APPROVED ไม่เปลี่ยน ; ป้ายสถานะ/สีเพิ่ม 1 ค่า ; เทสต์: cf_rbac PR_TABLE, cf_extra_fields, workflow tests, workspace routing, notify

### FR-02 หมายเหตุสินค้าใน PR / งานออนไลน์
- ตอนสร้าง PR คัดลอก `productRemark` ลง item ; ตอนแสดงผลใช้ `item.productRemark || products.find(productId).remark` (PR เก่าก็เห็น) ; แสดงกล่อง "สเปก/หมายเหตุ" ใต้ชื่อสินค้าใน PRCreateView (แถวรายการ), PRDetailsModal, OnlineOrderCard (ทั้งแถวแก้ไขได้/อ่านอย่างเดียว), PODetailsModal ; ไม่แตะ server ; แสดงเป็น text เท่านั้น (ห้าม dangerouslySetInnerHTML) + whitespace-pre-wrap

### FR-03 การ์ดงานออนไลน์
- OnlineOrderCard: แถวสินค้าเป็นการ์ด: รูป w-24/w-28 (คลิกเปิด ImageLightboxModal เดิม), ปุ่ม CTA "เปิดลิงก์ร้านค้าออนไลน์ ↗" + ป้ายแพลตฟอร์ม/โดเมน + ปุ่ม "คัดลอกลิงก์", กรอบหมายเหตุสินค้า (FR-02), จำนวน/หน่วย/ราคาอนุมัติตัวใหญ่ ; AttachmentThumbnail รองรับ sizeClass ใหญ่ ; UI เท่านั้น

### FR-04 ฟอนต์ทั้งระบบ
- ทางเลือก A (แนะนำ): override `theme.fontSize` ใน tailwind.config.js เลื่อนสเกล 1 ขั้น (xs→14px, sm→16px, base→18px, lg→20px, …) ครอบคลุม text-xs/sm/base ~1,450 จุดในคราวเดียว + codemod เปลี่ยน `text-[8/9/10/11px]` (~520 จุด) → `text-xs` + leading-normal แล้วไล่ตรวจหน้าจอทุกหน้า (ตาราง/การ์ด/modal/Sidebar) แก้จุดล้นด้วย min-w-0/break-words
- ทางเลือก B: ไล่เปลี่ยนคลาสทีละจุดตาม SRS (~2,000 จุด 60+ ไฟล์) งานใหญ่และเสี่ยงหลุดกว่า
- PDF (generatePoPdf) ใช้ขนาดของตัวเอง ไม่กระทบ
- ผู้ใช้เลือก A [Q4] ; ห้ามตาราง/ปุ่มเสียสัดส่วน ; playwright screenshot ก่อน/หลังหน้าหลักเพื่อยืนยัน

## ลำดับ/เวอร์ชันที่เสนอ (แต่ละข้อ: โค้ด → npm test → preview → QA → kla (FR-01) → backup → bump → CHANGELOG → tag → main)
1. v1.1.0 = FR-02 (เล็ก ไม่เปลี่ยน workflow) + FR-01 (ความต้องการหลักทางธุรกิจ)
2. v1.2.0 = FR-03
3. v1.3.0 = FR-04 (แตะทุกหน้า ทำหลังสุดเพื่อไม่ให้ปนกับบั๊กฟีเจอร์)
ผู้ใช้ยืนยันลำดับ [Q5] ; ทุกเวอร์ชันต้อง ask ผู้ใช้ก่อน deploy main

## คำตอบผู้ใช้ (2026-10-17)
Q1 ข้ามอัตโนมัติ · Q2 ทุก PR · Q3 `BUFFER` "ผู้ตรวจสอบจัดซื้อ (พี่สุ)" · Q4 ทางเลือก A · Q5 ตามลำดับข้างบน · Q6 Approver+Admin+Reviewer ตีกลับ/ยกเลิกได้ พี่สุไม่มีปุ่ม · Q7 level 2 ดูงบ/สร้าง PR/ดูสต๊อกทุกแผนก แต่จัดสรรงบ/ตรวจทานแทน reviewer ไม่ได้ · Q8 ไม่ใส่ใน PDF PO · Q9 ที่ PENDING_BUFFER แก้ได้เฉพาะพี่สุ+admin · Q10 ปิดบัญชีพี่สุ → admin ส่งต่อ/ตีกลับ ไม่เพิ่มปุ่ม

---

# งาน R2 storage adapter (ผู้ใช้สั่ง 2026-10-13) — รอ Fable อนุมัติ

สเปก: `docs/requirements-file-storage.md` (ผู้ใช้ตัดสิน: ใช้ R2 ตอนนี้ เพราะ Gmail ส่วนตัวสร้าง Shared Drive ไม่ได้ ; คงโค้ด Drive ไว้ย้ายภายหลัง) ; bucket + binding FILES ผู้ใช้เตรียมแล้ว
ลำดับ:
1. `functions/_lib/storage/{index,r2,drive-adapter,common}.js` — interface put/head/open/trash/untrash/makePrivate/publicUrl ; getStorage(env) สำหรับเขียน, getStorageFor(row) สำหรับอ่าน/ลบ/กู้ ; drive.js ไม่แก้ logic ไม่ลบ
2. migration `0013_attachments_storage.sql` (ADD COLUMN storage/objectKey/migratedFrom + index ; ไม่มี DROP)
   - migration `0014_m7_audit_notify.sql` (index `audit_logs.timestamp` + ตาราง `notification_reads` ; ไม่มี DROP)
   - migration `0015_stock_rate_index.sql` (index `audit_logs(performedBy, action, createdAtMs)` สำหรับ rate limit ปรับยอด/รับเข้า Manual ; ไม่มี DROP)
3. ต่อเข้า upload.js / files.js / orphans.js / unshare.js / [[route]].js (publicUrl) — API ฝั่ง client ไม่เปลี่ยน, สิทธิ์/IDOR/header เดิม
4. config: wrangler.toml r2_buckets + FILE_STORAGE, playwright.cf.config.js (R2 local), .dev.vars.example, e2e อัปโหลดจริง 1 เคส
5. `scripts/migrate-files.js` เฉพาะ --dry-run (ย้ายจริงรอบหน้า)
6. เอกสาร: M2_RUNBOOK ขั้น 1 เปลี่ยนเป็น R2, DEPLOY_CLOUDFLARE, parity
เกณฑ์ผ่าน: QA + kla ทันที (การเชื่อมต่อภายนอก), vitest/e2e CF local ผ่าน, ไม่เปลี่ยน UX, bucket ไม่เปิด public, ไม่รับ key จาก client
ไม่ทำ: deploy, d1/r2 --remote (ผู้ใช้รันเองหรือ ask ก่อน)

---

# เฟส 2: ปิดช่องโหว่กลาง/ต่ำที่ยอมรับไว้ (ผู้ใช้เลือก A — ask amv4na2y98, 2026-10-13)

สถานะ: รอ Fable อนุมัติ · ขอบเขต: ระบบ Cloudflare เท่านั้น (functions/ + src โหมด cloudflare) ไม่แตะ GAS ที่ใช้งานจริง ไม่ deploy
ลำดับตามที่ผู้ใช้เลือก:
1. ตัดระบบ GAS — เป็นงานผู้ใช้ใน M2 (ปิด web app หรือ clasp push) ทีมไม่ทำ แค่คงไว้ใน checklist
2. stock log ตรวจแผนก (`POST /api/stock-logs`) ให้ตรงกฎ canAccessDepartment ; batch products แจ้ง `skipped` ให้ client log/เตือน
3. บังคับเปลี่ยนรหัสครั้งแรก (`mustChangePassword`) + ยกเลิก token เดิมเมื่อเปลี่ยนรหัส (tokenVersion/passwordUpdatedAt ใน token) — มีหน้าจอเปลี่ยนรหัสเดิมหรือไม่ต้องตรวจก่อน ถ้าไม่มีต้อง ask เรื่อง UI
4. กรองข้อมูลที่ server: bootstrap/GET PR/PO/ผู้ใช้ ตามแผนกที่เข้าถึงได้ (canViewAllDepts/allowedDepartments) — ผลลัพธ์ที่ผู้ใช้เห็นต้องเท่ากับที่หน้าจอกรองอยู่แล้ว (ไม่ลดสิ่งที่เคยเห็นได้จริง)
5. proxy ดาวน์โหลดไฟล์ `/api/files/:id` ที่ต้อง login แทน anyone-with-link — ไฟล์เดิมยังเปิดได้ ; การเปลี่ยนสิทธิ์ไฟล์ใน Drive เป็นทางเลือกที่ต้อง ask
ต่ำอื่นในรอบเดียวกัน: ประวัติงบประเภททั่วไปจำกัดตามแผนก, ไฟล์กำพร้าใน Drive (trash เมื่อบันทึกล้ม), ล้างคอลัมน์ pin
เกณฑ์ผ่าน: QA + kla ทุก task, vitest/e2e CF local ผ่าน, ไม่เปลี่ยน UX/business rule นอกที่ระบุ

---

# แผน Migrate PRPO_PDQC → Cloudflare (เฟส 1) — ปิดแล้ว 2026-10-13

อัปเดต: 2026-10-11 · ผู้เขียน: Neo · สถานะ: รอ Fable อนุมัติ

## ข้อบังคับ
- คง UX/UI และ business rule เดิม (ระบบอ้างอิง = `src/` + `gas/` ที่ใช้งานจริง)
- ห้าม clasp push/deploy, wrangler deploy / d1 --remote, git push, ลบไฟล์, ติดตั้งแพ็กเกจ โดยไม่ ask ผู้ใช้

## สภาพปัจจุบัน (สรุปจากการสำรวจ)
- ของจริง: `src/` (React) + `gas/Code.gs` (RPC ผ่าน `google.script.run`, Sheets 18 ชีต, Drive โฟลเดอร์ `[ERP] PR-PO-Stock-System`)
- Cloudflare: `functions/api/[[route]].js` (= `cloudflare/functions/`) มี endpoint หลักแล้ว แต่ขาด usage-units, notifications, upload, budgets/reset, audit-logs, signatures, counters, finalize PO, recalc MAC ; approve/review เป็น PUT ทับทั้งเอกสาร ; path ไม่รู้จักได้ 200
- `d1_schema.sql` 13 ตาราง (ขาด notifications, attachments, signatures, app_config) และมี `DROP TABLE` ทุกตาราง
- โค้ดแยกสาย: `cloudflare/src/` ≠ `src/` ; `backend-gas/` เป็น fork เก่าที่ README อ้าง doPost/HMAC แต่ไม่มีจริง
- Drive ฝั่ง Cloudflare ยังไม่มี → รูปเก็บเป็น base64 ลง D1
- Auth: plaintext ทุก backend ; CF login ด้วย password ว่างได้, token ไม่ถูกตรวจ, `pin` รั่ว ; GAS เชื่อ user จาก client และ default ADMIN
- CI (`.github/workflows/deploy.yml`) build ไป GitHub Pages ไม่รันเทสต์ ; playwright baseURL ผิดพอร์ต

## สถาปัตยกรรมเป้าหมาย (เสนอ — ต้องให้ผู้ใช้ยืนยัน)
```
Browser ─▶ Cloudflare Pages (build จาก src/ ชุดเดียว)
            └─ Pages Functions /api/*  ── D1 (prpo-db)  = ข้อมูลหลัก
                       │
                       └─ Google Drive (โฟลเดอร์ใหม่เฉพาะโปรเจกต์) = ไฟล์แนบ/รูป
```
- frontend ชุดเดียว: `src/` เพิ่มโหมด `cloudflare` (flag เดียว) แทนการ fork `cloudflare/src/` ; ย้ายของดีจาก `cloudflare/src/` (login /api/auth, stock/issue) เข้า `src/`
- ทางเชื่อม Drive (ต้องเลือก):
  - D1: Workers เรียก Drive API ตรงด้วย Service Account (secret ใน wrangler secret) — ไม่พึ่ง GAS
  - D2: GAS web app ตัวเล็ก (doPost + HMAC) เป็น upload proxy — ใช้บัญชี Google เดิม
- Google Drive: โฟลเดอร์รากใหม่ เช่น `[PRPO-CF] PR-PO-Stock` โครงย่อยเหมือนเดิม (01_PR_Attachments, 02_PO_Documents, 03_GRN_Evidence, 04_Claim_Evidence/{YYYY-MM}/{เลขเอกสาร}) ; ID เก็บใน env ไม่ hardcode
- ย้ายข้อมูล: สคริปต์ export Sheets → SQL import ลง D1 (รันโดยผู้ใช้)

## Workstreams
1. **โครงสร้าง & deploy** — รวม frontend เป็นชุดเดียว, schema D1 แบบ migration (ไม่มี DROP), ลบ hardcode id, wrangler config, CI รัน lint+test ก่อน deploy, คู่มือ deploy ฉบับใหม่
2. **Google Drive** — สร้าง endpoint `/api/upload` ตามทาง D1/D2, โครงโฟลเดอร์ใหม่, ตาราง attachments, เลิกเก็บ base64 ใน D1
3. **Parity GAS ↔ Functions** — ตารางเทียบทุก action ใน `gas/Code.gs` กับ endpoint, เติม endpoint ที่ขาด, state machine PR/PO ฝั่ง server, เลขเอกสารจาก counters ฝั่ง server, 404 สำหรับ path ไม่รู้จัก, เลิก silent localStorage fallback ในโหมด CF
4. **Auth/Security (ขั้นต่ำก่อนขึ้นจริง)** — hash รหัสผ่าน, ปิด password ว่าง/รหัส default, token ที่ลงนามและตรวจทุก endpoint, RBAC ฝั่ง server ตาม level เดิม, ไม่ส่ง password/pin ออก
5. **ทดสอบ** — vitest สำหรับ Functions (ใช้ mock D1 แบบ `cloudflare_d1_sync_fixes`), แก้ playwright config, e2e บน `wrangler pages dev` + D1 local, prae-qa ทดสอบรายงาน

## ลำดับที่เสนอ
WS1 (โครง+schema) → WS3 (parity) ควบคู่ WS4 (auth) → WS2 (Drive) → WS5 (e2e รวม) → kla-security ตรวจทั้งระบบ → ผู้ใช้ deploy เอง

## คำถามที่ต้องให้ผู้ใช้ตัดสิน
1. ยืนยัน D1 เป็นที่เก็บข้อมูลหลัก (เลิกใช้ Sheets) หรือยังต้องคง GAS/Sheets ไว้คู่กัน
2. ทางเชื่อม Drive: D1 (Service Account) หรือ D2 (GAS proxy)
3. ระบบ GAS เดิมยังให้บริการต่อระหว่าง migrate หรือไม่ (มีผลต่อการย้ายข้อมูลรอบสุดท้าย)
4. ชะตา `cloudflare/src/` และ `backend-gas/` หลังรวมโค้ด (เก็บไว้ / archive — ไม่ลบโดยไม่ ask)
5. ไฟล์แนบใน Drive ใหม่ยังเป็น anyone-with-link เหมือนเดิม หรือจำกัดสิทธิ์
