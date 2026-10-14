'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const ASKJS = path.join(__dirname, '..', 'ask.js');
const FAKE = path.join(__dirname, 'fake-claude.js');
const TOKEN_FILE = path.join(os.tmpdir(), 'office-test-token-' + process.pid + '-' + path.basename(__filename));
const PORT = 4798;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p, token, rawBody) {
  return new Promise((ok, no) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: { ...(token ? { 'x-office-token': token } : {}), ...(rawBody != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) } : {}) },
    }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => ok({ status: res.statusCode, body: s, json: () => JSON.parse(s) })); });
    r.on('error', no);
    if (rawBody != null) r.write(rawBody);
    r.end();
  });
}
const post = (p, t, o) => req('POST', p, t, JSON.stringify(o));
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await req('GET', '/x'); return; } catch { await sleep(100); } }
  throw new Error('server ไม่ขึ้น');
}
function openEvents(token) {
  const events = [];
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/events?t=' + token }, res => {
    let buf = '';
    res.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  r.on('error', () => {});
  return { events, close: () => r.destroy() };
}
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dept extra-'));
  fs.mkdirSync(path.join(root, 'office'));
  fs.writeFileSync(path.join(root, 'office', 'departments.json'), JSON.stringify([
    { id: 'prototype', name: 'Prototype Team', root: '.', manager: { name: 'fable', model: 'fable' } },
    { id: 'marketing', name: 'Marketing', root: 'departments/marketing', manager: { name: 'mark', model: 'sonnet' } },
    { id: 'ghost', name: 'Ghost', root: 'departments/ghost', manager: { name: 'g', model: 'sonnet' } }, // โฟลเดอร์ไม่มี
  ]));
  fs.mkdirSync(path.join(root, 'departments', 'marketing'), { recursive: true });
  return root;
}

test('edge: โฟลเดอร์แผนกไม่มี, body null, restart หลัง stop, ask.js แผนกไม่รู้จัก', async () => {
  const root = mkRoot();
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1', OFFICE_ROOT: root, OFFICE_CLAUDE_BIN: FAKE, OFFICE_SESSION_DIR: sdir, FAKE_HANG: '1', OFFICE_TEST_TOKEN_FILE: TOKEN_FILE, FAKE_TOKEN_DIR: sdir }, stdio: 'ignore',
  });
  let ev;
  try {
    await waitUp();
    const T = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    ev = openEvents(T); await sleep(400);

    // แผนกที่โฟลเดอร์ไม่มี: ok=false + ข้อความ system, ไม่ spawn, ไม่สร้างโฟลเดอร์
    const r1 = await post('/api/chat', T, { text: 'x', dept: 'ghost' });
    assert.strictEqual(r1.json().ok, false);
    await sleep(200);
    assert.ok(ev.events.some(e => e.type === 'chat' && e.dept === 'ghost' && e.msg.role === 'system'));
    assert.ok(!fs.existsSync(path.join(root, 'departments', 'ghost')));
    assert.ok(!ev.events.some(e => e.type === 'status' && e.dept === 'ghost' && e.running === true));

    // body เป็น JSON null / พัง ต้องไม่ล้มเซิร์ฟเวอร์ (ยอมรับ 400/500 แต่ห้ามตาย)
    for (const raw of ['null', '{bad', '[]']) {
      for (const ep of ['/api/chat', '/api/ask', '/api/answer', '/api/stop']) {
        const r = await req('POST', ep, T, raw);
        assert.ok(r.status >= 200 && r.status < 600, ep + ' ' + raw);
      }
    }
    assert.strictEqual((await req('GET', '/x', T)).status, 404, 'เซิร์ฟเวอร์ต้องยังอยู่');

    // answer id ไม่มี / decision ผิด
    assert.strictEqual((await post('/api/answer', T, { id: 'nope', decision: 'approve' })).status, 409);
    await post('/api/chat', T, { text: 'tok', dept: 'marketing' });
    await sleep(600);
    const TM = fs.readFileSync(path.join(sdir, 'marketing.tok'), 'utf8');
    assert.ok(TM);
    const a = (await post('/api/ask', TM, { title: 't' })).json();
    assert.strictEqual((await post('/api/answer', T, { id: a.id, decision: 'hack' })).status, 409);
    assert.strictEqual((await req('GET', '/api/ask/nope/wait?s=1', TM)).status, 404);
    assert.strictEqual((await req('GET', '/api/ask/nope/wait?s=1', T)).status, 403);

    // stop แล้ว chat ใหม่ต้อง spawn ใหม่ (running true อีกครั้ง)
    await post('/api/chat', T, { text: 'a', dept: 'marketing' });
    await sleep(600);
    assert.strictEqual((await post('/api/stop', T, { dept: 'marketing' })).json().ok, true);
    await sleep(1500);
    const st = () => ev.events.filter(e => e.type === 'status' && e.dept === 'marketing').pop();
    assert.strictEqual(st().running, false);
    await post('/api/chat', T, { text: 'b', dept: 'marketing' });
    await sleep(600);
    assert.strictEqual(st().running, true, 'ต้อง spawn ใหม่หลัง exit');
    await post('/api/stop', T, { dept: 'marketing' });

    // ask.js ด้วย OFFICE_DEPT ที่ไม่รู้จัก: ต้องไม่พิมพ์ "CHOSE: undefined"
    const out = await new Promise(ok => {
      const c = spawn(process.execPath, [ASKJS, '--title', 't'], { env: { ...process.env, OFFICE_URL: 'http://127.0.0.1:' + PORT, OFFICE_DEPT: 'nope', OFFICE_DEPT_TOKEN: 'bogus' } });
      let s = ''; c.stdout.on('data', d => s += d); c.on('exit', () => ok(s));
      setTimeout(() => { c.kill(); ok(s); }, 5000);
    });
    assert.ok(!/CHOSE: undefined/.test(out), 'ask.js ไม่ตรวจ error จากเซิร์ฟเวอร์: ' + out);
    assert.ok(/^OFFICE_ERROR/.test(out), out);
  } finally {
    if (ev) ev.close();
    await new Promise(r => { if (p.exitCode !== null) return r(); p.on('exit', r); p.kill(); setTimeout(r, 2000); });
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* ok */ }
  }
});
