#!/usr/bin/env node
/**
 * import-sheets-to-d1.js : แปลงไฟล์ export จาก Google Sheets (ระบบเดิม) -> ไฟล์ .sql สำหรับ Cloudflare D1
 *
 * ออกแบบสำหรับ "ตอนตัดระบบ" : ใช้กับ D1 ที่ว่าง (apply migrations 0001-0006 แล้ว ยังไม่มีข้อมูล) เท่านั้น
 *
 * วิธีใช้ (Node 18+, ไม่ต้องติดตั้งแพ็กเกจ):
 *   1) ใน Google Sheets ส่งออกแต่ละชีตเป็น CSV (File > Download > CSV) แล้วตั้งชื่อไฟล์ = ชื่อชีต เช่น
 *      Users.csv, PRs.csv, POs.csv, PRItems.csv, Products.csv, StockLogs.csv ... (ตาม SCHEMA_DEFINITIONS
 *      ใน gas/SheetService.gs) ; รองรับ <ชีต>.json (array ของ object) ด้วย ; ชีตที่ไม่มีไฟล์จะถูกข้าม
 *      เก็บ CSV นอก repo หรือใน sheets-export/ (อยู่ใน .gitignore) และ "ลบทิ้งหลัง import" (มีข้อมูลบุคคล/รหัสผ่าน)
 *   2) สร้างไฟล์ SQL:
 *        node scripts/import-sheets-to-d1.js --in <โฟลเดอร์ CSV> [--out <ไฟล์.sql>] [--only Users,PRs]
 *          [--replace] [--force] [--force-change-password]
 *      - ค่าเริ่มต้น --out = import/d1-import.import.sql (ใน .gitignore) ; ต้องลงท้าย .sql ; ห้ามอยู่ใน data/ migrations/ functions/ src/ cloudflare/ หรือโฟลเดอร์ input (แม้มี --force)
 *        ถ้าอยู่ใน repo ต้องลงท้าย .import.sql ; ชื่อ d1_schema.sql ถูกปฏิเสธ
 *      - ไฟล์ --out มีอยู่แล้วจะปฏิเสธ เว้นแต่ --force
 *      - ค่าเริ่มต้นสร้าง INSERT ธรรมดา (ชน PRIMARY KEY/UNIQUE = คำสั่งล้มเหลว ไม่ทับข้อมูล)
 *        --replace = INSERT OR REPLACE (ทับแถวเดิมและลบแถวที่ชน UNIQUE เงียบ ๆ) พร้อมคำเตือน ; ใช้เมื่อรู้ผลเท่านั้น
 *      - --force-change-password = ตั้ง mustChangePassword = 1 ให้ทุกคน (ค่าเริ่มต้นตั้งเฉพาะคนที่ไม่มี hash)
 *      - ค่าเริ่มต้นเติมตาราง file_refs (INSERT OR IGNORE) ว่า PR/PO ที่นำเข้าถือไฟล์ Drive ตัวไหน (ใช้กติกาเดียวกับ API : filerefs.docFileIds)
 *        ต้อง apply migration 0011 ก่อน ; --no-file-refs = ไม่เติม (เซิร์ฟเวอร์จะสแกนแบบจำกัดแล้วทำดัชนีเองทีหลัง)
 *   3) apply migrations ทั้งหมด (0001-0011) ก่อน แล้วรันไฟล์ SQL (ทดสอบ local):
 *        npx wrangler d1 execute prpo-db --local --persist-to <dir> --file=<ไฟล์.sql>
 *      (ตอนตัดระบบจริงผู้ใช้เป็นผู้รันเอง ; สคริปต์นี้ไม่เรียก wrangler และไม่แตะ remote)
 *
 * กติกาสำคัญ
 *  - escape ' เป็น '' และ \n \r เป็น char(10)/char(13) ; หนึ่งคำสั่งต่อหนึ่งบรรทัด
 *  - doc_counters ใช้ ON CONFLICT DO UPDATE SET lastNumber = MAX(lastNumber, excluded.lastNumber) (ไม่ถอยเลขกลับ)
 *  - users: hash ด้วย functions/_lib/password.js (PBKDF2) -> passwordHash/Salt/Algo/Iterations, password = ''
 *    ห้ามเขียนรหัส plaintext ลง .sql/log ; รหัสว่าง/ค่า default ที่รู้จัก/ยาวเกิน -> ไม่ตั้ง hash + mustChangePassword = 1
 *    (ให้แอดมินตั้งรหัสใหม่) ; รายงานเฉพาะจำนวน ; pin ไม่ import
 *  - doc_counters: คำนวณจากเลขเอกสารที่ import (PR "PD001/2026", PO "PO-PD-2026-001") เอาเลขสูงสุดต่อ dept+docType+year
 *    และรวมกับชีต PRCounters (ถ้ามี) โดยเลือกค่าสูงกว่า
 *  - ฟิลด์ PR/PO ที่ไม่มีคอลัมน์ -> extraJson ; pos.budgetPeriod/committedAmount/actualPaidAmount/actualTotalAmount/
 *    purchaseChannel เป็นคอลัมน์จริง ; prs.poNumber เก็บเป็น "A, B" ได้ (และใส่ extraJson.poNumbers เป็น array)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, MAX_PASSWORD_LENGTH } from '../functions/_lib/password.js';
import { PR_KNOWN_STATUSES } from '../functions/_lib/rbac.js';
import { docFileIds, MAX_REFS_PER_DOC } from '../functions/_lib/filerefs.js';

// Server RBAC only moves PRs whose status the client really produces (rbac.PR_KNOWN_STATUSES) ; an odd sheet value would be stuck
// (only an admin could move it), so it is mapped to the closest known status and the original is kept in extraJson.originalStatus.
export function mapPrStatus(raw) {
  const s = String(raw ?? '').trim();
  if (PR_KNOWN_STATUSES.includes(s)) return { status: s, mapped: false };
  const u = s.toUpperCase();
  const ci = PR_KNOWN_STATUSES.find((k) => k.toUpperCase() === u);
  if (ci) return { status: ci, mapped: true };
  let status = 'DRAFT'; // unknown garbage: the safest place (the requester can fix / cancel it)
  if (/REJECT|ตีกลับ|ไม่อนุมัติ/.test(u) || /ตีกลับ|ไม่อนุมัติ/.test(s)) status = 'REJECTED_TO_DRAFT';
  else if (/CANCEL|VOID|ยกเลิก/.test(u) || /ยกเลิก/.test(s)) status = 'CANCELLED';
  else if (/DRAFT|ร่าง/.test(u) || /ร่าง/.test(s)) status = 'DRAFT';
  else if (/(WAIT|PEND|รอ).*(APPROV|อนุมัติ)/.test(u) || /รอ.*อนุมัติ/.test(s)) status = 'REVIEWED'; // waiting for the final approval
  else if (/PO[\s_-]?ISSUED/.test(u)) status = 'PO_ISSUED';
  else if (/IN[\s_-]?PROGRESS/.test(u)) status = 'IN_PROGRESS_ONLINE';
  else if (/APPROV|อนุมัติ/.test(u) || /อนุมัติ/.test(s)) status = 'APPROVED';
  else if (/REVIEWED/.test(u)) status = 'REVIEWED';
  else if (/CLOS|DONE|COMPLET|RECEIV|ปิด|เสร็จ/.test(u) || /ปิด|เสร็จ/.test(s)) status = 'CLOSED';
  else if (/REVIEW|WAIT|PEND|SUBMIT|รอ|ส่ง/.test(u) || /รอ|ส่ง/.test(s)) status = 'SUBMITTED';
  return { status, mapped: true };
}

// รหัส default ที่รู้จัก -> ไม่ตั้ง hash
export const KNOWN_DEFAULT_PASSWORDS = ['123456', 'password123', 'admin123'];

// คอลัมน์ UNIQUE ในตาราง D1 (migrations 0001) นอกเหนือจาก PRIMARY KEY
const UNIQUE_COLS = {
  departments: ['code'], users: ['username', 'employeeId'], products: ['code'], vendors: ['code'],
  prs: ['prNumber'], pos: ['poNumber'],
};

// ลำดับ = ลำดับที่เขียนลง SQL
export const SHEETS = [
  'Departments', 'Users', 'StorageLocations', 'UsageUnits', 'Products', 'Vendors', 'Signatures',
  'Budgets', 'BudgetTransactions', 'PRs', 'PRItems', 'POs', 'StockLogs', 'AuditLogs',
  'Notifications', 'AppConfig', 'Attachments', 'PRCounters',
];

// ---------------------------------------------------------------- CSV / input
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = []; i++; continue;
    }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, idx) => { if (h) o[h] = r[idx] === undefined ? '' : r[idx]; });
    return o;
  });
}

function loadSheet(dir, sheet) {
  const files = fs.readdirSync(dir);
  const lower = sheet.toLowerCase();
  const f = files.find((x) => x.toLowerCase() === `${lower}.csv`) || files.find((x) => x.toLowerCase() === `${lower}.json`);
  if (!f) return null;
  const full = path.join(dir, f);
  const raw = fs.readFileSync(full, 'utf8');
  if (f.toLowerCase().endsWith('.json')) {
    let j;
    try { j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch {
      // ไม่แนบข้อความ error เดิม (อาจมีเนื้อหาข้อมูลจริง)
      throw new Error(`ไฟล์ ${f} ไม่ใช่ JSON ที่ถูกต้อง`);
    }
    const arr = Array.isArray(j) ? j : (Array.isArray(j?.[sheet]) ? j[sheet] : []);
    return { file: f, rows: arr.filter((r) => r && typeof r === 'object') };
  }
  return { file: f, rows: csvToObjects(raw) };
}

// ---------------------------------------------------------------- value helpers
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const cellStr = (v) => (v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
const nz = (v) => (isBlank(v) ? null : cellStr(v).trim());
const raw = (v) => (isBlank(v) ? null : cellStr(v));

function num(v, def = null) {
  if (isBlank(v)) return def;
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  const x = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(x) ? x : def;
}

function bool(v, def = null) {
  if (isBlank(v)) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(s)) return false;
  return def;
}
const b01 = (v, def = 0) => { const b = bool(v, null); return b === null ? def : (b ? 1 : 0); };

/** แปลงเซลล์ JSON -> string JSON ; คืน {json, ok} (ว่าง = fallback ok) */
function jsonCell(v, fallback) {
  if (isBlank(v)) return { json: fallback, ok: true, empty: true };
  if (typeof v === 'object') return { json: JSON.stringify(v), ok: true };
  try { return { json: JSON.stringify(JSON.parse(String(v))), ok: true }; } catch { return { json: fallback, ok: false }; }
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try { return JSON.parse(t); } catch { return v; }
  }
  return v;
}

const NUMERIC_EXTRA = new Set(['subtotal', 'vat', 'committedAmount', 'actualPaidAmount', 'savingsAmount', 'claimRound', 'totalRefunded']);
const BOOL_EXTRA = new Set(['isOnline', 'hasDispute']);

// logs the API keeps append-only (approvalHistory ... ) : from the sheet they must be arrays, otherwise the server could not tell old entries from new ones
const LOG_COLUMNS = ['approvalHistory', 'activityLog', 'history', 'grnHistory', 'claimHistory', 'activityTimeline'];
function buildExtra(row, handled) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (handled.has(k) || isBlank(v)) continue;
    if (NUMERIC_EXTRA.has(k)) { const x = num(v); out[k] = x === null ? v : x; continue; }
    if (BOOL_EXTRA.has(k)) { const x = bool(v); out[k] = x === null ? v : x; continue; }
    out[k] = parseMaybeJson(v);
  }
  for (const k of LOG_COLUMNS) {
    if (k in out && !Array.isArray(out[k])) delete out[k]; // a cell that is not a JSON array is not a usable history
  }
  return out;
}

export function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v).replace(/\0/g, '')
    .replace(/'/g, "''")
    .replace(/\r/g, "'||char(13)||'")
    .replace(/\n/g, "'||char(10)||'");
  return `'${s}'`;
}

export function insertSql(table, cols, replace = false) {
  const names = Object.keys(cols);
  return `INSERT${replace ? ' OR REPLACE' : ''} INTO ${table} (${names.join(', ')}) VALUES (${names.map((k) => sqlLit(cols[k])).join(', ')});`;
}

export function counterSql(c, nowIso) {
  const base = insertSql('doc_counters', { dept: c.dept, docType: c.docType, year: c.year, lastNumber: c.lastNumber, prefix: c.prefix, updatedAt: nowIso });
  return `${base.slice(0, -1)} ON CONFLICT(dept, docType, year) DO UPDATE SET lastNumber = MAX(lastNumber, excluded.lastNumber), updatedAt = excluded.updatedAt;`;
}

// ---------------------------------------------------------------- mappers
// แต่ละ mapper: (row, ctx) -> { table, cols } | { skip: 'เหตุผล' } | array ของผลลัพธ์ (ผ่าน async ได้)
const need = (row, keys) => keys.filter((k) => isBlank(row[k]));

const MAPPERS = {
  Departments(row) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    if (isBlank(row.code) || isBlank(row.name)) return { skip: 'ไม่มี code/name' };
    return { table: 'departments', cols: {
      id: nz(row.id), code: nz(row.code), name: raw(row.name), isActive: b01(row.isActive, 1),
      createdAt: raw(row.createdAt),
    } };
  },

  StorageLocations(row) {
    if (need(row, ['id', 'name', 'department']).length) return { skip: 'ขาด id/name/department' };
    return { table: 'storage_locations', cols: {
      id: nz(row.id), name: raw(row.name), department: nz(row.department), isActive: b01(row.isActive, 1),
    } };
  },

  UsageUnits(row) {
    if (need(row, ['id', 'name', 'department']).length) return { skip: 'ขาด id/name/department' };
    const inactive = bool(row.isActive, true) === false;
    return { table: 'usage_units', cols: {
      id: nz(row.id), name: raw(row.name), department: nz(row.department),
      status: nz(row.status) || (inactive ? 'INACTIVE' : 'ACTIVE'),
    } };
  },

  Products(row) {
    if (need(row, ['id', 'code', 'name', 'department']).length) return { skip: 'ขาด id/code/name/department' };
    // ปิดใช้งาน (INACTIVE) แยกจากลบ: isDeleted = 0 เสมอ ; ใช้ status/isActive แทน (migration 0006)
    const inactive = bool(row.isActive, true) === false || String(row.status || '').toUpperCase() === 'INACTIVE';
    return { table: 'products', cols: {
      id: nz(row.id), code: nz(row.code), name: raw(row.name), category: raw(row.category),
      purchaseUnit: raw(row.purchaseUnit), usageUnit: raw(row.stockUnit),
      conversionRate: num(row.conversionRate, 1), minStock: num(row.reorderPoint, 0),
      currentStock: num(row.stockBalance, 0), standardPrice: num(row.price, 0),
      defaultLocationId: nz(row.locationId), isDirectUsage: 0, department: nz(row.department),
      isDeleted: 0, updatedAt: raw(row.updatedAt),
      avgCost: num(row.avgCost, num(row.averageCost, 0)), totalValue: num(row.totalValue, 0),
      leadTimeDays: num(row.leadTimeDays, null), locationName: raw(row.locationName),
      status: inactive ? 'INACTIVE' : (nz(row.status) || 'ACTIVE'), isActive: inactive ? 0 : 1,
    } };
  },

  Vendors(row) {
    if (need(row, ['id', 'code', 'name']).length) return { skip: 'ขาด id/code/name' };
    const inactive = bool(row.isActive, true) === false || String(row.status || '').toUpperCase() === 'INACTIVE';
    return { table: 'vendors', cols: {
      id: nz(row.id), code: nz(row.code), name: raw(row.name), contactPerson: raw(row.contactPerson),
      phone: raw(row.phone), email: raw(row.email), address: raw(row.address), taxId: raw(row.taxId),
      department: raw(row.department), isDeleted: 0,
      status: inactive ? 'INACTIVE' : (nz(row.status) || 'ACTIVE'), isActive: inactive ? 0 : 1,
    } };
  },

  Signatures(row) {
    if (isBlank(row.roleId)) return { skip: 'ไม่มี roleId' };
    return { table: 'signatures', cols: {
      roleId: nz(row.roleId), name: raw(row.name), signatureUrl: raw(row.signatureUrl),
      updatedAt: raw(row.updatedAt), updatedBy: raw(row.updatedBy),
    } };
  },

  Budgets(row) {
    if (isBlank(row.dept)) return { skip: 'ไม่มี dept' };
    const dept = nz(row.dept);
    const hist = jsonCell(row.history, '{}');
    const hs = jsonCell(row.historicalSpent, '{}');
    const rc = jsonCell(row.refundCredits, '{}');
    const monthly = num(row.monthlyBudget, 0);
    const bad = [!hist.ok && 'history', !hs.ok && 'historicalSpent', !rc.ok && 'refundCredits'].filter(Boolean);
    return { table: 'budgets', cols: {
      id: dept, department: dept, fiscalYear: num(row.year, new Date().getFullYear()),
      monthlyBudget: monthly, totalAllocated: monthly, totalUsed: num(row.spent, 0),
      totalRemaining: num(row.variance, 0), monthsJson: hist.json, updatedAt: raw(row.updatedAt),
      pendingAmount: num(row.pending, 0), historicalSpentJson: hs.json, refundCreditsJson: rc.json,
      month: nz(row.month),
    }, warn: bad.length ? `${bad.join('/')} ไม่ใช่ JSON ที่ถูกต้อง` : null };
  },

  BudgetTransactions(row) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    if (isBlank(row.dept) || isBlank(row.type)) return { skip: 'ขาด dept/type' };
    const created = raw(row.createdAt) || raw(row.date) || raw(row.timestamp);
    return { table: 'budget_transactions', cols: {
      id: nz(row.id), dept: nz(row.dept), department: nz(row.dept), type: nz(row.type),
      actionType: raw(row.actionType), amount: num(row.amount, 0), actor: raw(row.actorName),
      note: raw(row.note), targetMonth: raw(row.period), period: raw(row.period),
      createdAt: created, date: raw(row.date) || created,
      refundAmount: num(row.refundAmount, null), creditAmount: num(row.creditAmount, null),
      docType: raw(row.docType), docNo: raw(row.docNo), poNumber: raw(row.poNumber),
      transactionId: raw(row.transactionId), actorRole: raw(row.actorRole),
    } };
  },

  PRs(row, ctx) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    if (isBlank(row.prNo)) return { skip: 'ไม่มี prNo' };
    if (isBlank(row.department) || isBlank(row.status)) return { skip: 'ขาด department/status' };
    let items = jsonCell(row.items, '[]');
    let warn = items.ok ? null : 'items ไม่ใช่ JSON -> ใช้ []';
    if ((items.empty || !items.ok || items.json === '[]') && ctx.prItemsByPr) {
      const g = ctx.prItemsByPr.get(String(row.id).trim()) || ctx.prItemsByPr.get(String(row.prNo).trim());
      if (g && g.length) { items = { json: JSON.stringify(g), ok: true }; warn = null; }
    }
    const poList = isBlank(row.poNumber)
      ? []
      : String(parseMaybeJson(row.poNumber) instanceof Array ? parseMaybeJson(row.poNumber).join(',') : row.poNumber)
        .split(',').map((x) => x.trim()).filter(Boolean);
    // requestedBy is also kept in extraJson (the API reads it back as pr.requestedBy ; requesterName column keeps the same value as the fallback)
    const handled = new Set(['id', 'prNo', 'department', 'status', 'items', 'totalAmount', 'createdAt',
      'updatedAt', 'poNumber', 'note', 'purchaseChannel']);
    const extra = buildExtra(row, handled);
    if (!isBlank(row.requestedBy) && extra.requestedBy === undefined) extra.requestedBy = String(row.requestedBy).trim();
    if (poList.length) extra.poNumbers = poList;
    const st = mapPrStatus(row.status);
    if (st.mapped) {
      extra.originalStatus = String(row.status).trim();
      warn = [warn, `สถานะ PR "${extra.originalStatus}" ไม่อยู่ในชุดที่ระบบรู้จัก -> map เป็น ${st.status}`].filter(Boolean).join(' ; ');
    }
    return { table: 'prs', cols: {
      id: nz(row.id), prNumber: nz(row.prNo), department: nz(row.department), requesterName: raw(row.requestedBy),
      status: st.status, totalAmount: num(row.totalAmount, num(row.subtotal, 0)), reason: raw(row.note),
      itemsJson: items.json, createdAt: raw(row.createdAt), updatedAt: raw(row.updatedAt),
      extraJson: JSON.stringify(extra), poNumber: poList.length ? poList.join(', ') : null,
      purchaseChannel: raw(row.purchaseChannel),
    }, warn };
  },

  PRItems(row) {
    if (isBlank(row.id) || isBlank(row.prId)) return { skip: 'ขาด id/prId' };
    const imgs = jsonCell(row.images, null);
    const atts = jsonCell(row.attachments, null);
    return { table: 'pr_items', cols: {
      id: nz(row.id), prId: nz(row.prId), prNo: raw(row.prNo), productId: raw(row.productId),
      productCode: raw(row.productCode), name: raw(row.name), purchaseUnit: raw(row.purchaseUnit),
      stockUnit: raw(row.stockUnit), conversionRate: num(row.conversionRate, 1), qty: num(row.qty, 0),
      unit: raw(row.unit), price: num(row.price, 0), totalPrice: num(row.totalPrice, 0),
      department: raw(row.department), notes: raw(row.notes), status: raw(row.status),
      imageUrl: raw(row.imageUrl), fileId: raw(row.fileId), driveUrl: raw(row.driveUrl),
      images: imgs.json, attachments: atts.json, createdAt: raw(row.createdAt), updatedAt: raw(row.updatedAt),
    } };
  },

  POs(row) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    if (isBlank(row.poNo)) return { skip: 'ไม่มี poNo' };
    if (isBlank(row.department) || isBlank(row.status)) return { skip: 'ขาด department/status' };
    const items = jsonCell(row.items, '[]');
    const handled = new Set(['id', 'poNo', 'prId', 'prNo', 'department', 'vendorId', 'vendorName', 'purchaseChannel',
      'status', 'items', 'grandTotal', 'isClosed', 'createdAt', 'updatedAt', 'budgetPeriod', 'committedAmount',
      'actualPaidAmount', 'actualTotalAmount']);
    const extra = buildExtra(row, handled);
    // subtotal/vat เก็บใน extraJson ด้วย (ตาม parity D-1) แม้ map ลงคอลัมน์แล้ว
    const closed = bool(row.isClosed, null);
    return { table: 'pos', cols: {
      id: nz(row.id), poNumber: nz(row.poNo), prId: raw(row.prId), prNumber: raw(row.prNo),
      department: nz(row.department), vendorId: raw(row.vendorId), vendorName: raw(row.vendorName),
      totalAmount: num(row.subtotal, 0), vatAmount: num(row.vat, 0), grandTotal: num(row.grandTotal, 0),
      status: nz(row.status), itemsJson: items.json, createdAt: raw(row.createdAt), updatedAt: raw(row.updatedAt),
      extraJson: JSON.stringify(extra),
      isClosed: closed === null ? (String(row.status).toUpperCase() === 'CLOSED' ? 1 : 0) : (closed ? 1 : 0),
      budgetPeriod: raw(row.budgetPeriod), committedAmount: num(row.committedAmount, 0),
      actualPaidAmount: num(row.actualPaidAmount, 0), actualTotalAmount: num(row.actualTotalAmount, null),
      purchaseChannel: raw(row.purchaseChannel),
    }, warn: items.ok ? null : 'items ไม่ใช่ JSON -> ใช้ []' };
  },

  StockLogs(row) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    if (isBlank(row.productId) || isBlank(row.type)) return { skip: 'ขาด productId/type' };
    if (isBlank(row.department)) return { skip: 'ไม่มี department' };
    const change = num(row.changeQty, null);
    const qty = num(row.qty, change === null ? 0 : Math.abs(change));
    return { table: 'stock_logs', cols: {
      id: nz(row.id), productId: nz(row.productId), productCode: raw(row.productCode),
      productName: raw(row.productName) || raw(row.name), type: nz(row.type),
      docNo: raw(row.documentNo) || raw(row.grnNumber), referenceNo: raw(row.prNo), poNo: raw(row.poNumber),
      quantity: Math.abs(qty), changeQty: change, balance: num(row.balanceAfter, num(row.balance, 0)),
      unit: raw(row.unit), department: nz(row.department), location: raw(row.location),
      issuedTo: raw(row.issuedTo), issueUnit: raw(row.issueUnit), unitCost: num(row.unitCost, 0),
      totalCost: num(row.totalCost, 0), actorId: raw(row.actorId), actorName: raw(row.actorName),
      performedBy: raw(row.actorName), notes: raw(row.notes) || raw(row.reason),
      createdAt: raw(row.timestamp) || raw(row.date),
      conversionRate: num(row.conversionRate, null), unitPrice: num(row.unitPrice, null),
      totalPrice: num(row.totalPrice, null), locationId: raw(row.locationId), date: raw(row.date),
      grnNumber: raw(row.grnNumber),
    } };
  },

  AuditLogs(row) {
    if (isBlank(row.id) || isBlank(row.action)) return { skip: 'ขาด id/action' };
    const changes = parseMaybeJson(row.changes);
    const details = isBlank(row.changes) ? raw(row.summary) : JSON.stringify({ summary: raw(row.summary), changes });
    return { table: 'audit_logs', cols: {
      id: nz(row.id), action: nz(row.action), entityType: raw(row.module), entityId: raw(row.targetRef),
      performedBy: raw(row.actor), details, timestamp: raw(row.timestamp) || raw(row.createdAt),
    } };
  },

  Notifications(row) {
    if (isBlank(row.id)) return { skip: 'ไม่มี id' };
    return { table: 'notifications', cols: {
      id: nz(row.id), timestamp: raw(row.timestamp), title: raw(row.title), message: raw(row.message),
      type: raw(row.type), targetDepartment: raw(row.targetDepartment), targetRole: raw(row.targetRole),
      docRef: raw(row.docRef), status: raw(row.status) || 'UNREAD',
    } };
  },

  AppConfig(row) {
    if (isBlank(row.key)) return { skip: 'ไม่มี key' };
    return { table: 'app_config', cols: {
      key: nz(row.key), value: raw(row.value), description: raw(row.description), updatedAt: raw(row.updatedAt),
    } };
  },

  Attachments(row) {
    if (isBlank(row.id) || isBlank(row.fileId)) return { skip: 'ขาด id/fileId' };
    return { table: 'attachments', cols: {
      id: nz(row.id), fileId: nz(row.fileId), fileName: raw(row.fileName), mimeType: raw(row.mimeType),
      fileSize: num(row.fileSize, 0), category: raw(row.category), poNumber: raw(row.poNumber),
      docNo: raw(row.docNo), docType: raw(row.docType), viewUrl: raw(row.viewUrl), directUrl: raw(row.directUrl),
      lh3Url: raw(row.lh3Url), downloadUrl: raw(row.downloadUrl), folderPath: raw(row.folderPath),
      uploadedBy: raw(row.uploadedBy), uploadedAt: raw(row.uploadedAt),
    } };
  },
};

/** Users: async เพราะ hash */
async function mapUser(row, stats) {
  if (isBlank(row.id)) return { skip: 'ไม่มี id' };
  if (isBlank(row.username)) return { skip: 'ไม่มี username' };
  const dept = nz(row.department) || nz(row.primaryDepartment);
  if (!dept) return { skip: 'ไม่มี department' };
  if (isBlank(row.roleId)) return { skip: 'ไม่มี roleId' };
  const name = raw(row.name) || raw(row.employeeName) || raw(row.displayName) || nz(row.username);

  let allowed = parseMaybeJson(row.allowedDepartments);
  if (isBlank(allowed)) allowed = parseMaybeJson(row.departments);
  if (typeof allowed === 'string') allowed = allowed.split(',').map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(allowed) || !allowed.length) allowed = [dept];

  const active = bool(row.isActive, true);
  const status = nz(row.status) || (active === false ? 'INACTIVE' : 'ACTIVE');

  // trim ก่อน hash ตาม GAS login (Code.gs:299) และ D1 login ที่ trim input
  const pw = isBlank(row.password) ? '' : String(row.password).trim();
  let rec = null;
  if (pw === '') stats.noHashEmpty++;
  else if (KNOWN_DEFAULT_PASSWORDS.includes(pw.toLowerCase())) stats.noHashDefault++;
  else if (pw.length > MAX_PASSWORD_LENGTH) stats.noHashTooLong++;
  else { rec = await hashPassword(pw); stats.hashed++; }

  const cols = {
    id: nz(row.id), employeeId: nz(row.employeeId), username: nz(row.username), email: raw(row.email),
    password: '', name, employeeName: raw(row.employeeName), displayName: raw(row.displayName),
    position: raw(row.position), department: dept, primaryDepartment: nz(row.primaryDepartment) || dept,
    allowedDepartments: JSON.stringify(allowed), roleId: nz(row.roleId), canonicalRole: raw(row.canonicalRole),
    level: num(row.level, 1), status, signature: raw(row.signature), description: raw(row.description),
    updatedAt: raw(row.updatedAt),
    passwordHash: rec ? rec.hash : null, passwordSalt: rec ? rec.salt : null,
    passwordAlgo: rec ? rec.algo : null, passwordIterations: rec ? rec.iterations : null,
    mustChangePassword: (rec && !stats.forceChange) ? 0 : 1, passwordUpdatedAt: rec ? new Date().toISOString() : null,
  };
  return { table: 'users', cols };
}

// ---------------------------------------------------------------- counters
const PR_RE = /^([A-Za-z]+)(\d+)\/(\d{4})$/;
const PO_RE = /^PO-([A-Za-z0-9]+)-(\d{4})-(\d+)$/;

function bump(map, dept, docType, year, n, prefix) {
  const key = `${dept}|${docType}|${year}`;
  const cur = map.get(key);
  if (!cur || n > cur.lastNumber) map.set(key, { dept, docType, year, lastNumber: n, prefix });
}

export function counterFromDocNo(docNo) {
  const s = String(docNo || '').trim();
  let m = PR_RE.exec(s);
  if (m) return { dept: m[1].toUpperCase(), docType: 'PR', year: Number(m[3]), n: Number(m[2]) };
  m = PO_RE.exec(s);
  if (m) return { dept: m[1].toUpperCase(), docType: 'PO', year: Number(m[2]), n: Number(m[3]) };
  return null;
}

// ---------------------------------------------------------------- main
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = path.join(ROOT, 'import', 'd1-import.import.sql');

/**
 * realpath ของ path (แม้ไฟล์/โฟลเดอร์ปลายทางยังไม่มี) : realpath ของโฟลเดอร์แม่ที่มีอยู่ + ส่วนที่เหลือ
 * กัน symlink/junction พาออกนอกโฟลเดอร์ที่ห้าม
 */
function realpathOf(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = fs.realpathSync(cur); } catch { /* ใช้ path เดิม */ }
  return path.join(real, ...rest);
}

// เทียบแบบไม่สนตัวพิมพ์ใหญ่/เล็ก (Windows) ; path.relative อยู่บน path เดียวกันเสมอ
const isInside = (child, parent) => {
  const rel = path.relative(realpathOf(parent).toLowerCase(), realpathOf(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// โฟลเดอร์ใน repo ที่ห้ามเขียน --out ทับ/วาง (แม้มี --force)
const PROTECTED_DIRS = ['data', 'migrations', 'functions', 'src', 'cloudflare'];
const PROTECTED_BASENAMES = ['d1_schema.sql'];

function validateOut(outFile, inDir, force) {
  if (!String(outFile).toLowerCase().endsWith('.sql')) throw new Error('--out ต้องลงท้ายด้วย .sql');
  if (PROTECTED_BASENAMES.includes(path.basename(outFile).toLowerCase())) throw new Error('--out ห้ามใช้ชื่อ d1_schema.sql (DEPRECATED)');
  for (const d of PROTECTED_DIRS) {
    if (isInside(outFile, path.join(ROOT, d))) {
      throw new Error(d === 'data' ? '--out ห้ามอยู่ในโฟลเดอร์ data/' : `--out ห้ามอยู่ในโฟลเดอร์ ${d}/ (แม้มี --force)`);
    }
  }
  if (isInside(outFile, inDir)) throw new Error('--out ห้ามอยู่ในโฟลเดอร์อินพุต');
  if (isInside(outFile, ROOT) && !outFile.toLowerCase().endsWith('.import.sql')) {
    throw new Error('--out ที่อยู่ใน repo ต้องลงท้ายด้วย .import.sql (เช่น import/xxx.import.sql) หรือใช้ path นอก repo');
  }
  if (fs.existsSync(outFile) && !force) throw new Error('ไฟล์ --out มีอยู่แล้ว (ใช้ --force เพื่อเขียนทับ)');
}

/**
 * @param {{inDir:string, outFile?:string, only?:string[], replace?:boolean, force?:boolean, forceChangePassword?:boolean}} opts
 * @returns {Promise<{sql:string, report:object[], users:object, counters:object[]}>}
 */
export async function runImport({ inDir, outFile, only, replace = false, force = false, forceChangePassword = false, fileRefs = true } = {}) {
  const docsForRefs = { prs: [], pos: [], items: new Map() }; // rows written, for the file_refs backfill below
  if (!inDir || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory()) {
    throw new Error(`ไม่พบโฟลเดอร์อินพุต: ${inDir}`);
  }
  if (outFile) validateOut(outFile, inDir, force);
  const wanted = only && only.length ? new Set(only.map((x) => x.toLowerCase())) : null;
  const lines = [
    '-- สร้างโดย scripts/import-sheets-to-d1.js ; ใช้กับ D1 ว่างตอนตัดระบบ (migrations 0001-0006)',
    '-- ไม่มีรหัสผ่าน plaintext ในไฟล์นี้ ; ไฟล์นี้มีข้อมูลบุคคล/ธุรกิจ ห้าม commit และให้ลบหลังใช้งาน',
    replace
      ? '-- !!! โหมด --replace : INSERT OR REPLACE จะทับแถวเดิมและลบแถวที่ชน UNIQUE เงียบ ๆ !!!'
      : '-- โหมดปกติ : INSERT ธรรมดา (ชน PRIMARY KEY/UNIQUE = ล้มเหลว ไม่ทับข้อมูลเดิม)',
  ];
  const report = [];
  const userStats = { hashed: 0, noHashEmpty: 0, noHashDefault: 0, noHashTooLong: 0, forceChange: forceChangePassword };
  const counters = new Map();

  // PRItems ล่วงหน้า ใช้เติม prs.items เมื่อชีต PRs ไม่มี items
  const prItemsByPr = new Map();
  const prItemsSheet = loadSheet(inDir, 'PRItems');
  if (prItemsSheet) {
    for (const r of prItemsSheet.rows) {
      const key = String(r.prId || r.prNo || '').trim();
      if (!key) continue;
      const it = {};
      for (const [k, v] of Object.entries(r)) {
        if (isBlank(v) || k === 'prId' || k === 'prNo') continue;
        it[k] = ['qty', 'price', 'totalPrice', 'conversionRate'].includes(k) ? (num(v) ?? v) : parseMaybeJson(v);
      }
      if (!prItemsByPr.has(key)) prItemsByPr.set(key, []);
      prItemsByPr.get(key).push(it);
      const alt = String(r.prNo || '').trim();
      if (alt && alt !== key) {
        if (!prItemsByPr.has(alt)) prItemsByPr.set(alt, []);
        prItemsByPr.get(alt).push(it);
      }
    }
  }
  const ctx = { prItemsByPr };

  for (const sheet of SHEETS) {
    if (wanted && !wanted.has(sheet.toLowerCase())) continue;
    const data = loadSheet(inDir, sheet);
    if (!data) { report.push({ sheet, file: null, read: 0, written: 0, skipped: 0, reasons: {}, note: 'ไม่พบไฟล์ (ข้าม)' }); continue; }
    const rep = { sheet, file: data.file, read: data.rows.length, written: 0, skipped: 0, reasons: {}, warnings: 0 };
    const skip = (why) => { rep.skipped++; rep.reasons[why] = (rep.reasons[why] || 0) + 1; };

    if (sheet === 'PRCounters') {
      for (const r of data.rows) {
        // GAS: Number(r.year || currentYear) -> ปีว่าง = ปีปัจจุบัน
        const dept = nz(r.dept), type = nz(r.docType), year = num(r.year, new Date().getFullYear()), last = num(r.lastNumber);
        if (!dept || !type || year === null || last === null) { skip('ขาด dept/docType/year/lastNumber'); continue; }
        bump(counters, dept.toUpperCase(), type.toUpperCase(), year, last, nz(r.prefix) || type.toUpperCase());
        rep.written++; // นับเป็นอินพุตที่ใช้รวมเข้าตัวนับ
      }
      rep.note = 'รวมเข้า doc_counters (เลือกค่าสูงสุดร่วมกับเลขเอกสาร)';
      report.push(rep);
      continue;
    }

    const seenIds = new Set();
    const uniq = new Map(); // `${table}.${col}=${value}` -> id ที่ถือ key นี้ (กัน INSERT OR REPLACE ลบแถวอื่นเงียบ ๆ)
    for (const row of data.rows) {
      // เลขเอกสารของแถวที่ถูกข้ามก็เคยถูกใช้ไปแล้วในระบบเดิม -> นับเข้า counter เสมอ
      if (sheet === 'PRs' || sheet === 'POs') {
        const c = counterFromDocNo(nz(sheet === 'PRs' ? row.prNo : row.poNo));
        if (c) bump(counters, c.dept, c.docType, c.year, c.n, c.docType);
      }
      const res = sheet === 'Users' ? await mapUser(row, userStats) : MAPPERS[sheet](row, ctx);
      if (res.skip) { skip(res.skip); continue; }
      const idKey = res.cols.id ?? res.cols.roleId ?? res.cols.key;
      if (idKey !== undefined && seenIds.has(idKey)) {
        // โหมดปกติ : เก็บแถวแรก ข้ามแถวหลัง (ไม่ทับ) ; โหมด --replace คงพฤติกรรมเดิม (แถวหลังทับ)
        if (!replace) { skip('id ซ้ำ ข้ามแถวหลัง'); continue; }
        rep.reasons['id ซ้ำ (แถวหลังทับแถวก่อน)'] = (rep.reasons['id ซ้ำ (แถวหลังทับแถวก่อน)'] || 0) + 1;
      }
      const uniqueCols = UNIQUE_COLS[res.table] || [];
      const clash = uniqueCols.find((col) => {
        const v = res.cols[col];
        if (v === null || v === undefined || v === '') return false;
        const holder = uniq.get(`${col}=${v}`);
        return holder !== undefined && holder !== res.cols.id;
      });
      if (clash) {
        skip(`UNIQUE ชน: ${res.table}.${clash} ซ้ำกับแถวอื่น (ไม่เขียนทับ)`);
        (rep.conflicts ||= []).push({ table: res.table, column: clash, value: sheet === 'Users' ? '(redacted)' : String(res.cols[clash]), id: res.cols.id });
        continue;
      }
      for (const col of uniqueCols) {
        const v = res.cols[col];
        if (v !== null && v !== undefined && v !== '') uniq.set(`${col}=${v}`, res.cols.id);
      }
      if (res.warn) { rep.warnings++; rep.reasons[`คำเตือน: ${res.warn}`] = (rep.reasons[`คำเตือน: ${res.warn}`] || 0) + 1; }
      if (idKey !== undefined) seenIds.add(idKey);
      lines.push(insertSql(res.table, res.cols, replace));
      if (res.table === 'prs') docsForRefs.prs.push(res.cols);
      else if (res.table === 'pos') docsForRefs.pos.push(res.cols);
      else if (res.table === 'pr_items') (docsForRefs.items.get(res.cols.prId) || docsForRefs.items.set(res.cols.prId, []).get(res.cols.prId)).push(res.cols);
      rep.written++;
    }
    report.push(rep);
  }

  // file_refs backfill (migration 0011) : which imported PR / PO really HOLDS which Drive file, computed with the same rule the API uses
  // (filerefs.docFileIds = sanitize.fileIdsIn positions), so imported documents are found by the index and the server never has to table-scan for them.
  // Needs migration 0011 on the target ; --no-file-refs leaves it out (the server then finds them by its bounded scan and indexes them lazily).
  if (fileRefs) {
    let refCount = 0;
    const pushRefs = (table, cols, itemRows) => {
      const no = table === 'prs' ? cols.prNumber : cols.poNumber;
      for (const fid of [...docFileIds(table, cols, itemRows)].slice(0, MAX_REFS_PER_DOC)) {
        lines.push(`INSERT OR IGNORE INTO file_refs (fileId, docTable, docId, docNo) VALUES (${sqlLit(fid)}, ${sqlLit(table)}, ${sqlLit(cols.id)}, ${sqlLit(no ?? null)});`);
        refCount++;
      }
    };
    for (const c of docsForRefs.prs) pushRefs('prs', c, docsForRefs.items.get(c.id) || []);
    for (const c of docsForRefs.pos) pushRefs('pos', c, []);
    if (refCount) report.push({ sheet: 'file_refs (คำนวณ)', file: null, read: refCount, written: refCount, skipped: 0, reasons: {}, note: 'ต้องมี migration 0011 บน D1 ปลายทาง' });
  }

  const counterRows = [...counters.values()];
  const nowIso = new Date().toISOString();
  for (const c of counterRows) {
    lines.push(counterSql(c, nowIso));
  }
  if (counterRows.length) report.push({ sheet: 'doc_counters (คำนวณ)', file: null, read: counterRows.length, written: counterRows.length, skipped: 0, reasons: {} });

  const sql = lines.join('\n') + '\n';
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, sql, 'utf8');
  }
  return { sql, report, users: userStats, counters: counterRows };
}

export function formatReport({ report, users }) {
  const out = ['ชีต | อ่าน | เขียน | ข้าม | หมายเหตุ/เหตุผล'];
  for (const r of report) {
    const why = Object.entries(r.reasons || {}).map(([k, v]) => `${k} x${v}`).join('; ');
    out.push(`${r.sheet} | ${r.read} | ${r.written} | ${r.skipped} | ${[r.note, why].filter(Boolean).join(' ; ')}`);
    for (const c of r.conflicts || []) out.push(`    conflict: ${c.table}.${c.column} = ${c.value} (id ${c.id})`);
  }
  const noHash = users.noHashEmpty + users.noHashDefault + users.noHashTooLong;
  out.push('');
  out.push(`users: hash แล้ว ${users.hashed} ; ไม่ตั้ง hash ${noHash} (รหัสว่าง ${users.noHashEmpty}, รหัส default ${users.noHashDefault}, ยาวเกิน ${users.noHashTooLong})`);
  if (noHash) out.push('  -> ผู้ใช้กลุ่มนี้ mustChangePassword = 1 ต้องให้แอดมินตั้งรหัสใหม่ก่อนเข้าระบบ');
  return out.join('\n');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--in') a.inDir = argv[++i];
    else if (t === '--out') a.outFile = argv[++i];
    else if (t === '--only') a.only = String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (t === '--replace') a.replace = true;
    else if (t === '--force') a.force = true;
    else if (t === '--force-change-password') a.forceChangePassword = true;
    else if (t === '--no-file-refs') a.fileRefs = false;
    else if (t === '-h' || t === '--help') a.help = true;
    else throw new Error(`อาร์กิวเมนต์ไม่รู้จัก: ${t}`);
  }
  return a;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.inDir) {
      console.log('usage: node scripts/import-sheets-to-d1.js --in <โฟลเดอร์ CSV/JSON> [--out <ไฟล์.sql>] [--only Users,PRs] [--replace] [--force] [--force-change-password] [--no-file-refs]');
      process.exit(args.help ? 0 : 1);
    }
    if (!args.outFile) args.outFile = DEFAULT_OUT;
    if (args.replace) console.warn('คำเตือน: --replace ใช้ INSERT OR REPLACE ซึ่งทับแถวเดิมและลบแถวที่ชน UNIQUE เงียบ ๆ ; ใช้กับ D1 ว่างเท่านั้น');
    const result = await runImport(args);
    console.log(formatReport(result));
    console.log(`\nเขียนไฟล์: ${path.resolve(args.outFile)}`);
  } catch (e) {
    console.error('ผิดพลาด:', e.message);
    process.exit(1);
  }
}
