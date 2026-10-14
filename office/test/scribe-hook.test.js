'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { newDept, refreshDept, askPathFor } = require('../new-dept');

const PROJ = path.join(__dirname, '..', '..');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scribehook-'));
  fs.mkdirSync(path.join(root, 'office'));
  fs.cpSync(path.join(PROJ, 'claude-setup'), path.join(root, 'claude-setup'), { recursive: true });
  return root;
}
function cmdOf(file) {
  const m = fs.readFileSync(file, 'utf8').match(/command:\s*'(.*)'/);
  return m && m[1];
}

test('new-dept: คำสั่ง hook เป็น path เต็ม และบล็อก (deny JSON) แม้รันจาก cwd อื่น', () => {
  const root = mkProject();
  const r = newDept(root, 'hooktest', 'Hook Test');
  const cmd = cmdOf(path.join(r.abs, '.claude', 'agents', 'kafae-scribe.md'));
  assert.ok(cmd && /^node "[^"]*whiteboard-only\.js"$/.test(cmd), cmd);
  const hook = cmd.slice(6, -1);
  assert.ok(path.isAbsolute(hook) && fs.existsSync(hook), hook);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'scribehook-cwd-'));
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(r.abs, 'CLAUDE.md') }, cwd: other });
  const res = spawnSync(process.execPath, [hook], { input, cwd: other, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('new-dept: ไม่มีไฟล์ hook -> เตือน', () => {
  const root = mkProject();
  fs.rmSync(path.join(root, 'claude-setup', 'hooks'), { recursive: true, force: true });
  const r = newDept(root, 'nohook', 'No Hook');
  assert.ok(r.warnings.some(w => /whiteboard-only/.test(w)), JSON.stringify(r.warnings));
  fs.rmSync(root, { recursive: true, force: true });
});

test('scribe-hook: regex ไม่ match -> throw ข้อความชัด', () => {
  const { rewriteScribeHook } = require('../scribe-hook');
  assert.throws(() => rewriteScribeHook('no hook here', os.tmpdir()), /ไม่พบบรรทัด/);
});

test('scribe-hook: ปฏิเสธ path ที่มี % และ !', () => {
  const { hookCommand } = require('../scribe-hook');
  for (const bad of ['a%b', 'a!b']) assert.throws(() => hookCommand(path.join(os.tmpdir(), bad)), /ใช้ใน hook command ไม่ได้/);
});

test('new-dept: ต้นฉบับ kafae-scribe ไม่มีบรรทัด hook -> error ไม่เงียบ (CLI exit 1)', () => {
  const root = mkProject();
  fs.writeFileSync(path.join(root, 'claude-setup', 'agents', 'kafae-scribe.md'), '---\nname: x\n---\n');
  assert.throws(() => newDept(root, 'badsrc', 'Bad'), /ไม่พบบรรทัด/);
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'new-dept.js'), 'badsrc2', 'Bad'], { encoding: 'utf8', env: { ...process.env, OFFICE_ROOT: root } });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /ERROR/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('setup.js: ต้นฉบับ kafae-scribe ผิดรูปแบบ -> exit 1 พร้อม error', () => {
  const root = mkProject();
  fs.writeFileSync(path.join(root, 'claude-setup', 'agents', 'kafae-scribe.md'), 'broken');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js')], { encoding: 'utf8', env: { ...process.env, OFFICE_ROOT: root } });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /ERROR/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dept-template: allow = PowerShell ask path เท่านั้น ไม่มี Bash allow / $OFFICE_ASK', () => {
  const T = path.join(__dirname, '..', 'dept-template');
  const s = JSON.parse(fs.readFileSync(path.join(T, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(s.permissions.allow, ['PowerShell(node "{{ASK_PATH}}":*)', 'PowerShell(node "{{CONSULT_PATH}}":*)', 'PowerShell(node "{{MEMO_PATH}}":*)']);
  assert.ok(!/\$env:OFFICE_ASK|\$OFFICE_ASK/.test(fs.readFileSync(path.join(T, 'CLAUDE.md'), 'utf8')));
});

test('new-dept: แทน ASK_PATH ถูก ไม่มี placeholder ค้าง; refresh ไม่แตะ whiteboard', () => {
  const root = mkProject();
  const r = newDept(root, 'askt', 'Ask Test');
  const expect = path.join(root, 'office', 'ask.js').replace(/\\/g, '/');
  const md = fs.readFileSync(path.join(r.abs, 'CLAUDE.md'), 'utf8');
  const st = fs.readFileSync(path.join(r.abs, '.claude', 'settings.json'), 'utf8');
  assert.ok(md.includes('node "' + expect + '" --wait'));
  const expectC = path.join(root, 'office', 'consult.js').replace(/\\/g, '/');
  const expectM = path.join(root, 'office', 'memo.js').replace(/\\/g, '/');
  assert.deepStrictEqual(JSON.parse(st).permissions.allow, ['PowerShell(node "' + expect + '":*)', 'PowerShell(node "' + expectC + '":*)', 'PowerShell(node "' + expectM + '":*)']);
  assert.ok(md.includes('node "' + expectM + '" --to'), 'CLAUDE.md มีหัวข้อ memo');
  for (const t of [md, st]) assert.ok(!/\{\{(ASK_PATH|CONSULT_PATH|MEMO_PATH|ROOMS|MANAGER)\}\}/.test(t.replace('Ask Test', '')));
  const wb = path.join(r.abs, 'docs', 'whiteboard.md');
  fs.writeFileSync(wb, 'MY BOARD');
  fs.writeFileSync(path.join(r.abs, 'CLAUDE.md'), 'old');
  const rr = refreshDept(root, 'askt');
  assert.strictEqual(rr.written.length, 2);
  assert.strictEqual(fs.readFileSync(wb, 'utf8'), 'MY BOARD');
  assert.ok(fs.readFileSync(path.join(r.abs, 'CLAUDE.md'), 'utf8').includes(expect));
  assert.throws(() => refreshDept(root, 'nope'), /ไม่พบแผนก/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('askPathFor: ปฏิเสธอักขระต้องห้าม', () => {
  for (const bad of ['a"b', "a'b", 'a`b', 'a$b', 'a%b', 'a!b', 'a\nb']) assert.throws(() => askPathFor(bad), /permission rule/, JSON.stringify(bad));
  assert.ok(askPathFor('C:\\x y\\z').startsWith('C:/x y/z/office/'));
});

test('setup.js: แทน path เต็มเฉพาะ kafae-scribe, ไฟล์อื่น byte-for-byte, ไม่มี hook -> เตือน', () => {
  const root = mkProject();
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js')], { encoding: 'utf8', env: { ...process.env, OFFICE_ROOT: root } });
  let res = run();
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(/^node "[^"]*\.claude\/hooks\/whiteboard-only\.js"$/.test(cmdOf(path.join(root, '.claude', 'agents', 'kafae-scribe.md'))));
  assert.ok(fs.readFileSync(path.join(root, '.claude', 'agents', 'malee-coder.md')).equals(fs.readFileSync(path.join(root, 'claude-setup', 'agents', 'malee-coder.md'))));
  fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'claude-setup', 'hooks'), { recursive: true, force: true });
  res = run();
  assert.ok(/whiteboard-only/.test(res.stderr), res.stderr);
  fs.rmSync(root, { recursive: true, force: true });
});
