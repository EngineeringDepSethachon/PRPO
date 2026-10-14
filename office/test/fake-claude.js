'use strict';
// claude ปลอมสำหรับเทสต์: อ่านบรรทัด stream-json จาก stdin แล้วตอบ init + ข้อความบอก env/cwd + result
let buf = '';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (process.env.FAKE_TOKEN_DIR) require('fs').writeFileSync(require('path').join(process.env.FAKE_TOKEN_DIR, process.env.OFFICE_DEPT + '.tok'), process.env.OFFICE_DEPT_TOKEN || '');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (process.env.FAKE_HANG) continue; // ค้างไว้ให้เทสต์ stop
    let input = ''; try { input = JSON.parse(line).message.content[0].text; } catch { /* ok */ }
    out({ type: 'system', subtype: 'init', session_id: 'fake-' + process.env.OFFICE_DEPT });
    if (process.env.FAKE_SCRIPT) { // เล่นบรรทัด stream-json จากไฟล์ (JSON array) แทนคำตอบปกติ
      for (const o of JSON.parse(require('fs').readFileSync(process.env.FAKE_SCRIPT, 'utf8'))) out(o);
      out({ type: 'result', is_error: false });
      continue;
    }
    const later = f => (process.env.FAKE_DELAY_MS ? setTimeout(f, +process.env.FAKE_DELAY_MS) : f());
    later(() => {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ dept: process.env.OFFICE_DEPT, cwd: process.cwd(), ask: process.env.OFFICE_ASK, url: process.env.OFFICE_URL, argv: process.argv.slice(2), token: process.env.OFFICE_DEPT_TOKEN, input }) }] } });
    out({ type: 'result', is_error: false });
    });
  }
});
