# คู่มือ Deploy ระบบ PRPO ขึ้น Cloudflare (Pages + D1) ทีละขั้น

> **ขั้นตอนแบบก๊อปรันทีละขั้น (M2) ดูที่ [`docs/M2_RUNBOOK.md`](M2_RUNBOOK.md)**
>
> เอกสารนี้สำหรับผู้ใช้ทำเองทีละขั้น ทุกคำสั่งอ้างอิง `package.json`, `wrangler.toml`, `.dev.vars.example`, `migrations/` และ `scripts/import-sheets-to-d1.js`
> ค่าที่เป็นความลับหรือ ID จริงไม่ได้ใส่ไว้ในเอกสาร ใช้ `<YOUR_...>` แทนทุกครั้ง
>
> **หมายเหตุสถานะการทดสอบ:** คำสั่งที่มีข้อความ `(ยังไม่ทดสอบ)` ทีมยังไม่ได้รันจริงกับ wrangler บัญชี Cloudflare ของผู้ใช้ ให้ตรวจผลลัพธ์ทุกครั้งก่อนไปขั้นถัดไป
> ส่วนที่ทีมรันผ่านแล้ว: `npm run build:cf`, `npm test`, และ `wrangler d1 migrations apply prpo-db --local` (migrations 0001-0006)
>
> **Source of truth ของ migrations = `migrations/` ที่ root** (`wrangler.toml` มี `migrations_dir = "migrations"` และ deploy จาก root) ; **ไม่มี `cloudflare/migrations/` อีกต่อไป** — `prepare-cloudflare.js` เลิกคัดลอก migrations และ `cloudflare/wrangler.toml` ชี้ `migrations_dir = "../migrations"` ; `tests/migrations_sync.test.js` ตรวจว่า `cloudflare/migrations` ไม่มี/ว่าง และสคริปต์ไม่สร้างกลับ

---

## Checklist ลำดับเดียวสำหรับขึ้นระบบจริง

> ทำตามลำดับ (1)→(6) ห้ามข้าม ขั้นที่ไม่ได้ทดสอบมีป้าย **(ยังไม่ทดสอบ)** ทีมยังไม่ได้รันคำสั่งเหล่านี้กับ Cloudflare/Google/GAS จริง
> ทุกคำสั่งที่แตะ remote รันโดยผู้ใช้เอง ทีมไม่รัน `wrangler deploy`, `wrangler d1 ... --remote`, `clasp push/deploy` หรือ `git push`
> ห้ามใส่ค่า secret จริงลงเอกสารหรือไฟล์ใน repo ; ไฟล์ backup ต้องเก็บนอก repo เสมอ

**(1) เปิด R2 + ตรวจ binding + ตั้ง secrets** (ที่เก็บไฟล์ = Cloudflare R2 ; สถาปัตยกรรม : `docs/requirements-file-storage.md`)
- เปิด R2 ใน Dashboard แล้ว ; bucket `prpo-files` (production) และ `prpo-files-preview` (preview) สร้างโดยผู้ใช้แล้ว ; **ห้ามเปิด Public access / r2.dev** (ไฟล์อ่านผ่าน proxy `/api/files/:id` ที่ต้อง login เท่านั้น)
- ตรวจ `wrangler.toml` : `[[r2_buckets]] binding = "FILES"` (production) + `[[env.preview.r2_buckets]]` (preview ชี้ `prpo-files-preview`) + `FILE_STORAGE = "r2"` ใน `[vars]` และ `[env.preview.vars]` (ตั้งไว้แล้ว)
- ตั้ง secrets (ยังไม่ทดสอบ):
  - `AUTH_TOKEN_SECRET` — **คนละค่า** ระหว่าง Production และ Preview, ยาวอย่างน้อย 32 ตัวอักษร
  - R2 **ไม่ต้องมี secret เพิ่ม** ; `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `DRIVE_ROOT_FOLDER_ID` ใช้เฉพาะเมื่อสลับเป็น `FILE_STORAGE = "drive"` ภายหลังเมื่อมี Google Workspace + Shared Drive (ข้อ 2.4-2.5 และหัวข้อท้ายของ `docs/M2_RUNBOOK.md`)
- ไฟล์ Google Drive เก่า (ถ้ามี) : ปิด **anyone-with-link** ที่โฟลเดอร์รากตามหัวข้อ "หลัง cutover : ปิด anyone-with-link ของไฟล์เก่า" ด้านล่าง (ใช้กับ `storage='drive'` เท่านั้น ; ไฟล์ R2 เป็นส่วนตัวเสมอ)

**(2) สร้าง D1 preview แล้วใส่ id ใน `[env.preview]`**
- `npx wrangler d1 create prpo-db-preview` (ยังไม่ทดสอบ) — ได้ `database_id` แล้วแทน `<PREVIEW_DATABASE_ID>` ในบล็อก `[[env.preview.d1_databases]]` ของ `wrangler.toml`
- apply migrations ให้ฐาน preview: `npx wrangler d1 migrations apply prpo-db-preview --remote` (ยังไม่ทดสอบ) — ข้อมูลจริงห้ามใส่ฐาน preview

**(3) Backup D1 production ก่อน แล้ว apply migrations 0001-0015 remote** (0015 = ดัชนี `audit_logs(performedBy, action, createdAtMs)` สำหรับ rate limit ปรับยอด/รับเข้า Manual ไม่มี DROP ; 0013 = `attachments.storage/objectKey/migratedFrom` + ดัชนี `idx_attachments_storage` สำหรับไฟล์ R2/Drive ปนกัน ไม่มี DROP ; ต้อง apply ก่อน deploy โค้ดอัปโหลด ; 0012 = ดัชนี `login_attempts` ; 0010 = `tokenVersion` + ล้างคอลัมน์ pin ; ต้อง apply ก่อน deploy โค้ดที่เช็ค `tv` ; 0011 = ดัชนี `file_refs` + `attachments.docGone` ; 0014 = ดัชนี `audit_logs.timestamp` + ตาราง `notification_reads`)
- Backup (ยังไม่ทดสอบ) — เก็บไฟล์**นอก repo** เช่น `<PATH_OUTSIDE_REPO>\backup-<วันที่>.sql` (ห้ามใช้ path สัมพัทธ์ เพราะจะเขียนลง repo):
  ```powershell
  npx wrangler d1 export prpo-db --remote --output=<PATH_OUTSIDE_REPO>\backup-<วันที่>.sql
  ```
- ตรวจไฟล์ backup มีขนาดมากกว่า 0 และเปิดอ่านได้ก่อนไปขั้นถัดไป (ยังไม่ทดสอบ)
- Apply migrations (ยังไม่ทดสอบ):
  ```powershell
  npx wrangler d1 migrations apply prpo-db --remote
  ```
- ต้องผ่าน local ครบ 0001-0015 ก่อน (ข้อ 1.2)

**(4) ย้ายข้อมูลจาก Google Sheets (D1 ต้องว่าง)**
- ทำตามหัวข้อ 5 (export CSV → `scripts/import-sheets-to-d1.js` → ทดสอบ local → remote) ; ทดสอบ local ก่อนเสมอ (ยังไม่ทดสอบ)
- ลบไฟล์ CSV และไฟล์ `.import.sql` ทีละไฟล์ด้วย path เต็มหลังตรวจเสร็จ (ข้อ 5.6)

**(5) Smoke test (ยังไม่ทดสอบ)**
- `GET /api/health` **ไม่ส่ง token** → ต้องได้ **401** (200 = หยุดใช้งานทันที)
- Login ด้วยบัญชีจริงที่ผ่านการตั้งรหัสแล้ว
- สร้าง PR ทดสอบ 1 ใบ (ใช้ข้อมูลทดสอบ ไม่ใช่ข้อมูลจริง) แล้วตรวจว่าบันทึกใน D1 ได้
- อัปโหลดไฟล์แนบทดสอบ 1 ไฟล์ (`POST /api/upload`) แล้วตรวจว่า `attachments` มีแถว `storage='r2'` + `objectKey` และเปิดไฟล์ผ่าน `/api/files/:id` ได้ (เจ้าของ 200 / ผู้ใช้แผนกอื่น 404 / ไม่ login 401)
- ลบ PR ทดสอบ/ไฟล์ทดสอบที่สร้างขึ้นเอง (ถ้าทำได้) โดยไม่ลบข้อมูลจริง

**(6) ตัดระบบ GAS**
- ห้ามปล่อยค้าง: ต้องปิด web app เดิมหรือ `clasp push` ตัวแก้ทันทีหลังเปลี่ยนผู้ใช้ไป Cloudflare (ยังไม่ทดสอบ — ผู้ใช้รันเอง)
- ก่อนปิด: จดค่า deployment ID / version ของ web app เดิมไว้ (สำหรับ rollback)
- **ล้างรหัส plaintext ในชีต: ⏳ ต้องถามทีม/ผู้ใช้ก่อนทำทุกครั้ง** (ยังไม่ได้ตัดสินใจ)
- ย้าย `cloudflare/src` → `archive/cloudflare-src-2026-10-12/src` (ผู้ใช้ทำเอง ตามคำสั่งใน `archive/README.md`) ; ระหว่างนี้ห้าม build จาก `cloudflare/`
- ย้ายโฟลเดอร์ `backend-gas/` ไป archive ภายหลัง (ต้องถามผู้ใช้ก่อน)

### Rollback (ยังไม่ทดสอบทั้งหมด)

- **กู้ข้อมูล D1 จาก backup** (ทำบนฐานที่ว่างเท่านั้น ไม่ใช่ฐานที่มีข้อมูลแล้ว): `npx wrangler d1 execute prpo-db --remote --file=<PATH_OUTSIDE_REPO>\backup-<วันที่>.sql` (ยังไม่ทดสอบ) — ถ้าฐานไม่ว่าง คำสั่งจะชน PRIMARY KEY และล้มเหลว ไม่ทับข้อมูล
- **สลับผู้ใช้กลับไปใช้ GAS ชั่วคราว**: เปิด web app เดิมด้วย deployment/version ที่จดไว้ในขั้น (6) แล้วแจ้งผู้ใช้ให้ใช้ URL เดิม (ยังไม่ทดสอบ) ; ข้อมูลที่บันทึกใน D1 ระหว่างใช้งานจริงจะไม่ไปอยู่ใน GAS โดยอัตโนมัติ ต้องจดหรือย้ายเอง
- ทุกครั้งที่ rollback ให้แจ้งทีมและผู้ใช้ก่อนลงมือ

---

## 0. ข้อกำหนดเบื้องต้น

- Node.js 22 ขึ้นไป (มี `npm` และ `npx` ; wrangler 4.149 ต้องการ >=22 และเทสต์ import ใช้ `node:sqlite`)
- ติดตั้งแพ็กเกจของโปรเจกต์ที่ root: `npm install` (wrangler อยู่ใน devDependencies แล้ว ใช้ผ่าน `npx wrangler`)
- บัญชี Cloudflare ที่มีสิทธิ์สร้าง D1 และ Pages
- ล็อกอิน wrangler: `npx wrangler login` (ยังไม่ทดสอบ)
- โฟลเดอร์ Google Drive สำหรับโปรเจกต์นี้ (โฟลเดอร์ใหม่ เฉพาะโปรเจกต์ ไม่ปนกับระบบเดิม) เก็บ ID ไว้: `<YOUR_DRIVE_FOLDER_ID>`
- ทุกคำสั่งรันที่ **โฟลเดอร์ root ของโปรเจกต์** (`C:\Users\Admin\Desktop\PRPO`) เท่านั้น

---

## 1. Dev ในเครื่อง

### 1.1 สร้างไฟล์ `.dev.vars` ที่ root

คัดลอก `.dev.vars.example` เป็น `.dev.vars` (ไฟล์นี้อยู่ใน `.gitignore` ห้าม commit)

```powershell
Copy-Item .dev.vars.example .dev.vars
```

แก้ค่า `AUTH_TOKEN_SECRET` ในไฟล์ `.dev.vars` เป็นค่าสุ่มยาวอย่างน้อย 32 ตัวอักษร (สั้นกว่านี้หรือค่า `REPLACE_ME` ทำให้ API ตอบ 500 ทุกเส้น)
ตัวอย่างสร้างค่าสุ่ม (ต้องมี openssl ในเครื่อง ยังไม่ทดสอบบนเครื่องนี้):

```powershell
openssl rand -base64 48
```

- `ALLOW_DEV_SEED` และ `DEV_SEED_PASSWORD` ใช้เฉพาะ dev เท่านั้น ห้ามตั้งค่าใน production
- **CORS (`ALLOWED_ORIGINS`)**: รายการ origin ที่เรียก `/api` ข้ามโดเมนได้ คั่นด้วย comma (ตรงตัวเท่านั้น เช่น `https://prpo.example.com`) — origin ตรง = ตอบ `Access-Control-Allow-Origin: <origin นั้น>` + `Vary: Origin` ; ไม่ตรง = ไม่ใส่ header ; `*` ถูกเมิน ; preflight (`OPTIONS`) ใช้กฎเดียวกัน
  - **ไม่ตั้ง = same-origin เท่านั้น** (ไม่ใส่ ACAO) ซึ่งพอสำหรับ Pages ที่เสิร์ฟ frontend และ `/api` ใต้โดเมนเดียวกัน (`build:cf` เรียก `/api/...` แบบ relative อยู่แล้ว)
  - ข้อยกเว้น dev: ถ้าไม่ตั้ง `ALLOWED_ORIGINS` แต่ `ALLOW_DEV_SEED=true` หรือ `ENVIRONMENT=dev` จะอนุญาต `http://localhost:5173` (vite) และ `http://localhost:8788` (wrangler pages dev) เท่านั้น — production ห้ามตั้งสองค่านี้
  - ตั้งใน Pages: Settings → Environment variables (`ALLOWED_ORIGINS` ไม่ใช่ความลับ ใส่ใน `[vars]` ของ `wrangler.toml` ได้)
- ตรวจว่าไม่มีค่าจริงถูก commit: `git status` ต้องไม่เห็น `.dev.vars`

### 1.2 Apply migrations กับ D1 local

```powershell
npx wrangler d1 migrations apply prpo-db --local
```

- ใช้ชื่อฐานข้อมูล `prpo-db` ตาม `wrangler.toml` (`binding = "DB"`, `migrations_dir = "migrations"`)
- ต้อง apply ครบ `0001` ถึง `0006` ก่อนล็อกอินได้ ถ้าไม่ครบ login จะล้มเหลว (500)
- ทีมรันคำสั่งนี้ผ่านแล้ว (apply 2 รอบ)

### 1.3 Build frontend สำหรับ Cloudflare

```powershell
npm run build:cf
```

- คำสั่งนี้เรียก `vite build --mode cloudflare` และให้ผลลัพธ์ในโฟลเดอร์ `dist/`
- ทีมรันผ่านแล้ว

### 1.4 รัน Pages dev server (ยังไม่ทดสอบ)

```powershell
npx wrangler pages dev dist
```

- Pages dev จะอ่าน D1 binding `DB` จาก `wrangler.toml` และอ่าน `.dev.vars` จาก root
- ถ้า binding ไม่ขึ้น ให้ตรวจว่า `wrangler.toml` ยังมีบล็อก `[[d1_databases]]` และรัน migrations ใน 1.2 แล้ว
- ถ้าต้องระบุ binding เอง ให้ดูเอกสาร wrangler (ยังไม่ทดสอบ)

---

## 2. Production

> ขั้นตอนในหัวข้อนี้ **ผู้ใช้รันเองทั้งหมด** ทีมไม่ได้รันคำสั่งที่แตะ remote

### 2.1 สร้างฐานข้อมูล D1 (ครั้งเดียว)

ถ้ายังไม่มีฐานข้อมูล `prpo-db` ใน Cloudflare ให้สร้างก่อน (ยังไม่ทดสอบ)

```powershell
npx wrangler d1 create prpo-db
```

- คำสั่งจะแสดง `database_id` ให้นำไปใส่ในช่อง `database_id` ของบล็อก `[[d1_databases]]` ใน `wrangler.toml`
- ถ้า D1 ถูกสร้างแล้ว ใช้ค่า `database_id` ที่มีอยู่แทน (ค่า `database_id` ไม่ใช่ความลับ แต่ตรวจให้ตรงบัญชีที่จะ deploy)

### 2.2 Apply migrations กับ D1 remote (ผู้ใช้รันเอง)

```powershell
npx wrangler d1 migrations apply prpo-db --remote
```

- รันเฉพาะหลังตรวจแล้วว่า migrations 0001-0015 ผ่าน local (ข้อ 1.2)
- ห้ามรัน `d1_schema.sql` ใด ๆ (ดูหัวข้อ 4)

### 2.3 ตั้ง secret `AUTH_TOKEN_SECRET` (ยังไม่ทดสอบ)

```powershell
npx wrangler pages secret put AUTH_TOKEN_SECRET --project-name <YOUR_PAGES_PROJECT_NAME>
```

- wrangler จะถามค่าแบบซ่อนตัวอักษร ใส่ค่าสุ่มเดียวกับหลักการในข้อ 1.1 (ยาวอย่างน้อย 32 ตัวอักษร)
- ห้ามใส่ค่าจริงลงไฟล์ใด ๆ ในโปรเจกต์
- ชื่อ Pages project ตรวจได้จาก `name` ใน `wrangler.toml` (ปัจจุบันเป็น `prpo-pdqc`) และต้องตรงกับโปรเจกต์ที่สร้างใน Cloudflare Dashboard

### 2.4 ตั้งค่า `DRIVE_ROOT_FOLDER_ID` (เฉพาะ `FILE_STORAGE = "drive"` -- ตอนนี้ใช้ R2 ข้ามได้)

> ปัจจุบัน `wrangler.toml` มีบล็อก `[vars]` แล้ว (`FILE_STORAGE = "r2"`) ; ถ้าสลับเป็น Drive ให้เพิ่ม `DRIVE_ROOT_FOLDER_ID` ในบล็อก `[vars]` เดิม (และ `[env.preview.vars]`) ไม่ต้องสร้างบล็อกใหม่

เพิ่มบล็อกนี้ใน `wrangler.toml` (รูปแบบเดียวกับ `wrangler.toml.example`) แล้วใส่ ID ของโฟลเดอร์ Drive ที่เตรียมไว้:

```toml
[vars]
DRIVE_ROOT_FOLDER_ID = "<YOUR_DRIVE_FOLDER_ID>"
```

- ตอนนี้ `wrangler.toml` ของ root ยังไม่มีบล็อก `[vars]` ต้องเพิ่มเอง
- ค่า `DRIVE_ROOT_FOLDER_ID` ใช้โดย `functions/_lib/drive.js` (ดูข้อ 2.5)

### 2.5 Google Drive Service Account (ภายหลังเมื่อมี Google Workspace -- ตอนนี้ไม่ต้องทำ)

> ที่เก็บไฟล์ปัจจุบัน = R2 (`FILE_STORAGE = "r2"`). ส่วนนี้ใช้เมื่อสลับเป็น `FILE_STORAGE = "drive"` ; โค้ด `drive.js` ยังอยู่ครบและเลือกด้วยตัวแปรเดียว ; ไฟล์ R2 เดิมเปิดได้ต่อเพราะอ่านตามคอลัมน์ `attachments.storage` ของแต่ละแถว ; ย้ายไฟล์เก่า R2 -> Drive : `scripts/migrate-files.js` (ตอนนี้ `--dry-run` อ่านอย่างเดียวเท่านั้น)

ไลบรารี: `functions/_lib/drive.js` (WebCrypto + fetch ไม่มีแพ็กเกจเพิ่ม) ; การต่อเข้า route อัปโหลดทำในขั้นถัดไป
ห้าม commit key ของ Service Account ลงโปรเจกต์เด็ดขาด

**ข้อสำคัญ: Service Account ไม่มีโควตาพื้นที่เก็บข้อมูล (storage quota)** — ถ้าโฟลเดอร์ปลายทางอยู่ใน My Drive ของผู้ใช้ การอัปโหลดจะล้มเหลวด้วย "Service Accounts do not have storage quota" แม้แชร์เป็น Editor แล้ว ดังนั้นโฟลเดอร์ปลายทางต้องอยู่ใน **Shared Drive** และเพิ่ม SA เป็นสมาชิกของ Shared Drive นั้น (ตรวจให้แน่ใจว่าโฟลเดอร์ `<DRIVE_ROOT_FOLDER_ID>` (ยืนยัน id โฟลเดอร์กับผู้ใช้ตอนย้ายไป Google Drive ; ค่าที่ผู้ใช้แชร์ล่าสุด 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN) อยู่ใน Shared Drive ; ถ้ายังอยู่ใน My Drive ให้สร้างโฟลเดอร์ใหม่ใน Shared Drive แล้วใช้ ID ใหม่เป็น `DRIVE_ROOT_FOLDER_ID`) lib ใช้ `supportsAllDrives=true` อยู่แล้ว

1. สร้าง **Shared Drive** (Google Drive → Shared drives → New) สำหรับโปรเจกต์นี้ แล้วสร้างโฟลเดอร์รากข้างใน (ต้องใช้บัญชี Google Workspace ที่มีสิทธิ์สร้าง Shared Drive)
2. Google Cloud Console → สร้าง project แยกเฉพาะโปรเจกต์นี้ → IAM → Service Accounts → Create **SA เฉพาะโปรเจกต์นี้** ไม่ให้ IAM role ระดับ project ใด ๆ และ **ไม่เปิด domain-wide delegation**
3. APIs & Services → Library → เปิด **Google Drive API**
4. Service account → Keys → Add key → JSON (ดาวน์โหลดเก็บนอกโปรเจกต์ ห้ามอยู่ในโฟลเดอร์ repo) ; สร้าง key เท่าที่จำเป็น (1 อัน) และพิจารณาเปิด Organization Policy จำกัดการสร้าง key (`iam.disableServiceAccountKeyCreation`) หลังสร้างเสร็จ ; **หมุน key เป็นระยะ** (สร้างใหม่ → ตั้ง secret ใหม่ → ลบ key เก่า) และทันทีที่สงสัยว่ารั่ว
5. ใน Shared Drive: Manage members → เพิ่มอีเมล SA (`client_email`) เป็น **Content manager** (หรือสิทธิ์ที่เขียนได้) ; ถ้าแชร์เฉพาะโฟลเดอร์ ให้แน่ใจว่าโฟลเดอร์อยู่ใน Shared Drive
6. โฟลเดอร์ราก **ต้องไม่เปิด anyone-with-link** — และตั้งแต่ 2026-10-13 โค้ด**ไม่ตั้ง anyone-with-link ให้ไฟล์ใดอีก** (`drive.js` uploadFile คืน `sharedPublic:false` เสมอ, ไม่เรียก permissions API) ; ไฟล์เปิดได้เฉพาะผ่าน proxy ที่ต้อง login
7. ตั้งค่า (รันจาก root):
   ```powershell
   npx wrangler pages secret put GOOGLE_SA_CLIENT_EMAIL --project-name <YOUR_PAGES_PROJECT_NAME>
   npx wrangler pages secret put GOOGLE_SA_PRIVATE_KEY --project-name <YOUR_PAGES_PROJECT_NAME>
   ```
   - `GOOGLE_SA_CLIENT_EMAIL` = ค่า `client_email` ใน JSON ; `GOOGLE_SA_PRIVATE_KEY` = ค่า `private_key` (PEM PKCS8, วางทั้งก้อนหรือแบบมี `\n` ก็ได้)
   - `DRIVE_ROOT_FOLDER_ID` = id โฟลเดอร์รากใน Shared Drive (ข้อ 1) ใน `[vars]` (ข้อ 2.4) — ไม่ใช่ความลับ
   - ตั้งทั้ง Production และ Preview ; ทดสอบ local ใส่ใน `.dev.vars` (ดู `.dev.vars.example`)
8. ลบไฟล์ JSON key ในเครื่องหลังตั้ง secret เสร็จ (หรือเก็บในที่ปลอดภัยนอก repo)

รายละเอียดที่ควรรู้:
- OAuth scope ที่ใช้คือ `https://www.googleapis.com/auth/drive` (ไม่ใช้ `drive.file`) เพราะ `drive.file` เข้าถึงได้เฉพาะไฟล์ที่แอปสร้างเอง แต่โฟลเดอร์ราก "ถูกแชร์ให้" SA จึงจะ list/สร้างลูกไม่ได้ ; SA เห็นเฉพาะสิ่งที่ถูกแชร์ให้ จึงจำกัดอยู่ที่โฟลเดอร์นี้
- โครงโฟลเดอร์: `01_PR_Attachments|02_PO_Documents/{YYYY-MM}` และ `03_GRN_Evidence|04_Claim_Evidence/{YYYY-MM}/{PO_NUMBER}` (ตรงระบบเดิม)
- ข้อจำกัดไฟล์ตรงระบบเดิม: ไม่เกิน 20 MB ; ชนิด pdf, jpeg/png/webp/gif, xls/xlsx, doc/docx
- ไฟล์ **ไม่** ตั้งสิทธิ์ anyone-with-link (เปลี่ยนจากระบบเดิมตามที่ผู้ใช้ตัดสิน 2026-10-13) ; URL ที่คืน (`viewUrl`, `downloadUrl`, `directUrl`, `lh3Url`) ยังคืนรูปแบบเดิมเพื่อเก็บ fileId แต่เปิดตรงจากเบราว์เซอร์ไม่ได้ — หน้าเว็บโหมด Cloudflare แสดง/เปิด/ดาวน์โหลดผ่าน `/api/files/:id` ทุกจุด (`ProxiedImg`, `AttachmentThumbnail`, `AttachmentViewerModal`, `ImageLightboxModal`, `FileUploader` (ร่างเก่า), `PRCreateView`, `PRDetailsModal`, `PODetailsModal`, `OnlineOrderCard`) ; PDF ที่สร้างเอง (`generatePoPdf`) และ `PrintablePO` ฝังเฉพาะโลโก้/ลายเซ็น base64 ไม่ได้ดึงรูปจาก Drive จึงไม่ต้องผ่าน proxy ; ช่อง "ลิงก์หลักฐานโอนเงิน" (`settlementProofUrl`) เป็นลิงก์ที่ผู้ใช้พิมพ์เอง ไม่ใช่ไฟล์ที่อัปโหลด
- เปิดไฟล์ผ่าน proxy ไม่สำเร็จ : 401/403/429/5xx → แจ้งผู้ใช้ด้วย modal เดิม ไม่ fallback ไป Drive ; **ข้อจำกัด** : 404 server ตอบเหมือนกันทั้ง "ไม่ใช่ไฟล์โปรเจกต์" และ "ไม่มีสิทธิ์เห็น" (กันเดาว่าไฟล์มีอยู่) จึง fallback ลิงก์ Drive เดิมคงไว้ (ไฟล์ legacy) ; ไฟล์ใหม่ที่ผู้ใช้ไม่มีสิทธิ์จะไปเจอหน้าขอสิทธิ์ของ Google ; ไฟล์ที่ไม่ใช่รูป/PDF บันทึกด้วยชื่อเดิมแทนเปิดแท็บ
- ไฟล์ Word/Excel ที่เปิดดูในหน้าไม่ได้ (ไม่ใช่รูป/PDF) จะแสดงปุ่ม "เปิดไฟล์" ที่ดาวน์โหลดผ่าน proxy แทน Drive preview
- ถ้า secret ไม่ครบ ฟังก์ชันจะ throw `DRIVE_NOT_CONFIGURED` (ไม่ log key)

#### ที่เก็บไฟล์ : R2 (ค่าเริ่มต้น) / Drive (สลับได้) -- `functions/_lib/storage/`
- `getStorage(env)` เลือก backend ของไฟล์ **ใหม่** ตาม `env.FILE_STORAGE` (`r2` = ค่าเริ่มต้น | `drive`) ; `getStorageFor(row)` เลือกตามคอลัมน์ `attachments.storage` ของแถวนั้น (อ่าน/ลบ/กู้ ไม่ใช้ env) ; ค่า `FILE_STORAGE` ที่ไม่รู้จัก = ไม่พร้อมใช้งาน (503 ไม่ fallback เงียบ)
- R2 : binding `FILES` ; key `<category>/<YYYY>/<MM>/<docRef|_unassigned>/<fileId>__<ชื่อที่ sanitize แล้ว>` สร้างบน server เท่านั้น (ไม่รับ key จาก client) ; `fileId` = uuid ; ไม่มี binding -> 503 ข้อความชัด ; ไฟล์ส่วนตัวเสมอ (`makePrivate` = no-op `ALWAYS_PRIVATE`) ; ถังขยะ = prefix `trash/` ในบักเก็ตเดียวกัน (ไม่ลบถาวรอัตโนมัติ ; ตั้ง lifecycle ลบต้องถามผู้ใช้)
- client เก็บ `fileId` (uuid) + `url = /api/files/<fileId>` ; หน้าเว็บ (`ProxiedImg` / `useProxiedFileUrl` / `openProxiedFile`) อ่าน `fileId` หรือ id ใน path `/api/files/` แล้วเรียก proxy พร้อม Bearer เหมือนไฟล์ Drive (UX เดิม) ; `users.pictureUrl` **ไม่รับ** path นี้ (ใช้ `<img src>` ตรงที่ไม่มี token และยังไม่มีการอัปโหลดรูปโปรไฟล์ ; ถ้าเพิ่มภายหลังต้องใช้ ProxiedImg + ตรวจ id)
- local/e2e : `wrangler pages dev --r2 FILES` (เก็บใน `--persist-to`) ; e2e เคส 11 ใน `e2e/cf/flow.spec.js` อัปโหลด PNG จริงลง R2 local -> เปิดผ่าน `/api/files/:id`

#### `POST /api/upload` (functions/_lib/upload.js)
- ต้อง login (Bearer) ; body JSON `{ base64Data, mimeType, fileName, category, poNumber|docRef, docNo, docType }` (รูปแบบเดียวกับที่ `driveService.js` ส่ง) ; ต้อง apply migration 0007 และ 0009 ก่อน
- ตรวจ `Content-Length` ก่อนอ่าน body: ไม่มีหรือเกิน ~27.4 MB (20 MB x 1.37 + overhead) → 413 ; ความยาว base64 ตรวจก่อน decode
- สิทธิ์ตามเอกสาร: GRN/CLAIM/PO ต้องมี PO จริงใน D1 และ `canAccessDepartment` ; PR ที่มีเลข → ต้องมี PR จริงและแผนกเข้าถึงได้ ; PR ที่ยังไม่มีเลข (แนบตอนสร้าง) → เฉพาะแผนกของผู้ใช้ ไม่มีเลขในชื่อโฟลเดอร์ ; GRN บน PO ที่ CANCELLED → 409
- Rate limit: (1) นับ "คำขอ" ทุกครั้งรวมที่ถูกปฏิเสธ 120 ครั้ง/ชม./ผู้ใช้ ในตาราง `upload_attempts` (migration 0009) **ก่อนอ่าน body** → 429 ; ถ้าตัวนับใช้ไม่ได้จะตอบ 503 (fail closed) (2) ไฟล์ที่อัปโหลดสำเร็จ 60 ไฟล์/ชม./ผู้ใช้ และ 40 ไฟล์/เอกสาร → 429 (นับจาก `attachments`)
- PR ที่มีเลข: แนบไฟล์ได้เฉพาะตอนเนื้อหา PR ยังแก้ได้ (`canEditPrContent`: DRAFT, หรือขั้นตรวจทานโดย level 2+, admin เสมอ) ; client ปัจจุบันไม่ส่งเลข PR ตอนแนบ (แนบตอนสร้าง/แก้ฉบับร่าง)
- บันทึก `attachments`: fileId, uploaderId, docRef, category, mime, size, createdAtMs + URL ; ถ้าบันทึก D1 ไม่ได้ จะย้ายไฟล์ลงถังขยะใน Drive
- error ผ่าน `publicError`: 400/413/415 ข้อความเดิม, Drive/auth/config → 502/503 ข้อความทั่วไป ; ไม่ log body/token

#### `GET /api/files/:id` (functions/_lib/files.js) — proxy ดาวน์โหลดไฟล์ที่ต้อง login (P5 เฟส 2)
- **ต้อง apply migration ถึง 0013** (0013 = คอลัมน์ `storage/objectKey/migratedFrom` ; แถวเดิมเป็น `storage='drive'` ; ส่วน R2 : `:id` เป็น uuid และ `head/open` อ่านจาก bucket ตาม `objectKey` ของแถว ไม่ใช่ Drive ; ข้อความด้านล่างที่พูดถึง Drive ใช้กับแถว `storage='drive'`) (`0011_file_refs.sql` : ตารางดัชนี `file_refs(fileId, docTable, docId, docNo)` + คอลัมน์ `attachments.docGone` ; ไม่มี DROP) ก่อน deploy โค้ดนี้ — ใช้ `attachments` + `upload_attempts` เดิมด้วย ; ไม่แตะสิทธิ์ไฟล์ใน Drive (anyone-with-link ของไฟล์เดิมยังเปิดได้ ; การปิดเป็นเรื่องที่ต้อง ask ผู้ใช้ภายหลัง)
- `:id` = Drive file id ; เสิร์ฟเฉพาะไฟล์ที่อยู่ในตาราง `attachments` (= server อัปโหลดเอง อยู่ในโฟลเดอร์โปรเจกต์) และ Drive ยืนยันว่า `parents` มี `folderId` ที่บันทึกไว้, ไม่อยู่ในถังขยะ, ไม่เกิน 20 MB — นอกนั้น 404
- สิทธิ์: ผู้ใช้ต้อง "เห็นเอกสารเจ้าของไฟล์" ด้วยกฎอ่านเดียวกับ list endpoint (`scope.canSeeDocument`) — เอกสารที่ `attachments.docRef/poNumber/docNo` ชี้, หรือ PR/PO/PR line item ที่เก็บ fileId ไว้ใน JSON, หรือผู้อัปโหลดเอง (เฉพาะแถวที่ยังไม่ผูกเอกสาร) ; ไม่เห็น/ไม่พบ/ไม่ใช่ไฟล์โปรเจกต์ → 404 ข้อความเดียวกัน (กัน IDOR)
- ตอบแบบ stream จาก Drive (`alt=media`) ไม่ buffer ; `Content-Type` จาก allow-list ของ upload (ใช้ชนิดที่ server บันทึก ไม่ใช่ที่ Drive บอก ; นอก allow-list → `application/octet-stream` + attachment) ; `X-Content-Type-Options: nosniff` ; `Content-Disposition` inline เฉพาะรูป/PDF (ต่อท้าย `?download=1` เพื่อบังคับ attachment) ชื่อไฟล์ sanitize + `filename*` RFC 5987 ; `Cache-Control: private, max-age=300` ; `Content-Security-Policy: default-src 'none'; sandbox`
- Rate limit: 1500 คำขอ/ชม./ผู้ใช้ (ตัวนับ `dl:<userId>` ในตาราง `upload_attempts`, นับก่อนค้นสิทธิ์, ตัวนับใช้ไม่ได้ → 503) → 429
- token: ใช้ `Authorization: Bearer` เหมือน API อื่น (ไม่ใส่ token ใน query string) ; ฝั่งหน้าเว็บโหมด Cloudflare เรียกผ่าน `backendFetch` แล้วทำเป็น `blob:` URL (`src/utils/cfAttachments.js` : `useProxiedFileUrl` / `openProxiedFile`) ใช้ใน `AttachmentThumbnail`, `ImageLightboxModal`, `AttachmentViewerModal`, ปุ่มดาวน์โหลดใน `OnlineOrderCard` ; ถ้า proxy ตอบ 404 (ลิงก์ Drive เก่าที่ไม่ใช่ไฟล์โปรเจกต์) จะใช้ URL เดิมต่อ ; โหมด GAS/mock ไม่เปลี่ยน
- แถว `attachments` ที่ผูกเอกสาร (docRef/poNumber/docNo) → ใช้เอกสารนั้นตัดสินอย่างเดียว ; การค้นใน JSON เป็น fallback เฉพาะแถวที่ยังไม่ผูกเอกสาร (`functions/_lib/filerefs.js`) : `instr()` ใช้คัดแถวผู้สมัครเท่านั้น (แบ่งหน้าด้วย rowid) แล้ว parse JSON นับเฉพาะ id ที่อยู่ "ตำแหน่งไฟล์จริง" (array แนบ / ฟิลด์ URL ไฟล์ ตามกฎ `sanitize.fileIdsIn`) — id ที่พิมพ์ในข้อความอิสระ (note, คำอธิบาย) ไม่ให้สิทธิ์ ; กฎเดียวกันใช้ฝั่งเขียน (`sanitize.fileIdAllowed`) และฝั่งอ่าน (`mayUseDoc` = `canSeeDocument` หรือ `canAccessDepartment`)
- **ตำแหน่งไฟล์เดียวกันทั้งเขียนและอ่าน (รอบ 2):** `sanitize.fileRefOf` / `fileIdsIn` เป็นนิยามเดียวของ "ฟิลด์นี้ชี้ไฟล์ Drive" (id ใน URL Drive หรือ id เปล่า ที่ไม่ใช่ placeholder) — ฝั่งเขียนตรวจทุกตำแหน่งที่ฝั่งอ่านนับ (attachment object, array แนบ, ฟิลด์ไฟล์เดี่ยวเช่น `imageUrl`/`photo`/`claimPhoto`/`settlementProofUrl`/`proofUrl`) ด้วย `allowedFileIds` ; ไม่ผ่าน = ฟิลด์นั้นถูกตัดเป็น `''`
- **ดัชนี `file_refs`:** สร้างใหม่ให้เอกสารทุกครั้งที่บันทึก PR/PO (และ route รับของ/ปิด PO) — handler แต่ละตัวจดรหัส PR/PO ที่ "เขียนจริงในคำขอนี้" ลง `state.touched` แล้ว `onRequest` เรียก `reindexTouched` เฉพาะเอกสารเหล่านั้น (สูงสุด 200 id ต่อเอกสาร ; ไม่มีการสแกน `updatedAt` ย้อนหลังอีกแล้ว) และผูก `docRef` ให้ PR ที่ผู้ใช้บันทึกในคำขอนั้นเท่านั้น ; อ่านด้วย index ก่อน และตรวจเอกสารซ้ำทุกครั้ง (แถวเก่าค้างไม่ให้สิทธิ์) ; เอกสารเดิมที่ยังไม่อยู่ใน index ใช้ fallback `instr()` ที่จำกัด (สูงสุด 150 แถว/ตาราง, ครั้งเดียว/นาที/ไฟล์/isolate) แล้วเขียนเข้า index เอง (self-heal) ; เอกสารที่นำเข้าด้วย `scripts/import-sheets-to-d1.js` ถูกเติม `file_refs` ให้ตั้งแต่ตอน import (`--no-file-refs` เพื่อปิด ; ต้องมี migration 0011)
- **โควตา fallback ฝั่งเขียน (`sanitize.js`):** การสแกนตารางตอนตรวจ fileId ในเนื้อหาที่บันทึก จำกัด ≤5 id ต่อคำขอ และ ≤20 ครั้ง/นาที/ผู้ใช้ (ตัวนับ `fs:<userId>` ในตาราง `upload_attempts` หน้าต่าง 1 นาที — ใช้ร่วมกันทุก isolate ; ตัวนับใช้ไม่ได้ = ไม่สแกน) ; **ไม่ตัดเงียบเพราะโควตา/DB error (รอบแก้หลังกล้าตรวจ):** (ก) id ที่เอกสารเดิมที่กำลังบันทึก "ถืออยู่แล้ว" (หาจากเลข/รหัสใน body + `:id` ของ URL แล้วต้องเป็นเอกสารที่ผู้ใช้ใช้ได้ `mayUseDoc`) ถือว่าอนุญาตทันทีโดยไม่สแกนและไม่นับโควตา — บันทึกซ้ำ PR ที่มีไฟล์ legacy/ยังไม่ index จึงไม่ทำไฟล์หาย (ข) id ใหม่ที่ตรวจแล้ว "ไม่ได้รับอนุญาต" ยังถูกตัดเป็น `''` เหมือนเดิม (ค) id ใหม่ที่ตรวจไม่ได้เพราะเกินโควตา → ตอบ **429** / เพราะตัวนับหรือ DB พัง → ตอบ **503** และไม่เขียนอะไรเลย ; backfill ดัชนีให้ข้อมูลเดิมด้วย `scripts/backfill-file-refs.js` (ดูท้ายหัวข้อนี้) ; ปกติไฟล์ที่เพิ่งอัปโหลดผ่าน `/api/upload` หรือ PR/PO ที่อยู่ใน index ไม่ใช้ fallback เลย
- **กฎสิทธิ์เดียวกันอ่าน/เขียน:** `filerefs.attachmentRowAccess` (PR จับด้วย `prNumber`, PO ด้วย `poNumber` ก่อน `id`, แถว `docGone` ข้าม) ; PO ใหม่ห้ามใช้ `id` ที่ตรงกับ `prs.prNumber` (409) ; PR ที่ถูกลบแล้วแต่ PO ที่สร้างจาก PR นั้นยังถือไฟล์ (`prAttachments`) และอ้างเลข PR เดิม ผู้ที่ใช้ PO นั้นได้ยังเปิดไฟล์ได้ (ไม่เปิดช่องอื่น)
- **ผูกไฟล์กับ PR:** บันทึก PR แล้ว แถว `attachments` ที่ `docRef` ว่างและผู้อัปโหลด = ผู้บันทึก และ PR นั้นถือไฟล์จริง จะถูก UPDATE `docRef/docNo` = เลข PR ; PR จับคู่ด้วยเลข PR เท่านั้น ; ลบ PR → ลบแถว index และตั้ง `attachments.docGone = 1` (ไฟล์ใน Drive ไม่ถูกลบ) ; ไฟล์ของ PR ที่ PO ซึ่งอ้าง PR นั้น (prNumber/prId) ถืออยู่ (prAttachments) เปิดได้โดยผู้ที่ใช้ PO นั้นได้
- Rate limit เพิ่ม: เพดานไบต์ 2 GB/ชม./ผู้ใช้ (key `dlb:<userId>` นับจากขนาดใน metadata ของ Drive) และลบแถวตัวนับเก่าเมื่อเริ่ม window ใหม่
- blob: cache ต่อ session ล้างเมื่อ logout / session หมดอายุ / token เปลี่ยน (key ใช้ hash ของ token ไม่ใช่ token ดิบ) และดาวน์โหลดที่เสร็จหลังล้าง cache จะไม่ถูกเก็บ
- **ปิด anyone-with-link แล้ว (ผู้ใช้ตัดสิน 2026-10-13):** (1) ไฟล์ใหม่ไม่ถูกตั้ง `type:anyone` อีก (`sharedPublic = 0` ใน `attachments`) (2) ไฟล์เก่าใช้ `POST /api/admin/unshare-public` ดูหัวข้อถัดไป
- หน่วยความจำ/CPU (ประเมิน ยังไม่ได้วัดบน Workers จริง): ไฟล์ 20 MB → JSON base64 ~27 MB (ตัวอักษร 1 ไบต์) ; ช่วง decode ถือ สตริง base64 ~27 MB + ไบต์ไฟล์ 20 MB + บัฟเฟอร์ที่ `request.json()` อ่าน ~27 MB (ถ้ายังไม่ถูก GC) ≈ **~75 MB สูงสุด** ; หลัง decode ลบ `base64Data` ออกจาก body และ multipart ใช้ `Blob([head, bytes, tail])` ไม่สร้างสำเนา Uint8Array ก้อนที่สี่ ; ต่ำกว่าเพดาน 128 MB แต่หลายคำขอพร้อมกันใน isolate เดียวกันจะบวกกัน → ถ้าพบ error memory ให้ลดเพดานไฟล์ (`MAX_FILE_SIZE_BYTES` ใน drive.js) ; CPU: decode + เซ็น JWT (cache ไว้ ~1 ชม.) + ส่งต่อ Google หลักสิบ ms สำหรับไฟล์ใหญ่ → แผน Free (CPU 10 ms/คำขอ) ไม่พอสำหรับไฟล์ใหญ่ ควรใช้แผน Paid ; client บีบรูปเหลือ ~150 KB อยู่แล้วจึงปกติเบามาก
- เพดานขนาด JSON ของการเขียนทั่วไป (ตรวจ `Content-Length` ก่อนอ่าน body): เอกสาร (`/api/prs`, `/api/pos`, receive, products, stock-logs, budget-transactions) 4 MB, อื่น ๆ 2 MB → 413 (D1 จำกัด 1 แถว 2 MB อยู่แล้ว ; PR ที่มีรูปบีบ ≤150 KB หลายรูปยังผ่าน)
- ช่อง URL ไฟล์/ลิงก์ในการเขียน PR/PO/receive/settle ถูก sanitize ที่ server (`functions/_lib/sanitize.js`): ช่องไฟล์รับเฉพาะ `https://drive.google.com|docs.google.com|lh3.googleusercontent.com/...`, `data:image/(png|jpeg|webp|gif);base64` (และ `data:application/pdf` ของเก่า) ≤400k ตัวอักษร, รหัสไฟล์เปล่า/ค่า placeholder เก่า (`STORED_IN_DRIVE`) ; ค่าอื่นถูกตัดเป็นค่าว่างโดยไม่ error, scheme อันตราย (`javascript:`, `vbscript:`, `file:`, `data:` ชนิดอื่น) → 400 ; ลิงก์ร้านค้า (`onlineUrl`, `productUrl`, `onlineLink`, `link`, `itemUrl`, `url` นอกไฟล์แนบ) ต้องเป็น http(s) หรือไม่มี scheme ; `fileId` ที่ไม่อยู่ใน `attachments` และไม่เคยอยู่ใน PR/PO ที่บันทึกไว้ จะถูกล้าง URL ของไฟล์นั้น ; โครงสร้างซ้อนลึกเกิน 12 ชั้น → 400/413
- T2.3: `POST/PUT /api/prs`, `POST/PUT /api/pos`, `POST /api/pos/:id/receive` ปฏิเสธ (413) ฟิลด์ใดก็ตามที่เป็น `data:` URL ยาวเกิน 400,000 ตัวอักษร (~300 KB) ; รูปเล็กที่ client บีบแล้วยังฝังได้ตามเดิม

#### หลัง cutover : ปิด anyone-with-link ของไฟล์เก่า — `POST /api/admin/unshare-public` (functions/_lib/unshare.js)
- admin เท่านั้น (rule `admin-unshare-public`) ; **dry-run เป็นค่าเริ่มต้น** — ลงมือจริงต้องส่ง `{"dryRun": false}` (boolean เท่านั้น) ; ไม่ต้องมี migration ใหม่ (ใช้คอลัมน์ `attachments.sharedPublic` จาก 0007)
- รายการที่ถูกพิจารณา = แถว `attachments` ที่ server อัปโหลดเอง (`folderId` มีค่า), `sharedPublic = 1` (ทุกค่า `docGone` รวมไฟล์ของเอกสารที่ลบ/ไฟล์ที่ cleanup ย้ายถังขยะ) ; ไฟล์ที่ข้ามถาวร (`NOT_IN_DRIVE`, `NOT_IN_UPLOAD_FOLDER`) ถูกตั้ง `sharedPublic = -1` ไม่ดึงซ้ำ ส่วน `DRIVE_ERROR`/`STILL_PUBLIC` ลองใหม่รอบหน้า (อ่าน permissions ครบทุกหน้า และตรวจซ้ำหลังลบ) ; ไฟล์ของระบบ GAS เดิม (ไม่อยู่ใน `attachments` / ไม่มี `folderId`) ไม่ถูกแตะ ; ลงมือจริงจะตรวจ metadata ใน Drive ว่า `parents` ยังมี `folderId` ของโปรเจกต์ (ไม่ตรง = ข้าม `NOT_IN_UPLOAD_FOLDER`) แล้วลบเฉพาะ permission `type:"anyone"` (ไม่แตะ user/group/domain) และตั้ง `sharedPublic = 0`
- จำกัดต่อคำขอ 20 ไฟล์ (`limit` ลดได้) ; ตอบ `truncated:true` ถ้ายังเหลือ ให้เรียกซ้ำจนว่าง ; audit `UNSHARE_PUBLIC_DRYRUN` / `UNSHARE_PUBLIC` ระบุรายการไฟล์ (fileId, attachmentId, fileName, reason)
- ขั้นตอนหลัง cutover (ผู้ใช้ทำเอง) :
  1. ตรวจว่าหน้าเว็บ Cloudflare เปิดรูป/ไฟล์ได้ผ่าน proxy ปกติ
  2. login เป็น admin แล้วเรียก dry-run : `POST /api/admin/unshare-public` ด้วย body `{}` → ดู `candidates` ว่าเป็นไฟล์ของโปรเจกต์ทั้งหมด (dry-run ไม่เรียก Drive)
  3. ลงมือ : body `{"dryRun": false}` ทีละรอบ จน `candidateCount` เป็น 0 (ดู `skipped[]` ถ้ามี : `NOT_IN_DRIVE`, `NOT_IN_UPLOAD_FOLDER`, `DRIVE_ERROR`)
  4. ปิด anyone-with-link ของ **โฟลเดอร์ราก** ใน Drive ด้วยมือ (ทีมไม่แตะ) แล้วทดลองเปิดลิงก์ไฟล์เก่าในหน้าต่าง incognito ต้องเปิดไม่ได้
- ไม่เคยเรียก Drive จริงในการทดสอบ (เทสต์ใช้ mock `fetch`)

#### `POST /api/admin/cleanup-orphans` (functions/_lib/orphans.js) — ไฟล์กำพร้าใน Drive (P6)
- admin เท่านั้น (rule `admin-cleanup-orphans`) ; **dry-run เป็นค่าเริ่มต้น** — ลงมือจริงต้องส่ง `{"dryRun": false}` (ค่า boolean เท่านั้น) ; ไม่ต้องใช้ migration เพิ่ม (ใช้ `attachments.docGone` จาก 0011 : 2 = ย้ายถังขยะแล้ว)
- "กำพร้า" = แถว `attachments` ที่ server อัปโหลดเอง (`folderId` มีค่า) อายุเกิน `olderThanHours` (ค่าเริ่มต้นและขั้นต่ำ 24 ชม.) และ `docRef/poNumber/docNo` ว่างทั้งหมด และไม่มีแถว `file_refs` และไม่มี PR/PO/รายการ PR ใดถือ id นั้นในตำแหน่งไฟล์ (สแกนตารางจริงด้วย `fileHeldByAnyDoc` ; ถ้าสแกนไม่จบ/DB error = ถือว่ามีเอกสารถืออยู่ ไม่ใช่กำพร้า)
- dry-run ไม่เรียก Drive เลย ตอบรายการ (`orphans[]` : attachmentId, fileId, fileName, category, ageHours) ; ลงมือจริง = ตรวจ metadata (ต้องยังอยู่ในโฟลเดอร์ที่ server อัปโหลด) แล้ว **ย้ายไปถังขยะ Drive เท่านั้น (กู้คืนได้ ไม่ลบถาวร)** และตั้ง `docGone = 2` (ไม่แสดงรอบหน้า และเปิดผ่าน API ไม่ได้) ; ทำงานจำกัดต่อคำขอ (ตรวจไม่เกิน 25 ไฟล์, ย้ายไม่เกิน 20 ไฟล์, ดึงแถวผู้สมัคร 60 แถว — ตอบ `truncated: true` ถ้ายังเหลือ ให้เรียกซ้ำ) เพื่อไม่ชนเพดานจำนวน query/subrequest
- ลำดับตอนลงมือจริง (กัน race กับการบันทึกเอกสาร): (1) "จอง" แถวด้วย `UPDATE ... SET docGone = 2 WHERE fileId = ? AND docRef/poNumber/docNo ว่าง AND docGone = 0 RETURNING id` — ถ้าระหว่างนั้นมีการบันทึกที่ผูกไฟล์แล้ว จะจองไม่ได้ (`CHANGED`) และตั้งแต่จองแล้วฝั่งเขียนปฏิเสธ id นี้ (2) ตรวจซ้ำว่ามีเอกสารถือไหม (`HELD` → คืนแถว) (3) ตรวจ metadata แล้วย้ายถังขยะ ; ขั้นไหนพลาด (Drive error, ไม่อยู่ในโฟลเดอร์, ย้ายไม่สำเร็จ) = คืนแถว `docGone = 0` ยกเว้นไฟล์ที่ไม่มีใน Drive แล้ว
- audit: `ORPHAN_CLEANUP` / `ORPHAN_CLEANUP_DRYRUN` เก็บรายการ `{fileId, attachmentId, fileName}` ของไฟล์ที่ย้าย/ข้าม (+เหตุผล)
- **ทางกู้คืน:** `POST /api/admin/restore-orphan` body `{"fileId": "<id>"}` (admin เท่านั้น) — ใช้ได้เฉพาะแถวที่ cleanup ปิดไว้ (`docGone = 2`) และไฟล์ยังอยู่ในโฟลเดอร์อัปโหลด : เอาไฟล์ออกจากถังขยะ Drive แล้วตั้ง `docGone = 0` (audit `ORPHAN_RESTORE`) ; ถ้าไฟล์ถูกลบถาวรจากถังขยะ Drive ไปแล้ว (Drive ล้างถังขยะเองหลังประมาณ 30 วัน) จะกู้ไม่ได้ (404)
- ข้อควรระวัง: ผู้ใช้ที่เปิดฟอร์ม PR ค้างไว้เกิน 24 ชม. โดยยังไม่บันทึกอาจเสียไฟล์ที่แนบไว้ (กู้ด้วย restore ข้างบน) ; ควรรัน dry-run ดูรายการก่อนเสมอ ; ยังไม่เคยรันกับ Drive จริง (ทดสอบด้วย fetch จำลองเท่านั้น)

#### Backfill ดัชนี `file_refs` สำหรับ D1 ที่มีข้อมูลอยู่แล้ว (`scripts/backfill-file-refs.js`) (P6)
- ใช้เมื่อมี PR/PO อยู่ก่อนมีดัชนี (หรือ import มาโดยไม่เติม) — ไม่จำเป็นต่อความถูกต้อง (server สแกนแบบจำกัดแล้ว index เอง และเอกสารเดิมที่ถือไฟล์ไม่เสียไฟล์เวลาบันทึกซ้ำ) แต่ทำให้เร็วและแน่นอน
- สคริปต์ทำงานกับ **ไฟล์ sqlite บนเครื่องเท่านั้น** (ไม่เรียก wrangler ไม่แตะ remote) : `node scripts/backfill-file-refs.js --db <local.sqlite>` = รายงานอย่างเดียว ; `--out <ไฟล์.sql>` = เขียน `INSERT OR IGNORE` ; `--apply` = เขียนลงไฟล์ sqlite นั้น (ฐาน local เท่านั้น)
- local: ใช้ไฟล์ใน `.wrangler/state/v3/d1/...` ที่ได้จาก `wrangler d1 migrations apply prpo-db --local` / `wrangler pages dev --persist-to ...` (ต้องมี 0011)
- remote (**ผู้ใช้รันเอง**): (1) `wrangler d1 export prpo-db --remote --output=<ไฟล์นอก repo>.sql` (2) สร้าง sqlite local จาก export นั้น แล้วรัน `--db <local.sqlite> --out <backfill.sql>` (3) ตรวจ `backfill.sql` แล้ว `wrangler d1 execute prpo-db --remote --file=<backfill.sql>` — `INSERT OR IGNORE` รันซ้ำได้ ไม่ทับ/ลบอะไร

#### Security headers ของหน้าเว็บ (`public/_headers` → `dist/_headers`) (P6)
- ใช้กับไฟล์ static ของ Cloudflare Pages เท่านั้น (Functions/API ตั้ง header เอง) : `Content-Security-Policy`, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (ปิด camera/microphone/geolocation/payment/usb), และ cache `immutable` ให้ `/assets/*`
- ตรวจกับ build จริง (`npm run build:cf`) : `dist/index.html` มี script เป็น `<script type="module" src>` ภายนอก 1 ตัว (ไม่มี inline script) และ `<style>` inline 1 ก้อน (loading shell) + `style=""` ของ React → `style-src 'unsafe-inline'` ; Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`) ; รูปจาก `blob:` (ไฟล์ที่ proxy `/api/files/:id`), `data:`, `drive.google.com`, `lh3-lh6.googleusercontent.com` (ตรงกับโฮสต์ที่ `sanitize.js` ยอมรับ), `drive.usercontent.google.com` ; **ไม่มี CDN ภายนอกสำหรับสคริปต์/ฟอนต์ PDF แล้ว** — `generatePoPdf.js` ใช้ `import('pdf-lib')` / `import('@pdf-lib/fontkit')` จาก dependency ของโปรเจกต์ (แยกเป็น chunk โหลดตอนสร้าง PDF, same-origin) และฟอนต์ `/fonts/THSarabunNew*.ttf` จาก `public/fonts` (เฉพาะ build ของ GAS ที่ไม่มีโฟลเดอร์ fonts ยังใช้ CDN ซึ่งไม่ผ่าน `_headers`) ; `AuthContext` เรียก `api.ipify.org` ; iframe ดู PDF (blob:) และหน้า preview ของ Drive
- ถ้าเปลี่ยนจุดที่โหลดของภายนอกในโค้ด ต้องแก้ `_headers` ตาม (`tests/cf_p6_phase2.test.js` กลุ่ม "public/_headers" เช็คว่าไม่มี inline script ใหม่ใน `dist/index.html`, ไม่มี esm.sh/jsdelivr และโฮสต์ภายนอกที่ใช้อยู่ครบ)
- **ยังไม่ได้ทดสอบบน Cloudflare Pages จริง** — หลัง deploy Preview ให้เปิดทุกหน้าหลัก (ดูรูปแนบ, เปิด PDF, สร้าง PO PDF) โดยเปิด DevTools Console ดูว่าไม่มี "Refused to ..." ; ถ้ามี ให้เพิ่มโฮสต์นั้นในบรรทัด CSP

### 2.6 Build และ deploy (ยังไม่ทดสอบ)

รันจาก root เท่านั้น ห้ามรันจากโฟลเดอร์ `cloudflare/` (เป็นสำเนาเก่า ไม่ใช่ตัวหลัก)

```powershell
npm run build:cf
npx wrangler pages deploy dist --project-name <YOUR_PAGES_PROJECT_NAME>
```

- ก่อน deploy ต้องผ่านหัวข้อ 3 (checklist) ทุกข้อ
- ตรวจหลัง deploy ว่า Functions (`functions/`) ทำงานจริง (เช่น เรียก `/api/...` แล้วได้ 401 ไม่ใช่ 404 หรือ 500) เพราะการ deploy โฟลเดอร์ `dist` อย่างเดียวอาจไม่รวม Functions ตามที่คาด ให้ตรวจผลจริงก่อนเชื่อ

---

## 3. Checklist ก่อนขึ้นใช้งานจริง

- [ ] `npm test` ผ่าน (ข้อสังเกต: ณ วันที่ทีมตรวจ ยังมีเทสต์ 4 ข้อที่เกี่ยวกับความตรงกันของสำเนา `cloudflare/functions` กับ `functions/` ที่ยัง fail ต้องแก้ก่อนขึ้นจริง)
- [ ] `npm run build:cf` ผ่าน — **build ขึ้น production ด้วย `npm run build:cf` เท่านั้น** (ไม่ใช่ `npm run build`): คำว่า "build cloudflare" มีนิยามเดียวทั้งโปรเจกต์ = `--mode cloudflare` หรือ `VITE_BACKEND_MODE=cloudflare` (ใช้ทั้ง `vite.config.js` → ปิด source map, และ `authService.IS_CLOUDFLARE_BUILD` → ตัดบัญชี demo/ทางลัดรหัสออกจาก bundle) ; ตรวจ `dist/assets` ว่าไม่มีไฟล์ `.map` และไม่มีบัญชี demo (ไม่มีชื่อผู้ใช้เช่น `wichai.pd` คู่กับ `password`) ก่อน deploy — สตริง `password123`/`admin123` ที่ยังเหลือ 2-3 จุดเป็นข้อความ/รายการ "รหัสที่ห้ามใช้" ในฟอร์ม ไม่ใช่รหัสของบัญชีใด
- [ ] ผู้ใช้ใหม่: ไม่มีรหัสผ่านเริ่มต้นแล้ว — แอดมินต้องตั้งรหัสผ่านให้ผู้ใช้แต่ละคนเอง (อย่างน้อย 6 ตัว) ; server (`POST/PUT /api/users`) ปฏิเสธ `password123 / admin123 / 123456` (ไม่สนตัวพิมพ์) และรหัสสั้นกว่า 6 ตัวด้วย 400 "กรุณาตั้งรหัสผ่านใหม่ ห้ามใช้รหัสเริ่มต้น" ; ตอนแก้ไขผู้ใช้เว้นช่องรหัสว่างไว้ = ไม่เปลี่ยนรหัส
- [ ] migrations ทั้งหมด (0001-0015) ผ่าน local และพร้อม remote (0013 = `attachments.storage/objectKey/migratedFrom` สำหรับ R2/Drive, 0007 = คอลัมน์ attachments สำหรับ `/api/upload`, 0009 = ตัวนับคำขออัปโหลด, 0011 = ดัชนี `file_refs`, 0012 = ดัชนี `login_attempts` สำหรับล้างแถวเก่ากว่า 24 ชม. ; 0014 = ดัชนี `audit_logs.timestamp` + ตาราง `notification_reads` ; 0015 = ดัชนี `audit_logs(performedBy, action, createdAtMs)` สำหรับ rate limit ปรับปรุงสต็อก ; ไม่มี DROP)
- [x] **GitHub Pages job ปิดแล้ว (2026-10-13, ผู้ใช้ตัดสิน)** : job `build-and-deploy` ถูกเอาออกจาก `.github/workflows/deploy.yml` (เหลือ job `test` ที่รันทุก push) และ `GITHUB_PAGES_DEPLOYMENT.md` มีหมายเหตุเลิกใช้ด้านบน ; (ข้อเสนอ ไม่ได้ทำ: pin `actions/*` เป็น commit SHA — ไม่มีเน็ตยืนยัน SHA)
- [ ] `AUTH_TOKEN_SECRET` ค่า `e2e-local-secret-...` ใน `playwright.cf.config.js` เป็นค่าสาธารณะ : `hasSecret` ปฏิเสธเมื่อไม่ได้ตั้ง `ENVIRONMENT=dev` (e2e ตั้ง binding นี้เอง) — ห้ามใช้ค่านี้ใน production
- [ ] `public/_headers` (CSP ฯลฯ) อยู่ใน `dist/` หลัง `npm run build:cf` และเปิดแอปจริงบน Preview แล้วไม่มี CSP violation ใน Console (ดูหัวข้อ "Security headers" ด้านล่าง)
- [ ] `AUTH_TOKEN_SECRET` ตั้งใน Pages secret แล้ว ยาว **อย่างน้อย 32 ตัวอักษร** (โค้ด `hasSecret` ปฏิเสธสั้นกว่านี้และค่า `REPLACE_ME` — API ตอบ 500) และไม่ใช่ค่าเดิม ; ตั้งทั้ง Production **และ Preview** (คนละค่ากันยิ่งดี)
- [ ] `ALLOW_DEV_SEED` และ `DEV_SEED_PASSWORD` **ไม่ได้ตั้งใน production**
- [ ] **production/Preview ไม่ได้ตั้ง `ENVIRONMENT=dev`** (และไม่ตั้ง `ALLOW_DEV_SEED`) — `ENVIRONMENT=dev` เปิด CORS ของ localhost และทำให้ `hasSecret` ยอมรับ secret ตายตัวของ e2e (`e2e-local-secret-...`) ; ตรวจใน Settings → Environment variables ทั้ง Production และ Preview
- [ ] **ห้ามใส่ `ENVIRONMENT` / `ALLOW_DEV_SEED` / `DEV_SEED_PASSWORD` ใน `[vars]` ของ `wrangler.toml`** (ไฟล์ commit ได้ และ `[vars]` ใช้กับทุก environment รวม production) — ตั้งได้เฉพาะใน `.dev.vars` ของเครื่อง dev
- [ ] **Preview deployment**: ค่าเริ่มต้น Cloudflare Pages สร้าง Preview ทุก branch/PR และถ้า binding D1 เดียวกัน Preview จะอ่าน/เขียน **ฐาน production เดียวกัน** → `wrangler.toml` มีบล็อก `[[env.preview.d1_databases]]` (binding `DB` → `prpo-db-preview`, `database_id = "<PREVIEW_DATABASE_ID>"`) ไว้แล้ว: **ทำก่อน push branch ใดก็ตาม** — `npx wrangler d1 create prpo-db-preview` (ฐานใหม่ ไม่ใช่ production) → apply migrations ทั้งหมดให้ฐาน preview (ทดสอบ local ก่อน; ห้ามเอาข้อมูลจริงไปใส่) → แทน `<PREVIEW_DATABASE_ID>` ด้วย id ที่ได้ ; ระหว่างที่ยังเป็น placeholder Preview build จะล้มโดยตั้งใจ ไม่แอบใช้ฐาน production — **หรือ** ปิด Preview deployments ใน Settings → Builds & deployments ; ตรวจ Settings → Functions → D1 bindings ของ **Preview** ในแดชบอร์ดอีกครั้งว่าไม่ชี้ `prpo-db` (ตั้งค่าในแดชบอร์ดอาจทับ/ขัดกับไฟล์ ให้ดูว่าไฟล์เป็นแหล่งจริงของ binding) ; (หมายเหตุ: เพิ่ม `[env.preview]` ตามที่ Pages รองรับ — wrangler 4 รับ config นี้และ `wrangler pages dev` ทำงานได้ปกติ ผมยังไม่ได้เทียบกับเอกสารออนไลน์ เพราะเครื่องมือดึงเว็บไม่ได้รับอนุญาต ให้ผู้ deploy ยืนยันกับ Cloudflare docs “Pages › Functions › Wrangler configuration” ก่อนใช้จริง) ; ตรวจ Environment variables/secrets ของ Preview ให้ครบและไม่ใช้ค่า production ; พิจารณา Cloudflare Access ครอบโดเมน `*.pages.dev` ของ Preview เพื่อไม่ให้เข้าถึงสาธารณะ
- [ ] `DRIVE_ROOT_FOLDER_ID` ตั้งใน `wrangler.toml` แล้ว (ตรวจว่าเป็นโฟลเดอร์ใหม่ของโปรเจกต์นี้)
- [ ] ที่เก็บไฟล์ R2 พร้อม (bucket `prpo-files` / `prpo-files-preview` + binding `FILES` + `FILE_STORAGE = "r2"` ใน `wrangler.toml` ; route อัปโหลดต่อเข้าแล้ว) ; Drive Service Account (ข้อ 2.5) ภายหลังเมื่อมี Google Workspace เท่านั้น
- [x] RBAC ฝั่ง server ตามสิทธิ์/level ของระบบเดิม เสร็จแล้ว (T4.5 — `functions/_lib/rbac.js`, ตารางสิทธิ์ใน `docs/parity.md` หัวข้อ c.5) ; ก่อนขึ้นจริงตรวจ `allowedDepartments` ของผู้ใช้ผู้จัดการ/แอดมิน (ต้องเป็น `["*"]`/`ALL` ถ้าต้องข้ามแผนก — server ใช้กฎแผนกเดียวกับ client)
- [ ] Rate limit การล็อกอิน (T4.4) ผ่านการตรวจความปลอดภัยแล้ว
- [x] CORS ทำแล้ว (T1.8): allow-list จาก `ALLOWED_ORIGINS` (ดูหัวข้อ env ด้านบน) — ก่อนขึ้นจริง **ตั้ง `ALLOWED_ORIGINS`** เฉพาะเมื่อมีโดเมนอื่นเรียก `/api` ; ไม่ตั้ง = same-origin เท่านั้น (พอสำหรับ Pages โดเมนเดียว) ; ห้ามตั้ง `ENVIRONMENT=dev` / `ALLOW_DEV_SEED` ใน production
- [ ] ยังไม่มีการเผยแพร่ `sheets-export/`, `import/`, `*.import.sql`, `.dev.vars` ลง git
- [ ] ผ่าน kla-security ตรวจทั้งระบบ (T5.3)
- [ ] **นำเข้าตาราง `departments` ก่อนเปิดใช้งานจริง** — แผนกของสินค้าที่ server ตรวจ = `department || category` (ตรงกับที่ระบบเขียนและที่หน้า MasterData ตรวจ) — ตรวจ `category` เฉพาะเมื่อสินค้าไม่มี `department` เท่านั้น (ถ้ามี `department` แล้ว category เป็นแค่ป้าย) และกรณีนั้นเป็น fail closed: ผู้ใช้ที่ไม่เข้าถึงแผนก/ป้ายนั้นจะบันทึกสินค้านั้นไม่ได้ (403) ไม่ว่าตาราง `departments` จะว่างหรือไม่ ; ตารางแผนกที่ครบช่วยให้ `allowedDepartments` ของผู้ใช้ตรวจเทียบรหัสได้ถูกต้อง ; ตรวจความถูกต้องของรหัสแผนกกับ `allowedDepartments` ของผู้ใช้ด้วย
- [ ] **ตรวจหลัง deploy (checklist จาก kla T5.3)**
  - เรียก `GET /api/health` **โดยไม่ส่ง token** ต้องได้ **401** (ถ้าได้ 200 แปลว่า middleware auth ไม่ทำงาน — หยุดใช้งานทันที) ; `GET /api/bootstrap` ไม่ส่ง token ก็ต้อง 401
  - `AUTH_TOKEN_SECRET` ของ **Production และ Preview เป็นคนละค่า** (สุ่มยาว ≥ 32 ตัว แต่ละค่าสร้างใหม่ ไม่ copy กัน) — token ของ Preview ต้องใช้กับ Production ไม่ได้ (ทดสอบ: login ที่ Preview แล้วเอา token ไปเรียก Production ต้อง 401)
  - ไฟล์ export/นำเข้า (`sheets-export/*`, `import/*`, `*.import.sql`, ไฟล์ทดสอบที่มีข้อมูลจริง) ลบ **ทีละไฟล์ด้วย path เต็ม** หลังนำเข้าเสร็จ (ห้ามใช้ wildcard / `-Recurse`) และตรวจ `git status` ว่าไม่มีไฟล์เหล่านี้ถูกเพิ่มเข้า git
  - ตั้ง `allowedDepartments` ของผู้ใช้ทุกคนให้ถูกต้อง: ผู้ใช้ทั่วไป = แผนกของตัวเอง ; ผู้จัดการ/แอดมิน/ฝ่ายจัดซื้อออนไลน์ที่ต้องข้ามแผนก = `["*"]` ; ผู้ใช้ที่ `allowedDepartments` ว่างจะถูกจำกัดที่แผนกหลักตัวเองเท่านั้น
  - แอดมิน = `level >= 99` หรือ `roleId` ตรงตัว `ADMIN` เท่านั้น (ชื่อผู้ใช้ `admin` / ข้อความ title ไม่ทำให้เป็นแอดมิน) — ตรวจว่าแอดมินจริงของระบบเดิมมี roleId หรือ level ตามนี้ก่อน cutover

---

## 4. ข้อห้าม

- **`d1_schema.sql` เป็น DEPRECATED ห้ามใช้** ทั้งที่ root และในโฟลเดอร์ `cloudflare/` ใช้ `migrations/` เท่านั้น — ไฟล์นั้น **ไม่มีคอลัมน์ `users.tokenVersion`** (เพิ่มใน `migrations/0010_token_version.sql`) ฐานที่สร้างจาก `d1_schema.sql` จะ login/เปลี่ยนรหัสไม่ได้ถูกต้อง
- ห้าม deploy จากโฟลเดอร์ `cloudflare/` (สำเนาเก่า)
- ห้ามใส่ค่า secret, token, key หรือรหัสผ่านลงในไฟล์ที่ commit ได้
- ห้ามแก้หรือลบข้อมูลในโฟลเดอร์ `data/` (ข้อมูลระบบเดิม)

---

## 5. ย้ายข้อมูลจาก Google Sheets (ตอนตัดระบบ)

ขั้นตอนนี้ทำครั้งเดียวตอนตัดระบบเดิม และต้องทำกับ **D1 ที่ว่าง** (apply migrations ทั้งหมด 0001-0015 แล้ว ยังไม่มีข้อมูล ; ไฟล์ SQL เติมตาราง `file_refs` ด้วย จึงต้องมี 0011 — หรือสร้างด้วย `--no-file-refs`)

### 5.1 Export ชีตเป็น CSV

1. ใน Google Sheets ส่งออกแต่ละชีตเป็น CSV (File > Download > Comma-separated values)
2. ตั้งชื่อไฟล์ให้ตรงกับชื่อชีต เช่น `Users.csv`, `PRs.csv`, `POs.csv`, `PRItems.csv`, `Products.csv`, `StockLogs.csv` (รายชื่อชีตอยู่ในตัวแปร `SHEETS` ของ `scripts/import-sheets-to-d1.js`)
3. วางไฟล์ไว้ในโฟลเดอร์ `sheets-export/` ที่ root (โฟลเดอร์นี้อยู่ใน `.gitignore`)
4. ชีตที่ไม่มีไฟล์จะถูกข้าม ไม่ error

### 5.2 สร้างไฟล์ SQL

```powershell
node scripts/import-sheets-to-d1.js --in sheets-export
```

- ค่าเริ่มต้นของ `--out` คือ `import/d1-import.import.sql` (อยู่ใน `.gitignore`)
- ตัวเลือกอื่น: `--only Users,PRs` (เลือกบางชีต), `--force` (เขียนทับไฟล์ `--out` เดิม), `--force-change-password` (บังคับทุกคนเปลี่ยนรหัส)
- โหมดปกติ `INSERT` ธรรมดา: id หรือค่า UNIQUE ซ้ำจะล้มเหลว ไม่ทับข้อมูล ; แถว id ซ้ำในชีตเดียวกัน สคริปต์เก็บแถวแรกและข้ามแถวหลัง
- `--replace` ใช้ `INSERT OR REPLACE` ซึ่งทับแถวเดิมและลบแถวที่ชน UNIQUE เงียบ ๆ ใช้เฉพาะเมื่อรู้ผลแน่นอนเท่านั้น
- ไฟล์ `--out` ที่อยู่ใน repo ต้องลงท้ายด้วย `.import.sql` และห้ามอยู่ใน `data/`, `migrations/`, `functions/`, `src/`, `cloudflare/`
- ผลลัพธ์หน้าจอจะรายงานจำนวนแถวต่อชีต และจำนวนผู้ใช้ที่ hash รหัสได้ (ไม่แสดงรหัสผ่าน)

### 5.3 ทดสอบกับ D1 local (ยังไม่ทดสอบ)

```powershell
npx wrangler d1 execute prpo-db --local --file=import/d1-import.import.sql
```

- ตรวจจำนวนแถวและการล็อกอินบน local ก่อนทำ remote

### 5.4 รันกับ D1 remote (ผู้ใช้รันเอง, ยังไม่ทดสอบ)

```powershell
npx wrangler d1 execute prpo-db --remote --file=import/d1-import.import.sql
```

- รันได้เฉพาะเมื่อ D1 remote ว่างและ migrations 0001-0015 ผ่านแล้ว (ถ้ารันซ้ำ จะชน PRIMARY KEY และล้มเหลว ไม่ทับข้อมูล)

### 5.5 รหัสผ่านของผู้ใช้

- ผู้ใช้ที่รหัสว่าง, เป็นรหัส default ที่รู้จัก (`123456`, `password123`, `admin123`) หรือรหัสยาวเกินกำหนด จะไม่ถูก hash และถูกตั้ง `mustChangePassword = 1`
- **แอดมินต้องตั้งรหัสใหม่ให้ผู้ใช้กลุ่มนี้** ก่อนเข้าระบบได้
- สคริปต์ไม่เขียนรหัสผ่าน plaintext ลงไฟล์หรือ log

### 5.6 ลบไฟล์ที่มีข้อมูลบุคคลทิ้ง

หลังนำเข้าเสร็จและตรวจแล้ว ลบ **ทีละไฟล์ด้วย path เต็ม** (ห้ามใช้ wildcard):

- ไฟล์ CSV ทุกไฟล์ใน `sheets-export/`
- ไฟล์ `import/d1-import.import.sql` (หรือชื่อ `--out` ที่ใช้)

---

## 6. หมายเหตุอื่น

- สคริปต์ย้ายข้อมูลใช้ `functions/_lib/password.js` (PBKDF2) และรันด้วย Node 22+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม
- เอกสารนี้จะอัปเดตเมื่อ WS2 (Drive Service Account) และ T4.5 (RBAC) เสร็จ
