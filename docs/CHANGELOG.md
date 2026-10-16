# CHANGELOG — PRPO (PR/PO & Inventory)

เลขเวอร์ชันอยู่ที่ `package.json` และ git tag `vX.Y.Z` ; ทุกครั้งที่ deploy **main (production)** ต้องมีแถวในไฟล์นี้ + tag + backup ฐานข้อมูล (กติกาผู้ใช้ 2026-10-16)

## กติกาการออกเวอร์ชัน (ทำทุกครั้งก่อน deploy main)
1. `npm test -- --run` ผ่าน และทดสอบบน preview แล้ว (https://preview.prpo-pdqc.pages.dev)
2. backup ฐาน production: `npx wrangler d1 export prpo-db --remote --output C:\Users\Admin\prpo-backups\prpo-db-<YYYYMMDD>-v<เวอร์ชันเดิม>.sql`
   (ถ้ามี migration ใหม่ apply กับ prpo-db-preview ก่อน แล้วค่อย prpo-db)
3. bump เวอร์ชัน: `npm version patch|minor|major --no-git-tag-version` (แก้บั๊ก = patch, ฟีเจอร์ = minor, เปลี่ยนโครงสร้าง/ข้อมูล = major)
4. เพิ่มหัวข้อเวอร์ชันใหม่ด้านล่างนี้ (วันที่, สิ่งที่เปลี่ยน, migration, ชื่อไฟล์ backup)
5. commit แล้ว tag: `git tag -a v<เวอร์ชัน> -m "v<เวอร์ชัน>"` ; ผู้ใช้ push: `git push origin uat:main; git push origin uat; git push origin --tags`
6. deploy: `npm run build:cf` → `npx wrangler pages deploy dist --project-name prpo-pdqc --branch main --commit-dirty=true` แล้วจด deployment id ไว้ในหัวข้อเวอร์ชัน
7. ย้อนเวอร์ชัน: Cloudflare Pages → Deployments → Rollback (โค้ด) + `npx wrangler d1 execute prpo-db --remote --file=<backup.sql>` หลังล้างตาราง (ข้อมูล) — ทำเฉพาะเมื่อผู้ใช้สั่ง

---

## v1.0.0 — 2026-10-16 (ปล่อยใช้งานจริง)
- **Production:** https://prpo-pdqc.pages.dev (branch main, D1 `prpo-db`, R2 `prpo-files`) ; **Preview:** https://preview.prpo-pdqc.pages.dev (D1 `prpo-db-preview`, R2 `prpo-files-preview`)
- **ฐานข้อมูล:** migrations 0001–0017 ; ล้างข้อมูลทดสอบก่อนปล่อย (backup `prpo-backups/prpo-db-20261015-pre-reset.sql`) เหลือ admin 1 บัญชี + แผนก PD/QC + สถานที่เก็บ/หน่วยนับ
- **ย้ายจาก Google Apps Script + Sheets มา Cloudflare Pages Functions + D1 + R2** (903ee19): รหัสผ่านเก็บเป็น PBKDF2 hash เท่านั้น, token 8 ชม., RBAC/scope ฝั่ง server, audit log + แจ้งเตือนสร้างโดย server, งบประมาณแบบ ledger, ไฟล์แนบบน R2 ผ่าน `/api/files/:id` (ต้อง login)
- **แก้จาก smoke test 2026-10-14 (S1–S8)** (f2abd9a): ปรับสต็อก/รับเข้า Manual ผ่าน server, แอดมินจัดสรรงบได้, cascade สถานะ PO→PR, กระดิ่งแจ้งเตือน, รูปสินค้าขึ้น R2, ฟอร์ม PR ล้างหลังส่ง, GRN audit/IN_NG
- **แก้จากผู้ทดสอบ TC-001–TC-011** (09b6eb9 … ed73e1f): สร้าง/แก้แผนก, ไฟล์ R2 ไม่ถูกตีความเป็น Google Drive, lightbox ผ่าน proxy, ลายเซ็นผู้ขอซื้อใน PDF = ผู้ขอซื้อจริง, เบิกจ่ายด่วนใช้ต้นทุนเฉลี่ย, สายเคลม (จัดซื้อเอง/ออนไลน์) เดินต่อได้ถึงปิดงาน, แจ้งเตือนมากับ bootstrap, badge กระดิ่ง = ยังไม่อ่าน, admin เห็นปุ่มจัดการเคส, ผู้แจ้งเคลมนับเป็นเจ้าของเคลม, รับของรอบ 2 ไม่ติด 403, เปิด PR เลือกแผนกที่ดูแลได้หลายแผนก
- **กฎธุรกิจที่ผู้ใช้ตัดสิน:** ปิด PO ที่เคลมยังค้าง (CLAIM_REPORTED/CLAIM_IN_PROGRESS/CLAIM_PENDING/PARTIALLY_RECEIVED_IN_CLAIM) ได้เฉพาะเจ้าของ PR หรือผู้แจ้งเคลม, ผู้อนุมัติ (level ≥ 3), admin และจัดซื้อออนไลน์ (เคลมออนไลน์) ; WAITING_DELIVERY_ROUND_2 ไม่นับเป็นเคลมค้าง
- **เทสต์:** vitest 2248 ตัว 121 ไฟล์ ผ่าน
- **ค้าง (ไม่กระทบการใช้งาน):** TC-010 รอทดสอบซ้ำบน preview ; PR ยังเก็บ requesterId เป็น roleId (ตัดสินเจ้าของจากชื่อ) ; bootstrap ถูกเรียกซ้ำต่อการกระทำ ; ดู docs/whiteboard.md หมวด ⏳
