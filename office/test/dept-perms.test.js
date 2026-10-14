'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshDept } = require('../new-dept');
const { loadDepartments } = require('../depts');

const CFG = [
  { id: 'executive', name: 'Executive', kind: 'exec', root: 'departments/executive', addDirs: ['.'], manager: { name: 'fable', model: 'fable' } },
  { id: 'marketing', name: 'Marketing', root: 'departments/marketing', web: true, addDirs: ['docs'], manager: { name: 'keith', model: 'opus' } },
  { id: 'finance', name: 'Finance', root: 'departments/finance', web: 'yes', addDirs: ['docs'], manager: { name: 'frank', model: 'opus' } },
];

function proj() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dperm-'));
  fs.mkdirSync(path.join(r, 'office'), { recursive: true });
  fs.writeFileSync(path.join(r, 'office', 'departments.json'), JSON.stringify(CFG));
  for (const d of ['docs', 'departments/marketing', 'departments/finance']) fs.mkdirSync(path.join(r, d), { recursive: true });
  return r;
}
const settings = (r, id) => JSON.parse(fs.readFileSync(path.join(r, 'departments', id, '.claude', 'settings.json'), 'utf8'));

test('web parse เป็น boolean (เฉพาะ true จริง)', () => {
  const r = proj();
  const w = console.warn; console.warn = () => {};
  let l; try { l = loadDepartments(r); } finally { console.warn = w; }
  assert.strictEqual(l.find((d) => d.id === 'marketing').web, true);
  assert.strictEqual(l.find((d) => d.id === 'finance').web, false);
  assert.strictEqual(l.find((d) => d.id === 'prototype').web, false);
});

test('refresh: WebSearch/WebFetch เฉพาะ web:true ; deny Edit addDirs', () => {
  const r = proj();
  refreshDept(r, 'marketing');
  refreshDept(r, 'finance');
  const m = settings(r, 'marketing').permissions;
  const f = settings(r, 'finance').permissions;
  assert.ok(m.allow.includes('WebSearch') && m.allow.includes('WebFetch'));
  assert.ok(!f.allow.includes('WebSearch') && !f.allow.includes('WebFetch'));
  assert.ok(m.allow.some((x) => x.includes('consult.js')) && m.allow.some((x) => x.includes('ask.js')));
  // deny Edit(//C:/...) ใช้ไม่ได้จริง -> ต้องไม่มี ; ใช้ hook dept-guard แทน
  assert.ok(!m.deny.some((x) => x.startsWith('Edit(//')) && !f.deny.some((x) => x.startsWith('Edit(//')));
  for (const id of ['marketing', 'finance']) {
    const s = settings(r, id);
    const h = s.hooks.PreToolUse[0];
    assert.strictEqual(h.matcher, 'Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch');
    const guard = path.join(r, 'departments', id, '.claude', 'hooks', 'dept-guard.js').replace(/\\/g, '/');
    assert.strictEqual(h.hooks[0].command, 'node "' + guard + '"');
    assert.ok(fs.existsSync(guard));
    assert.ok(s.permissions.deny.includes('Read(//**/.env*)') && s.permissions.deny.includes('Read(//**/mosquitto/certs*/**)'));
  }
});

test('refresh คัด dept-agents (marketing) ไป .claude/agents และไม่แตะ kafae-scribe', () => {
  const r = proj();
  const agentsDir = path.join(r, 'departments', 'marketing', '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'kafae-scribe.md'), 'KEEP');
  fs.writeFileSync(path.join(agentsDir, 'mint-researcher.md'), 'OLD');
  const res = refreshDept(r, 'marketing');
  assert.ok(res.agents.includes('mint-researcher.md'));
  assert.notStrictEqual(fs.readFileSync(path.join(agentsDir, 'mint-researcher.md'), 'utf8'), 'OLD');
  assert.strictEqual(fs.readFileSync(path.join(agentsDir, 'kafae-scribe.md'), 'utf8'), 'KEEP');
  assert.deepStrictEqual(refreshDept(r, 'finance').agents.sort(), fs.readdirSync(path.join(__dirname, '..', 'dept-agents', 'finance')).filter((n) => n.endsWith('.md') && n !== 'kafae-scribe.md').sort());
});
