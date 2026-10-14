#!/usr/bin/env node
// PreToolUse hook ระดับแผนก (ไม่พึ่ง path rule ของ permissions)
// ติดตั้งที่ <แผนก>/.claude/hooks/dept-guard.js โดย new-dept.js ; รากแผนก = <สคริปต์>/../..
// Edit|Write|MultiEdit|NotebookEdit : อนุญาตเฉพาะไฟล์ใต้ <รากแผนก>/docs/ (ไม่ผ่าน symlink/junction)
//   docs/whiteboard.md : เฉพาะ agent_type = kafae-scribe
// WebFetch|WebSearch : อนุญาตเฉพาะ agent_type = mint-researcher ; session หลัก (ไม่มี agent_type) ถูกบล็อกด้วย
// บล็อก = พิมพ์ JSON permissionDecision:deny ทาง stdout แล้ว exit 0 (ทดสอบจริงบนเครื่องนี้: exit 2 ถูก harness นับเป็น status 1 = ไม่บล็อก)
// อนุญาต = exit 0 ไม่พิมพ์อะไร ; JSON เสีย/ข้อมูลผิดปกติ/เกิด exception -> บล็อก
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const LOG = path.join(os.tmpdir(), 'ld-dept-guard.log');
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// คืนข้อความเหตุผลที่บล็อก หรือ null = อนุญาต ; root ส่งเข้ามาเพื่อให้เทสต์ได้
function decide(raw, root) {
  let j;
  try { j = JSON.parse(raw); } catch { return { reason: 'อ่านข้อมูล hook ไม่ได้ (JSON เสีย)' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { reason: 'ข้อมูล hook ไม่ถูกต้อง' };
  const tool = j.tool_name;
  const agent = typeof j.agent_type === 'string' && j.agent_type ? j.agent_type : null;
  const input = j.tool_input && typeof j.tool_input === 'object' ? j.tool_input : {};
  const info = { tool: typeof tool === 'string' ? tool : null, agent };
  if (typeof tool !== 'string') return { reason: 'ไม่พบชื่อเครื่องมือ', info };

  if (WEB_TOOLS.has(tool)) {
    if (agent !== 'mint-researcher') return { reason: 'ค้นเว็บได้เฉพาะ mint-researcher (คุณคือ ' + (agent || 'session หลัก') + ')', info };
    return { reason: null, info };
  }
  if (!FILE_TOOLS.has(tool)) return { reason: null, info }; // ไม่ใช่เครื่องมือที่ตรวจ (กัน matcher กว้างผิด)

  // เลือกฟิลด์ path ตามเครื่องมือ ; ถ้ามีหลายฟิลด์ path ที่ค่าไม่ตรงกัน -> deny
  const vals = ['file_path', 'notebook_path', 'path'].map((k) => input[k]).filter((v) => v !== undefined && v !== null);
  if (new Set(vals.map((v) => (typeof v === 'string' ? v : '\0' + typeof v))).size > 1) return { reason: 'พบฟิลด์ path หลายค่าที่ไม่ตรงกัน', info };
  const fp = tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
  info.path = typeof fp === 'string' ? fp.slice(0, 500) : null;
  if (typeof fp !== 'string' || !fp.trim()) return { reason: 'ไม่พบ path ของไฟล์', info };
  const bad = checkRawPath(fp);
  if (bad) return { reason: bad, info };

  const base = typeof j.cwd === 'string' && j.cwd ? j.cwd : root;
  const target = path.resolve(base, fp);
  const docs = path.join(root, 'docs');
  const t = norm(target);
  const d = norm(docs);
  if (!t.startsWith(d + path.sep)) return { reason: 'แผนกนี้แก้ไฟล์ได้เฉพาะใน docs/ ของแผนกตัวเอง', info };
  const bad2 = checkRawPath(target);
  if (bad2) return { reason: bad2, info };

  if (t === path.join(d, 'whiteboard.md') && agent !== 'kafae-scribe') {
    return { reason: 'docs/whiteboard.md แก้ได้เฉพาะพี่กาแฟ (kafae-scribe)', info };
  }
  const link = checkLinks(root, docs, target);
  if (link) return { reason: link, info };
  return { reason: null, info };
}

// กัน ADS (:), 8.3 (~N), UNC / \\?\ , wildcard, trailing dot/space ของแต่ละชั้น, อักขระควบคุม
function checkRawPath(p) {
  if (/[\x00-\x1f]/.test(p)) return 'path มีอักขระควบคุม';
  if (/^[\\/]{2}/.test(p)) return 'ไม่รองรับ path แบบ UNC / device';
  if (/[*?<>|"]/.test(p)) return 'path มีอักขระต้องห้าม';
  if (p.indexOf(':', /^[A-Za-z]:/.test(p) ? 2 : 0) !== -1) return 'path มี : (alternate data stream)';
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '' || seg === '.' || seg === '..') continue;
    if (/[. ]$/.test(seg)) return 'ชื่อไฟล์/โฟลเดอร์ลงท้ายด้วยจุดหรือช่องว่าง';
    if (/~\d/.test(seg)) return 'path แบบชื่อสั้น 8.3 (~N) ไม่อนุญาต';
  }
  return null;
}

// ทุกชั้นตั้งแต่ docs ลงไปถึงไฟล์ต้องไม่ใช่ symlink/junction และ realpath ต้องอยู่ใต้ realpath(docs)
function checkLinks(root, docs, target) {
  try {
    const rel = path.relative(docs, target).split(path.sep);
    let cur = docs;
    const chain = [docs];
    for (const seg of rel) { cur = path.join(cur, seg); chain.push(cur); }
    let deepest = null;
    for (const c of chain) {
      let st;
      try { st = fs.lstatSync(c); } catch (e) { if (e.code === 'ENOENT') break; return 'ตรวจ path ไม่ได้ (' + e.code + ')'; }
      if (st.isSymbolicLink()) return 'พบ symlink/junction ใน path (' + path.basename(c) + ')';
      deepest = c;
    }
    if (!deepest) return 'ไม่พบโฟลเดอร์ docs ของแผนก';
    if (deepest === docs && !fs.lstatSync(docs).isDirectory()) return 'docs ไม่ใช่โฟลเดอร์';
    const realDocs = fs.realpathSync.native(docs);
    if (norm(realDocs) !== norm(path.join(fs.realpathSync.native(root), 'docs'))) return 'โฟลเดอร์ docs เป็นลิงก์';
    const realDeep = fs.realpathSync.native(deepest);
    const r = norm(realDeep), rd = norm(realDocs);
    if (r !== rd && !r.startsWith(rd + path.sep)) return 'path จริงอยู่นอก docs ของแผนก';
    return null;
  } catch (e) {
    return 'ตรวจ symlink ไม่ได้ (' + (e && e.code ? e.code : 'error') + ')';
  }
}

function log(info, reason) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), tool: info && info.tool, agent: info && info.agent, path: info && info.path, decision: reason ? 'block: ' + reason : 'allow' }) + '\n');
  } catch { /* ห้ามกระทบการตัดสินใจ */ }
}

module.exports = { decide, checkRawPath };

function deny(reason) {
  const msg = 'บล็อก (dept-guard): ' + reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg } }), () => process.exit(0));
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let r;
    try { r = decide(raw.replace(/^\uFEFF/, ''), root); } catch (e) { r = { reason: 'hook ผิดพลาด: ' + (e && e.message) }; }
    log(r.info, r.reason);
    if (r.reason) deny(r.reason); else process.exit(0);
  });
  process.stdin.on('error', () => deny('อ่าน stdin ไม่ได้'));
}