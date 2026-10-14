'use strict';
// ใช้: node office/new-dept.js <id> "<ชื่อ>"  |  node office/new-dept.js --refresh <id>   (env OFFICE_ROOT = ราก project, default = โฟลเดอร์แม่ของ office/)
const fs = require('fs');
const path = require('path');
const { validateId, resolveDeptRoot, loadDepartments, RESERVED } = require('./depts');
const { rewriteScribeHook } = require('./scribe-hook');

const NAME_MAX = 40;

const PLACEHOLDER_RE = /\{\{(NAME|ID|ASK_PATH|CONSULT_PATH|MEMO_PATH|GUARD_PATH|MANAGER|APPROVER_NAME|ROOMS)\}\}/g;

// path เต็มของ office/memo.js (forward slash) ตรวจอักขระเดียวกับ consult
function memoPathFor(projectRoot) {
  const p = path.join(projectRoot, 'office', 'memo.js').replace(/\\/g, '/');
  if (/["'`$%!\r\n\0]/.test(p)) throw new Error('path ของ office/memo.js มีอักขระที่ใช้ใน permission rule ไม่ได้ (" \' ` $ % ! CR LF): ' + p);
  return p;
}

// รายชื่อห้องอื่น (id + ชื่อ + หัวหน้า) สำหรับ memo --to ; ไม่รวมห้องตัวเอง
function roomsFor(projectRoot, selfId) {
  let list;
  try {
    const w = console.warn; console.warn = () => {};
    try { list = loadDepartments(projectRoot); } finally { console.warn = w; }
  } catch { return '- (ดู office/departments.json)'; }
  const rows = list.filter((d) => d.id !== selfId).map((d) => {
    const n = d.manager && d.manager.name;
    const safeName = String(d.name).replace(/[{}\x00-\x1f\x7f\u0085\u2028\u2029*_\[\]()#`]/g, '').trim().slice(0, NAME_MAX);
    return '- `' + d.id + '` = ' + safeName + (typeof n === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(n) ? ' (หัวหน้า ' + n.charAt(0).toUpperCase() + n.slice(1) + ')' : '') + (d.kind === 'exec' ? ' [ผู้บริหาร]' : '');
  });
  return rows.length ? rows.join('\n') : '- (ยังไม่มีห้องอื่น)';
}

// ชื่อผู้อนุมัติของแผนก (ชื่อ manager ของห้อง approver ตัวแรกพิมพ์ใหญ่) ; ไม่พบ -> "Fable"
// deptId ที่ยังไม่อยู่ใน departments.json (แผนกใหม่) ใช้ approver default = executive
function approverNameFor(projectRoot, deptId) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let list;
  try {
    const w = console.warn; console.warn = () => {};
    try { list = loadDepartments(projectRoot); } finally { console.warn = w; }
  } catch { return 'Fable'; }
  const dept = list.find((d) => d.id === deptId);
  const aid = dept ? dept.approver : 'executive';
  const ap = aid && list.find((d) => d.id === aid);
  const n = ap && ap.manager && ap.manager.name;
  return typeof n === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(n) ? cap(n) : 'Fable';
}

// path เต็มของ office/consult.js (forward slash) ตรวจอักขระเดียวกับ ask
function consultPathFor(projectRoot) {
  const p = path.join(projectRoot, 'office', 'consult.js').replace(/\\/g, '/');
  if (/["'`$%!\r\n\0]/.test(p)) throw new Error('path ของ office/consult.js มีอักขระที่ใช้ใน permission rule ไม่ได้ (" \' ` $ % ! CR LF): ' + p);
  return p;
}

// path เต็มของ <แผนก>/.claude/hooks/dept-guard.js (forward slash) ฝังใน settings.json hook command ; ตรวจอักขระเหมือน scribe-hook
function guardPathFor(deptAbs) {
  const p = path.join(deptAbs, '.claude', 'hooks', 'dept-guard.js').replace(/\\/g, '/');
  if (/["'`$%!\r\n\0]/.test(p)) throw new Error('path ของ dept-guard.js มีอักขระที่ใช้ใน hook command ไม่ได้ (" \' ` $ % ! CR LF): ' + p);
  return p;
}

// คัด office/hooks-src/dept-guard.js ไป <แผนก>/.claude/hooks/ (เขียนทับเสมอ — เป็นตัวกัน ไม่ใช่ไฟล์ที่แผนกแก้เอง)
function installGuard(deptAbs) {
  const dest = path.join(deptAbs, '.claude', 'hooks', 'dept-guard.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'hooks-src', 'dept-guard.js'), dest);
  return dest;
}

// ชื่อหัวหน้าแผนก: จาก departments.json (manager.name) ต้องเป็น a-z 0-9 - ไม่งั้นใช้ "lead"
function managerNameFor(dept) {
  const n = dept && dept.manager && dept.manager.name;
  return typeof n === 'string' && n !== 'fable' && /^[A-Za-z0-9-]{1,32}$/.test(n) ? n : 'lead';
}

// path เต็มของ office/ask.js แบบ forward slash สำหรับฝังใน CLAUDE.md / settings.json
function askPathFor(projectRoot) {
  const p = path.join(projectRoot, 'office', 'ask.js').replace(/\\/g, '/');
  if (/["'`$%!\r\n\0]/.test(p)) throw new Error('path ของ office/ask.js มีอักขระที่ใช้ใน permission rule ไม่ได้ (" \' ` $ % ! CR LF): ' + p);
  return p;
}

function copyTree(src, dest, subst, created, skipped) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) { copyTree(s, d, subst, created, skipped); continue; }
    let text = fs.readFileSync(s, 'utf8');
    text = text.replace(PLACEHOLDER_RE, (_, k) => subst['{{' + k + '}}']);
    try { fs.writeFileSync(d, text, { flag: 'wx' }); created.push(d); }
    catch (e) { if (e.code === 'EEXIST') skipped.push(d); else throw e; }
  }
}

function copyOptional(src, dest, label, created, skipped, warnings, transform) {
  let st;
  try { st = fs.lstatSync(src); } catch { warnings.push('ไม่พบ ' + label + ' (' + src + ') ข้ามไป'); return; }
  if (st.isSymbolicLink()) { warnings.push('ข้าม symlink: ' + src); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src)) copyOptional(path.join(src, n), path.join(dest, n), label, created, skipped, warnings, transform);
    return;
  }
  if (!st.isFile()) { warnings.push('ข้าม (ไม่ใช่ไฟล์ปกติ): ' + src); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    if (transform) fs.writeFileSync(dest, transform(fs.readFileSync(src, 'utf8')), { flag: 'wx' });
    else fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    created.push(dest);
  } catch (e) { if (e.code === 'EEXIST') skipped.push(dest); else throw e; }
}

function newDept(projectRoot, id, name) {
  if (!validateId(id)) throw new Error('id ต้องเป็น a-z 0-9 - ยาว 1-32');
  if (RESERVED.includes(id)) throw new Error('id "' + id + '" ถูกสงวนไว้' + (id.startsWith('executive') ? ' (ใช้ node office/new-exec.js)' : ''));
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_MAX || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(name)) {
    throw new Error('ชื่อต้องไม่ว่าง ไม่เกิน ' + NAME_MAX + ' ตัวอักษร และไม่มีอักขระควบคุม');
  }
  const rootRel = 'departments/' + id;
  const abs = resolveDeptRoot(projectRoot, rootRel);

  const cfgFile = path.join(projectRoot, 'office', 'departments.json');
  let list;
  if (fs.existsSync(cfgFile)) {
    list = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
    if (!Array.isArray(list)) throw new Error('departments.json ต้องเป็น array');
  } else {
    list = [{ id: 'prototype', name: 'Prototype Team', root: '.', manager: { name: 'neo', model: 'opus' } }];
  }
  if (list.some((d) => d && d.id === id)) throw new Error('id ซ้ำ: ' + id);

  const created = [], skipped = [], warnings = [];
  copyTree(path.join(__dirname, 'dept-template'), abs, { '{{NAME}}': name, '{{ID}}': id, '{{ASK_PATH}}': askPathFor(projectRoot), '{{CONSULT_PATH}}': consultPathFor(projectRoot), '{{MEMO_PATH}}': memoPathFor(projectRoot), '{{GUARD_PATH}}': guardPathFor(abs), '{{MANAGER}}': 'lead', '{{APPROVER_NAME}}': approverNameFor(projectRoot, id), '{{ROOMS}}': roomsFor(projectRoot, id) }, created, skipped);
  const setup = path.join(projectRoot, 'claude-setup');
  const destClaude = path.join(abs, '.claude');
  copyOptional(path.join(setup, 'agents', 'kafae-scribe.md'), path.join(destClaude, 'agents', 'kafae-scribe.md'), 'kafae-scribe.md', created, skipped, warnings,
    (text) => rewriteScribeHook(text, destClaude).text);
  copyOptional(path.join(setup, 'hooks'), path.join(destClaude, 'hooks'), 'claude-setup/hooks', created, skipped, warnings);
  installGuard(abs);
  if (!fs.existsSync(path.join(destClaude, 'hooks', 'whiteboard-only.js'))) {
    warnings.push('ไม่มี .claude/hooks/whiteboard-only.js ในแผนก — hook ของพี่กาแฟจะทำงานไม่ได้ (ตรวจ claude-setup/hooks)');
  }

  list.push({ id, name, root: rootRel, manager: { name: 'fable', model: 'fable' } });
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(list, null, 2) + '\n');
  return { id, name, root: rootRel, abs, created, skipped, warnings };
}

// เขียนทับเฉพาะ CLAUDE.md + .claude/settings.json จากแม่แบบ (ไม่แตะ docs/whiteboard.md และไฟล์อื่น)
const REFRESH_FILES = ['CLAUDE.md', path.join('.claude', 'settings.json')];
function refreshDept(projectRoot, id) {
  if (!validateId(id) || RESERVED.includes(id)) throw new Error('id ไม่ถูกต้องสำหรับ refresh: ' + id);
  const cfgFile = path.join(projectRoot, 'office', 'departments.json');
  if (!fs.existsSync(cfgFile)) throw new Error('ไม่พบ office/departments.json');
  const list = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
  const dept = Array.isArray(list) && list.find((d) => d && d.id === id);
  if (!dept) throw new Error('ไม่พบแผนก: ' + id);
  const abs = resolveDeptRoot(projectRoot, 'departments/' + id);
  if (!fs.existsSync(abs)) throw new Error('ไม่พบโฟลเดอร์แผนก: ' + abs);
  const subst = { '{{NAME}}': dept.name, '{{ID}}': id, '{{ASK_PATH}}': askPathFor(projectRoot), '{{CONSULT_PATH}}': consultPathFor(projectRoot), '{{MEMO_PATH}}': memoPathFor(projectRoot), '{{GUARD_PATH}}': guardPathFor(abs), '{{MANAGER}}': managerNameFor(dept), '{{APPROVER_NAME}}': approverNameFor(projectRoot, id), '{{ROOMS}}': roomsFor(projectRoot, id) };
  const written = [];
  const loaded = (() => {
    const w = console.warn; console.warn = () => {};
    try { return loadDepartments(projectRoot).find((d) => d.id === id); } finally { console.warn = w; }
  })();
  for (const rel of REFRESH_FILES) {
    let text = fs.readFileSync(path.join(__dirname, 'dept-template', rel), 'utf8').replace(PLACEHOLDER_RE, (_, k) => subst['{{' + k + '}}']);
    if (rel === path.join('.claude', 'settings.json')) text = applyDeptPermissions(text, loaded);
    const dest = path.join(abs, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    written.push(dest);
  }
  const guard = installGuard(abs);
  // ตัวกันพี่กาแฟ + ตัว agent: เขียนทับจากต้นฉบับ claude-setup เสมอ (ถ้ามี) เพื่อให้ได้การแก้ล่าสุด
  const setupDir = path.join(projectRoot, 'claude-setup');
  const wbSrc = path.join(setupDir, 'hooks', 'whiteboard-only.js');
  if (fs.existsSync(wbSrc)) {
    const wbDest = path.join(abs, '.claude', 'hooks', 'whiteboard-only.js');
    fs.mkdirSync(path.dirname(wbDest), { recursive: true });
    fs.copyFileSync(wbSrc, wbDest);
  }
  const ksSrc = path.join(setupDir, 'agents', 'kafae-scribe.md');
  if (fs.existsSync(ksSrc)) {
    const ksDest = path.join(abs, '.claude', 'agents', 'kafae-scribe.md');
    fs.mkdirSync(path.dirname(ksDest), { recursive: true });
    fs.writeFileSync(ksDest, rewriteScribeHook(fs.readFileSync(ksSrc, 'utf8'), path.join(abs, '.claude')).text);
  }
  // คัดลอก agent เฉพาะแผนกจาก office/dept-agents/<id>/*.md (เขียนทับ ; ข้าม kafae-scribe.md)
  const agentsSrc = path.join(__dirname, 'dept-agents', id);
  const agents = [];
  if (fs.existsSync(agentsSrc) && fs.lstatSync(agentsSrc).isDirectory()) {
    const agentsDest = path.join(abs, '.claude', 'agents');
    fs.mkdirSync(agentsDest, { recursive: true });
    for (const ent of fs.readdirSync(agentsSrc, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md') || ent.name === 'kafae-scribe.md') continue;
      fs.copyFileSync(path.join(agentsSrc, ent.name), path.join(agentsDest, ent.name));
      agents.push(ent.name);
    }
  }
  return { id, written, agents, guard };
}

// เติมสิทธิ์ตามแผนก: web -> WebSearch/WebFetch
function applyDeptPermissions(text, dept) {
  if (!dept) return text;
  const s = JSON.parse(text);
  const p = s.permissions;
  if (dept.web === true) for (const t of ['WebSearch', 'WebFetch']) if (!p.allow.includes(t)) p.allow.push(t);
  // การกันเขียนนอก docs ของแผนกทำโดย hook dept-guard.js (deny Edit(//C:/...) ไม่มีผลจริง จึงเลิกใช้)
  return JSON.stringify(s, null, 2) + '\n';
}

module.exports = { newDept, refreshDept, askPathFor };

if (require.main === module) {
  const root = process.env.OFFICE_ROOT ? path.resolve(process.env.OFFICE_ROOT) : path.resolve(__dirname, '..');
  try {
    if (process.argv[2] === '--refresh') {
      const r = refreshDept(root, process.argv[3]);
      console.log('refresh แผนก ' + r.id + ': เขียนทับ ' + r.written.length + ' ไฟล์ (CLAUDE.md, .claude/settings.json) + agents ' + r.agents.length + ' ไฟล์');
      process.exit(0);
    }
    const r = newDept(root, process.argv[2], process.argv[3]);
    console.log('สร้างแผนก ' + r.name + ' (' + r.id + ') ที่ ' + r.root);
    console.log('  สร้างไฟล์ ' + r.created.length + ' ไฟล์, ข้าม (มีอยู่แล้ว) ' + r.skipped.length);
    r.warnings.forEach((w) => console.warn('  เตือน: ' + w));
    console.log('  เพิ่มลง office/departments.json แล้ว (รีสตาร์ท office server เพื่อให้เห็นแผนกใหม่)');
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  }
}
