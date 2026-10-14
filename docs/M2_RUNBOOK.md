# M2 Runbook: ขึ้น Cloudflare ทีละขั้น (ผู้ใช้ก๊อปรันเอง)

> ทีมไม่รันคำสั่งใดในไฟล์นี้ ทุกคำสั่งรันโดยคุณใน **Windows PowerShell 5.1** ที่ root `C:\Users\Admin\Desktop\PRPO` ; รายละเอียดเชิงลึกดู `docs/DEPLOY_CLOUDFLARE.md`
> PowerShell 5.1 ไม่มี `&&` : รันทีละบรรทัด หรือใช้ `A; if ($?) { B }`
> `<...>` = ค่าที่คุณต้องแทนเอง ; ห้ามวางค่าลับลงไฟล์ใน repo ห้ามส่งในแชท
> ข้อมูลจริงจากโค้ด : Pages project = `prpo-pdqc` (`wrangler.toml` `name`), D1 = `prpo-db` (binding `DB`), `migrations_dir = "migrations"`, output = `dist`
> บัญชี Cloudflare ที่ต้องตรง : `bf8a6b6235d3b15616d8558762099275` ; ที่เก็บไฟล์ = R2 bucket `prpo-files` / `prpo-files-preview` (binding `FILES`, `FILE_STORAGE = "r2"`) ; Drive (`<DRIVE_ROOT_FOLDER_ID>` ; ยืนยัน id โฟลเดอร์กับผู้ใช้ตอนย้ายไป Google Drive ; ค่าที่ผู้ใช้แชร์ล่าสุด 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN) ใช้ภายหลังเมื่อมี Google Workspace เท่านั้น

ลำดับ : 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 ห้ามข้าม ถ้าขั้นไหนไม่ผ่าน หยุดและดูหัวข้อ "ถ้าพลาด" ของขั้นนั้น

---

## ขั้น 0 : เตรียมเครื่อง

**ทำไม** : wrangler 4 ต้องใช้ Node 22+ และต้องล็อกอินเป็นบัญชีที่ถูกต้องก่อนแตะ remote

```powershell
node --version
npm ci
npx wrangler login
npx wrangler whoami
```

**ตรวจว่าสำเร็จ** : `node --version` ขึ้น `v22.13` ขึ้นไป (ต้อง >= 22.13 เพราะขั้น backfill ใช้ `node:sqlite` ; ถ้าเป็น 22.5-22.12 ต้องเติม `--experimental-sqlite` หลังคำว่า `node`) ; `whoami` แสดง Account ID `bf8a6b6235d3b15616d8558762099275` (ถ้ามีหลายบัญชี ต้องมีบัญชีนี้)

**ถ้าพลาด** : Node ต่ำกว่า 22 -> ติดตั้ง Node 22 LTS แล้วเปิด PowerShell ใหม่ ; account ไม่ตรง -> `npx wrangler logout` แล้ว `npx wrangler login` ใหม่ด้วยบัญชีที่ถูก (อย่าไปขั้นถัดไป) ; `npm ci` พัง -> ตรวจว่า `package-lock.json` อยู่ครบ

---

## ขั้น 1 : เปิด R2 + ตรวจ binding + ตั้ง secret

**ทำไม** : ไฟล์แนบ (PR/PO/GRN/หลักฐานเคลม) เก็บใน Cloudflare R2 (private bucket, อ่านผ่าน `/api/files/:id` เท่านั้น) -- ใช้ได้กับบัญชี Gmail ส่วนตัว ไม่ต้องมี Google Workspace / Shared Drive / Service Account ; token ของ login เซ็นด้วย `AUTH_TOKEN_SECRET` ; รายละเอียดสถาปัตยกรรม : `docs/requirements-file-storage.md`

### 1.1 เปิด R2 และตรวจ bucket

1. Cloudflare Dashboard -> **R2 Object Storage** -> เปิดใช้งาน (ต้องเพิ่มวิธีชำระเงิน ใช้ส่วนฟรี 10 GB/เดือน ไม่ถูกเรียกเก็บ) -- **ทำแล้ว**
2. bucket `prpo-files` (production) และ `prpo-files-preview` (preview) **ผู้ใช้สร้างแล้ว** (ทีมไม่รัน `wrangler r2 ...`) ; ตรวจว่ามีครบ : Dashboard -> R2 -> Buckets เห็นสองชื่อนี้ ; **ห้ามเปิด Public access / r2.dev / custom domain** ของ bucket ทั้งสอง (ไฟล์ต้องเป็นส่วนตัวเสมอ)
3. ตรวจ binding ใน `wrangler.toml` (ตั้งไว้แล้ว ไม่ต้องแก้) :

```toml
[[r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files"

[[env.preview.r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files-preview"

[vars]
FILE_STORAGE = "r2"

[env.preview.vars]
FILE_STORAGE = "r2"
```

**ตรวจว่าสำเร็จ** : `git diff wrangler.toml` / เปิดไฟล์ เห็นบล็อกข้างบนครบ ; หลัง deploy (ขั้น 5) Dashboard -> `prpo-pdqc` -> Settings -> Bindings เห็น `FILES` -> R2 bucket ทั้ง Production และ Preview (Preview ต้องชี้ `prpo-files-preview` ไม่ใช่ `prpo-files`)

**ถ้าพลาด** : อัปโหลดแล้วได้ 503 "ระบบจัดเก็บไฟล์ยังไม่ได้ตั้งค่า" = ไม่มี binding `FILES` (deploy ใหม่หลังแก้ `wrangler.toml` หรือเพิ่ม binding ใน Dashboard) ; `FILE_STORAGE=drive` ต้องมี `GOOGLE_SA_*` (ดูหัวข้อ "ภายหลังเมื่อมี Google Workspace" ท้ายเอกสาร) -- ตอนนี้ **ไม่ต้องใช้**

**หมายเหตุ trash/ ใน R2** : ไฟล์กำพร้าที่ cleanup-orphans ย้ายออกจะอยู่ใต้ prefix `trash/` ใน bucket เดียวกัน **ไม่ถูกลบถาวรอัตโนมัติ** (ไม่มี job ล้าง) ; การตั้ง R2 lifecycle rule ลบ `trash/` เกิน 30 วัน **ต้องถามผู้ใช้ก่อนเสมอ** (ทีมไม่ตั้งเอง) ; กู้คืนด้วย `POST /api/admin/restore-orphan`

### 1.2 ตั้ง secret ของ Pages

**ข้อควรระวัง** : ห้าม screenshot / ห้ามเปิด `Start-Transcript` / ห้ามแชร์หน้าจอตอนมีค่า secret ; **ห้ามตั้ง `WRANGLER_LOG=debug` และ `WRANGLER_LOG_SANITIZE=false`** ขณะทำขั้นนี้ (ตรวจด้วย `Get-ChildItem Env:WRANGLER*`) ; ถ้า PowerShell แจ้ง ExecutionPolicy บล็อก `npx.ps1` : `Set-ExecutionPolicy -Scope Process RemoteSigned` หรือใช้ `npx.cmd` ; ปิดหน้าต่าง PowerShell ทิ้งหลังจบขั้นนี้

secret ที่โค้ดอ่านจริงสำหรับโหมด R2 : `AUTH_TOKEN_SECRET` (`functions/_lib/auth.js`) เท่านั้น ; `FILE_STORAGE` เป็นตัวแปรธรรมดาใน `wrangler.toml` ; `ALLOWED_ORIGINS` (`cors.js`, ไม่ลับ) **ไม่ต้องตั้ง** ถ้า frontend กับ `/api` อยู่โดเมนเดียวกันบน Pages
**โปรเจกต์ Pages `prpo-pdqc` ต้องมีใน Cloudflare อยู่แล้ว** (ถ้ายังไม่มี : `npx wrangler pages project create prpo-pdqc --production-branch main`)

ส่งค่าลับให้ wrangler ผ่าน **stdin (pipe)** ไม่ผ่าน clipboard : จากซอร์สของ wrangler 4.149 ที่ติดตั้งในโปรเจกต์ `pages secret put` ถ้า stdin ไม่ใช่เทอร์มินัลจะอ่านค่าจาก stdin ทั้งก้อนแล้วตัดช่องว่าง/ขึ้นบรรทัดท้าย (`trimEnd`) ; ซอร์สเดียวกันรับ `--env production|preview` ด้วย (flag นี้ไม่โชว์ใน `--help`) -> ตั้ง secret ของ Preview ได้จากบรรทัดคำสั่ง (ถ้าไม่ได้ผล ใช้ Dashboard ตามหมายเหตุด้านล่าง)

สร้างค่าสุ่ม 48 ไบต์ **2 ค่า คนละค่ากัน** (Production / Preview) เก็บในตัวแปร session เท่านั้น :

```powershell
function New-RandomSecret { $b = New-Object byte[] 48; $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider; $rng.GetBytes($b); $rng.Dispose(); [Convert]::ToBase64String($b) }
$prodSecret = New-RandomSecret
$previewSecret = New-RandomSecret
$prodSecret.Length
($prodSecret -ne $previewSecret)
```

ต้องได้ `64` และ `True` (ห้ามพิมพ์ตัวแปรสองตัวนี้ออกหน้าจอ) ; จากนั้น pipe เข้า wrangler (ตอบ prompt ถ้ามี) :

```powershell
$prodSecret | npx wrangler pages secret put AUTH_TOKEN_SECRET --project-name prpo-pdqc
$previewSecret | npx wrangler pages secret put AUTH_TOKEN_SECRET --project-name prpo-pdqc --env preview
```

**ล้างทันที** :

```powershell
Remove-Variable prodSecret, previewSecret, b, rng -ErrorAction SilentlyContinue
```

- ถ้า pipe ใช้ไม่ได้ในเครื่องคุณ และต้องวางค่าผ่านหน้าต่าง prompt/clipboard แทน : **ปิด Clipboard history และ Cloud clipboard sync** (Settings -> System -> Clipboard) ก่อน ; หลังวางทุกครั้งกด **Win+V -> Clear all** และ `Set-Clipboard -Value $null`
- สำรอง (ถ้า `--env preview` ใช้ไม่ได้) : Dashboard -> Workers & Pages -> `prpo-pdqc` -> Settings -> Variables and Secrets -> เลือก **Preview** -> Add (Type = Secret) : `AUTH_TOKEN_SECRET` (คนละค่ากับ Production)

**ห้ามเด็ดขาด** : ตั้ง `ENVIRONMENT=dev`, `ALLOW_DEV_SEED`, `DEV_SEED_PASSWORD` ที่ใดก็ตามในระบบจริง (ทั้ง Production/Preview และใน `wrangler.toml`)

**ตรวจว่าสำเร็จ** :

```powershell
npx wrangler pages secret list --project-name prpo-pdqc
npx wrangler pages secret list --project-name prpo-pdqc --env preview
```

ต้องเห็น `AUTH_TOKEN_SECRET` ในแต่ละ environment (ไม่เห็นค่า) ; แล้วเปิด Dashboard -> `prpo-pdqc` -> Settings -> Variables and Secrets ตรวจ **ทั้งแท็บ Production และ Preview** ว่า **ไม่มี** `ENVIRONMENT` / `ALLOW_DEV_SEED` / `DEV_SEED_PASSWORD`

**ถ้าพลาด** : ใส่ค่าผิด -> รัน `put` ซ้ำชื่อเดิมเพื่อทับ ; ลบ : `npx wrangler pages secret delete <NAME> --project-name prpo-pdqc`

---

## ขั้น 2 : D1 preview (ฐานแยกจาก production)

**ทำไม** : Preview deployment ต้องไม่ใช้ฐาน production (ตอนนี้ `database_id = "<PREVIEW_DATABASE_ID>"` ทำให้ Preview build ล้มโดยตั้งใจ)

```powershell
npx wrangler d1 create prpo-db-preview
```

คัดลอก `database_id` ที่ได้ ไปแทน `<PREVIEW_DATABASE_ID>` ใน `wrangler.toml` **บรรทัด 30** (`database_id = "<PREVIEW_DATABASE_ID>"` ในบล็อก `[[env.preview.d1_databases]]`) อย่าแตะ `database_id` ของ `prpo-db` บรรทัด 15

**ตรวจว่าสำเร็จ** : `npx wrangler d1 list` เห็นทั้ง `prpo-db` และ `prpo-db-preview` ; `git diff wrangler.toml` เปลี่ยนเฉพาะบรรทัดนั้น (ID ไม่ใช่ความลับ commit ได้)

**ถ้าพลาด** : ได้ ID ผิดที่ -> แก้กลับในไฟล์ ; ลบฐาน preview ที่สร้างเกิน : `npx wrangler d1 delete prpo-db-preview` (ฐานนี้ไม่มีข้อมูลจริง)

---

## ขั้น 3 : Backup แล้ว apply migrations 0001-0014

**ทำไม** : ต้องมี backup ก่อนแตะฐาน production ; migrations (`migrations/0001..0014`) สร้าง/ปรับตารางที่โค้ดใหม่ต้องใช้ (0010 `tokenVersion`, 0011 `file_refs`, 0012 ดัชนี login, 0013 `attachments.storage/objectKey/migratedFrom` สำหรับไฟล์ R2 -- แถวเดิมทั้งหมดเป็น `storage='drive'` ; 0014 ดัชนี `audit_logs.timestamp` + ตาราง `notification_reads` ; ไม่มี DROP ; **ต้อง apply 0013 ก่อน deploy โค้ดที่อัปโหลดลง R2**) ; `wrangler.toml` ตั้ง `migrations_dir = "migrations"` แล้ว จึงใช้ `d1 migrations apply` ได้ตรง ๆ ; **ห้ามใช้ `d1_schema.sql`**

### 3.1 Backup (เก็บนอก repo)

`.gitignore` **ไม่มี** `backups/` -> ใช้ path นอก repo เท่านั้น :

```powershell
New-Item -ItemType Directory -Force C:\Users\Admin\prpo-backups
npx wrangler d1 export prpo-db --remote --output=C:\Users\Admin\prpo-backups\prpo-db-<YYYYMMDD>.sql
(Get-Item C:\Users\Admin\prpo-backups\prpo-db-<YYYYMMDD>.sql).Length
```

**ตรวจ** : ขนาด > 0 และเปิดอ่านต้นไฟล์ได้ (`Get-Content C:\Users\Admin\prpo-backups\prpo-db-<YYYYMMDD>.sql -TotalCount 5`) ; ถ้าฐานยังว่าง/ยังไม่มีตาราง export อาจเล็กหรือ error -> ไปต่อได้ แต่จดไว้ว่าฐานว่าง

**ที่เก็บและอายุ backup** : โฟลเดอร์ `C:\Users\Admin\prpo-backups` ต้องอยู่ในไดรฟ์ที่เปิด BitLocker (ตรวจ `manage-bde -status C:` ใน PowerShell แบบ Administrator) และ **ไม่อยู่ในโฟลเดอร์ที่ sync** (OneDrive / Google Drive for desktop / Dropbox) ; backup และไฟล์ SQL/CSV มีข้อมูลบุคคลและ hash รหัสผ่าน -> เก็บ backup ที่ใช้กู้เท่าที่จำเป็น (แนะนำไม่เกิน 30 วัน หลังพ้นช่วง rollback ให้ลบทีละไฟล์ด้วย path เต็ม) ; ไฟล์ชั่วคราว (CSV, `.import.sql`, `set-admin-pw.sql`, backfill) ลบทันทีที่ใช้เสร็จ

### 3.2 ทดลอง preview ก่อน

```powershell
npx wrangler d1 migrations apply prpo-db-preview --remote --env preview
```

(ใช้ `--env preview` เพื่อให้ wrangler หาฐาน `prpo-db-preview` จากบล็อก `[env.preview]` ; ถ้า wrangler แจ้งว่าไม่พบฐานหรือไม่รู้จัก env ดูหัวข้อ "ถ้าพลาด")
ตอบ `y` เมื่อมันแสดงรายการ 0001-0014

```powershell
npx wrangler d1 execute prpo-db-preview --remote --env preview --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

ต้องเห็นตารางเช่น `users`, `prs`, `pos`, `attachments`, `file_refs`, `upload_attempts`, `login_attempts`, `d1_migrations`

### 3.3 Production

```powershell
npx wrangler d1 migrations apply prpo-db --remote
npx wrangler d1 execute prpo-db --remote --command "SELECT name FROM d1_migrations ORDER BY id"
```

**ตรวจว่าสำเร็จ** : รายการ migrations แสดง 0001 ถึง 0014 ครบ 14 แถว ; ตรวจตารางด้วยคำสั่ง `SELECT name FROM sqlite_master ...` แบบเดียวกับข้างบน (เปลี่ยนเป็น `prpo-db --remote` โดยไม่มี `--env`)

**ถ้าพลาด** :
- migration ใดล้ม wrangler ย้อน migration นั้นเอง migration ก่อนหน้ายังอยู่ -> อ่าน error แก้แล้วรัน apply ซ้ำได้ (ข้ามที่ผ่านแล้ว)
- ต้องย้อนทั้งฐานจริง ๆ : ทำได้เฉพาะเมื่อ **ฐานยังไม่มีข้อมูลจริง** (ก่อนขั้น 4) ; กู้จาก backup บนฐานว่างเท่านั้น : `npx wrangler d1 execute prpo-db --remote --file=C:\Users\Admin\prpo-backups\prpo-db-<YYYYMMDD>.sql` (ถ้าฐานไม่ว่างจะชน PRIMARY KEY และล้ม ไม่ทับข้อมูล)
- ทางเสริม : D1 Time Travel `npx wrangler d1 time-travel info prpo-db` (ดูจุดย้อนได้ ; ไม่ได้ทดสอบ)

---

## ขั้น 4 : ย้ายข้อมูลจาก Google Sheets (ต้องทำกับ D1 ที่ว่างเท่านั้น)

**ทำไม** : นำข้อมูลระบบเดิมเข้า D1 ครั้งเดียว ; สคริปต์ hash รหัสผ่านให้และไม่เขียน plaintext

### 4.0 Freeze : หยุดใช้ GAS ก่อน export (ทำ 4.1 -> ขั้น 7 ต่อเนื่อง)

**ทำไม** : ข้อมูลที่ผู้ใช้บันทึกใน GAS หลังจาก export จะไม่ตามเข้า D1 (และ import ทำครั้งเดียวกับฐานว่าง) -> ต้องไม่มีใครเขียนข้อมูลใน GAS ระหว่างขั้น 4.1 ถึงตัด GAS
1. ประกาศผู้ใช้ทุกคน (เวลาเริ่ม-สิ้นสุดช่วงหยุดใช้งาน) ให้หยุดบันทึก/อนุมัติ/รับของ
2. เลือกช่วงเวลาที่ไม่มีคนใช้ (เช่นนอกเวลางาน/วันหยุด) และเตรียมให้ครบก่อน : ขั้น 0-3, 5 (deploy Preview) เสร็จแล้ว
3. **ทำขั้น 4.1 -> 4.6 -> 5.2 -> 5.5 -> 6 -> 7 ต่อเนื่องในช่วง freeze เดียว** ; ถ้าติดขัดและต้องกลับไปใช้ GAS ให้แจ้งผู้ใช้ว่าข้อมูลที่เขียนใน D1 ช่วงนั้นต้องย้ายมือ

### 4.1 Export ชีตเป็น CSV

ใน Google Sheets แต่ละชีต : File -> Download -> Comma-separated values (.csv) ตั้งชื่อไฟล์เท่าชื่อชีต เช่น `Users.csv`, `PRs.csv`, `PRItems.csv`, `POs.csv`, `Products.csv`, `StockLogs.csv` ฯลฯ (ชื่อชีตทั้งหมดที่สคริปต์รู้จัก : Departments, Users, StorageLocations, UsageUnits, Products, Vendors, Signatures, Budgets, BudgetTransactions, PRs, PRItems, POs, StockLogs, AuditLogs, Notifications, AppConfig, Attachments, PRCounters ; ชีตที่ไม่มีไฟล์ถูกข้าม)
เบราว์เซอร์จะบันทึกลง `C:\Users\Admin\Downloads\` -> ย้ายทั้งหมดไปเก็บ **นอก repo** ที่ `C:\Users\Admin\prpo-backups\sheets-export\` (`New-Item -ItemType Directory -Force C:\Users\Admin\prpo-backups\sheets-export` แล้ว `Move-Item` ทีละไฟล์) ; ไฟล์มีข้อมูลบุคคลและรหัสผ่านใน Users -> ห้ามอยู่ใน repo/โฟลเดอร์ sync ; ตรวจว่า `C:\Users\Admin\Downloads\` ไม่เหลือ CSV ของระบบนี้ (ขั้น 4.6 ลบ)

**ก่อนไปต่อ ตรวจชีต Users** : (ก) แอดมินอย่างน้อย 1 คนต้องมี `roleId` = `ADMIN` หรือ `level` >= 99 (server ถือเฉพาะสองแบบนี้เป็นแอดมิน) (ข) ผู้ใช้ **ทุกคน** ต้องมี `roleId` (server บังคับ) (ค) ตั้ง `allowedDepartments` ให้ถูก (ผู้จัดการ/แอดมินข้ามแผนก = `["*"]`) (ง) ชีต Departments ควรครบ

### 4.2 สร้างไฟล์ SQL

```powershell
node scripts/import-sheets-to-d1.js --in C:\Users\Admin\prpo-backups\sheets-export --out C:\Users\Admin\prpo-backups\d1-import.import.sql --force-change-password
```

flag ที่ใช้ได้จริง : `--out`, `--only Users,PRs`, `--force` (ทับไฟล์ out), `--replace` (ห้ามใช้ ถ้าไม่รู้ผล), `--force-change-password`, `--no-file-refs`

**ตัวเลือกที่แนะนำ : `--force-change-password`** (ใส่ในคำสั่งข้างบนแล้ว) -- ทุกคนต้องตั้งรหัสใหม่ในการ login ครั้งแรก ผลต่อผู้ใช้ : รหัสเดิมจากระบบ GAS ยังใช้ login ครั้งแรกได้ (ถ้าไม่ใช่รหัสเริ่มต้น) แต่ถูกบังคับเปลี่ยนทันที ; เหตุผลที่แนะนำ : รหัสเดิมเคยอยู่เป็น plaintext ใน Sheets จึงถือว่าอาจรั่วแล้ว ; ถ้าไม่ใส่ flag นี้ ผู้ใช้ที่มีรหัสเดิมใช้ต่อได้เลยโดยไม่ถูกบังคับเปลี่ยน (เฉพาะคนที่ไม่มี hash จึงถูกบังคับ) -- **คุณตัดสินใจตอนรัน** (ไม่ใส่ flag ก็ได้ ลบ `--force-change-password` ออกจากคำสั่ง)

**ตรวจ** : หน้าจอรายงานจำนวนแถวต่อชีต ตรงกับจำนวนแถวในชีตจริง ; import **hash รหัสผ่านให้แล้ว** (PBKDF2, ไม่มี plaintext ในไฟล์ SQL) ; ยกเว้นรหัสผ่านว่าง/รหัสเริ่มต้น (`123456`, `password123`, `admin123`)/ยาวเกิน จะ **ไม่ถูกตั้งรหัส** -> แอดมินต้องตั้งให้ในขั้น 5.5 (ดูข้างล่าง)

### 4.3 ทดลอง local ก่อน (ไม่แตะ remote)

```powershell
npx wrangler d1 migrations apply prpo-db --local
npx wrangler d1 execute prpo-db --local --file=C:\Users\Admin\prpo-backups\d1-import.import.sql
npx wrangler d1 execute prpo-db --local --command "SELECT COUNT(*) AS n FROM users"
```

### 4.4 Apply กับ production (ฐานต้องว่าง)

ตรวจก่อนว่าว่าง : `npx wrangler d1 execute prpo-db --remote --command "SELECT COUNT(*) AS n FROM users"` ต้องได้ 0

```powershell
npx wrangler d1 execute prpo-db --remote --file=C:\Users\Admin\prpo-backups\d1-import.import.sql
npx wrangler d1 execute prpo-db --remote --command "SELECT COUNT(*) AS n FROM users"
npx wrangler d1 execute prpo-db --remote --command "SELECT COUNT(*) AS n FROM prs"
```

**ตรวจ** : จำนวนแถวตรงกับชีต ; มี admin : `SELECT username, roleId, level FROM users WHERE roleId='ADMIN' OR level>=99`

**เทียบผู้ใช้ชีต กับ D1 ก่อนตัด GAS (ขั้น 7)** : เปิดชีต Users เทียบกับผลคำสั่งนี้ -- จำนวนคน, `roleId`, `status`/active, `level` ต้องตรงกัน คนที่ไม่มี `roleId` หรือ status ผิดจะ login ไม่ได้/สิทธิ์ผิด :

```powershell
npx wrangler d1 execute prpo-db --remote --command "SELECT COUNT(*) AS total, SUM(UPPER(status)='ACTIVE') AS active, SUM(roleId IS NULL OR roleId='') AS noRole FROM users"
npx wrangler d1 execute prpo-db --remote --command "SELECT roleId, level, status, COUNT(*) AS n FROM users GROUP BY roleId, level, status ORDER BY roleId"
npx wrangler d1 execute prpo-db --remote --command "SELECT username, name, roleId, level, status, department FROM users ORDER BY username"
```

`noRole` ต้องเป็น 0 ; ถ้ามีความต่าง **อย่าตัด GAS** -> แก้ข้อมูลผ่านหน้า Admin หรือแจ้งทีม

### 4.5 `file_refs` / backfill

- **ถ้าใช้ import script ตัวปัจจุบันตามขั้น 4.2 (ไม่ใส่ `--no-file-refs`) และ D1 production ว่างมาก่อน : ไม่ต้อง backfill** (SQL ที่ได้เติม `file_refs` ให้แล้ว) -> ข้ามไปขั้น 4.6
- backfill จำเป็นเฉพาะกรณีมีข้อมูลอยู่ใน D1 ก่อนแล้ว (หรือสร้าง SQL ด้วย `--no-file-refs`) ; ถึงไม่ทำ server ก็ทำดัชนีเองทีหลัง (แค่ช้ากว่า) ; สคริปต์ทำงานกับไฟล์ sqlite **ในเครื่อง** ไม่แตะ remote ; ทางที่ทำได้จริงด้วย Node 22 (`node:sqlite` มีในตัว) :

```powershell
npx wrangler d1 export prpo-db --remote --output=C:\Users\Admin\prpo-backups\for-backfill.sql
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('C:/Users/Admin/prpo-backups/for-backfill.sqlite');db.exec(fs.readFileSync('C:/Users/Admin/prpo-backups/for-backfill.sql','utf8'));db.close();console.log('ok')"
node scripts/backfill-file-refs.js --db C:\Users\Admin\prpo-backups\for-backfill.sqlite
node scripts/backfill-file-refs.js --db C:\Users\Admin\prpo-backups\for-backfill.sqlite --out C:\Users\Admin\prpo-backups\backfill.sql
npx wrangler d1 execute prpo-db --remote --file=C:\Users\Admin\prpo-backups\backfill.sql
```

  บรรทัด 3 = รายงานอย่างเดียว (ตรวจจำนวนก่อน) ; บรรทัด 4 เขียน SQL `INSERT OR IGNORE` (รันซ้ำได้ ไม่ทับ/ลบ) ; ตรวจไฟล์ `backfill.sql` ก่อนบรรทัด 5 ; ถ้า `node:sqlite` แจ้ง experimental warning ไม่เป็นไร ; ไฟล์ export อาจมีข้อมูลบุคคล ลบทีละไฟล์ด้วย path เต็มเมื่อเสร็จ (ขั้นตอนนี้ยังไม่ได้ทดสอบกับ export จริง)

### 4.6 ล้างไฟล์ที่มีข้อมูลบุคคล (ทีละไฟล์ด้วย path เต็ม ห้าม wildcard)

หลังตรวจเสร็จ (รวมการเทียบผู้ใช้ข้างบน) ลบทีละไฟล์ด้วย path เต็ม **ระบุชื่อทุกไฟล์ ไม่ใช้ wildcard** :

```powershell
Remove-Item C:\Users\Admin\prpo-backups\d1-import.import.sql
Remove-Item C:\Users\Admin\prpo-backups\sheets-export\<ชื่อชีต>.csv
```

(บรรทัดที่สองทำซ้ำสำหรับ CSV ทุกไฟล์ที่ export ไว้ เช่น `Users.csv`, `PRs.csv`, ... แล้วลบโฟลเดอร์ `sheets-export` เมื่อว่างด้วย `Remove-Item C:\Users\Admin\prpo-backups\sheets-export` ซึ่งลบได้เฉพาะโฟลเดอร์ว่าง) ; ลบ CSV ที่ค้างใน `C:\Users\Admin\Downloads\` ด้วย (ทีละไฟล์ด้วย path เต็ม) ; ถ้าทำ backfill (ขั้น 4.5) ลบ `for-backfill.sql`, `for-backfill.sqlite`, `backfill.sql` ใน `C:\Users\Admin\prpo-backups\` ทีละไฟล์เช่นกัน ; แล้วเช็ค `git status` ว่าไม่มีไฟล์เหล่านี้ใน repo และตรวจด้วย `Test-Path` ของแต่ละไฟล์ได้ `False`

**ถ้าพลาด** : import ล้มกลางคัน (ชน PRIMARY KEY/UNIQUE) -> ฐานอาจมีข้อมูลบางส่วน ให้กู้จาก backup ขั้น 3.1 ไม่ใช่รันซ้ำ : ถ้าต้องการฐานว่างสะอาด ให้ถามทีมก่อน (ไม่มีคำสั่งล้างฐานในเอกสารนี้โดยตั้งใจ) ; ชีตแถว id ซ้ำ -> สคริปต์เก็บแถวแรก ; CSV เพี้ยนภาษาไทย -> export ใหม่เป็น UTF-8

---

## ขั้น 5 : Build + deploy (Preview ก่อน แล้ว Production)

**ทำไม** : ต้องเห็นว่าใช้งานได้บน Preview (ฐานแยก) ก่อนปล่อยจริง

```powershell
npm run build:cf
```

**ตรวจ build** : มีโฟลเดอร์ `dist` (ตรงกับ `pages_build_output_dir = "dist"`), มี `dist\_headers`, ไม่มีไฟล์ `.map` ใน `dist\assets`

### 5.1 Preview

```powershell
npx wrangler pages deploy dist --project-name prpo-pdqc --branch preview
```

(ใช้ branch ที่ไม่ใช่ production branch เพื่อให้เป็น Preview ; ผลลัพธ์จะแสดง URL แบบ `https://<hash>.prpo-pdqc.pages.dev` หรือ `https://preview.prpo-pdqc.pages.dev`)
Preview ใช้ฐาน `prpo-db-preview` (ว่าง ไม่มี user) -> เทสต์เต็มรูปแบบต้องสร้าง user ในฐาน preview เอง ซึ่งไม่มีทางลัด dev seed (ห้ามเปิด `ALLOW_DEV_SEED`) ; ใช้ Preview ตรวจ **หน้าโหลด, CSP, `/api/health` ได้ 401** เป็นหลัก ; ถ้าต้องการเทสต์ login บน Preview ให้ import ข้อมูลทดสอบ (ไม่ใช่ข้อมูลจริง) เข้า `prpo-db-preview` เอง

### 5.2 Production

```powershell
npx wrangler pages deploy dist --project-name prpo-pdqc --branch <PRODUCTION_BRANCH>
```

(`<PRODUCTION_BRANCH>` = ชื่อ production branch ของโปรเจกต์ : Dashboard -> Workers & Pages -> `prpo-pdqc` -> Settings -> Builds & deployments -> "Production branch" ; หรือ `npx wrangler pages project list` ; branch อื่นจะกลายเป็น Preview)

**ตรวจว่าสำเร็จ** (แทน `<PROD_URL>`) :

```powershell
try { Invoke-WebRequest -Uri <PROD_URL>/api/health -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

ต้องได้ **401** (200 = หยุดทันที, 404 = Functions ไม่ถูก deploy, 500 = secret ไม่ครบ/สั้นเกิน) ; เปิด `<PROD_URL>` ใน Chrome -> F12 -> Network -> คลิกเอกสารหลัก ดู Response Headers ต้องมี `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` ; Console ต้องไม่มี "Refused to ..."

**ถ้าพลาด** : deploy ผิด -> Dashboard -> `prpo-pdqc` -> Deployments -> deployment ก่อนหน้า -> **Rollback to this deployment** ; Preview build ล้มเพราะ `<PREVIEW_DATABASE_ID>` -> ยังไม่ได้ทำขั้น 2 ; พบ CSP violation -> จดโฮสต์ที่ถูกบล็อก แจ้งทีมให้เพิ่มใน `public/_headers` (อย่าลดความเข้มเอง)

---

## ขั้น 5.5 : ตั้งรหัสแอดมินคนแรก (ก่อน smoke test)

**ทำไม** : import จะไม่ตั้งรหัสให้ผู้ใช้ที่รหัสในชีตว่าง หรือเป็น `123456` / `password123` / `admin123` (dev seed ห้ามใช้ใน production) -> ถ้าแอดมินทุกคนอยู่ในกลุ่มนี้จะ login ไม่ได้ ; ผู้ใช้ที่รหัสในชีตเป็นค่าอื่น import hash ให้แล้ว (login ด้วยรหัสเดิมได้ ถ้าใช้ `--force-change-password` จะถูกบังคับเปลี่ยนทันที) จึงข้ามขั้นนี้ได้ถ้ามีแอดมินแบบนั้นแล้ว

ตรวจก่อนว่าแอดมินคนไหนมี hash แล้ว :

```powershell
npx wrangler d1 execute prpo-db --remote --command "SELECT username, roleId, level, (passwordHash IS NOT NULL AND passwordHash <> '') AS hasHash, mustChangePassword FROM users WHERE roleId='ADMIN' OR level>=99"
```

ถ้าไม่มีแอดมินที่ใช้ login ได้ ให้สร้าง SQL ตั้งรหัสชั่วคราว (สคริปต์ถามรหัสแบบซ่อนตัวอักษร ไม่รับรหัสทาง argv และ **ต้องรันใน PowerShell แบบโต้ตอบ** (ถ้า stdin เป็น pipe สคริปต์ปฏิเสธ) ; รหัสยาว 6-256 ตัว ไม่ใช่รหัสเริ่มต้น และ **ไม่มีช่องว่างหัว/ท้าย** (server ตัดช่องว่างตอน login) ; ไฟล์ผลลัพธ์ต้องอยู่นอก repo)

**ก่อนสร้างไฟล์ ตรวจว่า username เจอ 1 แถวพอดี** (สคริปต์เปรียบเทียบแบบ `lower(username)` ถ้าพิมพ์ผิด UPDATE จะไม่กระทบแถวใดและไม่มี error) :

```powershell
npx wrangler d1 execute prpo-db --remote --command "SELECT id, username, roleId, level FROM users WHERE lower(username) = lower('<ADMIN_USERNAME>')"
```

ต้องได้ **1 แถว** (0 = พิมพ์ผิด, มากกว่า 1 = ผิดปกติ หยุดและแจ้งทีม) จากนั้น :

```powershell
node scripts/set-user-password.js --username <ADMIN_USERNAME> --out C:\Users\Admin\prpo-backups\set-admin-pw.sql
try { npx wrangler d1 execute prpo-db --remote --file=C:\Users\Admin\prpo-backups\set-admin-pw.sql } finally { Remove-Item C:\Users\Admin\prpo-backups\set-admin-pw.sql -ErrorAction SilentlyContinue }
Test-Path C:\Users\Admin\prpo-backups\set-admin-pw.sql
```

`try/finally` ทำให้ลบไฟล์ SQL เสมอแม้ `execute` ล้ม ; `Test-Path` ต้องได้ `False` (ถ้าต้องรันซ้ำให้สร้างไฟล์ใหม่ด้วยสคริปต์)

สคริปต์เขียนเฉพาะ hash (PBKDF2-SHA256 โค้ดเดียวกับ server) ลง `UPDATE users SET passwordHash, passwordSalt, passwordAlgo, passwordIterations, passwordUpdatedAt, password='', pin='', mustChangePassword=1, tokenVersion=tokenVersion+1 WHERE lower(username)=...` ไม่มีรหัส plaintext

**ตรวจว่าสำเร็จ** : รัน SELECT ข้างบนซ้ำ `hasHash = 1`, `mustChangePassword = 1` ; login บนเว็บด้วยรหัสชั่วคราว -> ระบบบังคับเปลี่ยนรหัสทันที (ตั้งรหัสจริงของคุณ)

**ถ้าพลาด** : พิมพ์ username ผิด -> UPDATE ไม่กระทบแถวใด (ไม่เสียหาย) รันสร้างไฟล์ใหม่ด้วย `--force` ; ลืมรหัสชั่วคราว -> รันสคริปต์ใหม่ ; ไฟล์ SQL ค้าง -> ลบทีละไฟล์ด้วย path เต็ม

---

## ขั้น 6 : Smoke test (บน Production ด้วยข้อมูลทดสอบ)

**ทำไม** : ยืนยันว่าทุกเส้นทางหลักทำงานก่อนตัด GAS ; เปิด DevTools Console ค้างไว้ตลอด ต้องไม่มี CSP violation

- [ ] login แอดมิน (ตั้งรหัสไว้แล้วในขั้น 5.5)
- [ ] เปลี่ยนรหัสผ่านครั้งแรก (บัญชี `mustChangePassword`) แล้ว login ใหม่ได้
- [ ] สร้าง PR ทดสอบ + แนบไฟล์ (รูป และ PDF) -> บันทึกได้
- [ ] อนุมัติ PR ตามลำดับขั้น
- [ ] สร้าง PO จาก PR
- [ ] รับของ (GRN) พร้อมแนบหลักฐาน
- [ ] เปิดไฟล์แนบ/รูปจากรายละเอียด PR/PO (ผ่าน `/api/files/:id`) ต้องแสดงได้
- [ ] สร้าง PDF ของ PO (ฟอนต์ไทยแสดงถูก)
- [ ] หน้างบประมาณโหลดได้
- [ ] Online procurement hub โหลดได้
- [ ] **ทดสอบแนบไฟล์ (R2)** : แนบรูป PNG/JPG เล็ก ๆ ใน PR (และ PDF 1 ไฟล์) -> บันทึก -> ปิดแล้วเปิด PR ใหม่ รูปต้องแสดง ; เปิด PO/GRN/เคลมที่แนบไฟล์ รูปต้องแสดงผ่าน proxy ; login ด้วยผู้ใช้อีกแผนก (ที่ไม่มีสิทธิ์เห็นเอกสารนั้น) แล้วเปิด URL `/api/files/<fileId>` ต้องได้ 404 ; ไม่ login ต้องได้ 401
- [ ] ตรวจในฐาน : `npx wrangler d1 execute prpo-db --remote --command "SELECT id, fileId, category, storage, objectKey FROM attachments ORDER BY createdAtMs DESC LIMIT 5"` มีแถวไฟล์ทดสอบ `storage = 'r2'` และ `objectKey` ขึ้นต้นด้วย `PR/<ปี>/<เดือน>/...` ; ดูไฟล์ใน Dashboard -> R2 -> `prpo-files` (ไฟล์ทดสอบเท่านั้น ห้ามเปิด Public access)

**ถ้าพลาด** : อัปโหลดได้ 503 "ยังไม่ได้ตั้งค่าที่เก็บไฟล์" -> ไม่มี binding `FILES` (ขั้น 1.1) ; 500 ตอนอัปโหลด/บันทึก -> ยังไม่ได้ apply migration 0013 (ขั้น 3) ; รูปไม่แสดงและ `/api/files/<id>` ได้ 404 สำหรับเจ้าของไฟล์ -> ดูแถว `attachments` ว่า `storage='r2'` และ `objectKey` ไม่ว่าง ; 500 ทุก API -> `AUTH_TOKEN_SECRET` ไม่ตั้ง/สั้น ; ลบข้อมูลทดสอบที่สร้างเฉพาะของที่ทดสอบ ห้ามแตะข้อมูลจริง ; ผลไม่ผ่านให้ **ไม่ตัด GAS** และแจ้งทีม

---

## ขั้น 7 : ตัดระบบ GAS (ทำทันทีหลัง smoke test ผ่าน)

**ทำไม** : ถ้าปล่อย GAS ไว้ ผู้ใช้อาจเขียนข้อมูลสองที่แล้วข้อมูลแยกกัน

ก่อนปิด : จด Deployment ID / version ของ web app เดิมไว้ (เพื่อ rollback)

วิธีที่ 1 (แนะนำ) : เปิด script.google.com -> โปรเจกต์ -> **Deploy -> Manage deployments** -> เลือก deployment ที่ใช้งาน -> ไอคอนถังขยะ/**Archive**

วิธีที่ 2 : push ตัวแก้ที่ทำให้ GAS ไม่รับข้อมูล (ต้องได้ตัวแก้จากทีมก่อน) แล้วรัน :

```powershell
npm run gas:push
```

(`gas:push` = build + `clasp push --force` ; แตะบัญชี Google ของคุณ ; อย่ารันถ้าไม่มีไฟล์ตัวแก้ที่ตรวจแล้ว)

**ตรวจ** : เปิด URL web app เดิมแล้วใช้งานไม่ได้/ขึ้นข้อความปิดระบบ ; แจ้งผู้ใช้ทุกคนให้ใช้ `<PROD_URL>`

**ถ้าพลาด/ย้อน** : Manage deployments -> สร้าง/กู้ deployment ด้วย version ที่จดไว้ ; ข้อมูลที่เขียนลง D1 ระหว่างนั้นไม่ย้อนกลับไป GAS เอง ต้องย้ายมือ

**ขั้นเลือกทำ : ล้างคอลัมน์รหัสผ่านใน Google Sheets (ต้องตัดสินใจเอง ไม่มีคำสั่งลบในเอกสารนี้)** : ชีต Users เดิมยังเก็บรหัส (`password`) และ `pin` เป็น plaintext ซึ่งเป็นความเสี่ยงแม้ปิด GAS แล้ว (ผู้ที่เข้าถึงชีตได้เห็นรหัสเดิมของทุกคน) แนะนำให้ล้างคอลัมน์ `password` และ `pin` **หลังพ้นช่วง rollback** (เช่น 1-2 สัปดาห์ที่ D1 ใช้งานปกติ) ขั้นตอน : (1) ทำสำเนาชีตทั้งไฟล์ (File -> Make a copy) เก็บไว้ในที่จำกัดสิทธิ์เฉพาะผู้ดูแล (2) จากนั้นจึงล้างค่าในคอลัมน์ `password` / `pin` ของชีตต้นฉบับด้วยมือ (3) ตรวจสิทธิ์การแชร์ชีตให้เหลือเฉพาะผู้ดูแล ; ถ้ายังต้อง rollback ไป GAS ได้ ห้ามล้างก่อน -- ล้างแล้ว rollback ไม่ได้ (นอกจากกู้จากสำเนา)

---

## ขั้น 8 : หลัง cutover : ปิด anyone-with-link ของไฟล์เก่า และเก็บกวาดไฟล์กำพร้า

**ทำไม** : ไฟล์ **Google Drive** ที่อัปโหลดก่อนหน้านี้ (ถ้ามี) อาจยังเป็น anyone-with-link ; endpoint เป็น admin เท่านั้น และ **dry-run เป็นค่าเริ่มต้น**
**หมายเหตุ** : 8.2 (unshare-public) ใช้เฉพาะไฟล์ที่เก็บใน Drive (`storage='drive'`) ; ไฟล์ R2 เป็นส่วนตัวเสมอ -- ระบบข้ามแถว `storage='r2'` และรายงานเป็น `ALWAYS_PRIVATE` ; ถ้าเริ่มระบบใหม่บน R2 ทั้งหมดและไม่มีไฟล์ Drive เก่า ข้าม 8.2 ได้

### 8.1 เอา token อย่างปลอดภัย

ใช้ login แล้วเก็บ token ในตัวแปร session เท่านั้น ไม่พิมพ์ ไม่ใส่ในคำสั่ง (กันเข้า history) ; ถามรหัสผ่านแบบซ่อน :

```powershell
$base = "<PROD_URL>"
$u = Read-Host "username"
$sp = Read-Host "password" -AsSecureString
$pw = [System.Net.NetworkCredential]::new("", $sp).Password
$json = @{ username = $u; password = $pw } | ConvertTo-Json
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType "application/json; charset=utf-8" -Body $bytes
$sp.Dispose(); $pw = $null; $json = $null; $bytes = $null; $u = $null
$login.mustChangePassword
$h = @{ Authorization = "Bearer $($login.token)" }
```

`mustChangePassword` ต้องเป็น `False` (ถ้า True ให้ไปเปลี่ยนรหัสบนหน้าเว็บก่อน token จึงจะเรียก endpoint อื่นได้) ; `$h` อยู่แค่ใน session นี้ ปิดหน้าต่าง PowerShell เมื่อเสร็จ ; `Read-Host` ไม่บันทึกค่าที่พิมพ์ลง history แต่ **อย่า** พิมพ์รหัสผ่านเป็นอาร์กิวเมนต์ในคำสั่งใด ๆ

### 8.2 unshare-public : dry-run ก่อน

```powershell
$r = Invoke-RestMethod -Method Post -Uri "$base/api/admin/unshare-public" -Headers $h -ContentType "application/json" -Body '{}'
$r.dryRun
$r.candidateCount
$r.truncated
$r.candidates | Format-Table
```

**ตรวจ** : `dryRun = True` (ไม่เรียก Drive) ; `candidates` ต้องเป็นไฟล์ของโปรเจกต์นี้ทั้งหมด

ลงมือจริง (ทำซ้ำจน `candidateCount = 0` ; ครั้งละไม่เกิน 20 ไฟล์) :

```powershell
$r = Invoke-RestMethod -Method Post -Uri "$base/api/admin/unshare-public" -Headers $h -ContentType "application/json" -Body '{"dryRun": false}'
$r.candidateCount
$r.truncated
$r.skipped | Format-Table
```

ดู `skipped[]` : `NOT_IN_DRIVE`, `NOT_IN_UPLOAD_FOLDER` (ข้ามถาวร) ; `DRIVE_ERROR`/`STILL_PUBLIC` (ลองรอบหน้า) ; จากนั้นปิด anyone-with-link ของโฟลเดอร์รากด้วยมือใน Drive และทดสอบเปิดลิงก์ไฟล์เก่าใน Incognito ต้องเปิดไม่ได้

### 8.3 cleanup-orphans : dry-run เท่านั้นก่อน

```powershell
$r = Invoke-RestMethod -Method Post -Uri "$base/api/admin/cleanup-orphans" -Headers $h -ContentType "application/json" -Body '{}'
$r.dryRun
$r.orphans | Format-Table
```

ตรวจรายการ `orphans[]` ว่าเป็นไฟล์กำพร้าจริง (ไฟล์เกิน 24 ชม. ที่ไม่มีเอกสารถือ) ถ้าต้องลงมือ ใช้ body `'{"dryRun": false}'` (ไฟล์ Drive = ย้ายเข้าถังขยะ Drive ; ไฟล์ R2 = ย้ายไป prefix `trash/` ใน bucket เดียวกัน ; ไม่ลบถาวรทั้งสองแบบ และ `trash/` ของ R2 ไม่ถูกล้างอัตโนมัติ -- การตั้ง lifecycle ลบเกิน 30 วันต้องถามผู้ใช้ก่อน) ; กู้คืน : `POST /api/admin/restore-orphan` body `'{"fileId": "<id>"}'` (ภายใน ~30 วันตามถังขยะ Drive) ; **ข้อควรระวัง** ผู้ใช้ที่เปิดฟอร์ม PR ค้างเกิน 24 ชม. โดยไม่บันทึก อาจเสียไฟล์แนบ (กู้ด้วย restore) -> ไม่ควรลงมือในช่วงที่มีคนใช้งานหนัก

เสร็จแล้วล้าง token และตัวแปรทั้งหมด : `Remove-Variable h, login, r, base, u, sp, pw, json, bytes -ErrorAction SilentlyContinue` แล้วปิดหน้าต่าง PowerShell ; ห้าม screenshot/transcript ช่วงนี้ ; ถ้าเครื่องใช้ร่วมกับคนอื่น รัน `npx wrangler logout` เป็นขั้นสุดท้ายของทั้งงาน M2

**ถ้าพลาด** : 401 -> token หมดอายุ login ใหม่ ; 403 -> ผู้ใช้ไม่ใช่แอดมิน (ต้อง roleId `ADMIN` หรือ level >= 99) ; 429/503 -> รอแล้วลองใหม่ ; unshare ผิดไฟล์ -> ไม่มีคำสั่งย้อนอัตโนมัติ (ต้องแชร์ใหม่ใน Drive ด้วยมือ) จึงต้องตรวจ dry-run ก่อนเสมอ

---

## ภายหลังเมื่อมี Google Workspace : ย้ายไปเก็บไฟล์ใน Google Shared Drive (ไม่ต้องทำตอนนี้)

> เงื่อนไข : มีบัญชี Google Workspace + Shared Drive (บัญชี Gmail ส่วนตัวสร้างไม่ได้ และ Service Account อัปโหลดลง My Drive ไม่ได้เพราะไม่มีโควตา) ; ตอนนี้ไฟล์อยู่ใน R2 และระบบทำงานครบโดยไม่ต้องใช้ส่วนนี้
> ลำดับ : (ก) ทำ A1-A3 ด้านล่าง (ข) ตั้ง `FILE_STORAGE = "drive"` + `DRIVE_ROOT_FOLDER_ID` ใน `wrangler.toml` แล้ว deploy -> ไฟล์ **ใหม่** ไปที่ Drive ส่วนไฟล์เก่าใน R2 เปิดได้ต่อเพราะระบบอ่านตามคอลัมน์ `attachments.storage` ของแต่ละแถว (ค) ย้ายไฟล์เก่า : `scripts/migrate-files.js` ตอนนี้รันได้เฉพาะ `--dry-run` (อ่านอย่างเดียว) ; การย้ายจริงยังไม่รองรับ (spec : `docs/requirements-file-storage.md` ข้อ 6)
> ดูรายงานล่วงหน้า (ใช้ไฟล์ sqlite บนเครื่อง เช่น สำเนาจาก `wrangler d1 export` ที่คุณรันเอง ไม่ต่อ remote) :
> `node scripts/migrate-files.js --from r2 --to drive --dry-run --db <local.sqlite> [--limit N] [--doc <docRef>]`

### A1 Google Cloud Console (เบราว์เซอร์)

1. เข้า https://console.cloud.google.com -> เลือกเมนู project (บนซ้าย) -> **New Project** -> ตั้งชื่อเช่น `prpo-drive` (โปรเจกต์แยกเฉพาะงานนี้)
2. เมนู **APIs & Services -> Library** -> ค้น "Google Drive API" -> **Enable**
3. เมนู **IAM & Admin -> Service Accounts -> Create service account** -> ตั้งชื่อ `prpo-worker` -> **Create and continue** -> **ข้ามขั้นให้ role** (ไม่ให้ IAM role ใด ๆ) -> **Done** ; ไม่เปิด domain-wide delegation
4. คลิก SA ที่สร้าง -> แท็บ **Keys -> Add key -> Create new key -> JSON -> Create** : ไฟล์ดาวน์โหลดลงเครื่อง (ปกติลง `C:\Users\Admin\Downloads\`) ให้ย้ายไปเก็บ **นอก repo** ที่ `C:\Users\Admin\prpo-secrets\prpo-sa.json` (ห้าม commit, ห้ามอยู่ใต้ `C:\Users\Admin\Desktop\PRPO`) : `New-Item -ItemType Directory -Force C:\Users\Admin\prpo-secrets` แล้ว `Move-Item <ไฟล์ใน Downloads> C:\Users\Admin\prpo-secrets\prpo-sa.json` -- **ลบไฟล์นี้ทันทีหลังตั้ง secret ครบ** (A3) ไม่ต้องเก็บไว้
5. จดอีเมลของ SA (`...@...iam.gserviceaccount.com` = `client_email`)

### A2 Google Drive (เบราว์เซอร์)

0. **แนะนำ** : ใช้ Shared Drive ที่สร้างเฉพาะโปรเจกต์นี้ (หรือเพิ่ม SA เป็นสมาชิกเฉพาะโฟลเดอร์ของโปรเจกต์) ไม่ใช่ Shared Drive รวมของบริษัท -- Content manager ของทั้ง Drive ทำให้ SA เห็นไฟล์อื่นด้วย
1. Drive -> **Shared drives** (ต้องเป็นบัญชี Workspace) -> ตรวจว่าโฟลเดอร์ `<DRIVE_ROOT_FOLDER_ID>` อยู่ใน Shared Drive ไม่ใช่ My Drive (ถ้าอยู่ My Drive ให้ย้าย/สร้างโฟลเดอร์ใหม่ใน Shared Drive แล้วใช้ ID ใหม่ในขั้นตั้ง `DRIVE_ROOT_FOLDER_ID`)
2. คลิกขวา Shared Drive -> **Manage members** -> ใส่อีเมล SA -> สิทธิ์ **Content manager** -> Send
3. คลิกขวาโฟลเดอร์ราก -> **Share** -> ส่วน General access ต้องเป็น **Restricted** (ปิด anyone-with-link) -> Done


### A3 ตั้ง secrets ของ Service Account (`GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`) และ `DRIVE_ROOT_FOLDER_ID`

SA : อ่านจาก JSON แล้ว pipe (private_key แปลงบรรทัดใหม่เป็น `\n` ตัวอักษร เพื่อให้เป็นบรรทัดเดียว -- `drive.js` รับรูปแบบมี `\n` ตามที่เอกสารเดิมระบุ) :

```powershell
$j = Get-Content C:\Users\Admin\prpo-secrets\prpo-sa.json -Raw | ConvertFrom-Json
$j.client_email | npx wrangler pages secret put GOOGLE_SA_CLIENT_EMAIL --project-name prpo-pdqc
$j.private_key.Replace("`n", '\n') | npx wrangler pages secret put GOOGLE_SA_PRIVATE_KEY --project-name prpo-pdqc
$j.client_email | npx wrangler pages secret put GOOGLE_SA_CLIENT_EMAIL --project-name prpo-pdqc --env preview
$j.private_key.Replace("`n", '\n') | npx wrangler pages secret put GOOGLE_SA_PRIVATE_KEY --project-name prpo-pdqc --env preview
```

**ล้างทันที (ครบทุกตัว)** :

```powershell
Remove-Variable prodSecret, previewSecret, j, b, rng -ErrorAction SilentlyContinue
Remove-Item C:\Users\Admin\prpo-secrets\prpo-sa.json
Test-Path C:\Users\Admin\prpo-secrets\prpo-sa.json
```

- ลบสำเนา key ใน `C:\Users\Admin\Downloads\` ด้วย (ชื่อไฟล์ปกติขึ้นต้นด้วยชื่อ project เช่น `prpo-drive-xxxx.json` ; ลบทีละไฟล์ด้วย path เต็ม `Remove-Item C:\Users\Admin\Downloads\<ชื่อไฟล์>.json` ห้ามใช้ wildcard) แล้ว `Test-Path` ต้องได้ `False` ทั้งสองที่ ; ล้างถังขยะด้วย
- กลับไป Cloud Console -> SA -> แท็บ **Keys** ต้องเหลือ key **เดียว** (อันที่เพิ่งสร้าง ; ลบ key เก่า/ที่ไม่ใช้) ; ตั้งปฏิทินหมุน key เป็นระยะ (เช่นทุก 90 วัน : สร้างใหม่ -> put ใหม่ -> ลบเก่า)
- ถ้า pipe ใช้ไม่ได้ในเครื่องคุณ และต้องวางค่าผ่านหน้าต่าง prompt/clipboard แทน : **ปิด Clipboard history และ Cloud clipboard sync** (Settings -> System -> Clipboard) ก่อน ; หลังวางทุกครั้งกด **Win+V -> Clear all** และ `Set-Clipboard -Value $null`
- สำรอง (ถ้า `--env preview` ใช้ไม่ได้) : Dashboard -> Workers & Pages -> `prpo-pdqc` -> Settings -> Variables and Secrets -> เลือก **Preview** -> Add (Type = Secret) : `AUTH_TOKEN_SECRET` (คนละค่ากับ Production), `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` -- ถ้าต้องใช้วิธีนี้ ให้สร้างและเปิดไฟล์ key เฉพาะตอนก๊อป และทำความสะอาด clipboard ตามข้อบน

`DRIVE_ROOT_FOLDER_ID` : `wrangler.toml` **มีบล็อก `[vars]` และ `[env.preview.vars]` อยู่แล้ว** (`FILE_STORAGE = "r2"`) ตาม `docs/DEPLOY_CLOUDFLARE.md` 2.4 ; ถ้าสลับเป็น Drive ให้**แก้บล็อกเดิม** : เพิ่ม `DRIVE_ROOT_FOLDER_ID` และเปลี่ยน `FILE_STORAGE` เป็น `"drive"` (ทีมไม่แก้ไฟล์นี้ให้) ; **ห้ามสร้างบล็อก `[vars]` / `[env.preview.vars]` ซ้ำ** (TOML ซ้ำทำให้ build ล้ม) :

```toml
[vars]
FILE_STORAGE = "drive"                        # เดิม "r2"
DRIVE_ROOT_FOLDER_ID = "<DRIVE_ROOT_FOLDER_ID>"

[env.preview.vars]
FILE_STORAGE = "drive"                        # เดิม "r2"
DRIVE_ROOT_FOLDER_ID = "<PREVIEW_DRIVE_ROOT_FOLDER_ID>"
```

- Production = `<DRIVE_ROOT_FOLDER_ID>` (หรือ ID ใหม่ถ้าต้องย้ายเข้า Shared Drive ตาม A2)
- Preview : Pages **ไม่สืบทอด** `[vars]` ไปยัง `[env.preview]` จึงต้องมีบล็อก `[env.preview.vars]` แยก ; ควรใช้โฟลเดอร์ทดสอบคนละอันใน Shared Drive เดียวกัน (SA ต้องเป็นสมาชิก) เพื่อไม่ให้ไฟล์ทดสอบปนไฟล์จริง
- ไม่ใช่ความลับ commit ได้ ; **ห้ามใส่ `ENVIRONMENT` / `ALLOW_DEV_SEED` / `DEV_SEED_PASSWORD` ในบล็อกนี้**
- ตรวจหลังแก้ : `git diff wrangler.toml` ต้องมีเฉพาะบล็อกข้างบน (กับ database_id ของขั้น 2) ; ผลจริงดูตอน deploy ขั้น 5 (ถ้า upload ไฟล์ล้มเพราะไม่มีค่า ให้ตั้ง `DRIVE_ROOT_FOLDER_ID` ใน Dashboard แทน)

---

## ตาราง Rollback สรุป

| ขั้น | ผิดพลาดอะไร | ย้อนกลับ |
|---|---|---|
| 0 | login ผิดบัญชี | `npx wrangler logout` แล้ว login ใหม่ |
| 1 | secret ผิด/รั่ว หรือ binding R2 ผิด | `put` ซ้ำเพื่อทับ หรือ `pages secret delete` ; แก้ `wrangler.toml` / Bindings ให้ `FILES` ชี้ bucket ที่ถูก (Preview = `prpo-files-preview`) แล้ว deploy ใหม่ |
| 2 | สร้างฐาน preview ผิด | แก้ `wrangler.toml` กลับ ; `npx wrangler d1 delete prpo-db-preview` |
| 3 | migration ล้ม | wrangler ย้อน migration นั้นเอง ; แก้แล้ว apply ซ้ำ ; ฐานว่างกู้จาก backup ได้ |
| 4 | import ล้ม/ผิด | กู้จาก backup 3.1 (บนฐานว่างเท่านั้น) ; ห้ามรันซ้ำบนฐานที่มีข้อมูล |
| 5 | deploy ผิด | Dashboard -> Deployments -> Rollback to this deployment |
| 6 | smoke ไม่ผ่าน | ไม่ตัด GAS ; แจ้งทีม |
| 7 | ตัด GAS แล้วมีปัญหา | Manage deployments กู้ version ที่จดไว้ (ข้อมูลใน D1 ไม่ย้อนเอง) |
| 8 | ลงมือ cleanup ผิด | orphans : `restore-orphan` ; unshare : แชร์ใหม่ด้วยมือ |

## ลิงก์

- D1 Studio : https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/workers/d1 -> เลือก `prpo-db` -> แท็บ Tables/Console
- Pages project : https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/pages/view/prpo-pdqc
- เอกสารละเอียด : `docs/DEPLOY_CLOUDFLARE.md`

## สิ่งที่ผู้เขียนไม่แน่ใจ (ตรวจก่อนทำ)

1. `--env preview` กับ `d1 migrations apply/execute prpo-db-preview` : wrangler 4 รับ flag `--env` (ตรวจ `--help` แล้ว) แต่ยังไม่ได้ลองว่าหาฐานจาก `[env.preview]` ของ Pages config ได้หรือไม่ ; ทางสำรอง : ใช้ D1 Studio Console ใน Dashboard หรือสั่งด้วย `--config` ที่ชี้ไฟล์ชั่วคราวนอก repo ซึ่งมี `prpo-db-preview` เป็นฐานหลัก
2. `wrangler pages secret put` : อ่านค่าจาก stdin เมื่อถูก pipe และรับ `--env preview` ตามซอร์สใน `node_modules\wrangler\wrangler-dist\cli.js` (ตรวจด้วยการอ่านโค้ด ไม่ได้รันจริง ; flag `--env` ไม่โชว์ใน `--help`) ; pipe ใน Windows PowerShell 5.1 ต่อท้ายด้วย CRLF ซึ่ง wrangler ตัดออก (`trimEnd`) ; ถ้าไม่ได้ผลใช้ Dashboard ตามหมายเหตุในขั้น 1.2
3. บล็อก `[vars]` / `[env.preview.vars]` ใน `wrangler.toml` ใช้ได้กับ Pages ตามเอกสาร wrangler แต่ยังไม่ได้ลอง deploy จริง ; ทางสำรองคือตั้งใน Dashboard
4. ขั้น 5.5 (`scripts/set-user-password.js`) ทดสอบด้วย vitest กับ sqlite ในหน่วยความจำแล้ว (hash verify ผ่านด้วย `verifyPassword` ของ server) แต่ยังไม่ได้รันกับ D1 จริง ; การซ่อนตัวอักษรตอนพิมพ์รหัสต้องรันใน PowerShell แบบ interactive (ไม่ใช่ pipe)
5. ขั้น backfill ที่ใช้ `node:sqlite` โหลดไฟล์ export ยังไม่ได้ทดสอบกับ export จริง (ไม่จำเป็นถ้า D1 ว่างและใช้ import script ปัจจุบัน)
6. ทุกคำสั่งในไฟล์นี้ยังไม่ได้รันกับ Cloudflare/Google จริง
