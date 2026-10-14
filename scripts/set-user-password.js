#!/usr/bin/env node
/**
 * set-user-password.js : สร้างไฟล์ SQL ตั้งรหัสผ่านชั่วคราวให้ผู้ใช้ 1 คน (ใช้ตั้งแอดมินคนแรกหลัง import)
 *
 * วิธีใช้ (ผู้ใช้รันเอง ; สคริปต์นี้ไม่เรียก wrangler และไม่แตะ remote) :
 *   node scripts/set-user-password.js --username <ชื่อผู้ใช้> --out <C:\path\นอก-repo\set-pw.sql> [--force]
 *   - ถามรหัสผ่าน 2 ครั้งแบบซ่อนตัวอักษรจาก stdin (ไม่รับรหัสจาก argv กัน history)
 *   - ไฟล์ --out ต้องอยู่นอก repo, ลงท้าย .sql, ห้ามมีอยู่แล้ว (ยกเว้น --force)
 *   - กติการหัส (ตรงกับ server) : ยาว 6..256 ตัว, ไม่ใช่ 123456 / password123 / admin123 (ไม่สนตัวพิมพ์)
 *   - hash ด้วย functions/_lib/password.js (PBKDF2-SHA256 รูปแบบเดียวกับ server) ; ไฟล์ SQL ไม่มีรหัส plaintext
 *   - ตั้ง mustChangePassword = 1 (ต้องเปลี่ยนรหัสตอน login ครั้งแรก) และ tokenVersion + 1 (token เก่าใช้ไม่ได้)
 *   แล้วรัน : npx wrangler d1 execute prpo-db --remote --file=<ไฟล์.sql>  จากนั้นลบไฟล์ .sql ทิ้ง
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, MAX_PASSWORD_LENGTH } from '../functions/_lib/password.js';
import { sqlLit } from './import-sheets-to-d1.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_NEW_PASSWORD_LENGTH = 6;
export const FORBIDDEN_PASSWORDS = ['123456', 'password123', 'admin123'];

export function checkPassword(pw) {
  // server trims the password at login / change-password, so a password with leading/trailing whitespace could never match
  if (typeof pw === 'string' && pw !== pw.trim()) return 'รหัสผ่านต้องไม่มีช่องว่างหรือขึ้นบรรทัดใหม่ที่หัว/ท้าย (server ตัดช่องว่างตอน login ทำให้ login ไม่ได้)';
  if (typeof pw !== 'string' || pw.length < MIN_NEW_PASSWORD_LENGTH) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_NEW_PASSWORD_LENGTH} ตัว`;
  if (pw.length > MAX_PASSWORD_LENGTH) return `รหัสผ่านยาวเกิน ${MAX_PASSWORD_LENGTH} ตัว`;
  if (FORBIDDEN_PASSWORDS.includes(pw.toLowerCase())) return 'ห้ามใช้รหัสเริ่มต้น';
  return null;
}

export function checkOutPath(out, { force = false } = {}) {
  if (!out || !/\.sql$/i.test(out)) throw new Error('--out ต้องลงท้าย .sql');
  const full = path.resolve(out);
  const rel = path.relative(REPO_ROOT, full);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('--out ต้องอยู่นอก repo (เช่น C:\\Users\\<ชื่อ>\\prpo-backups\\set-pw.sql)');
  if (fs.existsSync(full) && !force) throw new Error('ไฟล์ --out มีอยู่แล้ว (ใช้ --force เพื่อทับ)');
  return full;
}

export async function buildSetPasswordSql(username, password, now = new Date()) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) throw new Error('ต้องระบุ --username');
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  const rec = await hashPassword(password);
  return `UPDATE users SET passwordHash = ${sqlLit(rec.hash)}, passwordSalt = ${sqlLit(rec.salt)}, passwordAlgo = ${sqlLit(rec.algo)}, `
    + `passwordIterations = ${rec.iterations}, passwordUpdatedAt = ${sqlLit(now.toISOString())}, password = '', pin = '', `
    + `mustChangePassword = 1, tokenVersion = COALESCE(tokenVersion, 0) + 1 WHERE lower(username) = ${sqlLit(uname)};\n`;
}

// hidden prompt : raw mode on a TTY, otherwise read one line from piped stdin
function readLineHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    if (!stdin.isTTY) {
      reject(new Error('stdin ไม่ใช่เทอร์มินัลแบบโต้ตอบ (ซ่อนตัวอักษรไม่ได้ และรหัสอาจค้างใน pipe/history) -> รันใน PowerShell ปกติ'));
      return;
    }
    let pw = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onKey = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); resolve(pw); return; }
        if (c === '\u0003') { done(); reject(new Error('ยกเลิก')); return; }
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1); else pw += c;
      }
    };
    function done() { stdin.off('data', onKey); stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n'); }
    stdin.on('data', onKey);
  });
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') a.username = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--force') a.force = true;
    else throw new Error(`ไม่รู้จักตัวเลือก ${argv[i]} (ไม่รับรหัสผ่านทาง argv)`);
  }
  return a;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.username || !args.out) throw new Error('usage: node scripts/set-user-password.js --username <user> --out <ไฟล์นอก repo>.sql [--force]');
    const out = checkOutPath(args.out, { force: args.force });
    const pw1 = await readLineHidden('รหัสผ่านชั่วคราว: ');
    const pw2 = await readLineHidden('ยืนยันรหัสผ่าน: ');
    if (pw1 !== pw2) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน');
    const sql = await buildSetPasswordSql(args.username, pw1);
    fs.writeFileSync(out, sql, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
    console.log(`เขียนไฟล์ SQL แล้ว : ${out}`);
    console.log('ขั้นต่อไป : npx wrangler d1 execute prpo-db --remote --file=<ไฟล์นี้> แล้วลบไฟล์ SQL ทิ้ง');
  } catch (e) {
    console.error(`ผิดพลาด : ${e.message}`);
    process.exitCode = 1;
  }
}
