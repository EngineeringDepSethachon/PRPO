'use strict';
// โหลด/ตรวจสอบรายชื่อแผนก (office/departments.json) ไม่มี dependency
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9-]{1,32}$/;
const NAME_MAX = 40;
const MGR_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ADD_DIRS_MAX = 5;
const MODEL_RE =/^[A-Za-z0-9._\-\[\]]{1,64}$/;

function defaultPrototype() {
  return { id: 'prototype', name: 'Prototype Team', root: '.', manager: { name: 'neo', model: 'opus' } };
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function validateId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !WIN_RESERVED.test(id);
}

// คืน path เต็มของ root แผนก หรือ throw Error ถ้าไม่ปลอดภัย
function resolveDeptRoot(projectRoot, root) {
  if (typeof root !== 'string' || root === '' || root.includes('\0')) throw new Error('root ไม่ถูกต้อง');
  if (path.isAbsolute(root) || /^[a-zA-Z]:/.test(root) || root.startsWith('\\\\') || root.startsWith('/')) {
    throw new Error('root ห้ามเป็น absolute path');
  }
  const base = path.resolve(projectRoot);
  const resolved = path.resolve(base, root);
  const rel = path.relative(base, resolved); // บน Windows ไม่สนตัวพิมพ์
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../')) {
    throw new Error('root ต้องอยู่ภายในโฟลเดอร์โปรเจกต์');
  }
  // ห้าม symlink/junction ในแต่ละชั้นของเส้นทางใต้ราก
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { break; } // ยังไม่มี = ไม่ต้องเช็กต่อ
    if (st.isSymbolicLink()) throw new Error('root ห้ามเป็น symlink/junction');
  }
  // ถ้ามีอยู่จริง realpath ต้องยังอยู่ใต้ realpath ของราก
  if (fs.existsSync(resolved)) {
    const rReal = fs.realpathSync.native(resolved);
    const bReal = fs.realpathSync.native(base);
    const r2 = path.relative(bReal, rReal);
    if (path.isAbsolute(r2) || r2 === '..' || r2.startsWith('..' + path.sep)) {
      throw new Error('root ออกนอกโฟลเดอร์โปรเจกต์ (realpath)');
    }
  }
  return resolved;
}

function loadDepartments(projectRoot) {
  const file = path.join(projectRoot, 'office', 'departments.json');
  let raw = null;
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (!Array.isArray(raw)) throw new Error('ต้องเป็น array');
    } catch (e) {
      console.warn('[depts] อ่าน departments.json ไม่ได้:', e.message);
      raw = null;
    }
  }
  const out = [];
  const seen = new Set();
  for (const d of raw || []) {
    try {
      if (!d || typeof d !== 'object') throw new Error('รายการไม่ใช่ object');
      if (!validateId(d.id)) throw new Error('id ไม่ถูกต้อง');
      if (seen.has(d.id)) throw new Error('id ซ้ำ');
      if (typeof d.name !== 'string' || d.name.trim() === '' || d.name.length > NAME_MAX) throw new Error('name ไม่ถูกต้อง (1-' + NAME_MAX + ' ตัวอักษร)');
      if (d.id === 'prototype' && d.root !== '.') throw new Error('prototype ต้องมี root = "."');
      const rootAbs = resolveDeptRoot(projectRoot, d.root);
      if (d.id !== 'prototype') {
        const base = path.resolve(projectRoot);
        const toBase = path.relative(base, rootAbs);
        if (toBase === '') throw new Error('root ห้ามเป็นรากโปรเจกต์');
        for (const o of out) {
          if (o.id === 'prototype') continue;
          const a = path.relative(o.rootAbs, rootAbs);
          const b = path.relative(rootAbs, o.rootAbs);
          const inside = (r) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
          if (inside(a) || inside(b)) throw new Error('root ซ้ำ/ซ้อนกับแผนก ' + o.id);
        }
      }
      const m = d.manager && typeof d.manager === 'object' ? d.manager : {};
      let model = typeof m.model === 'string' && m.model ? m.model : 'fable';
      if (!MODEL_RE.test(model)) {
        console.warn('[depts] แผนก ' + d.id + ': manager.model ไม่ถูกต้อง ใช้ค่า default (fable)');
        model = 'fable';
      }
      let mname = typeof m.name === 'string' && m.name ? m.name : 'fable';
      if (!MGR_NAME_RE.test(mname)) {
        console.warn('[depts] แผนก ' + d.id + ': manager.name ไม่ถูกต้อง ใช้ค่า default (lead)');
        mname = 'lead';
      }
      const manager = { name: mname, model };
      const addDirs = [];
      const addDirsAbs = [];
      if (d.addDirs !== undefined) {
        if (!Array.isArray(d.addDirs)) {
          console.warn('[depts] แผนก ' + d.id + ': addDirs ต้องเป็น array (ข้าม)');
        } else {
          if (d.addDirs.length > ADD_DIRS_MAX) {
            console.warn('[depts] แผนก ' + d.id + ': addDirs เกิน ' + ADD_DIRS_MAX + ' รายการ (ตัดส่วนเกิน)');
          }
          for (const a of d.addDirs.slice(0, ADD_DIRS_MAX)) {
            try {
              if (a === '.' && d.id !== 'executive') throw new Error('"." อนุญาตเฉพาะแผนก executive');
              const abs = resolveDeptRoot(projectRoot, a);
              if (addDirsAbs.includes(abs)) continue;
              addDirs.push(a);
              addDirsAbs.push(abs);
            } catch (e) {
              console.warn('[depts] แผนก ' + d.id + ': ข้าม addDirs ' + JSON.stringify(a) + ': ' + e.message);
            }
          }
        }
      }
      seen.add(d.id);
      const kind = d.id === 'executive' || d.kind === 'exec' ? 'exec' : 'team';
      const web = d.web === true;
      out.push({ id: d.id, name: d.name, root: d.root, rootAbs, manager, addDirs, addDirsAbs, kind, web, _approver: d.approver });
    } catch (e) {
      console.warn('[depts] ข้ามแผนก ' + JSON.stringify(d && d.id) + ': ' + e.message);
    }
  }
  if (!seen.has('prototype')) {
    const p = defaultPrototype();
    p.rootAbs = path.resolve(projectRoot);
    p.addDirs = [];
    p.addDirsAbs = [];
    p.kind = 'team';
    p.web = false;
    out.unshift(p);
  }
  // ลำดับ: exec ทั้งหมด (executive ก่อน) -> prototype -> ที่เหลือ (คงลำดับ config)
  const execs = out.filter((x) => x.kind === 'exec');
  const execIds = new Set(execs.map((x) => x.id));
  const rank = (x) => (x.kind === 'exec' ? (x.id === 'executive' ? 0 : 1) : x.id === 'prototype' ? 2 : 3);
  const sorted = out.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((p) => p[0]);
  for (const x of sorted) {
    const req = x._approver;
    delete x._approver;
    if (x.kind === 'exec') { x.approver = null; continue; }
    if (typeof req === 'string' && req !== x.id && execIds.has(req)) x.approver = req;
    else {
      if (req !== undefined) console.warn('[depts] แผนก ' + x.id + ': approver ไม่ถูกต้อง ใช้ค่า default');
      x.approver = execIds.has('executive') ? 'executive' : null;
    }
  }
  return sorted;
}

// id ที่ new-dept สร้างไม่ได้
const RESERVED = Object.freeze(['prototype', 'executive', 'executive-biz']);

module.exports = { loadDepartments, validateId, resolveDeptRoot, RESERVED };
