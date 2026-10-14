# Requirement: ที่เก็บไฟล์แนบ — R2 ตอนนี้, ย้ายไป Google Shared Drive ได้ภายหลัง

ผู้ใช้ตัดสิน 2026-10-13: "เขียนโค้ดไว้รอ Shared Drive แต่ตอนนี้ทำ R2 ไปก่อน และวางแผนเผื่อย้ายไปเก็บ Google Drive"
เหตุผล: บัญชี Google ของผู้ใช้เป็น Gmail ส่วนตัว สร้าง Shared Drive ไม่ได้ Service Account จึงอัปโหลดลง My Drive ไม่ได้ (ไม่มีโควตา) ; R2 ฟรี 10 GB/เดือน พอใช้หลายปี
เป็นการเปลี่ยนสถาปัตยกรรม → Neo ต้อง consult Fable ก่อนเริ่ม ; งานแตะการเชื่อมต่อภายนอก → kla-security ตรวจทันทีหลัง QA

## 1. เป้าหมาย
- ไฟล์แนบ (PR/PO/GRN/หลักฐานเคลม/ลายเซ็น ฯลฯ) ขึ้น R2 ได้ทันที โดย **UI และ API ที่ client เรียกไม่เปลี่ยน** (`POST /api/upload`, `GET /api/files/:id`, admin endpoints เดิม)
- โค้ด Drive เดิม (`functions/_lib/drive.js`) **ไม่ลบ** คงไว้เป็นอีก backend สลับด้วยตัวแปรเดียว
- ฐานข้อมูลรองรับไฟล์ "ปน" สองที่เก็บได้พร้อมกัน (ระหว่างย้าย) และย้ายกลับได้ (rollback)

## 2. โครงสร้างโค้ด (functions/_lib)
```
storage/
  index.js        getStorage(env) → adapter ตาม env.FILE_STORAGE ('r2' = ค่าเริ่มต้น | 'drive') ; getStorageFor(row) → adapter ตาม attachments.storage ของแถวนั้น (ใช้ตอนอ่าน/ลบ/กู้ ห้ามใช้ env)
  r2.js           adapter R2 (binding env.FILES)
  drive-adapter.js ห่อ drive.js เดิมให้เป็น interface เดียวกัน (ไม่แก้ logic Drive)
```
interface เดียวกันทั้งสอง adapter (ทุกฟังก์ชัน async):
| ฟังก์ชัน | หน้าที่ | R2 | Drive |
|---|---|---|---|
| `put({ name, mimeType, bytes, category, docRef, uploaderId, date })` | เก็บไฟล์ คืน `{ fileId, storage, objectKey, size, mimeType, name }` | key ตามข้อ 3, `fileId` = uuid ใหม่ | `uploadFile` + `ensureFolderPath` เดิม, `fileId` = Drive id |
| `head(ref)` | metadata `{ size, mimeType, name, exists }` | `bucket.head(key)` | `getFileMetadata` |
| `open(ref)` | stream สำหรับ proxy `{ body, mimeType, size, name }` | `bucket.get(key)` | `openFileMedia` |
| `trash(ref)` / `untrash(ref)` | ย้ายเข้า/ออกถังขยะ (ใช้โดย cleanup-orphans / restore-orphan) | copy ไป `trash/<key>` แล้ว delete ต้นทาง / ย้อนกลับ ; ลบถาวรเฉพาะ job ล้าง trash เกิน 30 วัน (ยังไม่ทำ แค่ออกแบบ) | `trashFile` / `untrashFile` |
| `makePrivate(ref)` | ถอดสิทธิ์สาธารณะ (unshare-public) | no-op คืน `{ skipped: 'ALWAYS_PRIVATE' }` | `listFilePermissions` + `deleteFilePermission` เดิม |
| `publicUrl(ref)` | ลิงก์สำหรับ UI | คืน `/api/files/:fileId` เสมอ | `driveUrls` เดิม (แต่ M4 ให้ UI เปิดผ่าน proxy อยู่แล้ว) |
`ref` = `{ fileId, objectKey, storage }` จากแถว attachments ; **ห้าม** รับ objectKey/fileId จาก client โดยตรง ต้อง resolve ผ่าน attachments + file_refs (กัน IDOR เหมือน P5)
`validateUpload`, `sanitizeFileName`, `ALLOWED_MIME_TYPES`, `MAX_FILE_SIZE_BYTES`, magic bytes, `publicError` ใช้ร่วมกันทั้งสอง backend (ย้ายไป `storage/common.js` หรือ re-export จาก drive.js)

## 3. R2
- binding `FILES` ; bucket production `prpo-files`, preview `prpo-files-preview` (ผู้ใช้/Neo สร้างด้วย `npx wrangler r2 bucket create` หลังผู้ใช้เปิด R2 ใน Dashboard)
- object key: `<category>/<YYYY>/<MM>/<docRef หรือ _unassigned>/<fileId>__<sanitizedName>` (category ตาม `DRIVE_CATEGORIES` เดิม เพื่อให้โครงเดียวกับโฟลเดอร์ Drive ตอนย้าย)
- `customMetadata`: `{ name, mimeType, uploaderId, docRef, category, uploadedAt }` ; `httpMetadata.contentType` = mime ที่ตรวจแล้ว
- ไฟล์ส่วนตัวเสมอ ไม่เปิด public bucket / r2.dev ; อ่านผ่าน `/api/files/:id` (ตรวจสิทธิ์ตามเอกสาร, nosniff, Content-Disposition เดิม)
- wrangler.toml:
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
- local/e2e: miniflare รองรับ R2 `--local` อยู่แล้ว ; เพิ่ม binding ใน `playwright.cf.config.js` / `.dev.vars.example` ; e2e อัปโหลดจริงลง R2 local 1 เคส
- ถ้า `FILE_STORAGE=drive` แต่ไม่มี `GOOGLE_SA_*` → 503 `publicError` แบบเดิม ; ถ้า `FILE_STORAGE=r2` แต่ไม่มี binding `FILES` → 503 ข้อความชัด (ไม่ล้มทั้งแอป)

## 4. ฐานข้อมูล (migration 0013, ไม่มี DROP)
```sql
ALTER TABLE attachments ADD COLUMN storage TEXT NOT NULL DEFAULT 'drive';   -- 'drive' | 'r2'
ALTER TABLE attachments ADD COLUMN objectKey TEXT;                           -- R2 key (NULL สำหรับ drive)
ALTER TABLE attachments ADD COLUMN migratedFrom TEXT;                        -- 'r2:<key>' หรือ 'drive:<id>' หลังย้าย (เพื่อ rollback)
CREATE INDEX IF NOT EXISTS idx_attachments_storage ON attachments(storage);
```
- แถวเดิมทั้งหมด = 'drive' (ถูกต้อง เพราะเคยเก็บ Drive) ; แถวใหม่ = ค่า `storage` ที่ adapter คืน
- `file_refs` / backfill / `fileIdsIn` ไม่เปลี่ยน (ยังอ้าง `fileId`)
- `scripts/import-sheets-to-d1.js`: ไฟล์แนบจากชีตเดิมอ้าง Drive id → ใส่ `storage='drive'`

## 5. จุดที่ต้องแก้ (ให้ Neo แตก task)
| ไฟล์ | งาน |
|---|---|
| `functions/_lib/storage/*` | ใหม่ตามข้อ 2-3 + unit test ด้วย fake R2Bucket (put/head/get/copy/delete) |
| `functions/_lib/upload.js` | เรียก `getStorage(env).put` ; บันทึก `storage/objectKey` ลง attachments |
| `functions/_lib/files.js` | `getStorageFor(row).open/head` ; header เดิม ; 404 เหมือนเดิมเมื่อไม่มีสิทธิ์ |
| `functions/_lib/orphans.js` | trash/untrash ผ่าน adapter ของแถว ; dry-run เดิม |
| `functions/_lib/unshare.js` | ข้ามแถว `storage='r2'` (รายงานเป็น `ALWAYS_PRIVATE`) |
| `functions/api/[[route]].js` | จุดที่สร้าง URL ไฟล์/ลายเซ็น ให้ใช้ `publicUrl` ของ adapter |
| `migrations/0013_attachments_storage.sql` | ตามข้อ 4 |
| `wrangler.toml`, `wrangler.toml.example`, `scripts/prepare-cloudflare.js` (template), `.dev.vars.example`, `playwright.cf.config.js`, `e2e/cf/seed.mjs` | binding + var |
| `docs/M2_RUNBOOK.md` ขั้น 1 | แทน Service Account ด้วย "เปิด R2 → สร้าง bucket 2 ใบ" ; ย้ายส่วน SA/Shared Drive ไปหัวข้อ "ภายหลังเมื่อมี Google Workspace" |
| `docs/DEPLOY_CLOUDFLARE.md`, `docs/parity.md` | อัปเดต |
| `tests/` | adapter ทั้งสอง, upload/files/orphans/unshare กับ storage ปน, migrations_sync, no_backdoor (ห้ามมี public URL ของ R2) |

ข้อห้าม: ไม่เปลี่ยน UI/flow ของผู้ใช้ ; ไม่ลบ `drive.js` ; ไม่เปิด public access บน bucket ; ไม่รับ key จาก client ; ขนาด/ชนิดไฟล์ที่รับคงเดิม

## 6. แผนย้ายไป Google Shared Drive ภายหลัง (ออกแบบไว้ ยังไม่เขียนโค้ดในรอบนี้ ยกเว้นข้อ 6.1)
เงื่อนไขเริ่ม: มีบัญชี Google Workspace + Shared Drive + Service Account เป็น Content manager (runbook หัวข้อ SA เดิม)
1. **6.1 (ทำในรอบนี้)**: โครง `scripts/migrate-files.js --from r2 --to drive [--dry-run] [--limit N] [--doc <docRef>]` ที่รันได้แค่ `--dry-run` (นับไฟล์/ขนาด/ประมาณเวลา) ส่วนย้ายจริงปล่อย `TODO` พร้อม interface ชัด
2. ย้ายจริง (รอบหน้า): ต่อแถว `attachments WHERE storage='r2'` ครั้งละ 20 → `open` จาก R2 → `put` ลง Drive (โฟลเดอร์ตาม category/docRef/date เดิม) → ตรวจ size + sha256 ตรง → UPDATE แถว (`storage='drive'`, `fileId`=Drive id, `migratedFrom='r2:<key>'`) ใน statement เดียว → เก็บ R2 object ไว้ 30 วันก่อนลบ (ไม่ลบทันที) ; idempotent รันซ้ำได้ ; บันทึก audit_logs ; ทำย้อนทาง `--from drive --to r2` ได้สำหรับ rollback
3. สลับไฟล์ใหม่: ตั้ง `FILE_STORAGE=drive` + secrets SA แล้ว deploy ; ไฟล์เก่าที่ยังเป็น r2 เปิดได้ต่อเนื่องเพราะอ่านตามแถว
4. `file_refs`/`fileId` ของเอกสาร (itemsJson, evidenceJson, attachmentsJson) ที่ฝัง fileId เดิม: สคริปต์ต้องอัปเดตจุดอ้างอิงเหล่านั้นด้วย (ใช้ `fileIdsIn` ของ P5 หาจุด) — ระบุใน dry-run ว่าเอกสารใดจะถูกแก้

## 7. ขั้นตอนฝั่งผู้ใช้ (ไม่ใช่งานทีม)
1. Dashboard → R2 Object Storage → เปิดใช้งาน (ต้องเพิ่มวิธีชำระเงิน ใช้ส่วนฟรีไม่ถูกเรียกเก็บ)
2. แจ้ง Claude/Neo ให้รัน `npx wrangler r2 bucket create prpo-files` และ `prpo-files-preview`
3. deploy Preview → ทดสอบแนบไฟล์ใน PR/GRN → เปิดดูผ่าน `/api/files/:id`
