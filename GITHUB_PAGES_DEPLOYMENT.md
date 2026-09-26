# คู่มือการตั้งค่าและ Deploy ระบบ PRPO_PDQC (GitHub Pages + Google Apps Script)

เอกสารนี้อธิบายขั้นตอนการติดตั้งและตั้งค่าระบบในรูปแบบ **Decoupled Architecture**:
- **Frontend:** โฮสต์อยู่บน GitHub Pages
- **Backend:** รันอยู่บน Google Apps Script (`backend-gas/`)
- **Database:** Google Sheets

---

## สารบัญ
1. [ขั้นตอนที่ 1: Deploy Backend บน Google Apps Script](#ขั้นตอนที่-1-deploy-backend-บน-google-apps-script)
2. [ขั้นตอนที่ 2: ตั้งค่า Repository บน GitHub](#ขั้นตอนที่-2-ตั้งค่า-repository-บน-github)
3. [ขั้นตอนที่ 3: เปิดใช้งาน GitHub Pages](#ขั้นตอนที่-3-เปิดใช้งาน-github-pages)
4. [ขั้นตอนที่ 4: การเข้าใช้งานและการทดสอบ](#ขั้นตอนที่-4-การเข้าใช้งานและการทดสอบ)
5. [การจัดการความปลอดภัยและแก้ไขปัญหา](#การจัดการความปลอดภัยและแก้ไขปัญหา)

---

## ขั้นตอนที่ 1: Deploy Backend บน Google Apps Script

1. **เข้าสู่โฟลเดอร์ Backend:**
   เปิด Terminal แล้วเข้าไปที่โฟลเดอร์ `backend-gas/`
   ```bash
   cd backend-gas
   ```

2. **Push โค้ดขึ้น Google Apps Script:**
   ```bash
   npx clasp push --force
   ```

3. **ตั้งค่า Script Properties บน Google Apps Script:**
   - เปิดหน้าต่าง Apps Script Editor (หรือพิมพ์ `npx clasp open`)
   - ไปที่ **Project Settings (⚙️) → ด้านล่างสุดที่หัวข้อ Script Properties → Edit script properties**
   - เพิ่มตัวแปร 3 รายการ:

   | Property Name | ค่าที่ต้องระบุ | คำอธิบาย |
   |---|---|---|
   | `SPREADSHEET_ID` | ไอดีของ Google Spreadsheet หลัก | เช่น `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs...` |
   | `API_SECRET_KEY` | คีย์ความลับสำหรับตรวจสอบคำขอ | ตั้งรหัสผ่านสุ่ม เช่น `prpo_secret_2026_xyz` |
   | `ADMIN_EMAILS` | อีเมลของผู้ดูแลระบบหลัก | เช่น `admin@yourcompany.com` |

   > [!NOTE]
   > ตัวแปร `SERVER_SECRET_KEY` สำหรับลงลายมือชื่อดิจิทัล HMAC-SHA256 ระบบจะสร้างขึ้นให้อัตโนมัติในครั้งแรกที่ทำงาน

4. **เผยแพร่เป็น Web App (New Deployment):**
   - ที่มุมขวาบนของหน้า Apps Script กดปุ่มสีน้ำเงิน **Deploy → New deployment**
   - คลิกที่รูปฟันเฟือง ⚙️ เลือก **Web app**
   - ตั้งค่า:
     - **Description:** `Production API v3.1`
     - **Execute as:** `Me (บัญชีของคุณ)`
     - **Who has access:** `Anyone (ทุกคน)`
   - กด **Deploy** และ **คัดลอก Web app URL** เก็บไว้ เช่น:
     `https://script.google.com/macros/s/AKfycb.../exec`

---

## ขั้นตอนที่ 2: ตั้งค่า Repository บน GitHub

1. **เพิ่ม Secrets บน GitHub Repository:**
   - ไปที่หน้า Repository ของคุณบน GitHub: `https://github.com/tharns1999-cmyk/PRPO_PDQC`
   - คลิกเมนู **Settings** ด้านบน
   - ที่แถบซ้ายมือ เลือก **Secrets and variables → Actions**
   - กดปุ่ม **New repository secret** เพิ่ม 2 ค่า:
     - **Name:** `VITE_GAS_API_URL`
       **Value:** วาง Web App URL ที่ได้จากขั้นตอนที่ 1
     - **Name:** `VITE_API_SECRET_KEY`
       **Value:** รหัสลับเดียวกับที่ตั้งไว้ใน `API_SECRET_KEY` ของ Script Properties

---

## ขั้นตอนที่ 3: เปิดใช้งาน GitHub Pages

1. ในหน้า GitHub Repo ของคุณ ไปที่ **Settings → Pages**
2. ที่หัวข้อ **Build and deployment → Source**:
   - เลือก **GitHub Actions**
3. ทุกครั้งที่คุณสั่ง `git push` โค้ดขึ้น branch `main`:
   - GitHub Actions (`.github/workflows/deploy.yml`) จะเริ่ม Build และ Deploy ขึ้น GitHub Pages ให้โดยอัตโนมัติ
   - คุณสามารถดูสถานะการ Deploy ได้ที่แท็บ **Actions**

---

## ขั้นตอนที่ 4: การเข้าใช้งานและการทดสอบ

1. เมื่อ Deploy เสร็จสิ้น ลิงก์เข้าใช้งานจะเป็นรูปแบบ:
   ```
   https://tharns1999-cmyk.github.io/PRPO_PDQC/
   ```
2. เมื่อเปิดหน้าเว็บ:
   - ระบบจะใช้ **HashRouter (`/#/login`)** ป้องกันปัญหา 404 ตอน Refresh หน้าเว็บ
   - เมื่อล็อกอิน Backend จะส่ง **HMAC-SHA256 Signed Token** กลับมาเก็บไว้ที่เบราว์เซอร์อย่างปลอดภัย
   - สิทธิ์ของผู้ใช้ (Admin, Approver, Requester, Department) จะถูกตรวจทานจากลายเซ็นดิจิทัลของ Server เสมอ

---

## การจัดการความปลอดภัยและแก้ไขปัญหา

### ปัญหาที่ 1: หน้าเว็บขึ้นว่า `GAS_URL_NOT_CONFIGURED`
- เกิดจากยังไม่ได้ตั้งค่า Secret `VITE_GAS_API_URL` บน GitHub หรือไม่ได้ใส่ในไฟล์ `.env`
- สามารถทดสอบแบบด่วนบนเบราว์เซอร์ได้โดยเปิด DevTools Console แล้วพิมพ์:
  ```javascript
  localStorage.setItem('prpo_gas_api_url', 'URL_ของ_GAS_ที่คุณได้');
  location.reload();
  ```

### ปัญหาที่ 2: Error `UNAUTHORIZED_TOKEN`
- เกิดจากเซสชันเดิมหมดอายุ (โทเคนมีอายุ 8 ชั่วโมง) ให้กด Logout แล้ว Login ใหม่อีกครั้ง
