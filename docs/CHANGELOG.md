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

## v1.1.0 — 2026-10-17 (Phase 3 ส่วนที่ 1: หมายเหตุสินค้า + role "พี่สุ")
- **backup ก่อน deploy:** `prpo-backups/prpo-db-20261017-v1.0.0.sql` ; **migration:** ไม่มี (สถานะ/role ใหม่เป็นค่าข้อความในคอลัมน์เดิม ฟิลด์พี่สุอยู่ใน extraJson)
- **FR-02 หมายเหตุสินค้า:** กล่อง "สเปก/หมายเหตุ" ใต้ชื่อสินค้าในหน้าสร้าง PR, รายละเอียด PR, การ์ดงานจัดซื้อออนไลน์ (ทั้งโหมดแก้ไข/อ่าน) และรายละเอียด PO ; PR ใหม่คัดลอก `productRemark` ลงรายการ PR เก่าดึงจาก master ด้วย productId
- **FR-01 role ใหม่ `BUFFER` "ผู้ตรวจสอบจัดซื้อ (พี่สุ)":** เลือกได้ในหน้า Admin (บังคับ level 2 แผนก ALL) ; flow PR ใหม่ `SUBMITTED → PENDING_BUFFER ("รอพี่สุตรวจสอบ") → REVIEWED → APPROVED` — ถ้าไม่มีบัญชี BUFFER ที่ ACTIVE ระบบข้ามขั้นไป REVIEWED เอง (ระบบเดิมไม่สะดุด) ; พี่สุเห็น PR/PO/สต๊อก/งบทุกแผนก (อ่าน) แก้ได้เฉพาะ จำนวน/ราคา/ลิงก์ ของ PR ที่ PENDING_BUFFER + คอมเมนต์ถึงผู้อนุมัติ + ปุ่มเดียว "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ" ; ไม่มีปุ่มตีกลับ/ยกเลิก/อนุมัติ/จัดสรรงบ/แก้ master ; Reviewer/Approver/Admin ตีกลับ-ยกเลิก PR ที่ค้างที่พี่สุได้ ; timeline บันทึก "ผู้ตรวจสอบจัดซื้อส่งต่อผู้อนุมัติ" พร้อมค่าก่อน→หลัง ; แจ้งเตือน PR_PENDING_BUFFER → พี่สุ และส่งต่อ → ผู้อนุมัติ ; PDF ไม่เปลี่ยน
- **ความปลอดภัย (ผลตรวจ kla 3 รอบ):** สิทธิ์เขียนของ BUFFER จำกัดที่ PR ขั้นตัวเอง/สร้าง PR/อ่านแจ้งเตือน/อัปโหลด ที่เหลือ 403 ; เส้นทางเขียน PR ทุก role: `items` ต้องเป็น array ของ object, ยอดต้องเป็นตัวเลข, server คำนวณยอดรวม+financials เองทุกครั้งที่เนื้อหาเปลี่ยน (ต่างเกิน 0.01 → 400) พร้อมขอบเขตส่วนลด/VAT/ค่าส่ง, ลิงก์/ส่วนลด/financials ล็อกตั้งแต่ PENDING_BUFFER, key การเงินบนสุดไม่หลุดเข้า extraJson, roleId normalize + level clamp
- **ผลข้างเคียงที่ตั้งใจ:** POST PR ที่ไม่ส่ง reason ไม่ลบ reason เดิมอีก ; PR ที่ไม่มี financials เดิมไม่ถูกสร้าง financials ให้ ; admin แก้ PR เดิมไม่ถูกบังคับยอด
- **เทสต์:** vitest 2802 ผ่าน (133 ไฟล์) ; เทสต์ใหม่ 12 ไฟล์ (buffer_*, cf_buffer_*, cf_qa_buffer, cf_pr_write_hardening, pr_product_remark, qa_*) ; เอกสาร parity.md c.5 / plan.md / tasks.md M10
- **ค้าง:** v1.2.0 การ์ดงานออนไลน์ (FR-03), v1.3.0 ขยายฟอนต์ (FR-04) ; ช่อง ONLINE ยังรับยอดแบบ subtotal (สูงกว่าจริงได้ ไม่ต่ำกว่า) ; ทุกคนในแผนกแก้/ยกเลิก DRAFT ของคนอื่นได้ (ของเดิมก่อน M10)

## v1.0.0 — 2026-10-16 (ปล่อยใช้งานจริง)
- **Production:** https://prpo-pdqc.pages.dev (branch main, D1 `prpo-db`, R2 `prpo-files`) ; **Preview:** https://preview.prpo-pdqc.pages.dev (D1 `prpo-db-preview`, R2 `prpo-files-preview`)
- **ฐานข้อมูล:** migrations 0001–0017 ; ล้างข้อมูลทดสอบก่อนปล่อย (backup `prpo-backups/prpo-db-20261015-pre-reset.sql`) เหลือ admin 1 บัญชี + แผนก PD/QC + สถานที่เก็บ/หน่วยนับ
- **ย้ายจาก Google Apps Script + Sheets มา Cloudflare Pages Functions + D1 + R2** (903ee19): รหัสผ่านเก็บเป็น PBKDF2 hash เท่านั้น, token 8 ชม., RBAC/scope ฝั่ง server, audit log + แจ้งเตือนสร้างโดย server, งบประมาณแบบ ledger, ไฟล์แนบบน R2 ผ่าน `/api/files/:id` (ต้อง login)
- **แก้จาก smoke test 2026-10-14 (S1–S8)** (f2abd9a): ปรับสต็อก/รับเข้า Manual ผ่าน server, แอดมินจัดสรรงบได้, cascade สถานะ PO→PR, กระดิ่งแจ้งเตือน, รูปสินค้าขึ้น R2, ฟอร์ม PR ล้างหลังส่ง, GRN audit/IN_NG
- **แก้จากผู้ทดสอบ TC-001–TC-011** (09b6eb9 … ed73e1f): สร้าง/แก้แผนก, ไฟล์ R2 ไม่ถูกตีความเป็น Google Drive, lightbox ผ่าน proxy, ลายเซ็นผู้ขอซื้อใน PDF = ผู้ขอซื้อจริง, เบิกจ่ายด่วนใช้ต้นทุนเฉลี่ย, สายเคลม (จัดซื้อเอง/ออนไลน์) เดินต่อได้ถึงปิดงาน, แจ้งเตือนมากับ bootstrap, badge กระดิ่ง = ยังไม่อ่าน, admin เห็นปุ่มจัดการเคส, ผู้แจ้งเคลมนับเป็นเจ้าของเคลม, รับของรอบ 2 ไม่ติด 403, เปิด PR เลือกแผนกที่ดูแลได้หลายแผนก
- **กฎธุรกิจที่ผู้ใช้ตัดสิน:** ปิด PO ที่เคลมยังค้าง (CLAIM_REPORTED/CLAIM_IN_PROGRESS/CLAIM_PENDING/PARTIALLY_RECEIVED_IN_CLAIM) ได้เฉพาะเจ้าของ PR หรือผู้แจ้งเคลม, ผู้อนุมัติ (level ≥ 3), admin และจัดซื้อออนไลน์ (เคลมออนไลน์) ; WAITING_DELIVERY_ROUND_2 ไม่นับเป็นเคลมค้าง
- **เทสต์:** vitest 2248 ตัว 121 ไฟล์ ผ่าน
- **ค้าง (ไม่กระทบการใช้งาน):** TC-010 รอทดสอบซ้ำบน preview ; PR ยังเก็บ requesterId เป็น roleId (ตัดสินเจ้าของจากชื่อ) ; bootstrap ถูกเรียกซ้ำต่อการกระทำ ; ดู docs/whiteboard.md หมวด ⏳
