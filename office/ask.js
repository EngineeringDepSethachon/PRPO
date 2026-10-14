#!/usr/bin/env node
'use strict';
// ให้ Fable/หัวหน้าห้องเรียกผ่าน PowerShell/Bash เพื่อขอให้ผู้ใช้ตัดสินใจ — ค้างรอจนผู้ใช้กดในหน้าออฟฟิศ
//   node office/ask.js --title "หัวข้อ" --body '...' [--options "A|B|C"]   (ไม่รองรับ --body-file)
//   node office/ask.js --wait <id>        (ถ้าครั้งก่อนตอบว่า PENDING)
// ผลลัพธ์: APPROVED | DENIED | CHOSE: <ตัวเลือก> (+ NOTE: ...) | PENDING id=...
// ใช้ token ต่อแผนกจาก env OFFICE_DEPT_TOKEN (server ส่งให้ตอน spawn) ; แผนกระบุจาก token ไม่ใช่จากที่ส่งมา

const { init, makeCall, argOpt, readBody, fail } = require('./client');

const ctx = init();
const call = makeCall(ctx);
const argv = process.argv.slice(2);

function show(a) {
  if (a.status === 'pending') {
    console.log('PENDING id=' + a.id + ' — ผู้ใช้ยังไม่ตอบ ให้รัน: node office/ask.js --wait ' + a.id + ' (ตั้ง Bash timeout 600000)');
  } else {
    if (a.decision === 'approve') console.log('APPROVED');
    else if (a.decision === 'deny') console.log('DENIED');
    else console.log('CHOSE: ' + a.option);
    if (a.note) console.log('NOTE: ' + a.note);
  }
}

(async () => {
  try {
    let id = argOpt(argv, '--wait');
    if (!id) {
      const body = await readBody(argv);
      const options = (argOpt(argv, '--options') || '').split('|').map(s => s.trim()).filter(Boolean);
      const a = await call('POST', '/api/ask', { title: argOpt(argv, '--title') || 'ขออนุญาต', body, options });
      if (!a || !a.id) fail('OFFICE_ERROR: ' + ((a && a.error) || 'สร้างคำถามไม่สำเร็จ'));
      id = a.id;
    }
    const r = await call('GET', '/api/ask/' + encodeURIComponent(id) + '/wait?s=540');
    if (!r || !r.status) fail('OFFICE_ERROR: ' + ((r && r.error) || 'ตอบกลับไม่ถูกต้อง'));
    show(r);
  } catch (e) {
    fail('OFFICE_ERROR: ' + (e.message || e));
  }
})();
