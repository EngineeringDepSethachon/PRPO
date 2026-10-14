#!/usr/bin/env node
'use strict';
// หัวหน้าห้อง -> ห้อง exec ที่เป็น approver ของแผนก : ขออนุมัติงานใหญ่ ไม่บล็อก
//   node office/consult.js --title "หัวข้อ" --body '...'
// ห้อง exec ขอคำปรึกษาห้อง exec อื่น (ต้องระบุ --to <id ห้อง exec>, ห้ามหาตัวเอง) :
//   node office/consult.js --to executive-biz --title "..." --body '...'
// ผลลัพธ์: SENT id=<id> ... (exit 0) ; ผลอนุมัติจะถูกส่งเข้า session ของหัวหน้าเป็นข้อความ
// แผนกผู้ส่งมาจาก token ต่อแผนก (env OFFICE_DEPT_TOKEN)

const { init, makeCall, argOpt, readBody, fail } = require('./client');

// ดูสถานะ consult ที่ส่งไปแล้ว (ทันที ไม่รอ) : node office/consult.js --status <id>
const DECISION_LABEL = { approve: 'APPROVED', revise: 'REVISE', reject: 'REJECTED', advise: 'ADVISED' };
const call = makeCall(init());
const argv = process.argv.slice(2);

(async () => {
  try {
    const st = argOpt(argv, '--status');
    if (st) {
      if (!/^[A-Za-z0-9]{1,40}$/.test(st)) fail('OFFICE_ERROR: id ไม่ถูกต้อง');
      const s = await call('GET', '/api/consult/' + st + '/wait?s=0');
      if (!s || !s.status) fail('OFFICE_ERROR: ' + ((s && s.error) || 'ดูสถานะไม่สำเร็จ'));
      const label = s.status === 'decided' ? (DECISION_LABEL[s.decision] || String(s.decision)) : 'pending';
      console.log('STATUS ' + st + ' ' + label + ' เรื่อง: ' + String(s.title || ''));
      return;
    }
    const body = await readBody(argv);
    const payload = { title: argOpt(argv, '--title') || 'ขออนุมัติ', body };
    const to = argOpt(argv, '--to');
    if (to) payload.to = to; // ห้อง exec เท่านั้น ; แผนกทีมส่ง --to แล้ว server จะปฏิเสธ
    const r = await call('POST', '/api/consult', payload);
    if (!r || !r.id) fail('OFFICE_ERROR: ' + ((r && r.error) || 'ส่งคำขอไม่สำเร็จ'));
    console.log('SENT id=' + r.id + ' — จบ turn ได้ ผลอนุมัติจะส่งเข้ามาเป็นข้อความ');
  } catch (e) {
    fail('OFFICE_ERROR: ' + (e.message || e));
  }
})();
