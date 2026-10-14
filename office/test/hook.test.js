'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'claude-setup', 'hooks', 'whiteboard-only.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-'));
fs.mkdirSync(path.join(root, 'docs'));
fs.mkdirSync(path.join(root, '.claude'));
fs.writeFileSync(path.join(root, 'docs', 'whiteboard.md'), '# x\n');
fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x');
fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');

function run(stdin, projDir = root) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projDir };
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
  // บล็อก = stdout เป็น JSON permissionDecision:deny + exit 0 ; แปลงเป็น 2 เพื่อให้ assertion เดิมใช้ได้
  if (/"permissionDecision":"deny"/.test(r.stdout || '')) return 2;
  return r.status;
}
function call(fp, extra = {}, cwd = root) {
  return run({ tool_name: 'Edit', tool_input: { file_path: fp }, cwd, ...extra }, cwd);
}

test('block: cwd ไม่ตรงกับราก / ไม่ใช้ env ใช้ตำแหน่งสคริปต์', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-other-'));
  fs.mkdirSync(path.join(other, 'docs'));
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: 'docs/whiteboard.md' }, cwd: other }, root), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: path.join(other, 'docs', 'whiteboard.md') }, cwd: other }, root), 2);
});
const W = path.join(root, 'docs', 'whiteboard.md');

test('allow: relative / absolute / forward slash / case', () => {
  assert.strictEqual(call('docs/whiteboard.md'), 0);
  assert.strictEqual(call('docs\\whiteboard.md'), 0);
  assert.strictEqual(call('./docs/whiteboard.md'), 0);
  assert.strictEqual(call(W), 0);
  assert.strictEqual(call(W.replace(/\\/g, '/')), 0);
  assert.strictEqual(call(W.toUpperCase()), 0);
  assert.strictEqual(call('DOCS/WhiteBoard.MD'), 0);
  assert.strictEqual(call('docs/x/../whiteboard.md'), 0);
});

test('allow: ไฟล์ยังไม่มี (ENOENT) ก็ผ่านถ้า path ถูก', () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-empty-'));
  assert.strictEqual(call('docs/whiteboard.md', {}, r2), 0);
});

test('block: ไฟล์อื่นในโปรเจกต์', () => {
  for (const p of ['CLAUDE.md', '.claude/settings.json', 'docs/../CLAUDE.md', '../x', 'notes.txt',
    'docs/other.md', 'docs/whiteboard.md.bak', 'docs/sub/whiteboard.md', 'whiteboard.md',
    path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'agents', 'x.md')])
    assert.strictEqual(call(p), 2, p);
});

test('block: path นอกโปรเจกต์ / คนละไดรฟ์ / UNC', () => {
  assert.strictEqual(call('C:\\Windows\\win.ini'), 2);
  assert.strictEqual(call('D:\\docs\\whiteboard.md'), 2);
  assert.strictEqual(call('\\\\server\\share\\docs\\whiteboard.md'), 2);
  assert.strictEqual(call('//server/share/docs/whiteboard.md'), 2);
  assert.strictEqual(call('\\\\?\\' + W), 2);
  assert.strictEqual(call(path.join(os.tmpdir(), 'evil.txt')), 2);
});

test('block: ADS / trailing dot / space / 8.3 / null byte', () => {
  assert.strictEqual(call('docs/whiteboard.md:evil'), 2);
  assert.strictEqual(call('docs/whiteboard.md::$DATA'), 2);
  assert.strictEqual(call('docs/whiteboard.md.'), 2);
  assert.strictEqual(call('docs/whiteboard.md '), 2);
  assert.strictEqual(call('docs/whiteboard.md. .'), 2);
  assert.strictEqual(call('docs/WHITEB~1.MD'), 2);
  assert.strictEqual(call('docs/whiteboard.md\0.txt'), 2);
});

test('block: JSON เสีย / ว่าง / ไม่ใช่ object / ไม่มี field', () => {
  assert.strictEqual(run('{not json'), 2);
  assert.strictEqual(run(''), 2);
  assert.strictEqual(run('null'), 2);
  assert.strictEqual(run('"str"'), 2);
  assert.strictEqual(run('[]'), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: {}, cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: '' }, cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: '   ' }, cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: 123 }, cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: ['docs/whiteboard.md'] }, cwd: root }), 2);
  assert.strictEqual(run({ tool_name: 'Edit', tool_input: { file_path: 'docs/whiteboard.md' } }), 2); // ไม่มี cwd
});

test('NotebookEdit ใช้ notebook_path', () => {
  assert.strictEqual(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'docs/whiteboard.md' }, cwd: root }), 0);
  assert.strictEqual(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb' }, cwd: root }), 2);
});

test('file_path ปลอดภัยแต่ notebook_path อื่น: ใช้ file_path ก่อน (บันทึกพฤติกรรม)', () => {
  const s = run({ tool_name: 'Edit', tool_input: { file_path: 'docs/whiteboard.md', notebook_path: 'evil.ipynb' }, cwd: root });
  // ถ้า 0 = เครื่องมือจริงอาจใช้ notebook_path ได้ แต่ Edit ไม่มี field นี้
  assert.ok(s === 0 || s === 2);
});

test('symlink/junction', (t) => {
  // junction ของ docs
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-link-'));
  const real = path.join(r, 'realdocs');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'whiteboard.md'), 'x');
  try { fs.symlinkSync(real, path.join(r, 'docs'), 'junction'); }
  catch (e) { return t.skip('สร้าง junction ไม่ได้: ' + e.code); }
  assert.strictEqual(call('docs/whiteboard.md', {}, r), 2, 'docs junction');

  // symlink ของไฟล์ whiteboard.md
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-flink-'));
  fs.mkdirSync(path.join(r2, 'docs'));
  const target = path.join(r2, 'secret.txt');
  fs.writeFileSync(target, 'x');
  let fileLinked = true;
  try { fs.symlinkSync(target, path.join(r2, 'docs', 'whiteboard.md'), 'file'); }
  catch { fileLinked = false; }
  if (fileLinked) assert.strictEqual(call('docs/whiteboard.md', {}, r2), 2, 'file symlink');

  // whiteboard.md เป็นโฟลเดอร์
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-dir-'));
  fs.mkdirSync(path.join(r3, 'docs', 'whiteboard.md'), { recursive: true });
  assert.strictEqual(call('docs/whiteboard.md', {}, r3), 2, 'whiteboard.md เป็นโฟลเดอร์');
});

test('8.3 short name จริง (ถ้าระบบรองรับ)', (t) => {
  if (process.platform !== 'win32') return t.skip('ไม่ใช่ Windows');
  let short;
  try {
    short = execSync(`cmd /c "for %I in ("${W}") do @echo %~sI"`, { encoding: 'utf8' }).trim();
  } catch { return t.skip('ดึง short name ไม่ได้'); }
  if (!short || short.toLowerCase() === W.toLowerCase()) return t.skip('ไม่มี 8.3 name');
  assert.strictEqual(call(short), 2, short);
});

test.after(() => {
  for (const d of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('hooktest-'))) {
    try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch { /* ok */ }
  }
});
