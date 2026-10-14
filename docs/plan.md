# งาน R2 storage adapter (ผู้ใช้สั่ง 2026-10-13) — รอ Fable อนุมัติ

สเปก: `docs/requirements-file-storage.md` (ผู้ใช้ตัดสิน: ใช้ R2 ตอนนี้ เพราะ Gmail ส่วนตัวสร้าง Shared Drive ไม่ได้ ; คงโค้ด Drive ไว้ย้ายภายหลัง) ; bucket + binding FILES ผู้ใช้เตรียมแล้ว
ลำดับ:
1. `functions/_lib/storage/{index,r2,drive-adapter,common}.js` — interface put/head/open/trash/untrash/makePrivate/publicUrl ; getStorage(env) สำหรับเขียน, getStorageFor(row) สำหรับอ่าน/ลบ/กู้ ; drive.js ไม่แก้ logic ไม่ลบ
2. migration `0013_attachments_storage.sql` (ADD COLUMN storage/objectKey/migratedFrom + index ; ไม่มี DROP)
   - migration `0014_m7_audit_notify.sql` (index `audit_logs.timestamp` + ตาราง `notification_reads` ; ไม่มี DROP)
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
