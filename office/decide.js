#!/usr/bin/env node
'use strict';
// ห้อง exec ที่เป็น approver ของ consult นั้นเท่านั้น ตัดสิน consult
//   node office/decide.js --id <id> --decision approve|revise|reject --body '...'   (advise: --decision advise)
// ผลลัพธ์: DECIDED <id> APPROVED|REVISE|REJECTED|ADVISED ; ห้องอื่นเรียก -> OFFICE_ERROR (server ตอบ 403)

const { init, makeCall, argOpt, readBody, fail } = require('./client');

const call = makeCall(init());
const argv = process.argv.slice(2);

(async () => {
  try {
    const id = argOpt(argv, '--id');
    const decision = argOpt(argv, '--decision');
    if (!id || !['approve', 'revise', 'reject', 'advise'].includes(decision)) fail('OFFICE_ERROR: ใช้ --id <id> --decision approve|revise|reject (consult แบบ advise ใช้ advise) [--body ...]');
    const body = await readBody(argv);
    const r = await call('POST', '/api/decide', { id, decision, body });
    if (!r || r.status !== 'decided') fail('OFFICE_ERROR: ' + ((r && r.error) || 'ตัดสินไม่สำเร็จ'));
    console.log('DECIDED ' + r.id + ' ' + { approve: 'APPROVED', revise: 'REVISE', reject: 'REJECTED', advise: 'ADVISED' }[r.decision]);
  } catch (e) {
    fail('OFFICE_ERROR: ' + (e.message || e));
  }
})();
