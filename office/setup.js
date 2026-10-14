#!/usr/bin/env node
'use strict';
// คัดลอก claude-setup/ → .claude/ (พนักงานและสิทธิ์เครื่องมือ) ก่อนเปิดออฟฟิศ
// ไฟล์ที่มีอยู่แล้วจะไม่ถูกทับ ยกเว้นรันด้วย --force
const fs = require('fs');
const path = require('path');
const { rewriteScribeHook } = require('./scribe-hook');
const ROOT = process.env.OFFICE_ROOT || process.cwd();
const SRC = path.join(ROOT, 'claude-setup');
const DST = path.join(ROOT, '.claude');
const force = process.argv.includes('--force');
if (!fs.existsSync(SRC)) { console.error('ไม่พบโฟลเดอร์ claude-setup ใน ' + ROOT); process.exit(1); }
let copied = 0, skipped = 0;
function walk(rel) {
  for (const e of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { walk(r); continue; }
    const to = path.join(DST, r);
    if (fs.existsSync(to) && !force) { skipped++; continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (r.split(path.sep).join('/') === 'agents/kafae-scribe.md') {
      // เฉพาะไฟล์นี้: แทนคำสั่ง hook เป็น path เต็ม (กัน fail-open เมื่อ cwd ไม่ใช่ราก)
      const out = rewriteScribeHook(fs.readFileSync(path.join(SRC, r), 'utf8'), DST);
      fs.writeFileSync(to, out.text);
    } else {
      fs.copyFileSync(path.join(SRC, r), to);
    }
    copied++;
  }
}
try { walk(''); } catch (e) { console.error('ERROR: setup ล้มเหลว: ' + e.message); process.exit(1); }
if (!fs.existsSync(path.join(DST, 'hooks', 'whiteboard-only.js'))) {
  console.warn('เตือน: ไม่พบ .claude/hooks/whiteboard-only.js — hook ของ kafae-scribe จะทำงานไม่ได้ (ตรวจ claude-setup/hooks)');
}
console.log('setup: คัดลอก ' + copied + ' ไฟล์ไป .claude/' + (skipped ? ' (ข้าม ' + skipped + ' ไฟล์ที่มีอยู่แล้ว ใช้ --force เพื่อทับ)' : ''));
