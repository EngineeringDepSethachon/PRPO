'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../hooks-src/dept-guard');

const SCRIPT = path.join(__dirname, '..', 'hooks-src', 'dept-guard.js');

function dept() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dguard-')));
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  return root;
}
const call = (root, tool, fp, extra = {}) => decide(JSON.stringify({ tool_name: tool, tool_input: { file_path: fp }, cwd: root, ...extra }), root).reason;

test('อนุญาตไฟล์ใต้ docs/ (Write/Edit/MultiEdit)', () => {
  const r = dept();
  for (const t of ['Write', 'Edit', 'MultiEdit']) {
    assert.strictEqual(call(r, t, path.join(r, 'docs', 'ok.md')), null, t);
  }
  assert.strictEqual(call(r, 'Write', path.join(r, 'docs', 'sub', 'new', 'a.md')), null);
  assert.strictEqual(call(r, 'Write', 'docs/rel.md'), null);
  assert.strictEqual(call(r, 'Write', (path.join(r, 'docs', 'ok.md')).replace(/\\/g, '/')), null);
});

test('NotebookEdit ใช้ notebook_path', () => {
  const r = dept();
  const j = (p) => decide(JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: p }, cwd: r }), r).reason;
  assert.strictEqual(j(path.join(r, 'docs', 'a.ipynb')), null);
  assert.ok(j(path.join(r, 'a.ipynb')));
});

test('บล็อกนอก docs / แผนกอื่น / ไฟล์ราก / docs เอง', () => {
  const r = dept();
  assert.ok(call(r, 'Write', path.join(r, 'AGENTS.md')));
  assert.ok(call(r, 'Write', path.join(r, 'other', 'x.md')));
  assert.ok(call(r, 'Write', path.join(r, '.claude', 'settings.json')));
  assert.ok(call(r, 'Write', path.join(r, 'docs')));
  assert.ok(call(r, 'Write', path.join(r, 'docs2', 'x.md')));
  assert.ok(call(r, 'Write', path.join(path.dirname(r), 'departments', 'finance', 'docs', 'zz.md')));
  assert.ok(call(r, 'Write', path.join(r, 'docs', '..', 'AGENTS.md')));
  assert.ok(call(r, 'Write', 'docs/../x.md'));
});

test('ไม่สนตัวพิมพ์บน Windows ; ไม่มี path -> บล็อก', () => {
  const r = dept();
  if (process.platform === 'win32') {
    assert.strictEqual(call(r, 'Write', path.join(r, 'DOCS', 'Ok.md')), null);
    assert.ok(call(r, 'Write', path.join(r, 'DOCS', 'WHITEBOARD.MD')));
  }
  assert.ok(decide(JSON.stringify({ tool_name: 'Write', tool_input: {}, cwd: r }), r).reason);
  assert.ok(decide(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 5 }, cwd: r }), r).reason);
});

test('กัน ADS / 8.3 / UNC / trailing dot-space / wildcard / NUL', () => {
  const r = dept();
  const d = path.join(r, 'docs');
  for (const p of [
    d + '\\a.md:stream', d + '\\a.md::$DATA', d + '\\PROGRA~1\\a.md', d + '\\a.md.', d + '\\a.md ', d + '\\sub.\\a.md',
    '\\\\server\\share\\docs\\a.md', '\\\\?\\' + d + '\\a.md', '//host/x/docs/a.md', d + '\\*.md', d + '\\a\0.md',
  ]) {
    assert.ok(call(r, 'Write', p), JSON.stringify(p));
  }
});

test('whiteboard.md: เฉพาะ kafae-scribe', () => {
  const r = dept();
  const wb = path.join(r, 'docs', 'whiteboard.md');
  assert.ok(call(r, 'Edit', wb));
  assert.ok(call(r, 'Edit', wb, { agent_type: 'mint-researcher' }));
  assert.strictEqual(call(r, 'Edit', wb, { agent_type: 'kafae-scribe', agent_id: 'x' }), null);
  assert.strictEqual(call(r, 'Write', path.join(r, 'docs', 'whiteboard2.md')), null);
});

test('symlink/junction: ไฟล์, โฟลเดอร์ย่อย และ docs เองถูกบล็อก', () => {
  const r = dept();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dguard-out-'));
  const link = (target, p) => { try { fs.symlinkSync(target, p, 'junction'); return true; } catch { return false; } };
  if (link(outside, path.join(r, 'docs', 'lnk'))) {
    assert.ok(call(r, 'Write', path.join(r, 'docs', 'lnk', 'x.md')));
    assert.ok(call(r, 'Write', path.join(r, 'docs', 'lnk')));
  }
  const r2 = dept();
  fs.rmSync(path.join(r2, 'docs'), { recursive: true });
  if (link(outside, path.join(r2, 'docs'))) assert.ok(call(r2, 'Write', path.join(r2, 'docs', 'x.md')));
  const r3 = dept();
  fs.writeFileSync(path.join(outside, 'f.md'), 'x');
  try { fs.symlinkSync(path.join(outside, 'f.md'), path.join(r3, 'docs', 'fl.md'), 'file'); assert.ok(call(r3, 'Write', path.join(r3, 'docs', 'fl.md'))); } catch { /* ไม่มีสิทธิ์สร้าง symlink */ }
});

test('web: เฉพาะ mint-researcher ผ่าน ; subagent อื่นและ session หลักบล็อก', () => {
  const r = dept();
  const w = (tool, agent) => decide(JSON.stringify({ tool_name: tool, tool_input: { url: 'https://x' }, cwd: r, ...(agent ? { agent_type: agent } : {}) }), r).reason;
  for (const t of ['WebFetch', 'WebSearch']) {
    assert.strictEqual(w(t, 'mint-researcher'), null);
    assert.ok(w(t, null));
    assert.ok(w(t, 'bam-assistant'));
    assert.ok(w(t, 'kafae-scribe'));
  }
});

test('JSON เสีย/ไม่ใช่ object -> บล็อก ; tool อื่นไม่ยุ่ง', () => {
  const r = dept();
  assert.ok(decide('{oops', r).reason);
  assert.ok(decide('', r).reason);
  assert.ok(decide('[]', r).reason);
  assert.ok(decide('null', r).reason);
  assert.ok(decide(JSON.stringify({ tool_input: {} }), r).reason);
  assert.strictEqual(decide(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' }, cwd: r }), r).reason, null);
});

test('CLI: exit code 0/2 + stderr ภาษาไทย (รากจากตำแหน่งสคริปต์)', () => {
  const r = dept();
  const hooks = path.join(r, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const s = path.join(hooks, 'dept-guard.js');
  fs.copyFileSync(SCRIPT, s);
  const run = (input) => spawnSync(process.execPath, [s], { input, encoding: 'utf8' });
  const ok = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(r, 'docs', 'a.md') }, cwd: r }));
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(ok.stdout, '');
  // บล็อก = JSON permissionDecision:deny ทาง stdout + exit 0 (exit 2 ไม่บล็อกจริงบน harness นี้)
  const denied = (x) => {
    assert.strictEqual(x.status, 0, x.stderr);
    const o = JSON.parse(x.stdout).hookSpecificOutput;
    assert.strictEqual(o.hookEventName, 'PreToolUse');
    assert.strictEqual(o.permissionDecision, 'deny');
    assert.match(o.permissionDecisionReason, /บล็อก/);
  };
  denied(run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(r, 'AGENTS.md') }, cwd: r })));
  denied(run('not json'));
  denied(run(''));
});
