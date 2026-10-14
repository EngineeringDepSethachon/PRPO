## Snapshot ปิดเฟส 1 (2026-10-13)

<!--
รูปแบบ (อย่าเปลี่ยนชื่อหัวข้อ ## ทั้ง 4):
- บรรทัด "อัปเดต: YYYY-MM-DD HH:mm" ต้องอัปเดตทุกครั้งที่แก้
- ✅ ตัดสินใจแล้ว: รายการขึ้นต้น [YYYY-MM-DD]
- Milestone = "### M<n>: ชื่อ" ตามด้วย checkbox "- [ ]" / "- [x]"
- progress = จำนวน [x] / ทั้งหมด (server คำนวณ)
-->
# ไวท์บอร์ด Migrate Team
อัปเดต: 2026-10-13 15:00

## ✅ ตัดสินใจแล้ว

- [2026-10-12] Fable อนุมัติเฟส 1 (cmv42ly9312f62): schema เป็น migration ไม่มี DROP ทดสอบ --local เท่านั้น ; PBKDF2 hash ตอน import ; parity table ก่อนเขียน endpoint
- [2026-10-13] ผู้ใช้เลือก: เก็บไฟล์ใน Shared Drive (โฟลเดอร์ 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN — ผู้ใช้ตั้ง SA เป็น Content manager เอง) ; หน้างบเปิดที่เดือนปัจจุบัน
- [2026-10-13] ผู้ใช้เลือก: คืนงบ/เติมงบของผู้ไม่มีสิทธิ์งบ (L1/online) ต้องอ้างเลข PO, คืนได้ครั้งเดียวต่อ PO และไม่เกินยอดที่ PO ตัดงบจริง ; ผู้ดูแลระบบ = level 99 หรือ roleId ADMIN ตรงตัวเท่านั้น (เลิกนับจากคำว่า ADMIN ในตำแหน่ง)
- [2026-10-12] ผู้ใช้เลือก: D1 เป็นข้อมูลหลัก ; GAS เดิมให้บริการต่อจนตัดระบบ ; Drive ใช้ Service Account โฟลเดอร์รากใหม่ id 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN (ผู้ใช้ส่งมา 2026-10-13 แทนอันเดิม) ; ไฟล์แนบ anyone-with-link ; cloudflare/src + backend-gas archive ภายหลัง
- [2026-10-12] ผู้ใช้เลือก: ติดตั้ง wrangler devDependency ; token 8 ชม. ; login ผิด 5 ครั้งล็อก 15 นาที ; แก้ GAS default ADMIN ในโค้ดแต่ไม่ clasp push
- [2026-10-12] prae-qa ไม่มี shell บนเครื่องนี้ → QA อ่านโค้ด ส่วนการรันคำสั่งให้โค้ดเดอร์/Neo รันแนบผล ; `npm test` ใช้ขอบเขต tests + src/services/__tests__
- [2026-10-12] ผู้ใช้เลือก: ตัดรหัส default (123456/password123/admin123) ใน Cloudflare — แอดมินตั้งรหัสให้ผู้ใช้ใหม่เอง ; login ได้เฉพาะ status ACTIVE (ตรง GAS)
- [2026-10-12] ผู้ใช้เลือก (parity): เลข PR ออกฝั่ง server รูปแบบเดิมแต่ใช้ปีปัจจุบัน ; สถานะ PR/PO ยึดค่าที่ GAS บันทึกจริง ; canDeleteMaster ยึดพฤติกรรมตอนรันจริง (level≥1 ลบได้) ; ตาราง parity อยู่ docs/parity.md
- [2026-10-12] token = base64url(payload).HMAC อายุ 8 ชม. secret AUTH_TOKEN_SECRET (wrangler secret) ; ต้อง apply migrations 0002/0003 ก่อนใช้ login
- [2026-10-12] ผู้ใช้ INACTIVE ใส่รหัสถูกได้ 403 ข้อความเฉพาะ (ตาม GAS ACCOUNT_DISABLED) ; เพดาน login ผิดต่อ IP 30 ครั้ง ต่อ user 5 ครั้ง/15 นาที
- [2026-10-12] CORS: ALLOWED_ORIGINS allowlist (ไม่ตั้ง = same-origin) ; AUTH_TOKEN_SECRET ≥32 ตัว ; PR ใหม่ห้ามแผนก ALL/BOTH ยกเว้น admin ; สิทธิ์แผนกฝั่ง server = src/utils/permissions.js
- [2026-10-12] RBAC ฝั่ง server ยึดตาราง action/role/from/to ใน docs/parity.md c.5 (functions/_lib/rbac.js) ; ledger/stock log append-only ; GAS ไม่มี user context → ไม่ใช่ ADMIN (ยังไม่ clasp push)
- [2026-10-12] deploy จาก root เท่านั้น: npm run build:cf + wrangler pages ; cloudflare/functions ซิงก์ด้วย node scripts/prepare-cloudflare.js --backend-only ; คู่มือ docs/DEPLOY_CLOUDFLARE.md ; Node 22
- [2026-10-13] kla ตรวจทั้งระบบ (T5.3) PASS สำหรับ Cloudflare ; npm audit production = 0 (26 รายการเป็น dev-only) ; ผู้ใช้อนุมัติ: ตัดทางลัด bootstrap admin + รหัส default ใน gas/ (ยังไม่ clasp push) และ GitHub Pages deploy เฉพาะ workflow_dispatch
- [2026-10-13] ปิดยอด PO: server คำนวณส่วนต่างเอง, สถานะตาม GAS (settlementStatus), แก้ยอดซ้ำได้แต่คืนงบครั้งแรกเท่านั้น
- [2026-10-13] ตรวจทั้งระบบผ่าน: vitest 1202, e2e CF local 9/9, npm audit production 0 ; รายงาน docs/security-report.md + docs/bug-details.md

- [2026-10-11] ผู้ใช้มอบอำนาจทีมทำงานอัตโนมัติจนเสร็จ (ระบบใช้งานภายใน) — รายละเอียดหัวข้อ "โหมดอัตโนมัติ" ใน CLAUDE.md ; ยังต้อง ask เฉพาะ: ลบไฟล์ของผู้ใช้, แก้ `data/`, git push, deploy (clasp/wrangler), เปลี่ยน UX/UI หรือ business rule

- [2026-10-11] Cloudflare ของผู้ใช้: Account ID `bf8a6b6235d3b15616d8558762099275` ; D1 `prpo-db` id `d2e63ef5-b69f-4bf0-8220-13a17682a9db` binding `DB` (ตรงกับ `wrangler.toml` ที่รากและใน `cloudflare/` แล้ว) ; D1 Studio: https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/workers/d1/databases/d2e63ef5-b69f-4bf0-8220-13a17682a9db/studio
- [2026-10-11] git remote origin = https://github.com/EngineeringDepSethachon/PRPO.git (ผู้ใช้ push เอง ทีมห้าม push)

## ⛔ ห้ามทำ

- ห้าม push ขึ้น git / ลบไฟล์ / ติดตั้งแพ็กเกจใหม่ โดยไม่ถามผู้ใช้ก่อน
- ห้าม commit key Service Account หรือ secret ใด ๆ ; ห้ามรัน d1 --remote

## ⏳ ค้างอยู่

- ผู้ใช้ต้องทำเองก่อนขึ้นจริง: ย้าย/สร้างโฟลเดอร์ใน Shared Drive, ปิด anyone-with-link โฟลเดอร์ราก, สร้าง Service Account + secret (docs/DEPLOY_CLOUDFLARE.md 2.5)
- ก่อน cutover: แอดมินในชีตเดิมต้องมี roleId ADMIN หรือ level 99
- รอ Fable อนุมัติปิดเฟส 1 (consult cmv4n8ly427e60)
- ผู้ใช้ต้องย้าย cloudflare/src → archive/cloudflare-src-2026-10-12/src เอง (คำสั่งใน archive/README.md ; permission บล็อกทีม) — ระหว่างนี้ห้าม build จาก cloudflare/
- ต่ำ (บันทึก): online settle ฝั่ง D1 ไม่คืนงบจาก actualTotalAmount (client คืนเองผ่าน ledger) ; parity: ไม่บังคับแผนก/เจ้าของเอกสารฝั่ง server, แก้ items PR ได้ทุกสถานะ
- GAS เดิมไม่มี RBAC ฝั่ง server (default ADMIN) — สิทธิ์จริงอยู่ใน workflowEngine.canAction ฝั่ง client → T4.5 ถอดเป็นฝั่ง server
- ถามผู้ใช้อีกครั้งตอนตัดระบบ: ล้างรหัส plaintext ใน Sheets
- ต่ำ (บันทึกไว้): token เดิมยังใช้ได้หลังเปลี่ยนรหัสจนครบ 8 ชม. (เพิ่ม tokenVersion ภายหลัง) ; ล้างคอลัมน์ pin ที่ค้าง ; CORS ยัง * ต้องจำกัด origin ก่อนขึ้นจริง
- ถามผู้ใช้: หน้า Online (OnlineTaskView/OnlineProcurementHub) ยังเปิดเดือน 2026-09/08 — เปลี่ยนเป็นเดือนปัจจุบันไหม
- parity (ยังไม่แก้): bootstrap/GET คืน PR/PO/ผู้ใช้ทุกแผนก (client กรองหน้าจอ) ; mustChangePassword ยังไม่บังคับ

## 🎯 Milestones

### M1: เฟส 1 Migrate ขึ้น Cloudflare

- [x] Fable อนุมัติแผน + ผู้ใช้ตอบคำถามสถาปัตยกรรม
- [x] WS1 โครงสร้าง & schema D1 แบบ migration
- [x] WS3 Parity GAS ↔ Functions
- [x] WS4 Auth/Security ขั้นต่ำ
- [x] WS2 Google Drive upload
- [x] WS5 ทดสอบ vitest/playwright/e2e
- [x] kla-security ตรวจทั้งระบบ

## สำเนาไวท์บอร์ด ณ ปิดเฟส 2 (2026-10-13) — Fable อนุมัติ cmv5g7gm24abda

<!--
รูปแบบ (อย่าเปลี่ยนชื่อหัวข้อ ## ทั้ง 4):
- บรรทัด "อัปเดต: YYYY-MM-DD HH:mm" ต้องอัปเดตทุกครั้งที่แก้
- ✅ ตัดสินใจแล้ว: รายการขึ้นต้น [YYYY-MM-DD]
- Milestone = "### M<n>: ชื่อ" ตามด้วย checkbox "- [ ]" / "- [x]"
- progress = จำนวน [x] / ทั้งหมด (server คำนวณ)
-->
# ไวท์บอร์ด Migrate Team
อัปเดต: 2026-10-13 23:45

## ✅ ตัดสินใจแล้ว

- [2026-10-13] P6 ผ่าน QA+kla: PDF ใช้ pdf-lib ในโปรเจกต์ (ไม่โหลด esm.sh), CSP public/_headers, ล้างไฟล์กำพร้าเฉพาะ admin (dry-run เริ่มต้น ย้ายถังขยะ กู้ได้), ก่อน deploy รัน scripts/backfill-file-refs.js ตามคู่มือ
- [2026-10-13] P5 ผ่าน QA+kla: GET /api/files/:id ต้อง login + เห็นเอกสารเจ้าของไฟล์ (นอกนั้น 404), stream, nosniff ; หน้าเว็บโหมด CF เปิดไฟล์ผ่าน proxy (blob) ถ้า proxy ไม่ได้ใช้ลิงก์เดิม ; ต้อง apply migrations ถึง 0011 (file_refs) ก่อน deploy
- [2026-10-13] P4 เสร็จ (ผ่าน QA+kla): server กรองข้อมูล = union ของหน้าจอเดิม ; ฟิลด์หลักฐาน (ผู้รับ/ผู้ปิด/ผู้แจ้ง/log) server ประทับจาก token, log append-only ปิดผนึกรายคีย์ ; ปิดเคลมต้องอยู่ในเคลม+สถานะปิด+บทบาทตามหน้าเว็บ ; ข้อจำกัดต่ำที่เหลือ (ตัวเลขแสดงผลเท่านั้น ไม่กระทบ ledger) ดูรายละเอียดใน docs/parity.md
- [2026-10-13] หน้าต่างเปลี่ยนรหัส (CF) + token ยกเลิกเมื่อเปลี่ยน/รีเซ็ต/ปิดบัญชี (tokenVersion, migration 0010) ผ่าน QA+kla ; ต้อง apply migration ถึง 0010 ก่อน deploy
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
- [2026-10-12] ผู้ใช้เลือก: D1 เป็นข้อมูลหลัก ; GAS เดิมให้บริการต่อจนตัดระบบ ; Drive ใช้ Service Account โฟลเดอร์รากใหม่ ; ไฟล์แนบ anyone-with-link ; cloudflare/src + backend-gas archive ภายหลัง
- [2026-10-12] ผู้ใช้เลือก: ติดตั้ง wrangler devDependency ; ตัดรหัส default (123456/password123/admin123) ใน Cloudflare (แอดมินตั้งรหัสให้ผู้ใช้ใหม่เอง) ; login ได้เฉพาะ status ACTIVE (ตรง GAS)
- [2026-10-12] Auth: token = base64url(payload).HMAC อายุ 8 ชม. secret AUTH_TOKEN_SECRET ≥32 ตัว (wrangler secret) ; login ผิด 5 ครั้ง/user ล็อก 15 นาที, เพดาน 30 ครั้ง/IP ; INACTIVE ได้ 403 ข้อความเฉพาะ (ตาม GAS) ; ต้อง apply migrations 0002/0003 ก่อนใช้ login
- [2026-10-12] Parity: เลข PR รูปแบบเดิมแต่ใช้ปีปัจจุบัน ; สถานะ PR/PO ยึดค่าที่ GAS บันทึก ; canDeleteMaster ยึดพฤติกรรมจริง (level≥1 ลบได้) ; PR ใหม่ห้ามแผนก ALL/BOTH ยกเว้น admin ; ตาราง parity = docs/parity.md
- [2026-10-12] RBAC ฝั่ง server ยึดตาราง docs/parity.md c.5 (functions/_lib/rbac.js) ; สิทธิ์แผนกฝั่ง server = src/utils/permissions.js ; ledger/stock log append-only
- [2026-10-12] CORS: ALLOWED_ORIGINS allowlist (ไม่ตั้ง = same-origin)
- [2026-10-12] deploy จาก root เท่านั้น: npm run build:cf + wrangler pages ; cloudflare/functions ซิงก์ด้วย node scripts/prepare-cloudflare.js --backend-only ; คู่มือ docs/DEPLOY_CLOUDFLARE.md ; Node 22
- [2026-10-12] prae-qa ไม่มี shell บนเครื่องนี้ → QA อ่านโค้ด ; คำสั่งรันโดยโค้ดเดอร์/Neo ; `npm test` ขอบเขต tests + src/services/__tests__
- [2026-10-11] ผู้ใช้มอบอำนาจทีมทำงานอัตโนมัติจนเสร็จ (ระบบใช้งานภายใน) — รายละเอียดหัวข้อ "โหมดอัตโนมัติ" ใน CLAUDE.md ; ยังต้อง ask เฉพาะ: ลบไฟล์ของผู้ใช้, แก้ `data/`, git push, deploy (clasp/wrangler), เปลี่ยน UX/UI หรือ business rule

- [2026-10-11] Cloudflare ของผู้ใช้: Account ID `bf8a6b6235d3b15616d8558762099275` ; D1 `prpo-db` id `d2e63ef5-b69f-4bf0-8220-13a17682a9db` binding `DB` (ตรงกับ `wrangler.toml` ที่รากและใน `cloudflare/` แล้ว) ; D1 Studio: https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/workers/d1/databases/d2e63ef5-b69f-4bf0-8220-13a17682a9db/studio
- [2026-10-11] git remote origin = https://github.com/EngineeringDepSethachon/PRPO.git (ผู้ใช้ push เอง ทีมห้าม push)

## ⛔ ห้ามทำ

- ห้าม push ขึ้น git / ลบไฟล์ / ติดตั้งแพ็กเกจใหม่ โดยไม่ถามผู้ใช้ก่อน
- ห้าม commit key Service Account หรือ secret ใด ๆ ; ห้ามรัน d1 --remote

## ⏳ ค้างอยู่

- ถามผู้ใช้ภายหลัง: ปิด anyone-with-link ใน Drive (ไฟล์ใหม่ + ลบสิทธิ์ไฟล์เก่า) หลัง proxy ครบทุกจุด
- ผู้ใช้ต้องทำเองก่อนขึ้นจริง: ย้าย/สร้างโฟลเดอร์ใน Shared Drive, ปิด anyone-with-link โฟลเดอร์ราก, สร้าง Service Account + secret (docs/DEPLOY_CLOUDFLARE.md 2.5)
- ก่อน cutover: แอดมินในชีตเดิมต้องมี roleId ADMIN หรือ level 99
- ความเสี่ยงที่ยอมรับ + เงื่อนไขปิด: (1) ไฟล์แนบ anyone-with-link — proxy ทำแล้ว — เหลือปิดลิงก์สาธารณะใน Drive (ต้อง ask) ; (2) GAS เชื่อ userContext จาก client — ต้องปิด web app GAS หรือ clasp push ตัวแก้ทันทีหลังตัดระบบ ห้ามปล่อยค้าง
- ต่ำ (บันทึก): online settle ฝั่ง D1 ไม่คืนงบจาก actualTotalAmount (client คืนเองผ่าน ledger) ; parity: ไม่บังคับแผนก/เจ้าของเอกสารฝั่ง server, แก้ items PR ได้ทุกสถานะ
- ถามผู้ใช้อีกครั้งตอนตัดระบบ: ล้างรหัส plaintext ใน Sheets
- ผู้ใช้ต้องลบไฟล์ tests/_dbg_tmp.test.js (ไฟล์ debug ของมะลิ permission บล็อก)
- ต่ำ (บันทึก): ฟอนต์ PDF ในระบบ GAS โหลดจาก jsdelivr, หน้า login ส่ง IP ไป api.ipify.org

## 🎯 Milestones

### M3: เฟส 2 ปิดช่องโหว่กลาง/ต่ำ

- [x] migrations ชุดเดียว
- [x] stock log ตรวจแผนก + แจ้ง skipped
- [x] บังคับเปลี่ยนรหัส + ยกเลิก token
- [x] กรองข้อมูลตามแผนกที่ server
- [x] proxy ดาวน์โหลดไฟล์
- [x] ต่ำอื่น (ledger, ไฟล์กำพร้า, ล้าง pin)
- [ ] kla ตรวจรวม + ปิดเฟส 2

### M2: เตรียมขึ้นระบบจริง (ผู้ใช้ทำตาม checklist ใน docs/DEPLOY_CLOUDFLARE.md)

- [ ] Service Account + Shared Drive + secrets
- [ ] สร้าง D1 preview
- [ ] backup + apply migrations remote
- [ ] ย้ายข้อมูลจาก Sheets
- [ ] smoke test
- [ ] ตัดระบบ GAS (ปิด web app หรือ clasp push ตัวแก้ทันที)

## M5 ปิดแล้ว (2026-10-13) — R2 storage adapter, Fable cmv6ddh435d434

### M5: R2 storage adapter

- [x] ช่วง A: storage adapter + migration 0013 + ต่อ upload/files/orphans/unshare
- [x] ช่วง B: config R2 + e2e + migrate-files dry-run + เอกสาร/runbook

## ปิด 2026-10-13: M6 แก้บั๊ก smoke test

### M6: แก้บั๊ก smoke test (docs/smoke-test-2026-10-13.md)

- [x] G วิกฤต: GRN log ซ้ำ + สต็อก/ต้นทุนไม่ขยับ
- [x] F สูง: ยอด PO หาย VAT + สถานะ COMPLETED
- [x] A สูง: bootstrap หลัง login + ล้างข้อมูลตัวอย่าง
- [x] B กลาง: เลิกยิง /api/storage ในโหมด CF
- [x] C, D กลาง: กล่องงบใน PR / timeline+audit PR
- [x] E, H, I, J ต่ำ

## ปิด 2026-10-13: M7 ปิดช่องว่าง parity โหมด CF

### M7: ปิดช่องว่าง parity โหมด CF

- [x] หน้า Audit Log admin อ่าน /api/audit-logs
- [x] แจ้งเตือนฝั่ง server แบบ GAS recordNotification
- [x] audit แถวของ PO (PO_CREATED/UPDATE_PO/GOODS_RECEIVED/PO_SETTLED)
- [x] ลายเซ็นบันทึกลง D1 + RESUBMIT ตอนแก้ PR
- [x] smoke test สวมบทบาทรอบ 2 บน localhost (docs/smoke-test-2026-10-13-r2.md: 78/78, e2e cf 12/12)
