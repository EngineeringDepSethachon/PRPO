<!--
รูปแบบ (อย่าเปลี่ยนชื่อหัวข้อ ## ทั้ง 4):
- บรรทัด "อัปเดต: YYYY-MM-DD HH:mm" ต้องอัปเดตทุกครั้งที่แก้
- ✅ ตัดสินใจแล้ว: รายการขึ้นต้น [YYYY-MM-DD]
- Milestone = "### M<n>: ชื่อ" ตามด้วย checkbox "- [ ]" / "- [x]"
- progress = จำนวน [x] / ทั้งหมด (server คำนวณ)
-->
# ไวท์บอร์ด Migrate Team
อัปเดต: 2026-10-13 23:59

## ✅ ตัดสินใจแล้ว

- [2026-10-13] หลัง smoke r2 (ผ่าน QA+kla): ยอดงบ 960 vs 1,070 ไม่ใช่บั๊ก (สคริปต์ API ข้ามขั้น client ; หน้าจอตรงกันทุกขั้น ; budgets.totalUsed ไม่ใช้แสดงผล ตรง GAS) ; server ส่งเวลา D1 เป็น ISO-Z (functions/_lib/timefmt.js) + client แสดงเวลาไทยรูปแบบเดิม ; ledger แผนก normalize ด้วย ledgerDeptCode ตัวเดียวทั้งตรวจ/บันทึก (dept=department เสมอ) ; PO สถานะ COMPLETED แสดง 'เสร็จสิ้น' ; login เร็วไม่ใช่บั๊กแอป

- [2026-10-13] M7 ปิดครบ (ผ่าน QA+kla ทุกข้อ): smoke รอบ 2 docs/smoke-test-2026-10-13-r2.md 5 role 78/78, e2e cf 12/12, npm test 2025 ผ่าน, build ผ่าน ; หน้า Audit Log ซ่อน PR_UPSERT/STOCK_LOG (เก็บในฐาน) ; PUT /api/users ไม่ส่ง allowedDepartments รีเซ็ตแผนก = พฤติกรรมเดิม GAS

- [2026-10-13] M7-2 ผ่าน QA+kla: server สร้างแจ้งเตือนตาม GAS (functions/_lib/notify.js, ข้อความตรงตัวอักษร, targetDept จาก DB, ใน batch เดียวกับเอกสาร) ; สถานะอ่านแยกต่อคน notification_reads (แถวเก่า status='read' = อ่านแล้วทุกคน) ; POST /api/notifications เฉพาะ ADMIN ; PR เขียนทับมี guard สถานะ (AND status IS ?) แพ้ race → 409 หรือ 200 no-op ; ก่อน deploy apply migrations ถึง 0014

- [2026-10-13] ผู้ใช้เลือก: คงไม่แจ้งเตือน Approver ตอนส่งจากร่าง/ส่งใหม่ (ตรง GAS) และไม่เพิ่มป้ายแยกแถว audit จาก client

- [2026-10-13] M7-1/3/4 ผ่าน QA+kla: GET /api/audit-logs field ตาม GAS (admin เท่านั้น, module pr/po=PURCHASE อื่นตาม moduleMap client) ; POST audit-logs จาก client ห้าม pr/po และ action ที่ server สงวน + timeline อ่านเฉพาะ source IS NULL ; PO audit PO_CREATED/UPDATE_PO/GOODS_RECEIVED_*/PO_SETTLED ใน batch ; RESUBMIT 1 แถวผ่าน marker จาก client ; ล้างลายเซ็นถึง D1 + signerOf fallback ตาม GAS ; CSV export กัน formula

- [2026-10-13] ผู้ใช้เลือก (ask) ตามที่ทีมแนะนำ M7: RESUBMIT 1 แถวต่อครั้ง ; UPDATE_PO ลงทุกการแก้ PO ; รับของ stockOnly ไม่ลง audit/แจ้งเตือน (ตาม GAS) ; สถานะอ่านแจ้งเตือนเก็บ server แยกต่อคน (ตาราง notification_reads migration 0014) ; ลายเซ็น: แก้การล้าง + fallback ตาม role ตาม GAS ไม่ทำหน้าใหม่ ; หน้า Audit Log แสดงข้อมูลจริงจาก server หน้าตาเดิม ; คงเมนูงบให้ ONLINE_PURCHASER (พฤติกรรมเดิม)

- [2026-10-13] Fable อนุมัติ M7 (cmv6sec6q1ce40) ลำดับ audit-log admin > PO audit > ลายเซ็น+RESUBMIT > แจ้งเตือน > smoke รอบ 2 ; local เท่านั้น ; เงื่อนไข: เทียบฟังก์ชัน GAS ตรงตัวอักษรจดใน tasks.md, audit actor จาก token + batch เดียวกับเอกสาร, /api/audit-logs เฉพาะ admin, ลายเซ็นแก้ได้เฉพาะ admin/เจ้าของ + จำกัดขนาด/ชนิด, ผู้รับแจ้งเตือนตรง GAS ห้ามข้ามแผนก + mark-read กัน IDOR + helper เดียว, migration ไม่มี DROP, smoke รอบ 2 เป็นเอกสารใหม่, เจอเรื่องเปลี่ยน UX/business rule ให้หยุด ask

- [2026-10-13] M6 ปิดครบ (ผ่าน QA+kla, npm test 1968/1968): E PO มี alias prNo จาก prNumber ; e2e/cf/seed.mjs กัน --remote

- [2026-10-13] C/D ปิด (ผ่าน QA+kla): โหมด CF ตัวเลขงบ (กล่อง PR, Dashboard, ธงเกินงบ, BudgetContext) ใช้ budgetService.calculatePeriodBudgetSummary แบบ BudgetView (workflowEngine เดิมจำลองยอด 65-95% — mock/GAS คงเดิม) ; server เขียน audit_logs ตอนเปลี่ยนสถานะ PR (actor จาก token, batch เดียวกับ PR) และประกอบ timeline ตอนอ่านแบบ GAS ; client ส่ง entry AL-/AUD- กลับถูกทิ้ง

- [2026-10-13] H = พฤติกรรมเดิม (ONLINE_PURCHASER ดูงบแบบภาพรวมโดยเจตนา) ไม่แก้ ; I/J แก้แล้ว ผ่าน QA+kla

- [2026-10-13] A/B ปิด (ผ่าน QA+kla): โหมด CF โหลด bootstrap ทันทีหลัง login ไม่ seed ข้อมูลตัวอย่าง ไม่เรียก /api/storage ; แคช localStorage ผูกเจ้าของ (session.userId) + ทิ้ง response ที่ token เปลี่ยน ; logout ล้างแคชทั้งหมด ; logout ไม่ revoke token ฝั่ง server คงเดิม (ยอมรับแล้ว)

- [2026-10-13] ผู้ใช้สั่งแก้บั๊ก smoke test ลำดับ G > F > A > B ก่อน

- [2026-10-13] G/F ปิดแล้ว (ผ่าน QA+kla ; ผู้ใช้สั่งแก้เพิ่มระหว่างทาง): server เป็นเจ้าของการบวกสต็อกตอนรับของ (MAC ตาม GAS, กันซ้ำด้วยเลข GRN, เพดานต่อบรรทัด + ต่อ PR หน่วยฐาน) ; ล็อกบรรทัด PO/อัตราแปลงหลังสั่งซื้อ ; PR หลังอนุมัติแก้จำนวนไม่ได้ ; สร้าง PO เฉพาะผู้อนุมัติขั้นสุดท้าย/admin ; สถานะ PO normalize + allowlist ; รายละเอียด docs/parity.md

- [2026-10-13] M5 R2 storage adapter เสร็จ ผ่าน QA+kla (Fable cmv6ddh435d434): ไฟล์ใหม่เก็บ R2 (FILE_STORAGE=r2 ค่าเริ่มต้น) อ่านตามแถว attachments.storage, โค้ด Drive คงไว้ ; migration 0013 ; scripts/migrate-files.js dry-run เท่านั้น ; runbook ขั้น 1 เป็น R2 ; ก่อน deploy apply migrations ถึง 0013

- [2026-10-13] ผู้ใช้สั่ง + Fable อนุมัติ (cmv6ddh435d434): ไฟล์แนบเก็บ R2 ก่อน (binding FILES, Gmail ส่วนตัวสร้าง Shared Drive ไม่ได้) คงโค้ด Drive ไว้ย้ายภายหลัง ; สเปก docs/requirements-file-storage.md ; แบ่งส่ง 2 ช่วง (A adapter+0013+endpoint / B config+e2e+migrate dry-run+เอกสาร) ; ทีมห้ามรัน wrangler r2 / d1 --remote / deploy

- [2026-10-13] **ที่เก็บไฟล์: ใช้ Cloudflare R2 ตอนนี้ และเขียนโค้ดให้สลับไป Google Shared Drive ได้ภายหลัง** (ผู้ใช้ตัดสิน — บัญชีเป็น Gmail สร้าง Shared Drive ไม่ได้ SA จึงใช้ไม่ได้) ; requirement เต็ม `docs/requirements-file-storage.md` (storage adapter r2/drive สลับด้วย FILE_STORAGE, attachments.storage/objectKey migration 0013, คง drive.js, แผนย้าย R2→Drive + rollback) ; เป็นการเปลี่ยนสถาปัตยกรรม Neo ต้อง consult Fable ก่อน และ kla ตรวจหลัง QA ; ยกเลิกรายการ "Service Account + Shared Drive" ใน M2 (ย้ายไปทำเมื่อมี Workspace)

- [2026-10-13] D-2 ปิด: bootstrap/GET products ส่ง alias price/stockBalance/reorderPoint/unit/avgCost ; ขาเข้าชื่อ UI ชนะชื่อ D1 ; fail-safe avgCost จับด้วย id/code (ไม่จับชื่อแบบ GAS)
- [2026-10-13] ผู้ใช้เลือก (ask): ทีมเตรียมคำสั่ง M2 ให้ก๊อปรันเอง → docs/M2_RUNBOOK.md (PowerShell 5.1, ผ่าน QA+kla) + scripts/set-user-password.js ตั้งรหัสแอดมินคนแรก (ขั้น 5.5) ; ทีมไม่รันคำสั่งที่แตะ remote
- [2026-10-13] Fable อนุมัติปิดเฟส 2 (cmv5g7gm24abda): stock log ตรวจแผนก, บังคับเปลี่ยนรหัส+tokenVersion, server กรองข้อมูล=หน้าจอเดิม+ฟิลด์หลักฐานประทับ token, proxy ไฟล์ /api/files/:id, CSP, PDF ใช้ pdf-lib ในโปรเจกต์ ; ก่อน deploy: apply migrations 0001-0012 + backfill file_refs ; รายละเอียด docs/parity.md
- [2026-10-13] ผู้ใช้เลือก (ask) ทำตามที่แนะนำ: ปิด anyone-with-link ไฟล์ใหม่ + ถอดสิทธิ์ไฟล์เก่าหลัง cutover ; ปิด job GitHub Pages ; ผู้ใช้ระดับ 2+ แก้งบทุกแผนกคงเดิม ; บังคับเลือกบทบาทตอนสร้างผู้ใช้
- [2026-10-13] ผู้ใช้เลือก: เพิ่มหน้าต่างเปลี่ยนรหัสเล็ก ๆ สไตล์เดิม (โหมด CF) เด้งเมื่อบัญชีต้องเปลี่ยนรหัส + เปิดจากเมนูโปรไฟล์ ; กรองข้อมูลที่ server = เท่ากับที่หน้าจอเดิมของผู้ใช้เห็นได้จริง (รวมทุกหน้า) ผู้ใช้ไม่เห็นอะไรเปลี่ยน ; users/products/departments ส่งครบซ่อนฟิลด์ลับ ; สิทธิ์ดูทุกแผนกคงเดิม
- [2026-10-13] logout เป็น stateless (token หมดอายุ 8 ชม.) — ยอมรับ ; ปิดบัญชี/เปลี่ยนรหัส → tokenVersion+1
- [2026-10-13] ผู้ใช้เลือก: หน้า Online (OnlineTaskView/OnlineProcurementHub) เปิดที่เดือนปัจจุบัน ; ไม่ต้องทำ Login with Google บน GAS — ใช้ login ด้วยรหัสที่สร้างใหม่
- [2026-10-13] Fable อนุมัติเปิดเฟส 2 (cmv4qxjf733ddc) ขอบเขต Cloudflare เท่านั้น ; ผู้ใช้ตัดสิน: migrations ชุดเดียวที่ root (ลบสำเนา cloudflare/migrations) ; บังคับเปลี่ยนรหัสเฉพาะบัญชีที่แอดมินสร้าง/รีเซ็ต ; ยกเลิก token เมื่อเปลี่ยนรหัสเองและแอดมินรีเซ็ต ; migration ใหม่ 0010+ ไม่มี DROP
- [2026-10-13] ผู้ใช้เลือก (ask amv4na2y98): ช่องโหว่กลาง/ต่ำที่เหลือ แก้ในเฟส 2 ตามลำดับ: ตัด GAS (ผู้ใช้) > stock log ตรวจแผนก > บังคับเปลี่ยนรหัส/ยกเลิก token > กรองข้อมูลที่ server > proxy ไฟล์ — แผน docs/plan.md
- [2026-10-13] Fable อนุมัติปิดเฟส 1 (cmv4n8ly427e60) ; เฟสถัดไปต้อง consult ใหม่ ; migrations source of truth = migrations/ ที่ root (cloudflare/migrations เป็นสำเนา มีเทสต์เทียบ)
- [2026-10-13] ผู้ใช้เลือก: เก็บไฟล์ใน Shared Drive (โฟลเดอร์ 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN ; ผู้ใช้ตั้ง SA เป็น Content manager เอง) ; หน้างบเปิดที่เดือนปัจจุบัน
- [2026-10-13] ผู้ใช้เลือก: คืน/เติมงบของผู้ไม่มีสิทธิ์งบ (L1/online) ต้องอ้างเลข PO, คืนได้ครั้งเดียวต่อ PO, ไม่เกินยอดที่ PO ตัดงบจริง ; ผู้ดูแลระบบ = level 99 หรือ roleId ADMIN ตรงตัวเท่านั้น
- [2026-10-13] ปิดยอด PO: server คำนวณส่วนต่างเอง, สถานะตาม GAS (settlementStatus), แก้ยอดซ้ำได้แต่คืนงบครั้งแรกเท่านั้น
- [2026-10-13] ผู้ใช้อนุมัติ: ตัดทางลัด bootstrap admin + รหัส default ใน gas/ (ยังไม่ clasp push) ; GitHub Pages deploy เฉพาะ workflow_dispatch
- [2026-10-12] M4 ผ่าน QA+kla: ไฟล์ใหม่ไม่แชร์สาธารณะ เปิดผ่าน proxy ทุกจุด (Word/Excel โหมด CF เป็นปุ่มเปิดไฟล์) ; admin POST /api/admin/unshare-public (dry-run เริ่มต้น) รันหลัง cutover ; ปิด job GitHub Pages (เหลือ test) ; บังคับเลือกบทบาทตอนสร้าง/แก้ผู้ใช้ (server 400 ถ้าไม่มี)
- [2026-10-12] ผู้ใช้เลือก: D1 เป็นข้อมูลหลัก ; GAS เดิมให้บริการต่อจนตัดระบบ ; Drive ใช้ Service Account โฟลเดอร์รากใหม่ ; ไฟล์แนบ anyone-with-link ; cloudflare/src + backend-gas archive ภายหลัง
- [2026-10-12] ผู้ใช้เลือก: ติดตั้ง wrangler devDependency ; ตัดรหัส default (123456/password123/admin123) ใน Cloudflare (แอดมินตั้งรหัสให้ผู้ใช้ใหม่เอง) ; login ได้เฉพาะ status ACTIVE (ตรง GAS)
- [2026-10-12] Auth: token = base64url(payload).HMAC อายุ 8 ชม. secret AUTH_TOKEN_SECRET ≥32 ตัว (wrangler secret) ; login ผิด 5 ครั้ง/user ล็อก 15 นาที, เพดาน 30 ครั้ง/IP ; INACTIVE ได้ 403 ข้อความเฉพาะ (ตาม GAS) ; ต้อง apply migrations 0002/0003 ก่อนใช้ login
- [2026-10-12] Parity: เลข PR รูปแบบเดิมแต่ใช้ปีปัจจุบัน ; สถานะ PR/PO ยึดค่าที่ GAS บันทึก ; canDeleteMaster ยึดพฤติกรรมจริง (level≥1 ลบได้) ; PR ใหม่ห้ามแผนก ALL/BOTH ยกเว้น admin ; ตาราง parity = docs/parity.md
- [2026-10-12] RBAC ฝั่ง server ยึดตาราง docs/parity.md c.5 (functions/_lib/rbac.js) ; สิทธิ์แผนกฝั่ง server = src/utils/permissions.js ; ledger/stock log append-only
- [2026-10-12] CORS: ALLOWED_ORIGINS allowlist (ไม่ตั้ง = same-origin)
- [2026-10-12] deploy จาก root เท่านั้น: npm run build:cf + wrangler pages ; cloudflare/functions ซิงก์ด้วย node scripts/prepare-cloudflare.js --backend-only ; คู่มือ docs/DEPLOY_CLOUDFLARE.md ; Node 22
- [2026-10-12] prae-qa ไม่มี shell บนเครื่องนี้ → QA อ่านโค้ด ; คำสั่งรันโดยโค้ดเดอร์/Neo ; `npm test` ขอบเขต tests + src/services/__tests__
- [2026-10-11] ผู้ใช้มอบอำนาจทีมทำงานอัตโนมัติจนเสร็จ (ระบบใช้งานภายใน) — รายละเอียดหัวข้อ "โหมดอัตโนมัติ" ใน CLAUDE.md ; ยังต้อง ask เฉพาะ: ลบไฟล์ของผู้ใช้, แก้ `data/`, git push, deploy (clasp/wrangler), เปลี่ยน UX/UI หรือ business rule

- [2026-10-13] M2: ผู้ใช้สั่งลบ D1 เดิม (ข้อมูล seed 72 แถว backup ไว้ที่ C:\Users\Admin\prpo-backups\prpo-db-20261013.sql) แล้วสร้างใหม่ ; D1 `prpo-db` id ใหม่ `c64022bb-88eb-485f-94f7-dd9e9617e44c` ; D1 `prpo-db-preview` id `00791d04-880f-4106-a2fc-f3349bcb013f` ; Pages project `prpo-pdqc` สร้างแล้ว (production branch main) ; migrations 0001-0012 apply ทั้งสองฐานแล้ว ; Preview deploy แล้ว https://preview.prpo-pdqc.pages.dev (หน้าโหลด 200 + CSP/XFO/nosniff ครบ, AUTH_TOKEN_SECRET ตั้งแล้วทั้ง production/preview (สุ่ม 48 ไบต์ คนละค่า) → /api/health 401 ; ฐาน preview มี mock: แผนก PD/QC/PUR/MGT, users admin.test(ADMIN 99)/plant.test/asst.test/online.test/req.test ยังไม่มีรหัส ผู้ใช้ตั้งเองผ่าน set-user-password.js ; ที่เก็บไฟล์ยังไม่ตัดสิน (Shared Drive ใช้ไม่ได้ เป็น Gmail — เสนอ R2) ; GOOGLE_SA_* ยังไม่ตั้ง) ; อัปเดต id ใน wrangler.toml ทั้งสอง, e2e/cf/seed.mjs, playwright.cf.config.js, scripts/prepare-cloudflare.js, cloudflare/README.md
- [2026-10-11] Cloudflare ของผู้ใช้: Account ID `bf8a6b6235d3b15616d8558762099275` ; D1 Studio: https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/workers/d1 (เลือก prpo-db)
- [2026-10-11] git remote origin = https://github.com/EngineeringDepSethachon/PRPO.git (ผู้ใช้ push เอง ทีมห้าม push)

## ⛔ ห้ามทำ

- ห้าม push ขึ้น git / ลบไฟล์ / ติดตั้งแพ็กเกจใหม่ โดยไม่ถามผู้ใช้ก่อน
- ห้าม commit key Service Account หรือ secret ใด ๆ ; ห้ามรัน d1 --remote

## ⏳ ค้างอยู่

- **งานใหม่ (Neo): ทำ R2 storage adapter ตาม docs/requirements-file-storage.md** (consult Fable → สมชายแตก task → malee → QA → kla) ; **R2 เปิดแล้ว + bucket `prpo-files` / `prpo-files-preview` สร้างแล้ว (2026-10-13) + binding `FILES` และ `FILE_STORAGE="r2"` ใส่ใน wrangler.toml แล้ว** ทีมเริ่มเขียนโค้ดได้ทันที (อย่าสร้าง bucket/binding ซ้ำ)
- D-2 แก้แล้ว deploy Preview รอบใหม่แล้ว (2026-10-13, deployment 5575d3c8) — รอผู้ใช้ยืนยันหน้า Master Data/Dashboard

- ผู้ใช้ต้องทำเองก่อนขึ้นจริง: ทำตาม docs/M2_RUNBOOK.md ขั้น 0-8 (ขั้น 4.0 หยุดใช้ GAS ก่อน export ; ตัดสินตอนรัน: --force-change-password, ล้าง password/pin ในชีตหลังพ้น rollback)
- ก่อน cutover: แอดมินในชีตเดิมต้องมี roleId ADMIN หรือ level 99
- ความเสี่ยงที่ยอมรับ + เงื่อนไขปิด: (1) anyone-with-link → "ไฟล์ใหม่ private แล้ว ; หลัง cutover admin รัน unshare-public (dry-run ก่อน) เพื่อถอดสิทธิ์ไฟล์เก่า" ; (2) GAS เชื่อ userContext จาก client — ต้องปิด web app GAS หรือ clasp push ตัวแก้ทันทีหลังตัดระบบ ห้ามปล่อยค้าง
- ต่ำ (บันทึก): online settle ฝั่ง D1 ไม่คืนงบจาก actualTotalAmount (client คืนเองผ่าน ledger) ; parity: ไม่บังคับแผนก/เจ้าของเอกสารฝั่ง server, แก้ items PR ได้ทุกสถานะ
- ถามผู้ใช้อีกครั้งตอนตัดระบบ: ล้างรหัส plaintext ใน Sheets
- ต่ำ (รอผู้ใช้ตัดสินภายหลัง): จับคู่ code ที่มีช่องว่าง/อักษรไม่ใช่ ASCII ระหว่าง stock-logs กับ MAC ; ฟอนต์ PDF ของ GAS โหลดจาก jsdelivr ; หน้า login ส่ง IP ไป api.ipify.org ; ตัวเลขยอดคืนที่แสดงผล client เขียนได้ภายใต้เพดาน (ไม่กระทบ ledger) ; เปิดไฟล์ private ที่ไม่มีสิทธิ์/เน็ตล่มจะไปหน้าขอสิทธิ์ Google (proxy ตอบ 404 เหมือนกันกันเดา)
- ผู้ใช้ต้องลบไฟล์ temp เอง (permission บล็อกทีม): C:\Users\Admin\Desktop\PRPO\docs\_tmp_assemble.cjs, C:\Users\Admin\Desktop\PRPO\docs\_tmp_step1_head.md, C:\Users\Admin\Desktop\PRPO\docs\_tmp_step1_tail.md, C:\Users\Admin\Desktop\PRPO\docs\_tmp_later_head.md, C:\Users\Admin\Desktop\PRPO\tests\_dbg_sig.test.js (ไฟล์ it.skip เปล่าของ M7-4b)
- ถามผู้ใช้ภายหลัง: lifecycle ลบถาวร trash/ ใน R2 เกิน 30 วัน (ตอนนี้ไม่ลบอัตโนมัติ) ; id โฟลเดอร์ Drive ยืนยันตอนย้ายไป Google Drive
- ลบ/แก้บรรทัดที่อ้าง Service Account/Shared Drive เป็นขั้นก่อนขึ้นจริง (ตอนนี้เป็นงานภายหลังเมื่อมี Google Workspace)
- ต่ำ (บันทึก): PR อนุมัติ/ส่งกลับพร้อมกัน 2 request ผ่านทั้งคู่ (ไม่มี optimistic lock) ; PRDetailsModal self-heal สถานะจาก activityLog (เดิม, แสดงผลเท่านั้น) ; แผนกไม่มีงบเดือนนี้ → ธงเกินงบขึ้น (zero-based ตรง BudgetView)
- ต่ำ (บันทึก): admin แยกแถว audit ที่ client ส่งไม่ได้ (ต้องเพิ่มป้าย = เปลี่ยน UI ถามผู้ใช้ภายหลัง)
- ต่ำ (บันทึก): ลายเซ็นตาม role ใช้ภาพเดียวกันทุกคนใน role นั้น (ตาม GAS)
- ต่ำ (บันทึก): ลายเซ็นทุกคนอ่านได้ทาง GET /api/users ทุกคนที่ login (ตามระบบเดิม)
- ต่ำ (ตรวจใน smoke รอบ 2): หน้า Audit Log รีโหลด 2000 แถวทุกครั้งที่มี log ในเครื่อง ; ORDER BY julianday ไม่ใช้ index
- ต่ำ (บันทึก) M7-2: lock ใช้ status อย่างเดียว — แก้เนื้อหาพร้อมกันในสถานะเดิม/ABA ยังทับได้ ; POST หลาย PR ได้ 409 บางส่วน ; PUT ไม่พบแถวตอบ success ; ดับเบิลคลิกสร้าง PR → 409 modal (ข้อมูลไม่เสีย) ; Approver role ที่ canViewAllDepts=0 ยังได้แจ้งเตือนแผนกอื่น (ตรง GAS) ; เหตุผลยกเลิก PR แจ้งทั้งแผนก (ตรง GAS)
- ผู้ใช้เลือก (ask 2026-10-13): ไม่แจ้งเตือน Approver ตอนส่งจากร่าง/ส่งใหม่ (ตรง GAS) ; ไม่เพิ่มป้ายแถว audit จาก client
- ต่ำ (บันทึก): หลัง smoke r2: แท็บ 'ปิดงานแล้ว' ในรายการ PO ไม่นับ COMPLETED (พฤติกรรมเดิม — เปลี่ยน = ถามผู้ใช้) ; PR ค้าง 'รอสั่ง Online' หลังเคลม/ยกเลิก PO (เดิม) ; รหัสแผนกจริงที่ขึ้นต้น 'ฝ่าย' จะถูกตัด — เช็กตอนย้ายข้อมูล Sheets ; writer ติดป้าย CLAIM_CREDIT ไม่มี docNo ให้ PO อื่นในแผนกได้ ; writer เขียน ledger แผนก ALL ได้ (เดิม) ; ORDER BY createdAt ที่รูปแบบปน

## 🎯 Milestones

### M2: เตรียมขึ้นระบบจริง (ผู้ใช้ทำตาม checklist ใน docs/DEPLOY_CLOUDFLARE.md)

- [ ] เปิด R2 + ตรวจ binding FILES + secrets (runbook ขั้น 1)
- [x] สร้าง D1 preview (00791d04… ; ลบ D1 เดิมแล้วสร้าง prpo-db ใหม่ c64022bb…)
- [ ] backup + apply migrations remote (ถึง 0014 ทั้ง prod/preview ; backup เดิมที่ C:\Users\Admin\prpo-backups)
- [ ] ย้ายข้อมูลจาก Sheets
- [ ] smoke test
- [ ] ตัดระบบ GAS (ปิด web app หรือ clasp push ตัวแก้ทันที)
