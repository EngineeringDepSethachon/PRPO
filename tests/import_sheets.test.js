// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImport, parseCsv, sqlLit, counterFromDocNo } from '../scripts/import-sheets-to-d1.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'sheets');
const FAKE_PLAIN = 'Fx-Plain-Pw-7731';

let result;
let sql;
let tmpDir;
let outFile;
const line = (needle) => sql.split('\n').find((l) => l.includes(needle));

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-sheets-'));
  outFile = path.join(tmpDir, 'out.sql');
  result = await runImport({ inDir: FIX, outFile });
  sql = fs.readFileSync(outFile, 'utf8');
});

afterAll(() => {
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
});

describe('csv parser / sql escape', () => {
  it('handles quotes, embedded newlines, BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x ""q"",y","l1\nl2"\r\n');
    expect(rows).toEqual([['a', 'b'], ['x "q",y', 'l1\nl2']]);
  });
  it('escapes single quote and newlines', () => {
    expect(sqlLit("O'Brien")).toBe("'O''Brien'");
    expect(sqlLit('a\nb')).toBe("'a'||char(10)||'b'");
    expect(sqlLit(null)).toBe('NULL');
    expect(sqlLit(NaN)).toBe('NULL');
  });
  it('extracts counters from doc numbers', () => {
    expect(counterFromDocNo('PD001/2026')).toEqual({ dept: 'PD', docType: 'PR', year: 2026, n: 1 });
    expect(counterFromDocNo('PO-QC-2025-044')).toEqual({ dept: 'QC', docType: 'PO', year: 2025, n: 44 });
    expect(counterFromDocNo('junk')).toBeNull();
  });
});

describe('mapping', () => {
  it('maps PR columns, poNumber list and extraJson', () => {
    const l = line("'PD001/2026'");
    expect(l).toContain('INSERT INTO prs');
    expect(l).toContain("'PO-PD-2026-001, PO-PD-2026-002'");
    expect(l).toContain("'PR-1'");
    // note: apostrophe + newline escaped
    expect(l).toContain("หมายเหตุ it''s'||char(10)||'สองบรรทัด");
    expect(l).toContain('"reviewedBy":"boss"');
    expect(l).toContain('"poNumbers":["PO-PD-2026-001","PO-PD-2026-002"]');
    expect(l).toContain('"committedAmount":200');
    // itemsJson re-serialised JSON
    expect(l).toContain(`[{"name":"น้ำมัน 5''L","qty":2,"price":100}]`);
  });

  it('PR without items falls back to PRItems; bad JSON -> []', () => {
    expect(line("'QC007/2026'")).toContain('"name":"สารเคมี"');
    const bad = line("'PD002/2025'");
    expect(bad).toContain("'[]'");
    expect(bad).toContain("'PO-PD-2025-004'");
    const prRep = result.report.find((r) => r.sheet === 'PRs');
    expect(prRep.warnings).toBe(1);
  });

  it('maps PO real columns and extraJson', () => {
    const l = line("'PO-PD-2026-012'");
    expect(l).toContain('INSERT INTO pos');
    expect(l).toContain("budgetPeriod");
    expect(l).toMatch(/'2026-03', 107, 105\.5, 105\.5, 'ONLINE'\);$/);
    expect(l).toContain('"savingsAmount":1.5');
    expect(l).toContain('"isOnline":true');
    expect(l).toContain('"ngItems":[{"id":1}]');
  });

  it('maps products (stockUnit->usageUnit, price->standardPrice, INACTIVE->isDeleted)', () => {
    const l = line("'SKU-001'");
    expect(l).toContain("'น้ำมัน 5''L'");
    expect(l).toContain('1250.5');
    const dead = line("'SKU-002'");
    // isDeleted=0 (INACTIVE เก็บใน status/isActive), avgCost fallback averageCost
    expect(dead).toMatch(/'PD', 0, '2026-02-01', 8\.5, 0, NULL, NULL, 'INACTIVE', 0\);$/);
  });

  it('maps stock_logs and skips rows missing productId', () => {
    const l = line("'SL-1'");
    expect(l).toContain("'GRN-PO-PD-2026-012-01'");
    expect(line("'SL-2'")).toContain('-3');
    expect(line("'SL-3'")).toBeUndefined();
    const rep = result.report.find((r) => r.sheet === 'StockLogs');
    expect(rep).toMatchObject({ read: 3, written: 2, skipped: 1 });
  });

  it('maps budgets keyed by dept with monthsJson', () => {
    const l = line('INTO budgets');
    expect(l).toContain("'PD', 'PD', 2026, 50000, 50000, 1000, 49000");
    expect(l).toContain('{"2026-03":{"budget":50000}}');
  });
});

describe('users / password handling', () => {
  it('hashes real password, no plaintext, password empty string', () => {
    const l = line("'test.pd'");
    expect(l).toContain("PBKDF2-SHA256");
    expect(l).toContain('100000');
    expect(l).toMatch(/, '', 'O''Brien ทดสอบ'/); // password = ''
    expect(sql).not.toContain(FAKE_PLAIN);
    expect(sql).not.toContain('9999'); // pin not imported
    expect(sql).not.toMatch(/\bpin\b/);
  });

  it('does not set hash for default/empty passwords and counts them', () => {
    const d = line("'test.default'");
    expect(d).not.toContain('PBKDF2');
    expect(d).toContain("'INACTIVE'");
    expect(line("'test.empty'")).not.toContain('PBKDF2');
    expect(result.users).toMatchObject({ hashed: 1, noHashEmpty: 1, noHashDefault: 1, noHashTooLong: 0 });
    const usersRep = result.report.find((r) => r.sheet === 'Users');
    expect(usersRep).toMatchObject({ read: 4, written: 3, skipped: 1 });
    expect(JSON.stringify(result.report)).not.toContain(FAKE_PLAIN);
  });

  it('allowedDepartments from departments column', () => {
    expect(line("'test.empty'")).toContain('["PD","WH"]');
    expect(line("'test.pd'")).toContain('["PD"]');
  });
});

describe('doc_counters', () => {
  it('computes max per dept+docType+year and merges PRCounters sheet', () => {
    const get = (dept, type, year) => result.counters.find((c) => c.dept === dept && c.docType === type && c.year === year)?.lastNumber;
    expect(get('PD', 'PR', 2026)).toBe(5); // sheet counter 5 > doc 1
    expect(get('QC', 'PR', 2026)).toBe(7);
    expect(get('PD', 'PR', 2025)).toBe(2);
    expect(get('PD', 'PO', 2026)).toBe(12);
    expect(sql).toContain('INSERT INTO doc_counters (dept, docType, year, lastNumber, prefix, updatedAt)');
  });
});

describe('report', () => {
  it('reports per sheet read/written/skipped', () => {
    const r = result.report.find((x) => x.sheet === 'Departments');
    expect(r).toMatchObject({ read: 2, written: 2, skipped: 0 });
    expect(result.report.find((x) => x.sheet === 'Vendors').note).toMatch(/ไม่พบไฟล์/);
  });
});
