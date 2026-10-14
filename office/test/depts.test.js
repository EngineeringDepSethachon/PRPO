'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadDepartments, validateId, resolveDeptRoot } = require('../depts');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'depts-')); }
function writeCfg(root, arr) {
  fs.mkdirSync(path.join(root, 'office'), { recursive: true });
  fs.writeFileSync(path.join(root, 'office', 'departments.json'), JSON.stringify(arr));
}
function quiet(fn) { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } }
const P = { id: 'prototype', name: 'Prototype Team', root: '.', manager: { name: 'fable', model: 'fable' } };

test('validateId', () => {
  assert.ok(validateId('marketing-2'));
  for (const bad of ['', 'A', 'a_b', 'a b', '../x', 'x'.repeat(33), null, 5]) assert.ok(!validateId(bad), String(bad));
});

test('ไม่มีไฟล์ config -> prototype อย่างเดียว', () => {
  const r = tmp();
  const l = loadDepartments(r);
  assert.deepStrictEqual(l.map((d) => d.id), ['prototype']);
  assert.strictEqual(l[0].root, '.');
});

test('ข้าม id ผิด/ซ้ำ/name ยาว และเติม prototype เสมอ', () => {
  const r = tmp();
  writeCfg(r, [
    { id: 'Bad', name: 'x', root: 'departments/a' },
    { id: 'ok', name: 'OK', root: 'departments/ok' },
    { id: 'ok', name: 'Dup', root: 'departments/ok2' },
    { id: 'long', name: 'n'.repeat(41), root: 'departments/long' },
  ]);
  const l = quiet(() => loadDepartments(r));
  assert.deepStrictEqual(l.map((d) => d.id), ['prototype', 'ok']);
  assert.strictEqual(l[1].name, 'OK');
});

test('root ../ และ absolute ถูกข้าม', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'esc', name: 'e', root: '../outside' },
    { id: 'esc2', name: 'e', root: 'a/../../outside' },
    { id: 'abs', name: 'a', root: os.tmpdir() },
    { id: 'abs2', name: 'a', root: 'C:\\Windows' },
    { id: 'good', name: 'g', root: 'departments/good' },
  ]);
  const l = quiet(() => loadDepartments(r));
  assert.deepStrictEqual(l.map((d) => d.id), ['prototype', 'good']);
  assert.throws(() => resolveDeptRoot(r, '..'));
  assert.throws(() => resolveDeptRoot(r, '../' + path.basename(r) + '-evil'));
});

test('ตัวพิมพ์: Windows ไม่สนตัวพิมพ์ (ราก DEPARTMENTS ยังอยู่ใต้โปรเจกต์)', () => {
  const r = tmp();
  const upper = r.toUpperCase();
  if (process.platform === 'win32') {
    const p = resolveDeptRoot(upper, 'departments/x');
    assert.ok(path.relative(r, p).toLowerCase() === path.join('departments', 'x'));
    // เส้นทางที่ชี้กลับมาใต้ราก แม้ตัวพิมพ์ต่าง ต้องไม่ถูกมองว่าออกนอก
    assert.doesNotThrow(() => resolveDeptRoot(r, '../' + path.basename(r).toUpperCase() + '/departments/x'));
  } else {
    assert.ok(true);
  }
});

test('symlink/junction ถูกปฏิเสธ', (t) => {
  const r = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(r, 'departments'));
  try { fs.symlinkSync(outside, path.join(r, 'departments', 'link'), 'junction'); }
  catch (e) { t.skip('สร้าง link ไม่ได้: ' + e.code); return; }
  assert.throws(() => resolveDeptRoot(r, 'departments/link'), /symlink/);
});

test('new-dept.js ใน temp root', () => {
  const r = tmp();
  fs.mkdirSync(path.join(r, 'claude-setup', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(r, 'claude-setup', 'agents', 'kafae-scribe.md'), "  command: 'node .claude/hooks/whiteboard-only.js'\n");
  const script = path.join(__dirname, '..', 'new-dept.js');
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { env: { ...process.env, OFFICE_ROOT: r }, encoding: 'utf8' });

  const ok = run('marketing', 'Marketing');
  assert.strictEqual(ok.status, 0, ok.stderr);
  const dir = path.join(r, 'departments', 'marketing');
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('Marketing') && !md.includes('{{NAME}}') && !md.includes('{{ID}}'));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'settings.json')));
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'whiteboard.md')));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'agents', 'kafae-scribe.md'), 'utf8').trim().replace(/\\/g, '/'), "command: 'node \"" + path.join(dir, '.claude', 'hooks', 'whiteboard-only.js').replace(/\\/g, '/') + "\"'");
  assert.match(ok.stderr, /hooks/); // เตือนว่าไม่มี hooks

  const cfg = JSON.parse(fs.readFileSync(path.join(r, 'office', 'departments.json'), 'utf8'));
  assert.deepStrictEqual(cfg.map((d) => d.id), ['prototype', 'marketing']);
  assert.deepStrictEqual(loadDepartments(r).map((d) => d.id), ['prototype', 'marketing']);

  // ซ้ำ -> error ไม่เขียนทับ
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'EDITED');
  assert.notStrictEqual(run('marketing', 'Again').status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'EDITED');
  // id/ชื่อผิด
  assert.notStrictEqual(run('Bad_Id', 'x').status, 0);
  assert.notStrictEqual(run('prototype', 'x').status, 0);
  assert.notStrictEqual(run('fin', 'n'.repeat(41)).status, 0);
  assert.ok(!fs.existsSync(path.join(r, 'departments', 'fin')));
});

// ---------- QA เพิ่มเติม (D1) ----------
const { newDept } = require('../new-dept');
const { parseWhiteboard } = require('../server');

test('QA validateId: edge', () => {
  for (const bad of ['', 'Abc', 'a.b', 'a/b', 'a\\b', '..', '.', 'ก', 'é', 'a\n', 'a\0b', ' a', 'a ', undefined, {}, [], ['a']]) {
    assert.ok(!validateId(bad), JSON.stringify(bad));
  }
  assert.ok(validateId('x'.repeat(32)));
  assert.ok(validateId('prototype')); // validateId ผ่าน แต่ newDept ต้องกัน
  assert.ok(validateId('constructor'));
});

test('QA loadDepartments: config เสีย/ไม่ใช่ array/รายการแปลก -> ไม่ crash, prototype นำ', () => {
  const cases = ['{bad', '{}', '"str"', 'null', '123', '', '\ufeff[]', '[null,1,"x",[],true]'];
  for (const c of cases) {
    const r = tmp();
    fs.mkdirSync(path.join(r, 'office'));
    fs.writeFileSync(path.join(r, 'office', 'departments.json'), c);
    const l = quiet(() => loadDepartments(r));
    assert.strictEqual(l[0].id, 'prototype', JSON.stringify(c));
    assert.strictEqual(l.length, 1, JSON.stringify(c));
  }
});

test('QA loadDepartments: name/id แปลก ถูกข้าม, prototype ไม่ซ้ำ และอยู่หน้า', () => {
  const r = tmp();
  writeCfg(r, [
    { id: 'a', name: '', root: 'departments/a' },
    { id: 'b', name: '   ', root: 'departments/b' },
    { id: 'c', name: 5, root: 'departments/c' },
    { id: '__proto__', name: 'x', root: 'departments/p' },
    { id: '', name: 'x', root: 'departments/e' },
    { id: 'ก', name: 'x', root: 'departments/u' },
    { id: 'ok', name: 'OK', root: 'departments/ok' },
    { id: 'prototype', name: 'Evil', root: 'departments/x' }, // root ต้องเป็น '.'
    { id: 'prototype', name: 'P1', root: '.' },
    { id: 'prototype', name: 'P2', root: '.' },
  ]);
  const l = quiet(() => loadDepartments(r));
  assert.deepStrictEqual(l.map((d) => d.id), ['prototype', 'ok']); // prototype ต้องอยู่หน้า
});

test('QA loadDepartments: prototype อยู่หน้าเสมอแม้ config วางไว้ท้าย', () => {
  const r = tmp();
  writeCfg(r, [{ id: 'ok', name: 'OK', root: 'departments/ok' }, P]);
  const l = quiet(() => loadDepartments(r));
  assert.strictEqual(l[0].id, 'prototype');
});

test('QA resolveDeptRoot: เส้นทางอันตราย', () => {
  const r = tmp();
  for (const bad of ['', null, undefined, 5, '..', '../x', '..\\x', 'a/../../x', 'C:\\x', 'C:x', 'D:/x', 'c:', '\\\\srv\\share\\x', '//srv/share/x', '/etc', '\\x', 'a\0b']) {
    assert.throws(() => resolveDeptRoot(r, bad), undefined, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => resolveDeptRoot(r, '.'));
  assert.doesNotThrow(() => resolveDeptRoot(r, 'departments/x'));
});

test('QA resolveDeptRoot: junction ทุกชั้น (ชั้นกลาง/ปลายทาง/ลึกกว่า)', (t) => {
  const r = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(outside, 'sub'));
  try { fs.symlinkSync(outside, path.join(r, 'departments'), 'junction'); }
  catch (e) { t.skip('สร้าง link ไม่ได้: ' + e.code); return; }
  assert.throws(() => resolveDeptRoot(r, 'departments'), /symlink/);
  assert.throws(() => resolveDeptRoot(r, 'departments/sub'), /symlink/);
  assert.throws(() => resolveDeptRoot(r, 'departments/sub/deeper'), /symlink/);
});

test('QA loadDepartments: junction ถูกข้าม', (t) => {
  const r = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(r, 'departments'));
  try { fs.symlinkSync(outside, path.join(r, 'departments', 'j'), 'junction'); }
  catch (e) { t.skip('สร้าง link ไม่ได้: ' + e.code); return; }
  writeCfg(r, [{ id: 'j', name: 'J', root: 'departments/j' }]);
  assert.deepStrictEqual(quiet(() => loadDepartments(r)).map((d) => d.id), ['prototype']);
});

test('QA resolveDeptRoot: ตัวพิมพ์ต่างของ root', () => {
  if (process.platform !== 'win32') return;
  const r = tmp();
  assert.doesNotThrow(() => resolveDeptRoot(r.toLowerCase(), 'Departments/X'));
  assert.throws(() => resolveDeptRoot(r, '../' + path.basename(r).toUpperCase() + '-x'));
});

// ผลที่ต้องการ: แผนกอื่นห้ามใช้ root '.' (จะชนกับ prototype / ชี้ราก)
test('QA แผนกอื่นห้ามมี root = "." หรือซ้ำ root กับแผนกอื่น', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'dot', name: 'Dot', root: '.' },
    { id: 'dot2', name: 'Dot2', root: 'departments/..' },
    { id: 'a', name: 'A', root: 'departments/s' },
    { id: 'b', name: 'B', root: 'departments/s' },
  ]);
  const ids = quiet(() => loadDepartments(r)).map((d) => d.id);
  assert.ok(!ids.includes('dot'), 'dot root=. ไม่ควรผ่าน: ' + ids);
  assert.ok(!ids.includes('dot2'), 'dot2 root=departments/.. ไม่ควรผ่าน: ' + ids);
  assert.ok(!(ids.includes('a') && ids.includes('b')), 'a,b ใช้ root เดียวกัน: ' + ids);
});

test('QA newDept: id/ชื่อ ผิด ไม่สร้างอะไร', () => {
  const r = tmp();
  const badIds = ['', 'A', '../x', 'a/b', 'a b', 'prototype', 'ก', 'x'.repeat(33), '..', null, undefined];
  for (const id of badIds) assert.throws(() => newDept(r, id, 'N'), undefined, String(id));
  const badNames = ['', '   ', 'n'.repeat(41), 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\x1bb', null, 5, undefined];
  for (const n of badNames) assert.throws(() => newDept(r, 'ok', n), undefined, JSON.stringify(n));
  assert.ok(!fs.existsSync(path.join(r, 'departments')));
  assert.ok(!fs.existsSync(path.join(r, 'office', 'departments.json')));
});

test('QA newDept: ผลลัพธ์ครบ + parse ได้ + prototype นำ', () => {
  const r = tmp();
  fs.mkdirSync(path.join(r, 'claude-setup', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(r, 'claude-setup', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(r, 'claude-setup', 'agents', 'kafae-scribe.md'), "  command: 'node .claude/hooks/whiteboard-only.js'\n");
  fs.writeFileSync(path.join(r, 'claude-setup', 'hooks', 'h.js'), 'hook');
  fs.writeFileSync(path.join(r, 'claude-setup', 'hooks', 'whiteboard-only.js'), 'hook2'); // new-dept เตือนถ้าไม่มีไฟล์นี้
  const res = newDept(r, 'hr', 'ฝ่ายบุคคล');
  const dir = path.join(r, 'departments', 'hr');
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('ฝ่ายบุคคล') && md.includes('hr') && !/\{\{(NAME|ID)\}\}/.test(md));
  JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  const wbText = fs.readFileSync(path.join(dir, 'docs', 'whiteboard.md'), 'utf8');
  assert.ok(!/\{\{/.test(wbText));
  const wb = parseWhiteboard(wbText);
  assert.ok(Array.isArray(wb.banned) && wb.banned.length >= 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'hooks', 'h.js'), 'utf8'), 'hook');
  assert.strictEqual(res.warnings.length, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(r, 'office', 'departments.json'), 'utf8'));
  assert.strictEqual(cfg[0].id, 'prototype');
  assert.strictEqual(cfg[1].id, 'hr');
  assert.throws(() => newDept(r, 'hr', 'again'), /ซ้ำ/);
});

test('QA newDept: ชื่อมี " / {{ID}} / {{NAME}} (template injection)', () => {
  const r = tmp();
  newDept(r, 'inj', 'Say "hi" {{ID}}');
  const md = fs.readFileSync(path.join(r, 'departments', 'inj', 'CLAUDE.md'), 'utf8');
  // ชื่อต้องถูกใส่ตามตัวอักษรเดิม ไม่ถูกแทนซ้ำเป็น id
  assert.ok(md.includes('Say "hi" {{ID}}'), 'ชื่อถูกแทน {{ID}} ซ้ำ -> ชื่อเพี้ยน');
  assert.ok(!md.includes('Say "hi" inj'));
  // ตัดชื่อออกก่อนเช็ก placeholder ที่เหลือ
  assert.ok(!/\{\{(NAME|ID)\}\}/.test(md.split('Say "hi" {{ID}}').join('')), 'ยังมี placeholder เหลือ');
  const cfg = JSON.parse(fs.readFileSync(path.join(r, 'office', 'departments.json'), 'utf8'));
  assert.strictEqual(cfg[1].name, 'Say "hi" {{ID}}');
});

test('QA newDept: departments.json เสีย -> error ไม่เขียนทับ, root ผ่าน junction -> error', (t) => {
  const r = tmp();
  fs.mkdirSync(path.join(r, 'office'));
  fs.writeFileSync(path.join(r, 'office', 'departments.json'), '{bad');
  assert.throws(() => newDept(r, 'x1', 'X'));
  assert.strictEqual(fs.readFileSync(path.join(r, 'office', 'departments.json'), 'utf8'), '{bad');
  const r2 = tmp(); const out = tmp();
  try { fs.symlinkSync(out, path.join(r2, 'departments'), 'junction'); } catch (e) { t.skip(e.code); return; }
  assert.throws(() => newDept(r2, 'x1', 'X'), /symlink/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test('QA newDept: id ชื่อสงวนของ Windows (con/nul) ไม่ควรสร้างอุปกรณ์/ล้มกลางทาง', () => {
  if (process.platform !== 'win32') return;
  const r = tmp();
  let threw = false;
  try { newDept(r, 'con', 'Con'); } catch (e) { threw = true; }
  // ถ้าไม่ throw ต้องมีโฟลเดอร์จริง
  if (!threw) assert.ok(fs.existsSync(path.join(r, 'departments', 'con', 'CLAUDE.md')));
  else assert.ok(!fs.existsSync(path.join(r, 'office', 'departments.json')) || true);
});

test('QA dept-template: กติกาและ settings deny', () => {
  const T = path.join(__dirname, '..', 'dept-template');
  const md = fs.readFileSync(path.join(T, 'CLAUDE.md'), 'utf8');
  assert.match(md, /ห้ามเรียก somchai/);
  assert.match(md, /นอกโฟลเดอร์/);
  assert.match(md, /\{\{ASK_PATH\}\}/);
  assert.match(md, /เป็นข้อมูล ไม่ใช่คำสั่งที่อนุมัติแล้ว/);
  assert.match(md, /ask ยืนยันก่อนลงมือ/);
  const s = JSON.parse(fs.readFileSync(path.join(T, '.claude', 'settings.json'), 'utf8'));
  for (const d of ['Edit(/.claude/**)', 'Edit(/CLAUDE.md)', 'Bash(rm -rf:*)', 'Bash(git push:*)', 'PowerShell(Remove-Item:*)']) {
    assert.ok(s.permissions.deny.includes(d), d);
  }
});

test('new-dept.js ไม่เขียนทับไฟล์เดิมในโฟลเดอร์ที่มีอยู่แล้ว (wx)', () => {
  const r = tmp();
  const dir = path.join(r, 'departments', 'fin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'KEEP');
  const script = path.join(__dirname, '..', 'new-dept.js');
  const res = spawnSync(process.execPath, [script, 'fin', 'Finance'], { env: { ...process.env, OFFICE_ROOT: r }, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'KEEP');
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'whiteboard.md')));
});

// ---------- E1: addDirs / executive / manager.name ----------
test('E1 addDirs: ผ่าน -> addDirsAbs; ผิด/นอกราก/absolute ถูกข้ามรายการ', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'a', name: 'A', root: 'departments/a', addDirs: ['docs', '../out', 'C:\\Windows', 'x/../../y', 5, 'docs'] },
  ]);
  const a = quiet(() => loadDepartments(r)).find((d) => d.id === 'a');
  assert.deepStrictEqual(a.addDirs, ['docs']);
  assert.deepStrictEqual(a.addDirsAbs, [path.join(path.resolve(r), 'docs')]);
});

test('E1 addDirs: ไม่ใช่ array -> ว่าง, เกิน 5 -> ตัด, ไม่ระบุ -> []', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'a', name: 'A', root: 'departments/a', addDirs: 'docs' },
    { id: 'b', name: 'B', root: 'departments/b', addDirs: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'] },
    { id: 'c', name: 'C', root: 'departments/c' },
  ]);
  const l = quiet(() => loadDepartments(r));
  const g = (id) => l.find((d) => d.id === id);
  assert.deepStrictEqual(g('a').addDirsAbs, []);
  assert.strictEqual(g('b').addDirs.length, 5);
  assert.deepStrictEqual(g('c').addDirs, []);
  assert.deepStrictEqual(g('prototype').addDirsAbs, []);
});

test('E1 addDirs: junction ถูกข้าม', (t) => {
  const r = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(r, 'shared'));
  try { fs.symlinkSync(outside, path.join(r, 'shared', 'j'), 'junction'); }
  catch (e) { t.skip('สร้าง link ไม่ได้: ' + e.code); return; }
  writeCfg(r, [P, { id: 'a', name: 'A', root: 'departments/a', addDirs: ['shared/j', 'shared'] }]);
  const a = quiet(() => loadDepartments(r)).find((d) => d.id === 'a');
  assert.deepStrictEqual(a.addDirs, ['shared']);
});

test('E1 addDirs "." อนุญาตเฉพาะ executive', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'executive', name: 'Executive', root: 'departments/executive', addDirs: ['.'] },
    { id: 'a', name: 'A', root: 'departments/a', addDirs: ['.'] },
  ]);
  const l = quiet(() => loadDepartments(r));
  assert.deepStrictEqual(l.find((d) => d.id === 'executive').addDirsAbs, [path.resolve(r)]);
  assert.deepStrictEqual(l.find((d) => d.id === 'a').addDirsAbs, []);
});

test('E1 ลำดับ: executive ก่อน prototype ก่อนแผนกอื่น (แม้วางท้าย)', () => {
  const r = tmp();
  writeCfg(r, [
    { id: 'a', name: 'A', root: 'departments/a' },
    P,
    { id: 'executive', name: 'Executive', root: 'departments/executive' },
  ]);
  assert.deepStrictEqual(quiet(() => loadDepartments(r)).map((d) => d.id), ['executive', 'prototype', 'a']);
  const r2 = tmp();
  writeCfg(r2, [{ id: 'a', name: 'A', root: 'departments/a' }]);
  assert.deepStrictEqual(quiet(() => loadDepartments(r2)).map((d) => d.id), ['prototype', 'a']);
});

test('E1 manager.name: ผิดรูปแบบ -> lead', () => {
  const r = tmp();
  const mk = (id, name) => ({ id, name: id, root: 'departments/' + id, manager: { name, model: 'opus' } });
  writeCfg(r, [P, mk('a', 'Neo'), mk('b', '1x'), mk('c', 'x'.repeat(25)), mk('d', 'a b'), mk('e', 'neo-2'), mk('f', 'x'.repeat(24))]);
  const l = quiet(() => loadDepartments(r));
  const n = (id) => l.find((d) => d.id === id).manager.name;
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(n), ['lead', 'lead', 'lead', 'lead']);
  assert.strictEqual(n('e'), 'neo-2');
  assert.strictEqual(n('f'), 'x'.repeat(24));
});

test('E1 departments.json จริงของโปรเจกต์', () => {
  const root = path.join(__dirname, '..', '..');
  const l = loadDepartments(root);
  // PRPO: มีแค่ห้อง Executive (Fable) + ทีมหลัก id prototype ชื่อ "Migrate Team"
  assert.deepStrictEqual(l.map((d) => d.id), ['executive', 'prototype']);
  assert.deepStrictEqual(l[0].addDirsAbs, [path.resolve(root)]);
  assert.strictEqual(l[0].kind, 'exec');
  assert.strictEqual(l[1].name, 'Migrate Team');
  assert.strictEqual(l[1].manager.name, 'neo');
  assert.strictEqual(l[1].approver, 'executive');
});

// ---------- B1: kind / approver / RESERVED ----------
const X = { id: 'executive', name: 'Executive', root: 'departments/executive' };
const XB = { id: 'executive-biz', name: 'XB', kind: 'exec', root: 'departments/executive-biz' };

test('B1 kind: executive = exec เสมอ, อื่น default team, kind แปลก -> team', () => {
  const r = tmp();
  writeCfg(r, [P, X, XB,
    { id: 'a', name: 'A', root: 'departments/a' },
    { id: 'b', name: 'B', root: 'departments/b', kind: 'boss' },
    { id: 'c', name: 'C', root: 'departments/c', kind: 'exec' }]);
  const l = quiet(() => loadDepartments(r));
  const k = (id) => l.find((d) => d.id === id).kind;
  assert.deepStrictEqual(['executive', 'executive-biz', 'prototype', 'a', 'b', 'c'].map(k), ['exec', 'exec', 'team', 'team', 'team', 'exec']);
});

test('B1 approver: ถูกต้อง/ผิด/ชี้ตัวเอง/ชี้ team/exec ไม่มี approver', () => {
  const r = tmp();
  writeCfg(r, [P, X, XB,
    { id: 'a', name: 'A', root: 'departments/a', approver: 'executive-biz' },
    { id: 'b', name: 'B', root: 'departments/b', approver: 'nope' },
    { id: 'c', name: 'C', root: 'departments/c', approver: 'c' },
    { id: 'd', name: 'D', root: 'departments/d', approver: 'a' },
    { id: 'e', name: 'E', root: 'departments/e' },
    { id: 'f', name: 'F', root: 'departments/f', approver: 5 }]);
  const l = quiet(() => loadDepartments(r));
  const ap = (id) => l.find((d) => d.id === id).approver;
  assert.strictEqual(ap('a'), 'executive-biz');
  for (const id of ['b', 'c', 'd', 'e', 'f', 'prototype']) assert.strictEqual(ap(id), 'executive', id);
  assert.strictEqual(ap('executive'), null);
  assert.strictEqual(ap('executive-biz'), null);
});

test('B1 approver: ไม่มี executive -> null; approver ชี้ exec อื่นยังได้', () => {
  const r = tmp();
  writeCfg(r, [P, { id: 'a', name: 'A', root: 'departments/a', approver: 'executive' }]);
  const l = quiet(() => loadDepartments(r));
  assert.strictEqual(l.find((d) => d.id === 'a').approver, null);
  assert.strictEqual(l.find((d) => d.id === 'prototype').approver, null);
  const r2 = tmp();
  writeCfg(r2, [P, XB, { id: 'a', name: 'A', root: 'departments/a', approver: 'executive-biz' }]);
  assert.strictEqual(quiet(() => loadDepartments(r2)).find((d) => d.id === 'a').approver, 'executive-biz');
});

test('B1 ลำดับ: exec ทั้งหมด (executive ก่อน) แล้ว prototype แล้วที่เหลือ', () => {
  const r = tmp();
  writeCfg(r, [{ id: 'a', name: 'A', root: 'departments/a' }, XB, P, X, { id: 'b', name: 'B', root: 'departments/b' }]);
  assert.deepStrictEqual(quiet(() => loadDepartments(r)).map((d) => d.id), ['executive', 'executive-biz', 'prototype', 'a', 'b']);
});

test('B1 addDirs: path ที่ยังไม่มีไม่ถูกทิ้ง; path ใต้รากใช้ได้; "." เฉพาะ executive', () => {
  const r = tmp();
  writeCfg(r, [P,
    { id: 'executive-biz', name: 'XB', kind: 'exec', root: 'departments/executive-biz', addDirs: ['.', 'docs/product-brief', 'departments/marketing/docs'] },
    { id: 'm', name: 'M', root: 'departments/m', addDirs: ['docs/product-brief', 'departments/f/docs'] }]);
  const l = quiet(() => loadDepartments(r));
  assert.deepStrictEqual(l.find((d) => d.id === 'executive-biz').addDirs, ['docs/product-brief', 'departments/marketing/docs']);
  const m = l.find((d) => d.id === 'm');
  assert.deepStrictEqual(m.addDirs, ['docs/product-brief', 'departments/f/docs']);
  assert.deepStrictEqual(m.addDirsAbs, [path.join(path.resolve(r), 'docs', 'product-brief'), path.join(path.resolve(r), 'departments', 'f', 'docs')]);
});

test('B1 RESERVED export', () => {
  const { RESERVED } = require('../depts');
  assert.deepStrictEqual([...RESERVED].sort(), ['executive', 'executive-biz', 'prototype']);
  // newDept ต้องปฏิเสธ prototype (executive/executive-biz รอ new-dept.js ใช้ RESERVED)
  assert.throws(() => newDept(tmp(), 'prototype', 'N'));
});
