'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const TOKEN_FILE = path.join(os.tmpdir(), 'office-test-token-' + process.pid + '-' + path.basename(__filename));
const tokenBefore = null; // server ไม่เขียน token ลงดิสก์แล้ว ใช้ไฟล์ชั่วคราวเฉพาะเทสต์ผ่าน OFFICE_TEST_TOKEN_FILE
const PORT = 4799;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(p, headers = {}) {
  return new Promise((ok, no) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => ok({ status: r.statusCode, body: s }));
    }).on('error', no);
  });
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await get('/x'); return; } catch { await sleep(100); } }
  throw new Error('server ไม่ขึ้น');
}
async function withServer(root, fn) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1', OFFICE_ROOT: root, OFFICE_TEST_TOKEN_FILE: TOKEN_FILE }, stdio: 'ignore'
  });
  try {
    await waitUp();
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const board = async () => JSON.parse((await get('/api/whiteboard', { 'x-office-token': token })).body);
    await fn(board);
  } finally {
    await new Promise(r => { if (p.exitCode !== null) return r(); p.on('exit', r); p.kill(); setTimeout(r, 2000); });
    if (tokenBefore === null) try { fs.unlinkSync(TOKEN_FILE); } catch { /* ok */ }
  }
}
const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbtest-'));
  fs.mkdirSync(path.join(root, 'docs'));
  return root;
};
const EMPTY = { updated: '', decided: [], banned: [], pending: [], milestones: [] };

test('readBoard: whiteboard.md เป็นโฟลเดอร์ -> board ว่าง ไม่พัง', async () => {
  const root = mk();
  fs.mkdirSync(path.join(root, 'docs', 'whiteboard.md'));
  await withServer(root, async board => {
    assert.deepStrictEqual(await board(), EMPTY);
  });
});

test('readBoard: symlink -> board ว่าง', async (t) => {
  const root = mk();
  const secret = path.join(root, 'secret.md');
  fs.writeFileSync(secret, '## ✅ ตัดสินใจแล้ว\n- ลับ\n');
  try { fs.symlinkSync(secret, path.join(root, 'docs', 'whiteboard.md'), 'file'); }
  catch (e) { return t.skip('สร้าง symlink ไม่ได้: ' + e.code); }
  await withServer(root, async board => {
    assert.deepStrictEqual(await board(), EMPTY);
  });
});

test('readBoard: ไฟล์ > 256KB อ่านแค่ส่วนต้น ไม่พัง', async () => {
  const root = mk();
  const head = 'อัปเดต: 2026-01-01 00:00\n## ✅ ตัดสินใจแล้ว\n- ต้นไฟล์\n';
  const filler = '- x\n'.repeat(10);
  const pad = '<!-- ' + 'a'.repeat(300 * 1024) + ' -->\n';
  fs.writeFileSync(path.join(root, 'docs', 'whiteboard.md'), head + pad + '## ⛔ ห้ามทำ\n- ท้ายไฟล์\n' + filler);
  await withServer(root, async board => {
    const b = await board();
    assert.deepStrictEqual(b.decided, ['ต้นไฟล์']);
    assert.deepStrictEqual(b.banned, []); // เกิน 256KB ถูกตัด
  });
});

test('readBoard: ไฟล์ > 256KB ตัดกลางตัวอักษร UTF-8 ไม่ crash', async () => {
  const root = mk();
  fs.writeFileSync(path.join(root, 'docs', 'whiteboard.md'),
    '## ✅ ตัดสินใจแล้ว\n' + '- ก\n'.repeat(120000));
  await withServer(root, async board => {
    const b = await board();
    assert.strictEqual(b.decided.length, 200);
  });
});

test('readBoard: cache ตาม mtime+size เห็นการเปลี่ยนแปลง', async () => {
  const root = mk();
  const f = path.join(root, 'docs', 'whiteboard.md');
  fs.writeFileSync(f, '## ✅ ตัดสินใจแล้ว\n- one\n');
  await withServer(root, async board => {
    assert.deepStrictEqual((await board()).decided, ['one']);
    assert.deepStrictEqual((await board()).decided, ['one']); // hit cache
    fs.writeFileSync(f, '## ✅ ตัดสินใจแล้ว\n- two\n'); // size เท่าเดิม
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(f, t, t);
    assert.deepStrictEqual((await board()).decided, ['two']);
    fs.writeFileSync(f, '## ✅ ตัดสินใจแล้ว\n- three-longer\n'); // size เปลี่ยน
    assert.deepStrictEqual((await board()).decided, ['three-longer']);
  });
});

test('readBoard: ไฟล์หายหลังเคยมี -> board ว่าง', async () => {
  const root = mk();
  const f = path.join(root, 'docs', 'whiteboard.md');
  fs.writeFileSync(f, '## ✅ ตัดสินใจแล้ว\n- one\n');
  await withServer(root, async board => {
    assert.deepStrictEqual((await board()).decided, ['one']);
    fs.unlinkSync(f);
    assert.deepStrictEqual(await board(), EMPTY);
  });
});
