'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../hooks-src/exec-guard');
const { decide: deptDecide } = require('../hooks-src/dept-guard');
const { newExec } = require('../new-exec');

const SCRIPT = path.join(__dirname, '..', 'hooks-src', 'exec-guard.js');
const call = (tool) => decide(JSON.stringify({ tool_name: tool, tool_input: { file_path: 'x' } })).reason;

test('exec-guard: deny เครื่องมือเขียน/เว็บ ทุกตัว', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(call(t), t);
});

test('exec-guard: เครื่องมืออ่านผ่าน ; JSON เสีย/ไม่มี tool -> deny', () => {
  assert.strictEqual(call('Read'), null);
  assert.strictEqual(call('PowerShell'), null);
  assert.ok(decide('{bad').reason);
  assert.ok(decide('[]').reason);
  assert.ok(decide('{}').reason);
});

test('exec-guard: สคริปต์พิมพ์ deny JSON + exit 0 ; allow พิมพ์ว่าง', () => {
  const d = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a' } }), encoding: 'utf8' });
  assert.strictEqual(d.status, 0);
  assert.strictEqual(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'xx', encoding: 'utf8' });
  assert.strictEqual(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }), encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout, '');
});

test('new-exec: ติดตั้ง exec-guard.js + hook ใน settings + ไม่มี deny Edit(//C:/..)', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'xguard-'));
  fs.mkdirSync(path.join(r, 'office'), { recursive: true });
  fs.mkdirSync(path.join(r, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(r, 'office', 'departments.json'), JSON.stringify([
    { id: 'executive', name: 'Executive', kind: 'exec', root: 'departments/executive', addDirs: ['.'], manager: { name: 'fable', model: 'fable' } },
    { id: 'executive-biz', name: 'EB', kind: 'exec', root: 'departments/executive-biz', addDirs: ['docs'], manager: { name: 'celine', model: 'fable' } },
  ]));
  for (const id of ['executive', 'executive-biz']) {
    const res = newExec(r, { id, refresh: true });
    const g = path.join(res.outDir, '.claude', 'hooks', 'exec-guard.js');
    assert.ok(fs.existsSync(g));
    const hook = res.settings.hooks.PreToolUse[0];
    assert.match(hook.matcher, /Edit\|Write\|MultiEdit\|NotebookEdit\|WebFetch\|WebSearch/);
    assert.strictEqual(hook.hooks[0].command, 'node "' + g.replace(/\\/g, '/') + '"');
    assert.ok(res.settings.permissions.deny.includes('Edit(//**)'));
    assert.ok(!res.settings.permissions.deny.some((d) => /^Edit\(\/\/[A-Za-z]:/.test(d)));
  }
});

test('dept-guard: เลือก path ตามเครื่องมือ ; หลายฟิลด์ไม่ตรงกัน -> deny', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dg2-')));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const ok = path.join(root, 'docs', 'a.md');
  const bad = path.join(root, 'x.md');
  const d = (tool, input) => deptDecide(JSON.stringify({ tool_name: tool, tool_input: input, cwd: root }), root).reason;
  assert.strictEqual(d('Write', { file_path: ok }), null);
  assert.ok(d('Write', { file_path: ok, notebook_path: bad }));
  assert.ok(d('Write', { file_path: ok, path: bad }));
  assert.ok(d('NotebookEdit', { notebook_path: ok, file_path: bad }));
  assert.ok(d('Write', { notebook_path: ok }), 'Write ต้องใช้ file_path เท่านั้น');
  assert.strictEqual(d('NotebookEdit', { notebook_path: ok }), null);
});
