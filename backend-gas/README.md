# PRPO_PDQC — Google Apps Script Standalone Backend API

โฟลเดอร์นี้บรรจุเฉพาะโค้ด **Backend API** สำหรับรันบน Google Apps Script โดยทำหน้าที่เชื่อมต่อกับ **Google Sheets** เป็นฐานข้อมูล และให้บริการ API แก่ Frontend (GitHub Pages หรือโฮสต์ภายนอก)

---

## ไฟล์ในโฟลเดอร์นี้
- `Code.gs`: จุดรับคำขอหลัก (Entry Point) มี `doPost(e)` สำหรับรับ Web API และ `doGet(e)` สำหรับตรวจสุขภาพระบบ (Health Check) พร้อมตรรกะระบบ PR, PO, Inventory, Budget, Authentication (HMAC-SHA256 Signed Tokens)
- `Config.gs`: ตั้งค่าคงที่, บทบาทสิทธิ์ (Roles), สิทธิ์การเข้าถึงแผนก (Department Scoping), และชื่อแท็บชีต
- `SheetService.gs`: จัดการฐานข้อมูล Google Sheets 17 แท็บ, Mutex Lock (`LockService`), RAM Micro-Caching (`CacheService`), และป้องกัน Formula Injection
- `appsscript.json`: Manifest กำหนดสิทธิ์ OAuth scopes และการเผยแพร่ Web App
- `.clasp.json`: การตั้งค่าสำหรับ Push โค้ดผ่าน Google Clasp CLI

---

## ขั้นตอนการ Deploy Backend

### 1. ล็อกอิน Clasp (หากยังไม่ได้ล็อกอิน)
เปิด Terminal ในโฟลเดอร์นี้แล้วรัน:
```bash
npx clasp login
```

### 2. Push โค้ดขึ้น Google Apps Script
```bash
npx clasp push --force
```

### 3. ตั้งค่า Script Properties บน Google Apps Script
เปิดหน้า Google Apps Script Editor (ผ่าน `npx clasp open` หรือเปิดผ่าน Google Sheets) ไปที่:
**Project Settings (⚙️) → Script Properties → Edit script properties** และเพิ่มตัวแปรดังนี้:

| Property Name | คำอธิบาย | ตัวอย่าง |
|---|---|---|
| `SPREADSHEET_ID` | ไอดีของ Google Spreadsheet ฐานข้อมูลหลัก | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs...` |
| `API_SECRET_KEY` | *(แนะนำ)* คีย์ความปลอดภัยสำหรับจับคู่กับ Frontend | `prpo_secure_key_2026_xyz` |
| `ADMIN_EMAILS` | อีเมลแอดมินสูงสุด (คั่นด้วยจุลภาค) | `admin@company.com` |

> [!NOTE]
> ระบบจะสร้าง `SERVER_SECRET_KEY` สำหรับลงลายมือชื่อดิจิทัล HMAC-SHA256 ให้อัตโนมัติใน Script Properties เพื่อความปลอดภัยสูงสุด

### 4. เผยแพร่เป็น Web App (Deploy)
1. ในหน้า Apps Script กดปุ่มสีน้ำเงิน **Deploy → New deployment**
2. เลือกประเภท: **Web app**
3. ตั้งค่า:
   - **Execute as:** `Me (บัญชีของคุณ)`
   - **Who has access:** `Anyone (ทุกคน)`
4. กด **Deploy** และคัดลอก **Web app URL** (เช่น `https://script.google.com/macros/s/AKfycb.../exec`) เพื่อนำไปใส่ในตัวแปร `VITE_GAS_API_URL` ของฝั่ง Frontend
