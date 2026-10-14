# archive/

โฟลเดอร์เก็บของเก่าที่ไม่ได้ใช้งานแล้ว (เก็บไว้เพื่ออ้างอิง ไม่ลบ)

## สถานะปัจจุบัน (2026-10-12)

- ย้าย `cloudflare/src/` → `archive/cloudflare-src-2026-10-12/src/` แล้ว (168 ไฟล์, ผู้ใช้อนุมัติ ดำเนินการ 2026-10-12)
- ลบสำเนา `cloudflare/migrations/` (9 ไฟล์ ตรงกับ root ทุกไฟล์) และไฟล์ temp `dbg_tmp.mjs`, `vt_report_tmp.cjs`, `vt_result_tmp.json` แล้ว โดยส่งไป Recycle Bin (กู้คืนได้จากถังขยะ Windows)
- build/deploy จาก root เท่านั้น (`npm run build:cf` ที่ root)

## cloudflare-src-2026-10-12/src/

- คือสำเนา frontend (`src/`) ชุดเก่าที่เคยอยู่ใน `cloudflare/src/`
- frontend รวมเป็น `src/` ชุดเดียวที่ root แล้ว deploy จาก root ด้วย `npm run build:cf`
- สคริปต์ `scripts/prepare-cloudflare.js` โหมดเต็มยังคัดลอก `src/` ไปที่ `cloudflare/src/` ได้ แต่จะพิมพ์คำเตือนว่าเป็นสำเนา ห้ามใช้เป็นแหล่งจริง
- Vitest, oxlint (`.oxlintrc.json` มี `ignorePatterns: ["archive/**"]`) และ Vite build ไม่อ่านโฟลเดอร์นี้

## วิธีย้าย (ผู้ใช้รันเอง รันจากโฟลเดอร์ root ของโปรเจกต์)

```
New-Item -ItemType Directory -Force -Path "archive\cloudflare-src-2026-10-12"
Move-Item -LiteralPath "cloudflare\src" -Destination "archive\cloudflare-src-2026-10-12\src"
```

## วิธีกู้คืน (ใช้เฉพาะหลังย้ายแล้ว)

ถ้าโฟลเดอร์อยู่ที่ `archive\cloudflare-src-2026-10-12\src` แล้ว ให้คัดลอกกลับ:

```
Copy-Item -LiteralPath "archive\cloudflare-src-2026-10-12\src" -Destination "cloudflare\src" -Recurse
```
