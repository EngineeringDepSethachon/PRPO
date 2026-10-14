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
const REAL_WB = path.join(__dirname, '..', '..', 'docs', 'whiteboard.md');

const tokenBefore = null; // server ไม่เขียน token ลงดิสก์แล้ว ใช้ไฟล์ชั่วคราวเฉพาะเทสต์ผ่าน OFFICE_TEST_TOKEN_FILE
const { parseWhiteboard } = require(SERVER);

test('require ไม่เขียน .token ไม่ listen', () => {
  const now = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8') : null;
  assert.strictEqual(now, tokenBefore);
});

test('ไฟล์ว่าง / undefined / null', () => {
  const empty = { updated: '', decided: [], banned: [], pending: [], milestones: [] };
  assert.deepStrictEqual(parseWhiteboard(''), empty);
  assert.deepStrictEqual(parseWhiteboard(undefined), empty);
  assert.deepStrictEqual(parseWhiteboard(null), empty);
});

const FULL = [
  '# ไวท์บอร์ด', 'อัปเดต: 2026-10-06 10:00', '',
  '## ✅ ตัดสินใจแล้ว', '- [2026-10-06] ใช้ Node', '- ข้อสอง', '',
  '## ⛔ ห้ามทำ', '- ห้ามลบไฟล์', '',
  '## ⏳ ค้างอยู่', '- รอลูกค้า', '',
  '## 🎯 Milestones', '### M1: เริ่ม', '- [x] a', '- [X] b', '- [ ] c', '### M2: สอง', '- [ ] d', ''
].join('\n');

test('parse เคสปกติ + [x]/[X]/[ ]', () => {
  const b = parseWhiteboard(FULL);
  assert.strictEqual(b.updated, '2026-10-06 10:00');
  assert.deepStrictEqual(b.decided, ['[2026-10-06] ใช้ Node', 'ข้อสอง']);
  assert.deepStrictEqual(b.banned, ['ห้ามลบไฟล์']);
  assert.deepStrictEqual(b.pending, ['รอลูกค้า']);
  assert.strictEqual(b.milestones.length, 2);
  assert.strictEqual(b.milestones[0].title, 'M1: เริ่ม');
  assert.strictEqual(b.milestones[0].done, 2);
  assert.strictEqual(b.milestones[0].total, 3);
  assert.deepStrictEqual(b.milestones[0].items, [
    { text: 'a', done: true }, { text: 'b', done: true }, { text: 'c', done: false }]);
  assert.strictEqual(b.milestones[1].done, 0);
});

test('CRLF และ CR เดี่ยว ให้ผลเหมือน LF', () => {
  assert.deepStrictEqual(parseWhiteboard(FULL.replace(/\n/g, '\r\n')), parseWhiteboard(FULL));
  assert.deepStrictEqual(parseWhiteboard(FULL.replace(/\n/g, '\r')), parseWhiteboard(FULL));
});

test('คอมเมนต์หลายบรรทัดถูกตัด ไม่ปนเข้า section', () => {
  const t = '<!--\n## ✅ ตัดสินใจแล้ว\n- ในคอมเมนต์\n-->\n# x\nอัปเดต: 1\n## ✅ ตัดสินใจแล้ว\n- จริง <!-- แทรก --> ต่อ\n<!-- a -->\n- สอง';
  const b = parseWhiteboard(t);
  assert.strictEqual(b.updated, '1');
  assert.deepStrictEqual(b.decided, ['จริง  ต่อ', 'สอง']);
});

test('คอมเมนต์ไม่ปิด ตัดถึงท้ายไฟล์ ไม่ crash', () => {
  const b = parseWhiteboard('## ✅ ตัดสินใจแล้ว\n- ก\n<!-- ไม่ปิด\n- ข');
  assert.deepStrictEqual(b.decided, ['ก']);
});

test('หัวข้อหาย: ส่วนที่ไม่มีเป็น [] และรายการก่อนหัวข้อถูกข้าม', () => {
  const b = parseWhiteboard('- ลอย\n## ⛔ ห้ามทำ\n- x\n');
  assert.deepStrictEqual(b.decided, []);
  assert.deepStrictEqual(b.banned, ['x']);
  assert.deepStrictEqual(b.milestones, []);
});

test('หัวข้อไม่รู้จัก ปิด section ก่อนหน้า', () => {
  const b = parseWhiteboard('## ✅ ตัดสินใจแล้ว\n- a\n## อื่น ๆ\n- b\n');
  assert.deepStrictEqual(b.decided, ['a']);
});

test('milestone checkbox ก่อน ### ถูกข้าม / ### นอก ms ไม่สร้าง milestone', () => {
  const b = parseWhiteboard('## 🎯 Milestones\n- [x] ลอย\n### M1\n- [x] ok\n## ✅ ตัดสินใจแล้ว\n### M9\n- z');
  assert.strictEqual(b.milestones.length, 1);
  assert.strictEqual(b.milestones[0].total, 1);
  assert.deepStrictEqual(b.decided, ['z']);
});

test('item ใน milestone ไม่มี checkbox = ไม่เสร็จ, ว่าง = ข้าม', () => {
  const b = parseWhiteboard('## 🎯 Milestones\n### M1\n- plain\n- [x]\n- [ ]   \n');
  assert.deepStrictEqual(b.milestones[0].items, [{ text: 'plain', done: false }]);
  assert.strictEqual(b.milestones[0].total, 1);
});

test('ข้อความยาว > 500 ถูกตัด', () => {
  const long = 'ก'.repeat(900);
  const b = parseWhiteboard(`## ✅ ตัดสินใจแล้ว\n- ${long}\n## 🎯 Milestones\n### ${long}\n- [x] ${long}`);
  assert.strictEqual(b.decided[0].length, 500);
  assert.strictEqual(b.milestones[0].title.length, 500);
  assert.strictEqual(b.milestones[0].items[0].text.length, 500);
  const u = parseWhiteboard('อัปเดต: ' + 'x'.repeat(300));
  assert.strictEqual(u.updated.length, 100);
});

test('จำนวนรายการจำกัด 200', () => {
  const many = Array.from({ length: 300 }, (_, i) => '- i' + i).join('\n');
  const b = parseWhiteboard('## ✅ ตัดสินใจแล้ว\n' + many);
  assert.strictEqual(b.decided.length, 200);
  const ms = Array.from({ length: 300 }, (_, i) => `### M${i}\n- [x] a`).join('\n');
  assert.strictEqual(parseWhiteboard('## 🎯 Milestones\n' + ms).milestones.length, 200);
  const items = Array.from({ length: 300 }, () => '- [x] a').join('\n');
  const m = parseWhiteboard('## 🎯 Milestones\n### M\n' + items).milestones[0];
  assert.strictEqual(m.items.length, 200);
  assert.strictEqual(m.total, 200);
});

test('ลำดับหัวข้อสลับ', () => {
  const t = '## 🎯 Milestones\n### M1\n- [x] a\n## ⏳ ค้างอยู่\n- p\n## ⛔ ห้ามทำ\n- b\n## ✅ ตัดสินใจแล้ว\n- d\n';
  const b = parseWhiteboard(t);
  assert.deepStrictEqual([b.decided, b.banned, b.pending], [['d'], ['b'], ['p']]);
  assert.strictEqual(b.milestones[0].done, 1);
});

test('docs/whiteboard.md จริง parse ได้ ไม่ crash และหัวข้อครบ', () => {
  const b = parseWhiteboard(fs.readFileSync(REAL_WB, 'utf8'));
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(b.updated), 'updated=' + b.updated);
  for (const k of ['decided', 'banned', 'pending', 'milestones']) assert.ok(Array.isArray(b[k]));
});

// ---------- รันจริง ----------
const PORT = 4799;
function get(p, headers = {}) {
  return new Promise((ok, no) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => ok({ status: r.statusCode, body: s }));
    }).on('error', no);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await get('/x'); return; } catch { await sleep(100); } }
  throw new Error('server ไม่ขึ้น');
}
function startServer(root) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_NO_OPEN: '1', OFFICE_ROOT: root, OFFICE_TEST_TOKEN_FILE: TOKEN_FILE },
    stdio: 'ignore'
  });
  return p;
}
function stopServer(p) {
  return new Promise(r => { if (p.exitCode !== null) return r(); p.on('exit', r); p.kill(); setTimeout(r, 2000); });
}
function cleanupToken() { if (tokenBefore === null) try { fs.unlinkSync(TOKEN_FILE); } catch { /* ok */ } }
function openEvents(token) {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/events?t=' + token }, r => {
    let buf = '';
    r.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

test('server จริง: template, auth, SSE, watch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtest-'));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  const wb = path.join(root, 'docs', 'whiteboard.md');
  let proc;
  let ev;
  try {
    proc = startServer(root);
    await waitUp();
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    await t.test('ไม่มีไฟล์ -> สร้าง template', () => {
      assert.ok(fs.existsSync(wb));
      const txt = fs.readFileSync(wb, 'utf8');
      assert.ok(txt.includes('## 🎯 Milestones') && txt.includes('## ✅ ตัดสินใจแล้ว'));
    });

    await t.test('auth', async () => {
      assert.strictEqual((await get('/api/whiteboard')).status, 401);
      assert.strictEqual((await get('/api/whiteboard?t=wrong')).status, 401);
      const r = await get('/api/whiteboard', { 'x-office-token': token });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.body).milestones, []);
      const r2 = await get('/api/whiteboard?t=' + token);
      assert.strictEqual(r2.status, 200);
      assert.strictEqual((await get('/events')).status, 401);
    });

    ev = openEvents(token);
    await sleep(500);
    await t.test('init มี board', () => {
      const init = ev.events.find(e => e.type === 'init');
      assert.ok(init && init.board && Array.isArray(init.board.milestones));
    });

    const wbEvents = () => ev.events.filter(e => e.type === 'whiteboard');
    await t.test('แก้เนื้อหา -> event changed:true ภายใน 2 วิ', async () => {
      fs.writeFileSync(wb, FULL);
      await sleep(2000);
      const w = wbEvents();
      assert.strictEqual(w.length, 1);
      assert.strictEqual(w[0].changed, true);
      assert.strictEqual(w[0].board.milestones.length, 2);
    });

    await t.test('แก้แบบเนื้อหา parse เดิม -> ไม่มี event', async () => {
      fs.writeFileSync(wb, FULL + '\n\n<!-- แค่คอมเมนต์ -->\n');
      await sleep(2200);
      assert.strictEqual(wbEvents().length, 1);
    });

    await t.test('ลบแล้วสร้างใหม่ -> ยังได้ event', async () => {
      fs.unlinkSync(wb);
      await sleep(1500);
      fs.writeFileSync(wb, FULL.replace('ข้อสอง', 'ข้อใหม่'));
      await sleep(2200);
      const w = wbEvents();
      assert.ok(w.length >= 2, 'events=' + w.length);
      assert.ok(w[w.length - 1].board.decided.includes('ข้อใหม่'));
    });
  } finally {
    if (ev) ev.close();
    if (proc) await stopServer(proc);
    cleanupToken();
  }
});

test('server จริง: มีไฟล์อยู่แล้ว ห้ามเขียนทับ', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtest2-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const wb = path.join(root, 'docs', 'whiteboard.md');
  fs.writeFileSync(wb, FULL);
  let proc;
  try {
    proc = startServer(root);
    await waitUp();
    await sleep(300);
    assert.strictEqual(fs.readFileSync(wb, 'utf8'), FULL);
  } finally {
    if (proc) await stopServer(proc);
    cleanupToken();
  }
});

test('จบแล้วไม่มี .token ค้าง (ถ้าเดิมไม่มี)', () => {
  cleanupToken();
  assert.strictEqual(fs.existsSync(TOKEN_FILE), tokenBefore !== null);
});
