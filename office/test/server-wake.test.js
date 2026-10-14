'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const FAKE = path.join(__dirname, 'fake-claude.js');
const TOKEN_FILE = path.join(os.tmpdir(), 'office-test-token-' + process.pid + '-' + path.basename(__filename));
const PORT = 4798;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(p, token, body) {
  return new Promise((ok, no) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'x-office-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    r.on('error', no); r.write(data); r.end();
  });
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

const tu = (id, name, input, parent) => ({ type: 'assistant', parent_tool_use_id: parent || null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const tr = (id, text, err) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: !!err }] } });
const notif = id => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` }] } });

async function run(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));
  fs.mkdirSync(path.join(root, 'office'));
  fs.writeFileSync(path.join(root, 'office', 'departments.json'), JSON.stringify([
    { id: 'prototype', name: 'P', root: '.', manager: { name: 'fable', model: 'fable' } }]));
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const sf = path.join(sdir, 'script.json');
  fs.writeFileSync(sf, JSON.stringify(script));
  const p = spawn(process.execPath, [SERVER], { stdio: 'ignore', env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1',
    OFFICE_ROOT: root, OFFICE_CLAUDE_BIN: FAKE, OFFICE_SESSION_DIR: sdir, FAKE_SCRIPT: sf, OFFICE_TEST_TOKEN_FILE: TOKEN_FILE } });
  let ev;
  try {
    for (let i = 0; i < 50; i++) { try { await new Promise((ok, no) => http.get({ host: '127.0.0.1', port: PORT, path: '/x' }, r => { r.resume(); ok(); }).on('error', no)); break; } catch { await sleep(100); } }
    const T = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    ev = openEvents(T);
    await sleep(300);
    await post('/api/chat', T, { text: 'go' });
    await sleep(1200);
    return ev.events.filter(e => ['delegate', 'working', 'done', 'fable_tool'].includes(e.type)).map(e => [e.type, e.agent || e.tool, e.id || '', e.desc || ''].join('|'));
  } finally { if (ev) ev.close(); p.kill(); await sleep(200); }
}

test('Agent foreground: done ตอน tool_result ตามเดิม', async () => {
  const r = await run([
    tu('A1', 'Agent', { subagent_type: 'malee-coder', description: 'x' }),
    tu('W1', 'Read', {}, 'A1'),
    tr('A1', 'ok\nagentId: abc123 (usage...)'),
  ]);
  assert.deepStrictEqual(r, ['delegate|malee-coder|A1|x', 'working|malee-coder||', 'done|malee-coder|A1|']);
});

test('Agent background: ไม่ done จนกว่า task-notification', async () => {
  const r = await run([
    tu('A1', 'Agent', { subagent_type: 'malee-coder', description: 'x', run_in_background: true }),
    tr('A1', 'Async agent launched successfully.\nagentId: bg1 (internal ID)'),
    tu('W1', 'Edit', {}, 'A1'),
  ]);
  assert.deepStrictEqual(r, ['delegate|malee-coder|A1|x', 'working|malee-coder||']);
  const r2 = await run([
    tu('A1', 'Agent', { subagent_type: 'malee-coder', description: 'x', run_in_background: true }),
    tr('A1', 'Async agent launched successfully.\nagentId: bg1'),
    notif('other'),
    notif('bg1'),
  ]);
  assert.deepStrictEqual(r2, ['delegate|malee-coder|A1|x', 'done|malee-coder|A1|']);
});

test('SendMessage ปลุก agent เดิม: delegate/working/done ; to ไม่รู้จัก = fable_tool', async () => {
  const r = await run([
    tu('A1', 'Agent', { subagent_type: 'prae-qa', description: 'test' }),
    tr('A1', 'done\nagentId: qa1'),
    tu('S1', 'SendMessage', { to: 'qa1', summary: 'ทดสอบซ้ำ', message: 'again' }),
    tr('S1', 'Resuming agent qa1'),
    tu('W1', 'Bash', {}, 'S1'),
    tu('W2', 'Bash', {}, 'A1'), // กรณี parent เป็น Agent id เดิม
    tu('S2', 'SendMessage', { to: 'nobody', summary: 's', message: 'm' }),
    notif('qa1'),
  ]);
  assert.deepStrictEqual(r, [
    'delegate|prae-qa|A1|test', 'done|prae-qa|A1|',
    'delegate|prae-qa|S1|ทดสอบซ้ำ', 'working|prae-qa||', 'working|prae-qa||',
    'fable_tool|SendMessage||', 'done|prae-qa|S1|',
  ]);
});
