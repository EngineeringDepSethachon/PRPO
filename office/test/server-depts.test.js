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
const PORT = 4797;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p, token, body) {
  return new Promise((ok, no) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: { ...(token ? { 'x-office-token': token } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => ok({ status: res.statusCode, body: s, json: () => JSON.parse(s) })); });
    r.on('error', no);
    if (data) r.write(data);
    r.end();
  });
}
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dept srv-')); // มีช่องว่างในชื่อโดยตั้งใจ
  fs.mkdirSync(path.join(root, 'office'));
  fs.writeFileSync(path.join(root, 'office', 'departments.json'), JSON.stringify([
    { id: 'prototype', name: 'Prototype Team', root: '.', manager: { name: 'fable', model: 'fable' } },
    { id: 'marketing', name: 'Marketing', root: 'departments/marketing', manager: { name: 'mark', model: 'sonnet' } },
  ]));
  const ag = (r, n, m) => {
    fs.mkdirSync(path.join(r, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'agents', n + '.md'), `---\nname: ${n}\ndescription: x\nmodel: ${m}\n---\nbody\n`);
  };
  const mk = path.join(root, 'departments', 'marketing');
  fs.mkdirSync(mk, { recursive: true });
  ag(root, 'malee-coder', 'sonnet'); ag(root, 'kafae-scribe', 'haiku');
  ag(mk, 'kafae-scribe', 'haiku');
  return root;
}

test('หลายแผนก: init, roster, API dept, spawn env/cwd, stop, ask', async () => {
  const root = mkRoot();
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  fs.writeFileSync(path.join(sdir, '.session'), 'old-session');
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1', OFFICE_ROOT: root, OFFICE_CLAUDE_BIN: FAKE, OFFICE_SESSION_DIR: sdir, OFFICE_TEST_TOKEN_FILE: TOKEN_FILE }, stdio: 'ignore',
  });
  let ev;
  try {
    await waitUp();
    const T = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    ev = openEvents(T);
    await sleep(500);
    const init = ev.events.find(e => e.type === 'init');

    // migrate .session
    assert.ok(fs.existsSync(path.join(sdir, '.session-prototype')));
    assert.ok(!fs.existsSync(path.join(sdir, '.session')));

    // shape init
    assert.deepStrictEqual(init.departments.map(d => d.id), ['prototype', 'marketing']);
    assert.deepStrictEqual(init.departments.map(d => d.empty), [false, true]);
    assert.strictEqual(init.departments[0].running, false);
    assert.strictEqual(init.departments[0].pendingAsks, 0);
    assert.deepStrictEqual(Object.keys(init.depts).sort(), ['marketing', 'prototype']);
    assert.strictEqual(init.depts.marketing.roster[0].name, 'mark');
    assert.deepStrictEqual(init.depts.marketing.roster.map(r => r.name), ['mark', 'kafae-scribe']);
    assert.ok(init.depts.prototype.roster.some(r => r.name === 'malee-coder'));
    assert.ok(!init.depts.marketing.roster.some(r => r.name === 'malee-coder'), 'agents ของรากต้องไม่หลุดไปแผนกอื่น');
    for (const k of ['roster', 'chat', 'asks', 'running', 'board', 'model']) assert.ok(k in init, k); // field เดิม = prototype
    assert.strictEqual(init.roster[0].name, 'fable');
    assert.strictEqual(init.depts.marketing.model, 'sonnet');

    // whiteboard แยกแผนก
    assert.ok(fs.existsSync(path.join(root, 'docs', 'whiteboard.md')));
    assert.ok(fs.existsSync(path.join(root, 'departments', 'marketing', 'docs', 'whiteboard.md')));
    assert.strictEqual((await req('GET', '/api/whiteboard?dept=marketing', T)).status, 200);
    assert.strictEqual((await req('GET', '/api/whiteboard?dept=nope', T)).status, 400);
    assert.strictEqual((await req('GET', '/api/whiteboard?dept=..%2F..', T)).status, 400);

    // dept ไม่รู้จัก -> 400
    assert.strictEqual((await req('POST', '/api/chat', T, { text: 'x', dept: 'nope' })).status, 400);
    assert.strictEqual((await req('POST', '/api/stop', T, { dept: 'nope' })).status, 400);
    assert.strictEqual((await req('POST', '/api/ask', T, { title: 't', dept: 'nope' })).status, 403, 'token UI เรียก /api/ask ไม่ได้');
    assert.strictEqual((await req('POST', '/api/chat', T, { text: 'x', dept: 5 })).status, 400);

    // spawn: env + cwd ต่อแผนก
    assert.strictEqual((await req('POST', '/api/chat', T, { text: 'hi', dept: 'marketing' })).status, 200);
    assert.strictEqual((await req('POST', '/api/chat', T, { text: 'hi' })).status, 200); // default prototype
    await sleep(1500);
    const chats = ev.events.filter(e => e.type === 'chat' && e.msg.role === 'fable');
    const info = Object.fromEntries(chats.map(e => [e.dept, JSON.parse(e.msg.text)]));
    assert.strictEqual(info.marketing.dept, 'marketing');
    assert.strictEqual(path.resolve(info.marketing.cwd).toLowerCase(), path.resolve(root, 'departments', 'marketing').toLowerCase());
    assert.strictEqual(info.prototype.dept, 'prototype');
    assert.strictEqual(path.resolve(info.prototype.cwd).toLowerCase(), path.resolve(root).toLowerCase());
    assert.strictEqual(info.marketing.ask, ASKJS);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(info.marketing.url));
    assert.ok(info.marketing.argv.includes('sonnet') && info.prototype.argv.includes('fable'));
    // ทุก event มี dept
    for (const e of ev.events.filter(e => e.type !== 'init')) assert.ok(e.dept, JSON.stringify(e));
    assert.ok(fs.existsSync(path.join(sdir, '.session-marketing')));
    assert.strictEqual(fs.readFileSync(path.join(sdir, '.session-marketing'), 'utf8'), 'fake-marketing');

    // ask: dept ติดไปกับ ask, answer/wait ใช้ id อย่างเดียว
    const TM = info.marketing.token, TP = info.prototype.token;
    assert.ok(TM && TP && TM !== TP && TM !== T);
    const a = (await req('POST', '/api/ask', TM, { title: 'q', dept: 'prototype', options: ['A', 'B'] })).json(); // dept ใน body ไม่มีผล
    assert.strictEqual(a.dept, 'marketing');
    const a0 = (await req('POST', '/api/ask', TP, { title: 'q0' })).json();
    assert.strictEqual(a0.dept, 'prototype');
    await sleep(200);
    const ev2 = ev.events.filter(e => e.type === 'ask');
    assert.deepStrictEqual(ev2.map(e => e.dept), ['marketing', 'prototype']);
    assert.strictEqual((await req('GET', '/api/ask/' + a.id + '/wait?s=1', TP)).status, 404, 'แผนกอื่นรอ ask ของเราไม่ได้');
    const waiting = req('GET', '/api/ask/' + a.id + '/wait?s=5', TM);
    await sleep(200);
    assert.strictEqual((await req('POST', '/api/answer', TM, { id: a.id, decision: 'option', option: 'B' })).status, 403, 'child ตอบ ask เองไม่ได้');
    assert.strictEqual((await req('POST', '/api/answer', T, { id: a.id, decision: 'option', option: 'B' })).status, 200);
    const w = (await waiting).json();
    assert.strictEqual(w.option, 'B');
    await sleep(200);
    const upd = ev.events.find(e => e.type === 'ask_update');
    assert.strictEqual(upd.dept, 'marketing');
    assert.strictEqual((await req('POST', '/api/answer', T, { id: a.id, decision: 'approve' })).status, 409);

    // init ใหม่: pendingAsks + asks แยกแผนก
    const ev3 = openEvents(T); await sleep(400);
    const i3 = ev3.events.find(e => e.type === 'init'); ev3.close();
    assert.strictEqual(i3.departments.find(d => d.id === 'prototype').pendingAsks, 1);
    assert.strictEqual(i3.departments.find(d => d.id === 'marketing').pendingAsks, 0);
    assert.strictEqual(i3.depts.marketing.asks.length, 1);
    assert.strictEqual(i3.depts.prototype.asks.length, 1);
  } finally {
    if (ev) ev.close();
    await new Promise(r => { if (p.exitCode !== null) return r(); p.on('exit', r); p.kill(); setTimeout(r, 2000); });
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* ok */ }
  }
});

test('stop ฆ่าเฉพาะแผนกนั้น', async () => {
  const root = mkRoot();
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1', OFFICE_ROOT: root, OFFICE_CLAUDE_BIN: FAKE, OFFICE_SESSION_DIR: sdir, FAKE_HANG: '1', OFFICE_TEST_TOKEN_FILE: TOKEN_FILE }, stdio: 'ignore',
  });
  let ev;
  try {
    await waitUp();
    const T = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    ev = openEvents(T); await sleep(300);
    await req('POST', '/api/chat', T, { text: 'a', dept: 'marketing' });
    await req('POST', '/api/chat', T, { text: 'b', dept: 'prototype' });
    await sleep(800);
    const running = dept => ev.events.filter(e => e.type === 'status' && e.dept === dept).pop();
    assert.strictEqual(running('marketing').running, true);
    assert.strictEqual(running('prototype').running, true);
    assert.strictEqual((await req('POST', '/api/stop', T, { dept: 'marketing' })).json().ok, true);
    await sleep(1500);
    assert.strictEqual(running('marketing').running, false);
    assert.strictEqual(running('prototype').running, true, 'prototype ต้องไม่ถูกฆ่า');
    assert.strictEqual((await req('POST', '/api/stop', T, { dept: 'marketing' })).json().ok, false);
    assert.strictEqual((await req('POST', '/api/stop', T, { dept: 'prototype' })).json().ok, true);
  } finally {
    if (ev) ev.close();
    await new Promise(r => { if (p.exitCode !== null) return r(); p.on('exit', r); p.kill(); setTimeout(r, 2000); });
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* ok */ }
  }
});
