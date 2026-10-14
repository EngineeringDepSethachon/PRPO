'use strict';
// --body-file / --*-file ถูกปฏิเสธ (exit 2) และไม่ส่ง request ใด ๆ ไปที่ server
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OFFICE = path.join(__dirname, '..');

test('--body-file (path/stdin/--x-file) ถูกปฏิเสธ exit 2 และไม่ส่ง request', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('{}'); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + srv.address().port;
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-')), 'secret.key');
  fs.writeFileSync(secret, 'TOPSECRET');
  const run = (script, args) => new Promise(ok => {
    const c = spawn(process.execPath, [path.join(OFFICE, script), ...args], { env: { ...process.env, OFFICE_URL: url, OFFICE_DEPT_TOKEN: 'tok' } });
    let s = ''; c.stdout.on('data', d => (s += d)); c.stdin.end();
    c.on('exit', code => ok({ code, out: s.trim() }));
    setTimeout(() => c.kill(), 8000);
  });
  try {
    const cases = [
      ['ask.js', ['--title', 't', '--body-file', secret]],
      ['ask.js', ['--title', 't', '--body-file', '-']],
      ['consult.js', ['--title', 't', '--body-file', secret]],
      ['consult.js', ['--title', 't', '--body-file=' + secret]],
      ['consult.js', ['--title-file', secret]],
      ['decide.js', ['--id', 'x', '--decision', 'approve', '--body-file', secret]],
    ];
    for (const [s, a] of cases) {
      const r = await run(s, a);
      assert.strictEqual(r.code, 2, s + ' ' + a.join(' ') + ' -> ' + r.out);
      assert.ok(r.out.startsWith('OFFICE_ERROR: ไม่รองรับ --body-file'), r.out);
      assert.ok(!r.out.includes('TOPSECRET'));
    }
    assert.strictEqual(hits, 0, 'ต้องไม่ส่ง request');
    // --body ปกติยังส่งได้ (ไปถึง server)
    await run('consult.js', ['--title', 't', '--body', 'x']);
    assert.ok(hits >= 1);
  } finally { srv.close(); }
});
