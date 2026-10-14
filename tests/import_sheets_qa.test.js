// @vitest-environment node
// QA เพิ่มเติมสำหรับ T4.2 (scripts/import-sheets-to-d1.js) : parser / SQL escape / injection / counters / ข้อมูลสูญหาย
// เคสที่ใช้ it.fails = bug ที่ยืนยันแล้วจากการอ่านโค้ด ; เมื่อแก้โค้ดแล้ว it.fails จะแดง -> ให้เปลี่ยนเป็น it ธรรมดา
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runImport, parseCsv, sqlLit, formatReport } from '../scripts/import-sheets-to-d1.js';
import { verifyPassword } from '../functions/_lib/password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const FIX = path.join(here, 'fixtures', 'sheets');

// ---- temp input dirs (ลบเฉพาะไฟล์ที่สร้างเอง ทีละไฟล์) ----
const made = [];
function mkIn(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-import-'));
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    paths.push(p);
  }
  made.push({ dir, paths });
  return dir;
}
afterEach(() => {
  for (const m of made) {
    for (const p of m.paths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    try { fs.rmdirSync(m.dir); } catch { /* ignore */ }
  }
  made.length = 0;
});

// ถ้า validate พังแล้วโค้ดสร้างโฟลเดอร์/ไฟล์ขึ้นมา เทสต์จะลบเฉพาะที่ "ไม่มีมาก่อน" ทีละ path เต็ม
async function withTempOut(p, fn) {
  const fileExisted = fs.existsSync(p);
  const createdDirs = [];
  let d = path.dirname(p);
  while (!fs.existsSync(d)) {
    createdDirs.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  try { await fn(); } finally {
    if (!fileExisted && fs.existsSync(p)) fs.unlinkSync(p);
    for (const dir of createdDirs) { try { fs.rmdirSync(dir); } catch { /* ไม่ว่าง = ไม่ใช่ของเรา ไม่ลบ */ } }
  }
}

const stripLiterals = (l) => l.replace(/'(?:[^']|'')*'/g, '');
const STRICT = /^INSERT( OR REPLACE)? INTO [a-z_]+ \([A-Za-z, ]+\) VALUES \(([\s,]|NULL|[0-9eE+.-]+|\|\|char\(1[03]\)\|\|)*\)( ON CONFLICT\(dept, docType, year\) DO UPDATE SET lastNumber = MAX\(lastNumber, excluded\.lastNumber\), updatedAt = excluded\.updatedAt)?;$/;
const insertLines = (sql) => sql.split('\n').filter((l) => l && !l.startsWith('--'));

// ======================================================================= CSV parser
describe('parseCsv', () => {
  it('BOM + CRLF + comma in quotes + CRLF inside quotes + no trailing newline', () => {
    const t = '﻿id,name\r\n1,"a,b"\r\n2,"line1\r\nline2"\r\n3,plain';
    expect(parseCsv(t)).toEqual([['id', 'name'], ['1', 'a,b'], ['2', 'line1\r\nline2'], ['3', 'plain']]);
  });
  it('escaped quotes at end of cell, trailing empty field, blank lines, lone CR', () => {
    expect(parseCsv('"say ""hi"""')).toEqual([['say "hi"']]);
    expect(parseCsv('a,b\n1,')).toEqual([['a', 'b'], ['1', '']]);
    expect(parseCsv('a,b\n1,2\n\n\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\r1')).toEqual([['a'], ['1']]);
    expect(parseCsv('')).toEqual([]);
  });
});

// ======================================================================= sqlLit
describe('sqlLit', () => {
  it('escapes quote, backslash (literal in SQLite), NUL, CR/LF, numbers, empty', () => {
    expect(sqlLit("'; DROP TABLE users;--")).toBe("'''; DROP TABLE users;--'");
    expect(sqlLit('a\\b')).toBe("'a\\b'");
    expect(sqlLit('a\0b')).toBe("'ab'");
    expect(sqlLit('a\r\nb')).toBe("'a'||char(13)||''||char(10)||'b'");
    expect(sqlLit('')).toBe("''");
    expect(sqlLit(0)).toBe('0');
    expect(sqlLit(-1.5)).toBe('-1.5');
    expect(sqlLit(Infinity)).toBe('NULL');
    expect(sqlLit(undefined)).toBe('NULL');
    expect(sqlLit(true)).toBe('1');
  });
});

// ======================================================================= injection
describe('SQL injection from CSV content / headers', () => {
  it('every statement is one line and only literals + numbers after stripping string literals', async () => {
    const dir = mkIn({
      'Departments.csv': "id,code,name,isActive\nD1,PD,\"x'); DROP TABLE users;--\",true\n",
      'Products.csv': 'id,code,name,department,category\nP1,C1,"a\\b\'c\r\nd",PD,"; DELETE FROM users"\n',
      'PRs.csv': "id,prNo,department,status,items,evil'); DROP TABLE users;--\nPR1,PD001/2026,PD,DRAFT,[],x\n",
    });
    const { sql } = await runImport({ inDir: dir });
    expect(sql).not.toContain('\r');
    const lines = insertLines(sql);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(stripLiterals(l)).toMatch(STRICT);
      expect(l).not.toMatch(/^INSERT[^']*DROP/);
    }
    // header name lands only inside a (quoted) JSON literal
    const pr = lines.find((l) => l.includes('INTO prs'));
    expect(pr).toContain("evil''); DROP TABLE users;--");
    expect(pr.slice(0, pr.indexOf('VALUES'))).not.toContain('evil');
  });
});

// ======================================================================= passwords
describe('password handling', () => {
  const header = 'id,username,password,pin,name,department,roleId,employeeId,status\n';
  it('no plaintext password/pin anywhere (sql, report text, report json)', async () => {
    const dir = mkIn({
      'Users.csv': `${header}U1,qa.one,"Zq-Plain-8841'x\\y;",PIN-5527,QA One,PD,REQUESTER_PD,E1,ACTIVE\n`
        + `U2,qa.long,${'L'.repeat(257)},PIN-5528,QA Long,PD,REQUESTER_PD,E2,ACTIVE\n`,
    });
    const res = await runImport({ inDir: dir });
    const all = res.sql + JSON.stringify(res.report) + formatReport(res);
    expect(all).not.toContain('Zq-Plain');
    expect(all).not.toContain('PIN-552');
    expect(all).not.toContain('L'.repeat(257));
    expect(res.users).toMatchObject({ hashed: 1, noHashTooLong: 1 });
    expect(res.sql).not.toMatch(/\bpin\b/);
  });

  const hashOf = (sql, uname) => {
    const line = sql.split('\n').find((l) => l.includes(`'${uname}'`));
    const m = /'([A-Za-z0-9+/]{43}=)', '([A-Za-z0-9+/]{22}==)', 'PBKDF2-SHA256', (\d+)/.exec(line);
    return m ? { hash: m[1], salt: m[2], iterations: Number(m[3]), algo: 'PBKDF2-SHA256' } : null;
  };

  it('hash verifies with the original password (control)', async () => {
    const dir = mkIn({ 'Users.csv': `${header}U1,qa.ctl,Plain1x,,QA,PD,REQUESTER_PD,E1,ACTIVE\n` });
    const { sql } = await runImport({ inDir: dir });
    const rec = hashOf(sql, 'qa.ctl');
    expect(rec).not.toBeNull();
    expect(await verifyPassword('Plain1x', rec)).toBe(true);
    expect(await verifyPassword('plain1x', rec)).toBe(false);
  });

  // BUG: GAS login trims the stored password (Code.gs:299) and D1 login trims the input (functions [[route]].js:173)
  // แต่ importer hash แบบไม่ trim -> ผู้ใช้ที่รหัสในชีตมีช่องว่างหัวท้ายเข้าสู่ระบบไม่ได้
  it('BUG: password with surrounding spaces is hashed trimmed (parity with GAS)', async () => {
    const dir = mkIn({ 'Users.csv': `${header}U1,qa.sp,"  Secret1  ",,QA,PD,REQUESTER_PD,E1,ACTIVE\n` });
    const { sql } = await runImport({ inDir: dir });
    const rec = hashOf(sql, 'qa.sp');
    expect(rec).not.toBeNull();
    expect(await verifyPassword('Secret1', rec)).toBe(true);
  });
});

// ======================================================================= doc_counters
describe('doc_counters', () => {
  const get = (r, dept, type, year) => r.counters.find((c) => c.dept === dept && c.docType === type && c.year === year)?.lastNumber;

  it('max per dept+type+year for PR "PD001/2026" and PO "PO-PD-2026-001"; sheet counter lower than docs does not win', async () => {
    const dir = mkIn({
      'PRs.csv': 'id,prNo,department,status\nA,PD009/2026,PD,X\nB,PD010/2026,PD,X\nC,PD1000/2026,PD,X\nD,QC001/2026,QC,X\nE,PD005/2025,PD,X\nF,pd011/2026,PD,X\n',
      'POs.csv': 'id,poNo,department,status\nA,PO-PD-2026-007,PD,X\nB,PO-PD-2026-020,PD,X\nC,PO-QC-2025-003,QC,X\n',
      'PRCounters.csv': 'dept,docType,lastNumber,prefix,year,updatedAt\npd,pr,3,PR,2026,\n',
    });
    const r = await runImport({ inDir: dir });
    expect(get(r, 'PD', 'PR', 2026)).toBe(1000);
    expect(get(r, 'QC', 'PR', 2026)).toBe(1);
    expect(get(r, 'PD', 'PR', 2025)).toBe(5);
    expect(get(r, 'PD', 'PO', 2026)).toBe(20);
    expect(get(r, 'QC', 'PO', 2025)).toBe(3);
    // no duplicate key per (dept,docType,year)
    const keys = r.counters.map((c) => `${c.dept}|${c.docType}|${c.year}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sheet counter higher than imported docs wins (next number cannot collide)', async () => {
    const dir = mkIn({
      'PRs.csv': 'id,prNo,department,status\nA,PD002/2026,PD,X\n',
      'PRCounters.csv': 'dept,docType,lastNumber,prefix,year,updatedAt\nPD,PR,9,PR,2026,\n',
    });
    const r = await runImport({ inDir: dir });
    expect(get(r, 'PD', 'PR', 2026)).toBe(9);
  });

  // BUG (ต่ำ): GAS generateSequentialDocId ใช้ Number(r.year || currentYear) -> แถวที่ year ว่างคือปีปัจจุบัน แต่ importer ข้ามแถว
  it('BUG: PRCounters row with blank year counts as current year (GAS parity)', async () => {
    const dir = mkIn({ 'PRCounters.csv': 'dept,docType,lastNumber,prefix,year,updatedAt\nPD,PR,40,PR,,\n' });
    const r = await runImport({ inDir: dir });
    expect(get(r, 'PD', 'PR', new Date().getFullYear())).toBe(40);
  });

  // BUG (ต่ำ-กลาง): แถว PR ที่ถูก skip (เช่นขาด status) เคยใช้เลขไปแล้วในระบบเดิม แต่ไม่ถูกนับเข้า counter
  // -> ถ้าไม่มีชีต PRCounters เลขถัดไปอาจซ้ำกับเอกสารที่ไม่ได้ import
  it('BUG: skipped PR row still reserves its document number in doc_counters', async () => {
    const dir = mkIn({ 'PRs.csv': 'id,prNo,department,status\nA,PD001/2026,PD,X\nB,PD050/2026,PD,\n' });
    const r = await runImport({ inDir: dir });
    expect(get(r, 'PD', 'PR', 2026)).toBe(50);
  });
});

// ======================================================================= duplicate unique keys
describe('unique-key collisions', () => {
  // BUG (กลาง): products.code / vendors.code / users.username|employeeId / prs.prNumber / pos.poNumber เป็น UNIQUE
  // INSERT OR REPLACE ลบแถวเดิมเงียบ ๆ เมื่อ id ต่างแต่ key ซ้ำ ; รายงานยังนับ written ครบ ไม่มีคำเตือน
  it('BUG: duplicate products.code with different id is reported (not silently replaced)', async () => {
    const dir = mkIn({ 'Products.csv': 'id,code,name,department\nP1,C1,A,PD\nP2,C1,B,QC\n' });
    const r = await runImport({ inDir: dir });
    const rep = r.report.find((x) => x.sheet === 'Products');
    expect(rep.skipped + Object.keys(rep.reasons).length).toBeGreaterThan(0);
  });
});

// ======================================================================= data loss (ฟิลด์ที่ผู้ใช้เห็น)
describe('data loss: fields used by frontend/GAS must survive import', () => {
  const lineOf = (sql, table) => sql.split('\n').find((l) => l.startsWith(`INSERT INTO ${table} `)) || '';

  const btHeader = 'id,date,createdAt,transactionId,period,type,actionType,dept,amount,refundAmount,creditAmount,docType,docNo,poNumber,actorName,actorRole,note,timestamp\n';
  const btRow = 'TX1,2026-09-01,2026-09-01T00:00:00Z,TXN-DOC-77-BUDGET_ROLLBACK,2026-09,BUDGET_ROLLBACK,BUDGET_ROLLBACK,PD,5,123.45,6.5,PO,DOC-77,PO-PD-2026-077,Somchai,FINANCE,note,2026-09-01T00:00:00Z\n';

  // src/views/BudgetView.jsx:1747 amount = tx.amount ?? tx.refundAmount ?? tx.creditAmount ; gas/Code.gs:3660-3664 ใช้ refundAmount
  it('BUG: budget_transactions keeps refundAmount/creditAmount', async () => {
    const { sql } = await runImport({ inDir: mkIn({ 'BudgetTransactions.csv': btHeader + btRow }) });
    const l = lineOf(sql, 'budget_transactions');
    expect(l).toContain('123.45');
    expect(l).toContain('6.5');
  });
  // BudgetView.jsx:1749 docRef = tx.docNo || tx.poNumber ; ลูกค้าเห็นคอลัมน์ "เอกสารอ้างอิง" ใน ledger
  it('BUG: budget_transactions keeps docNo/poNumber/docType (ledger reference column)', async () => {
    const { sql } = await runImport({ inDir: mkIn({ 'BudgetTransactions.csv': btHeader + btRow }) });
    const l = lineOf(sql, 'budget_transactions');
    expect(l).toContain('DOC-77');
    expect(l).toContain('PO-PD-2026-077');
  });
  // budgetService.js:491 / Code.gs:3641-3647 idempotency guard ใช้ transactionId/docNo+type -> หายแล้วคืนเงินซ้ำได้
  it('BUG: budget_transactions keeps transactionId (idempotency key) and actorRole', async () => {
    const { sql } = await runImport({ inDir: mkIn({ 'BudgetTransactions.csv': btHeader + btRow }) });
    const l = lineOf(sql, 'budget_transactions');
    expect(l).toContain('TXN-DOC-77-BUDGET_ROLLBACK');
    expect(l).toContain('FINANCE');
  });

  // BudgetContext.jsx:40-41, budgetService.js:544, workflowEngine.js:684 อ่าน/เขียน budgets[dept].refundCredits[month] ; pending/historicalSpent ใช้คำนวณงบ
  it('BUG: budgets keeps refundCredits / historicalSpent / pending', async () => {
    const csv = 'dept,monthlyBudget,spent,pending,variance,year,month,historicalSpent,history,refundCredits,updatedAt\n'
      + 'PD,50000,1000,3131,49000,2026,9,"{""2026-09"":4242}","{""2026-09"":50000}","{""2026-09"":8171}",\n';
    const { sql } = await runImport({ inDir: mkIn({ 'Budgets.csv': csv }) });
    const l = lineOf(sql, 'budgets');
    expect(l).toContain('8171');
    expect(l).toContain('4242');
    expect(l).toContain('3131');
  });

  // StockCardView.jsx:214,754 ใช้ leadTimeDays ; QuickIssue/StockCard/MasterData ใช้ p.locationName
  it('BUG: products keeps leadTimeDays and locationName', async () => {
    const csv = 'id,code,name,department,leadTimeDays,locationName,locationId\nP1,C1,A,PD,13579,LOC-NAME-X,L1\n';
    const { sql } = await runImport({ inDir: mkIn({ 'Products.csv': csv }) });
    const l = lineOf(sql, 'products');
    expect(l).toContain('13579');
    expect(l).toContain('LOC-NAME-X');
  });

  // storage_locations ใน GAS มี isActive ; D1 ไม่มีคอลัมน์ -> จุดเก็บที่ปิดใช้งานกลับมาเปิด
  it('BUG: storage_locations keeps isActive', async () => {
    const csv = 'id,name,department,isActive\nL1,Shelf,PD,false\n';
    const { sql } = await runImport({ inDir: mkIn({ 'StorageLocations.csv': csv }) });
    const cols = lineOf(sql, 'storage_locations').split('VALUES')[0];
    expect(cols).toMatch(/isActive|status/);
  });

  // INACTIVE vs isDeleted ตรวจค่าจริงผ่าน SQLite ในกลุ่ม 'SQLite' ด้านล่าง
});

describe('CLI options / output safety', () => {
  const csv = { 'Departments.csv': 'id,code,name,isActive\nD1,PD,x,true\n' };

  it('default is plain INSERT with header; --replace gives INSERT OR REPLACE with warning header', async () => {
    const plain = (await runImport({ inDir: mkIn(csv) })).sql;
    expect(plain).toMatch(/^INSERT INTO departments /m);
    expect(plain).not.toContain('INSERT OR REPLACE');
    expect(plain).not.toContain('รันซ้ำได้');
    const rep = (await runImport({ inDir: mkIn(csv), replace: true })).sql;
    expect(rep).toMatch(/^INSERT OR REPLACE INTO departments /m);
    expect(rep).toContain('--replace');
  });

  it('doc_counters uses ON CONFLICT ... MAX(lastNumber, excluded.lastNumber)', async () => {
    const dir = mkIn({ 'PRs.csv': 'id,prNo,department,status\nA,PD003/2026,PD,X\n' });
    const { sql } = await runImport({ inDir: dir });
    expect(sql).toContain('ON CONFLICT(dept, docType, year) DO UPDATE SET lastNumber = MAX(lastNumber, excluded.lastNumber)');
  });

  it('invalid JSON error carries only the file name, not content', async () => {
    const dir = mkIn({ 'Users.json': '{"secret-content-xyz": ' });
    await expect(runImport({ inDir: dir })).rejects.toThrow(/^ไฟล์ Users\.json ไม่ใช่ JSON ที่ถูกต้อง$/);
  });

  it('--out validation: .sql only, no overwrite without force, not in input dir, not in data/', async () => {
    const dir = mkIn(csv);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-out-'));
    const out = path.join(outDir, 'o.sql');
    try {
      await expect(runImport({ inDir: dir, outFile: path.join(outDir, 'o.txt') })).rejects.toThrow('.sql');
      await expect(runImport({ inDir: dir, outFile: path.join(dir, 'o.sql') })).rejects.toThrow('โฟลเดอร์อินพุต');
      await withTempOut(path.join(ROOT, 'data', 'qa-nonexistent-sub', 'o.sql'), async () => {
        await expect(runImport({ inDir: dir, outFile: path.join(ROOT, 'data', 'qa-nonexistent-sub', 'o.sql') })).rejects.toThrow('data/');
      });
      await runImport({ inDir: dir, outFile: out });
      await expect(runImport({ inDir: dir, outFile: out })).rejects.toThrow('--force');
      await runImport({ inDir: dir, outFile: out, force: true });
    } finally {
      try { fs.unlinkSync(out); } catch { /* ignore */ }
      try { fs.rmdirSync(outDir); } catch { /* ignore */ }
    }
  });

  it('default password check is case-insensitive; --force-change-password flags everyone', async () => {
    const users = 'id,username,password,name,department,roleId,employeeId\nU1,a.up,ADMIN123,A,PD,R,E1\nU2,a.ok,Okpass1,B,PD,R,E2\n';
    const r1 = await runImport({ inDir: mkIn({ 'Users.csv': users }) });
    expect(r1.users).toMatchObject({ hashed: 1, noHashDefault: 1 });
    const r2 = await runImport({ inDir: mkIn({ 'Users.csv': users }), forceChangePassword: true });
    const okLine = r2.sql.split('\n').find((l) => l.includes("'a.ok'"));
    expect(okLine).toContain('PBKDF2-SHA256');
    expect(okLine).toMatch(/, 1, '[^']+'\);$/); // mustChangePassword = 1, passwordUpdatedAt
  });
});

// ======================================================================= --out กับ path ที่ห้าม + id ซ้ำ
describe('--out protected paths / duplicate ids (QA ข้อต่ำ)', () => {
  // สร้างไฟล์เฉพาะเมื่อ "ยังไม่มี" และลบเฉพาะไฟล์ที่เทสต์สร้างเอง ทีละไฟล์ (ป้องกันเขียนทับไฟล์เดิมใน repo)
  const csv = { 'Departments.csv': 'id,code,name,isActive\nD1,PD,x,true\n' };

  it('--out ..\\data\\x.sql and DATA\\x.sql (ทั้งแบบ resolve และตัวพิมพ์ต่าง) ถูกปฏิเสธ', async () => {
    const dir = mkIn(csv);
    // ไม่ใช้ path จริงใน data/ โดยตรง: โฟลเดอร์ย่อยที่ยังไม่มี ถ้า validate พังจะถูกสร้างแล้วเทสต์ลบคืน
    const sub = 'qa-nonexistent-sub';
    const viaDotDot = `${path.join(ROOT, 'scripts')}\\..\\data\\${sub}\\x.sql`;
    const upper = path.join(ROOT, 'DATA', sub, 'x.sql');
    await withTempOut(path.join(ROOT, 'data', sub, 'x.sql'), async () => {
      await expect(runImport({ inDir: dir, outFile: viaDotDot, force: true })).rejects.toThrow('data/');
    });
    await withTempOut(path.join(ROOT, 'data', sub, 'x.sql'), async () => {
      await expect(runImport({ inDir: dir, outFile: upper, force: true })).rejects.toThrow('data/');
    });
  });

  it('--out ในไฟล์ migrations/ ถูกปฏิเสธแม้มี --force', async () => {
    const dir = mkIn(csv);
    const p = path.join(ROOT, 'migrations', 'qa-should-not-exist.sql');
    await withTempOut(p, async () => {
      await expect(runImport({ inDir: dir, outFile: p, force: true })).rejects.toThrow('migrations/');
      expect(fs.existsSync(p)).toBe(false);
    });
  });

  it('--out ใน functions/ src/ cloudflare/ และชื่อ d1_schema.sql ถูกปฏิเสธแม้มี --force', async () => {
    const dir = mkIn(csv);
    const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-schema-'));
    try {
      const targets = [
        path.join(ROOT, 'functions', 'qa-should-not-exist.sql'),
        path.join(ROOT, 'src', 'qa-should-not-exist.sql'),
        path.join(ROOT, 'cloudflare', 'qa-should-not-exist.sql'),
        path.join(schemaDir, 'd1_schema.sql'),
      ];
      for (const p of targets) {
        await withTempOut(p, async () => {
          await expect(runImport({ inDir: dir, outFile: p, force: true })).rejects.toThrow();
          expect(fs.existsSync(p)).toBe(false);
        });
      }
    } finally {
      try { fs.rmdirSync(schemaDir); } catch { /* ignore */ }
    }
  });

  it('--out อยู่ใน repo แต่ไม่ลงท้าย .import.sql ถูกปฏิเสธ ; ลงท้าย .import.sql ผ่าน', async () => {
    const dir = mkIn(csv);
    const bad = path.join(ROOT, 'import', 'qa-should-not-exist.sql');
    await expect(runImport({ inDir: dir, outFile: bad })).rejects.toThrow('.import.sql');
    expect(fs.existsSync(bad)).toBe(false);
    // path นอก repo (tmp) ที่ไม่ใช่ .import.sql ยังผ่านได้
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-out-'));
    const ok = path.join(outDir, 'o.sql');
    try {
      await runImport({ inDir: dir, outFile: ok });
      expect(fs.existsSync(ok)).toBe(true);
    } finally {
      try { fs.unlinkSync(ok); } catch { /* ignore */ }
      try { fs.rmdirSync(outDir); } catch { /* ignore */ }
    }
  });

  // junction (Windows) ใน tmp ชี้ไป migrations/ จริง -> realpath ต้องพาไปเจอ migrations/ แล้วปฏิเสธ
  // ลบเฉพาะ junction ด้วย rmdirSync (ลบลิงก์ ไม่แตะปลายทาง)
  it('junction ใน tmp ที่ชี้ไป migrations/ ถูกปฏิเสธ (realpath)', async (ctx) => {
    const dir = mkIn(csv);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-junc-'));
    const link = path.join(linkParent, 'lnk');
    try {
      try { fs.symlinkSync(path.join(ROOT, 'migrations'), link, 'junction'); } catch { ctx.skip(); return; }
      const p = path.join(link, 'qa-should-not-exist.sql');
      await withTempOut(path.join(ROOT, 'migrations', 'qa-should-not-exist.sql'), async () => {
        await expect(runImport({ inDir: dir, outFile: p, force: true })).rejects.toThrow('migrations/');
        expect(fs.existsSync(path.join(ROOT, 'migrations', 'qa-should-not-exist.sql'))).toBe(false);
      });
    } finally {
      try { fs.rmdirSync(link); } catch { /* ignore */ }
      try { fs.rmdirSync(linkParent); } catch { /* ignore */ }
    }
  });

  it('โหมดปกติ: id ซ้ำ -> เก็บแถวแรก ข้ามแถวหลัง และรายงานเหตุผล', async () => {
    const dir = mkIn({ 'Departments.csv': 'id,code,name,isActive\nD1,PD,first,true\nD1,QC,second,true\n' });
    const r = await runImport({ inDir: dir });
    const rep = r.report.find((x) => x.sheet === 'Departments');
    expect(rep.written).toBe(1);
    expect(rep.skipped).toBe(1);
    expect(rep.reasons['id ซ้ำ ข้ามแถวหลัง']).toBe(1);
    const lines = insertLines(r.sql);
    expect(lines.filter((l) => l.includes('INTO departments'))).toHaveLength(1);
    expect(r.sql).toContain("'first'");
    expect(r.sql).not.toContain("'second'");
  });

  it('โหมด --replace: id ซ้ำยังเขียนทั้งสองแถว (พฤติกรรมเดิม) และรายงานว่าแถวหลังทับ', async () => {
    const dir = mkIn({ 'Departments.csv': 'id,code,name,isActive\nD1,PD,first,true\nD1,QC,second,true\n' });
    const r = await runImport({ inDir: dir, replace: true });
    const rep = r.report.find((x) => x.sheet === 'Departments');
    expect(rep.written).toBe(2);
    expect(rep.reasons['id ซ้ำ (แถวหลังทับแถวก่อน)']).toBe(1);
  });
});

// ======================================================================= SQLite integration (ข้ามถ้า Node ไม่มี node:sqlite)
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
function newDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS) db.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  return db;
}
const count = (db, t) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);

describe.skipIf(!DatabaseSync)('SQLite: apply migrations 0001-0006 + generated SQL', () => {
  it('fixtures import: plain mode fails on re-run (no silent overwrite); --replace re-run keeps row counts', async () => {
    const plain = (await runImport({ inDir: FIX })).sql;
    const db = newDb();
    db.exec(plain);
    expect(() => db.exec(plain)).toThrow();
    db.close();

    const { sql } = await runImport({ inDir: FIX, replace: true });
    const db2 = newDb();
    db2.exec(sql);
    const tables = ['departments', 'users', 'products', 'prs', 'pos', 'pr_items', 'stock_logs', 'budgets', 'doc_counters'];
    const first = tables.map((t) => count(db2, t));
    db2.exec(sql);
    expect(tables.map((t) => count(db2, t))).toEqual(first);
    expect(first[0]).toBeGreaterThan(0);
    db2.close();
  });

  it('doc_counters never goes backwards when the table already has a higher number', async () => {
    const { sql } = await runImport({ inDir: mkIn({ 'PRs.csv': 'id,prNo,department,status\nA,PD003/2026,PD,X\n' }) });
    const db = newDb();
    db.exec("INSERT INTO doc_counters (dept, docType, year, lastNumber) VALUES ('PD', 'PR', 2026, 99)");
    db.exec(sql);
    expect(Number(db.prepare("SELECT lastNumber AS n FROM doc_counters WHERE dept='PD' AND docType='PR' AND year=2026").get().n)).toBe(99);
    db.close();
  });

  // MasterDataView มีสถานะ INACTIVE (ปิดใช้งาน) แยกจากลบ ; bootstrap กรอง isDeleted = 0 -> ต้องไม่ถูกแปลงเป็น isDeleted
  it('INACTIVE product / inactive storage location keep real values (status, isActive, isDeleted)', async () => {
    const dir = mkIn({
      'Products.csv': 'id,code,name,department,status,isActive\nP1,C1,A,PD,INACTIVE,false\nP2,C2,B,PD,ACTIVE,true\n',
      'StorageLocations.csv': 'id,name,department,isActive\nL1,Shelf,PD,false\nL2,Shelf2,PD,true\n',
    });
    const { sql } = await runImport({ inDir: dir });
    const db = newDb();
    db.exec(sql);
    expect({ ...db.prepare('SELECT status, isActive, isDeleted FROM products WHERE id = ?').get('P1') })
      .toEqual({ status: 'INACTIVE', isActive: 0, isDeleted: 0 });
    expect({ ...db.prepare('SELECT status, isActive, isDeleted FROM products WHERE id = ?').get('P2') })
      .toEqual({ status: 'ACTIVE', isActive: 1, isDeleted: 0 });
    expect(Number(db.prepare('SELECT isActive AS a FROM storage_locations WHERE id = ?').get('L1').a)).toBe(0);
    expect(Number(db.prepare('SELECT isActive AS a FROM storage_locations WHERE id = ?').get('L2').a)).toBe(1);
    db.close();
  });

  it('hostile text round-trips exactly and does not alter schema', async () => {
    const name = "it's a\\b; --\r\nline2 '); DROP TABLE users;--";
    const dir = mkIn({
      'Products.csv': `id,code,name,department\nP1,C1,"${name.replace(/"/g, '""')}",PD\n`,
      'Departments.csv': "id,code,name,isActive\nD1,PD,\"x'); DROP TABLE users;--\",true\n",
    });
    const { sql } = await runImport({ inDir: dir });
    const db = newDb();
    db.exec(sql);
    expect(db.prepare('SELECT name FROM products WHERE id = ?').get('P1').name).toBe(name);
    expect(db.prepare('SELECT name FROM departments WHERE id = ?').get('D1').name).toBe("x'); DROP TABLE users;--");
    expect(Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'users'").get().c)).toBe(1);
    db.close();
  });

  it('users without usable password get mustChangePassword = 1 and empty password column', async () => {
    const dir = mkIn({
      'Users.csv': 'id,username,password,name,department,roleId,employeeId\nU1,a.def,123456,A,PD,R,E1\nU2,a.emp,,B,PD,R,E2\nU3,a.ok,Okpass1,C,PD,R,E3\n',
    });
    const { sql } = await runImport({ inDir: dir });
    const db = newDb();
    db.exec(sql);
    const row = (u) => ({ ...db.prepare('SELECT password, passwordHash, mustChangePassword FROM users WHERE username = ?').get(u) });
    expect(row('a.def')).toMatchObject({ password: '', passwordHash: null, mustChangePassword: 1 });
    expect(row('a.emp')).toMatchObject({ password: '', passwordHash: null, mustChangePassword: 1 });
    expect(row('a.ok')).toMatchObject({ password: '', mustChangePassword: 0 });
    expect(row('a.ok').passwordHash).toBeTruthy();
    db.close();
  });
});
