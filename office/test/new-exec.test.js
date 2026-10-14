'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newExec } = require('../new-exec');
const { newDept, refreshDept } = require('../new-dept');
const { RESERVED } = require('../depts');

const CFG = [
  { id: 'executive', name: 'Executive', kind: 'exec', root: 'departments/executive', addDirs: ['.'], manager: { name: 'fable', model: 'fable' } },
  { id: 'executive-biz', name: 'Executive Biz', kind: 'exec', root: 'departments/executive-biz', addDirs: ['docs'], manager: { name: 'celine', model: 'fable' } },
  { id: 'prototype', name: 'Prototype Team', root: '.', approver: 'executive', manager: { name: 'neo', model: 'opus' } },
  { id: 'marketing', name: 'Marketing', root: 'departments/marketing', approver: 'executive-biz', manager: { name: 'keith', model: 'opus' } },
];

function proj() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'nexec-'));
  fs.mkdirSync(path.join(r, 'office'), { recursive: true });
  fs.writeFileSync(path.join(r, 'office', 'departments.json'), JSON.stringify(CFG));
  fs.mkdirSync(path.join(r, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(r, 'departments', 'marketing'), { recursive: true });
  return r;
}
const read = (r, id, rel) => fs.readFileSync(path.join(r, 'departments', id, rel), 'utf8');

test('new-exec biz: role/placeholder ไม่ค้าง และมีชื่อ/approves/peer', () => {
  const r = proj();
  newExec(r, { id: 'executive-biz' });
  const md = read(r, 'executive-biz', 'CLAUDE.md');
  const st = read(r, 'executive-biz', '.claude/settings.json');
  assert.ok(!/\{\{/.test(md) && !/\{\{/.test(st));
  assert.match(md, /Celine/);
  assert.match(md, /Marketing \(id: marketing\) หัวหน้า Keith/);
  assert.doesNotMatch(md, /Prototype Team \(id/);
  assert.match(md, /Fable \(ห้อง id: executive\)/);
  assert.match(md, /--to executive /);
  assert.match(md, /Marketing \+ Finance/);
  const s = JSON.parse(st);
  assert.ok(s.permissions.allow.some((a) => a.includes('consult.js')));
  assert.ok(s.permissions.allow.some((a) => /memo\.js":\*\)$/.test(a)), 'exec allow memo.js');
  assert.match(md, /node ".*\/office\/memo\.js" --to/);
  assert.match(md, /ประสานงานข้ามห้อง \(memo\)/);
  assert.doesNotMatch(md, /\{\{\w+\}\}/);
  for (const d of ['Read(//**/.env*)', 'Read(//**/*.key)', 'Read(//**/ca-private/**)', 'Read(//**/mosquitto/certs*/**)', 'WebFetch', 'WebSearch', 'Edit(//**)', 'Write(//**)']) {
    assert.ok(s.permissions.deny.includes(d), d);
  }
});

test('new-exec tech (default) และ --refresh ทับ', () => {
  const r = proj();
  newExec(r, {});
  const md = read(r, 'executive', 'CLAUDE.md');
  assert.match(md, /Fable = ผู้บริหาร/);
  assert.match(md, /เทคนิค/);
  assert.match(md, /Prototype Team \(id: prototype\) หัวหน้า Neo/);
  assert.match(md, /Celine \(ห้อง id: executive-biz\)/);
  assert.doesNotMatch(md, /\{\{/);
  fs.writeFileSync(path.join(r, 'departments', 'executive', 'CLAUDE.md'), 'old');
  newExec(r, {});
  assert.strictEqual(read(r, 'executive', 'CLAUDE.md'), 'old');
  newExec(r, { refresh: true });
  assert.match(read(r, 'executive', 'CLAUDE.md'), /Fable/);
});

test('new-exec: id ไม่ใช่ exec / role ผิด -> error', () => {
  const r = proj();
  assert.throws(() => newExec(r, { id: 'marketing' }), /exec/);
  assert.throws(() => newExec(r, { id: 'nope' }), /ไม่พบ/);
  assert.throws(() => newExec(r, { role: 'x' }), /role/);
});

test('RESERVED มี executive-biz และ new-dept ปฏิเสธ', () => {
  assert.ok(RESERVED.includes('executive-biz'));
  const r = proj();
  assert.throws(() => newDept(r, 'executive-biz', 'X'), /สงวน/);
  assert.throws(() => refreshDept(r, 'executive-biz'), /refresh/);
});

test('APPROVER_NAME: แผนกใหม่ = Fable ; refresh ตาม approver ใน config', () => {
  const r = proj();
  const res = newDept(r, 'legal', 'Legal');
  const md = fs.readFileSync(path.join(res.abs, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(md, /\{\{/);
  assert.match(md, /ขออนุมัติจาก Fable/);
  refreshDept(r, 'marketing');
  const m = fs.readFileSync(path.join(r, 'departments', 'marketing', 'CLAUDE.md'), 'utf8');
  assert.match(m, /ขออนุมัติจาก Celine/);
  assert.match(m, /ผลอนุมัติจาก Celine/);
  assert.doesNotMatch(m, /\{\{/);
});
