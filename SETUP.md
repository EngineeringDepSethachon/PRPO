# ตั้งค่า Fable Office (Migrate Team) — คำสั่งสำหรับ Claude Code

อ่านไฟล์นี้แล้วทำตามลำดับด้านล่างทั้งหมดในโฟลเดอร์นี้ (`PRPO/`) ไม่ต้องถามก่อนแต่ละขั้น
ยกเว้นข้อที่บอกว่า "หยุดและถามผู้ใช้"

## เป้าหมาย
เปิดใช้งาน Fable Office: หน้าเว็บออฟฟิศพิกเซลที่รัน Neo เป็นหัวหน้าทีม Migrate Team (session หลัก)
สั่งงาน subagent หลายโมเดล มี Fable เป็นผู้บริหารในห้อง Executive และให้ผู้ใช้คุย/อนุมัติงานผ่านเบราว์เซอร์

## ขั้นตอน

1. **ตรวจ Node.js**
   รัน `node -v` ต้องได้ 20 ขึ้นไป (โปรเจกต์ PRPO ต้องการ 20+) ถ้าไม่มีหรือเก่ากว่านั้น หยุดและถามผู้ใช้ให้ติดตั้ง/อัปเดตจาก nodejs.org

2. **ตรวจว่ากำลังรันเองอยู่ในนี้**
   ไฟล์นี้ถูกออกแบบมาให้ Claude Code ตัวที่กำลังอ่านอยู่ *เป็น Neo* และ *รันเอง* ผ่านหน้าเว็บ
   ไม่ต้องสั่ง `claude` ซ้อนตัวเองจากในนี้ — แค่เตรียมไฟล์ให้พร้อม แล้วบอกผู้ใช้ให้ปิด session นี้
   แล้วเปิดใหม่ด้วยคำสั่งในข้อ 6

3. **ติดตั้งพนักงาน (คัดลอก claude-setup/ → .claude/)**
   รัน:
   ```
   node office/setup.js
   ```
   ถ้ามี `.claude/agents/` หรือ `.claude/settings.json` อยู่ก่อนแล้ว และเนื้อหาต่างจาก
   `claude-setup/` ให้หยุดและถามผู้ใช้ว่าจะรวมเอง หรือให้รัน `node office/setup.js --force` ทับ

4. **สร้าง/อัปเดตห้องผู้บริหาร (Fable)**
   รัน:
   ```
   node office/new-exec.js
   ```
   ได้ `departments/executive/` (CLAUDE.md, `.claude/settings.json`, `.claude/hooks/exec-guard.js`, `docs/whiteboard.md`)
   ถ้าต้องการเขียนทับ CLAUDE.md/settings ของห้องนี้จากแม่แบบ ใช้ `node office/new-exec.js --refresh`
   ต้องมี `departments/executive/.claude/package.json` (`"type": "commonjs"`) อยู่ด้วย — ถ้าหาย ให้สร้างใหม่ เพราะ package.json รากโปรเจกต์ตั้ง `"type": "module"` และ hook เป็น CommonJS

5. **ตรวจไฟล์ครบ**
   ควรมีไฟล์เหล่านี้หลังข้อ 3-4:
   - `.claude/agents/somchai-planner.md`, `malee-coder.md`, `nong-coder.md`, `prae-qa.md`, `kla-security.md`, `kafae-scribe.md`
   - `.claude/settings.json`, `.claude/package.json`, `.claude/hooks/whiteboard-only.js`
   - `office/server.js`, `office/ask.js`, `office/consult.js`, `office/memo.js`, `office/index.html`, `office/departments.json`, `office/package.json`
   - `departments/executive/CLAUDE.md`, `departments/executive/.claude/settings.json`
   - `CLAUDE.md` ที่รากโฟลเดอร์ (มีหัวข้อ "บทบาท: Neo (opus) = หัวหน้าโปรเจกต์ Migrate Team")
   - `docs/whiteboard.md`, `docs/tasks.md`
   ถ้าไฟล์ไหนหาย ให้รายงานกลับและหยุด แทนที่จะเขียนไฟล์ใหม่เอง (ต้นฉบับอยู่ที่โปรเจกต์ `Lazy dough/` ของผู้ใช้)

6. **สรุปให้ผู้ใช้**
   บอกผู้ใช้ว่าพร้อมแล้ว และให้เปิดเองด้วยคำสั่งนี้ในโฟลเดอร์เดียวกัน (**คนละ terminal/session จากตอนนี้**) หรือดับเบิลคลิก `Start-Office.bat`:
   ```
   npm run office
   ```
   เบราว์เซอร์จะเปิดอัตโนมัติ (`Start-Office.bat` และ shortcut "PRPO Office" บน Desktop ใช้พอร์ต `4778` เพื่อรันคู่กับออฟฟิศ Lazy dough ที่พอร์ต 4777 ได้ ; `npm run office` ตรง ๆ ใช้ 4777) พิมพ์สั่งงาน Neo ในแชทด้านขวาได้เลย
   สลับไปห้อง Executive เพื่อคุย/ดูคิวอนุมัติของ Fable

   > ครั้งแรกต้องเปิด `claude` ในโฟลเดอร์ `departments/executive` หนึ่งครั้งเพื่อกด trust ไม่งั้นห้อง Fable จะไม่ตอบ
   > เหตุผลที่ต้องเปิด session ใหม่: `npm run office` จะรันโปรเซส `claude` เองแบบ headless
   > เพื่อขับเคลื่อนตัวละครในหน้าเว็บ ถ้ารันซ้อนจาก session ปัจจุบันจะชนกัน

## ถ้ามีปัญหา

| อาการ | วิธีตรวจ |
|---|---|
| `npm run office` บอกว่าไม่รู้จักคำสั่ง `claude` | รัน `claude --version` เช็กว่าติดตั้ง CLI แล้วและอยู่ใน PATH |
| `ReferenceError: require is not defined in ES module scope` | หาย `office/package.json` หรือ `.claude/package.json` หรือ `departments/executive/.claude/package.json` (`"type": "commonjs"`) — สร้างใหม่ |
| หน้าเว็บเปิดแต่ขึ้น "ขาดการเชื่อมต่อ" | terminal ที่รัน `npm run office` ถูกปิดไปแล้ว ต้องรันใหม่ |
| หน้าเว็บไม่มีตัวละครขึ้นเลย | เช็ก `.claude/agents/*.md` ว่ามีครบและมีบรรทัด `name:`/`model:` ในแต่ละไฟล์ |
| Neo ไม่มอบงานให้ subagent เลย | เปิดไฟล์ `CLAUDE.md` เช็กว่าอยู่ที่รากโฟลเดอร์ (ไม่ใช่ใน `.claude/`) |
| ห้อง Executive ไม่ตอบ | เปิด `claude` ใน `departments/executive` หนึ่งครั้งแล้วกด trust ; เช็ก `departments/executive/CLAUDE.md` |
| อยากเปลี่ยนโมเดลของใครสักคน | แก้บรรทัด `model:` ใน `claude-setup/agents/<ชื่อ>.md` แล้วรัน `node office/setup.js --force` |
| ทดสอบระบบออฟฟิศเอง | `npm run office:test` (รันทีละไฟล์ เพราะเทสต์ server ใช้พอร์ต 4799 ร่วมกัน ถ้ารันขนานจะชนกันเอง) |

เสร็จแล้วรายงานสั้น ๆ ว่าทำอะไรไปบ้าง และให้ผู้ใช้สั่งงานต่อเองในหน้าเว็บ
