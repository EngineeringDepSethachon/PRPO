#!/usr/bin/env node
'use strict';
// หัวหน้าห้อง -> หัวหน้าห้องอื่น : ส่งบันทึกประสานงาน (ข้อมูล/ขอข้อมูล ไม่ใช่คำสั่งหรือการอนุมัติ) ไม่บล็อก
//   node office/memo.js --to <id ห้องปลายทาง> --title "หัวข้อ" [--re <memo id ที่ตอบ>] --body '...'
// ผลลัพธ์: SENT memo=<id> (exit 0) ; ผู้ส่งมาจาก token ต่อแผนก (env OFFICE_DEPT_TOKEN) ; ห้ามส่งหาตัวเอง

const { init, makeCall, argOpt, readBody, fail } = require('./client');

const call = makeCall(init());
const argv = process.argv.slice(2);

(async () => {
  try {
    const to = argOpt(argv, '--to');
    if (!to) fail('OFFICE_ERROR: ต้องระบุ --to <id ห้องปลายทาง>');
    const body = await readBody(argv);
    const r = await call('POST', '/api/memo', { to, title: argOpt(argv, '--title') || 'บันทึก', body, ...(argOpt(argv, '--re') ? { re: argOpt(argv, '--re') } : {}) });
    if (!r || !r.id) fail('OFFICE_ERROR: ' + ((r && r.error) || 'ส่งบันทึกไม่สำเร็จ'));
    console.log('SENT memo=' + r.id);
  } catch (e) {
    fail('OFFICE_ERROR: ' + (e.message || e));
  }
})();
