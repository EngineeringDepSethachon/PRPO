#!/usr/bin/env node
// PreToolUse hook ของ kafae-scribe: อนุญาตเฉพาะการแก้ <ราก>/docs/whiteboard.md
// ราก = $CLAUDE_PROJECT_DIR ถ้ามี ไม่งั้น <สคริปต์>/../.. (สคริปต์อยู่ใน <แผนก>/.claude/hooks/)
// อนุญาต = exit 0 ไม่พิมพ์อะไร ; บล็อก = พิมพ์ JSON permissionDecision:deny ทาง stdout แล้ว exit 0
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const LOG = path.join(os.tmpdir(), 'lazydough-hook.log');
let logInfo = { tool: null, path: null };

function log(decision) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), tool: logInfo.tool, path: logInfo.path, decision }) + '\n');
  } catch { /* ห้ามกระทบการตัดสินใจ */ }
}

function block(msg) {
  log('block: ' + msg);
  // บนเครื่องนี้ exit 2 ไม่บล็อกจริง -> ใช้ JSON permissionDecision:deny ทาง stdout + exit 0
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'บล็อก: ' + msg } });
  process.stdout.write(out, () => process.exit(0));
}

function decide(raw) {
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch { return 'อ่านข้อมูล hook ไม่ได้ (JSON เสีย)'; }
  if (!j || typeof j !== 'object') return 'ข้อมูล hook ไม่ถูกต้อง';
  const input = (j.tool_input && typeof j.tool_input === 'object') ? j.tool_input : {};
  const fp = input.file_path || input.notebook_path || input.path;
  logInfo = { tool: typeof j.tool_name === 'string' ? j.tool_name : null, path: typeof fp === 'string' ? fp.slice(0, 500) : null };
  if (typeof fp !== 'string' || !fp.trim()) return 'ไม่พบ path ของไฟล์';
  if (fp.includes('\0')) return 'path ไม่ถูกต้อง';
  const cwd = typeof j.cwd === 'string' && j.cwd ? j.cwd : null;
  if (!cwd) return 'ไม่พบ cwd';
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  const root = path.resolve(envRoot && envRoot.trim() ? envRoot : path.join(__dirname, '..', '..'));
  if (norm(path.resolve(cwd)) !== norm(root)) return 'cwd ไม่ตรงกับรากแผนก';
  const target = path.resolve(root, fp);
  const docs = path.resolve(root, 'docs');
  const allowed = path.join(docs, 'whiteboard.md');
  if (norm(target) !== norm(allowed)) return 'พี่กาแฟแก้ได้เฉพาะ docs/whiteboard.md เท่านั้น';
  // กัน symlink/junction: ไฟล์ และโฟลเดอร์ docs ต้องไม่ใช่ลิงก์
  try {
    const dst = fs.lstatSync(docs);
    if (dst.isSymbolicLink() || !dst.isDirectory()) return 'โฟลเดอร์ docs ไม่ปกติ';
    if (norm(fs.realpathSync(docs)) !== norm(docs)) return 'โฟลเดอร์ docs เป็นลิงก์';
  } catch (e) { if (e.code !== 'ENOENT') return 'ตรวจโฟลเดอร์ docs ไม่ได้'; }
  try {
    const st = fs.lstatSync(allowed);
    if (st.isSymbolicLink() || !st.isFile()) return 'whiteboard.md ไม่ใช่ไฟล์ปกติ (symlink)';
  } catch (e) { if (e.code !== 'ENOENT') return 'ตรวจไฟล์ไม่ได้'; }
  return null;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; if (buf.length > 5e6) block('ข้อมูลใหญ่เกินไป'); });
process.stdin.on('end', () => {
  const why = decide(buf);
  if (why) return block(why);
  log('allow');
  process.exit(0);
});
process.stdin.on('error', () => block('อ่าน stdin ไม่ได้'));
