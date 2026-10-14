# คู่มือการติดตั้งและ Deploy ระบบ PRPO_PDQC บน Google Apps Script (Production Deployment Guide)

เอกสารนี้รวบรวมขั้นตอนการเตรียมความพร้อม, การบิลด์ Single-File HTML Bundle, การเชื่อมต่อ Google Apps Script ผ่าน Google Clasp CLI และการสั่ง Deploy ระบบขึ้น Production อย่างสมบูรณ์แบบ

---

## สารบัญ
1. [ข้อกำหนดเบื้องต้นของระบบ (Prerequisites)](#1-ข้อกำหนดเบื้องต้นของระบบ-prerequisites)
2. [การเปิดใช้งาน Apps Script API ใน Google Account](#2-การเปิดใช้งาน-apps-script-api-ใน-google-account)
3. [การสร้างโปรเจกต์ Google Sheets & Apps Script](#3-การสร้างโปรเจกต์-google-sheets--apps-script)
4. [การยืนยันตัวตนด้วย Clasp (Clasp Login)](#4-การยืนยันตัวตนด้วย-clasp-clasp-login)
5. [การตั้งค่า Script ID ใน `.clasp.json`](#5-การตั้งค่า-script-id-ใน-claspjson)
6. [การตั้งค่า Script Properties บน Google Apps Script](#6-การตั้งค่า-script-properties-บน-google-apps-script)
7. [คำสั่ง Build และ Deploy แบบอัตโนมัติ (Automation Scripts)](#7-คำสั่ง-build-และ-deploy-แบบอัตโนมัติ-automation-scripts)
8. [การเริ่มต้นระบบครั้งแรก (Initialization & Data Seeding)](#8-การเริ่มต้นระบบครั้งแรก-initialization--data-seeding)
9. [การตั้งค่าการเผยแพร่ Web App (Web App Deployment Settings)](#9-การตั้งค่าการเผยแพร่-web-app-web-app-deployment-settings)
10. [การแก้ไขปัญหาทั่วไป (Troubleshooting)](#10-การแก้ไขปัญหาทั่วไป-troubleshooting)

---

## 1. ข้อกำหนดเบื้องต้นของระบบ (Prerequisites)
- **Node.js**: เวอร์ชัน `>= 20.0.0`
- **npm**: เวอร์ชัน `>= 10.0.0`
- บัญชี Google Workspace หรือ Google Account สำหรับองค์กรที่มีสิทธิ์เข้าถึง Google Drive และ Google Sheets

---

## 2. การเปิดใช้งาน Apps Script API ใน Google Account
ก่อนสั่งรันคำสั่งผ่าน Clasp จำเป็นต้องเปิดใช้งาน Apps Script API ในบัญชี Google เสียก่อน:
1. เข้าไปที่: [https://script.google.com/home/usersettings](https://script.google.com/home/usersettings)
2. เลื่อนลงมาที่หัวข้อ **Google Apps Script API**
3. ปรับสถานะเป็น **เปิด (ON)**

---

## 3. การสร้างโปรเจกต์ Google Sheets & Apps Script
1. เปิด [Google Drive](https://drive.google.com/) ขององค์กร
2. สร้าง Google Spreadsheet ใหม่ ตั้งชื่อว่า `[DATABASE] PR-PO-Stock-System`
3. คัดลอก **Spreadsheet ID** จาก URL ในแถบที่อยู่:
   ```
   https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit
   ```
4. ในหน้า Google Sheets ให้ไปที่เมนู **ส่วนขยาย (Extensions) → Apps Script**
5. ตั้งชื่อโปรเจกต์ Apps Script ด้านบน เช่น `PRPO_PDQC_Backend`
6. ไปที่เมนู **Project Settings (ไอคอนรูปฟันเฟือง ⚙️) → Script ID**
7. คัดลอก **Script ID** เก็บไว้สำหรับใช้ในขั้นตอนที่ 5

---

## 4. การยืนยันตัวตนด้วย Clasp (Clasp Login)
เปิด Terminal ในโฟลเดอร์โปรเจกต์ แล้วรันคำสั่ง:
```bash
npx clasp login
```
เบราว์เซอร์จะเปิดขึ้นมาเพื่อให้เข้าสู่ระบบด้วย Google Account ของคุณ:
1. เลือกบัญชี Google ที่เป็นเจ้าของโปรเจกต์ Apps Script
2. กดยืนยันการให้สิทธิ์ (Allow Permissions)
3. เมื่อหน้าต่างแสดงข้อความ `Logged in! You may close this page.` ให้ปิดหน้าต่างเบราว์เซอร์ได้ทันที
*(โทเคนยืนยันตัวตนจะถูกบันทึกไว้ใน `~/.clasprc.json` โดยอัตโนมัติ และปลอดภัยจาก Git Version Control)*

---

## 5. การตั้งค่า Script ID ใน `.clasp.json`
ไฟล์ `.clasp.json` ใช้สำหรับระบุโปรเจกต์ปลายทางที่จะ Push โค้ดขึ้นไป:
1. หากยังไม่มีไฟล์ `.clasp.json` ให้คัดลอกไฟล์ต้นแบบ:
   ```bash
   cp .clasp.json.sample .clasp.json
   ```
2. เปิดไฟล์ `.clasp.json` แล้วนำ Script ID ที่ได้จากขั้นตอนที่ 3 มาใส่:
   ```json
   {
     "scriptId": "1a2b3c4d5e6f7g8h9i0j_YOUR_ACTUAL_SCRIPT_ID_HERE",
     "rootDir": "gas-deploy"
   }
   ```
> [!IMPORTANT]
> ไฟล์ `.clasp.json` ถูกระบุไว้ใน `.gitignore` เรียบร้อยแล้ว ข้อมูล Script ID ของคุณจะไม่ถูก Commit ขึ้น Git อย่างแน่นอน

---

## 6. การตั้งค่า Script Properties บน Google Apps Script
ในหน้าต่าง Apps Script Editor ไปที่ **Project Settings (⚙️) → ด้านล่างสุดที่หัวข้อ Script Properties → Edit script properties**:
เพิ่มตัวแปรระบบ 3 รายการดังนี้:

| Property Name | ค่าที่ต้องระบุ | ตัวอย่าง |
|---|---|---|
| `SPREADSHEET_ID` | ไอดีของ Google Spreadsheet หลัก (จากขั้นตอนที่ 3) | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` |
| `ADMIN_EMAILS` | อีเมลของผู้ดูแลระบบที่ได้รับสิทธิ์ Admin สูงสุด (คั่นด้วยจุลภาค) | `admin@company.com,director@company.com` |
| `APP_ENV` | สภาพแวดล้อมระบบ | `production` |

---

## 7. คำสั่ง Build และ Deploy แบบอัตโนมัติ (Automation Scripts)

ใน `package.json` ได้จัดเตรียมชุดคำสั่งสำหรับการบิลด์และดีพลอยไว้ให้พร้อมใช้งานทันที:

### A. บิลด์ Frontend เป็น Single-File HTML Bundle
```bash
npm run build:gas
```
- คอมไพล์ React SPA, CSS (Tailwind/Vanilla) และ Assets ทั้งหมดให้ Inline เข้าเป็นไฟล์ HTML เดี่ยวสมบูรณ์ไว้ที่ `dist-gas/index.html`

### B. จัดเตรียมโฟลเดอร์ Staging สำหรับ Deploy
```bash
npm run prepare:gas
```
- รวบรวมไฟล์ `.gs` ทั้งหมด (8 ไฟล์), `appsscript.json`, และ `dist-gas/index.html` เข้าสู่โฟลเดอร์ `gas-deploy/` พร้อมตรวจสอบความสมบูรณ์

### C. บิลด์และจัดเตรียมแบบขั้นตอนเดียว
```bash
npm run gas:build
```

### D. ตรวจสอบสถานะการเชื่อมต่อ Clasp
```bash
npm run gas:status
```
- ตรวจสอบรายการไฟล์ที่พร้อมสำหรับการ Push ขึ้น Google Apps Script

### E. Push โค้ดขึ้น Apps Script
```bash
npm run gas:push
```
- สั่งบิลด์ ล่าสุด และพุชไฟล์ทั้งหมดใน `gas-deploy/` ขึ้นสู่คลาวด์

### F. One-Click Full Deployment (Production Release) 🚀
```bash
npm run gas:deploy
```
คำสั่งเดียวที่ทำงานครบวงจร:
1. รัน Static Code Quality Gate (`npm run lint`)
2. รันชุดทดสอบทั้งหมด 306 ข้อ (`npm test`)
3. คอมไพล์ Single HTML Bundle (`npm run build:gas`)
4. จัดเตรียมและตรวจสอบโฟลเดอร์ Staging (`npm run prepare:gas`)
5. ตรวจสอบสิทธิ์ Clasp
6. Push โค้ดขึ้น Apps Script (`clasp push`)
7. สร้าง Deployment Version ใหม่บน Production (`clasp deploy`) พร้อมบันทึกประวัติ Release

---

## 8. การเริ่มต้นระบบครั้งแรก (Initialization & Data Seeding)
เมื่อดีพลอยโค้ดขึ้นสู่ Apps Script เป็นครั้งแรก:
1. เปิดหน้าต่าง Apps Script Editor
2. ที่แถบเครื่องมือด้านบน เลือกฟังก์ชัน `initializeSystem` แล้วกดปุ่ม **Run**
   - ให้สิทธิ์ความปลอดภัย (Authorization) ตามที่ Google ร้องขอ
   - ระบบจะสร้างแท็บชีตทั้ง 17 แท็บ, สร้าง Headers สี Dark Slate, ตรึงแถวที่ 1 และสร้างโครงสร้างโฟลเดอร์ใน Google Drive ให้โดยอัตโนมัติ
3. เลือกฟังก์ชัน `seedInitialMasterData` แล้วกดปุ่ม **Run**
   - ระบบจะนำเข้าข้อมูลแผนกเริ่มต้น (PD, QC, ALL), หน่วยการใช้งาน, จุดเก็บสินค้า, โครงร่างงบประมาณ และบัญชีผู้ใช้เริ่มต้น

---

## 9. การตั้งค่าการเผยแพร่ Web App (Web App Deployment Settings)
1. ในหน้า Apps Script Editor กดปุ่มสีน้ำเงิน **Deploy → Manage deployments**
2. คลิกไอคอนรูปดินสอที่หัวข้อ **Web app** หรือแก้ไข Deployment เดิม
3. ตั้งค่าการเข้าถึงตามมาตรฐานของระบบ (Standard Settings):
   - **ดำเนินการในฐานะ (Execute as):** `ฉัน (Me / tharn.s1999@gmail.com)` — ให้ระบบทำงานภายใต้สิทธิ์ของเจ้าของโปรเจกต์
   - **ผู้ที่มีสิทธิ์เข้าถึง (Who has access):** `ทุกคน (Anyone)` — เพื่อให้ทุกคนสามารถเข้าถึงลิงก์ Web App ได้โดยไม่มีข้อจำกัด Domain
4. กดปุ่ม **Deploy**
5. คัดลอก **Web app URL** (เช่น `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`) สำหรับส่งให้ทีมงานเข้าใช้งาน

---

## 10. การแก้ไขปัญหาทั่วไป (Troubleshooting)

### ปัญหาที่ 1: `clasp: command not found`
- **วิธีแก้:** รันผ่าน `npx clasp` หรือตรวจสอบว่าได้รัน `npm install` เรียบร้อยแล้ว

### ปัญหาที่ 2: `Error: Invalid scriptId`
- **วิธีแก้:** ตรวจสอบว่าในไฟล์ `.clasp.json` ได้ระบุ Script ID จริงแทนข้อความ placeholder แล้ว

### ปัญหาที่ 3: `GaxiosError: User has not enabled the Apps Script API`
- **วิธีแก้:** ไปที่ [https://script.google.com/home/usersettings](https://script.google.com/home/usersettings) แล้วเปิด Google Apps Script API เป็น **ON**

### ปัญหาที่ 4: หน้าเว็บแสดงผลค้างหรือขึ้นว่า `GAS BACKEND ACTIVE`
- **วิธีแก้:** เกิดจากยังไม่ได้ Push ไฟล์ `index.html` ขึ้นไป ให้รันคำสั่ง `npm run gas:push` อีกครั้ง แล้วกด Refresh หน้าเว็บ
