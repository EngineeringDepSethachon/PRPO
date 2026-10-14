#!/usr/bin/env node
// PreToolUse hook ของห้อง exec (ผู้บริหาร) : อ่านอย่างเดียว
// deny ทุก Edit|Write|MultiEdit|NotebookEdit และ WebFetch|WebSearch
// บล็อก = พิมพ์ JSON permissionDecision:deny ทาง stdout แล้ว exit 0 (เหมือน dept-guard)
// JSON เสีย/ข้อมูลผิดปกติ/exception -> deny
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLOCKED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']);
const LOG = path.join(os.tmpdir(), 'ld-exec-guard.log');

// คืน { reason, info } ; reason = null -> อนุญาต
function decide(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return { reason: 'อ่านข้อมูล hook ไม่ได้ (JSON เสีย)' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { reason: 'ข้อมูล hook ไม่ถูกต้อง' };
  const tool = j.tool_name;
  const info = { tool: typeof tool === 'string' ? tool : null };
  if (typeof tool !== 'string') return { reason: 'ไม่พบชื่อเครื่องมือ', info };
  if (BLOCKED.has(tool)) return { reason: 'ห้องผู้บริหารอ่านอย่างเดียว ใช้ ' + tool + ' ไม่ได้', info };
  return { reason: null, info };
}

function log(info, reason) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), tool: info && info.tool, decision: reason ? 'block: ' + reason : 'allow' }) + '\n');
  } catch { /* ห้ามกระทบการตัดสินใจ */ }
}

module.exports = { decide };

function deny(reason) {
  const msg = 'บล็อก (exec-guard): ' + reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg } }), () => process.exit(0));
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let r;
    try { r = decide(raw.replace(/^﻿/, '')); } catch (e) { r = { reason: 'hook ผิดพลาด: ' + (e && e.message) }; }
    log(r.info, r.reason);
    if (r.reason) deny(r.reason); else process.exit(0);
  });
  process.stdin.on('error', () => deny('อ่าน stdin ไม่ได้'));
}
