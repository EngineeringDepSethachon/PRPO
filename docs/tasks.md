# M7 — ปิดช่องว่าง parity โหมด CF (Fable cmv6sec6q1ce40 ; ผู้ใช้ ask 2026-10-13: ทำตามแนะนำ Q1-Q6 ทั้งหมด, คงเมนูงบ ONLINE) — ปิดแล้ว 2026-10-13
ผล: ทุกข้อ QA PASS + kla PASS (M7-1 kla พบสูง: ปลอม audit ผ่าน POST → แก้ ; M7-2 QA FAIL 1 รอบ + kla กลาง: POST notifications/lost-update → แก้ด้วย optimistic lock สถานะ) ; smoke r2 78/78, e2e cf 12/12 ; npm test 2025 ผ่าน, build ผ่าน ; เพิ่ม: ซ่อน PR_UPSERT/STOCK_LOG ในหน้า Audit Log, seed canViewAllDepts
ลำดับ: (1a ∥ 3 ∥ mig) → 1b → 4a → 4b → 2 → 5 ; ทุกข้อ QA → kla (1, 4, 2 ตรวจทันที)
- [x] M7-1a GET /api/audit-logs (functions/_lib/extra.js:291-318) คืน field ตาม GAS apiGetAuditLogs Code.gs:3630 + recordAuditLogEntry Code.gs:1080-1126: id, timestamp, createdAt, action, module, targetRef, docNo, actorName, actorRole, actor{id,name,role,department}, summary, details, comment, changes ; module pr/po=PURCHASE, stock_log/product=INVENTORY, user/signature=RBAC, budget*=BUDGET, อื่น=MASTER ; timestamp ISO-Z ; admin เท่านั้น — malee
- [x] M7-1b client โหมด CF: apiService.js:53-69 + AuditLogView.jsx:79-98 เรียก GET /api/audit-logs?limit=2000 (guard token) ไม่ seed/ไม่ fallback localStorage ; หน้าตา/ปุ่มคงเดิม (Q6=A) — nong
- [x] M7-mig migrations/0014: idx_audit_logs_timestamp + ตาราง notification_reads(notificationId,userId,readAt) (Q4=A) ไม่มี DROP — nong
- [x] M7-3 PO audit (poAuditStmt ใน batch เดียวกับ PO): PO_CREATED (apiCreatePO Code.gs:2364, 'สร้างใบสั่งซื้อ (PO) เลขที่ '+poNo) ; UPDATE_PO (apiSavePO Code.gs:2535, note||reason||comment||'ปรับปรุงข้อมูลใบสั่งซื้อ', ทุก PUT/POST ทับ Q2=A) ; GOODS_RECEIVED_FULL/PARTIAL (Code.gs:2951, 'ตรวจรับสินค้า เลขที่ '+grn+' ครบถ้วนแล้ว ปิดใบงาน'|' บางส่วน', ไม่ลงเมื่อ stockOnly Q3=A / GRN ซ้ำ / PO จบแล้ว) ; PO_SETTLED (Code.gs:3092, 'ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿X | ยอดจ่ายจริง ฿Y'[' | ประหยัดงบ ฿S'][' | '+note]) ; audit() ใส่ timestamp ISO — malee
- [x] M7-4a RESUBMIT ตาม apiUpdatePR Code.gs:1641-1655 + apiSavePR 1620-1627: client ส่ง action RESUBMIT/UPDATE (apiService.js:834, :850) ; server ลง RESUBMIT 1 แถว (Q1=A) หรือ CANCEL ถ้า CANCELLED ; isDraft=true / editPRItems ไม่ลง ; ตัดกฎ DRAFT→SUBMITTED⇒RESUBMIT — malee
- [x] M7-4b ลายเซ็น (Q5=A): ล้างลายเซ็น (null) ต้องถึง D1 (apiUpsertUser Code.gs:468) ; signerOf fallback roleId||canonicalRole||role → 'REQUESTER_PD' ตาม resolveUserSignatureBase64 Code.gs:2002 ; แก้ได้เฉพาะ admin — malee
- [x] M7-2 แจ้งเตือน server: helper เดียว functions/_lib/notify.js port recordNotification (gas/SheetService.gs:414-487) targetRole 'Approver'/'Requester'/'Purchaser'/'ALL', targetDept จากแถวใน DB ; PR_SUBMITTED/Approver (Code.gs:1524) ; PR_APPROVED Requester+Purchaser (:1737, :1745) ; PR_REJECTED/Requester (:1806) ; PR_CANCELLED/ALL (:1912) ; PO_CANCELLED/ALL (:2457) ; ONLINE_ORDERED/Requester (:2475) ; PO_CLAIM_CLOSED/Purchaser (:2517) ; GOODS_RECEIVED/Purchaser หรือ PO_CLAIM Purchaser+Requester (:2966-2990, id ผูก GRN) ; mark-read ผ่าน notification_reads กัน IDOR — malee
- [x] M7-5 smoke รอบ 2 → docs/smoke-test-2026-10-13-r2.md (ไม่ทับฉบับเดิม) 5 role ครบ flow — prae-qa

# M4 — งานตามที่ผู้ใช้ตัดสินหลังปิดเฟส 2 (ask 2026-10-12: ทำตามที่แนะนำ) — ปิดแล้ว
- [x] ไฟล์ใหม่ไม่แชร์สาธารณะ + proxy ครบทุกจุด (ProxiedImg, FileUploader, viewer, lightbox) + POST /api/admin/unshare-public — malee — QA PASS 3 รอบ, kla PASS 2 รอบ
- [x] ปิด job GitHub Pages (deploy.yml เหลือ job test) — malee
- [x] ผู้ใช้ระดับ 2+ แก้งบทุกแผนก: คงเดิม (บันทึก parity.md)
- [x] บังคับเลือกบทบาทตอนสร้าง/แก้ผู้ใช้ + server 400 — malee
- ผลเทสต์: npm test 1462 ผ่าน (ข้าม 1), e2e CF 10/10 ; ต่ำ: เน็ตล่ม/ไม่มีสิทธิ์ → fallback หน้าขอสิทธิ์ Google
---

# Tasks — เฟส 2 (Fable อนุมัติ cmv4qxjf733ddc, 2026-10-13)
ผู้ใช้ตัดสิน: migrations ชุดเดียวที่ root (ลบสำเนา cloudflare/migrations, cloudflare/wrangler.toml ชี้ ../migrations) ; บังคับเปลี่ยนรหัสเฉพาะบัญชีที่แอดมินสร้าง/รีเซ็ต ; ยกเลิก token เมื่อเปลี่ยนรหัสเองและแอดมินรีเซ็ต
- [x] P0 migrations source of truth เดียว — malee — QA PASS ; 👤 ผู้ใช้ต้องลบสำเนา cloudflare/migrations (permission บล็อกทีม) — เทสต์ migrations_sync จะผ่านหลังลบ
- [x] P2 stock-logs ตรวจแผนก + skipped เฉพาะแถวแผนกอื่นที่ฟิลด์ master ต่างจริง + modal เตือนเดิม — malee — QA PASS รอบ 3 ; ต่ำ: label department ของ log, lookup id/code ใน diff
- [x] P3 mustChangePassword (บัญชีใหม่/รีเซ็ต) + tokenVersion ยกเลิก token (migration 0010) + หน้าต่างเปลี่ยนรหัส (ผู้ใช้เลือก A) + ตัวจับ 401 หลายแท็บ — malee — QA PASS (b–d) + kla PASS 2 รอบ ; npm test 1243, e2e 10/10 ; ต่ำ → P6: CSP _headers, storage event logout ทันที
- [x] P4 กรอง bootstrap/GET ตามแผนกที่ server (เทสต์เทียบหน้าจอทุก role/level) — malee
  - ผ่าน QA+kla 2026-10-13 (5 รอบแก้: ฟิลด์หลักฐาน/ประทับ token, logSealed รายคีย์, guard เคลม/บรรทัด, เพดานขนาด) — npm test 1338 ผ่าน, e2e CF 10/10 ; ข้อจำกัดใน docs/parity.md
- [x] P5 proxy ดาวน์โหลดไฟล์ /api/files/:id ตรวจสิทธิ์ตามเอกสาร, stream, nosniff — malee → kla ทันที
  - ผ่าน QA+kla 2026-10-13 (3 รอบ: IDOR instr → fileIdsIn นิยามเดียว, file_refs index migration 0011, logout ล้าง cache) — npm test 1376, e2e CF 10/10 ; ต่อใน P6: fallback quota, reindex เฉพาะเอกสารที่เขียน, deptOfRef ; anyone-with-link ต้อง ask ผู้ใช้ภายหลัง
- [x] P6 ต่ำ: ledger ประเภททั่วไปตามแผนก, ไฟล์กำพร้า Drive, ล้าง pin (UPDATE ว่าง ใน 0010+) + ต่อจาก P5 (fallback quota/reindex/deptOfRef) + CSP _headers + storage logout
  - ผ่าน QA+kla 2026-10-13 (2 รอบ): ledger/logout ยืนยันด้วยเทสต์, fallback quota + คงลิงก์ที่เอกสารถือ (429/503 แทนตัดเงียบ), scripts/backfill-file-refs.js, /api/admin/cleanup-orphans (dry-run, trash) + restore-orphan, CSP public/_headers, PDF ใช้ pdf-lib ในโปรเจกต์แทน esm.sh — npm test 1426, e2e CF 10/10 ; ต่ำค้าง: ฟอนต์ GAS จาก jsdelivr, ipify, key เอกสาร 60 ตัว/คำขอ, restore แล้วติด cleanup รอบถัดไป
- [x] P7 kla ตรวจรวม + consult ปิดเฟส 2
  - เริ่ม 2026-10-13: kla ตรวจรวม
  - kla ตรวจรวม PASS (วิกฤต/สูง/กลาง 0) ; Fable อนุมัติปิดเฟส 2 cmv5g7gm24abda ; vitest 1436, e2e 10/10, audit 0
- [x] U4 (ผู้ใช้เลือก) หน้า Online (OnlineTaskView/OnlineProcurementHub) อิงเดือนปัจจุบันทั้งหน้า (src/utils/monthUtils.js) — nong — QA PASS รอบ 2 ; ต่ำ: alias '2026'/'2569' ตกค้าง

---

# Tasks — Migrate Team (เฟส 1) — ปิดแล้ว

อนุมัติ: Fable consult `cmv42ly9312f62` APPROVED (2026-10-12) · แผน: `docs/plan.md`

## การตัดสินใจของผู้ใช้ (2026-10-12)
- D1 = ข้อมูลหลัก (เลิก Sheets หลังย้าย) ; GAS เดิมให้บริการต่อจนตัดระบบ แล้วย้ายข้อมูลรอบสุดท้าย
- Drive: Service Account (key อยู่ใน wrangler secret ผู้ใช้ตั้งเอง ห้าม commit) ; โฟลเดอร์รากใหม่ id `1H85HQT8kLM_pN5pOp1DCxbtb-ie-AEK4` (ใส่ผ่าน env `DRIVE_ROOT_FOLDER_ID`)
- ไฟล์แนบ anyone-with-link เหมือนเดิม ; `cloudflare/src/` + `backend-gas/` → archive หลังรวมโค้ด (ไม่ลบถาวร)
- ติดตั้ง wrangler เป็น devDependency ; token อายุ 8 ชม. ; login ผิด 5 ครั้ง ล็อก 15 นาที ; แก้ GAS default ADMIN ในโค้ด `gas/` แต่ไม่ clasp push
- Neo: T1.4 ไม่ลบ D1 `database_id` จาก wrangler.toml (wrangler ต้องใช้ ไม่ใช่ความลับ) และไม่แตะ `gas/Config.gs` (ระบบใช้งานจริง)

## WS1 โครงสร้าง & deploy
- [x] T1.0 ติดตั้ง wrangler devDependency — nong (wrangler 4.149.0 ; Neo ตรวจ diff แล้ว)
- [ ] T1.1 migrations/0001_init.sql + 0002_missing_tables.sql (ไม่มี DROP, apply --local 2 รอบผ่าน) — malee — QA PASS (0001-0003 ; ฟิลด์ pos/prs/budget_transactions ที่ GAS มีแต่ D1 ไม่มี → ตัดสินใน T3.1 ว่าเก็บใน JSON หรือเพิ่ม migration 0004)
- [x] T1.2 ใส่หัว DEPRECATED ใน d1_schema.sql ทั้งสองไฟล์ — nong
- [x] T1.3 รวม frontend `src/` + flag `VITE_BACKEND_MODE` — malee — QA ผ่านขอบเขตครบใน 4 รอบ (รอบ 4 ผู้ใช้อนุมัติ) ; ปิด fallback login/สลับ user ในโหมด CF, ทุก fetch แนบ Bearer, build:cf ; ประเด็น requesterId ย้ายไป T4.3b
- [x] T1.4 ID ฝั่ง Cloudflare ไปใช้ env/placeholder — nong (ไม่พบ ID ฝังในโค้ด ; เพิ่ม DRIVE_ROOT_FOLDER_ID ใน wrangler.toml.example)
- [x] T1.5 CI: lint → test → build → build:cf ก่อน deploy — nong — QA PASS (lint 0 error/819 warning ; CI แดงจนกว่าแก้ 6 เทสต์เดิม)
- [x] T1.6 แก้ playwright baseURL/webServer — nong (พอร์ต 5173, --list 30 เทสต์)
- [x] T1.7 docs/DEPLOY_CLOUDFLARE.md — nong — QA รอบ 1 FAIL (Node 18→22) แก้แล้ว Neo ตรวจ + รันเทสต์ import 49/49 ; CI ใช้ node 22 ; ส่วน Drive รอ WS2
- [x] T1.8 CORS: ALLOWED_ORIGINS allowlist + Vary + dev shortcut localhost — malee — QA PASS + kla PASS ; secret ≥32 ; checklist Preview D1

## WS3 Parity (หลัง T1.1)
- [x] T3.1 docs/parity.md ครบทุกฟังก์ชันใน gas/Code.gs — malee — QA PASS (68 แถว: มี 4/ต่าง 43/ขาด 21 ; ส่วน CF auth ในเอกสารล้าสมัยหลัง T4.3 — refresh ตอน T3.2)
- [x] T3.1b migrations/0004_parity_columns.sql (extraJson prs/pos, prs.poNumber, pos.isClosed, products.avgCost/totalValue) — nong — QA PASS
- [x] T3.1c (QA PASS ; comma-join จริงอยู่ที่ src/services/workflowEngine.js:1691 ส่วน GAS Code.gs:2971,3201 เก็บเลขเดียว — import ต้องรองรับทั้งสองแบบ) migrations/0005: pos.budgetPeriod/committedAmount/actualPaidAmount/actualTotalAmount, purchaseChannel (prs/pos), index (pos.department,budgetPeriod), prs.status ; prs.poNumber = comma-joined ตาม GAS ; Functions ต้อง merge extraJson ตอนอ่าน — nong
- [x] T3.2 Router + 404/405 (functions/_lib/routes.js) — malee — QA + kla PASS
- [x] T3.3 เลขเอกสาร doc_counters atomic, Asia/Bangkok, renumber PR เมื่อชน/ผิดรูปแบบ — malee — QA + kla PASS
- [x] T3.4 State machine PR/PO — ทำใน T4.5 (PR_FLOWS/PO_RULES ตรวจ from→to ฝั่ง server ; ไม่แยกเป็น action endpoint เพื่อคง API เดิมของ client)
- [x] T3.5 Endpoint ที่ขาด + PUT budgets/:dept เครดิตคืน + hardening (0008) — malee — QA + kla PASS ; npm test 1140
- [x] T3.6 เลิก silent fallback ในโหมด cloudflare (cfGuard: throw + modal เดียว + rollback + reload) — malee — QA PASS รอบ 2 ; ต่ำ: receiveAllGoods rollback 2 ชั้น, dedupe 800ms อาจกลืน error ถัดไป
- [x] T3.7 เลิกเดือน/ปี hard-code ใน functions (Asia/Bangkok) — malee ; ค้าง: client ยังฝัง 2026-09/2026-08 (budgetService, BudgetView) — ถามผู้ใช้

## WS4 Auth/Security (หลัง T1.1) — ส่ง kla-security ทันทีหลัง QA
- [ ] T4.1 PBKDF2 (WebCrypto) hash/verify — malee — QA PASS 13/13 (Neo รันแล้ว) kla PASS (ไม่มีวิกฤต/สูง) ; ข้อกลาง/ต่ำ (ช่วง iterations 1000–100000, ตรวจ algo, รหัส ≤256, ล้าง plaintext) แก้รวมใน T4.3
- [x] T4.2 scripts/import-sheets-to-d1.js (hash ตอน import, --local เท่านั้น) — malee — QA PASS (T4.2/b/c) ; kla รอบ 1 FAIL (สูงอยู่ฝั่ง functions → แก้ใน T4.5) ; ฝั่ง importer แก้แล้ว (INSERT ปกติ/--replace, --out ปลอดภัย, .gitignore) ; ต่ำ: /import/, กัน --out ทับไฟล์โปรเจกต์, ข้อความ id ซ้ำ, realpath
- [ ] T4.3 /api/auth + token HMAC 8 ชม. + middleware, ไม่ส่ง password/pin — malee
- [ ] T4.4 Rate limit: ผิด 5 ครั้ง ล็อก 15 นาที — malee — QA PASS รอบ 2 รอ kla
- [x] T4.3b server ตั้ง requesterId/actorId = role id แบบ frontend (parity GAS) เก็บ user id จริงใน audit_logs — malee — QA PASS
- [x] T4.3c แก้ผล kla: สำเนา cloudflare/functions backdoor (วิกฤต), seed plaintext d1_schema (สูง), error message, เพดาน IP 30, .gitignore .env, ย้าย runtime DDL — malee — QA PASS + kla ตรวจซ้ำ PASS (ไม่มีวิกฤต/สูง)
- [x] T4.3d (QA PASS รอบ 2 ; ต่ำ: 401/400 error ไม่ใช่ string ยังได้ [object Object]) ข้อกลางจาก kla รอบ 2: cloudflare/wrangler.toml.example, archive cloudflare/src → archive/cloudflare-src-2026-10-12 (ผู้ใช้อนุมัติ archive แล้ว), ข้อความ 429/403 ตอน login — nong — เสร็จ ยกเว้นย้าย cloudflare/src (คำสั่ง Move-Item ถูก permission บล็อก → ผู้ใช้ต้องรันเอง/อนุมัติ) ; npm test 635/635, build/build:cf ผ่าน, lint 0 error
- [x] T4.2b migration 0006 + import + functions: ฟิลด์ที่หายตอน import — malee — QA PASS (Neo รัน 51/51) ; ต่ำ: คอมเมนต์ 0001-0005→0006, เทสต์ INACTIVE regex อ่อน, activeFields isActive vs status, settle+ตัวกันซ้ำ BUDGET_ROLLBACK ตาม GAS (คงไว้)
- [x] T4.5 RBAC ตาม level เดิม + แก้ GAS default ADMIN (ไม่ push) — malee — QA PASS ; kla 5 รอบ (b–e) ปิดช่องเพิ่มงบผ่าน settle/PO ปลอม/ยอด PR ; kla รอบสุดท้าย PASS ; npm test 1018/1018 ; ค้าง: รอผู้ใช้ (ask amv45cl6i5) จำกัด TOP_UP/ROLLBACK ผ่าน /budgets/adjust + title ADMIN ; ต่ำ: ledger POST ประเภทอื่นปลอมประวัติได้ (ไม่กระทบยอด), client เงียบเมื่อ 400/409 (→ T3.6)
- [x] T4.6 (ผู้ใช้ตัดสิน 2026-10-13) คืนงบ L1/online ต้องอ้าง PO + เพดานรวมต่อ PO (ไม่ใช่ครั้งเดียว เพราะ flow จริงคืนหลายร้าน/รอบ) ; admin = level≥99 หรือ roleId ADMIN — malee — QA PASS (b–e)
- [x] T4.6c-e settle คืนงบส่วนต่างจริง (server คำนวณ), สถานะตาม GAS (settlementStatus), แก้ยอดซ้ำได้แต่คืนงบครั้งแรกเท่านั้น (ตรง GAS), client CF ไม่คืนซ้ำในเครื่อง — malee — QA PASS ; npm test 1184, e2e 9/9
- [x] T4.5f/h PO ตรวจแผนก, id UUID, rule budget-dept-update, แผนกตรง client permissions.js, PR ใหม่ห้าม ALL/BOTH (ยกเว้น admin), PO ปิดแล้วห้ามแก้ยอด — malee — QA PASS + kla PASS ; npm test 1039/1039

## WS2 Google Drive (Service Account) — ส่ง kla-security ทันทีหลัง QA
- [x] T2.1 functions/_lib/drive.js (SA JWT, โฟลเดอร์, upload, anyone-with-link, magic bytes, publicError) — malee — QA PASS + kla PASS ; ต้องใช้ Shared Drive (ask amv4cxycs6)
- [x] T2.1c hook /api/upload (functions/_lib/upload.js, migration 0007/0009) + frontend CF อัปโหลด PDF/รูปใหญ่/claim ขึ้น Drive, ตัด blob: — malee — QA PASS + kla PASS
- [x] T2.1d/e sanitize URL ไฟล์/ลิงก์/ลายเซ็น (functions/_lib/sanitize.js, body.js), rate limit upload, ลายเซ็นผู้ใช้บีบ JPEG — malee — QA PASS รอบ 3 ; ต่ำ: fileUtils.js:169 event.target, รูปเดโม SVG ถูกตัดใน CF
- [x] T2.2 โครงโฟลเดอร์ 0X_*/{YYYY-MM}/{เลขเอกสาร} + ตาราง attachments — รวมใน T2.1/T2.1c
- [x] T2.3 เลิกเก็บ base64 ใหญ่ใน D1 (เพดาน 400k ต่อฟิลด์, PDF/รูปใหญ่ขึ้น Drive) — รวมใน T2.1c
- [x] T2.4 kla ตรวจซ้ำ sanitize → PASS (กลาง 1: JSON string bypass) → แก้ + QA PASS ; ต่ำเหลือ 3 (บันทึกใน bug-details.md)
- [ ] T2.2 โครงโฟลเดอร์ 0X_*/{YYYY-MM}/{เลขเอกสาร} + ตาราง attachments — malee
- [ ] T2.3 เลิกเก็บ base64 ใน D1 (รูปเก่ายังแสดงได้) — malee

## งานเพิ่มจากผู้ใช้
- [x] U1 หน้างบเปิดเดือนปัจจุบัน (BudgetView.jsx ค่าเริ่มต้น ; ?month= ยังใช้ได้) — nong — QA PASS ; ค้าง: budgetService baseline 2026-09, OnlineTaskView/OnlineProcurementHub ยังฝัง 2026-09/08 (ถามผู้ใช้)
- [x] U2 docs/security-report.md สรุปบั๊กตามระดับ + ประเมินโอกาสถูกแฮก — Neo

- [x] U3 (ผู้ใช้อนุมัติ 2026-10-13) gas/: ตัด bootstrap admin + รหัส default + fallback ADMIN ใน getUserProfile ; CI: GitHub Pages deploy เฉพาะ workflow_dispatch, ลบ env ลับ — nong — QA PASS ; ยังไม่ clasp push ; ผลข้างเคียง Login with Google บน GAS ใช้ไม่ได้

## WS5 ทดสอบ
- [x] T5.0 แก้ 6 เทสต์ที่ fail เดิม — malee — QA PASS ; npm test 587/587 (Neo รันแล้ว) ; ค้าง: BudgetView/budgetService ฝังเดือน 2026-09 (พฤติกรรมเดิม — ถามผู้ใช้)
- [ ] T5.1 Vitest ของ Functions (mock D1) — nong + prae
- [x] T5.2 E2E บน wrangler pages dev + D1 --local (playwright.cf.config.js, e2e/cf/*, npm run test:e2e:cf) — malee — 9/9 ผ่าน ไม่พบ bug ; QA PASS ; ยังไม่ครอบ: upload Drive จริง, ขั้นตอนธุรกิจผ่าน UI (ยิง API)
- [x] T5.3 kla-security ตรวจทั้งระบบ — PASS (ไม่มีวิกฤต/สูงใน Cloudflare) ; npm audit --omit=dev = 0 ; แก้ข้อกลาง/ต่ำ T5.3b–f (Preview D1, ledger allowlist, master data ตรวจแผนกแถวจริง, /api/auth 8KB, build CF ตัด demo/sourcemap, รหัสผู้ใช้ห้าม default) — QA PASS ; npm test 1202, e2e 9/9 ; ต่ำที่เหลือ: batch skip ไม่แจ้ง client, stock-logs ไม่ตรวจแผนก, ตัวแปร known ไม่ใช้

## M9: แก้บั๊กผู้ทดสอบ 2026-10-14 (docs/bug-log-tester-2026-10-14.md)
- [x] TC-008 เบิกจ่ายด่วนตัดราคาตั้งต้นแทน MAC — server serverIssueUnitCost (avgCost > IN ล่าสุด > standardPrice) ใช้ใน /api/stock/issue และ /adjust เมิน unitCost client ; QuickIssueView โหมด CF เกณฑ์เดียวกัน ; macMigration โหมด CF เรียก POST /api/products/recalculate-mac ; QA 2 รอบ PASS, kla PASS
- [x] TC-007 สถิติ/ประวัติเบิกไม่มีข้อมูล — functions/_lib/stocklogs.js stockLogView alias timestamp/date/qty/note/name/balanceAfter ใน GET /api/stock-logs + bootstrap ; tests/cf_tc007_tc008.test.js, tests/cf_tc007_tc008_qa_edge.test.js
- [x] TC-004 หมายเหตุสินค้าไม่บันทึก — migration 0017_product_remark.sql, applyProductRemark (สิทธิ์แผนก, ≤2000, actor จาก token, id แถวที่ตรวจสิทธิ์แล้ว, audit PRODUCT_REMARK_SET) ; PUT/POST แถวเดิมไม่เขียน currentStock ; ProductRemarkDrawer แสดงค่าที่เพิ่งบันทึก ; kla กลาง IDOR remark แก้แล้ว + recalculate-mac เมิน averageCost + สินค้าไม่มีแผนก admin เท่านั้น + CSV csvCell (src/utils/csvSafe.js) ; tests/cf_product_remark*.test.js ; npm test 2128/2128, build ผ่าน
- [x] TC-003/006/009 สายเคลม — PODetailsModal ปุ่มจัดการเคสเปิดด้วย isSelfClaimStatus ; To-Do เคลมจัดซื้อเอง = Requester+Admin ; resolveClaim ล้าง flag ค้าง ; Hub สถานะปิดชนะ flag ค้าง ; tests/cf_claim_flow_tc003_006_009.test.js ; QA PASS, kla PASS
- [x] TC-005 กระดิ่ง — แถว server ติด serverScoped ไม่กรองซ้ำ ; badge = งานค้าง (ผู้ใช้เลือก A คงตาม 1.0.1) ; src/utils/claimState.js (isPoInOpenClaim, isPoDone, isOwnerByRequesterId) ร่วม getUserTasks/isTaskForMe ; tests/notification_bell_tc005.test.js ; QA 2 รอบ PASS, kla PASS
- [x] TC-005 follow-up (2026-10-15, Neo แก้เอง หลังผู้ทดสอบยังพบรายการว่างบน production) — สาเหตุจริง: `/api/bootstrap` ฝั่ง CF ไม่ส่ง `notifications` (GAS apiGetBootstrapData ส่ง) และ client ไม่เรียก GET /api/notifications เอง → เครื่องใหม่รายการว่างเสมอ ; แก้: extra.js `listNotificationsFor()` ใช้ร่วม GET + bootstrap (กรอง isUserTargetOfNotification + read mark รายผู้ใช้) ; เทสต์ใน tests/cf_notifications_server.test.js ; npm test 2235/2235 ; deploy prod แล้ว (commit 8223212)
- [x] 2026-10-15 ผู้ทดสอบรายงานต่อ (Neo แก้เอง): (1) modal "คำนวณต้นทุนเฉลี่ยใหม่ไม่สำเร็จ NOT_FOUND ถุงมือกันร้อน" เด้งทุกครั้งที่เปิดแอป — `App.jsx` เรียก `runMacMigration()` (hack เก่าของสินค้าตัวอย่าง) ทุกครั้งตอนเริ่ม → ถอดออก + ลบ export ใน macMigration.js ; (2) กระดิ่ง badge 1 แต่ข้างใน 13 — เปลี่ยน badge จาก taskCounts.total เป็นจำนวนแจ้งเตือนยังไม่อ่าน (`unreadBadgeCount`) ส่วนงานค้างยังมี badge ที่ "งานของฉัน" (กลับคำตัดสิน S5 ข้อ A ตามที่ผู้ใช้แจ้งว่าไม่สอดคล้อง) ; tests/sidebar_notification_bell.test.jsx ปรับ ; npm test 2236/2236 ; deploy prod bundle index-CO_EVpVL.js
- [x] 2026-10-15 ผู้ทดสอบ: PO-PD-2026-003 (SELF, PARTIALLY_RECEIVED_IN_CLAIM) เปิดเป็น System Admin ไม่มีปุ่มท้ายหน้าต่าง — `PODetailsModal.jsx` gate `isOperational` นับเฉพาะ requester/asst_mgr/supervisor ไม่รวม admin ทั้งที่ canReceiveGoods/canResolveSelfClaim อนุญาต ADMIN → เพิ่ม isAdminRole เข้า isOperational ; เทสต์ใหม่ tests/po_details_admin_footer.test.jsx (admin/owner เห็น "จัดการเคสปัญหา" หลังปิดแผง, reviewer ไม่ใช่เจ้าของไม่เห็น, ONLINE ไม่เห็น) ; npm test 2241/2241 ; deploy prod bundle index-CVGtEZCB.js
  - หมายเหตุ: แผง "จัดการเคสสินค้ามีปัญหา" เปิดอัตโนมัติตอนเปิด PO ; ปุ่ม "จัดการเคสปัญหา" ท้ายหน้าต่างโผล่หลังกดยกเลิก/ปิดแผง (พฤติกรรมเดิม) ; ยังพบว่า requesterId ของ PO เก็บเป็น roleId (เช่น ASST_MANAGER) ทำให้ผู้ใช้ role เดียวกันถูกนับเป็นเจ้าของ (follow-up เดิมบนไวท์บอร์ด)
- [x] TC-002 รูป GRN — AttachmentViewerModal รู้จัก R2 /api/files ไม่ตีความ uuid เป็น Drive ; tests/cf_grn_photo_viewer*.test.jsx ; QA PASS, kla PASS
- [x] /api/products/batch ไม่เขียน currentStock แถวเดิม, ข้ามแถว isDeleted, count นับแถวที่เขียนจริง ; ยอดตั้งต้นแถวใหม่ตรวจ ≥0 ≤1e7 + audit PRODUCT_CREATE + trim code ; ORDER BY (id=?) DESC ใน resolveMasterRow/handler ; isDriveUrl/getDriveFileViewUrl ตรวจ hostname ; tests/cf_batch_stock_not_reverted, cf_kla_*, cf_products_followup_low, drive_url_host ; QA+kla PASS
- TC-001 ลายเซ็นผู้ขอซื้อใน PDF รอผู้ใช้ตัดสิน
- ผลรวม M9: npm test 2225/2225 (119 ไฟล์), build ผ่าน ; ก่อน deploy apply migration ถึง 0017 ; kla กลางค้าง: PO ค้างเคลมปิดได้โดยไม่มี canCloseClaim (รอผู้ใช้ตัดสินพร้อม short-close S4)
