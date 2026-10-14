'use strict';
// ตัวช่วยร่วมของ ask.js / consult.js / decide.js : อ่าน OFFICE_DEPT_TOKEN, ตรวจ OFFICE_URL (loopback เท่านั้น), เรียก API
// child ต้องไม่ใช้ token ของหน้าเว็บ — ใช้เฉพาะ token ของแผนกที่ server ส่งทาง env
const http = require('http');

function fail(msg, code) { console.log(msg); process.exit(code || 2); }

function init() {
  rejectFileArgs(process.argv.slice(2));
  const token = process.env.OFFICE_DEPT_TOKEN;
  if (!token) fail('OFFICE_NOT_RUNNING: ไม่พบ OFFICE_DEPT_TOKEN (ไม่ได้ถูกเปิดผ่าน Fable Office, npm run office) — ถามผู้ใช้ในแชทแทน');
  let base;
  try { base = new URL(process.env.OFFICE_URL || 'http://127.0.0.1:4777'); } catch { fail('OFFICE_ERROR: OFFICE_URL ไม่ถูกต้อง'); }
  const host = base.hostname.replace(/^\[|\]$/g, '');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    fail('OFFICE_ERROR: OFFICE_URL ต้องเป็น http://127.0.0.1 หรือ localhost เท่านั้น (loopback)');
  }
  return { token, base };
}

function makeCall({ token, base }) {
  return function call(method, p, body) {
    return new Promise((ok, no) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        host: host4(base), port: base.port, path: p, method,
        headers: { 'x-office-token': token, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      }, res => {
        let s = '';
        res.on('data', d => (s += d));
        res.on('end', () => { try { ok(JSON.parse(s)); } catch (e) { no(new Error('HTTP ' + res.statusCode + ' ตอบกลับไม่ใช่ JSON')); } });
      });
      r.on('error', no);
      if (data) r.write(data);
      r.end();
    });
  };
}
function host4(base) { return base.hostname.replace(/^\[|\]$/g, ''); }

function argOpt(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; }

// รับ body จาก --body เท่านั้น ; ห้ามอ่านไฟล์/stdin (กันแผนกอ่านไฟล์ลับนอกโฟลเดอร์แล้วส่งออก)
function rejectFileArgs(argv) {
  if (argv.some(a => /^--[a-z-]*-file(=|$)/i.test(a))) fail('OFFICE_ERROR: ไม่รองรับ --body-file ใช้ --body \'...\'');
}
async function readBody(argv) {
  rejectFileArgs(argv);
  return argOpt(argv, '--body') || '';
}

module.exports = { init, makeCall, argOpt, readBody, fail };
