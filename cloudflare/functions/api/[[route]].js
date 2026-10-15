// Cloudflare Pages Functions - Native D1 REST API for PRPO
// Mounted automatically at /api/* by Cloudflare Pages

import { hashPassword, verifyPassword, PASSWORD_ITERATIONS, MAX_PASSWORD_LENGTH } from '../_lib/password.js';
import { sanitizeUser, signToken, verifyTokenDetailed, getBearerToken, hasSecret } from '../_lib/auth.js';
import { buildCorsHeaders } from '../_lib/cors.js';
import { authorize, canWriteBudget, resolvePermissions, canAdjustBudget, canTransitionPR, canTransitionPO, PO_CLIENT_STATUSES, PO_PRE_ORDER, normalizePoStatus, canAccessDepartment, clientCanAccessDepartmentData, clientViewOfUser, canEditPrContent, normalizeUser, normalizeDeptCode, ledgerDeptCode, isWildcardDept } from '../_lib/rbac.js';
import { issueDocNumber, issueGrnNumber, bangkokYear, bangkokMonth } from '../_lib/docnum.js';
import { classifyUnhandled } from '../_lib/routes.js';
import { handleExtraRoutes, listNotificationsFor } from '../_lib/extra.js';
import { utcIsoRow, utcIsoRows } from '../_lib/timefmt.js';
import { productView, productViews } from '../_lib/products.js';
import { stockLogViews } from '../_lib/stocklogs.js';
import { handleUpload, checkBodyShape } from '../_lib/upload.js';
import { handleFileDownload } from '../_lib/files.js';
import { handleCleanupOrphans, handleRestoreOrphan } from '../_lib/orphans.js';
import { handleUnsharePublic } from '../_lib/unshare.js';
import { reindexTouched, markDocGone } from '../_lib/filerefs.js';
import { sanitizeWriteBody, checkUserSignature, sanitizeUrlField } from '../_lib/sanitize.js';
import { notificationStmts, prNotificationParams, poSaveNotificationParams, poReceiveNotificationParams } from '../_lib/notify.js';
import { readBodyLimited, rebuildRequest } from '../_lib/body.js';
import { buildViewer, filterDocuments, filterStockLogs, filterBudgetRows, filterLedger, stripOtherEmails } from '../_lib/scope.js';

// JSON write size caps (Content-Length checked before the body is read). Documents carry small inline images (<=150 KB each) and one
// D1 row is limited to 2 MB anyway ; everything else is small. /api/upload has its own, larger limit (upload.js).
const DOC_WRITE_MAX_BYTES = 4 * 1024 * 1024;
const JSON_WRITE_MAX_BYTES = 2 * 1024 * 1024;
// stock log view : a GRN row written before grnNumber was filled (empty grnNumber, docNo = the GRN) shows docNo as grnNumber (GAS keeps grnNumber = documentNo) ; stored data is not changed
function withGrnNumber(rows) {
  return (rows || []).map((r) => (r && !r.grnNumber && /^GRN?-/i.test(String(r.docNo || '')) ? { ...r, grnNumber: r.docNo } : r));
}
// cost per stock unit used on an issue / adjustment log : avgCost (MAC) -> latest IN price fail-safe (what the screens show) -> standard price
async function serverIssueUnitCost(db, prod) {
  // the latest-IN fail-safe applies whatever the balance is (the screen does the same) : view the row as if it held stock
  const v = (await productViews(db, [{ ...prod, currentStock: Math.max(Number(prod.currentStock) || 0, 1) }]).catch(() => []))[0];
  return Number((v && v.avgCost) || prod.avgCost || prod.standardPrice || 0);
}
const DOC_WRITE_RE =/^\/api\/(prs?|pos?|products|receive-goods|receive|grn|inventory|stock-logs|budget-transactions)(\/|$)/;

const LOGIN_MAX_FAILS = 5;       // per user (per resolved userId)
const LOGIN_MAX_FAILS_IP = 30;   // per IP (shared NAT / office networks)
// Known default plaintext passwords are never accepted/migrated by the lazy upgrade
const REJECTED_LEGACY_PASSWORDS = new Set(['123456', 'password123', 'admin123']);
const MIN_NEW_PASSWORD_LENGTH = 6; // shortest password POST/PUT /api/users accepts
// the only calls a token of an account with mustChangePassword = 1 may make
const MUST_CHANGE_ALLOWED = [['POST', '/api/me/password'], ['GET', '/api/me'], ['POST', '/api/logout']];
const LOGIN_WINDOW_MS =15 * 60 * 1000;
const LOGIN_FAIL_MSG = 'ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง';
const LOGIN_LOCK_MSG = 'พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่';

// ฟิลด์สถานะใช้งาน (migration 0006): คืน {status, isActive} ; ไม่ส่งมา = null (คงค่าเดิมผ่าน COALESCE)
function activeFields(src) {
  let s = src && src.status !== undefined && src.status !== null && src.status !== '' ? String(src.status).toUpperCase() : null;
  let a = null;
  if (src && src.isActive !== undefined && src.isActive !== null && src.isActive !== '') {
    a = (src.isActive === false || src.isActive === 0 || String(src.isActive).toLowerCase() === 'false' || src.isActive === '0') ? 0 : 1;
  } else if (s) {
    a = s === 'INACTIVE' ? 0 : 1;
  }
  // isActive sent without status -> keep status consistent with it
  if (s === null && a !== null) s = a === 0 ? 'INACTIVE' : 'ACTIVE';
  return { status: s, isActive: a };
}
// PR_COMMITMENT is written ONLY by the server, when a REVIEWED PR becomes APPROVED / PO_ISSUED / IN_PROGRESS_ONLINE, from the PR's own total.
// (The client still POSTs its own PR_COMMITMENT row on approval ; that POST is acknowledged but never written.) transactionId uses the
// client's idempotency-key format so a client that merges the server ledger de-duplicates it.
const PR_APPROVED_TO = ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE'];
async function writePrCommitment(db, prId, actorName, actorRole) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date, docType, docNo, transactionId, actorRole)
    SELECT ?, department, department, 'PR_COMMITMENT', 'PR_COMMITMENT', 'ผูกพันงบประมาณ (PR อนุมัติ)', -totalAmount, -totalAmount, 0, 0, 0, ?, ?, '', '', ?, ?, 'PR', prNumber, 'TXN-' || prNumber || '-PR_COMMITMENT', ?
    FROM prs
    WHERE id = ? AND totalAmount > 0
      AND NOT EXISTS (SELECT 1 FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT' AND docNo = prs.prNumber)
    ON CONFLICT(id) DO NOTHING
  `).bind(`TX-PRC-${prId}`, actorName || 'System', 'กันเงินผูกพันอนุมัติ PR', now, now, actorRole || null, prId).run().catch((e) => {
    console.error('[pr] commitment write failed:', e && e.message);
  });
}
// items / total comparison for the PR content lock (fingerprint = product, qty, price ; tolerant of extra client-only fields)
function itemFingerprint(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((i) => `${i && (i.productId || i.id || i.code || i.name) || ''}|${Number(i && (i.purchaseQty ?? i.qty ?? i.quantity ?? 1)) || 0}|${Number(i && i.price) || 0}`).join(';');
}
function prContentChanged(curRow, body) {
  const hasTotal = (body.totalAmount !== undefined && body.totalAmount !== null) || (body.total !== undefined && body.total !== null);
  if (hasTotal && Math.abs(Number(body.totalAmount ?? body.total) - Number(curRow.totalAmount || 0)) > 0.005) return true;
  if (Array.isArray(body.items)) {
    let old = [];
    try { old = JSON.parse(curRow.itemsJson || '[]'); } catch { old = []; }
    if (itemFingerprint(body.items) !== itemFingerprint(old)) return true;
  }
  return false;
}
// A PR whose content is frozen for this caller (approved / PO issued / ... , see canEditPrContent) keeps the qty / price / conversion of its stored lines
// whatever the body says (the fingerprint above only sees purchaseQty|qty|quantity + price) : the figures of the stored lines are copied over the body's, by
// position ; adding, removing or re-ordering a line is refused. -> { items } | { error: true }. Other fields of a line (store, notes, flags ...) stay as sent.
const PR_FROZEN_LINE_KEYS = ['qty', 'purchaseQty', 'orderedQty', 'quantity', 'price', 'unitPrice', 'estimatedPrice', 'conversionRate', 'conversionRatio'];
function freezePrItems(storedItemsJson, clientItems) {
  let base = [];
  try { base = JSON.parse(storedItemsJson || '[]'); } catch { base = []; }
  if (!Array.isArray(base) || !Array.isArray(clientItems)) return { items: clientItems };
  if (clientItems.length !== base.length) return { error: true };
  const items = clientItems.map((it, i) => {
    const s = base[i];
    if (!it || typeof it !== 'object' || !s || typeof s !== 'object') return it;
    const kb = String(s.productId || s.id || s.code || ''); const kc = String(it.productId || it.id || it.code || '');
    if (kb && kc !== kb) return null;
    const out = { ...it };
    for (const k of PR_FROZEN_LINE_KEYS) { if (k in s) out[k] = s[k]; else delete out[k]; }
    return out;
  });
  return items.some((x) => x === null) ? { error: true } : { items };
}
// Pairing of PO lines with PR rows when the same product is on several rows (other rate : box x12 + piece x1) : the n-th line of a product takes the n-th
// still-free row of it ; a line that carries a rate prefers the free row with that rate (a split PO may hold only the second row). -> index into prItems, -1 = none
const prLineKey = (it) => String((it && (it.productId || it.code || it.id)) || '');
const prRateOf = (x) => { for (const k of ['conversionRate', 'conversionRatio']) { const n = Number(x && x[k]); if (Number.isFinite(n) && n > 0) return n; } return 0; };
// (fits / onPick : optional - a new PO prefers a free row that still has room for the line, and reports its pick so the next line sees the room taken)
function pickPrRows(prItems, lines, fits, onPick) {
  const claimed = new Set();
  return lines.map((line) => {
    if (!line || typeof line !== 'object') return -1;
    const cands = [];
    prItems.forEach((x, i) => { if ((line.productId && x.productId === line.productId) || (!line.productId && ((line.code && x.code === line.code) || (line.id && x.id === line.id)))) cands.push(i); });
    if (!cands.length) return -1;
    let free = cands.filter((i) => !claimed.has(i));
    if (fits) { const room = free.filter((i) => fits(i, line)); if (room.length) free = room; }
    const lineRate = prRateOf(line);
    const byRate = lineRate ? free.find((i) => prRateOf(prItems[i]) === lineRate) : undefined;
    const pick = byRate !== undefined ? byRate : (free.length ? free[0] : cands[cands.length - 1]);
    claimed.add(pick);
    if (onPick) onPick(pick, line);
    return pick;
  });
}
// unguessable, collision-free suffix for every id the server makes (Math.random is not collision-safe nor unpredictable)
function uid() {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
// A PO that is CLOSED / CANCELLED keeps its amounts : the client never edits totalAmount / vatAmount / grandTotal after closing
// (settlement writes actualTotalAmount + item actual prices, claims write refund fields). Admin may still correct data.
function poAmountsFrozenAndChanged(authUser, curRow, body) {
  if (!['CLOSED', 'CANCELLED'].includes(String(curRow.status || '').trim().toUpperCase())) return false;
  if (normalizeUser(authUser).isAdmin) return false;
  const differs = (sent, stored) => sent !== undefined && sent !== null && sent !== '' && Math.abs(Number(sent) - Number(stored || 0)) > 0.005;
  return differs(body.grandTotal, curRow.grandTotal)
    || differs(body.totalAmount ?? body.total, curRow.totalAmount)
    || differs(body.vatAmount, curRow.vatAmount);
}
// canonical codes of the active rows in `departments` ; null when the table cannot be read ; empty set = no master data yet (no check)
async function knownDepartmentCodes(db) {
  try {
    const res = await db.prepare('SELECT code, id FROM departments WHERE isActive = 1').all();
    const set = new Set();
    for (const r of (res && res.results) || []) {
      if (r.code) set.add(normalizeDeptCode(r.code));
      if (r.id) set.add(normalizeDeptCode(r.id));
    }
    return set;
  } catch {
    return null;
  }
}
async function lookupStatus(db, sql, ...binds) {
  try { return (await db.prepare(sql).bind(...binds).first()) || null; } catch { return null; }
}
function finiteOr0(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}
function optNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Ledger row the SERVER writes for a claim refund credited through PUT /api/budgets/:dept. type BUDGET_ROLLBACK (what the client's own row has,
// so ledger screens treat it as a refund) but actionType CLAIM_CREDIT : the settle cap (POST /pos/:id/settle) only counts actionType
// 'REFUND_SETTLEMENT' and PR_COMMITMENT rows, so these rows neither use up nor extend that cap (no new ceiling is introduced here).
// The client's own row for the same refund (actionType REFUND_SETTLEMENT) is acknowledged by POST /api/budget-transactions and not stored.
// guardUsed: number -> insert only while budgets.totalUsed is still exactly that figure ; null -> unconditional. RETURNING id tells the caller if it was inserted.
// the client's reference to the PO is attached later, when its own REFUND_SETTLEMENT row is acknowledged (the PUT body carries no PO number).
function budgetSpentOf(b) {
  return b.spent ?? b.actualExpense ?? b.budgetSpent;
}

// docNo / transactionId : the PO and the client's idempotency key when the PUT body carries them (T4.6) ; gate : the resolveRefundPo context -> the
// per-PO / per-PR cap is re-checked inside this very INSERT (refundCapGuard).
function claimCreditLedgerStmt(db, { code, credit, prevUsed, actor, actorUserId, role, guardUsed, docNo, transactionId, gate, id }) {
  const guarded = guardUsed !== null && guardUsed !== undefined;
  const nowIso = new Date().toISOString();
  const month = bangkokMonth();
  const note = 'คืนงบประมาณจากการเคลม/ปิดงาน';
  const cap = gate ? refundCapGuard(credit, gate) : { sql: '', binds: [] };
  return db.prepare(`
    INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date, docType, actorRole, refundAmount, creditAmount, actorUserId, docNo, poNumber, transactionId)
    SELECT ?, ?, ?, 'BUDGET_ROLLBACK', 'CLAIM_CREDIT', 'คืนงบประมาณ (Refund)', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE 1 ${guarded ? 'AND (SELECT totalUsed FROM budgets WHERE id = ?) = ?' : ''} ${cap.sql}
    ON CONFLICT(id) DO NOTHING
    RETURNING id
  `).bind(
    id || `TX-CC-${Date.now()}-${uid()}`, code, code,
    credit, credit, prevUsed, Math.max(0, Math.round((prevUsed - credit) * 100) / 100),
    actor || 'System', note, month, month, nowIso, nowIso, docNo ? 'PO' : null, role || null, credit, credit, actorUserId || null, docNo || null, docNo || null, transactionId || null,
    ...(guarded ? [code, guardUsed] : []), ...cap.binds
  );
}

// Refund cap shared by every route that gives budget back to a department (T4.6) : settle, PUT /api/budgets/:dept (claim credit),
// POST /api/budgets/adjust TOP_UP / BUDGET_ROLLBACK by users without the budget permission.
//   returned(PO) = sum of the ledger rows that give budget back for that PO (type BUDGET_ROLLBACK or TOP_UP carrying the PO number :
//                  REFUND_SETTLEMENT from settle, CLAIM_CREDIT from the claim credit, the adjust rows)
//   cap(PO)      = min( PR_COMMITMENT of the PR - returned(all POs of the PR) , approvedTotal of the PO - returned(PO) )
// The same test in SQL (re-checked inside the INSERT, so concurrent refunds cannot jointly exceed it).
// Department gate for master-data writes (products / vendors / storage_locations), the same rule the client applies before saving
// (MasterDataView -> canAccessDepartmentData ; here canAccessDepartment, which also lets admin / online purchaser through) :
// every department the write names must be reachable, and so must the department of the row it overwrites.
// A product `category` is looked at when it is a real department code (it can also be a free label) : with a populated departments table it must be one
// of them ; with an empty / unreadable one (fresh install) anything that LOOKS like a code (2-5 capital letters) is checked too, i.e. it fails closed.
const MASTER_TABLES = { products: { code: true }, vendors: { code: true }, storage_locations: { code: false } };

// The row a PUT / DELETE will really change, resolved the way the handlers do it (path id/code first, then the body's) and returned with its id,
// so the department check and the UPDATE / DELETE act on ONE row (WHERE id = row.id), never "check one row, change several".
async function resolveMasterRow(db, table, { subId, id, code }) {
  const withCode = MASTER_TABLES[table].code;
  const q = withCode ? `SELECT id, department FROM ${table} WHERE id = ? OR UPPER(code) = UPPER(?) ORDER BY (id = ?) DESC, COALESCE(isDeleted,0) ASC, id LIMIT 1` : `SELECT id, department FROM ${table} WHERE id = ? LIMIT 1`;
  const run = (a, b) => db.prepare(q).bind(...(withCode ? [a, b, a] : [a])).first().catch(() => null);
  let row = null;
  if (subId) row = await run(subId, subId);
  if (!row && (id || code)) row = await run(id || '', code || '');
  return row;
}

// -> null (allowed) | 'deny' (403) | 'mismatch' (400 : the body names another record than the URL)
// opts.upsertById : the handler writes `INSERT … ON CONFLICT(id)` (vendors POST) - the row it changes is the row with that id, so that is the
// row checked ; a new id whose code is already used by ANOTHER row is a 409 (instead of a UNIQUE error / a check on the wrong row).
// Every key used here (id / code fields, in this order) is the key the handler writes with.
async function masterWriteVerdict(db, authUser, table, items, subId, opts = {}) {
  if (!MASTER_TABLES[table]) return 'deny';
  const known = await knownDepartmentCodes(db);
  const reach = (d) => canAccessDepartment(authUser, normalizeDeptCode(d));
  for (const p of items) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'bad'; // null / number / string / nested array row : 400, never a TypeError (500)
    if (subId && p.id && p.id !== subId) {
      const byPath = await resolveMasterRow(db, table, { subId });
      if (!byPath || byPath.id !== p.id) return 'mismatch'; // PUT /x with another id in the body
    }
    const named = [p.department];
    // The department that is written (and that the client checks, MasterDataView) is `department || category`. So the category is looked at ONLY when
    // there is no department - then it is the department, and it must be reachable (a free label is simply an unreachable department for a normal user ;
    // with an empty departments table this is the fail-closed case). With a department present the category is just a label.
    if (table === 'products' && !p.department && p.category) named.push(String(p.category).trim());
    for (const d of named) if (d && !reach(d)) return 'deny';
    const id = p.id || '';
    const code = !MASTER_TABLES[table].code ? '' : (table === 'vendors' ? (p.code || p.vendorCode || id || subId || '') : (p.code || p.itemCode || id || subId || ''));
    let ex;
    if (opts.upsertById) {
      ex = id ? await db.prepare(`SELECT id, department FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first().catch(() => null) : null;
      if (code) {
        // the code (UNIQUE) must not belong to a different row than the one this id writes
        const clash = await db.prepare(`SELECT id FROM ${table} WHERE UPPER(code) = UPPER(?) LIMIT 1`).bind(code).first().catch(() => null);
        if (clash && clash.id !== id) return 'conflict';
      }
    } else {
      ex = await resolveMasterRow(db, table, { subId, id: id || subId || '', code });
    }
    if (ex && ex.department && !reach(ex.department)) return 'deny';
    if (!ex && !named.some(Boolean) && table !== 'vendors' && !reach('PD')) return 'deny'; // a new row without a department is stored under PD
  }
  return null;
}
// Products write gate. The bulk stock-sync route (/api/products/batch : InventoryContext, warehouseService, AppContext, MasterDataView) is sent with the
// product list of EVERY department, so there the rows the user may not touch are skipped silently (never written, never an error ; their ids are
// returned as `skipped`) and the rest is written. Every other products route stays all-or-nothing (403 / 400).
// the product rows of a request body : an array, { products: [...] } or a single object (anything else becomes a row that fails validation -> 400)
// code / itemCode are trimmed here so the gate, the lookup of the existing row and the INSERT all see the same key ("ABC " must find "ABC")
const trimCodes = (p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const needs = (typeof p.code === 'string' && p.code !== p.code.trim()) || (typeof p.itemCode === 'string' && p.itemCode !== p.itemCode.trim());
  if (!needs) return p;
  const q = { ...p };
  if (typeof q.code === 'string') q.code = q.code.trim();
  if (typeof q.itemCode === 'string') q.itemCode = q.itemCode.trim();
  return q;
};
const productRows = (body) => (Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray(body.products) ? body.products : [body])).map(trimCodes);
// Opening balance of a NEW product row (existing rows never take stock from the body). { value: null } = not sent, { value } = finite >= 0 rounded to 4 dp
// and <= STOCK_QTY_MAX (same bounds as /api/stock/*), { error } = refused.
function parseOpeningStock(p) {
  const raw = p.stockBalance !== undefined && p.stockBalance !== null && p.stockBalance !== '' ? p.stockBalance : p.currentStock;
  if (raw === undefined || raw === null || raw === '') return { value: null };
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw)) n = Number(raw);
  else return { error: 'ยอดตั้งต้นต้องเป็นตัวเลข' };
  if (!Number.isFinite(n) || n < 0) return { error: 'ยอดตั้งต้นต้องไม่ติดลบ' };
  const v = round4(n);
  if (v > STOCK_QTY_MAX) return { error: 'ยอดตั้งต้นมากเกินไป' };
  return { value: v };
}
// INSERT of a new product + (opening > 0) its PRODUCT_CREATE audit row in ONE db.batch ; actor comes from the token
async function insertProductWithAudit(db, authUser, insertStmt, id, code, opening) {
  if (!(opening > 0)) { await insertStmt.run(); return; }
  const aud = db.prepare('INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`AUD-${Date.now()}-${uid()}`, 'PRODUCT_CREATE', 'product', String(id), authUser.userId,
      JSON.stringify({ roleKey: authUser.roleKey, actorName: authUser.name || authUser.username || 'System User', code, openingStock: opening }), new Date().toISOString());
  if (typeof db.batch === 'function') await db.batch([insertStmt, aud]); else { await insertStmt.run(); await aud.run(); }
}
async function gateProducts(db, authUser, path, list, subId) {
  if (path !== '/api/products/batch') {
    const verdict = await masterWriteVerdict(db, authUser, 'products', list, subId);
    return { verdict, items: list, skipped: [] };
  }
  const items = [];
  const skipped = [];
  for (const p of list) {
    const v = await masterWriteVerdict(db, authUser, 'products', [p], null);
    if (v === 'bad') return { verdict: 'bad', items: [], skipped: [] }; // a malformed row is a client bug, not a department matter : the request is 400
    // a skipped row is only REPORTED when it really differs from the DB (the client re-sends every department on each sync ; unchanged rows skip silently)
    if (v) { if (await productRowDiffers(db, p)) skipped.push((p && (p.id || p.code || p.itemCode)) || null); } else items.push(p);
  }
  return { verdict: null, items, skipped };
}
// response of a single-product POST / PUT : what the client sent, overlaid with the row as stored (UI + D1 field names, D-2)
async function savedProductView(db, sent, subId) {
  const key = sent.id || subId || '';
  const code = sent.code || sent.itemCode || key;
  const row = (key || code) ? await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) ORDER BY (id = ?) DESC LIMIT 1').bind(key, code, key).first().catch(() => null) : null;
  if (!row) return sent;
  const [view] = await productViews(db, [row]);
  return { ...sent, ...view };
}
// Product Remark (migration 0017) : one text per product + who / when. Written ONLY by the single-product POST / PUT (department gate already passed),
// never by the bulk /batch sync (it re-sends every department with possibly stale copies). Author + time come from the token, never the body.
const PRODUCT_REMARK_MAX = 2000;
const productRemarkTooLong = (list) => list.some((p) => p && typeof p === 'object' && typeof p.remark === 'string' && p.remark.trim().length > PRODUCT_REMARK_MAX);
// rowId = the id of the row the department gate checked and the main UPDATE / INSERT wrote (existing.id or the inserted id) - never looked up again by code
async function applyProductRemark(db, authUser, path, p, rowId) {
  if (path === '/api/products/batch' || !p || typeof p !== 'object' || !('remark' in p) || !rowId) return;
  const next = p.remark == null ? '' : String(p.remark).trim().slice(0, PRODUCT_REMARK_MAX);
  const row = await db.prepare('SELECT id, remark FROM products WHERE id = ?').bind(rowId).first();
  if (!row || String(row.remark ?? '') === next) return; // unchanged -> keep the original author / time
  const who = authUser.name || authUser.username || 'System User';
  const title = authUser.title || authUser.department || '';
  const upd = db.prepare('UPDATE products SET remark = ?, remarkUpdatedAt = ?, remarkUpdatedBy = ? WHERE id = ?')
    .bind(next, new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), title ? `${who} (${title})` : who, row.id);
  const aud = db.prepare('INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`AUD-${Date.now()}-${uid()}`, 'PRODUCT_REMARK_SET', 'product', String(row.id), authUser.userId,
      JSON.stringify({ roleKey: authUser.roleKey, actorName: who, from: String(row.remark ?? ''), to: next }), new Date().toISOString());
  if (typeof db.batch === 'function') await db.batch([upd, aud]); else { await upd.run(); await aud.run(); }
}
// the master fields of a product row with the defaults the products POST / PUT handlers apply when they write it
function productMasterFields(p) {
  const id = p.id || '';
  const cat = p.category || p.department || 'PD';
  const purchaseUnit = p.purchaseUnit || p.unit || 'ชิ้น';
  return {
    name: p.name || p.itemName || '',
    cat,
    purchaseUnit,
    usageUnit: p.stockUnit || p.usageUnit || purchaseUnit,
    convRate: Number(p.conversionRate || 1),
    minStock: Number(p.reorderPoint ?? p.minStock ?? 0) || 0,
    price: (p.price ?? p.standardPrice) !== undefined && (p.price ?? p.standardPrice) !== null ? Number(p.price ?? p.standardPrice) : null,
    locId: ('locationId' in p ? p.locationId : p.defaultLocationId) || '',
    dept: p.department || cat,
    leadTimeDays: optNum(p.leadTimeDays) ?? null,
    id
  };
}
// true when the incoming product row would change something stored (or does not exist yet). Only fields the client sent are compared.
async function productRowDiffers(db, p) {
  if (!p || typeof p !== 'object') return true;
  const id = p.id || '';
  const code = p.code || p.itemCode || id;
  // the very row the department gate looked at (resolveMasterRow), then its full record
  const hit = (id || code) ? await resolveMasterRow(db, 'products', { subId: null, id, code }) : null;
  const ex = hit ? await db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1').bind(hit.id).first().catch(() => null) : null;
  if (!ex) return true;
  // MASTER fields only, normalised exactly like the products POST / PUT handlers write them (same defaults). currentStock / avgCost / totalValue are
  // server-managed (receive / issue / adjust move them) : a stale client copy of those must not raise a warning, so they are not compared.
  const m = productMasterFields(p);
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const sameNum = (a, b) => Number(a ?? 0) === Number(b ?? 0);
  if (!same(m.name, ex.name) || !same(m.cat, ex.category) || !same(m.dept, ex.department)
    || !same(m.purchaseUnit, ex.purchaseUnit) || !same(m.usageUnit, ex.usageUnit) || !same(m.locId, ex.defaultLocationId)
    || !sameNum(m.convRate, ex.conversionRate) || !sameNum(m.minStock, ex.minStock)) return true;
  if (m.price !== null && !sameNum(m.price, ex.standardPrice)) return true;
  if (m.leadTimeDays !== null && !sameNum(m.leadTimeDays, ex.leadTimeDays)) return true;
  if (p.locationName != null && !same(p.locationName, ex.locationName)) return true;
  const af = activeFields(p);
  if (af.status != null && String(af.status) !== String(ex.status ?? '')) return true;
  if (af.isActive != null && Number(af.isActive) !== Number(ex.isActive ?? 1)) return true;
  if (Number(ex.isDeleted) === 1) return true; // a write would undelete it
  return false;
}
const masterVerdictResponse = (v) => (v === 'bad' ? { msg: 'ข้อมูลไม่ถูกต้อง', status: 400 }
  : v === 'mismatch' ? { msg: 'รหัสในข้อมูลไม่ตรงกับรหัสในเส้นทาง', status: 400 }
  : v === 'conflict' ? { msg: 'รหัส (code) ซ้ำกับรายการอื่นที่มีอยู่แล้ว', status: 409 } : { msg: FORBIDDEN_MSG, status: 403 });

// ledger record types a user WITHOUT the budget permission may post (see POST /api/budget-transactions)
const LEDGER_TYPES_FOR_STAFF = new Set(['PR_RELEASE', 'ACTUAL_SPEND', 'PO_CANCEL_REFUND', 'PR_CANCEL_RELEASE', 'PO_CANCEL_RELEASE', 'CLAIM_REFUND']);
const RETURN_TYPES_SQL = "UPPER(type) IN ('BUDGET_ROLLBACK', 'TOP_UP')";
function refundCapGuard(amount, gate) {
  return {
    sql: `
      AND ? <= (SELECT COALESCE(SUM(ABS(amount)), 0) FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT' AND docNo = ?)
             - (SELECT COALESCE(SUM(amount), 0) FROM budget_transactions WHERE ${RETURN_TYPES_SQL} AND docNo IN (SELECT poNumber FROM pos WHERE prNumber = ? OR prId = ?)) + 0.005
      AND ? <= ? - (SELECT COALESCE(SUM(amount), 0) FROM budget_transactions WHERE ${RETURN_TYPES_SQL} AND docNo = ?) + 0.005`,
    // POs reference their PR by number or by id (prNumber / prId) : both are counted
    binds: [amount, gate.prNumber, gate.prNumber, gate.prId || gate.prNumber, amount, gate.approvedTotal, gate.poNumber]
  };
}

// -> { error: {status, message} } | { ctx: { poNumber, prNumber, approvedTotal, capLeft, department } }
async function resolveRefundPo(db, authUser, { docNo, dept }) {
  const ref = str100(docNo);
  if (!ref) return { error: { status: 400, message: 'ต้องระบุเลขที่ PO ที่คืนงบประมาณ (docNo/poNumber)' } };
  const po = await db.prepare('SELECT * FROM pos WHERE poNumber = ? OR id = ? ORDER BY (poNumber = ?) DESC LIMIT 1').bind(ref, ref, ref).first();
  if (!po) return { error: { status: 400, message: 'ไม่พบ PO ที่อ้างอิง' } };
  const poDept = normalizeDeptCode(po.department);
  if (dept && normalizeDeptCode(dept) !== poDept) return { error: { status: 400, message: 'แผนกที่คืนงบไม่ตรงกับแผนกของ PO' } };
  if (!canAccessDepartment(authUser, poDept)) return { error: { status: 403, message: FORBIDDEN_MSG } };
  const prKey = String(po.prNumber || po.prId || '').trim();
  const pr = prKey ? await db.prepare('SELECT id, prNumber, department FROM prs WHERE prNumber = ? OR id = ? ORDER BY (prNumber = ?) DESC LIMIT 1').bind(prKey, prKey, prKey).first() : null;
  if (!pr) return { error: { status: 400, message: 'ไม่พบ PR ของ PO นี้ จึงไม่สามารถคืนงบประมาณได้' } };
  if (normalizeDeptCode(pr.department) !== poDept) return { error: { status: 400, message: 'PO และ PR อยู่คนละแผนก ไม่สามารถคืนงบประมาณได้' } };
  let extra = {};
  try { extra = JSON.parse(po.extraJson || '{}') || {}; } catch { extra = {}; }
  const approvedTotal = Number(extra.approvedTotal) > 0 ? Number(extra.approvedTotal) : 0;
  const ev = await db.prepare(`
    SELECT
      COALESCE((SELECT SUM(ABS(amount)) FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT' AND docNo = ?), 0) AS committed,
      COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE ${RETURN_TYPES_SQL} AND docNo IN (SELECT poNumber FROM pos WHERE prNumber = ? OR prId = ?)), 0) AS prReturned,
      COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE ${RETURN_TYPES_SQL} AND docNo = ?), 0) AS poReturned
  `).bind(pr.prNumber, pr.prNumber, pr.id, po.poNumber).first();
  const committed = Number(ev && ev.committed) || 0;
  if (committed <= 0) return { error: { status: 400, message: 'ไม่พบยอดผูกพันงบของ PR ที่ตรวจแล้ว จึงไม่สามารถคืนงบประมาณได้' } };
  const capLeft = Math.min(committed - (Number(ev.prReturned) || 0), approvedTotal - (Number(ev.poReturned) || 0));
  if (!(capLeft > 0)) return { error: { status: 400, message: 'PO นี้คืนงบประมาณครบตามมูลค่าที่ตัดไว้แล้ว' } };
  return { ctx: { poNumber: po.poNumber, prNumber: pr.prNumber, prId: pr.id, approvedTotal, capLeft, department: poDept } };
}

// upsert of one department's budget row (POST /api/budgets and PUT /api/budgets/:dept). -> null | error message (400)
// spent/variance are only written on first insert ; afterwards totalUsed/totalRemaining move through settle / adjust / allocate
// - except opts.overwriteTotals (PUT by a budget writer = GAS apiSaveBudgets) which stores the body's spent / variance as sent.
async function upsertBudgetEntry(db, dept, b, opts = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'ข้อมูลงบประมาณไม่ถูกต้อง';
  const monthly = Number(b.monthlyBudget || b.totalBudget || b.amount || 0);
  const spentIn = budgetSpentOf(b); // spent | actualExpense | budgetSpent (the client keeps all three in sync)
  const spentNum = Number(spentIn || 0);
  const varianceNum = Number(b.variance ?? b.remainingBudget ?? (monthly - spentNum));
  const overwrite = Boolean(opts.overwriteTotals) && spentIn !== undefined && spentIn !== null && spentIn !== '';
  if (![monthly, spentNum, varianceNum].every(Number.isFinite) || (b.pending != null && b.pending !== '' && !Number.isFinite(Number(b.pending)))) {
    return 'ข้อมูลงบประมาณไม่ถูกต้อง';
  }
  const historyJson = JSON.stringify(b.history || {});
  // ฟิลด์ใหม่ (migration 0006): ส่งมาเฉพาะที่มี ; ไม่ส่ง = คงค่าเดิม (COALESCE)
  const pendingAmt = (b.pending !== undefined && b.pending !== null) ? Number(b.pending) : null;
  const histSpentJson = (b.historicalSpent !== undefined && b.historicalSpent !== null) ? JSON.stringify(b.historicalSpent) : null;
  const refundCreditsJson = (b.refundCredits !== undefined && b.refundCredits !== null) ? JSON.stringify(b.refundCredits) : null;
  const monthVal = (b.month !== undefined && b.month !== null) ? String(b.month) : null;
  const code = ledgerDeptCode(dept);
  const upsertStmt = db.prepare(`
    INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt, pendingAmount, historicalSpentJson, refundCreditsJson, month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE(?, 0), ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ${overwrite ? 'totalUsed = excluded.totalUsed, totalRemaining = excluded.totalRemaining,' : ''}
      monthlyBudget = excluded.monthlyBudget,
      totalAllocated = excluded.totalAllocated,
      monthsJson = excluded.monthsJson,
      pendingAmount = COALESCE(?, budgets.pendingAmount),
      historicalSpentJson = COALESCE(excluded.historicalSpentJson, budgets.historicalSpentJson),
      refundCreditsJson = COALESCE(excluded.refundCreditsJson, budgets.refundCreditsJson),
      month = COALESCE(excluded.month, budgets.month),
      updatedAt = CURRENT_TIMESTAMP
  `).bind(code, code, bangkokYear(), monthly, monthly, spentNum, varianceNum, historyJson, pendingAmt, histSpentJson, refundCreditsJson, monthVal, pendingAmt);
  // a D1 error must surface (500), not look like success ; extra statements (e.g. the claim-credit ledger row) commit with the upsert or not at all
  if (opts.extraStmts && opts.extraStmts.length) await db.batch([upsertStmt, ...opts.extraStmts]);
  else await upsertStmt.run();
  return null;
}

// settlement result of a PO (POST /api/pos/:id/settle) lives in pos.extraJson (+ the real column actualTotalAmount) ; the client reads these as
// top-level PO fields (po.settlementStatus, po.savingsAmount, po.actualItems ...), so they are merged back in on every PO read.
const SETTLEMENT_KEYS = ['settlementStatus', 'savingsAmount', 'settlementNote', 'settlementProofUrl', 'settledBy', 'settledAt', 'actualItems'];
function poSettlementFields(extraJson) {
  if (!extraJson) return {};
  let e = {};
  try { e = JSON.parse(extraJson) || {}; } catch { return {}; }
  const out = {};
  for (const k of SETTLEMENT_KEYS) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

// ── PR / PO fields that have no column (requestedBy, applicantName1, financials, reviewer / approver details, stakeholders, vendor snapshot ...) ──
// The client keeps ~40 such fields on a PR / PO and reads them back (TaskCard / PRListView search / PDF / workflowEngine ownership). GAS keeps the
// whole object ; D1 keeps them in extraJson (the importer does the same) and every read spreads them back as top-level fields.
// Everything the client sends is kept EXCEPT : the fields that are real columns / have their own handling, and what the SERVER owns (below).
const PR_EXTRA_RESERVED = new Set(['id', 'prNumber', 'prNo', 'department', 'requesterId', 'requesterName', 'status', 'totalAmount', 'total', 'reason', 'purpose',
  'items', 'timeline', 'attachments', 'approvalWorkflow', 'createdAt', 'updatedAt', 'extraJson', 'itemsJson', 'timelineJson', 'attachmentsJson', 'approvalWorkflowJson',
  'poNumber', 'purchaseChannel',
  // request markers (the audit action the client asks for) : read by the PUT handler, never stored
  'action', 'isResubmit',
  // PO bookkeeping names are not PR fields either
  'approvedTotal', 'settlementStatus', 'savingsAmount', 'settlementNote', 'settlementProofUrl', 'settledBy', 'settledAt', 'actualItems']);
const PO_EXTRA_RESERVED = new Set(['id', 'poNumber', 'poNo', 'prId', 'prNumber', 'prNo', 'department', 'vendorId', 'vendorName', 'totalAmount', 'total',
  'vatAmount', 'grandTotal', 'status', 'items', 'timeline', 'evidence', 'paymentTerms', 'deliveryDate', 'createdAt', 'updatedAt', 'extraJson', 'itemsJson', 'timelineJson',
  'evidenceJson', 'isClosed', 'budgetPeriod', 'committedAmount', 'actualPaidAmount', 'actualTotalAmount', 'purchaseChannel',
  // server-owned : computed by the server (approvedTotal at creation, settlement by POST /api/pos/:id/settle) ; ownership is copied from the PR row
  'approvedTotal', 'settlementStatus', 'savingsAmount', 'settlementNote', 'settlementProofUrl', 'settledBy', 'settledAt', 'actualItems', 'requesterId']);
// Server-owned approval trail : who reviewed / approved, their signature and when are written by the server when the transition succeeds
// (name / id from the token, signature from users.signature or the role's signature row - exactly what the client used to put there), and the
// approval history is appended by the server. The client's own values for these are ignored.
const APPROVAL_KEYS = ['reviewedBy', 'reviewerName', 'reviewerSignature', 'reviewedAt', 'reviewerId',
  'approvedBy', 'approverName', 'approverSignature', 'approvedAt', 'approverId', 'approvalHistory'];
APPROVAL_KEYS.forEach((k) => { PR_EXTRA_RESERVED.add(k); PO_EXTRA_RESERVED.add(k); });
// amounts shown by BudgetView (pr.totalEstimate || pr.totalAmount) : only the server / importer may set them, never a client save ; refPrNo is copied from the PR
['totalEstimate', 'estimatedTotal'].forEach((k) => PR_EXTRA_RESERVED.add(k));
PO_EXTRA_RESERVED.add('refPrNo');
// claim records : written ONLY through docServerPatch (claimPatch) so the server merges, stamps who / when and never lets a save delete them
['claimData', 'claimDetails', 'inlineClaimData', 'storeClaims', 'claimEvidence', 'disputeInfo', 'claimResolution', 'grAttachments', 'claimPhoto', 'refundAmount', 'totalRefunded'].forEach((k) => PO_EXTRA_RESERVED.add(k));
// who created the document is fixed at creation (from the token / the PR) and never rewritten by a later save
const PR_IDENTITY_KEYS = ['requestedBy', 'applicantName1', 'createdBy'];
const PO_IDENTITY_KEYS = ['requestedBy', 'applicantName1', 'createdBy'];
const PO_CHANNEL_KEYS = ['procurementType', 'channel'];
const EXTRA_MAX_CHARS = 1200000; // signatures are data URLs ; one D1 row is limited to 2 MB
const REVIEW_STATUSES_OWN = ['REVIEWED'];
const APPROVE_STATUSES_OWN = ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE'];

// an error the handler turns into a plain HTTP answer (see the catch at the end of onRequest) ; thrown from helpers that run deep inside a write
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// keys that must never be stored inside extraJson / log entries (prototype pollution when the object is merged / spread later)
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function cleanDeep(v, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = cleanDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}

// null is kept for a key that is not reserved : json_patch then removes the stored value (a client clearing a field)
function pickExtra(body, reserved, dropKeys = []) {
  const out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const [k, v] of Object.entries(body)) {
    if (reserved.has(k) || dropKeys.includes(k) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) continue;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = cleanDeep(v);
    if (Object.keys(out).length > 150) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด');
  }
  return out;
}

// Cloudflare Workers run in UTC : every display timestamp the client used to make with toLocaleString('th-TH') (device = Thailand) is made in Bangkok time
const thaiStamp = (date) => date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

// name + signature of the acting user as the client composes them (workflowEngine.updatePRStatus / createPOFromPR)
async function signerOf(db, authUser, fallbackName) {
  const name = authUser.employeeName || (authUser.name && authUser.name !== 'Admin System' ? authUser.name : fallbackName);
  let signature = authUser.signature || null;
  if (!signature && db) {
    try {
      const r = await db.prepare('SELECT signatureUrl FROM signatures WHERE UPPER(TRIM(roleId)) = UPPER(?) LIMIT 1').bind(String(authUser.roleId || authUser.canonicalRole || authUser.role || 'REQUESTER_PD').trim()).first(); // GAS resolveUserSignatureBase64 :2002
      signature = (r && r.signatureUrl) || null;
    } catch { signature = null; }
  }
  return { name, signature };
}

/**
 * Server side of a PR save : the reviewer / approver details of a successful transition and the appended approval history.
 * stored = the row's current extra (object), clientHistory = body.approvalHistory, prev / next = status before / after.
 * -> object to merge into extraJson.
 */
async function prApprovalPatch(db, authUser, { stored, clientHistory, prev, next, isExisting, eventId, meta }) {
  const out = {};
  const now = new Date();
  const changed = Boolean(next) && next !== prev;
  if (changed && REVIEW_STATUSES_OWN.includes(next)) {
    const s = await signerOf(db, authUser, 'คุณสมชาย มุ่งมั่น');
    const at = now.toISOString();
    out.reviewedBy = { id: authUser.roleKey, name: s.name, signature: s.signature, timestamp: at };
    out.reviewerName = s.name;
    out.reviewerSignature = s.signature;
    out.reviewedAt = at;
  }
  if (changed && APPROVE_STATUSES_OWN.includes(next) && !APPROVE_STATUSES_OWN.includes(prev)) {
    const s = await signerOf(db, authUser, 'คุณประเสริฐ ยิ่งยง');
    const at = now.toISOString();
    out.approvedBy = { id: authUser.roleKey, name: s.name, signature: s.signature, timestamp: at };
    out.approverName = s.name;
    out.approverSignature = s.signature;
    out.approvedAt = at;
  }
  // approval history : the stored entries are kept as they are ; entries the client adds get the identity of the token, and the workflow entries
  // (REVIEWED / APPROVED ...) are only accepted together with the real transition. A transition without an entry gets one from the server.
  const history = Array.isArray(stored.approvalHistory) ? stored.approvalHistory.slice() : [];
  // rows saved before the server kept the history : the client's entries are taken once, but the identity on them is ALWAYS the token's
  // (the importer fills approvalHistory from the sheet when the sheet has it, so imported rows are never in this case)
  const legacyBackfill = isExisting && !Array.isArray(stored.approvalHistory);
  const actorName = authUser.name || authUser.username || '';
  const actorRole = authUser.title || authUser.canonicalRole || authUser.role || '';
  // a stored entry carries the server's time, so the time the CLIENT put on it is kept as clientTimestamp : the same entry sent again (before a reload, or copied back from GET) matches by either
  const keyOf = (e) => `${e.action}|${e.timestamp}|${e.comment}`;
  const clientKeyOf = (e) => `${e.action}|${e.clientTimestamp !== undefined ? e.clientTimestamp : e.timestamp}|${e.comment}`;
  const seen = new Set();
  for (const h of history) { if (h && typeof h === 'object') { seen.add(keyOf(h)); seen.add(clientKeyOf(h)); } }
  const stamp = thaiStamp(now);
  let added = 0;
  for (const e of Array.isArray(clientHistory) ? clientHistory : []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const action = String(e.action || '').slice(0, 40);
    if (!action) continue;
    const gatedReview = REVIEW_STATUSES_OWN.includes(action);
    const gatedApprove = APPROVE_STATUSES_OWN.includes(action);
    if (gatedReview && !(changed && next === 'REVIEWED')) continue;
    if (gatedApprove && !(changed && APPROVE_STATUSES_OWN.includes(next))) continue;
    const entry = {
      actorName,
      actorRole,
      action,
      date: String(e.date || stamp).slice(0, 64),
      timestamp: String(e.timestamp || e.date || stamp).slice(0, 64),
      comment: String(e.comment || '').slice(0, 1000)
    };
    const clientTs = String(e.clientTimestamp ?? e.timestamp ?? e.date ?? '').slice(0, 64);
    const ckey = clientKeyOf({ action, clientTimestamp: clientTs, comment: entry.comment });
    if (seen.has(ckey) || seen.has(keyOf(entry))) continue; // already stored (the same entry sent again, or a copy of a stored one)
    seen.add(ckey);
    seen.add(keyOf(entry));
    entry.date = stamp; // a NEW entry : the time is the server's, never the client's
    entry.timestamp = stamp;
    entry.clientTimestamp = clientTs; // bookkeeping for the duplicate check only (PDF / modal ignore it)
    // entries of a real transition share the id of the audit_logs row the server writes for it (the details modal merges timeline + approvalHistory by id : one line, not two)
    if (changed && eventId) entry.id = eventId;
    if (meta && entry.comment) meta.comment = entry.comment;
    history.push(entry);
    added += 1;
  }
  if (changed && added === 0) {
    // the action PDF / PrintablePO look for : 'APPROVED' for any approval status, 'REVIEWED' for the review
    const action = APPROVE_STATUSES_OWN.includes(next) ? 'APPROVED' : next;
    history.push({ actorName, actorRole, action, date: stamp, timestamp: stamp, comment: '', ...(eventId ? { id: eventId } : {}) });
    added += 1;
  }
  if (added > 0 || legacyBackfill) out.approvalHistory = history.slice(-500);
  return out;
}
// ── PR timeline from audit_logs (parity with GAS : logPRAudit writes AuditLogs rows, buildAuditLogsByDoc assembles pr.timeline when PRs are read) ──
// Rows are written by the server only (actor = the token, never the body) and never updated / deleted ; the PR's timeline is rebuilt from them on every read.
const PR_AUDIT_ACTIONS = ['CREATE', 'PR_DRAFTED', 'RESUBMIT', 'REVIEW_FORWARD', 'APPROVE', 'SEND_BACK', 'CANCEL'];
const PR_AUDIT_TEXT = {
  CREATE: 'สร้างใบขอซื้อและส่งตรวจสอบ',
  PR_DRAFTED: 'บันทึกแบบร่างใบขอซื้อ',
  RESUBMIT: 'แก้ไขรายละเอียดเอกสารและส่งตรวจสอบใหม่อีกครั้ง',
  REVIEW_FORWARD: 'ตรวจสอบผ่าน ส่งต่อ Plant Mgr',
  APPROVE: 'อนุมัติใบขอซื้อ',
  SEND_BACK: 'ส่งกลับเพื่อแก้ไข',
  CANCEL: 'ยกเลิกใบขอซื้อ'
};
const parseJsonSafe = (str, fallback = []) => {
  if (!str) return fallback;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return fallback; }
};
// audit events are read-only output : whatever the client sends back under such an id (a copy of what GET gave it, or a forged one) is dropped before the stored log is merged
const isAuditEntry = (e) => Boolean(e) && typeof e === 'object' && typeof e.id === 'string' && /^(AL|AUD)-/.test(e.id);
const withoutAuditEntries = (tl) => (Array.isArray(tl) ? tl.filter((e) => !isAuditEntry(e)) : tl);
// resubmit = the client's marker (apiUpdatePR / submitPR sent action 'RESUBMIT') : a status change alone no longer means RESUBMIT (GAS logs it from apiUpdatePR only)
function prAuditAction(prev, next, isExisting, resubmit = false) {
  if (!next) return resubmit && isExisting ? 'RESUBMIT' : null;
  if (!isExisting) return next === 'DRAFT' ? 'PR_DRAFTED' : 'CREATE';
  if (next === prev) return resubmit ? 'RESUBMIT' : null;
  if (next === 'REVIEWED') return 'REVIEW_FORWARD';
  if (APPROVE_STATUSES_OWN.includes(next) && !APPROVE_STATUSES_OWN.includes(prev)) return 'APPROVE';
  if (String(next).startsWith('REJECTED')) return 'SEND_BACK';
  if (next === 'CANCELLED') return 'CANCEL';
  if (next === 'DRAFT') return 'PR_DRAFTED';
  return resubmit ? 'RESUBMIT' : null;
}
// the audit row as a prepared statement : it is written in the SAME db.batch (one transaction) as the PR write when the binding has batch
// whereSql / whereBinds : a guard evaluated inside the batch (e.g. "the PR is still in the status this request read") so a second identical request writes no second row
function prAuditStmt(db, authUser, { id, action, prId, prNo, status, comment, whereSql, whereBinds }) {
  if (!db || !action) return null;
  const text = String(comment || '').trim().slice(0, 1000) || PR_AUDIT_TEXT[action] || '';
  const details = {
    docNo: String(prNo || prId || ''), comment: text, summary: text, status: status || null,
    actorName: authUser.name || authUser.username || '', actorRole: authUser.title || authUser.canonicalRole || authUser.role || '', roleKey: authUser.roleKey
  };
  return db.prepare(`INSERT OR IGNORE INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${whereSql || '1'}`)
    .bind(id, action, 'pr', String(prId || ''), authUser.userId, JSON.stringify(details), new Date().toISOString(), ...(whereBinds || []));
}
// PO audit row (GAS recordAuditLogEntry parity : entityType 'po', comment text is the exact GAS wording) ; actor from the token only.
// INSERT OR IGNORE on a fixed id makes a retried request (same GRN) a no-op ; whereSql/whereBinds = the same guard the PO write has, so no row is left without its write.
function poAuditStmt(db, authUser, { id, action, poId, poNo, status, comment, whereSql, whereBinds, statusFromPo }) {
  if (!db || !action) return null;
  const text = String(comment || '').slice(0, 1000);
  const details = {
    docNo: String(poNo || poId || ''), comment: text, summary: text, status: status || null,
    actorName: authUser.name || authUser.username || '', actorRole: authUser.title || authUser.canonicalRole || authUser.role || '', roleKey: authUser.roleKey, module: 'PURCHASE'
  };
  // statusFromPo : details.status is read from the PO row AFTER the write in the same batch (what was really stored), not from the request body
  const detailsExpr = statusFromPo ? "json_set(?, '$.status', (SELECT status FROM pos WHERE id = ?))" : '?';
  return db.prepare(`INSERT OR IGNORE INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) SELECT ?, ?, ?, ?, ?, ${detailsExpr}, ? WHERE ${whereSql || '1'}`)
    .bind(id, action, 'po', String(poId || ''), authUser.userId, JSON.stringify(details), ...(statusFromPo ? [String(poId || '')] : []), new Date().toISOString(), ...(whereBinds || []));
}
// ── PR cascade when a PO is fully received / closed (GAS apiReceivePO step 10, Code.gs:2900-2947 ; parity.md "PO_ISSUED/IN_PROGRESS_ONLINE -> completed") ──
// GAS : PO CLOSED / COMPLETED -> its PR gets status = poStatus = 'completed', poNumber, fullyReceivedAt and an activityLog line ; no audit row / notification for the PR
// (the PO's own GOODS_RECEIVED_* audit + notification already exist). Server side, in the SAME batch as the PO write :
//  - only a PR that is APPROVED / PO_ISSUED / IN_PROGRESS_ONLINE, of the PO's department, and only while it still has the status read here (optimistic, like every PR write)
//  - only when the PO row really is CLOSED / COMPLETED after its own write in that batch. Exactly like GAS : the FIRST PO of the PR that closes completes it
//    (owner's decision) - sibling POs are not looked at ; PR.poNumber is overwritten with the number of the PO that closed last (Code.gs:2922)
const PR_CASCADE_FROM = new Set(['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE']);
const PO_CLOSING_FOR_PR = new Set(['CLOSED', 'COMPLETED']);
async function prCascadeFor(db, poRow) {
  // the PO's prId names the PR exactly (id = prId only) ; prNumber is the fallback ONLY for a PO that has no prId (never both : another PR's number cannot match)
  const prId = String((poRow && poRow.prId) || '').trim();
  const prNo = String((poRow && poRow.prNumber) || '').trim();
  if (!prId && !prNo) return null;
  const prRow = await (prId
    ? db.prepare('SELECT id, prNumber, status, department FROM prs WHERE id = ? LIMIT 1').bind(prId)
    : db.prepare('SELECT id, prNumber, status, department FROM prs WHERE prNumber = ? LIMIT 1').bind(prNo)).first().catch(() => null);
  if (!prRow || !PR_CASCADE_FROM.has(String(prRow.status || '').trim())) return null;
  if (normalizeDeptCode(prRow.department) !== normalizeDeptCode(poRow.department)) return null;
  return prRow;
}
function prCascadeStmt(db, authUser, { prRow, poRow, poNo, iso }) {
  if (!db || !prRow) return [];
  const actor = authUser.name || authUser.username || 'System';
  const entry = {
    action: 'ปิดเอกสาร (Closed)', user: actor, role: authUser.title || authUser.canonicalRole || authUser.role || '',
    date: iso, timestamp: iso, note: `PO ${poNo} รับสินค้าครบแล้ว ปิดใบ PR อัตโนมัติ`
  };
  const tl = "COALESCE(NULLIF(timelineJson, ''), '[]')";
  const update = db.prepare(`
    UPDATE prs SET
      status = 'completed',
      poNumber = COALESCE(NULLIF(?, ''), poNumber),
      timelineJson = CASE WHEN json_valid(${tl}) AND json_type(${tl}) = 'array' THEN json_insert(${tl}, '$[#]', json(?)) ELSE timelineJson END,
      extraJson = json_patch(COALESCE(NULLIF(extraJson, ''), '{}'), ?),
      updatedAt = CURRENT_TIMESTAMP
    WHERE id = ? AND status IS ?
      AND UPPER(TRIM(COALESCE((SELECT status FROM pos WHERE id = ?), ''))) IN ('CLOSED', 'COMPLETED')
  `).bind(String(poNo || ''), JSON.stringify(entry), JSON.stringify({ poStatus: 'completed', fullyReceivedAt: iso }),
    prRow.id, prRow.status, poRow.id);
  // audit row of the cascade : the NEXT statement of the batch, written only when the UPDATE above really changed the PR (changes() = rows of the last statement) ;
  // action PR_COMPLETED_BY_PO is not one of PR_AUDIT_ACTIONS, so it never joins the PR timeline ; listed by GET /api/audit-logs like the PO rows (module PURCHASE)
  const text = `ปิดเอกสาร (Closed) จาก PO ${poNo}`;
  const details = {
    docNo: String(prRow.prNumber || prRow.id), poNumber: String(poNo || ''), comment: text, summary: text, status: 'completed',
    actorName: actor, actorRole: authUser.title || authUser.canonicalRole || authUser.role || '', roleKey: authUser.roleKey, module: 'PURCHASE'
  };
  const audit = db.prepare('INSERT OR IGNORE INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0')
    .bind(`AUD-PR-DONE:${prRow.id}:${poRow.id}`, 'PR_COMPLETED_BY_PO', 'pr', String(prRow.id), authUser.userId, JSON.stringify(details), iso);
  return [update, audit];
}
// notifications of a PO save : only while the PO is still in the state this request read (status, orderStatus, claim resolvedAt) -> two identical saves = one row
function poNotifyStmts(db, { poId, prev, status, body, dept, poNo }) {
  const prevExtra = (prev && prev.extra) || {};
  const cr = prevExtra.claimResolution;
  const prevResolved = cr && typeof cr === 'object' && cr.resolvedAt ? String(cr.resolvedAt) : '';
  return notificationStmts(db, poSaveNotificationParams({ prev, status, body, dept, poNo }), {
    whereSql: "(SELECT status FROM pos WHERE id = ?) IS ? AND COALESCE((SELECT json_extract(extraJson, '$.orderStatus') FROM pos WHERE id = ?), '') = ? AND COALESCE((SELECT json_extract(extraJson, '$.claimResolution.resolvedAt') FROM pos WHERE id = ?), '') = ?",
    whereBinds: [poId, prev.status === undefined ? null : prev.status, poId, String(prevExtra.orderStatus || ''), poId, prevResolved]
  });
}
// GAS apiSavePO comment : note || reason || comment || default ; only non-empty strings count (an object / number is "not given")
const poUpdateComment = (p) => [p && p.note, p && p.reason, p && p.comment].find((v) => typeof v === 'string' && v.trim()) || 'ปรับปรุงข้อมูลใบสั่งซื้อ';
// PO write + its audit row : one batch ; a binding without batch writes them one after the other
// pre : rows guarded by "the PO still has the status / order / claim state this request read" (notifications) : they go BEFORE the write
async function runPoWithAudit(db, stmt, auditStmt, extras = [], pre = []) {
  const more = (extras || []).filter(Boolean);
  const first = (pre || []).filter(Boolean);
  if (!auditStmt && more.length === 0 && first.length === 0) return stmt.run();
  if (typeof db.batch === 'function') return db.batch([...first, stmt, ...(auditStmt ? [auditStmt] : []), ...more]);
  for (const x of first) await x.run().catch((e) => { console.error('[po-audit] write failed', e && e.message); });
  const r = await stmt.run();
  for (const x of [auditStmt, ...more]) if (x) await x.run().catch((e) => { console.error('[po-audit] write failed', e && e.message); });
  return r;
}
// PR write + its audit row : one batch (all or nothing) ; a binding without batch writes them one after the other and logs a failed audit row
// did the write change a row ? (D1 result.meta.changes ; a binding that does not report it counts as applied)
const writeApplied = (r) => { const ch = r && r.meta && r.meta.changes; return ch === undefined || ch === null || Number(ch) > 0; };
// auditFirst : the audit / notification rows are guarded by "status is still the one read" so they go BEFORE the write that changes the status
async function runWithAudit(db, stmt, auditStmt, ctx, extras = [], auditFirst = false) {
  const more = (extras || []).filter(Boolean);
  if (!auditStmt) return stmt.run();
  if (typeof db.batch === 'function') {
    const list = auditFirst ? [auditStmt, ...more, stmt] : [stmt, auditStmt, ...more];
    const out = await db.batch(list);
    return Array.isArray(out) ? out[list.indexOf(stmt)] : out; // the result of the PR write itself (meta.changes)
  }
  if (auditFirst) {
    for (const x of [auditStmt, ...more]) await x.run().catch((e) => { console.error('[pr-audit] write failed', ctx && ctx.prId, ctx && ctx.action, e && e.message); });
    return stmt.run();
  }
  const r = await stmt.run();
  for (const x of [auditStmt, ...more]) await x.run().catch((e) => { console.error('[pr-audit] write failed', ctx && ctx.prId, ctx && ctx.action, e && e.message); });
  return r;
}
// reason text of the audit row of a send-back / cancel : taken from THIS request only (a cancel never picks an old rejectReason)
const prTransitionComment = (act, p) => (act === 'SEND_BACK' ? (p.rejectReason || p.rejectionReason || p.returnComment || p.comment || p.cancelReason) : (act === 'CANCEL' ? (p.cancelReason || p.comment) : ''));
// notification rows of a PR transition (GAS call sites ; recipients by role + the department of the row, see _lib/notify.js)
const prNotifyStmts = (db, authUser, act, { dept, prNo, body, whereSql, whereBinds }) => notificationStmts(db, prNotificationParams(act, { dept, prNo, requesterName: authUser.name || authUser.username || '', body }), { whereSql, whereBinds });
// "the PR row is still in the status this request read" : the guard of the audit / notification rows of a status transition
const prPrevStatusGuard = (prId, prevStatus) => ({ whereSql: '(SELECT status FROM prs WHERE id = ?) IS ?', whereBinds: [prId, prevStatus === undefined ? null : prevStatus] });
// the audit events of the PRs the caller may see : ONE query (ids travel as one JSON parameter, json_each) ; uses idx_audit_logs_entity (entityType, entityId) ; no LIMIT (never drops the newest rows)
async function prAuditEvents(db, prIds) {
  const ids = [...new Set((prIds || []).map((x) => String(x)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const marks = PR_AUDIT_ACTIONS.map(() => '?').join(',');
  let rowsAll = [];
  try {
    const res = await db.prepare(`SELECT id, action, entityId, details, timestamp FROM audit_logs WHERE entityType = 'pr' AND source IS NULL AND entityId IN (SELECT value FROM json_each(?)) AND action IN (${marks}) ORDER BY timestamp ASC, rowid ASC`)
      .bind(JSON.stringify(ids), ...PR_AUDIT_ACTIONS).all();
    rowsAll = res.results || [];
  } catch (e) {
    console.error('[pr-audit] timeline read failed', e && e.message);
  }
  const byPr = new Map();
  for (const r of rowsAll) {
    const d = parseJsonSafe(r.details, {});
    const who = d.actorName || 'ผู้ใช้งาน';
    const text = d.comment || d.summary || '';
    const ev = {
      id: r.id, timestamp: r.timestamp, createdAt: r.timestamp, date: r.timestamp, time: r.timestamp, action: r.action, title: r.action, type: r.action,
      docNo: d.docNo || '', targetRef: d.docNo || '', actor: who, actorName: who, user: who, userName: who, by: who,
      role: d.actorRole || '', actorRole: d.actorRole || '', userRole: d.actorRole || '',
      comment: text, note: text, details: text, description: text, summary: text, reason: text, changes: [], status: d.status || null
    };
    if (!byPr.has(r.entityId)) byPr.set(r.entityId, []);
    byPr.get(r.entityId).push(ev);
  }
  return byPr;
}
// stored timeline (older rows / entries the client sent) + audit events, one line per id
// merged list is ordered by time (stable ; an entry whose time cannot be parsed keeps the time of the entry before it)
function prTimelineOf(pr, byPr) {
  const base = Array.isArray(pr.timeline) ? pr.timeline : [];
  const ev = (byPr && byPr.get(pr.id)) || [];
  if (ev.length === 0) return base;
  // the audit event wins when an id collides (a stored / client-made entry can never hide or replace a real event)
  const evIds = new Set(ev.map((e) => e.id));
  const all = base.filter((e) => !(e && typeof e === 'object' && evIds.has(e.id))).concat(ev);
  let last = 0;
  const keyed = all.map((e, i) => {
    const t = e && typeof e === 'object' ? Date.parse(e.timestamp || e.createdAt || e.date || '') : NaN;
    if (!Number.isNaN(t)) last = t;
    return { e, k: last, i };
  });
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  return keyed.map((x) => x.e);
}
async function withPrTimelines(db, prs) {
  const byPr = await prAuditEvents(db, prs.map((p) => p.id));
  return prs.map((p) => ({ ...p, timeline: prTimelineOf(p, byPr) }));
}

// ── append-only logs (activityLog / history / grnHistory / claimHistory / activityTimeline / timeline) ──
// Entries already stored cannot be changed ; entries the client adds are kept (their content) but WHO and WHEN come from the token / the server.
const PR_LOG_KEYS = ['activityLog', 'history', 'activityTimeline'];
const PO_LOG_KEYS = ['activityLog', 'history', 'grnHistory', 'claimHistory', 'activityTimeline'];
PR_LOG_KEYS.forEach((k) => PR_EXTRA_RESERVED.add(k));
PO_LOG_KEYS.forEach((k) => PO_EXTRA_RESERVED.add(k));
// scalar actor / stamp fields the server writes itself
['workflowStatus', 'fullyReceivedAt'].forEach((k) => { PR_EXTRA_RESERVED.add(k); PO_EXTRA_RESERVED.add(k); });
const RECEIVER_KEYS = ['receivedBy', 'receiverName', 'receivedById', 'receiverId', 'receivedRole', 'receiverRole', 'receiverSignature', 'receivedAt', 'receivingInfo'];
[...RECEIVER_KEYS, 'closedBy', 'closedDate'].forEach((k) => PO_EXTRA_RESERVED.add(k));
// receivedBy is stamped separately : 'name (position)' like ReceivingModal composed it
const LOG_NAME_KEYS = ['actorName', 'user', 'userName', 'by', 'performedBy', 'recordedBy', 'actor', 'resolvedBy', 'reportedBy'];
const LOG_ROLE_KEYS = ['actorRole', 'role', 'userRole'];
const LOG_ID_KEYS = ['userId', 'actorId', 'resolvedById', 'reportedById'];
const LOG_TIME_KEYS = ['date', 'timestamp', 'resolvedAt'];
// document level "who did it" fields the server stamps itself (see stampWho / the ordered* handling in docServerPatch) ; flag = this row's logs are managed by the server
PO_EXTRA_RESERVED.add('logSealed');
PR_EXTRA_RESERVED.add('logSealed');

// logSealed : true (every key sealed - rows created by the server, or the boolean older dev rows carry) | array of sealed log keys (older rows, sealed key by key)
const isLogSealed = (flag, k) => flag === true || (Array.isArray(flag) && flag.includes(k));
function sealLogKeys(stored, allKeys, newKeys) {
  if (stored.logSealed === true) return true;
  const sealed = new Set(Array.isArray(stored.logSealed) ? stored.logSealed.filter((k) => allKeys.includes(k)) : []);
  for (const k of allKeys) if (Array.isArray(stored[k]) || newKeys.includes(k)) sealed.add(k);
  return allKeys.filter((k) => sealed.has(k));
}

function actorOf(authUser) {
  const now = new Date();
  return {
    name: authUser.name || authUser.username || '',
    role: authUser.title || authUser.canonicalRole || authUser.role || '',
    title: authUser.title || authUser.position || '',
    id: authUser.roleKey,
    stamp: thaiStamp(now),
    iso: now.toISOString()
  };
}
const receivedByLabel = (a) => (a.title ? `${a.name} (${a.title})` : a.name);
const logKey = (e) => (typeof e === 'string' ? e : `${e && e.action}|${(e && (e.note ?? '')) ?? ''}|${(e && (e.comment ?? '')) ?? ''}|${(e && (e.message ?? '')) ?? ''}|${(e && (e.status ?? '')) ?? ''}|${(e && (e.grnNumber ?? '')) ?? ''}`);
// size caps : one entry <= ~4 KB of JSON (long strings are cut), a whole log <= LOG_TOTAL_MAX chars (413 before anything is written)
const LOG_ENTRY_MAX = 4096;
const LOG_TOTAL_MAX = 600000;
function shrinkStrings(v, lim, depth = 0) {
  if (typeof v === 'string') return v.length > lim ? v.slice(0, lim) : v;
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => shrinkStrings(x, lim, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 6) return null;
    const o = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) { if (++n > 40) break; o[k] = shrinkStrings(x, lim, depth + 1); }
    return o;
  }
  return v;
}
function capEntry(e) {
  if (!e || typeof e !== 'object') return e;
  if (JSON.stringify(e).length <= LOG_ENTRY_MAX) return e;
  for (const lim of [1000, 300, 100, 40]) {
    const cur = shrinkStrings(e, lim);
    if (JSON.stringify(cur).length <= LOG_ENTRY_MAX) return cur;
  }
  const o = {};
  for (const [k, x] of Object.entries(e)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') o[k] = typeof x === 'string' ? x.slice(0, 100) : x;
  return JSON.stringify(o).length <= LOG_ENTRY_MAX ? o : { action: String(e.action || '').slice(0, 100), truncated: true };
}
function stampLogEntry(e, a) {
  if (typeof e === 'string') return e.slice(0, 2000);
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const out = cleanDeep({ ...e });
  for (const k of LOG_NAME_KEYS) if (k in out) out[k] = a.name;
  for (const k of LOG_ROLE_KEYS) if (k in out) out[k] = a.role;
  for (const k of LOG_ID_KEYS) if (k in out) out[k] = a.id;
  for (const k of LOG_TIME_KEYS) if (k in out) out[k] = a.stamp;
  if ('receivedBy' in out) out.receivedBy = receivedByLabel(a);
  return capEntry(out);
}
// legacy = the row exists but the server never stored this log (row older than the server-kept logs) : the client's entries are the only history there is,
// so they are taken ONCE as they are (stamping them would overwrite the real authors with whoever saves first) ; from then on the log is append-only
function mergeLog(stored, client, a, max = 500, legacy = false) {
  const base = Array.isArray(stored) ? stored : [];
  if (!Array.isArray(client)) return base;
  if (legacy && !Array.isArray(stored)) {
    const taken = client.map((e) => (typeof e === 'string' ? e.slice(0, 2000) : (e && typeof e === 'object' && !Array.isArray(e) ? capEntry(cleanDeep(e)) : null))).filter((e) => e !== null).slice(-max);
    if (JSON.stringify(taken).length > LOG_TOTAL_MAX) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด');
    return taken;
  }
  let aligned = client.length >= base.length;
  for (let i = 0; aligned && i < base.length; i += 1) if (logKey(client[i]) !== logKey(base[i])) aligned = false;
  let fresh;
  if (aligned) fresh = client.slice(base.length);
  else { const seen = new Set(base.map(logKey)); fresh = client.filter((e) => !seen.has(logKey(e))); }
  const stamped = fresh.map((e) => stampLogEntry(e, a)).filter((e) => e !== null);
  const merged = base.concat(stamped).slice(-max);
  if (stamped.length > 0 && JSON.stringify(merged).length > LOG_TOTAL_MAX) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด');
  return merged;
}

// receiver details of a goods receipt, composed like workflowEngine.receiveGoods did on the client (name / role / signature of the TOKEN user)
async function receiverPatch(db, authUser) {
  const s = await signerOf(db, authUser, '');
  const signature = s.signature || '/signatures/receiver-default.png';
  const name = authUser.employeeName || (authUser.name && authUser.name !== 'Admin System' ? authUser.name : (authUser.username || ''));
  const role = authUser.position || authUser.roleId || authUser.role || authUser.title || 'ผู้ตรวจรับ / บันทึกสต็อก';
  const id = authUser.roleKey;
  return {
    receivedBy: name, receiverName: name, receivedById: id, receiverId: id, receivedRole: role, receiverRole: role,
    receiverSignature: signature, receivedAt: thaiStamp(new Date()),
    receivingInfo: { receiverName: name, receiverId: id, receiverRole: role, receiverSignature: signature, receivedAt: new Date().toISOString() }
  };
}

/**
 * Server side of a PR / PO save beyond the approval trail : merged logs, workflowStatus, fullyReceivedAt, closedBy/closedDate, receiver details.
 * stored = current extra (object), body = request body, next = the status after the save. -> object to merge into extraJson
 */
// ── document level "who / when" fields (orderedBy / orderedAt, storeClaims[*], inlineClaimData, claimData, claimDetails) ──
// The client still writes the content ; WHO and WHEN are the token's whenever the entry is new or its content changed. An unchanged entry keeps the
// stored who / when (a stale copy of the document saved later by somebody else cannot take them over).
const WHO_BY = ['resolvedBy', 'reportedBy'];
const WHO_ID = ['resolvedById', 'reportedById'];
const WHO_KEYS = new Set([...WHO_BY, ...WHO_ID, 'resolvedAt', 'reportedAt']);
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isoShaped = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
function canonJson(v, drop) {
  if (Array.isArray(v)) return `[${v.map((x) => canonJson(x, drop)).join(',')}]`;
  if (isPlain(v)) return `{${Object.keys(v).filter((k) => !drop.has(k) && v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k], drop)}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
// Claim records are merged on the SERVER (RFC 7386 without deletions : a null / missing field keeps the stored value, nothing can be erased), then the
// who / when of the part that CHANGED is the token's :
//   report content (reason / description / items / images ...)  -> reportedBy / reportedById / reportedAt
//   resolution content (status / type / refund / note ...)      -> resolvedBy / resolvedById / resolvedAt   (the reporter stays the reporter)
//   inspection (claimEvidence / disputeInfo, or any entry that has them) -> inspectorName / inspectedAt (/ date)
// A part that did not change keeps the stored who / when. The WHOLE merged object is written (json_patch then only re-applies the same values).
const REPORT_STAMP_KEYS = ['reportedBy', 'reportedById', 'reportedAt'];
const RESOLVE_STAMP_KEYS = ['resolvedBy', 'resolvedById', 'resolvedAt'];
const INSPECT_STAMP_KEYS = ['inspectorName', 'inspectedAt'];
const STAMP_DROP = new Set([...REPORT_STAMP_KEYS, ...RESOLVE_STAMP_KEYS, ...INSPECT_STAMP_KEYS]);
const STAMP_DROP_EVIDENCE = new Set([...STAMP_DROP, 'date']);
const RESOLVE_CONTENT = new Set(['status', 'isResolved', 'type', 'actionType', 'resolutionType', 'claimStatus', 'hasPendingClaim', 'refundAmount', 'note',
  'newTrackingNo', 'replacementTrackingNo', 'expectedDate', 'resolution']);
function mergeKeep(s, c, depth = 0) {
  const out = isPlain(s) ? { ...s } : {};
  if (!isPlain(c) || depth > 8) return out;
  for (const [k, v] of Object.entries(c)) {
    if (DANGEROUS_KEYS.has(k) || v === null || v === undefined) continue;
    out[k] = isPlain(v) ? mergeKeep(isPlain(out[k]) ? out[k] : null, v, depth + 1) : cleanDeep(v);
  }
  return out;
}
function stampClaim(s, c, a, opts = {}) {
  const st = isPlain(s) ? s : null;
  // a resolved entry that the client re-opens (ReceivingModal round 2 on the same store : isResolved true -> false, type / actionType null) is REPLACED by
  // the client's entry : the old resolution fields (type, resolvedBy ...) must not stay on a pending claim and nobody is stamped as its resolver
  const reopen = Boolean(st) && st.isResolved === true && isPlain(c) && c.isResolved === false;
  const m = reopen ? mergeKeep(null, c) : mergeKeep(st, c);
  const drop = opts.evidence ? STAMP_DROP_EVIDENCE : STAMP_DROP;
  const pickBy = (o, pred) => { const r = {}; if (!isPlain(o)) return r; for (const k of Object.keys(o)) if (pred(k)) r[k] = o[k]; return r; };
  const differs = (pred) => !st || canonJson(pickBy(m, pred), drop) !== canonJson(pickBy(st, pred), drop);
  const reportChanged = differs((k) => !RESOLVE_CONTENT.has(k) && !drop.has(k) && k !== 'claimDetails');
  const resolveChanged = differs((k) => RESOLVE_CONTENT.has(k));
  const anyChanged = differs((k) => !drop.has(k) && k !== 'claimDetails');
  // the previous version is kept in claimHistory (CLAIM_EDITED) when the report / evidence changes or an array (images, items ...) gets shorter :
  // the original reporter / inspector and the replaced evidence are never lost when the stamp below is rewritten
  if (st && Array.isArray(opts.archive) && ((opts.evidence ? anyChanged : reportChanged) || reopen || shrunkArrays(st, m))) {
    opts.archive.push({ field: opts.label || 'claim', previous: st });
  }
  const stamp = (k, changed, kind) => {
    if (!(k in m)) return;
    if (!changed && st && st[k] !== undefined) { m[k] = st[k]; return; }
    m[k] = kind === 'by' ? a.name : kind === 'id' ? a.id : (isoShaped(m[k]) ? a.iso : a.stamp);
  };
  stamp('reportedBy', reportChanged, 'by'); stamp('reportedById', reportChanged, 'id'); stamp('reportedAt', reportChanged, 'at');
  stamp('resolvedBy', resolveChanged, 'by'); stamp('resolvedById', resolveChanged, 'id'); stamp('resolvedAt', resolveChanged, 'at');
  if (opts.evidence) { m.inspectorName = (anyChanged || !st || st.inspectorName === undefined) ? a.name : st.inspectorName; }
  else stamp('inspectorName', anyChanged, 'by');
  if (opts.evidence) { m.inspectedAt = (anyChanged || !st || st.inspectedAt === undefined) ? a.iso : st.inspectedAt; }
  else stamp('inspectedAt', anyChanged, 'at');
  if (opts.evidence && 'date' in m) m.date = (anyChanged || !st || st.date === undefined) ? (isoShaped(m.date) ? a.iso : a.stamp) : st.date;
  if (isPlain(m.claimDetails) && isPlain(c && c.claimDetails)) m.claimDetails = stampClaim(st && st.claimDetails, c.claimDetails, a, { archive: opts.archive, label: `${opts.label || 'claim'}.claimDetails` });
  // (null = json_patch removes the stored key)
  if (reopen) for (const k of Object.keys(st)) if (!(k in m)) m[k] = null;
  return m;
}
// true when an array of the stored object is missing elements in the merged one (anywhere inside nested objects)
function shrunkArrays(st, m, depth = 0) {
  if (!isPlain(st) || !isPlain(m) || depth > 8) return false;
  for (const [k, v] of Object.entries(st)) {
    if (Array.isArray(v)) {
      if (!Array.isArray(m[k])) return true;
      const have = new Set(m[k].map((x) => JSON.stringify(x)));
      if (v.some((x) => !have.has(JSON.stringify(x)))) return true;
    } else if (isPlain(v) && k !== 'claimDetails' && shrunkArrays(v, m[k], depth + 1)) return true;
  }
  return false;
}
// -> writes the claim keys of a PO save into `out`. null / non-object (or an array for an object key) keeps the stored value : a save cannot delete a claim.
// null is accepted as "the claim is closed" ONLY together with a real closing condition in the same save (status moves to a closing status, or a
// claimResolution object is sent) : the stored claim is then copied into claimHistory (append-only, stamped) and cleared, so a new claim starts clean and
// no evidence is lost. Any other null keeps the stored claim.
const CLAIM_CLOSING_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_REFUND', 'WAITING_DELIVERY_ROUND_2', 'CLOSED']);
// Closing a claim (clearing claimData, writing the PO level claimResolution) needs ALL of :
//  (a) the stored PO is in a claim : status CLAIM_* / *_IN_CLAIM, or claimStatus / flags / a storeClaims entry still pending
//  (b) this very save moves the status to a closing status (workflowEngine.resolveClaim always does : COMPLETED or WAITING_DELIVERY_ROUND_2 together with
//      claimData = null / claimResolution) - a claimResolution alone is not enough
//  (c) a role that resolves claims in the client : admin ; ONLINE channel -> the online purchaser ; self-buy -> any department user except the online purchaser
function claimIsOpen(stored, prevStatus) {
  const s = String(prevStatus || '').trim().toUpperCase();
  if (s.startsWith('CLAIM_') || s.includes('_IN_CLAIM')) return true;
  if (['PENDING_CLAIM', 'IN_CLAIM'].includes(String(stored.claimStatus || '').toUpperCase())) return true;
  if (stored.hasDispute === true || stored.isInClaim === true || stored.hasUnresolvedClaim === true) return true;
  if (isPlain(stored.storeClaims)) {
    for (const c of Object.values(stored.storeClaims)) {
      if (isPlain(c) && (c.isResolved === false || String(c.status || '').toUpperCase() === 'PENDING_CLAIM' || String(c.claimStatus || '').toUpperCase() === 'PENDING_CLAIM')) return true;
    }
  }
  return false;
}
// same split as the client : fileClaim treats a PO as self-buy only when procurementType INTERNAL / channel DIRECT / purchaseChannel SELF, everything else
// (also an old imported PO with no purchaseChannel) is ONLINE
function isSelfBuyPo(channel, stored) {
  return String(channel || '').toUpperCase() === 'SELF' || String(stored.procurementType || '').toUpperCase() === 'INTERNAL' || String(stored.channel || '').toUpperCase() === 'DIRECT';
}
// ONLINE : admin / online purchaser (OnlineProcurementHub). Self-buy : exactly PODetailsModal.canResolveSelfClaim - admin, the PO's requester, a receiver
// of the PO's department (canReceiveGoods), a reviewer of that department or one who views every department (canReview)
function canCloseClaim(authUser, channel, stored, department) {
  const p = resolvePermissions(authUser);
  if (p.isAdmin) return true;
  if (!isSelfBuyPo(channel, stored)) return Boolean(p.onlineish);
  const sameDept = clientCanAccessDepartmentData(clientViewOfUser(authUser), department);
  const isRequester = Boolean(stored.requesterId) && (stored.requesterId === authUser.roleKey || stored.requesterId === normalizeUser(authUser).roleId);
  return isRequester || (p.canReceiveGoods && sameDept) || (p.canReview && (sameDept || p.canViewAllDepts));
}
// a save closes the claim when the claim is open, the role may close it and the status IS / BECOMES a closing one : a status change, or - when an earlier
// store already moved the PO to WAITING_DELIVERY_ROUND_2 and the last store is resolved at that same status - a claimResolution object in the save
function claimClosing({ authUser, stored, prevStatus, next, channel, department, body }) {
  const n = String(next || '').trim().toUpperCase();
  if (!n || !CLAIM_CLOSING_STATUSES.has(n) || !claimIsOpen(stored, prevStatus)) return false;
  if (n === String(prevStatus || '').trim().toUpperCase() && !(body && isPlain(body.claimResolution))) return false;
  return canCloseClaim(authUser, channel, stored, department);
}
function claimPatch(stored, body, a, out, closing = false) {
  const archive = [];
  const archived = {};
  for (const k of ['claimData', 'claimDetails', 'inlineClaimData']) {
    if (isPlain(body[k])) out[k] = stampClaim(stored[k], body[k], a, { archive, label: k });
    else if (body[k] === null && closing && isPlain(stored[k])) { archived[k] = stored[k]; out[k] = null; }
  }
  // PO level resolution record : only written together with the closing, who / when from the token
  if (closing && isPlain(body.claimResolution)) {
    const r = stampClaim(stored.claimResolution, body.claimResolution, a, { archive, label: 'claimResolution' });
    if (r.refundAmount !== undefined && (!Number.isFinite(Number(r.refundAmount)) || Number(r.refundAmount) < 0)) throw new HttpError(400, 'ยอดเงินคืนไม่ถูกต้อง');
    // who / when of the close are the token's whether or not the client sent them (workflowEngine.resolveClaim sends resolvedBy / resolvedAt)
    r.resolvedBy = a.name; r.resolvedById = a.id; r.resolvedAt = isoShaped(r.resolvedAt) || r.resolvedAt === undefined ? a.iso : a.stamp;
    out.claimResolution = r;
  }
  for (const k of ['claimEvidence', 'disputeInfo']) {
    const c = body[k];
    if (isPlain(c)) { if (!Array.isArray(stored[k])) out[k] = stampClaim(stored[k], c, a, { evidence: true, archive, label: k }); } // a stored photo list is not replaced by an object
    else if (Array.isArray(c) && !isPlain(stored[k])) {
      // a list of photos : added to what is stored, never replaces it ; entries that are objects get the inspector of the token
      const base = Array.isArray(stored[k]) ? stored[k] : [];
      const seen = new Set(base.map((x) => JSON.stringify(x)));
      const added = cleanDeep(c.filter((x) => x !== null && x !== undefined)).filter((x) => !seen.has(JSON.stringify(x)))
        .map((x) => (isPlain(x) ? { ...x, inspectorName: a.name, inspectedAt: a.iso } : x));
      out[k] = base.concat(added).slice(0, 200);
    }
  }
  if (isPlain(body.storeClaims)) {
    const ss = isPlain(stored.storeClaims) ? stored.storeClaims : {};
    const sc = {};
    let n = 0;
    for (const [key, v] of Object.entries(body.storeClaims)) {
      if (DANGEROUS_KEYS.has(key) || key.length > 200 || !isPlain(v)) continue;
      if (++n > 100) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด');
      sc[key] = stampClaim(Object.prototype.hasOwnProperty.call(ss, key) ? ss[key] : null, v, a, { archive, label: `storeClaims.${key}` });
    }
    out.storeClaims = sc;
  }
  // grAttachments : add-only ; claimPhoto : set once
  if (Array.isArray(body.grAttachments)) out.grAttachments = additiveMerge(Array.isArray(stored.grAttachments) ? stored.grAttachments : [], body.grAttachments).slice(0, 200);
  if (typeof body.claimPhoto === 'string' && (stored.claimPhoto === undefined || stored.claimPhoto === null || stored.claimPhoto === '')) out.claimPhoto = body.claimPhoto;
  const entries = [];
  if (Object.keys(archived).length > 0) entries.push({ action: 'CLAIM_DATA_ARCHIVED', actorName: a.name, date: a.stamp, timestamp: a.stamp, ...archived });
  // (ReceivingModal re-opens every disputed store under 2 keys : plat_name + name ; the total claimHistory size cap below bounds the volume)
  if (archive.length > 100) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด'); // nothing is dropped silently
  for (const x of archive) entries.push({ action: 'CLAIM_EDITED', field: x.field, previous: x.previous, actorName: a.name, date: a.stamp, timestamp: a.stamp });
  if (entries.length > 0) {
    const base = Array.isArray(out.claimHistory) ? out.claimHistory : (Array.isArray(stored.claimHistory) ? stored.claimHistory : []);
    const hist = base.concat(entries).slice(-500);
    if (JSON.stringify(hist).length > LOG_TOTAL_MAX) throw new HttpError(413, 'ขนาดข้อมูลเกินกำหนด');
    out.claimHistory = hist;
  }
}

// ── PO / PR line + attachment guards (POST upsert / PUT) ──
// receivedQty / goodQty / defectiveQty : finite, >= 0 ; a save never LOWERS the figure the server holds (goods received through /receive stay received ; the
// receiving screen itself saves its cumulative figures through PUT, which can only raise them). After the settlement the actual unit prices are fixed.
// In a final status evidence / attachments can only be added to.
const FINAL_DOC_STATUSES = new Set(['CLOSED', 'RECEIVED', 'SETTLED', 'CANCELLED']);
const isFinalStatus = (s) => FINAL_DOC_STATUSES.has(String(s || '').trim().toUpperCase());
const LINE_QTY_KEYS = ['receivedQty', 'goodQty', 'defectiveQty'];
const LINE_PRICE_KEYS = ['actualUnitPrice', 'actUnitPrice', 'actualPrice'];
const lineKeyOf = (it) => (it && (it.productId || it.id || it.code)) || '';
// Lines of a PO (non-admin) :
//  - the stored lines cannot be removed or re-keyed (productId | id | code) -> 400 ; adding a line is not touched
//  - once the PO is past the ordering step the ordered qty / unit price / price are fixed (the online purchaser is exempt : acknowledgeOnlineTask edits them
//    while the stored status is still IN_PROGRESS_ONLINE, and the online hub keeps the right to correct an order) ; client flows that edit lines later
//    (ReceivingModal received / damaged / shortage / refund fields, claim resolution) only touch the claim + received fields below
//  - in a final status (CLOSED / SETTLED / CANCELLED / COMPLETED*) a claim / refund / price figure that is already set cannot be changed
//  - received / good qty never go down and never above the stored ordered qty
// admin may correct anything ; changes to a closed PO's qty / price are reported through `notes` (the caller writes an audit row).
const hasGrn = (extra) => Boolean(extra && Array.isArray(extra.grnHistory) && extra.grnHistory.length > 0);
const PRE_ORDER_STATUSES = new Set(['', ...PO_PRE_ORDER]); // the same set the transition rules use (rbac.js)
// The ordered qty of a PO line, read the same way everywhere (PR ceiling, line guard, receive, ceilings) : the HIGHEST positive of the qty keys, else 1.
const QTY_KEYS = ['orderedQty', 'purchaseQty', 'qty', 'quantity'];
const orderedQtyOf = (line) => {
  let m = 0;
  for (const k of QTY_KEYS) { const n = Number(line && line[k]); if (Number.isFinite(n) && n > m) m = n; }
  return m > 0 ? m : 1;
};
// A PO body's status: trimmed + upper-cased at the single entry (a non-string / unknown value is refused for a non-admin) -> an error response or null
function checkPoStatus(p, authUser) {
  if (p.status === undefined || p.status === null) return null;
  const ns = normalizePoStatus(p.status);
  if (ns === null) return { message: 'สถานะ PO ไม่ถูกต้อง', status: 400 };
  if (!ns) { delete p.status; return null; }
  if (!normalizeUser(authUser).isAdmin && !PO_CLIENT_STATUSES.has(ns)) return { message: 'สถานะ PO ไม่ถูกต้อง', status: 400 };
  p.status = ns;
  return null;
}
const ORDER_FREE_STATUSES = new Set(['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'ISSUED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'PENDING_APPROVAL']);
// (conversionRate / conversionRatio : the stock a receipt adds is received qty x conversion, so it is fixed with the order like the price)
const LINE_ORDER_KEYS = ['qty', 'purchaseQty', 'orderedQty', 'quantity', 'unitPrice', 'price', 'conversionRate', 'conversionRatio'];
const LINE_CLAIM_KEYS = ['refundAmount', 'refundedQty', 'claimResolution', 'damagedQty', 'shortageQty', 'unitPrice', 'actualPrice', 'price'];

// ctx for rbac.canTransitionPO (closing a PO with an open claim) : is the caller the requester who owns this PO's PR (by id, else by
// exact name ; the PO's own requesterId/requesterName in extraJson count too), and is it an online task
async function poOwnerCtx(db, authUser, poId) {
  const out = { isOwner: false, isOnlinePo: false };
  if (!db || !poId) return out;
  try {
    const po = await db.prepare('SELECT prId, prNumber, purchaseChannel, extraJson FROM pos WHERE id = ? OR poNumber = ? ORDER BY (id = ?) DESC LIMIT 1').bind(poId, poId, poId).first();
    if (!po) return out;
    const extra = parseJsonSafe(po.extraJson, {}) || {};
    const channel = String(po.purchaseChannel || extra.purchaseChannel || extra.channel || '').toUpperCase();
    out.isOnlinePo = channel === 'ONLINE' || channel === 'ONLINE_PURCHASE';
    const ids = new Set(); const names = new Set();
    const add = (id, name) => { if (id) ids.add(String(id)); if (name) names.add(String(name).trim()); };
    add(extra.requesterId, extra.requesterName || extra.requestedBy);
    const refs = [po.prId, po.prNumber].filter(Boolean);
    if (refs.length) {
      const pr = await db.prepare('SELECT requesterId, requesterName FROM prs WHERE id = ? OR prNumber = ? OR id = ? OR prNumber = ? LIMIT 1')
        .bind(refs[0], refs[0], refs[1] || refs[0], refs[1] || refs[0]).first();
      if (pr) add(pr.requesterId, pr.requesterName);
    }
    const myId = String(authUser.userId || authUser.id || '');
    const myName = String(authUser.name || authUser.username || '').trim();
    out.isOwner = Boolean((myId && ids.has(myId)) || (myName && names.has(myName)));
  } catch { /* fail closed : not the owner */ }
  return out;
}
const isFinalLineStatus = (s) => { const u = String(s || '').trim().toUpperCase(); return ['CLOSED', 'SETTLED', 'CANCELLED'].includes(u) || u.startsWith('COMPLETED'); };
const hasValue = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== false;
function guardPoItems(stored, client, { admin = false, lockPrice = false, onlineish = false, storedStatus = '', notes = null, grnStarted = false } = {}) {
  const base = Array.isArray(stored) ? stored : [];
  const st = String(storedStatus || '').trim().toUpperCase();
  // Receiving has started when a GRN is on the PO or a stored line already holds received / good qty : the PO can no longer be "moved back" to unlock it.
  const started = Boolean(grnStarted) || base.some((x) => isPlain(x) && (Number(x.receivedQty) > 0 || Number(x.goodQty) > 0));
  // (a non-online user : the lines are fixed from the first status in which goods can be received - ISSUED / PO_ISSUED included ; no client flow of a
  // requester / receiver edits qty or price there. The online purchaser, who does at IN_PROGRESS_ONLINE (acknowledgeOnlineTask), is exempt only while the
  // PO is still in an ordering status AND nothing was received ; admin may correct anything.)
  const onlineFree = onlineish && !started && ORDER_FREE_STATUSES.has(st);
  const orderLocked = !admin && !onlineFree && base.length > 0 && (started || !PRE_ORDER_STATUSES.has(st));
  const finalLocked = !admin && isFinalLineStatus(st);
  if (!admin && base.length > 0) {
    const bad = () => new HttpError(400, 'ไม่สามารถลดหรือเปลี่ยนรายการสินค้าใน PO ได้');
    if (client.length < base.length) throw bad();
    const cnt = (arr) => { const m = new Map(); for (const x of arr) { const k = lineKeyOf(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
    const have = cnt(client);
    for (const [k, n] of cnt(base)) if ((have.get(k) || 0) < n) throw bad();
    // the stored lines keep their positions (the stock log id and its ceiling are per line position) : a re-ordered list is refused
    for (let i = 0; i < base.length; i += 1) {
      const bk = lineKeyOf(base[i]);
      if (bk && lineKeyOf(client[i]) !== bk) throw bad();
    }
    // no client flow adds a line after the PO was made (acknowledgeOnlineTask only maps the existing lines) : nobody but admin, in any status
    if (client.length > base.length) {
      throw new HttpError(400, 'ไม่สามารถเพิ่มรายการสินค้าใน PO หลังสร้างแล้ว');
    }
  }
  const auditable = admin && (isFinalLineStatus(st) || lockPrice);
  return client.map((it, idx) => {
    if (!isPlain(it)) return it;
    const key = lineKeyOf(it);
    // the same product can be on several lines (online : one per store) : same position wins when it is the same product, otherwise the n-th
    // occurrence of that product on the client side pairs with the n-th stored line of it (never "always the first")
    let s;
    if (!key) s = base[idx];
    else if (isPlain(base[idx]) && lineKeyOf(base[idx]) === key) s = base[idx];
    else {
      let nth = 0;
      for (let j = 0; j < idx; j += 1) if (lineKeyOf(client[j]) === key) nth += 1;
      s = base.filter((x) => isPlain(x) && lineKeyOf(x) === key)[nth];
    }
    const out = { ...it };
    for (const k of ['conversionRate', 'conversionRatio']) {
      if (out[k] === undefined || out[k] === null || out[k] === '') continue;
      const n = Number(out[k]);
      if (!Number.isFinite(n) || n <= 0 || n > CONV_MAX) throw new HttpError(400, 'อัตราแปลงหน่วยไม่ถูกต้อง');
    }
    for (const k of LINE_QTY_KEYS) {
      if (out[k] === undefined || out[k] === null || out[k] === '') continue;
      const n = Number(out[k]);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'จำนวนที่รับไม่ถูกต้อง');
      out[k] = n;
      if (isPlain(s) && !admin) {
        const sv = Number(s[k]);
        // ceiling = the stored ordered qty, found the same way the receive endpoint finds it (first positive of orderedQty / purchaseQty / qty / quantity, else 1)
        const cap = orderedQtyOf(s);
        if (k !== 'defectiveQty' && Number.isFinite(cap) && cap > 0) out[k] = Math.min(out[k], Math.max(cap, Number.isFinite(sv) ? sv : 0));
        if (Number.isFinite(sv) && out[k] < sv) out[k] = sv;
      }
    }
    // damagedQty : a finite number >= 0, never above the ordered qty (clamped for a non-admin). It may go DOWN (claim REFUND / WRITE_OFF reset it to 0) and stay
    // (REPLACEMENT) - the stock card never trusts it as a ceiling (IN_NG is bound by the ordered qty minus the stock logs of the PO line).
    if (out.damagedQty !== undefined && out.damagedQty !== null && out.damagedQty !== '') {
      const dn = Number(out.damagedQty);
      if (!Number.isFinite(dn) || dn < 0) throw new HttpError(400, 'จำนวนที่รับไม่ถูกต้อง');
      out.damagedQty = admin ? dn : Math.min(dn, orderedQtyOf(isPlain(s) ? s : out));
    }
    if (lockPrice && !admin && isPlain(s)) {
      for (const k of LINE_PRICE_KEYS) { if (k in s) out[k] = s[k]; else delete out[k]; }
    }
    if (isPlain(s) && !admin) {
      // the conversion of a stored line is never re-set by a save, by anybody but admin, in any status (it decides how much stock a receipt adds ;
      // acknowledgeOnlineTask edits qty / price only and keeps the line's rate)
      for (const k of ['conversionRate', 'conversionRatio', 'prRowIndex']) { if (k in s) out[k] = s[k]; else delete out[k]; }
    }
    if (isPlain(s) && orderLocked) {
      for (const k of LINE_ORDER_KEYS) { if (k in s) out[k] = s[k]; else delete out[k]; }
    }
    // once goods are received the actual prices are fixed too (the receipt cost fallback reads them) ; the settlement writes them through POST /settle
    if (isPlain(s) && started && !admin) {
      for (const k of LINE_PRICE_KEYS) { if (k in s) out[k] = s[k]; else delete out[k]; }
    }
    if (isPlain(s) && finalLocked) {
      for (const k of LINE_CLAIM_KEYS) if (hasValue(s[k])) out[k] = s[k];
    }
    if (notes && isPlain(s) && (auditable || (admin && LINE_QTY_KEYS.some((k) => Number.isFinite(Number(s[k])) && Number(out[k]) < Number(s[k]))))) {
      for (const k of [...LINE_ORDER_KEYS, ...LINE_PRICE_KEYS, ...LINE_QTY_KEYS]) {
        if (k in out && !(Number(out[k]) === Number(s[k])) && !(out[k] === s[k])) notes.push({ line: key || idx, field: k, from: s[k] ?? null, to: out[k] });
      }
    }
    return out;
  });
}
function additiveMerge(stored, client) {
  if (Array.isArray(stored)) {
    if (!Array.isArray(client)) return stored;
    const seen = new Set(stored.map((x) => JSON.stringify(x)));
    return stored.concat(cleanDeep(client).filter((x) => x !== null && x !== undefined && !seen.has(JSON.stringify(x))));
  }
  if (isPlain(stored)) {
    if (!isPlain(client)) return stored;
    const out = { ...stored };
    for (const [k, v] of Object.entries(client)) {
      if (DANGEROUS_KEYS.has(k) || v === null || v === undefined) continue;
      out[k] = k in stored ? additiveMerge(stored[k], v) : cleanDeep(v);
    }
    return out;
  }
  return stored === undefined || stored === null ? cleanDeep(client) : stored;
}
// the line of a GRN entry in grnHistory : only the fields the screens / PDF / stock card read (ReceivingModal, OnlineOrderCard, storageService.getGRNs), bounded
// statuses in which goods may be received (web workflowEngine.receiveGoods / PODetailsModal receivable list + the claim / waiting-round-2 statuses of the
// ReceivingModal flow). TERMINAL ones answer "duplicate" on the full receive. stockOnly runs after the client saved the PO, so it also takes the closing ones.
const RECEIVE_OPEN_STATUSES = new Set(['ISSUED', 'PO_ISSUED', 'ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'SHIPPED', 'IN_PROGRESS_ONLINE', 'PARTIAL', 'PARTIAL_RECEIVED', 'PARTIALLY_RECEIVED',
  'PARTIALLY_RECEIVED_IN_CLAIM', 'WAITING_DELIVERY_ROUND_2', 'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'CLAIM_PENDING']);
const RECEIVE_TERMINAL_STATUSES = new Set(['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND']);
const RECEIVE_STOCK_STATUSES = new Set([...RECEIVE_OPEN_STATUSES, 'CLOSED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND']);
const RECEIVE_QTY_MAX = 10000000;
const CONV_MAX = 10000;
// good quantity of a received line : goodQty / receivedQty / receiveQty, or receivedThisTime (what quick-receive sends : { productId, receivedThisTime })
const recvGoodOf = (r) => Number(r.goodQty ?? r.receivedQty ?? r.receiveQty ?? r.receivedThisTime ?? 0);
const GRN_ITEM_STR =['code', 'name', 'unit', 'storageLocation', 'condition', 'shortageAction', 'shortageReason', 'disputeAction'];
const GRN_ITEM_NUM = ['goodQty', 'defectiveQty', 'damagedQty', 'shortageQty', 'receivedThisTime', 'orderedQty'];
function grnItemView(rItem, line) {
  const out = { productId: String((line && (line.productId || line.id)) || '').slice(0, 120) };
  for (const k of GRN_ITEM_STR) if (typeof rItem[k] === 'string') out[k] = rItem[k].slice(0, 200);
  for (const k of GRN_ITEM_NUM) { const n = Number(rItem[k]); if (rItem[k] !== undefined && rItem[k] !== null && rItem[k] !== '' && Number.isFinite(n)) out[k] = n; }
  const reason = rItem.defectReason ?? rItem.defectNote ?? rItem.note;
  if (typeof reason === 'string') out.defectReason = reason.slice(0, 500);
  out.goodQty = recvGoodOf(rItem);
  out.defectiveQty = Number(rItem.defectiveQty || 0);
  return out;
}
// evidence / attachments value to store. current = the stored value (undefined for a new row), sent = the body value (undefined = not sent)
function guardedDocBlob(current, sent, existing, status, empty) {
  if (!existing) return sent === undefined || sent === null ? empty : cleanDeep(sent);
  if (sent === undefined || sent === null) return current === undefined || current === null ? empty : current;
  if (isFinalStatus(status)) return additiveMerge(current === undefined || current === null ? empty : current, sent);
  return cleanDeep(sent);
}
// ordering : a new orderedAt (ISO, within 10 minutes of the server clock - so the value a client keeps in its copy equals the stored one) is a new
// ordering event stamped with the token's name ; otherwise the stored orderedBy / orderedAt stay
function orderedPatch(stored, body, a, out) {
  if (body.orderedAt === undefined && body.orderedBy === undefined) return;
  const sAt = stored.orderedAt; const sBy = stored.orderedBy;
  const t = Date.parse(body.orderedAt);
  const fresh = isoShaped(body.orderedAt) && Number.isFinite(t) && Math.abs(Date.now() - t) <= 600000;
  const event = (sAt === undefined && sBy === undefined) ? Boolean(body.orderedAt || body.orderedBy) : (body.orderedAt !== sAt && fresh);
  if (event) { out.orderedBy = a.name; out.orderedAt = fresh ? body.orderedAt : a.iso; return; }
  // (undefined overrides the client's value in Object.assign and is dropped by JSON.stringify : nothing is written)
  out.orderedBy = sBy;
  out.orderedAt = sAt;
}

async function docServerPatch(db, authUser, kind, { stored, body, next, isExisting = false, prevStatus = null, channel = null, department = null, grandTotal = 0, totalAmount = 0 }) {
  const a = actorOf(authUser);
  const out = {};
  const logKeys = kind === 'PO' ? PO_LOG_KEYS : PR_LOG_KEYS;
  let grnAdded = 0;
  for (const k of logKeys) {
    if (!Array.isArray(body[k])) continue;
    const before = Array.isArray(stored[k]) ? stored[k].length : 0;
    const legacy = Boolean(isExisting) && !isLogSealed(stored.logSealed, k) && !Array.isArray(stored[k]);
    out[k] = mergeLog(stored[k], body[k], a, 500, legacy);
    if (k === 'grnHistory' && !legacy) grnAdded = out[k].length - before;
  }
  // a row created through the server has every key sealed from the start ; an older row seals a key only once the server holds it
  out.logSealed = isExisting ? sealLogKeys(stored, logKeys, Object.keys(out)) : true;
  if (kind === 'PO') {
    orderedPatch(stored, body, a, out);
    const closing = isExisting && claimClosing({ authUser, stored, prevStatus, next, channel, department, body });
    claimPatch(stored, body, a, out, closing);
    // PO level refund figures (BudgetView / hub read them before the lines) : written only while a claim is being closed or a store claim is being
    // resolved by someone who may resolve it, finite, >= 0 and not above the PO value
    if (isExisting && claimIsOpen(stored, prevStatus) && canCloseClaim(authUser, channel, stored, department)
      && (closing || (isPlain(body.storeClaims) && Object.entries(body.storeClaims).some(([key, v]) => isPlain(v) && v.isResolved === true
        && !(isPlain(stored.storeClaims) && isPlain(stored.storeClaims[key]) && stored.storeClaims[key].isResolved === true))))) {
      for (const k of ['refundAmount', 'totalRefunded']) {
        if (body[k] === undefined || body[k] === null || body[k] === '') continue;
        const n = Number(body[k]);
        // ceiling = the PO value (grandTotal, else totalAmount) ; a PO with no value cannot be refunded
        const cap = Number(grandTotal) > 0 ? Number(grandTotal) : (Number(totalAmount) > 0 ? Number(totalAmount) : 0);
        if (!Number.isFinite(n) || n < 0 || n > cap + 0.01) throw new HttpError(400, 'ยอดเงินคืนไม่ถูกต้อง');
        out[k] = n;
      }
    }
    if (Object.keys(out).includes('claimHistory') && isExisting) out.logSealed = sealLogKeys(stored, logKeys, Object.keys(out));
  }
  if (next && (kind === 'PR' || body.workflowStatus !== undefined || stored.workflowStatus !== undefined)) out.workflowStatus = next;
  if (body.fullyReceivedAt && !stored.fullyReceivedAt) out.fullyReceivedAt = a.stamp;
  if (kind === 'PO') {
    if (body.closedBy && !stored.closedBy) { out.closedBy = a.name; out.closedDate = a.stamp; }
    const sentReceiver = RECEIVER_KEYS.some((k) => body[k] !== undefined && body[k] !== null);
    // a receipt was recorded (grnHistory grew) or this is the first time receiver details arrive : the receiver is the token user
    if (grnAdded > 0 || (sentReceiver && !stored.receivingInfo)) Object.assign(out, await receiverPatch(db, authUser));
  }
  return out;
}

// -> JSON string of the extra patch, or null when it is too large
// stored = the row's current extra : the size / key count are checked on the RESULT of the json_patch (stored + patch), not on the patch alone,
// so many small saves cannot grow a row without bound (a row is limited to 2 MB in D1)
const EXTRA_MAX_KEYS = 300;
function mergePatchPlain(t, p) {
  if (!isPlain(p)) return p;
  const out = isPlain(t) ? { ...t } : {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (v === null) delete out[k]; else out[k] = mergePatchPlain(out[k], v);
  }
  return out;
}
function extraPatchJson(extra, stored) {
  const s = JSON.stringify(extra);
  if (s.length > EXTRA_MAX_CHARS) return null;
  if (stored && typeof stored === 'object') {
    const merged = mergePatchPlain(stored, JSON.parse(s));
    if (Object.keys(merged).length > EXTRA_MAX_KEYS || JSON.stringify(merged).length > EXTRA_MAX_CHARS) return null;
  }
  return s;
}
function parseExtra(extraJson) {
  if (!extraJson) return {};
  try { const e = JSON.parse(extraJson); return e && typeof e === 'object' && !Array.isArray(e) ? e : {}; } catch { return {}; }
}
// the PR as the client reads it : extra fields on top level (columns win), requestedBy falls back to the requester's name
function prView(r) {
  const extra = parseExtra(r.extraJson);
  delete extra.logSealed; // server bookkeeping
  const view = { ...extra, ...utcIsoRow(r) };
  if (!view.requestedBy) view.requestedBy = r.requesterName || '';
  return view;
}
// names the UI reads for a PO row (poNo / prNo ; the D1 columns are poNumber / prNumber) ; the UI name is always the D1 value
const poAliasOf = (r) => ({ poNo: r.poNumber, prNo: r.prNumber });
function poExtraView(extraJson) {
  const extra = parseExtra(extraJson);
  delete extra.approvedTotal; // server bookkeeping, never part of the document
  delete extra.logSealed;
  return extra;
}

// JSON body with a hard size limit. -> { tooBig: true } | { body } (body = {} when empty / not JSON)
async function readJsonLimited(request, maxBytes) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxBytes) return { tooBig: true };
  if (!request.body) return { body: {} };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); return { tooBig: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  try { return { body: JSON.parse(new TextDecoder().decode(all)) }; } catch { return { body: {} }; }
}

function str100(v, max = 100) {
  return v === undefined || v === null ? '' : String(v).trim().slice(0, max);
}

function safeEqualStr(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Mirrors src/config/constants.js resolveUserPermissions(user).id : the frontend (and GAS) record
// requesterId/actorId as the user's role id, not the user row id.
function resolveRoleKey(user) {
  const level = Number(user.level || 1);
  const isOnline = user.roleId === 'ONLINE_PURCHASER' || user.role_id === 'ONLINE_PURCHASER';
  return user.roleId || user.role_id
    || (level >= 99 ? 'ADMIN' : level >= 3 ? 'APPROVER' : level >= 2 ? (isOnline ? 'ONLINE_PURCHASER' : 'REVIEWER') : 'REQUESTER');
}

function isUserActive(u) {
  return !!u && (u.isActive === true || String(u.isActive).toLowerCase() === 'true' || u.isActive === 1 || u.status === 'ACTIVE');
}

let dummyRecordPromise = null;
function getDummyRecord() {
  if (!dummyRecordPromise) {
    dummyRecordPromise = hashPassword('dummy-password-for-timing').catch((e) => { dummyRecordPromise = null; throw e; });
  }
  return dummyRecordPromise.then((r) => ({ hash: r.hash, salt: r.salt, iterations: r.iterations, algo: r.algo }));
}

const FORBIDDEN_MSG = 'ไม่มีสิทธิ์ดำเนินการนี้';

// stock quantity from a JSON body : a number or a plain decimal string only (no booleans / arrays / "5abc" / exponent forms). The screens' inputs are
// step="any" and "issue all" sends the raw balance (0.30000000000000004), so extra decimals are ROUNDED to 4 dp (the precision the balance is kept in),
// never refused. Then : > 0 and at most STOCK_QTY_MAX. Returns { qty } or { error } (Thai reason).
const STOCK_QTY_MAX = 10000000;
const STOCK_MANUAL_PER_MIN = 30; // adjust / manual-in per user per minute
const round4 = (x) => Math.round((Number(x) + Number.EPSILON) * 10000) / 10000;
function parseStockQty(raw) {
  let s;
  if (typeof raw === 'number') { if (!Number.isFinite(raw)) return { error: 'จำนวนต้องเป็นตัวเลข' }; s = String(raw); }
  else if (typeof raw === 'string') s = raw.trim();
  else return { error: 'จำนวนต้องเป็นตัวเลข' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: 'จำนวนต้องเป็นตัวเลขที่ไม่ติดลบและไม่ใช้รูปแบบยกกำลัง' };
  const v = round4(Number(s));
  if (!(v > 0)) return { error: 'จำนวนต้องมากกว่า 0 (ทศนิยมสูงสุด 4 ตำแหน่ง)' };
  if (v > STOCK_QTY_MAX) return { error: `จำนวนมากเกินไป (ไม่เกิน ${STOCK_QTY_MAX.toLocaleString('en-US')})` };
  return { qty: v };
}

// PR / PO writes (and the goods-receipt / settle routes that store evidence files in a PO) : the handlers record the ids they wrote in state.touched ;
// those documents get their file_refs index rows rebuilt and a PR binds its saver's still unbound uploads to its number (functions/_lib/filerefs.js).
// Nothing else is reindexed (no "recently updated" scan).
export async function onRequest(context) {
  const state = {};
  const res = await handleRequest(context, state);
  try {
    if (state.touched && state.authUser && context.env && context.env.DB) {
      await reindexTouched(context.env.DB, state.touched, state.authUser.userId);
    }
  } catch { /* the index is a lookup aid : never fails the request */ }
  return res;
}

async function handleRequest(context, state) {
  const { env } = context;
  let { request } = context;
  const url = new URL(request.url);
  // One canonical path for BOTH authorization and routing (a mismatch lets e.g. "/api/budgets/adjust/" skip its rule)
  const rawPath = url.pathname;
  let badPath = /\/\/|%2f|%5c|%2e|%00/i.test(rawPath);
  if (!badPath) {
    try { decodeURIComponent(rawPath); } catch { badPath = true; } // malformed %-sequence -> 400 (not a 500)
  }
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  const method = request.method;

  // CORS : exact-match allow-list from env.ALLOWED_ORIGINS (see functions/_lib/cors.js) ; the preflight follows the same rule
  const corsHeaders = buildCorsHeaders(env, request);

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: corsHeaders
    });
  };

  const errorResponse = (msg, status = 500) => {
    return new Response(JSON.stringify({ error: msg, success: false }), {
      status,
      headers: corsHeaders
    });
  };

  if (badPath) return errorResponse('เส้นทางไม่ถูกต้อง', 400);

  // JSON writes without a Content-Length (chunked) : read the stream with a byte cap (413 as soon as it is exceeded) and hand the
  // handlers an equivalent request, instead of letting request.json() buffer an unbounded body. /api/upload does its own gate.
  // Everything except login is read AFTER authentication + RBAC (see the size gate below) so an unauthenticated caller can never make the
  // server buffer a body ; login itself has no token yet, so it is capped here (its limit is the small general one).
  const needsStreamCap = () => method !== 'GET' && method !== 'HEAD' && path !== '/api/upload' && request.body
    && !/^\d+$/.test(String(request.headers.get('Content-Length') ?? '').trim());
  const streamCap = async () => {
    const got = await readBodyLimited(request, DOC_WRITE_RE.test(path) ? DOC_WRITE_MAX_BYTES : JSON_WRITE_MAX_BYTES);
    if (got.tooLarge) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
    request = rebuildRequest(request, got.bytes);
    return null;
  };
  if (/^\/api\/(auth(\/login)?|login)$/.test(path) && needsStreamCap()) {
    const tooLarge = await streamCap();
    if (tooLarge) return tooLarge;
  }

  const db = env.DB;

  const parseJsonSafe = (str, fallback = []) => {
    if (!str) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback; }
  };

  const formatSafeUser = (u) => {
    if (!u) return null;
    u = utcIsoRow(u);
    const safe = sanitizeUser(u);

    const rawLevel = Number(u.level || 1);
    const roleStr = String((u.roleId || '') + ' ' + (u.canonicalRole || '') + ' ' + (u.positionKey || '') + ' ' + (u.title || '')).toUpperCase();
    const isAdmin = rawLevel >= 99 || String(u.roleId || '') === 'ADMIN'; // T4.6 : same as rbac.normalizeUser
    const level = isAdmin ? 99 : rawLevel;
    const isOnline = !isAdmin && (roleStr.includes('ONLINE_PURCHASER') || u.canonicalRole === 'PURCHASER');
    const isApprover = isAdmin || level >= 3 || roleStr.includes('APPROV') || roleStr.includes('PLANT_MANAGER');
    const isReviewer = isAdmin || (!isOnline && (isApprover || level >= 2 || roleStr.includes('REVIEW') || roleStr.includes('ASST_MANAGER')));
    const isPurchaser = isAdmin || isOnline || roleStr.includes('PURCHAS');
    const isRequester = isAdmin || (!isOnline && (roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC') || level === 1));

    let depts = parseJsonSafe(u.allowedDepartments, null);
    if (!depts || !Array.isArray(depts) || depts.length === 0) {
      depts = u.allowedDepartments ? String(u.allowedDepartments).split(',').map(d => d.trim()).filter(Boolean) : [u.department || 'PD'];
    }

    const canCreatePR = isAdmin ? true : (u.canCreatePR !== undefined && u.canCreatePR !== null ? Boolean(Number(u.canCreatePR)) : Boolean(!isOnline && isRequester));
    const canSubmitPR = isAdmin ? true : (u.canSubmitPR !== undefined && u.canSubmitPR !== null ? Boolean(Number(u.canSubmitPR)) : canCreatePR);
    const canDeleteOwnDraft = isAdmin ? true : (u.canDeleteOwnDraft !== undefined && u.canDeleteOwnDraft !== null ? Boolean(Number(u.canDeleteOwnDraft)) : Boolean(!isOnline && level >= 1));
    const canReview = isAdmin ? true : (u.canReview !== undefined && u.canReview !== null ? Boolean(Number(u.canReview)) : Boolean(!isOnline && level >= 2));
    const canFinalApprove = isAdmin ? true : (u.canFinalApprove !== undefined && u.canFinalApprove !== null ? Boolean(Number(u.canFinalApprove)) : Boolean(level >= 3));
    const canOnlinePurchase = isAdmin ? true : (u.canOnlinePurchase !== undefined && u.canOnlinePurchase !== null ? Boolean(Number(u.canOnlinePurchase)) : Boolean(isOnline));
    const canReceiveGoods = isAdmin ? true : (u.canReceiveGoods !== undefined && u.canReceiveGoods !== null ? Boolean(Number(u.canReceiveGoods)) : Boolean(!isOnline && (level === 1 || roleStr.includes('WH'))));
    const canCloseOwnPO = isAdmin ? true : (u.canCloseOwnPO !== undefined && u.canCloseOwnPO !== null ? Boolean(Number(u.canCloseOwnPO)) : Boolean(isOnline || level === 1));
    const canManageMaster = isAdmin ? true : (u.canManageMaster !== undefined && u.canManageMaster !== null ? Boolean(Number(u.canManageMaster)) : Boolean(!isOnline && level >= 1));
    const canDeleteMaster = isAdmin ? true : (u.canDeleteMaster !== undefined && u.canDeleteMaster !== null ? Boolean(Number(u.canDeleteMaster)) : false);
    const canViewBudget = isAdmin ? true : (u.canViewBudget !== undefined && u.canViewBudget !== null ? Boolean(Number(u.canViewBudget)) : Boolean(!isOnline && level >= 2));
    const canViewBudgetMenu = isAdmin ? true : (u.canViewBudgetMenu !== undefined && u.canViewBudgetMenu !== null ? Boolean(Number(u.canViewBudgetMenu)) : Boolean(!isOnline && level >= 2));
    const canSetBudget = isAdmin ? true : (u.canSetBudget !== undefined && u.canSetBudget !== null ? Boolean(Number(u.canSetBudget)) : Boolean(level >= 3));
    const canViewAllDepts = isAdmin ? true : (u.canViewAllDepts !== undefined && u.canViewAllDepts !== null ? Boolean(Number(u.canViewAllDepts)) : Boolean(isOnline || level >= 2 || (u.department === 'ALL')));

    const permissions = {
      PR_CREATION: Boolean(isAdmin || canCreatePR),
      REVIEW: Boolean(isAdmin || canReview),
      APPROVAL: Boolean(isAdmin || canFinalApprove),
      PURCHASING: Boolean(isAdmin || canOnlinePurchase || isPurchaser),
      INVENTORY: Boolean(isAdmin || canReceiveGoods),
      ADMIN: Boolean(isAdmin)
    };

    return {
      ...safe,
      level,
      isAdmin,
      isApprover,
      isReviewer,
      isPurchaser,
      isRequester,
      isOnline,
      canCreatePR,
      canSubmitPR,
      canDeleteOwnDraft,
      canReview,
      canFinalApprove,
      canOnlinePurchase,
      canReceiveGoods,
      canCloseOwnPO,
      canManageMaster,
      canDeleteMaster,
      canViewBudget,
      canViewBudgetMenu,
      canSetBudget,
      canViewAllDepts,
      permissions,
      allowedDepartments: depts,
      assignedDepartments: depts,
      departments: depts
    };
  };

  try {
    // Fail closed: no signing secret configured -> whole API is disabled
    if (!hasSecret(env)) {
      return errorResponse('Server authentication is not configured', 500);
    }

    // ── 1. Auth Endpoint (/api/auth/login or /api/auth or /api/login) ──
    if (path === '/api/auth/login' || path === '/api/auth' || path === '/api/login') {
      if (method === 'POST') {
        // a login body is a few dozen bytes : refuse anything above 8 KB before it is parsed (Content-Length, and a counted stream when it is absent)
        const lim = await readJsonLimited(request, 8 * 1024);
        if (lim.tooBig) return errorResponse('ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป', 413);
        const body = lim.body && typeof lim.body === 'object' && !Array.isArray(lim.body) ? lim.body : {};
        const cleanUser = String(body.username || '').trim().toLowerCase();
        const cleanPass = String(body.password || '').trim();

        if (!cleanUser) return errorResponse('Username is required', 400);
        if (!cleanPass) return errorResponse('กรุณากรอกรหัสผ่าน', 400);

        if (!db) {
          return errorResponse('D1 Database binding (env.DB) is not available', 500);
        }

        const nowMs = Date.now();
        const attemptId = cleanUser.slice(0, 100);
        const clientIp = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
        const userAgent = (request.headers.get('User-Agent') || '').slice(0, 200);

        const user = await db.prepare(
          `SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(employeeId) = ? OR LOWER(email) = ? LIMIT 1`
        ).bind(cleanUser, cleanUser, cleanUser).first();

        // Per-user counter keys on the resolved userId (aliases share one counter); unknown -> typed text
        const attemptKey = user ? `id:${user.id}` : `name:${attemptId}`;
        const nonce = `${userAgent}#${globalThis.crypto.randomUUID()}`;

        // Atomic rate limit: record this attempt as a pending failure and count in ONE batch (transaction).
        // D1 serializes concurrent batches, so the 6th+ attempt always sees count > 5.
        const windowStart = nowMs - LOGIN_WINDOW_MS;
        const insertSql = 'INSERT INTO login_attempts (kind, identifier, success, attemptedAt, ip, userAgent) VALUES (?, ?, 0, ?, ?, ?)';
        const countSql = 'SELECT COUNT(*) AS c FROM login_attempts WHERE kind = ? AND identifier = ? AND success = 0 AND attemptedAt > ?';
        const batchRes = await db.batch([
          db.prepare(insertSql).bind('USER', attemptKey, nowMs, clientIp, nonce),
          db.prepare(insertSql).bind('IP', clientIp, nowMs, clientIp, nonce),
          db.prepare(countSql).bind('USER', attemptKey, windowStart),
          db.prepare(countSql).bind('IP', clientIp, windowStart)
        ]);
        const countOf = (r) => Number(((r && r.results && r.results[0]) || {}).c || 0);
        // housekeeping (same idea as upload_attempts) : the first attempt of a key sweeps rows older than 24h (the lock window is 15 min)
        if (countOf(batchRes[2]) === 1) await db.prepare('DELETE FROM login_attempts WHERE attemptedAt < ?').bind(nowMs - 24 * 3600 * 1000).run().catch(() => {});
        if (countOf(batchRes[2]) > LOGIN_MAX_FAILS || countOf(batchRes[3]) > LOGIN_MAX_FAILS_IP) {
          // rejected attempts are not kept (an attacker cannot extend a victim's lock indefinitely)
          await db.prepare('DELETE FROM login_attempts WHERE userAgent = ?').bind(nonce).run().catch(() => {});
          return errorResponse(LOGIN_LOCK_MSG, 429);
        }
        // the pending row stays = counted as a failure ; it is removed on success below
        const failResponse = () => errorResponse(LOGIN_FAIL_MSG, 401);

        if (cleanPass.length > MAX_PASSWORD_LENGTH) return failResponse();

        if (!user) {
          // equalize timing with the real verification path (don't reveal that the username doesn't exist)
          await verifyPassword(cleanPass, await getDummyRecord());
          return failResponse();
        }

        const hasHash = typeof user.passwordHash === 'string' && user.passwordHash && typeof user.passwordSalt === 'string' && user.passwordSalt;
        const legacyPlain = typeof user.password === 'string' ? user.password : '';
        let needsStore = false; // hash (re)store required
        if (hasHash) {
          const ok = await verifyPassword(cleanPass, {
            hash: user.passwordHash,
            salt: user.passwordSalt,
            iterations: Number(user.passwordIterations),
            algo: user.passwordAlgo
          });
          if (!ok) return failResponse();
          needsStore = Number(user.passwordIterations) < PASSWORD_ITERATIONS;
        } else {
          // transition: plaintext in `password` -> compare, then hash + clear plaintext
          // (the old test-lock 'admin123'/'password123' backdoor is gone: these defaults are rejected outright)
          if (!legacyPlain || REJECTED_LEGACY_PASSWORDS.has(legacyPlain) || REJECTED_LEGACY_PASSWORDS.has(cleanPass)
            || !safeEqualStr(legacyPlain, cleanPass)) return failResponse();
          needsStore = true;
        }

        // Only ACTIVE accounts may log in (parity with gas/Code.gs: isActive true/1/'true' or status === 'ACTIVE')
        if (!isUserActive(user)) {
          return errorResponse('บัญชีผู้ใช้งานถูกระงับการใช้งานชั่วคราว กรุณาติดต่อผู้ดูแลระบบ', 403);
        }

        if (needsStore || legacyPlain) {
          try {
            const rec = needsStore ? await hashPassword(cleanPass) : null;
            await db.prepare(`
              UPDATE users SET
                passwordHash = COALESCE(?, passwordHash),
                passwordSalt = COALESCE(?, passwordSalt),
                passwordAlgo = COALESCE(?, passwordAlgo),
                passwordIterations = COALESCE(?, passwordIterations),
                passwordUpdatedAt = CASE WHEN ? IS NOT NULL THEN ? ELSE passwordUpdatedAt END,
                password = '',
                pin = CASE WHEN pin = ? THEN '' ELSE pin END
              WHERE id = ?
            `).bind(
              rec ? rec.hash : null, rec ? rec.salt : null, rec ? rec.algo : null, rec ? rec.iterations : null,
              rec ? new Date(nowMs).toISOString() : null, rec ? new Date(nowMs).toISOString() : null,
              legacyPlain || cleanPass,
              user.id
            ).run();
          } catch (e) {
            console.error('[auth] password upgrade failed:', e && e.message);
            return errorResponse('ไม่สามารถเข้าสู่ระบบได้ในขณะนี้', 500);
          }
        }

        // success: reset this user's counter and drop this attempt's IP row (earlier IP failures are kept)
        await db.batch([
          db.prepare("DELETE FROM login_attempts WHERE kind = 'USER' AND identifier = ?").bind(attemptKey),
          db.prepare("DELETE FROM login_attempts WHERE kind = 'IP' AND userAgent = ?").bind(nonce)
        ]).catch(() => {});

        const safeUser = formatSafeUser(user);
        const token = await signToken({
          sub: user.id,
          userId: user.id,
          role: user.canonicalRole || user.roleId || '',
          level: safeUser.level,
          tv: Number(user.tokenVersion || 0)
        }, env.AUTH_TOKEN_SECRET, { now: nowMs });
        // mustChangePassword (admin created / reset the account) : the login works but the token can only reach the change-password endpoint, /api/me, /api/logout
        return jsonResponse({
          success: true,
          token,
          user: safeUser,
          mustChangePassword: Number(user.mustChangePassword) === 1
        });
      }
    }

    // ── Auth middleware: every endpoint below requires a valid Bearer token ──
    const bearer = getBearerToken(request);
    const verified = await verifyTokenDetailed(bearer, env.AUTH_TOKEN_SECRET);
    // 401 body carries a machine code so the client can tell "expired" from "revoked" : TOKEN_INVALID | TOKEN_EXPIRED | TOKEN_REVOKED
    const unauthorized = (code) => new Response(JSON.stringify({ error: 'Unauthorized', code, success: false }), { status: 401, headers: corsHeaders });
    if (!verified.payload) {
      return unauthorized(verified.error);
    }
    const tokenPayload = verified.payload;
    let authUser = {
      id: tokenPayload.userId,
      userId: tokenPayload.userId,
      role: tokenPayload.role,
      level: tokenPayload.level
    };
    if (db) {
      let row;
      try {
        row = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(tokenPayload.userId).first();
      } catch (e) {
        // a database problem is NOT a rejected token : answer 503 so the client keeps its session and retries (never 401 -> sign-out)
        console.error('[auth] user lookup failed:', e && e.message);
        return new Response(JSON.stringify({ error: 'ระบบฐานข้อมูลไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง', code: 'DB_UNAVAILABLE', success: false }), { status: 503, headers: corsHeaders });
      }
      if (!row || !isUserActive(row)) {
        return unauthorized('TOKEN_REVOKED');
      }
      // a password change / reset bumps users.tokenVersion : every older token stops working (a token without `tv` counts as version 0)
      if (Number(tokenPayload.tv || 0) !== Number(row.tokenVersion || 0)) {
        return unauthorized('TOKEN_REVOKED');
      }
      if (Number(row.mustChangePassword) === 1 && !MUST_CHANGE_ALLOWED.some(([m, p]) => m === method && p === path)) {
        return new Response(JSON.stringify({ error: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งานระบบ', success: false, mustChangePassword: true }), { status: 403, headers: corsHeaders });
      }
      authUser = { ...authUser, ...sanitizeUser(row), userId: row.id, dbTokenVersion: Number(row.tokenVersion || 0), dbMustChange: Number(row.mustChangePassword) === 1 };
      // level as the client sees it (admin normalized to 99) so the role key matches the frontend session id
      authUser.roleKey = resolveRoleKey({ roleId: row.roleId, level: formatSafeUser(row).level });
    } else {
      authUser.roleKey = resolveRoleKey({ roleId: tokenPayload.role, level: tokenPayload.level });
    }
    state.authUser = authUser;
    // PR / PO rows THIS request really wrote : onRequest rebuilds the file_refs index for exactly these (filerefs.reindexTouched)
    const markTouched = (table, id) => {
      if (!id) return;
      if (!state.touched) state.touched = { prs: new Set(), pos: new Set() };
      state.touched[table].add(String(id));
    };
    // Best-effort audit trail keeping the real user id (requesterId/actorId hold the role key for frontend parity)
    const audit = (action, entityType, entityId, details) => (db
      ? db.prepare('INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`AUD-${Date.now()}-${uid()}`, action, entityType, String(entityId || ''), authUser.userId, JSON.stringify({ roleKey: authUser.roleKey, ...details }), new Date().toISOString())
        .run().catch(() => {})
      : Promise.resolve());
    if (!authorize(authUser, method, path)) {
      return errorResponse(FORBIDDEN_MSG, 403);
    }
    const scopeViewer = buildViewer(authUser); // P4 : what the read endpoints below may send this user

    // size gate for JSON writes (before any handler reads the body) : declared length first, then a byte-capped stream read when
    // Content-Length is missing / empty / not a number (chunked)
    if (method !== 'GET' && method !== 'HEAD' && path !== '/api/upload') {
      const cl = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(cl) && cl > (DOC_WRITE_RE.test(path) ? DOC_WRITE_MAX_BYTES : JSON_WRITE_MAX_BYTES)) {
        return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
      }
      if (needsStreamCap()) {
        const tooLarge = await streamCap();
        if (tooLarge) return tooLarge;
      }
    }

    // ── 1-me. Session endpoints : who am I / change MY password / logout (stateless : the client drops its token) ──
    if (path === '/api/me' && method === 'GET') {
      if (!db) return errorResponse('Database not available', 500);
      // built from the stored row (never from the internal authUser : no tokenVersion / roleKey / dbXxx fields)
      const meRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(authUser.userId).first().catch(() => null);
      if (!meRow) return errorResponse('Unauthorized', 401);
      return jsonResponse({ success: true, user: formatSafeUser(meRow), mustChangePassword: Number(meRow.mustChangePassword) === 1 });
    }
    if (path === '/api/logout' && method === 'POST') {
      return jsonResponse({ success: true });
    }
    if (path === '/api/me/password' && method === 'POST') {
      if (!db) return errorResponse('Database not available', 500);
      const lim = await readJsonLimited(request, 8 * 1024);
      if (lim.tooBig) return errorResponse('ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป', 413);
      const b = lim.body && typeof lim.body === 'object' && !Array.isArray(lim.body) ? lim.body : {};
      const current = typeof b.currentPassword === 'string' ? b.currentPassword.trim() : (typeof b.oldPassword === 'string' ? b.oldPassword.trim() : '');
      const next = typeof b.newPassword === 'string' ? b.newPassword.trim() : '';
      if (!current) return errorResponse('กรุณากรอกรหัสผ่านเดิม', 400);
      if (next.length > MAX_PASSWORD_LENGTH) return errorResponse(`รหัสผ่านต้องไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`, 400);
      if (next.length < MIN_NEW_PASSWORD_LENGTH || REJECTED_LEGACY_PASSWORDS.has(next.toLowerCase())) {
        return errorResponse(`กรุณาตั้งรหัสผ่านใหม่อย่างน้อย ${MIN_NEW_PASSWORD_LENGTH} ตัวอักษร และห้ามใช้รหัสเริ่มต้น`, 400);
      }
      // Wrong "current password" guesses with a stolen token are rate limited like a login : this attempt is recorded as a pending failure and the
      // failures are counted in ONE batch (transaction), so concurrent guesses cannot all slip under the limit. Own counters per user and per IP.
      const key = `pw:${authUser.userId}`;
      const nowMs = Date.now();
      const clientIp = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
      const ipKey = `pw:${clientIp}`;
      const nonce = `pwchange#${globalThis.crypto.randomUUID()}`;
      const insertSql = 'INSERT INTO login_attempts (kind, identifier, success, attemptedAt, ip, userAgent) VALUES (?, ?, 0, ?, ?, ?)';
      const countSql = 'SELECT COUNT(*) AS c FROM login_attempts WHERE kind = ? AND identifier = ? AND success = 0 AND attemptedAt > ?';
      const windowStart = nowMs - LOGIN_WINDOW_MS;
      const rl = await db.batch([
        db.prepare(insertSql).bind('USER', key, nowMs, clientIp, nonce),
        db.prepare(insertSql).bind('IP', ipKey, nowMs, clientIp, nonce),
        db.prepare(countSql).bind('USER', key, windowStart),
        db.prepare(countSql).bind('IP', ipKey, windowStart)
      ]);
      const cnt = (r) => Number(((r && r.results && r.results[0]) || {}).c || 0);
      if (cnt(rl[2]) === 1) await db.prepare('DELETE FROM login_attempts WHERE attemptedAt < ?').bind(nowMs - 24 * 3600 * 1000).run().catch(() => {});
      if (cnt(rl[2]) > LOGIN_MAX_FAILS || cnt(rl[3]) > LOGIN_MAX_FAILS_IP) {
        await db.prepare('DELETE FROM login_attempts WHERE userAgent = ?').bind(nonce).run().catch(() => {}); // rejected attempts are not kept
        return errorResponse(LOGIN_LOCK_MSG, 429);
      }
      const row = await db.prepare('SELECT passwordHash, passwordSalt, passwordAlgo, passwordIterations, password FROM users WHERE id = ? LIMIT 1').bind(authUser.userId).first().catch(() => null);
      if (!row) return errorResponse('Unauthorized', 401);
      let okCurrent = false;
      if (row.passwordHash && row.passwordSalt) {
        okCurrent = await verifyPassword(current, { hash: row.passwordHash, salt: row.passwordSalt, iterations: Number(row.passwordIterations), algo: row.passwordAlgo });
      } else if (typeof row.password === 'string' && row.password && !REJECTED_LEGACY_PASSWORDS.has(row.password)) {
        okCurrent = safeEqualStr(row.password, current);
      }
      if (!okCurrent) return errorResponse('รหัสผ่านเดิมไม่ถูกต้อง', 400); // the pending failure row stays = counted
      if (next === current) {
        await db.prepare('DELETE FROM login_attempts WHERE userAgent = ?').bind(nonce).run().catch(() => {}); // right password : not a guess
        return errorResponse('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม', 400);
      }
      await db.batch([
        db.prepare("DELETE FROM login_attempts WHERE kind = 'USER' AND identifier = ?").bind(key),
        db.prepare("DELETE FROM login_attempts WHERE kind = 'IP' AND userAgent = ?").bind(nonce)
      ]).catch(() => {});
      const rec = await hashPassword(next);
      // tokenVersion is advanced ONLY from the version this request authenticated with : a concurrent change/reset makes this a 409 instead of a lost update
      const upd = await db.prepare(`
        UPDATE users SET passwordHash = ?, passwordSalt = ?, passwordAlgo = ?, passwordIterations = ?, passwordUpdatedAt = ?,
          password = '', pin = '', mustChangePassword = 0, tokenVersion = COALESCE(tokenVersion, 0) + 1
        WHERE id = ? AND COALESCE(tokenVersion, 0) = ?
        RETURNING tokenVersion
      `).bind(rec.hash, rec.salt, rec.algo, rec.iterations, new Date(nowMs).toISOString(), authUser.userId, Number(authUser.dbTokenVersion || 0)).first();
      if (!upd) return errorResponse('บัญชีถูกแก้ไขรหัสผ่านพร้อมกัน กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง', 409);
      const nextVersion = Number(upd.tokenVersion);
      await audit('PASSWORD_CHANGE', 'user', authUser.userId, {});
      // every older token is dead now ; hand back a fresh one so this session carries on
      const token = await signToken({
        sub: authUser.userId, userId: authUser.userId, role: authUser.canonicalRole || authUser.roleId || '', level: formatSafeUser(authUser).level, tv: nextVersion
      }, env.AUTH_TOKEN_SECRET, { now: nowMs });
      return jsonResponse({ success: true, token, mustChangePassword: false });
    }

    // ── 1a. File upload to Google Drive (T2.1c) : auth + rbac passed ; document permission, size, rate limit are checked inside ──
    if (path === '/api/upload' && method === 'POST') {
      return handleUpload({ request, env, db, authUser, jsonResponse, errorResponse, audit, uid });
    }

    // ── 1a-2. File download proxy (P5 phase 2) : auth + rbac passed ; the owner document's visibility, rate limit are checked inside ──
    const fileMatch = method === 'GET' ? path.match(/^\/api\/files\/([^/]+)$/) : null;
    if (fileMatch) {
      return handleFileDownload({ request, env, db, authUser, corsHeaders, fileId: fileMatch[1] });
    }

    // ── 1a-3. Orphan Drive files (P6) : admin only (RBAC rule), dry run unless the body says dryRun:false ; files go to the Drive trash, never deleted ──
    if (path === '/api/admin/cleanup-orphans' && method === 'POST') {
      return handleCleanupOrphans({ request, env, db, authUser, jsonResponse, errorResponse, audit });
    }

    if (path === '/api/admin/restore-orphan' && method === 'POST') {
      return handleRestoreOrphan({ request, env, db, authUser, jsonResponse, errorResponse, audit });
    }

    // ── 1a-4. Take "anyone with the link" off project files uploaded before it was switched off : admin only (RBAC rule), dry run by default ──
    if (path === '/api/admin/unshare-public' && method === 'POST') {
      return handleUnsharePublic({ request, env, db, authUser, jsonResponse, errorResponse, audit });
    }

    // ── 1b. T3.5 endpoints (usage-units, notifications, audit-logs, signatures, PUT storage-locations/:id, recalculate-mac) ──
    // implemented in functions/_lib/extra.js ; they run after auth + RBAC like everything else
    const extraRes = await handleExtraRoutes({
      request, db, method, path, authUser, viewer: formatSafeUser(authUser), jsonResponse, errorResponse, audit, uid, activeFields
    });
    if (extraRes) return extraRes;

    // ── 2. Bootstrap Endpoint (/api/bootstrap) ──
    if (path === '/api/bootstrap') {
      if (!db) {
        return jsonResponse({ success: true, localMode: true });
      }

      const [
        productsRes,
        vendorsRes,
        locationsRes,
        unitsRes,
        deptsRes,
        usersRes,
        prsRes,
        posRes,
        logsRes,
        budgetsRes,
        txsRes
      ] = await Promise.all([
        db.prepare('SELECT * FROM products WHERE isDeleted = 0').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM vendors WHERE isDeleted = 0').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM storage_locations').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM usage_units').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM departments WHERE isActive = 1').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM users ORDER BY name ASC').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM prs ORDER BY createdAt DESC').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM pos ORDER BY createdAt DESC').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 200').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM budget_transactions ORDER BY createdAt DESC LIMIT 500').all().catch(() => ({ results: [] }))
      ]);

      // P4 : only what this user's screens can show (functions/_lib/scope.js)
      const prs = await withPrTimelines(db, filterDocuments(scopeViewer, (prsRes.results || []).map(r => ({
        ...prView(r),
        prNo: r.prNumber,
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, []),
        attachments: parseJsonSafe(r.attachmentsJson, []),
        approvalWorkflow: parseJsonSafe(r.approvalWorkflowJson, {})
      }))));

      const pos = filterDocuments(scopeViewer, (posRes.results || []).map(r => ({
        ...poExtraView(r.extraJson),
        ...r,
        ...poAliasOf(r),
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, []),
        evidence: parseJsonSafe(r.evidenceJson, {}),
        ...poSettlementFields(r.extraJson)
      })));

      const users = stripOtherEmails(scopeViewer, (usersRes.results || []).map(u => formatSafeUser(u)));

      const budgets = {};
      if (budgetsRes.results && budgetsRes.results.length > 0) {
        filterBudgetRows(scopeViewer, budgetsRes.results).forEach(b => {
          const dept = b.department || b.id;
          budgets[dept] = {
            monthlyBudget: Number(b.monthlyBudget || 0),
            spent: Number(b.totalUsed || 0),
            actualExpense: Number(b.totalUsed || 0),
            pending: Number(b.pendingAmount || 0),
            variance: Number(b.totalRemaining ?? (b.monthlyBudget - (b.totalUsed || 0))),
            remainingBudget: Number(b.totalRemaining ?? (b.monthlyBudget - (b.totalUsed || 0))),
            history: parseJsonSafe(b.monthsJson, { [bangkokMonth()]: Number(b.monthlyBudget || 0) }),
            historicalSpent: parseJsonSafe(b.historicalSpentJson, {}),
            refundCredits: parseJsonSafe(b.refundCreditsJson, {})
          };
        });
      }

      const productList = await productViews(db, productsRes.results || []);
      // GAS apiGetBootstrapData carried `notifications` (filtered with isUserTargetOfNotification) ; the client never calls GET /api/notifications
      // on its own, so without this the bell popover stays empty on a fresh device (TC-005 follow-up, 2026-10-15)
      const notifications = await listNotificationsFor(db, authUser, formatSafeUser(authUser)).catch((e) => { console.error('[bootstrap] notifications failed', e && e.message); return []; });
      return jsonResponse({
        success: true,
        prs,
        pos,
        notifications,
        products: productList,
        inventory: productList,
        vendors: utcIsoRows(vendorsRes.results || []),
        storageLocations: locationsRes.results || [],
        usageUnits: unitsRes.results || [],
        departments: utcIsoRows(deptsRes.results || []),
        users,
        stockLogs: stockLogViews(filterStockLogs(scopeViewer, utcIsoRows(withGrnNumber(logsRes.results || [])))),
        budgets: Object.keys(budgets).length > 0 ? budgets : undefined,
        budgetTransactions: filterLedger(scopeViewer, utcIsoRows(txsRes.results || []))
      });
    }

    // ── 3. PRs Endpoints (/api/prs or /api/pr) ──
    if (path === '/api/prs' || path === '/api/pr' || path.startsWith('/api/prs/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/prs/') ? decodeURIComponent(path.replace('/api/prs/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM prs ORDER BY createdAt DESC').all();
        const prs = await withPrTimelines(db, filterDocuments(scopeViewer, (res.results || []).map(r => ({
          ...prView(r),
          prNo: r.prNumber,
          items: parseJsonSafe(r.itemsJson, []),
          timeline: parseJsonSafe(r.timelineJson, []),
          attachments: parseJsonSafe(r.attachmentsJson, []),
          approvalWorkflow: parseJsonSafe(r.approvalWorkflowJson, {})
        }))));
        return jsonResponse(prs);
      }

      if (method === 'POST') {
        const data = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(data); if (shape) return errorResponse(shape.message, shape.status); }
        { const bad = await sanitizeWriteBody(db, data, authUser); if (bad) return errorResponse(bad.message, bad.status); }
        const prList = Array.isArray(data) ? data : [data];
        // RBAC (canAction): changing the status of an existing PR requires the role that owns that step
        // existing row + no status sent => keep the stored status (never the 'SUBMITTED' default) ; status sent => always checked
        const prCur = new Map();
        const prIssued = new Map(); // PR -> { requested } for numbers the server issued
        const seenPr = new Set();
        for (const p of prList) {
          if (!p || typeof p !== 'object') return errorResponse('ข้อมูลไม่ถูกต้อง', 400);
          if (!p.id) p.id = `PR-${Date.now()}-${uid()}`; // server-made id, fixed once so the checks and the insert agree
          const batchKeys = [String(p.id), String(p.prNumber || p.prNo || p.id)];
          if (batchKeys.some((k) => seenPr.has(k))) return errorResponse('รหัส/เลขที่ PR ซ้ำกันในคำขอเดียวกัน', 400);
          batchKeys.forEach((k) => seenPr.add(k));
          const cur = p.id ? await lookupStatus(db, 'SELECT id, prNumber, status, department, totalAmount, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson, extraJson FROM prs WHERE id = ? LIMIT 1', p.id) : null;
          prCur.set(p, cur);
          if (cur) {
            // an existing PR: caller must reach its department, and its content (items / total) is frozen once the client freezes it
            if (!canAccessDepartment(authUser, cur.department)) return errorResponse(FORBIDDEN_MSG, 403);
            if (prContentChanged(cur, p) && !canEditPrContent(authUser, cur.status)) return errorResponse(FORBIDDEN_MSG, 403);
            if (Array.isArray(p.items) && !canEditPrContent(authUser, cur.status)) {
              const fz = freezePrItems(cur.itemsJson, p.items);
              if (fz.error) return errorResponse(FORBIDDEN_MSG, 403);
              p.items = fz.items;
            }
          } else {
            // new PR: a concrete, canonical department code. ALL / BOTH / * (any case) would open the document to everybody : admin only
            // (the client always creates a PR under a concrete department). Checked against the departments table when it has data.
            const deptRaw = p.department || 'PD';
            const wildcard = isWildcardDept(deptRaw);
            if (wildcard && !normalizeUser(authUser).isAdmin) return errorResponse('แผนกของ PR ไม่ถูกต้อง', 400);
            const deptCode = normalizeDeptCode(deptRaw);
            if (!wildcard) {
              const known = await knownDepartmentCodes(db);
              if (known && known.size > 0 && !known.has(deptCode)) return errorResponse('ไม่พบแผนกนี้ในระบบ', 400);
            }
            p.department = deptCode; // stored canonical (upper-case, no DEPT-)
            if (!canAccessDepartment(authUser, p.department)) return errorResponse(FORBIDDEN_MSG, 403);
            // a new PR's id must not be another PR's number (lookups are "id = ? OR prNumber = ?")
            if (await lookupStatus(db, 'SELECT id FROM prs WHERE prNumber = ? LIMIT 1', p.id)) return errorResponse('เลขที่/รหัส PR ซ้ำกับเอกสารที่มีอยู่', 409);
            // number (T3.3): the client's own number is kept when it is free. Not sent, or already taken by another PR -> the server issues the
            // next one from doc_counters ({DEPT}{NNN}/{YYYY}) and returns it in body.pr / body.prNo (+ renumbered / requestedPrNo) ; never silent.
            const asked = String(p.prNumber || p.prNo || '').trim();
            // a client number is only kept when it has the real shape for this PR : {DEPT}{digits}/{current Bangkok year} (idGenerator.js)
            const shapeOk = Boolean(asked) && new RegExp(`^${String(p.department).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+/${bangkokYear()}$`).test(asked);
            const taken = shapeOk ? await lookupStatus(db, 'SELECT id FROM prs WHERE prNumber = ? OR id = ? LIMIT 1', asked, asked) : null;
            if (!shapeOk || taken) {
              const issued = await issueDocNumber(db, { docType: 'PR', dept: p.department });
              prIssued.set(p, { requested: asked || null });
              p.prNumber = issued.docNo;
              p.prNo = issued.docNo;
            }
          }
          const effective = p.status || (cur ? null : 'SUBMITTED');
          if (effective && !canTransitionPR(authUser, cur ? cur.status : undefined, effective)) return errorResponse(FORBIDDEN_MSG, 403);
        }
        for (const p of prList) {
          const prId = p.id;
          let prNo = p.prNumber || p.prNo || prId;
          const dept = p.department || 'PD';
          const reqId = authUser.roleKey; // role id, same as frontend currentUser.id (real user id goes to audit_logs)
          const reqName = authUser.name || authUser.username || '';
          const curRow = prCur.get(p);
          const status = p.status || (curRow ? curRow.status : 'SUBMITTED');
          // existing PR + field not sent => keep the stored value (an upsert must not zero the total)
          const hasTotal = (p.totalAmount !== undefined && p.totalAmount !== null) || (p.total !== undefined && p.total !== null);
          const total = curRow && !hasTotal ? Number(curRow.totalAmount || 0) : Number(p.totalAmount || p.total || 0);
          const reason = p.reason || p.purpose || '';
          const itemsJson = curRow && !Array.isArray(p.items) ? (curRow.itemsJson || '[]') : JSON.stringify(p.items || []);
          // timeline is append-only (entries added by the client get the token's identity / the server's time)
          const timelineJson = JSON.stringify(mergeLog(curRow ? parseJsonSafe(curRow.timelineJson, []) : [], withoutAuditEntries(p.timeline) || [], actorOf(authUser)));
          // existing PR + not sent => keep the stored value (an upsert must not wipe them) ; a final status only accepts ADDED attachments
          const attachmentsJson = JSON.stringify(guardedDocBlob(curRow ? parseJsonSafe(curRow.attachmentsJson, []) : undefined, Array.isArray(p.attachments) ? p.attachments : undefined, Boolean(curRow), curRow && curRow.status, []));
          const approvalWorkflowJson = curRow && (p.approvalWorkflow === undefined || p.approvalWorkflow === null) ? (curRow.approvalWorkflowJson || '{}') : JSON.stringify(p.approvalWorkflow || {});
          // fields without a column -> extraJson (see PR_EXTRA_RESERVED). The creator is fixed at creation from the token ; a later save never rewrites it.
          const prExtra = pickExtra(p, PR_EXTRA_RESERVED, curRow ? PR_IDENTITY_KEYS : []);
          if (!curRow) {
            prExtra.requestedBy = reqName;
            for (const k of ['applicantName1', 'createdBy']) if (p[k] !== undefined && p[k] !== null) prExtra[k] = reqName;
          }
          const prAuditAct = prAuditAction(curRow ? curRow.status : undefined, status, Boolean(curRow));
          const prAuditId = prAuditAct ? `AL-${Date.now()}-${uid()}` : undefined;
          const prAuditMeta = {};
          Object.assign(prExtra, await prApprovalPatch(db, authUser, {
            stored: curRow ? parseExtra(curRow.extraJson) : {}, clientHistory: p.approvalHistory, prev: curRow ? curRow.status : undefined, next: status, isExisting: Boolean(curRow), eventId: prAuditId, meta: prAuditMeta
          }));
          Object.assign(prExtra, await docServerPatch(db, authUser, 'PR', { stored: curRow ? parseExtra(curRow.extraJson) : {}, body: p, next: status, isExisting: Boolean(curRow) }));
          const extraJson = extraPatchJson(prExtra, curRow ? parseExtra(curRow.extraJson) : undefined);
          if (extraJson === null) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
          const prChannel = typeof p.purchaseChannel === 'string' && p.purchaseChannel.trim() ? p.purchaseChannel.trim().slice(0, 32) : null;
          const prPoNumber = typeof p.poNumber === 'string' && p.poNumber.trim() ? p.poNumber.trim().slice(0, 300) : null;

          // an existing PR changing status : optimistic (the upsert only applies while the row has the status read here) and the audit / notification rows are
          // guarded the same way and go first ; a NEW PR : its CREATE / PR_DRAFTED row + notification only while no PR with that id exists yet (two identical
          // creates at once -> one set). Both guards are evaluated inside the batch.
          const postTransition = Boolean(curRow && prAuditAct && status && status !== curRow.status);
          const postGuard = curRow && prAuditAct ? prPrevStatusGuard(prId, curRow.status)
            : (!curRow && prAuditAct ? { whereSql: 'NOT EXISTS (SELECT 1 FROM prs WHERE id = ?)', whereBinds: [prId] } : {});
          const insertPr = (no) => db.prepare(`
            INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, reason, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson, purchaseChannel, poNumber, extraJson, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              totalAmount = excluded.totalAmount,
              reason = excluded.reason,
              itemsJson = excluded.itemsJson,
              timelineJson = excluded.timelineJson,
              attachmentsJson = excluded.attachmentsJson,
              approvalWorkflowJson = excluded.approvalWorkflowJson,
              purchaseChannel = COALESCE(excluded.purchaseChannel, prs.purchaseChannel),
              poNumber = COALESCE(excluded.poNumber, prs.poNumber),
              extraJson = json_patch(COALESCE(NULLIF(prs.extraJson, ''), '{}'), excluded.extraJson),
              updatedAt = CURRENT_TIMESTAMP
            WHERE ${curRow ? 'prs.status IS ?' : '0'}
          `).bind(prId, no, dept, reqId, reqName, status, total, reason, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson, prChannel, prPoNumber, extraJson, ...(curRow ? [curRow.status] : []));
          // an existing PR is only overwritten while it still has the status read here (a save made on an older view can not roll an approved PR back / edit its locked
          // content) ; a "new" PR whose id appeared meanwhile is not overwritten either (WHERE 0) -> changes 0 -> 409 below. A clash of prNumber (another UNIQUE) still throws and is renumbered.
          const prAuditComment = prAuditMeta.comment || prTransitionComment(prAuditAct, p);
          // the PR write and its audit row go in one batch (the row carries the number actually stored)
          // + the GAS notification rows of that transition (department = the stored row's, never the body's)
          const savePr = (no) => runWithAudit(db, insertPr(no), prAuditAct ? prAuditStmt(db, authUser, { id: prAuditId, action: prAuditAct, prId, prNo: no, status, comment: prAuditComment, ...postGuard }) : null, { prId, action: prAuditAct },
            prAuditAct ? prNotifyStmts(db, authUser, prAuditAct, { dept: (curRow && curRow.department) || dept, prNo: no, body: p, ...postGuard }) : [], Boolean(postGuard.whereSql));
          let saveRes;
          try {
            saveRes = await savePr(prNo);
          } catch (e) {
            // lost a race for the same number (checked free a moment ago) : a new PR is renumbered by the server, never failed with a 500
            if (curRow || !/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
            const issued = await issueDocNumber(db, { docType: 'PR', dept });
            prIssued.set(p, { requested: prIssued.has(p) ? prIssued.get(p).requested : (prNo === prId ? null : prNo) });
            prNo = issued.docNo;
            p.prNumber = issued.docNo;
            p.prNo = issued.docNo;
            saveRes = await savePr(prNo);
          }
          if (!writeApplied(saveRes) || postTransition) {
            // not applied : the PR moved (or appeared) since it was read. A transition is judged by its audit row (did THIS request win ?) ; the PR already in the
            // wanted status -> nothing more to do (200) ; anything else -> 409 and nothing was written
            const won = postTransition ? await db.prepare('SELECT 1 AS x FROM audit_logs WHERE id = ? LIMIT 1').bind(prAuditId).first().catch(() => null) : null;
            if (!won && (postTransition || !writeApplied(saveRes))) {
              const nowRow = await lookupStatus(db, 'SELECT status FROM prs WHERE id = ? LIMIT 1', prId);
              if (postTransition && nowRow && nowRow.status === status) continue;
              return errorResponse('เอกสารถูกแก้ไขโดยผู้อื่น กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง', 409);
            }
          }
          markTouched('prs', prId);
          await audit('PR_UPSERT', 'pr', prId, { requesterUserId: authUser.userId, prNo });
          if (curRow && curRow.status === 'REVIEWED' && PR_APPROVED_TO.includes(status)) {
            await writePrCommitment(db, prId, authUser.name || authUser.username, authUser.title || authUser.canonicalRole || authUser.roleKey);
          }
        }
        // body.pr is the PR as stored (with the server-issued number when one was issued) ; apiService.createPR hands body.pr to the caller,
        // and AppContext.handleCreatePR / PRCreateView replace their list entry by id, so the client picks the new number up.
        const first = prIssued.get(prList[0]);
        return jsonResponse({
          success: true,
          count: prList.length,
          pr: prList[0],
          id: prList[0]?.id,
          prNo: prList[0]?.prNumber || prList[0]?.prNo,
          ...(first ? { issuedByServer: true, renumbered: Boolean(first.requested), requestedPrNo: first.requested } : {}),
          issued: prList.filter((x) => prIssued.has(x)).map((x) => ({ id: x.id, prNo: x.prNumber, requestedPrNo: prIssued.get(x).requested }))
        });
      }

      if (method === 'PUT' && subId) {
        const p = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(p); if (shape) return errorResponse(shape.message, shape.status); }
        { const bad = await sanitizeWriteBody(db, p, authUser, { docKey: subId }); if (bad) return errorResponse(bad.message, bad.status); }
        const status = p.status || null;
        // resolve ONE row (exact id first, then prNumber) ; the UPDATE below targets that id only
        const curRow = await lookupStatus(db, 'SELECT id, status, department, totalAmount, itemsJson, timelineJson, attachmentsJson, extraJson FROM prs WHERE id = ? OR prNumber = ? ORDER BY (id = ?) DESC LIMIT 1', subId, subId, subId);
        if (curRow) {
          if (!canAccessDepartment(authUser, curRow.department)) return errorResponse(FORBIDDEN_MSG, 403);
          if (prContentChanged(curRow, p) && !canEditPrContent(authUser, curRow.status)) return errorResponse(FORBIDDEN_MSG, 403);
          if (Array.isArray(p.items) && !canEditPrContent(authUser, curRow.status)) {
            const fz = freezePrItems(curRow.itemsJson, p.items);
            if (fz.error) return errorResponse(FORBIDDEN_MSG, 403);
            p.items = fz.items;
          }
        }
        if (status && curRow && !canTransitionPR(authUser, curRow.status, status)) return errorResponse(FORBIDDEN_MSG, 403);
        const targetId = curRow && curRow.id ? curRow.id : subId;
        const itemsJson = p.items ? JSON.stringify(p.items) : null;
        const timelineJson = Array.isArray(p.timeline) ? JSON.stringify(mergeLog(curRow ? parseJsonSafe(curRow.timelineJson, []) : [], withoutAuditEntries(p.timeline), actorOf(authUser))) : null;
        const attachmentsJson = p.attachments ? JSON.stringify(guardedDocBlob(curRow ? parseJsonSafe(curRow.attachmentsJson, []) : undefined, p.attachments, Boolean(curRow), curRow && curRow.status, [])) : null;
        const approvalWorkflowJson = p.approvalWorkflow ? JSON.stringify(p.approvalWorkflow) : null;
        const reason = p.reason || p.purpose || null;
        const totalAmount = (p.totalAmount !== undefined && p.totalAmount !== null) ? Number(p.totalAmount) : null;
        // fields without a column -> merged into extraJson ; the creator (requestedBy / applicantName1) is never rewritten
        const putExtra = pickExtra(p, PR_EXTRA_RESERVED, PR_IDENTITY_KEYS);
        // RESUBMIT only on the client's marker (apiUpdatePR / submitPR) and never on top of a review / approve / send-back / cancel in the same PUT
        const putResubmitMarker = p.action === 'RESUBMIT' || p.isResubmit === true;
        const putRawAct = curRow ? prAuditAction(curRow.status, status || curRow.status, true, putResubmitMarker) : null;
        // RESUBMIT is logged only for a real re-send : the PR was a draft / sent back and is now SUBMITTED, or its content (total / items) changed
        const putIsResend = putRawAct === 'RESUBMIT' && (((curRow.status === 'DRAFT' || curRow.status === 'REJECTED_TO_DRAFT') && status === 'SUBMITTED') || prContentChanged(curRow, p));
        const putAuditAct = putRawAct === 'RESUBMIT' && !putIsResend ? null : putRawAct;
        if (putRawAct === 'RESUBMIT' && !canEditPrContent(authUser, curRow.status)) {
          // a repeated submit (the first PUT worked, its response was lost) : same status sent again, content unchanged -> 200 no-op, nothing written, no audit row
          if (status && status === curRow.status && !prContentChanged(curRow, p)) return jsonResponse({ success: true, id: subId, unchanged: true });
          return errorResponse(FORBIDDEN_MSG, 403);
        }
        const putAuditId = putAuditAct ? `AL-${Date.now()}-${uid()}` : undefined;
        const putAuditMeta = {};
        Object.assign(putExtra, await prApprovalPatch(db, authUser, {
          stored: curRow ? parseExtra(curRow.extraJson) : {}, clientHistory: p.approvalHistory, prev: curRow ? curRow.status : undefined, next: status || (curRow ? curRow.status : null), isExisting: Boolean(curRow), eventId: putAuditId, meta: putAuditMeta
        }));
        Object.assign(putExtra, await docServerPatch(db, authUser, 'PR', { stored: curRow ? parseExtra(curRow.extraJson) : {}, body: p, next: status || (curRow ? curRow.status : null), isExisting: Boolean(curRow) }));
        const putExtraJson = extraPatchJson(putExtra, curRow ? parseExtra(curRow.extraJson) : undefined);
        if (putExtraJson === null) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
        const putChannel = typeof p.purchaseChannel === 'string' && p.purchaseChannel.trim() ? p.purchaseChannel.trim().slice(0, 32) : null;
        const putPoNumber = typeof p.poNumber === 'string' && p.poNumber.trim() ? p.poNumber.trim().slice(0, 300) : null;

        const putTransition = Boolean(curRow && putAuditAct && status && status !== curRow.status);
        const putNumRow = putAuditAct ? await lookupStatus(db, 'SELECT prNumber FROM prs WHERE id = ? LIMIT 1', targetId) : null;
        const putUpdate = db.prepare(`
          UPDATE prs SET
            status = COALESCE(?, status),
            totalAmount = COALESCE(?, totalAmount),
            reason = COALESCE(?, reason),
            itemsJson = COALESCE(?, itemsJson),
            timelineJson = COALESCE(?, timelineJson),
            attachmentsJson = COALESCE(?, attachmentsJson),
            approvalWorkflowJson = COALESCE(?, approvalWorkflowJson),
            purchaseChannel = COALESCE(?, purchaseChannel),
            poNumber = COALESCE(?, poNumber),
            extraJson = json_patch(COALESCE(NULLIF(extraJson, ''), '{}'), ?),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ?${curRow ? ' AND status IS ?' : ''}
        `).bind(status, totalAmount, reason, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson, putChannel, putPoNumber, putExtraJson, targetId, ...(curRow ? [curRow.status] : []));
        // the UPDATE and its audit row + notification rows are one batch. A status transition is optimistic : the audit / notification rows are guarded by
        // "the PR still has the status this request read" and go BEFORE the UPDATE, which also only applies to that status -> two identical requests
        // (double click, a second writer) leave exactly one row of each.
        // (every audited write to an existing PR - a transition or a RESUBMIT of the same status - is guarded the same way)
        const putGuard = curRow && putAuditAct ? prPrevStatusGuard(targetId, curRow.status) : {};
        const putRes = await runWithAudit(db, putUpdate, putAuditAct ? prAuditStmt(db, authUser, { id: putAuditId, action: putAuditAct, prId: targetId, prNo: putNumRow && putNumRow.prNumber, status, comment: putAuditMeta.comment || prTransitionComment(putAuditAct, p), ...putGuard }) : null, { prId: targetId, action: putAuditAct },
        putAuditAct && curRow ? prNotifyStmts(db, authUser, putAuditAct, { dept: curRow.department || 'PD', prNo: (putNumRow && putNumRow.prNumber) || targetId, body: p, ...putGuard }) : [], Boolean(putGuard.whereSql));
        // every write to an existing PR only applies while the PR still has the status read here ; not applied -> the PR moved meanwhile
        const putWon = putAuditAct ? Boolean(await db.prepare('SELECT 1 AS x FROM audit_logs WHERE id = ? LIMIT 1').bind(putAuditId).first().catch(() => null)) : writeApplied(putRes);
        if (curRow && !putWon) {
          // a transition to the status the PR now has -> 200 no-op ; anything else (an edit on an older view, another status) -> 409, nothing written
          const nowRow = await lookupStatus(db, 'SELECT status FROM prs WHERE id = ? LIMIT 1', targetId);
          if (status && nowRow && nowRow.status === status && status !== curRow.status) return jsonResponse({ success: true, id: subId, unchanged: true });
          return errorResponse('เอกสารถูกแก้ไขโดยผู้อื่น กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง', 409);
        }
        markTouched('prs', targetId);
        if (curRow && curRow.status === 'REVIEWED' && PR_APPROVED_TO.includes(status)) {
          await writePrCommitment(db, targetId, authUser.name || authUser.username, authUser.title || authUser.canonicalRole || authUser.roleKey);
        }

        return jsonResponse({ success: true, id: subId });
      }

      if (method === 'DELETE' && subId) {
        const goneRows = ((await db.prepare('SELECT id, prNumber FROM prs WHERE id = ? OR prNumber = ?').bind(subId, subId).all().catch(() => ({ results: [] }))).results) || [];
        await db.prepare('DELETE FROM prs WHERE id = ? OR prNumber = ?').bind(subId, subId).run();
        for (const g of goneRows) await markDocGone(db, 'prs', g); // file_refs rows dropped, attachments marked (Drive files stay)
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 4.1 Goods Receipt (GRN) Subsystem (/api/pos/:id/receive or /api/receive-goods or /api/inventory/receive) ──
    const receiveMatch = path.match(/^\/api\/pos\/([^/]+)\/receive$/);
    if (method === 'POST' && (receiveMatch || path === '/api/receive-goods' || path === '/api/receive' || path === '/api/grn' || path === '/api/inventory/receive')) {
      if (!db) return jsonResponse({ success: false, localMode: true });
      const body = await request.json().catch(() => ({}));
      { const shape = checkBodyShape(body); if (shape) return errorResponse(shape.message, shape.status); }
      { const bad = await sanitizeWriteBody(db, body, authUser, { docKey: receiveMatch ? decodeURIComponent(receiveMatch[1]) : (body.poId || body.id) }); if (bad) return errorResponse(bad.message, bad.status); }
      const targetPoId = receiveMatch ? decodeURIComponent(receiveMatch[1]) : (body.poId || body.id);
      const { receivingItems = [], note = '', options = {}, grNumber: bodyGrNo } = body;
      // stockOnly (ReceivingModal, which saves the PO itself with PUT /api/pos/:id afterwards) : only the stock side of the receipt is written here -
      // currentStock, the moving average cost and ONE IN stock log per line - and the PO row is left alone. Needs the GRN number (idempotency key).
      const stockOnly = body.stockOnly === true || (options && options.stockOnly === true);
      if (stockOnly && !(bodyGrNo || (options && options.grNumber))) return errorResponse('ต้องระบุเลขที่ GRN', 400);
      // actor comes from the verified token, never from the request body
      const actorName = authUser.name || authUser.username || 'Warehouse';
      const actorRole = authUser.title || authUser.canonicalRole || authUser.role || 'Warehouse';
      const timestamp = thaiStamp(new Date());

      const poRow = await db.prepare('SELECT * FROM pos WHERE id = ? OR poNumber = ? ORDER BY (id = ?) DESC LIMIT 1').bind(targetPoId, targetPoId, targetPoId).first().catch(() => null);
      if (!poRow) {
        return errorResponse(`ไม่พบเอกสารใบสั่งซื้อ PO ID: ${targetPoId}`, 404);
      }
      // the department of the PO is checked FIRST (before anything is returned or written, also for an already closed PO) : receiving goods of
      // another department's PO would add that department's stock and return its document
      if (!canAccessDepartment(authUser, poRow.department)) return errorResponse(FORBIDDEN_MSG, 403);

      // the stock log id is built as LOG:{poId}:{GRN}:{line} and summed by that pattern : a PO id with ':' could mix with another PO's rows
      if (String(poRow.id).includes(':')) return errorResponse('รหัส PO ไม่รองรับการตรวจรับ', 400);
      // parity gas/Code.gs:2643-2648 apiReceivePO: a PO already in a terminal status is returned unchanged (nothing is written).
      // GAS does NOT cap cumulative received qty at the ordered qty (remainingQty = max(0, ordered - received)), so neither do we.
      // (stockOnly : the PO row is not touched here and the GRN must already be on the PO, see below)
      // Goods can only be received on a PO that was ordered : DRAFT / pending / rejected / cancelled POs are refused (409). stockOnly runs AFTER the
      // client saved the PO (its status may already be the final one), so it also accepts the closing statuses ; the grnHistory + line ceiling bound it.
      const recvStatus = normalizePoStatus(poRow.status) || '';
      if (stockOnly && !RECEIVE_STOCK_STATUSES.has(recvStatus)) return errorResponse('สถานะ PO ไม่อนุญาตให้ตรวจรับสินค้า', 409);
      if (!stockOnly && !RECEIVE_TERMINAL_STATUSES.has(recvStatus) && !RECEIVE_OPEN_STATUSES.has(recvStatus)) return errorResponse('สถานะ PO ไม่อนุญาตให้ตรวจรับสินค้า', 409);
      if (!stockOnly && RECEIVE_TERMINAL_STATUSES.has(recvStatus)) {
        return jsonResponse({
          success: true,
          duplicate: true,
          po: { ...poExtraView(poRow.extraJson), ...poRow, ...poAliasOf(poRow), items: parseJsonSafe(poRow.itemsJson, []), timeline: parseJsonSafe(poRow.timelineJson, []), evidence: parseJsonSafe(poRow.evidenceJson, {}) },
          message: 'PO อยู่ในสถานะสิ้นสุดแล้ว ไม่บันทึกการตรวจรับซ้ำ'
        });
      }

      // Every received line must be a line of THIS PO, and the stock that moves is the product of the PO's line (never an id taken from the body) ;
      // a line that is not in the PO is skipped (none at all -> 400). The product's department is checked again (a PO line may point at another
      // department's product). Done before the lock so a refusal leaves the PO untouched.
      const poItemsPre = parseJsonSafe(poRow.itemsJson, []);
      const receivePlan = [];
      const receiveSkipped = [];
      for (const rItem of Array.isArray(receivingItems) ? receivingItems : []) {
        if (!rItem || typeof rItem !== 'object') continue;
        const pId = rItem.productId || rItem.id;
        const matches = (it) => it && ((pId && (it.productId === pId || it.id === pId)) || (rItem.code && it.code === rItem.code));
        // The same product can be on several PO lines (other rate / store) : the client's lineIndex picks the line (it must be a line of that product) ;
        // without it the n-th repeat of a product in the request takes the n-th line of it (the first line not taken yet)
        let idx = -1;
        const li = Number(rItem.lineIndex);
        if (rItem.lineIndex !== undefined && rItem.lineIndex !== null && Number.isInteger(li) && li >= 0 && li < poItemsPre.length && matches(poItemsPre[li])) idx = li;
        else {
          idx = poItemsPre.findIndex((it, i) => matches(it) && !receivePlan.some((x) => x.idx === i));
          if (idx < 0) idx = poItemsPre.findIndex(matches);
        }
        if (idx < 0) { receiveSkipped.push(pId || rItem.code || null); continue; }
        const line = poItemsPre[idx];
        const prodKey = line.productId || line.code || line.id;
        const prod = prodKey ? await db.prepare('SELECT * FROM products WHERE id = ? OR code = ? ORDER BY (id = ?) DESC LIMIT 1').bind(prodKey, prodKey, prodKey).first().catch(() => null) : null;
        if (prod && prod.department && !canAccessDepartment(authUser, normalizeDeptCode(prod.department))) return errorResponse(FORBIDDEN_MSG, 403);
        // quantities : finite numbers, never negative (a negative figure would lower the PO's received qty and the stock)
        const qGood = recvGoodOf(rItem);
        const qDef = Number(rItem.defectiveQty || 0);
        if (!Number.isFinite(qGood) || qGood < 0 || !Number.isFinite(qDef) || qDef < 0 || qGood > RECEIVE_QTY_MAX || qDef > RECEIVE_QTY_MAX) return errorResponse('จำนวนที่รับไม่ถูกต้อง', 400);
        // the same PO line twice in one request (same product repeated / another spelling of it) is ONE receipt : quantities are added, so the stock
        // log id (PO + GRN + line) is the same however the request is ordered or repeated
        const dup = receivePlan.find((x) => x.idx === idx);
        if (dup) {
          dup.rItem = { ...dup.rItem, goodQty: recvGoodOf(dup.rItem) + qGood, defectiveQty: Number(dup.rItem.defectiveQty || 0) + qDef };
          delete dup.rItem.receivedQty; delete dup.rItem.receiveQty; delete dup.rItem.receivedThisTime;
          if (recvGoodOf(dup.rItem) > RECEIVE_QTY_MAX) return errorResponse('จำนวนที่รับไม่ถูกต้อง', 400);
          continue;
        }
        receivePlan.push({ rItem, idx, prod, prodKey });
      }
      { // GRN number the client sends : GRN-{poNo}-{NN} / GR-{poId}-{ts} shape, bounded
        const askedGr = bodyGrNo || (options && options.grNumber);
        if (askedGr !== undefined && askedGr !== null && askedGr !== '' && (typeof askedGr !== 'string' || !/^GRN?-[A-Za-z0-9._/-]{1,120}$/.test(askedGr))) return errorResponse('เลขที่ GRN ไม่ถูกต้อง', 400);
      }
      if (Array.isArray(receivingItems) && receivingItems.length > 0 && receivePlan.length === 0) {
        return errorResponse('รายการที่รับไม่ตรงกับสินค้าใน PO นี้', 400);
      }

      // Figures of every received line, from the STORED PO line (never from the body) : conversion (0 < c <= 10000 ; line, else product), base cost
      // (GAS apiReceivePO : price || unitPrice || actualPrice || actUnitPrice, the order keys are locked after ordering by guardPoItems), stock qty.
      const firstPos = (...vals) => { for (const v of vals) { const n = Number(v); if (v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0) return n; } return 0; };
      const esc = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
      const planLogId = (idx) => `LOG:${poRow.id}:${stockGr}:${idx}`;
      const stockGr = bodyGrNo || (options && options.grNumber) || '';
      if (!stockOnly && stockGr) {
        // full receive repeated with a GRN number that is already on the PO (retry / double click while the PO is still PARTIAL) : nothing is added again
        const histNow = parseExtra(poRow.extraJson).grnHistory;
        if (Array.isArray(histNow) && histNow.some((g) => g && (g.grnNumber === stockGr || g.grnNo === stockGr))) {
          return jsonResponse({
            success: true,
            duplicate: true,
            po: { ...poExtraView(poRow.extraJson), ...poRow, ...poAliasOf(poRow), items: poItemsPre, timeline: parseJsonSafe(poRow.timelineJson, []), evidence: parseJsonSafe(poRow.evidenceJson, {}) },
            message: 'เลขที่ GRN นี้บันทึกแล้ว ไม่บันทึกการตรวจรับซ้ำ'
          });
        }
      }
      // PR-level ceiling : the goods received over ALL the POs of a PR (a cancelled PO's included) never pass the PR's qty of that product
      let prItemsOfPo = [];
      let prRefNo = poRow.prNumber || '';
      let prRefId = poRow.prId || '';
      if (poRow.prNumber || poRow.prId) {
        const prr = await db.prepare('SELECT id, prNumber, itemsJson FROM prs WHERE prNumber = ? OR id = ? ORDER BY (prNumber = ?) DESC LIMIT 1').bind(poRow.prNumber || poRow.prId, poRow.prId || poRow.prNumber, poRow.prNumber || '').first().catch(() => null);
        prItemsOfPo = prr ? parseJsonSafe(prr.itemsJson, []) : [];
        if (prr) { prRefNo = prr.prNumber || prRefNo; prRefId = prr.id || prRefId; }
      }
      // rate snapshotted on the PO lines paired with each PR row, over ALL the POs of the PR (prRowIndex, else paired again as before) : used for the PR rows that have no rate
      const rowRate = new Map();
      if (prItemsOfPo.length && (prRefNo || prRefId)) {
        const allPos = (await db.prepare("SELECT itemsJson FROM pos WHERE prNumber = NULLIF(?, '') OR prId = NULLIF(?, '')").bind(prRefNo, prRefId).all().catch(() => ({ results: [] }))).results || [];
        for (const o of allPos) {
          const ls = parseJsonSafe(o.itemsJson, []);
          const paired = pickPrRows(prItemsOfPo, ls);
          ls.forEach((l, i) => {
            const stored = l && Number.isInteger(l.prRowIndex) && l.prRowIndex >= 0 && l.prRowIndex < prItemsOfPo.length ? l.prRowIndex : paired[i];
            if (stored >= 0 && !rowRate.has(stored)) { const r = firstPos(l && l.conversionRate, l && l.conversionRatio); if (r) rowRate.set(stored, r); }
          });
        }
      }
      const prKeyOf = (it) => String((it && (it.productId || it.code || it.id)) || '');
      for (const pl of receivePlan) {
        const line = poItemsPre[pl.idx];
        // the line's own conversion, else 1 (as workflowEngine.receiveGoods) - the product's rate is NOT read at receipt time (it is snapshotted onto the line when the PO is made)
        const conv = firstPos(line.conversionRate, line.conversionRatio) || 1;
        if (conv > CONV_MAX) return errorResponse('อัตราแปลงหน่วยไม่ถูกต้อง', 400);
        pl.good = recvGoodOf(pl.rItem);
        pl.def = Number(pl.rItem.defectiveQty || 0);
        pl.conv = conv;
        pl.stockQty = Math.round(pl.good * conv * 10000) / 10000;
        if (!Number.isFinite(pl.stockQty) || pl.stockQty > 1e9) return errorResponse('จำนวนที่รับไม่ถูกต้อง', 400);
        pl.prCeil = null;
        if (prItemsOfPo.length) {
          const lk = prKeyOf(line);
          const sameIdx = [];
          prItemsOfPo.forEach((x, i) => { if (prKeyOf(x) === lk || (line.productId && x.productId === line.productId)) sameIdx.push(i); });
          // base unit : sum over the PR rows of that product of qty x the row's own rate ; a row with no rate takes the rate snapshotted on the PO line that
          // was paired with it (prRowIndex), else 1 - never the rate of the line being received
          if (sameIdx.length) {
            pl.prCeil = sameIdx.reduce((s, i) => {
              const x = prItemsOfPo[i];
              // the row's own rate, else the one snapshotted on a paired PO line of any PO of the PR, else (not found) the rate of the line being received
              // (its conversion is locked on the PO line, so it cannot be inflated by the receiver)
              return s + orderedQtyOf(x) * (firstPos(x.conversionRate, x.conversionRatio) || rowRate.get(i) || conv);
            }, 0);
          }
        }
        pl.baseCost = Math.round((firstPos(line.price, line.unitPrice, line.actualPrice, line.actUnitPrice) / conv) * 10000) / 10000;
        if (!stockOnly) {
          // like the web engine (workflowEngine.receiveGoods) : received so far + this round may not pass the ordered qty
          const ordered = orderedQtyOf(line);
          if ((Number(line.receivedQty) || 0) + pl.good + pl.def > ordered + 1e-9) return errorResponse('จำนวนตรวจรับเกินยอดสั่งซื้อ', 400);
          pl.ceiling = ordered * conv;
        }
      }
      if (stockOnly) {
        // The ReceivingModal saves the PO first and then calls this : the GRN must already be in the PO's grnHistory (else any GRN number would add stock),
        // and per line the stock logged for this PO + line may not pass what the PO line holds as received (good) qty.
        // nothing to book (no line, or every line 0 good and 0 defective) : refused, no audit / notification for an empty receipt
        if (!receivePlan.some((p) => p.good > 0 || p.def > 0)) return errorResponse('ไม่มีรายการที่รับ', 400);
        const hist = parseExtra(poRow.extraJson).grnHistory;
        if (!Array.isArray(hist) || !hist.some((g) => g && (g.grnNumber === stockGr || g.grnNo === stockGr))) return errorResponse('ไม่พบเลขที่ GRN นี้ในใบสั่งซื้อ กรุณาบันทึกการตรวจรับก่อน', 409);
        for (const pl of receivePlan) {
          const line = poItemsPre[pl.idx];
          pl.ceiling = (Number(line.goodQty) || 0) * pl.conv; // good qty only : receivedQty also counts defective goods, which never enter stock
          if (pl.def > 0) {
            // defective goods (IN_NG, no stock) : bound by SERVER figures only - this request's defective qty may not pass what is still not received GOOD :
            // ordered qty (stored line) minus the good stock already logged for this PO line (this request's good qty included). Earlier IN_NG are NOT deducted
            // (replaced goods may come defective again, claim REPLACEMENT round 2) ; the client's damagedQty / defectiveQty on the line are never a ceiling.
            pl.ngCeiling = orderedQtyOf(line) * pl.conv;
            const haveNg = await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(`LOGNG:${poRow.id}:${stockGr}:${pl.idx}`).first().catch(() => null);
            if (!haveNg) {
              const sumIn = await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS s FROM stock_logs WHERE docType = 'GRN' AND type = 'IN' AND id LIKE ? ESCAPE '\\'").bind(`LOG:${esc(poRow.id)}:%:${pl.idx}`).first().catch(() => null);
              const haveGood = pl.good > 0 ? await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(planLogId(pl.idx)).first().catch(() => null) : null;
              const used = (Number(sumIn && sumIn.s) || 0) + (pl.good > 0 && !haveGood ? pl.stockQty : 0);
              if (used + Math.round(pl.def * pl.conv * 10000) / 10000 > pl.ngCeiling + 1e-4) return errorResponse('จำนวนของชำรุดเกินยอดสั่งซื้อของรายการใน PO', 409);
            }
          }
          if (!(pl.good > 0)) continue;
          const have = await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(planLogId(pl.idx)).first().catch(() => null);
          if (have) continue;
          const sum = await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS s FROM stock_logs WHERE docType = 'GRN' AND type = 'IN' AND id LIKE ? ESCAPE '\\'").bind(`LOG:${esc(poRow.id)}:%:${pl.idx}`).first().catch(() => null);
          if ((Number(sum && sum.s) || 0) + pl.stockQty > pl.ceiling + 1e-4) return errorResponse('จำนวนที่รับเกินจำนวนตรวจรับของรายการใน PO', 409);
        }
      }

      // Optimistic lock (GAS uses LockService): only ONE concurrent receive can flip this PO's updatedAt token while it is still
      // non-terminal ; the loser gets 409 and must retry, so stock can never be added twice for the same read of the PO.
      const lockToken = `${new Date().toISOString()}#${uid()}`;
      const locked = stockOnly ? { id: poRow.id } : await db.prepare(
        "UPDATE pos SET updatedAt = ? WHERE id = ? AND UPPER(TRIM(status)) NOT IN ('CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND') AND updatedAt IS ? RETURNING id"
      ).bind(lockToken, poRow.id, poRow.updatedAt ?? null).first();
      if (!locked) {
        return errorResponse('เอกสาร PO ถูกแก้ไขหรือกำลังตรวจรับโดยผู้อื่น กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง', 409);
      }

      const items = parseJsonSafe(poRow.itemsJson, []);
      const timeline = parseJsonSafe(poRow.timelineJson, []);
      const evidence = parseJsonSafe(poRow.evidenceJson, {});
      const cleanPoNo = poRow.poNumber || poRow.id;
      // GRN number: the client's own (apiService.receiveGoods always sends one) is kept as is ; when absent the server issues the canonical
      // GRN-{poNo}-{NN} (warehouseService.generateGRNNumber) with NN = the next free receiving round of this PO. The PO is locked above, so
      // two receives of one PO cannot take the same round.
      const usedGrn = timeline.map((t) => /\((GRN-[^)]+)\)/.exec(String(t && t.action || ''))).filter(Boolean).map((m) => m[1]);
      const grNumber = bodyGrNo || options?.grNumber || await issueGrnNumber(db, { poNo: cleanPoNo, usedNumbers: usedGrn, round: options?.round });

      // stock updates + logs + the PO update are built first and committed together in ONE db.batch (all or nothing)
      const recvStmts = [];
      const recvLogIds = [];
      const recvProdIds = new Set();
      const ngPlan = [];
      for (const { rItem, idx, prod, prodKey, conv, stockQty, baseCost, ceiling, prCeil } of receivePlan) {
        const pId = prodKey; // the PO line's product, not the body's
        const goodQty = recvGoodOf(rItem);
        const defectiveQty = Number(rItem.defectiveQty || 0);

        // Update PO items
        const matchedItem = items[idx];
        if (matchedItem && !stockOnly) {
          matchedItem.receivedQty = (Number(matchedItem.receivedQty) || 0) + (goodQty + defectiveQty);
          matchedItem.goodQty = (Number(matchedItem.goodQty) || 0) + goodQty;
          matchedItem.defectiveQty = (Number(matchedItem.defectiveQty) || 0) + defectiveQty;
          matchedItem.storageLocation = rItem.storageLocation || matchedItem.storageLocation || matchedItem.usageLocation || 'DEFAULT';
        }

        // Update Products in D1
        if (goodQty > 0) {
          // The log id is derived from the GRN number (+ line), so a repeated request (retry / double click) hits the same id : the stock update is
          // guarded by "this log does not exist yet" and the insert is ON CONFLICT DO NOTHING, both inside the one batch -> never added twice.
          // (id = PO + GRN number + PO line position : the same however the request is ordered / repeated)
          const logId = `LOG:${poRow.id}:${grNumber}:${idx}`;
          // conversion, base cost and ceiling were worked out above from the stored PO line
          // the stock update and the log insert share ONE condition, evaluated inside the batch : this log does not exist yet AND the stock already logged
          // for this PO line plus this receipt stays within the ceiling (stockOnly : the received qty the PO line holds ; full receive : the ordered qty)
          const withPr = prCeil !== null && prCeil !== undefined && Boolean(prRefNo || prRefId);
          const cond = `NOT EXISTS (SELECT 1 FROM stock_logs WHERE id = ?)
            AND COALESCE((SELECT SUM(quantity) FROM stock_logs WHERE docType = 'GRN' AND type = 'IN' AND id LIKE ? ESCAPE '\\'), 0) + ? <= ?${withPr
    ? ` AND COALESCE((SELECT SUM(quantity) FROM stock_logs WHERE docType = 'GRN' AND type = 'IN' AND productId = ? AND poNo IN (SELECT poNumber FROM pos WHERE prNumber = NULLIF(?, '') OR prId = NULLIF(?, ''))), 0) + ? <= ?`
    : ''}`;
          const condBinds = [logId, `LOG:${esc(poRow.id)}:%:${idx}`, stockQty, Number(ceiling) + 1e-4,
            ...(withPr ? [prod?.id || pId, prRefNo, prRefId, stockQty, Number(prCeil) + 1e-4] : [])];
          if (prod && prod.id) {
            // moving average cost = GAS apiAppendStockMovements IN (Code.gs:3241-3248) : currentAvg = avgCost || standard price ; stock <= 0 counts as 0 ;
            // newAvg = (balance * currentAvg + qty * baseUnitPrice) / (balance + qty), rounded to 2 decimals
            const bal = 'MAX(COALESCE(currentStock, 0), 0)';
            const newAvg = `ROUND((${bal} * (CASE WHEN COALESCE(avgCost, 0) > 0 THEN avgCost WHEN COALESCE(standardPrice, 0) > 0 THEN standardPrice ELSE 0 END) + ? * ?) / (${bal} + ?), 2)`;
            recvStmts.push(db.prepare(`
              UPDATE products SET
                avgCost = ${newAvg},
                totalValue = ROUND((COALESCE(currentStock, 0) + ?) * ${newAvg}, 2),
                currentStock = COALESCE(currentStock, 0) + ?,
                updatedAt = CURRENT_TIMESTAMP
              WHERE id = ? AND ${cond}
            `).bind(stockQty, baseCost, stockQty, stockQty, stockQty, baseCost, stockQty, stockQty, prod.id, ...condBinds));
            recvProdIds.add(prod.id);
          }
          recvLogIds.push(logId);
          // balance is read inside the same batch, right after the stock update above
          recvStmts.push(db.prepare(`
            INSERT INTO stock_logs (id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo, quantity, changeQty, balance, unit, department, location, issuedTo,
              unitCost, unitPrice, totalCost, totalPrice, conversionRate, actorName, performedBy, grnNumber, createdAt)
            SELECT ?, ?, ?, ?, 'IN', 'GRN', ?, ?, ?, ?, ?, COALESCE((SELECT currentStock FROM products WHERE id = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
            WHERE ${cond}
            ON CONFLICT(id) DO NOTHING
          `).bind(
            logId,
            prod?.id || pId,
            prod?.code || matchedItem?.code || pId,
            prod?.name || matchedItem?.name || 'สินค้าตรวจรับ',
            grNumber,
            cleanPoNo,
            cleanPoNo,
            stockQty,
            stockQty,
            prod?.id || '',
            stockQty,
            rItem.unit || prod?.usageUnit || 'ชิ้น',
            poRow.department || 'PD',
            rItem.storageLocation || 'DEFAULT',
            actorName,
            baseCost,
            baseCost,
            Math.round(stockQty * baseCost * 100) / 100,
            Math.round(stockQty * baseCost * 100) / 100,
            conv,
            actorName,
            actorName,
            grNumber,
            ...condBinds
          ));
        }
        if (defectiveQty > 0) ngPlan.push({ pl: receivePlan.find((x) => x.idx === idx), def: defectiveQty, matchedItem });
      }

      // Defective goods : GAS keeps an IN_NG row in the stock card (qty only, grnNumber/docNo = the GRN, apiAppendStockMovements Code.gs:3236-3299 adds nothing to the
      // balance for IN_NG) ; currentStock / moving average cost are NOT touched. id bound to PO + GRN + line, so a retry never repeats it ; the full receive
      // writes it only when every good log of the receipt exists (same guard as the PO UPDATE below).
      const ngLogIds = [];
      for (const { pl, def, matchedItem } of ngPlan) {
        const ngId = `LOGNG:${poRow.id}:${grNumber}:${pl.idx}`;
        const ngQty = Math.round(def * pl.conv * 10000) / 10000;
        const ngProdId = pl.prod?.id || pl.prodKey;
        ngLogIds.push(ngId);
        const ngGuard = stockOnly
          ? `NOT EXISTS (SELECT 1 FROM stock_logs WHERE id = ?) AND ? <= ? - COALESCE((SELECT SUM(quantity) FROM stock_logs WHERE docType = 'GRN' AND type = 'IN' AND id LIKE ? ESCAPE '\\'), 0)`
          : `NOT EXISTS (SELECT 1 FROM stock_logs WHERE id = ?) AND (SELECT COUNT(*) FROM stock_logs WHERE id IN (${recvLogIds.length ? recvLogIds.map(() => '?').join(',') : "''"})) = ?`;
        const ngGuardBinds = stockOnly
          ? [ngId, ngQty, Number(pl.ngCeiling) + 1e-4, `LOG:${esc(poRow.id)}:%:${pl.idx}`]
          : [ngId, ...recvLogIds, recvLogIds.length];
        recvStmts.push(db.prepare(`
          INSERT INTO stock_logs (id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo, quantity, changeQty, balance, unit, department, location, issuedTo,
            actorName, performedBy, notes, grnNumber, createdAt)
          SELECT ?, ?, ?, ?, 'IN_NG', 'GRN', ?, ?, ?, ?, ?, COALESCE((SELECT currentStock FROM products WHERE id = ?), 0), ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
          WHERE ${ngGuard}
          ON CONFLICT(id) DO NOTHING
        `).bind(
          ngId, ngProdId, pl.prod?.code || matchedItem?.code || pl.prodKey, pl.prod?.name || matchedItem?.name || 'สินค้าตรวจรับ',
          grNumber, cleanPoNo, cleanPoNo, ngQty, ngQty, pl.prod?.id || '',
          pl.rItem.unit || pl.prod?.usageUnit || 'ชิ้น', poRow.department || 'PD', pl.rItem.storageLocation || 'DEFAULT', actorName,
          actorName, actorName, `[สินค้าชำรุด/NG] ${String(pl.rItem.defectReason || pl.rItem.defectNote || '').slice(0, 300)}`.trim(), grNumber,
          ...ngGuardBinds
        ));
      }

      if (stockOnly) {
        // GAS apiReceivePO (Code.gs:2949-2994) as the ReceivingModal flow reaches it : a receipt that leaves the PO NOT finished (PARTIAL / claim / round 2 ...)
        // writes the GOODS_RECEIVED_PARTIAL audit + PO_CLAIM notifications (Purchaser + Requester) ; a finished PO (CLOSED / COMPLETED ...) writes none here
        // (user decision, ask A). Same ids as the full receive (PO + GRN) -> once per GRN, a retry adds nothing ; same batch, guarded by the stock logs ;
        // actor from the token, department from the PO row.
        {
          const stStatus = normalizePoStatus(poRow.status) || '';
          const stDone = ['CLOSED', 'COMPLETED', 'COMPLETED_WITH_REFUND', 'RECEIVED'].includes(stStatus);
          if (!stDone) {
            const stIds = [...recvLogIds, ...ngLogIds]; // every row of this receipt (good + IN_NG) must exist
            const stWhere = `(SELECT COUNT(*) FROM stock_logs WHERE id IN (${stIds.length ? stIds.map(() => '?').join(',') : "''"})) = ?`;
            const stBinds = [...stIds, stIds.length];
            const stAudit = poAuditStmt(db, authUser, {
              id: `AUD-PO-GRN:${poRow.id}:${grNumber}`,
              action: 'GOODS_RECEIVED_PARTIAL',
              poId: poRow.id, poNo: cleanPoNo, status: poRow.status,
              comment: 'ตรวจรับสินค้า ' + (grNumber ? ('เลขที่ ' + grNumber) : '') + ' บางส่วน',
              whereSql: stWhere, whereBinds: stBinds
            });
            if (stAudit) recvStmts.push(stAudit);
            // a PO row without a department : no notification (never broadcast to ALL from here)
            if (String(poRow.department || '').trim()) {
              recvStmts.push(...notificationStmts(db, poReceiveNotificationParams({ closed: false, dept: poRow.department, poNo: cleanPoNo }), {
                idBase: `GRN:${poRow.id}:${grNumber}`, whereSql: stWhere, whereBinds: stBinds
              }));
            }
          }
        }
        try {
          await db.batch(recvStmts);
        } catch (e) {
          console.error('[receive] stock batch failed:', e && e.message);
          return errorResponse('ไม่สามารถบันทึกการตรวจรับสินค้าได้ กรุณาลองใหม่', 500);
        }
        const inList = (ids) => ids.map(() => '?').join(',');
        const allLogIds = [...recvLogIds, ...ngLogIds];
        const logRows = allLogIds.length ? ((await db.prepare(`SELECT * FROM stock_logs WHERE id IN (${inList(allLogIds)})`).bind(...allLogIds).all().catch(() => ({ results: [] }))).results || []) : [];
        // a line whose log is missing was refused by the in-batch ceiling (a concurrent receipt took the room) : tell the caller, nothing was added for it
        if (logRows.length < allLogIds.length) return errorResponse('จำนวนที่รับเกินจำนวนตรวจรับของรายการใน PO', 409);
        const prodIds = [...recvProdIds];
        const prodRows = prodIds.length ? ((await db.prepare(`SELECT * FROM products WHERE id IN (${inList(prodIds)})`).bind(...prodIds).all().catch(() => ({ results: [] }))).results || []) : [];
        return jsonResponse({
          success: true,
          stockOnly: true,
          grNumber,
          products: await productViews(db, prodRows),
          stockLogs: withGrnNumber(logRows),
          ...(receiveSkipped.length ? { skipped: receiveSkipped } : {}),
          message: 'บันทึกสต็อกจากการตรวจรับสำเร็จ'
        });
      }

      // status like the web engine (workflowEngine.receiveGoods, no claim) : every line received -> CLOSED, else PARTIAL (the statuses PODetailsModal
      // knows : a PARTIAL PO keeps its "receive next round" button) ; the ReceivingModal flow saves COMPLETED itself with the PO PUT
      const allReceived = items.every(it => Number(it.receivedQty || 0) >= orderedQtyOf(it));
      const newStatus = allReceived ? 'CLOSED' : 'PARTIAL';

      timeline.push({
        action: `ตรวจรับสินค้า (${grNumber})`,
        user: actorName,
        role: actorRole,
        date: timestamp,
        timestamp,
        note: note || `ตรวจรับเข้าสต็อก ${newStatus === 'CLOSED' ? 'ครบถ้วน' : 'บางส่วน'}`
      });

      // receiver details + the GRN entry are written by the server from the token (what workflowEngine.receiveGoods / warehouseService composed on the client)
      const recvStored = parseExtra(poRow.extraJson);
      const recvExtra = await receiverPatch(db, authUser);
      const roundNo = (Array.isArray(recvStored.grnHistory) ? recvStored.grnHistory.length : 0) + 1;
      recvExtra.grnHistory = (Array.isArray(recvStored.grnHistory) ? recvStored.grnHistory : []).concat([{
        grnNumber: grNumber, grnNo: grNumber, round: roundNo, roundNumber: roundNo, date: timestamp, receivedBy: receivedByLabel(actorOf(authUser)),
        items: receivePlan.map(({ rItem, idx }) => grnItemView(rItem, items[idx])),
        note: String(note || '').slice(0, 1000), poNumber: cleanPoNo, poNo: cleanPoNo, refPo: cleanPoNo
      }]).slice(-500);
      recvExtra.workflowStatus = newStatus;
      recvExtra.logSealed = sealLogKeys(recvStored, PO_LOG_KEYS, ['grnHistory']);
      if (newStatus === 'CLOSED' && !recvStored.fullyReceivedAt) recvExtra.fullyReceivedAt = timestamp;
      const recvExtraJson = extraPatchJson(recvExtra, recvStored);
      if (recvExtraJson === null) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
      recvStmts.push(db.prepare(`
        UPDATE pos SET
          status = ?,
          itemsJson = ?,
          timelineJson = ?,
          evidenceJson = ?,
          extraJson = json_patch(COALESCE(NULLIF(extraJson, ''), '{}'), ?),
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
          AND (SELECT COUNT(*) FROM stock_logs WHERE id IN (${recvLogIds.length ? recvLogIds.map(() => '?').join(',') : "''"})) = ?
      `).bind(newStatus, JSON.stringify(items), JSON.stringify(timeline), JSON.stringify(evidence), recvExtraJson, poRow.id, ...recvLogIds, recvLogIds.length));
      // GAS apiReceivePO audit (Code.gs:2951) : same batch, same guard as the PO UPDATE above (nothing when the receipt was refused) ; id bound to the GRN so a retry never repeats it
      {
        const recvClosed = newStatus === 'CLOSED' || newStatus === 'COMPLETED';
        const recvAudit = poAuditStmt(db, authUser, {
          id: `AUD-PO-GRN:${poRow.id}:${grNumber}`,
          action: recvClosed ? 'GOODS_RECEIVED_FULL' : 'GOODS_RECEIVED_PARTIAL',
          poId: poRow.id, poNo: cleanPoNo, status: newStatus,
          comment: 'ตรวจรับสินค้า ' + (grNumber ? ('เลขที่ ' + grNumber) : '') + (recvClosed ? ' ครบถ้วนแล้ว ปิดใบงาน' : ' บางส่วน'),
          whereSql: `(SELECT COUNT(*) FROM stock_logs WHERE id IN (${recvLogIds.length ? recvLogIds.map(() => '?').join(',') : "''"})) = ?`,
          whereBinds: [...recvLogIds, recvLogIds.length]
        });
        if (recvAudit) recvStmts.push(recvAudit);
        // GAS apiReceivePO notifications (:2966-2990) : same guard, ids bound to the GRN -> a retry adds nothing ; stockOnly never reaches here (returned above)
        recvStmts.push(...notificationStmts(db, poReceiveNotificationParams({ closed: recvClosed, dept: poRow.department, poNo: cleanPoNo }), {
          idBase: `GRN:${poRow.id}:${grNumber}`,
          whereSql: `(SELECT COUNT(*) FROM stock_logs WHERE id IN (${recvLogIds.length ? recvLogIds.map(() => '?').join(',') : "''"})) = ?`,
          whereBinds: [...recvLogIds, recvLogIds.length]
        }));
        // GAS apiReceivePO step 10 : every line received (PO CLOSED) -> the PR is completed in the same batch (after the PO UPDATE it depends on)
        if (recvClosed) {
          const prCasc = prCascadeStmt(db, authUser, { prRow: await prCascadeFor(db, poRow), poRow, poNo: cleanPoNo, iso: new Date().toISOString() });
          recvStmts.push(...prCasc);
        }
      }
      try {
        await db.batch(recvStmts);
      } catch (e) {
        console.error('[receive] batch failed:', e && e.message);
        return errorResponse('ไม่สามารถบันทึกการตรวจรับสินค้าได้ กรุณาลองใหม่', 500);
      }
      // the PO row above is only written when every stock log of this receipt exists : if one was refused by the in-batch ceiling the PO is untouched
      if (recvLogIds.length) {
        const placeholders = recvLogIds.map(() => '?').join(',');
        const made = await db.prepare(`SELECT COUNT(*) AS n FROM stock_logs WHERE id IN (${placeholders})`).bind(...recvLogIds).first().catch(() => null);
        if (!made || Number(made.n) < recvLogIds.length) return errorResponse('จำนวนที่รับเกินจำนวนที่สั่งของรายการใน PO', 409);
      }
      markTouched('pos', poRow.id);

      const { logSealed: _sealed, ...recvView } = recvExtra;
      const updatedPo = { ...poExtraView(poRow.extraJson), ...recvView, ...poRow, ...poAliasOf(poRow), status: newStatus, items, timeline, evidence };
      return jsonResponse({
        success: true,
        po: updatedPo,
        ...(receiveSkipped.length ? { skipped: receiveSkipped } : {}),
        message: 'บันทึกการตรวจรับสินค้าสำเร็จ'
      });
    }

    // ── 4.2 PO Settle & Finalize Endpoint (/api/pos/:id/settle) ──
    const settleMatch = path.match(/^\/api\/pos\/([^/]+)\/settle$/);
    if (method === 'POST' && settleMatch) {
      if (!db) return jsonResponse({ success: false, localMode: true });
      const targetPoId = decodeURIComponent(settleMatch[1]);
      const body = await request.json().catch(() => ({}));
      { const shape = checkBodyShape(body); if (shape) return errorResponse(shape.message, shape.status); }
      { const bad = await sanitizeWriteBody(db, body, authUser, { docKey: targetPoId }); if (bad) return errorResponse(bad.message, bad.status); }
      const poRow = await db.prepare('SELECT * FROM pos WHERE id = ? OR poNumber = ? ORDER BY (id = ?) DESC LIMIT 1').bind(targetPoId, targetPoId, targetPoId).first().catch(() => null);
      if (!poRow) {
        return errorResponse(`ไม่พบเอกสารใบสั่งซื้อ PO ID: ${targetPoId}`, 404);
      }
      // client canAction checks the PO department for everyone except admin / online purchaser (parity) - before anything about the PO is revealed
      if (!canAccessDepartment(authUser, poRow.department || 'PD')) return errorResponse(FORBIDDEN_MSG, 403);
      if (['CANCELLED', 'DRAFT'].includes(String(poRow.status || '').trim().toUpperCase())) {
        return errorResponse('ไม่สามารถปิดงาน PO ที่ถูกยกเลิกหรือยังเป็นฉบับร่างได้', 409);
      }

      const cleanPoNo = poRow.poNumber || poRow.id;
      const dept = poRow.department || 'PD';

      // Settlement parity with gas/Code.gs apiSettlePO (T4.6c) : the client (POSettlementModal -> apiService.settlePO) sends actualTotalAmount /
      // actualItems / settlementNote / settlementProofUrl (and a savingsAmount that is NEVER trusted). The server computes the savings itself,
      // refunds them through the shared refund cap + REFUND_SETTLEMENT ledger row, stores the result on the PO and leaves `status` alone
      // (GAS and the client only set settlementStatus = 'SETTLED').
      const rawActual = body.actualTotalAmount !== undefined && body.actualTotalAmount !== null && body.actualTotalAmount !== '' ? body.actualTotalAmount
        : (body.actualTotal !== undefined && body.actualTotal !== null && body.actualTotal !== '' ? body.actualTotal : null);
      const hasActual = rawActual !== null;
      const actualTotal = hasActual ? Math.round(Number(rawActual) * 100) / 100 : null;
      if (hasActual && (!Number.isFinite(actualTotal) || actualTotal < 0)) return errorResponse('ยอดเงินจ่ายจริงไม่ถูกต้อง', 400);
      // legacy shape (no actualTotalAmount): an explicit refundAmount, still capped (400 when above the cap)
      const legacyRefund = hasActual ? 0 : Number(body.refundAmount || body.totalRefunded || 0);
      if (!Number.isFinite(legacyRefund) || legacyRefund < 0) return errorResponse('ยอดคืนงบประมาณไม่ถูกต้อง', 400);

      const extra = parseJsonSafe(poRow.extraJson, {});
      // Settling again (the UI's "edit the actual amount" button after closing) is allowed, like GAS apiSettlePO which simply overwrites the settlement
      // fields : the new figures replace the old ones. Budget: only the INCREASE of the savings is refunded (see `wanted` below), nothing is pulled back.
      const wasSettled = Boolean(extra && extra.settlementStatus === 'SETTLED');

      // Refund rule: a refund is only ever paid against a PR_COMMITMENT that the server validated (POST /api/budget-transactions) for a REAL PR
      // of the same department. No such PR / commitment => no refund (the settlement is still recorded). Ceiling = shared refund cap :
      // min( commitment − refunds already paid on any PO of that PR , PO value the server snapshotted (approvedTotal) − refunds of this PO ).
      const approvedTotal = Number(extra && extra.approvedTotal) > 0 ? Number(extra.approvedTotal) : 0;
      const prKey = String(poRow.prNumber || poRow.prId || '').trim();
      const prRow = prKey ? await db.prepare('SELECT id, prNumber, department FROM prs WHERE prNumber = ? OR id = ? ORDER BY (prNumber = ?) DESC LIMIT 1')
        .bind(prKey, prKey, prKey).first().catch(() => null) : null;
      if (prRow && normalizeDeptCode(prRow.department) !== normalizeDeptCode(dept) && (hasActual || legacyRefund > 0)) {
        return errorResponse('PO และ PR อยู่คนละแผนก ไม่สามารถคืนงบประมาณได้', 400);
      }
      const ev = prRow ? await db.prepare(`
        SELECT
          COALESCE((SELECT SUM(ABS(amount)) FROM budget_transactions WHERE UPPER(type) = 'PR_COMMITMENT' AND docNo = ?), 0) AS prCommit,
          COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE ${RETURN_TYPES_SQL}
            AND docNo IN (SELECT poNumber FROM pos WHERE prNumber = ? OR prId = ?)), 0) AS refunded,
          COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE ${RETURN_TYPES_SQL} AND docNo = ?), 0) AS poRefunded,
          COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE UPPER(type) = 'BUDGET_DEDUCT' AND docNo = ?), 0) AS poDeducted,
          COALESCE((SELECT SUM(amount) FROM budget_transactions WHERE actionType = 'REFUND_SETTLEMENT' AND docNo = ?), 0) AS settleRefunded
      `).bind(prRow.prNumber, prRow.prNumber, prRow.id, cleanPoNo, cleanPoNo, cleanPoNo).first().catch(() => null) : null;
      const committed = Number(ev && ev.prCommit) || 0;
      const poRefunded = Number(ev && ev.poRefunded) || 0;
      const poDeducted = Number(ev && ev.poDeducted) || 0;
      const capLeft = Math.min(committed - (Number(ev && ev.refunded) || 0), approvedTotal - poRefunded);
      const r2 = (x) => Math.round(x * 100) / 100;

      // savings: what this PO really took from the budget (approved value + extra deductions − what was already given back) minus what was
      // actually paid. Without a server snapshot (old / imported PO) the GAS base (grandTotal) is used for the figure shown, but nothing is refunded.
      const grandBase = Number(poRow.grandTotal || poRow.totalAmount || 0);
      // refunds this very settlement already paid (earlier settle of the same PO) are not "given back by someone else" : they are the part of
      // the savings that has been refunded, so the base excludes them and they are subtracted from the new savings below
      const settleRefunded = Number(ev && ev.settleRefunded) || 0;
      const cutBase = approvedTotal > 0 ? r2(approvedTotal + poDeducted - (poRefunded - settleRefunded)) : grandBase;
      const savings = hasActual ? r2(cutBase - actualTotal) : 0;
      const target = hasActual ? Math.max(0, savings) : legacyRefund; // total this settlement may have refunded (overpaid : GAS refunds nothing and deducts nothing)
      // GAS parity : the budget is refunded by the FIRST settlement only (apiAppendBudgetTransaction is idempotent per type + docNo). A later edit of the
      // actual amount overwrites the settlement fields but refunds nothing more and pulls nothing back.
      const wanted = settleRefunded > 0 ? 0 : r2(target);

      let refundDenied = null;
      let refundEffective = 0;
      let refundClamped = false;
      if (wanted > 0) {
        if (!prRow || committed <= 0 || approvedTotal <= 0 || !(capLeft > 0)) {
          refundDenied = !prRow ? 'NO_PR' : (committed <= 0 ? 'NO_COMMITMENT' : 'NOTHING_LEFT');
        } else if (hasActual) {
          // computed by the server -> refund what the cap allows (the settlement itself must not fail on it)
          refundEffective = Math.min(wanted, r2(capLeft));
          refundClamped = refundEffective + 0.005 < wanted;
        } else if (wanted > capLeft + 0.005) {
          return errorResponse('ยอดคืนงบประมาณเกินมูลค่าที่ตัดงบไว้', 400);
        } else {
          refundEffective = wanted;
        }
      }

      // items with the actual unit price per line (GAS :3094-3111) - explicit client price if valid, else the paid/ordered ratio
      const items = parseJsonSafe(poRow.itemsJson, []);
      const clientItems = Array.isArray(body.actualItems) ? body.actualItems : [];
      const ratio = hasActual && grandBase > 0 ? actualTotal / grandBase : 1;
      const settledItems = (Array.isArray(items) ? items : []).map((it, idx) => {
        const explicit = Number(clientItems[idx] && clientItems[idx].actualUnitPrice);
        const base = Number(it.price || it.unitPrice || it.estimatedPrice || 0);
        const unit = hasActual ? (Number.isFinite(explicit) && explicit >= 0 && explicit < 1e9 ? explicit : Math.round(base * ratio * 100) / 100) : Number(it.actualUnitPrice ?? base);
        return hasActual ? { ...it, actualPrice: unit, actualUnitPrice: unit, unitPrice: unit } : it;
      });
      const settledAt = new Date().toISOString();
      const patch = {
        settlementStatus: 'SETTLED',
        settlementNote: str100(body.settlementNote || body.note, 1000),
        settlementProofUrl: str100(body.settlementProofUrl || body.proofUrl, 2000), // already cleaned by sanitizeWriteBody
        settledBy: authUser.name || authUser.username || 'Purchaser', // from the token, never the body
        settledAt,
        ...(hasActual ? { savingsAmount: savings, actualItems: settledItems } : {})
      };

      // one atomic batch: ledger row (guarded by NOT EXISTS REFUND_SETTLEMENT of this PO and by the shared cap) -> budgets only if that row was
      // inserted -> PO result (last write wins, like GAS). Two concurrent settles of one PO therefore refund the savings only once.
      const stmts = [];
      let settleTxId = null;
      if (refundEffective > 0) {
        const txId = `TX-${Date.now()}-${uid()}`;
        settleTxId = txId;
        const settleGuard = refundCapGuard(refundEffective, { prNumber: prRow.prNumber, prId: prRow.id, approvedTotal, poNumber: cleanPoNo });
        stmts.push(db.prepare(`
          INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date, refundAmount, actorUserId, docType, docNo, poNumber)
          SELECT ?, ?, ?, 'BUDGET_ROLLBACK', 'REFUND_SETTLEMENT', 'คืนงบประมาณ (Refund)', ?, ?, 0, 0, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'PO', ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM budget_transactions WHERE actionType = 'REFUND_SETTLEMENT' AND docNo = ?)
            ${settleGuard.sql}
        `).bind(
          txId,
          dept,
          dept,
          refundEffective,
          refundEffective,
          authUser.name || authUser.username || 'Budget Specialist',
          hasActual ? `คืนงบประมาณจากการปิดยอดจ่ายจริง (Online Settlement) PO ${cleanPoNo} (ประหยัด ฿${savings.toLocaleString()})` : (body.note || `คืนงบประมาณจากการเคลม/ปิดงาน (${cleanPoNo})`),
          bangkokMonth(), bangkokMonth(), // refund is booked in the month it is settled
          refundEffective,
          authUser.userId,
          cleanPoNo,
          cleanPoNo,
          cleanPoNo,
          // the ceiling is re-checked inside the same statement so two concurrent refunds (settle / claim credit / adjust) cannot exceed it
          ...settleGuard.binds
        ));
        stmts.push(db.prepare(`
          UPDATE budgets
          SET totalUsed = MAX(0, totalUsed - ?), totalRemaining = totalRemaining + ?, updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (SELECT 1 FROM budget_transactions WHERE id = ?)
        `).bind(refundEffective, refundEffective, normalizeDeptCode(dept), txId));
      }
      stmts.push(db.prepare(`
        UPDATE pos SET
          extraJson = json_patch(COALESCE(NULLIF(extraJson, ''), '{}'), ?),
          actualTotalAmount = COALESCE(?, actualTotalAmount),
          itemsJson = ?,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(JSON.stringify(patch), actualTotal, JSON.stringify(hasActual ? settledItems : items), poRow.id));
      // GAS apiSettlePO audit (Code.gs:3092) : PO_SETTLED every time (a re-settle too), same batch as the PO result
      stmts.push(poAuditStmt(db, authUser, {
        id: `AUD-${Date.now()}-${uid()}`, action: 'PO_SETTLED', poId: poRow.id, poNo: cleanPoNo, status: poRow.status,
        comment: 'ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿' + Number(grandBase || 0).toLocaleString('en-US') + (hasActual ? ' | ยอดจ่ายจริง ฿' + actualTotal.toLocaleString('en-US') : '') // GAS throws without an actual total ; the legacy refund-only call just has no such segment
          + (savings > 0 ? (' | ประหยัดงบ ฿' + savings.toLocaleString('en-US')) : '') + (patch.settlementNote ? (' | ' + patch.settlementNote) : '')
      }));
      try {
        await db.batch(stmts);
      } catch (e) {
        console.error('[settle] batch failed:', e && e.message);
        return errorResponse('ไม่สามารถบันทึกการปิดยอดได้', 500);
      }
      markTouched('pos', poRow.id);

      // the statement-level guard may have refused the refund (a concurrent settle of the same PO already paid it): the settlement stands without it
      if (settleTxId) {
        const written = await db.prepare('SELECT id FROM budget_transactions WHERE id = ? LIMIT 1').bind(settleTxId).first().catch(() => null);
        if (!written) { refundDenied = 'NOTHING_LEFT'; refundEffective = 0; refundClamped = false; }
      }
      return jsonResponse({
        success: true,
        id: targetPoId,
        settlementStatus: 'SETTLED',
        ...(wasSettled ? { resettled: true } : {}),
        ...(hasActual ? { actualTotalAmount: actualTotal, savingsAmount: savings } : {}),
        refundedAmount: refundEffective,
        ...(refundClamped ? { refundClamped: true, refundRequested: wanted } : {}),
        ...(refundDenied ? { refundSkipped: true, refundDenied } : {}),
        message: refundDenied ? 'บันทึกการปิดยอดแล้ว แต่ไม่คืนงบประมาณ (ไม่พบยอดผูกพันงบของ PR ที่ตรวจแล้ว หรือคืนครบเพดานแล้ว)' : 'บันทึกการปิดยอด/ชำระเงินเรียบร้อย'
      });
    }

    // ── 4.3 General POs Endpoints (/api/pos or /api/po) ──
    if (path === '/api/pos' || path === '/api/po' || path.startsWith('/api/pos/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/pos/') ? decodeURIComponent(path.replace('/api/pos/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM pos ORDER BY createdAt DESC').all();
        const pos = filterDocuments(scopeViewer, (res.results || []).map(r => ({
          ...poExtraView(r.extraJson),
          ...utcIsoRow(r),
          ...poAliasOf(r),
          items: parseJsonSafe(r.itemsJson, []),
          timeline: parseJsonSafe(r.timelineJson, []),
          evidence: parseJsonSafe(r.evidenceJson, {}),
          ...poSettlementFields(r.extraJson)
        })));
        return jsonResponse(pos);
      }

      if (method === 'POST') {
        const data = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(data); if (shape) return errorResponse(shape.message, shape.status); }
        { const bad = await sanitizeWriteBody(db, data, authUser); if (bad) return errorResponse(bad.message, bad.status); }
        const poList = Array.isArray(data) ? data : [data];
        // existing row + no status sent => keep the stored status (never the 'ORDERED' default) ; status sent => always checked
        const poCur = new Map();
        const poGuard = new Map();
        const poPr = new Map();
        const poIssued = new Set(); // POs whose number the server issued
        const prUsed = new Map(); // PR id -> Map(product key -> qty already taken by its POs, this request included)
        const seenPo = new Set();
        for (const p of poList) {
          if (!p || typeof p !== 'object') return errorResponse('ข้อมูลไม่ถูกต้อง', 400);
          if (!p.id) p.id = `PO-${Date.now()}-${uid()}`;
          { const bad = checkPoStatus(p, authUser); if (bad) return errorResponse(bad.message, bad.status); }
          for (const k of ['totalAmount', 'total', 'vatAmount', 'vat', 'grandTotal', 'subtotal']) {
            if (p[k] === undefined || p[k] === null || p[k] === '') continue;
            const n = Number(p[k]);
            if (!Number.isFinite(n) || n < 0) return errorResponse('ยอดเงินของ PO ไม่ถูกต้อง', 400);
          }
          const batchKeys = [String(p.id), String(p.poNumber || p.poNo || p.id)];
          if (batchKeys.some((k) => seenPo.has(k))) return errorResponse('รหัส/เลขที่ PO ซ้ำกันในคำขอเดียวกัน', 400);
          batchKeys.forEach((k) => seenPo.add(k));
          const cur = p.id ? await lookupStatus(db, 'SELECT status, department, totalAmount, vatAmount, grandTotal, timelineJson, itemsJson, evidenceJson, purchaseChannel, extraJson FROM pos WHERE id = ? LIMIT 1', p.id) : null;
          poCur.set(p, cur);
          // lines / evidence: existing row + not sent => keep the stored value ; received quantities never go down ; actual prices are fixed after the settlement ;
          // a final status only accepts ADDED evidence (checked here, before anything of the request is written)
          {
            const storedExtra = cur ? parseExtra(cur.extraJson) : {};
            const lockPrice = Boolean(cur) && (storedExtra.settlementStatus === 'SETTLED' || String(cur.status || '').trim().toUpperCase() === 'SETTLED');
            const admin = normalizeUser(authUser).isAdmin;
            const itemNotes = [];
            const itemsOut = Array.isArray(p.items)
              ? guardPoItems(cur ? parseJsonSafe(cur.itemsJson, []) : [], p.items, { admin, lockPrice, onlineish: resolvePermissions(authUser).onlineish, storedStatus: cur ? cur.status : '', notes: itemNotes, grnStarted: hasGrn(storedExtra) })
              : (cur ? parseJsonSafe(cur.itemsJson, []) : []);
            const evOut = guardedDocBlob(cur ? parseJsonSafe(cur.evidenceJson, {}) : undefined, p.evidence, Boolean(cur), cur && cur.status, {});
            poGuard.set(p, { itemsJson: JSON.stringify(itemsOut), evidenceJson: JSON.stringify(evOut), storedExtra, itemNotes });
          }
          if (cur && poAmountsFrozenAndChanged(authUser, cur, p)) return errorResponse(FORBIDDEN_MSG, 403);
          // existing PO: same department gate as PR (client canAction / list filters by department ; online purchaser, admin, all-dept users pass)
          if (cur && !canAccessDepartment(authUser, cur.department)) return errorResponse(FORBIDDEN_MSG, 403);
          const effective = p.status || (cur ? null : 'ORDERED');
          if (effective && !canTransitionPO(authUser, cur ? cur.status : undefined, effective, cur ? await poOwnerCtx(db, authUser, p.id) : {})) return errorResponse(FORBIDDEN_MSG, 403);
          if (!cur) {
            // a new PO's id must not be another PO's number (lookups are "id = ? OR poNumber = ?" - same rule as for PRs)
            if (await lookupStatus(db, 'SELECT id FROM pos WHERE poNumber = ? LIMIT 1', p.id)) return errorResponse('รหัส/เลขที่ PO ซ้ำกับเอกสารที่มีอยู่', 409);
            // ... nor a PR's number (file references are resolved by number : a PO id equal to a PR number would be ambiguous)
            if (await lookupStatus(db, 'SELECT id FROM prs WHERE prNumber = ? LIMIT 1', p.id)) return errorResponse('รหัส/เลขที่ PO ซ้ำกับเอกสารที่มีอยู่', 409);
            // A NEW PO only exists because an approved PR issued it (workflowEngine.createPOFromPR -> apiService.updatePRStatus POSTs it after the PR
            // PUT): it must reference a real PR that is APPROVED/PO_ISSUED/IN_PROGRESS_ONLINE, in the same department. Admin may seed data.
            const key = String(p.prNumber || p.prNo || p.prId || '').trim();
            const prRow = key ? await lookupStatus(db,
              'SELECT id, prNumber, status, department, totalAmount, requesterId, requesterName, extraJson, itemsJson FROM prs WHERE prNumber = ? OR id = ? ORDER BY (prNumber = ?) DESC LIMIT 1', key, key, key) : null;
            poPr.set(p, prRow);
            if (!normalizeUser(authUser).isAdmin) {
              const sameDept = prRow && String(prRow.department || '').toUpperCase() === String(p.department || prRow.department || '').toUpperCase();
              if (!prRow || !['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE'].includes(prRow.status) || !sameDept) {
                return errorResponse('PO ต้องอ้างอิง PR ที่อนุมัติแล้วและอยู่แผนกเดียวกัน', 400);
              }
              if (!canAccessDepartment(authUser, prRow.department)) return errorResponse(FORBIDDEN_MSG, 403);
              // A PO is issued by the final approver of the PR (workflowEngine.updatePRStatus -> createPOFromPR, the REVIEWED -> PO_ISSUED / IN_PROGRESS_ONLINE
              // step) : the same roles may POST a new PO. Its first status is the one createPOFromPR sets.
              if (!(canTransitionPR(authUser, 'REVIEWED', 'PO_ISSUED') || canTransitionPR(authUser, 'REVIEWED', 'IN_PROGRESS_ONLINE'))) return errorResponse(FORBIDDEN_MSG, 403);
              if (!['ISSUED', 'IN_PROGRESS_ONLINE'].includes(String(p.status || '').toUpperCase())) return errorResponse('สถานะเริ่มต้นของ PO ไม่ถูกต้อง', 400);
              // lines come from the PR (same product) and, over all the PR's POs that are not cancelled (split PO included), do not pass the PR's qty
              const prItems = parseJsonSafe(prRow.itemsJson, []);
              // A PR approved with no stored lines (imported / legacy) cannot be checked : only an admin issues a PO for it (see docs/parity.md for the check query)
              if (!prItems.length) return errorResponse('PR นี้ไม่มีรายการสินค้าในระบบ ไม่สามารถออก PO ได้ กรุณาให้ผู้ดูแลระบบ (admin) สร้าง PO', 400);
              const gd = poGuard.get(p);
              const lines = parseJsonSafe(gd.itemsJson, []);
              if (!lines.length) return errorResponse('PO ต้องมีรายการสินค้าจาก PR', 400);
              // what the PR's other POs already took : a live PO counts its ordered qty, a CANCELLED one what it had already received (that stock is in)
              if (!prUsed.has(prRow.id)) {
                const used = new Map(); // PR row index -> qty taken
                const others = (await db.prepare('SELECT status, itemsJson FROM pos WHERE prNumber = ? OR prId = ?').bind(prRow.prNumber, prRow.id).all().catch(() => ({ results: [] }))).results || [];
                for (const o of others) {
                  const cancelled = normalizePoStatus(o.status) === 'CANCELLED';
                  const oLines = parseJsonSafe(o.itemsJson, []);
                  // the row a line was paired with when its PO was made (prRowIndex, written by the server) ; an older PO without it is paired again
                  const paired = pickPrRows(prItems, oLines);
                  oLines.forEach((it, i) => {
                    const stored = it && Number.isInteger(it.prRowIndex) && it.prRowIndex >= 0 && it.prRowIndex < prItems.length ? it.prRowIndex : -1;
                    const row = stored >= 0 ? stored : paired[i];
                    if (row < 0) return;
                    const q = cancelled ? Math.max(Number(it && it.goodQty) || 0, Number(it && it.receivedQty) || 0) : orderedQtyOf(it);
                    used.set(row, (used.get(row) || 0) + q);
                  });
                }
                prUsed.set(prRow.id, used);
              }
              const used = prUsed.get(prRow.id);
              const pend = new Map();
              const rowOfLine = pickPrRows(prItems, lines,
                (i, ln) => (used.get(i) || 0) + (pend.get(i) || 0) + orderedQtyOf(ln) <= orderedQtyOf(prItems[i]) + 1e-9,
                (i, ln) => pend.set(i, (pend.get(i) || 0) + orderedQtyOf(ln)));
              for (let li = 0; li < lines.length; li += 1) {
                const line = lines[li];
                const prItem = isPlain(line) && rowOfLine[li] >= 0 ? prItems[rowOfLine[li]] : null;
                if (!prItem) return errorResponse('รายการใน PO ไม่ตรงกับรายการใน PR', 400);
                // one qty for every qty key of the line (the highest the body sent), so every reader of the line sees the same figure
                const q = orderedQtyOf(line);
                let wrote = false;
                for (const qk of QTY_KEYS) if (qk in line) { line[qk] = q; wrote = true; }
                if (!wrote) line.qty = q;
                const total = (used.get(rowOfLine[li]) || 0) + q;
                if (total > orderedQtyOf(prItem) + 1e-9) return errorResponse('จำนวนใน PO รวมแล้วเกินจำนวนใน PR', 400);
                used.set(rowOfLine[li], total);
                line.prRowIndex = rowOfLine[li]; // server-owned : the PR row this line was paired with
              }
              gd.itemsJson = JSON.stringify(lines);
            }
            // Conversion is written onto every line of a new PO NOW (every role, admin included) and never read from anywhere else later : the matching PR
            // row's rate, else a snapshot of the product's (the screens used it when the line had none), else 1. An admin's own valid figure is kept.
            {
              const gd2 = poGuard.get(p);
              const lines2 = parseJsonSafe(gd2.itemsJson, []);
              const prItems2 = prRow ? parseJsonSafe(prRow.itemsJson, []) : [];
              const rows2 = pickPrRows(prItems2, lines2);
              const isAdmin2 = normalizeUser(authUser).isAdmin;
              for (let li = 0; li < lines2.length; li += 1) {
                const line = lines2[li];
                if (!isPlain(line)) continue;
                // the row written above (non-admin) or the one found now ; written on the line for later readers
                const ri = Number.isInteger(line.prRowIndex) && line.prRowIndex >= 0 && line.prRowIndex < prItems2.length ? line.prRowIndex : rows2[li];
                if (ri >= 0) line.prRowIndex = ri; else delete line.prRowIndex;
                const prItem = ri >= 0 ? prItems2[ri] : null;
                let conv = isAdmin2 && prRateOf(line) > 0 && prRateOf(line) <= CONV_MAX ? prRateOf(line) : 0;
                if (!conv && prItem) conv = prRateOf(prItem);
                if (!conv) {
                  const pk = (prItem && (prItem.productId || prItem.code)) || line.productId || line.code || line.id;
                  const pr0 = pk ? await db.prepare('SELECT conversionRate FROM products WHERE id = ? OR code = ? ORDER BY (id = ?) DESC LIMIT 1').bind(pk, pk, pk).first().catch(() => null) : null;
                  conv = pr0 && Number(pr0.conversionRate) > 0 ? Number(pr0.conversionRate) : 1;
                }
                if (conv > CONV_MAX) return errorResponse('อัตราแปลงหน่วยไม่ถูกต้อง', 400);
                line.conversionRate = conv;
                if ('conversionRatio' in line) line.conversionRatio = conv;
              }
              gd2.itemsJson = JSON.stringify(lines2);
            }
            // number (T3.3): the client's own PO number is kept when free ; not sent -> the server issues PO-{DEPT}-{YYYY}-{NNN} from doc_counters
            // and returns it in body.po / body.poNo. A number that is already taken is REFUSED (409) instead of being replaced : the client
            // does not read the response of POST /api/pos (apiService.updatePRStatus), so a silent renumber would leave it holding a number
            // that does not exist on the server.
            const askedNo = String(p.poNumber || p.poNo || '').trim();
            if (askedNo) {
              if (await lookupStatus(db, 'SELECT id FROM pos WHERE poNumber = ? OR id = ? LIMIT 1', askedNo, askedNo)) return errorResponse('เลขที่ PO ซ้ำกับเอกสารที่มีอยู่', 409);
            } else {
              const issued = await issueDocNumber(db, { docType: 'PO', dept: normalizeDeptCode((prRow && prRow.department) || p.department || authUser.department || 'PUR') });
              p.poNumber = issued.docNo;
              p.poNo = issued.docNo;
              poIssued.add(p);
            }
          }
        }
        for (const p of poList) {
          const poId = p.id;
          let poNo = p.poNumber || p.poNo || poId;
          const newPr = poPr.get(p) || null;
          const prId = newPr ? newPr.id : (p.prId || '');
          const prNo = newPr ? newPr.prNumber : (p.prNumber || p.prNo || '');
          const dept = newPr ? newPr.department : (p.department || 'PD');
          const vendorId = p.vendorId || p.supplierId || '';
          const vendorName = p.vendorName || p.supplierName || '';
          // existing PO + amount not sent => keep the stored amount (an upsert must not zero the PO value)
          const cc = poCur.get(p);
          const sent = (v) => v !== undefined && v !== null && v !== '';
          // (the client's own PO shape carries subtotal / vat / grandTotal : a new PO without totalAmount / vatAmount takes them from there, so
          // the amounts are not stored as 0 next to a non-zero grandTotal)
          const total = cc && !sent(p.totalAmount) && !sent(p.total) ? Number(cc.totalAmount || 0) : Number(p.totalAmount || p.total || (cc ? 0 : p.subtotal) || 0) || 0;
          const vat = cc && !sent(p.vatAmount) ? Number(cc.vatAmount || 0) : Number(p.vatAmount || (cc ? 0 : p.vat) || 0) || 0;
          const grand = cc && !sent(p.grandTotal) ? Number(cc.grandTotal || total) : Number(p.grandTotal || total);
          const status = p.status || (poCur.get(p) ? poCur.get(p).status : 'ORDERED');
          const guard = poGuard.get(p);
          const itemsJson = guard.itemsJson;
          const paymentTerms = p.paymentTerms || '';
          const deliveryDate = p.deliveryDate || '';
          const timelineJson = JSON.stringify(mergeLog(cc ? parseJsonSafe(cc.timelineJson, []) : [], p.timeline || [], actorOf(authUser)));
          const evidenceJson = guard.evidenceJson;
          // fields without a column -> extraJson (see PO_EXTRA_RESERVED). Ownership of a NEW PO is copied from the PR row on the server
          // (requesterId + the PR's creator) ; a later save never rewrites it.
          // procurementType / channel decide who may close a claim (isSelfBuyPo) : set when the PO is made, an admin only afterwards
          const poExtra = pickExtra(p, PO_EXTRA_RESERVED, cc ? (normalizeUser(authUser).isAdmin ? PO_IDENTITY_KEYS : [...PO_IDENTITY_KEYS, ...PO_CHANNEL_KEYS]) : []);
          if (cc && isFinalStatus(cc.status) && guard.storedExtra.attachments !== undefined && poExtra.attachments !== undefined) {
            poExtra.attachments = additiveMerge(guard.storedExtra.attachments, poExtra.attachments);
          }
          if (!cc && newPr) {
            const prx = parseExtra(newPr.extraJson);
            poExtra.requesterId = newPr.requesterId || null;
            poExtra.requestedBy = prx.requestedBy || newPr.requesterName || '';
            for (const k of ['applicantName1', 'createdBy']) if (prx[k] !== undefined && prx[k] !== null) poExtra[k] = prx[k];
            poExtra.refPrNo = newPr.prNumber; // copied from the PR, never from the body
            // reviewer details are forwarded from the PR (workflowEngine.createPOFromPR) ; the approver is the user who issues the PO, composed like the client did
            for (const k of ['reviewedBy', 'reviewerName', 'reviewerSignature', 'reviewedAt']) if (prx[k] !== undefined && prx[k] !== null) poExtra[k] = prx[k];
          }
          if (!cc) {
            // the approver is the user who issues the PO, composed like createPOFromPR did (also for an admin-seeded PO without a PR ; no reviewer then)
            const s = await signerOf(db, authUser, 'คุณประเสริฐ ยิ่งยง');
            poExtra.approvedBy = s.name;
            poExtra.approverName = s.name;
            poExtra.approverSignature = s.signature;
            poExtra.approvedAt = thaiStamp(new Date());
          }
          Object.assign(poExtra, await docServerPatch(db, authUser, 'PO', { stored: cc ? parseExtra(cc.extraJson) : {}, body: p, next: status, isExisting: Boolean(cc), prevStatus: cc ? cc.status : null, channel: cc ? (cc.purchaseChannel || guard.storedExtra.purchaseChannel) : null, department: cc ? cc.department : null, grandTotal: cc ? cc.grandTotal : 0, totalAmount: cc ? cc.totalAmount : 0 }));
          const poExtraJson = extraPatchJson(poExtra, cc ? guard.storedExtra : undefined);
          if (poExtraJson === null) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
          // the channel is set when the PO is made (createPOFromPR) ; on an existing PO only an admin can change it (it decides who may close a claim)
          const poChannel = typeof p.purchaseChannel === 'string' && p.purchaseChannel.trim() && (!cc || normalizeUser(authUser).isAdmin) ? p.purchaseChannel.trim().slice(0, 32) : null;

          // approvedTotal is computed by the SERVER from the PR (never from the body): the PO value, but at most what is left of the PR total
          // after the other POs of the same PR (a PO may legitimately exceed the PR a little, e.g. online price variance). Written once, at creation.
          // (computed inside the INSERT … SELECT itself: PR total − what the other POs of the PR already took, in one statement)
          const insertPo = (no) => db.prepare(`
            INSERT INTO pos (id, poNumber, prId, prNumber, department, vendorId, vendorName, totalAmount, vatAmount, grandTotal, status, itemsJson, paymentTerms, deliveryDate, timelineJson, evidenceJson, extraJson, purchaseChannel, updatedAt)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              json_patch(json_object('approvedTotal', MAX(0, MIN(?,
                COALESCE((SELECT totalAmount FROM prs WHERE id = ?), 0)
                - COALESCE((SELECT SUM(COALESCE(json_extract(extraJson, '$.approvedTotal'), 0)) FROM pos WHERE prNumber = ? AND id != ?), 0)))), ?),
              ?,
              CURRENT_TIMESTAMP
            WHERE 1
            ON CONFLICT(id) DO UPDATE SET
              purchaseChannel = COALESCE(excluded.purchaseChannel, pos.purchaseChannel),
              extraJson = json_patch(COALESCE(NULLIF(pos.extraJson, ''), '{}'), json_remove(excluded.extraJson, '$.approvedTotal')),
              status = excluded.status,
              vendorId = COALESCE(NULLIF(excluded.vendorId, ''), pos.vendorId),
              vendorName = COALESCE(NULLIF(excluded.vendorName, ''), pos.vendorName),
              totalAmount = excluded.totalAmount,
              vatAmount = excluded.vatAmount,
              grandTotal = excluded.grandTotal,
              paymentTerms = COALESCE(NULLIF(excluded.paymentTerms, ''), pos.paymentTerms),
              deliveryDate = COALESCE(NULLIF(excluded.deliveryDate, ''), pos.deliveryDate),
              itemsJson = excluded.itemsJson,
              timelineJson = excluded.timelineJson,
              evidenceJson = excluded.evidenceJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(poId, no, prId, prNo, dept, vendorId, vendorName, total, vat, grand, status, itemsJson, paymentTerms, deliveryDate, timelineJson, evidenceJson,
            // snapshot inputs : the body value, the PR it references (server-resolved), the siblings ; existing rows are never re-snapshotted
            Number.isFinite(grand) ? grand : 0, newPr ? newPr.id : '', newPr ? newPr.prNumber : '', poId, poExtraJson, poChannel);
          // GAS apiCreatePO / apiSavePO audit : PO_CREATED for a new row, UPDATE_PO when the upsert overwrites a row ; same batch as the PO write, final PO number
          const savePo = (no) => runPoWithAudit(db, insertPo(no), poAuditStmt(db, authUser, {
            id: `AUD-${Date.now()}-${uid()}`, action: cc ? 'UPDATE_PO' : 'PO_CREATED', poId, poNo: no, status, statusFromPo: true,
            comment: cc ? poUpdateComment(p) : 'สร้างใบสั่งซื้อ (PO) เลขที่ ' + no
          }), [], cc ? poNotifyStmts(db, { poId, prev: { status: cc.status, extra: parseExtra(cc.extraJson) }, status, body: { orderStatus: p.orderStatus, claimResolution: poExtra.claimResolution }, dept: cc.department, poNo: no }) : []); // GAS apiSavePO notifications (apiCreatePO sends none)
          try {
            await savePo(poNo);
          } catch (e) {
            // lost a race for the same number: server-issued -> take the next one ; client-chosen -> 409 (see above, never renumber silently)
            if (cc || !/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
            if (!poIssued.has(p)) return errorResponse('เลขที่ PO ซ้ำกับเอกสารที่มีอยู่', 409);
            const issued = await issueDocNumber(db, { docType: 'PO', dept: normalizeDeptCode(dept) });
            poNo = issued.docNo;
            p.poNumber = issued.docNo;
            p.poNo = issued.docNo;
            await savePo(poNo);
          }
          markTouched('pos', poId);
          if (guard.itemNotes && guard.itemNotes.length) await audit('PO_ADMIN_ITEM_CHANGE', 'po', poId, { actorUserId: authUser.userId, changes: guard.itemNotes.slice(0, 30) });
        }
        return jsonResponse({
          success: true,
          count: poList.length,
          po: poList[0],
          id: poList[0]?.id,
          poNo: poList[0]?.poNumber || poList[0]?.poNo,
          ...(poIssued.size ? { issuedByServer: true, issued: poList.filter((x) => poIssued.has(x)).map((x) => ({ id: x.id, poNo: x.poNumber })) } : {})
        });
      }

      if (method === 'PUT' && subId) {
        const p = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(p); if (shape) return errorResponse(shape.message, shape.status); }
        { const bad = await sanitizeWriteBody(db, p, authUser, { docKey: subId }); if (bad) return errorResponse(bad.message, bad.status); }
        { const bad = checkPoStatus(p, authUser); if (bad) return errorResponse(bad.message, bad.status); }
        // resolve ONE row (exact id first, then poNumber) ; the UPDATE below targets that id only
        const curPo = await lookupStatus(db, 'SELECT id, poNumber, prId, prNumber, status, department, totalAmount, vatAmount, grandTotal, timelineJson, itemsJson, evidenceJson, purchaseChannel, extraJson FROM pos WHERE id = ? OR poNumber = ? ORDER BY (id = ?) DESC LIMIT 1', subId, subId, subId);
        if (curPo && !canAccessDepartment(authUser, curPo.department)) return errorResponse(FORBIDDEN_MSG, 403);
        if (curPo && poAmountsFrozenAndChanged(authUser, curPo, p)) return errorResponse(FORBIDDEN_MSG, 403);
        if (p.status && curPo && !canTransitionPO(authUser, curPo.status, p.status, await poOwnerCtx(db, authUser, curPo.id || subId))) return errorResponse(FORBIDDEN_MSG, 403);
        const targetPoRowId = curPo && curPo.id ? curPo.id : subId;
        const vendorId = p.vendorId || p.supplierId || null;
        const vendorName = p.vendorName || p.supplierName || null;
        const totalAmount = (p.totalAmount !== undefined && p.totalAmount !== null) ? Number(p.totalAmount) : (p.total !== undefined ? Number(p.total) : null);
        const vatAmount = (p.vatAmount !== undefined && p.vatAmount !== null) ? Number(p.vatAmount) : null;
        const grandTotal = (p.grandTotal !== undefined && p.grandTotal !== null) ? Number(p.grandTotal) : null;
        const paymentTerms = p.paymentTerms || null;
        const deliveryDate = p.deliveryDate || null;
        const putStoredExtra = curPo ? parseExtra(curPo.extraJson) : {};
        const putLockPrice = Boolean(curPo) && (putStoredExtra.settlementStatus === 'SETTLED' || String(curPo.status || '').trim().toUpperCase() === 'SETTLED');
        const putItemNotes = [];
        const itemsJson = Array.isArray(p.items)
          ? JSON.stringify(guardPoItems(curPo ? parseJsonSafe(curPo.itemsJson, []) : [], p.items, { admin: normalizeUser(authUser).isAdmin, lockPrice: putLockPrice, onlineish: resolvePermissions(authUser).onlineish, storedStatus: curPo ? curPo.status : '', notes: putItemNotes, grnStarted: hasGrn(putStoredExtra) }))
          : null;
        const timelineJson = Array.isArray(p.timeline) ? JSON.stringify(mergeLog(curPo ? parseJsonSafe(curPo.timelineJson, []) : [], p.timeline, actorOf(authUser))) : null;
        const evidenceJson = p.evidence ? JSON.stringify(guardedDocBlob(curPo ? parseJsonSafe(curPo.evidenceJson, {}) : undefined, p.evidence, Boolean(curPo), curPo && curPo.status, {})) : null;
        // fields without a column -> merged into extraJson ; ownership / server-owned values (approvedTotal, settlement*) are never taken from the body
        const putPoExtra = pickExtra(p, PO_EXTRA_RESERVED, curPo && !normalizeUser(authUser).isAdmin ? [...PO_IDENTITY_KEYS, ...PO_CHANNEL_KEYS] : PO_IDENTITY_KEYS);
        if (curPo && isFinalStatus(curPo.status) && putStoredExtra.attachments !== undefined && putPoExtra.attachments !== undefined) {
          putPoExtra.attachments = additiveMerge(putStoredExtra.attachments, putPoExtra.attachments);
        }
        Object.assign(putPoExtra, await docServerPatch(db, authUser, 'PO', { stored: curPo ? parseExtra(curPo.extraJson) : {}, body: p, next: p.status || (curPo ? curPo.status : null), isExisting: Boolean(curPo), prevStatus: curPo ? curPo.status : null, channel: curPo ? (curPo.purchaseChannel || putStoredExtra.purchaseChannel) : null, department: curPo ? curPo.department : null, grandTotal: curPo ? curPo.grandTotal : 0, totalAmount: curPo ? curPo.totalAmount : 0 }));
        const putPoExtraJson = extraPatchJson(putPoExtra, curPo ? putStoredExtra : undefined);
        if (putPoExtraJson === null) return errorResponse('ขนาดข้อมูลเกินกำหนด', 413);
        const putPoChannel = typeof p.purchaseChannel === 'string' && p.purchaseChannel.trim() && (!curPo || normalizeUser(authUser).isAdmin) ? p.purchaseChannel.trim().slice(0, 32) : null;

        const putPoStmt = db.prepare(`
          UPDATE pos SET
            status = COALESCE(?, status),
            vendorId = COALESCE(?, vendorId),
            vendorName = COALESCE(?, vendorName),
            totalAmount = COALESCE(?, totalAmount),
            vatAmount = COALESCE(?, vatAmount),
            grandTotal = COALESCE(?, grandTotal),
            paymentTerms = COALESCE(?, paymentTerms),
            deliveryDate = COALESCE(?, deliveryDate),
            itemsJson = COALESCE(?, itemsJson),
            timelineJson = COALESCE(?, timelineJson),
            evidenceJson = COALESCE(?, evidenceJson),
            purchaseChannel = COALESCE(?, purchaseChannel),
            extraJson = json_patch(COALESCE(NULLIF(extraJson, ''), '{}'), ?),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          p.status || null,
          vendorId,
          vendorName,
          totalAmount,
          vatAmount,
          grandTotal,
          paymentTerms,
          deliveryDate,
          itemsJson,
          timelineJson,
          evidenceJson,
          putPoChannel,
          putPoExtraJson,
          targetPoRowId
        );
        // PO saved as CLOSED / COMPLETED (ReceivingModal / claim close / short-close : the client saves the final status itself) while it was not yet -> the PR of that
        // PO is completed in the same batch (see prCascadeFor) ; a PO that was already closed never re-cascades
        const putClosesPo = Boolean(curPo) && PO_CLOSING_FOR_PR.has(String(p.status || '').trim().toUpperCase()) && !PO_CLOSING_FOR_PR.has(String(curPo.status || '').trim().toUpperCase());
        const putPrCascade = putClosesPo
          ? prCascadeStmt(db, authUser, { prRow: await prCascadeFor(db, { ...curPo, prId: curPo.prId || putPoExtra.prId || putStoredExtra.prId, prNumber: curPo.prNumber || putPoExtra.prNumber || putStoredExtra.prNumber }), poRow: curPo, poNo: curPo.poNumber || targetPoRowId, iso: new Date().toISOString() })
          : [];
        // GAS apiSavePO audit : UPDATE_PO, same batch as the write (only when the row exists)
        await runPoWithAudit(db, putPoStmt, poAuditStmt(db, authUser, {
          id: `AUD-${Date.now()}-${uid()}`, action: 'UPDATE_PO', poId: targetPoRowId, poNo: (curPo && curPo.poNumber) || targetPoRowId, status: (curPo && curPo.status) || null, statusFromPo: true,
          comment: poUpdateComment(p),
          whereSql: 'EXISTS (SELECT 1 FROM pos WHERE id = ?)', whereBinds: [targetPoRowId]
        }), putPrCascade, curPo ? poNotifyStmts(db, { poId: targetPoRowId, prev: { status: curPo.status, extra: putStoredExtra }, status: p.status || curPo.status, body: { orderStatus: p.orderStatus, claimResolution: putPoExtra.claimResolution }, dept: curPo.department, poNo: curPo.poNumber || targetPoRowId }) : []);
        markTouched('pos', targetPoRowId);
        if (putItemNotes.length) await audit('PO_ADMIN_ITEM_CHANGE', 'po', targetPoRowId, { actorUserId: authUser.userId, changes: putItemNotes.slice(0, 30) });

        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 5. Products Catalog Endpoints (/api/products) ──
    if (path === '/api/products' || path === '/api/products/batch' || path.startsWith('/api/products/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/products/') && path !== '/api/products/batch'
        ? decodeURIComponent(path.replace('/api/products/', ''))
        : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM products WHERE isDeleted = 0').all();
        return jsonResponse(await productViews(db, res.results || []));
      }

      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(body); if (shape) return errorResponse(shape.message, shape.status); }
        const gate = await gateProducts(db, authUser, path, productRows(body), null);
        if (gate.verdict) { const r = masterVerdictResponse(gate.verdict); return errorResponse(r.msg, r.status); }
        if (productRemarkTooLong(gate.items)) return errorResponse(`หมายเหตุสินค้ายาวเกิน ${PRODUCT_REMARK_MAX} ตัวอักษร`, 400);
        const prods = gate.items;
        const skipped = gate.skipped;
        const isBatch = path === '/api/products/batch';
        let written = 0;
        for (const p of prods) {
          const id = p.id || `PROD-${Date.now()}-${uid()}`;
          const code = p.code || p.itemCode || id;
          const name = p.name || p.itemName || '';
          const cat = p.category || p.department || 'PD';
          const purchaseUnit = p.purchaseUnit || p.unit || 'ชิ้น';
          const usageUnit = p.stockUnit || p.usageUnit || purchaseUnit; // UI name wins when both are sent (D-2)
          const convRate = Number(p.conversionRate || 1);
          const minStock = Number(p.reorderPoint ?? p.minStock ?? 0) || 0;
          // not sent -> null : an existing row keeps its stock / price (COALESCE below), a new row gets 0 (D-2)
          const opening = parseOpeningStock(p);
          const curStock = opening.value;
          const price = (p.price ?? p.standardPrice) != null && (p.price ?? p.standardPrice) !== '' ? Number(p.price ?? p.standardPrice) : null;
          const locId = ('locationId' in p ? p.locationId : p.defaultLocationId) || '';
          const dept = p.department || cat;

          // Check if product already exists by id OR code (case-insensitive)
          const existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) ORDER BY (id = ?) DESC, COALESCE(isDeleted,0) ASC, id LIMIT 1').bind(id, code, id).first();
          // bulk sync : a deleted product is never revived by a (stale) list ; a NEW row with a refused opening balance is rejected like a row the user may not touch
          if (isBatch && existing && Number(existing.isDeleted) === 1) continue;
          if (isBatch && !existing && opening.error) { skipped.push(p.id || p.code || p.itemCode || null); continue; }
          // single write : the opening balance only matters for a NEW row (an existing row ignores the body's stock) so only then is it validated
          if (!isBatch && !existing && opening.error) return errorResponse(opening.error, 400);
          written++;
          if (existing) {
            await db.prepare(`
              UPDATE products SET
                name = COALESCE(?, name),
                category = COALESCE(?, category),
                purchaseUnit = COALESCE(?, purchaseUnit),
                usageUnit = COALESCE(?, usageUnit),
                conversionRate = COALESCE(?, conversionRate),
                minStock = COALESCE(?, minStock),
                currentStock = COALESCE(?, currentStock),
                standardPrice = COALESCE(?, standardPrice),
                defaultLocationId = COALESCE(?, defaultLocationId),
                department = COALESCE(?, department),
                leadTimeDays = COALESCE(?, leadTimeDays),
                locationName = COALESCE(?, locationName),
                status = COALESCE(?, status),
                isActive = COALESCE(?, isActive),
                isDeleted = 0,
                updatedAt = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(name, cat, purchaseUnit, usageUnit, convRate, minStock, null, price, locId, dept, optNum(p.leadTimeDays), p.locationName ?? null, activeFields(p).status, activeFields(p).isActive, existing.id).run();
            // the server owns the stock of an existing row (changes only via /stock/issue, /adjust, /manual-in, GRN receive) : a stale client copy (also in the bulk /batch sync) never overwrites it. A NEW row takes the opening balance below.
          } else {
            const ins = db.prepare(`
              INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, department, isDeleted, updatedAt, leadTimeDays, locationName, status, isActive)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, 1))
            `).bind(id, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock ?? 0, price ?? 0, locId, dept, optNum(p.leadTimeDays), p.locationName ?? null, activeFields(p).status, activeFields(p).isActive);
            await insertProductWithAudit(db, authUser, ins, id, code, curStock ?? 0);
          }
          await applyProductRemark(db, authUser, path, p, existing ? existing.id : id);
        }
        return jsonResponse(Array.isArray(body) || body.products ? { success: true, count: written, ...(skipped.length ? { skipped } : {}) } : (prods[0] ? await savedProductView(db, prods[0], subId) : { success: true, count: 0, skipped }));
      }

      if (method === 'PUT') {
        const body = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(body); if (shape) return errorResponse(shape.message, shape.status); }
        const gate = await gateProducts(db, authUser, path, productRows(body), subId);
        if (gate.verdict) { const r = masterVerdictResponse(gate.verdict); return errorResponse(r.msg, r.status); }
        if (productRemarkTooLong(gate.items)) return errorResponse(`หมายเหตุสินค้ายาวเกิน ${PRODUCT_REMARK_MAX} ตัวอักษร`, 400);
        const prods = gate.items;
        const skipped = gate.skipped;
        const isBatch = path === '/api/products/batch';
        let written = 0;
        for (const p of prods) {
          const id = p.id || subId;
          const code = p.code || p.itemCode || id;
          const name = p.name || p.itemName || '';
          const cat = p.category || p.department || 'PD';
          const purchaseUnit = p.purchaseUnit || p.unit || 'ชิ้น';
          const usageUnit = p.stockUnit || p.usageUnit || purchaseUnit; // UI name wins when both are sent (D-2)
          const convRate = Number(p.conversionRate || 1);
          const minStock = Number(p.reorderPoint ?? p.minStock ?? 0) || 0;
          const opening = parseOpeningStock(p);
          const curStock = opening.value;
          const price = p.price !== undefined ? Number(p.price) : (p.standardPrice !== undefined ? Number(p.standardPrice) : null);
          const locId = ('locationId' in p) ? (p.locationId || '') : (p.defaultLocationId || null); // key sent as null / '' clears the location, key absent keeps it (D-2)
          const dept = p.department || cat;

          // Find existing product by subId, id, or code
          let existing = null;
          let insertedId = null;
          if (subId) {
            existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) ORDER BY (id = ?) DESC, COALESCE(isDeleted,0) ASC, id LIMIT 1').bind(subId, subId, subId).first();
          }
          if (!existing && (id || code)) {
            existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) ORDER BY (id = ?) DESC, COALESCE(isDeleted,0) ASC, id LIMIT 1').bind(id || '', code || '', id || '').first();
          }

          if (isBatch && existing && Number(existing.isDeleted) === 1) continue; // bulk sync never revives a deleted product
          if (isBatch && !existing && opening.error) { skipped.push(p.id || p.code || p.itemCode || null); continue; }
          // single write : the opening balance only matters for a NEW row (an existing row ignores the body's stock)
          if (!isBatch && !existing && opening.error) return errorResponse(opening.error, 400);
          written++;
          if (existing) {
            await db.prepare(`
              UPDATE products SET
                name = COALESCE(?, name),
                category = COALESCE(?, category),
                purchaseUnit = COALESCE(?, purchaseUnit),
                usageUnit = COALESCE(?, usageUnit),
                conversionRate = COALESCE(?, conversionRate),
                minStock = COALESCE(?, minStock),
                currentStock = COALESCE(?, currentStock),
                standardPrice = COALESCE(?, standardPrice),
                defaultLocationId = COALESCE(?, defaultLocationId),
                department = COALESCE(?, department),
                leadTimeDays = COALESCE(?, leadTimeDays),
                locationName = COALESCE(?, locationName),
                status = COALESCE(?, status),
                isActive = COALESCE(?, isActive),
                isDeleted = 0,
                updatedAt = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(name, cat, purchaseUnit, usageUnit, convRate, minStock, null, price, locId, dept, optNum(p.leadTimeDays), p.locationName ?? null, activeFields(p).status, activeFields(p).isActive, existing.id).run();
            // the server owns the stock balance of an existing row (changes only via /stock/issue, /adjust, /manual-in, GRN receive) : a stale copy in the body (single PUT or bulk /batch) never overwrites it. A NEW row takes the opening balance below.
          } else {
            insertedId = id || `PROD-${Date.now()}-${uid()}`;
            const ins = db.prepare(`
              INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, department, isDeleted, updatedAt, leadTimeDays, locationName, status, isActive)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, 1))
            `).bind(insertedId, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock || 0, price || 0, locId, dept, optNum(p.leadTimeDays), p.locationName ?? null, activeFields(p).status, activeFields(p).isActive);
            await insertProductWithAudit(db, authUser, ins, insertedId, code, curStock || 0);
          }
          await applyProductRemark(db, authUser, path, p, existing ? existing.id : insertedId);
        }

        return jsonResponse(Array.isArray(body) || body.products ? { success: true, count: written, ...(skipped.length ? { skipped } : {}) } : (prods[0] ? await savedProductView(db, prods[0], subId) : { success: true, count: 0, skipped }));
      }

      if (method === 'DELETE' && subId) {
        // the department of the row is checked before it is removed (as usage-units does) ; only that one row is changed
        const pRow = await resolveMasterRow(db, 'products', { subId });
        if (pRow && pRow.department && !canAccessDepartment(authUser, normalizeDeptCode(pRow.department))) return errorResponse(FORBIDDEN_MSG, 403);
        if (pRow) await db.prepare('UPDATE products SET isDeleted = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').bind(pRow.id).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 6. Vendors Endpoints (/api/vendors) ──
    if (path === '/api/vendors' || path.startsWith('/api/vendors/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/vendors/') ? decodeURIComponent(path.replace('/api/vendors/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM vendors WHERE isDeleted = 0').all();
        return jsonResponse(utcIsoRows(res.results || []));
      }

      if (method === 'POST') {
        const v = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(v); if (shape) return errorResponse(shape.message, shape.status); }
        const vList = Array.isArray(v) ? v : [v];
        { const v = await masterWriteVerdict(db, authUser, 'vendors', vList, null, { upsertById: true }); if (v) { const r = masterVerdictResponse(v); return errorResponse(r.msg, r.status); } }
        for (const item of vList) {
          const id = item.id || `VEN-${Date.now()}-${uid()}`;
          const code = item.code || item.vendorCode || id;
          const name = item.name || '';
          const contact = item.contactPerson || '';
          const phone = item.phone || '';
          const email = item.email || '';
          const address = item.address || '';
          const taxId = item.taxId || '';
          const term = item.paymentTerm || '';
          const dept = item.department || 'ALL';

          await db.prepare(`
            INSERT INTO vendors (id, code, name, contactPerson, phone, email, address, taxId, paymentTerm, department, isDeleted, status, isActive)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, COALESCE(?, 'ACTIVE'), COALESCE(?, 1))
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              contactPerson = excluded.contactPerson,
              phone = excluded.phone,
              email = excluded.email,
              address = excluded.address,
              taxId = excluded.taxId,
              paymentTerm = excluded.paymentTerm,
              department = excluded.department,
              status = COALESCE(?, vendors.status),
              isActive = COALESCE(?, vendors.isActive),
              isDeleted = 0
          `).bind(id, code, name, contact, phone, email, address, taxId, term, dept, activeFields(item).status, activeFields(item).isActive, activeFields(item).status, activeFields(item).isActive).run();
        }
        return jsonResponse(Array.isArray(v) ? { success: true, count: vList.length } : vList[0]);
      }

      if (method === 'PUT') {
        const item = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(item); if (shape) return errorResponse(shape.message, shape.status); }
        { const v = await masterWriteVerdict(db, authUser, 'vendors', [item], subId); if (v) { const r = masterVerdictResponse(v); return errorResponse(r.msg, r.status); } }
        const id = item.id || subId;
        const code = item.code || item.vendorCode || id;
        const name = item.name || '';
        const contact = item.contactPerson || '';
        const phone = item.phone || '';
        const email = item.email || '';
        const address = item.address || '';
        const taxId = item.taxId || '';
        const term = item.paymentTerm || '';
        const dept = item.department || 'ALL';

        // change ONLY the row that was checked above (path id/code first, then the body's) - never "check one row, update every row that matches id OR code"
        const vRow = await resolveMasterRow(db, 'vendors', { subId, id, code });
        if (vRow) await db.prepare(`
          UPDATE vendors SET
            name = COALESCE(?, name),
            contactPerson = COALESCE(?, contactPerson),
            phone = COALESCE(?, phone),
            email = COALESCE(?, email),
            address = COALESCE(?, address),
            taxId = COALESCE(?, taxId),
            paymentTerm = COALESCE(?, paymentTerm),
            department = COALESCE(?, department),
            status = COALESCE(?, status),
            isActive = COALESCE(?, isActive),
            isDeleted = 0
          WHERE id = ?
        `).bind(name, contact, phone, email, address, taxId, term, dept, activeFields(item).status, activeFields(item).isActive, vRow.id).run();

        return jsonResponse({ ...item, id, code, name });
      }

      if (method === 'DELETE' && subId) {
        const vDelRow = await resolveMasterRow(db, 'vendors', { subId });
        if (vDelRow && vDelRow.department && !canAccessDepartment(authUser, normalizeDeptCode(vDelRow.department))) return errorResponse(FORBIDDEN_MSG, 403);
        if (vDelRow) await db.prepare('UPDATE vendors SET isDeleted = 1 WHERE id = ?').bind(vDelRow.id).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 7. Storage Locations (/api/storage-locations) ──
    if (path === '/api/storage-locations' || path.startsWith('/api/storage-locations/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/storage-locations/') ? decodeURIComponent(path.replace('/api/storage-locations/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM storage_locations').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const loc = await request.json().catch(() => ({}));
        { const shape = checkBodyShape(loc); if (shape) return errorResponse(shape.message, shape.status); }
        { const v = await masterWriteVerdict(db, authUser, 'storage_locations', [loc], null); if (v) { const r = masterVerdictResponse(v); return errorResponse(r.msg, r.status); } }
        const id = loc.id || `LOC-${Date.now()}-${uid()}`;
        await db.prepare(`
          INSERT INTO storage_locations (id, name, department, isActive) VALUES (?, ?, ?, COALESCE(?, 1))
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, department = excluded.department,
            isActive = COALESCE(?, storage_locations.isActive)
        `).bind(id, loc.name || '', loc.department || 'PD', activeFields(loc).isActive, activeFields(loc).isActive).run();
        return jsonResponse({ success: true, id });
      }

      if (method === 'DELETE' && subId) {
        const lRow = await resolveMasterRow(db, 'storage_locations', { subId });
        if (lRow && lRow.department && !canAccessDepartment(authUser, normalizeDeptCode(lRow.department))) return errorResponse(FORBIDDEN_MSG, 403);
        if (lRow) await db.prepare('DELETE FROM storage_locations WHERE id = ?').bind(lRow.id).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 8. Departments (/api/departments) ──
    if (path === '/api/departments' || path.startsWith('/api/departments/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/departments/') ? decodeURIComponent(path.replace('/api/departments/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM departments WHERE isActive = 1').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const d = await request.json().catch(() => ({}));
        const id = d.id || `DEPT-${d.code || Date.now()}`;
        const code = d.code || id;
        const name = d.name || '';
        const nameEn = d.nameEn || '';
        const prefix = d.prefix || code;
        const desc = d.description || '';
        const budget = Number(d.monthlyBudget || 0);
        const isActive = d.isActive === false || d.isActive === 0 ? 0 : 1;
        const color = d.color || 'blue';
        const mgr = d.managerName || '';

        await db.prepare(`
          INSERT INTO departments (id, code, name, nameEn, prefix, description, monthlyBudget, isActive, color, managerName, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            nameEn = excluded.nameEn,
            prefix = excluded.prefix,
            description = excluded.description,
            monthlyBudget = excluded.monthlyBudget,
            isActive = excluded.isActive,
            color = excluded.color,
            managerName = excluded.managerName,
            updatedAt = CURRENT_TIMESTAMP
        `).bind(id, code, name, nameEn, prefix, desc, budget, isActive, color, mgr).run();

        return jsonResponse({ ...d, id, code, name });
      }

      if (method === 'PUT') {
        const d = await request.json().catch(() => ({}));
        const id = d.id || subId;
        const code = d.code || id;
        const name = d.name || '';
        const nameEn = d.nameEn || '';
        const prefix = d.prefix || code;
        const desc = d.description || '';
        const budget = Number(d.monthlyBudget || 0);
        const isActive = d.isActive === false || d.isActive === 0 ? 0 : 1;
        const color = d.color || 'blue';
        const mgr = d.managerName || '';

        // the row is located by id (the client keeps the original id when the code is edited) ; `code` is updated too,
        // so renaming a department's short code sticks (documents / users keep the code they were created with)
        const newCode = d.code ? String(d.code).trim().toUpperCase() : null;
        await db.prepare(`
          UPDATE departments SET
            code = COALESCE(?, code),
            name = COALESCE(?, name),
            nameEn = COALESCE(?, nameEn),
            prefix = COALESCE(?, prefix),
            description = COALESCE(?, description),
            monthlyBudget = COALESCE(?, monthlyBudget),
            isActive = COALESCE(?, isActive),
            color = COALESCE(?, color),
            managerName = COALESCE(?, managerName),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = (SELECT id FROM departments WHERE id = ? OR code = ? ORDER BY (id = ?) DESC LIMIT 1)
        `).bind(newCode, name, nameEn, prefix, desc, budget, isActive, color, mgr, id, code, id).run(); // admin only ; one row

        return jsonResponse({ ...d, id, code, name });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE departments SET isActive = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM departments WHERE id = ? OR code = ? ORDER BY (id = ?) DESC LIMIT 1)').bind(subId, subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 9. Users Management Endpoints (/api/users or /api/user) ──
    if (path === '/api/users' || path === '/api/user' || path.startsWith('/api/users/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/users/') ? decodeURIComponent(path.replace('/api/users/', '')) : null;

      // Schema comes from migrations/0001 + 0003 (no runtime CREATE/ALTER).

      // Dev-only seed: requires ALLOW_DEV_SEED='true' AND DEV_SEED_PASSWORD (never in production). Password is hashed before storing.
      const userCountRes = env.ALLOW_DEV_SEED === 'true'
        ? await db.prepare('SELECT COUNT(*) as count FROM users').first().catch(() => null)
        : null;
      if (userCountRes && Number(userCountRes.count) === 0 && typeof env.DEV_SEED_PASSWORD === 'string' && env.DEV_SEED_PASSWORD.length >= 8) {
        const seedUsers = [
          { id: 'USR-0001', employeeId: 'EMP-PD-001', username: 'wichai.pd', email: 'wichai@company.com', name: 'คุณวิชัย (PD)', employeeName: 'คุณวิชัย สุขใจ', displayName: 'Wichai (PD)', position: 'เจ้าหน้าที่ฝ่ายผลิต', department: 'PD', primaryDepartment: 'PD', allowedDepartments: '["PD"]', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', positionKey: 'REQUESTER_PD', title: 'Requester (PD)', level: 1, status: 'ACTIVE' },
          { id: 'USR-0002', employeeId: 'EMP-QC-001', username: 'somying.qc', email: 'somying@company.com', name: 'คุณสมหญิง (QC)', employeeName: 'คุณสมหญิง รักดี', displayName: 'Somying (QC)', position: 'เจ้าหน้าที่ฝ่ายควบคุมคุณภาพ (QC)', department: 'QC', primaryDepartment: 'QC', allowedDepartments: '["QC"]', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', positionKey: 'REQUESTER_QC', title: 'Requester (QC)', level: 1, status: 'ACTIVE' },
          { id: 'USR-0003', employeeId: 'EMP-MGR-001', username: 'somchai.am', email: 'somchai.am@company.com', name: 'คุณสมชาย (Asst. Mgr)', employeeName: 'คุณสมชาย มุ่งมั่น', displayName: 'Somchai (Asst Mgr)', position: 'ผู้ช่วยผู้จัดการฝ่ายผลิต (Asst. Manager)', department: 'PD', primaryDepartment: 'PD', allowedDepartments: '["PD","QC"]', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', positionKey: 'REVIEWER', title: 'Assistant Manager', level: 2, status: 'ACTIVE' },
          { id: 'USR-0004', employeeId: 'EMP-PUR-001', username: 'nat.on', email: 'nat.on@company.com', name: 'คุณนัท (Online Purchaser)', employeeName: 'คุณนัท จัดซื้อ', displayName: 'Nat (Online)', position: 'เจ้าหน้าที่จัดซื้อออนไลน์', department: 'PUR', primaryDepartment: 'PUR', allowedDepartments: '["*"]', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', positionKey: 'ONLINE_PURCHASER', title: 'Online Purchaser', level: 2, status: 'ACTIVE' },
          { id: 'USR-0005', employeeId: 'EMP-MGR-002', username: 'prasert.pm', email: 'prasert.pm@company.com', name: 'คุณประเสริฐ (Plant Mgr)', employeeName: 'คุณประเสริฐ ยิ่งยง', displayName: 'Prasert (Plant Mgr)', position: 'ผู้จัดการโรงงาน (Plant Manager)', department: 'MGT', primaryDepartment: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', positionKey: 'APPROVER', title: 'Plant Manager', level: 3, status: 'ACTIVE' },
          { id: 'USR-0006', employeeId: 'EMP-WH-001', username: 'somkid.wh', email: 'somkid.wh@company.com', name: 'คุณสมคิด (Warehouse)', employeeName: 'คุณสมคิด คลังทอง', displayName: 'Somkid (WH)', position: 'หัวหน้าแผนกคลังสินค้า', department: 'WH', primaryDepartment: 'WH', allowedDepartments: '["WH","PD","QC"]', roleId: 'WAREHOUSE', canonicalRole: 'WAREHOUSE', positionKey: 'WAREHOUSE', title: 'Warehouse Supervisor', level: 2, status: 'ACTIVE' },
          { id: 'USR-0007', employeeId: 'EMP-ADM-001', username: 'admin', email: 'admin@company.com', name: 'ผู้ดูแลระบบ (Admin)', employeeName: 'นายแอดมิน สูงสุด', displayName: 'Admin System', position: 'ผู้ดูแลระบบส่วนกลาง', department: 'ALL', primaryDepartment: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', positionKey: 'ADMIN', title: 'System Administrator', level: 99, status: 'ACTIVE' }
        ];
        for (const su of seedUsers) {
          const seedRec = await hashPassword(env.DEV_SEED_PASSWORD);
          await db.prepare(`
            INSERT INTO users (id, employeeId, username, email, password, pin, passwordHash, passwordSalt, passwordAlgo, passwordIterations, passwordUpdatedAt, name, employeeName, displayName, position, department, primaryDepartment, allowedDepartments, roleId, canonicalRole, positionKey, title, level, status, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).bind(su.id, su.employeeId, su.username, su.email, seedRec.hash, seedRec.salt, seedRec.algo, seedRec.iterations, su.name, su.employeeName, su.displayName, su.position, su.department, su.primaryDepartment, su.allowedDepartments, su.roleId, su.canonicalRole, su.positionKey, su.title, su.level, su.status).run().catch(() => {});
        }
      }

      if (method === 'GET') {
        if (subId) {
          const user = await db.prepare('SELECT * FROM users WHERE id = ? OR username = ? OR LOWER(username) = LOWER(?) LIMIT 1').bind(subId, subId, subId).first();
          if (!user) return errorResponse('User not found', 404);
          return jsonResponse(stripOtherEmails(scopeViewer, [formatSafeUser(user)])[0]);
        }

        const res = await db.prepare('SELECT * FROM users ORDER BY name ASC').all();
        const users = stripOtherEmails(scopeViewer, (res.results || []).map(u => formatSafeUser(u)));
        return jsonResponse(users);
      }

      // The admin creates the account / resets the password : the user must choose their own at the next login (mustChangePassword = 1) and every
      // older token dies (tokenVersion + 1). When the admin sets their OWN password it is a self change : no forced change, tokens still die.
      const buildPasswordStmt = async (userId, plain) => {
        const rec = await hashPassword(plain);
        const forceChange = userId !== authUser.userId ? 1 : 0;
        return {
          forceChange,
          stmt: db.prepare(`
            UPDATE users SET passwordHash = ?, passwordSalt = ?, passwordAlgo = ?, passwordIterations = ?,
              passwordUpdatedAt = ?, password = '', pin = '', mustChangePassword = ?, tokenVersion = COALESCE(tokenVersion, 0) + 1
            WHERE id = ?
          `).bind(rec.hash, rec.salt, rec.algo, rec.iterations, new Date().toISOString(), forceChange, userId)
        };
      };
      const storeUserPassword = async (userId, plain) => {
        const { stmt, forceChange } = await buildPasswordStmt(userId, plain);
        await stmt.run();
        await audit('PASSWORD_SET_BY_ADMIN', 'user', userId, { forceChange: forceChange === 1 });
      };
      // a closed account (INACTIVE) must not come back to life with its old tokens when it is re-activated later : closing bumps tokenVersion
      const revokeTokens = (userId) => db.prepare('UPDATE users SET tokenVersion = COALESCE(tokenVersion, 0) + 1 WHERE id = ?').bind(userId).run();

      if (method === 'POST' || method === 'PUT') {
        const u = await request.json().catch(() => ({}));
        // profile picture : Drive URL / small raster data URL only (anything else is stored empty ; dangerous schemes are refused)
        if (u && typeof u.pictureUrl === 'string' && u.pictureUrl) {
          const picCheck = sanitizeUrlField(u.pictureUrl);
          if (picCheck.message) return errorResponse(picCheck.message, picCheck.status);
          u.pictureUrl = picCheck.value;
        }
        const rawId = (u.id || subId || '').trim();
        const empId = (u.employeeId || '').trim();
        const username = (u.username || '').trim();
        const email = (u.email || (username ? `${username.toLowerCase()}@company.com` : '')).trim();
        // an UPDATE only changes the e-mail when the client really sent one (the derived default is for new accounts only : it must not overwrite a stored address)
        const emailGiven = (typeof u.email === 'string' ? u.email : '').trim();
        // Plaintext password is never stored: hashed in a separate UPDATE below. Columns `password` stay ''.
        const plainPass = (typeof u.password === 'string' ? u.password : '').trim();
        if (plainPass.length > MAX_PASSWORD_LENGTH) {
          return errorResponse(`รหัสผ่านต้องไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`, 400);
        }
        // A password that is being set must not be a known default or a trivially short one : the admin chooses a real password for the user
        // (no minimum exists in the old system / UI, so 6 is the floor). Case-insensitive : "Password123" is the same default.
        if (plainPass && (REJECTED_LEGACY_PASSWORDS.has(plainPass.toLowerCase()) || plainPass.length < MIN_NEW_PASSWORD_LENGTH)) {
          return errorResponse('กรุณาตั้งรหัสผ่านใหม่ ห้ามใช้รหัสเริ่มต้น', 400);
        }
        const rawPass = '';
        const pin = '';
        const name = (u.name || u.employeeName || '').trim();
        const empName = u.employeeName || name;
        const dispName = u.displayName || name;
        const position = u.position || '';
        const dept = u.department || u.primaryDepartment || 'PD';
        const primaryDept = u.primaryDepartment || dept;
        const allowedDepts = JSON.stringify(Array.isArray(u.allowedDepartments) && u.allowedDepartments.length > 0
          ? u.allowedDepartments
          : (Array.isArray(u.assignedDepartments) ? u.assignedDepartments : [primaryDept]));
        // 1. Flexible lookup for existing record
        let existingUser = null;
        if (subId) {
          existingUser = await db.prepare(
            'SELECT * FROM users WHERE id = ? OR username = ? OR LOWER(username) = LOWER(?) OR (employeeId IS NOT NULL AND employeeId != \'\' AND employeeId = ?) LIMIT 1'
          ).bind(subId, subId, subId, subId).first().catch(() => null);
        }
        if (!existingUser && rawId) {
          existingUser = await db.prepare(
            'SELECT * FROM users WHERE id = ? OR username = ? OR LOWER(username) = LOWER(?) LIMIT 1'
          ).bind(rawId, rawId, rawId).first().catch(() => null);
        }
        if (!existingUser && empId) {
          existingUser = await db.prepare(
            'SELECT * FROM users WHERE employeeId = ? LIMIT 1'
          ).bind(empId).first().catch(() => null);
        }
        if (!existingUser && username) {
          existingUser = await db.prepare(
            'SELECT * FROM users WHERE username = ? OR LOWER(username) = LOWER(?) LIMIT 1'
          ).bind(username, username).first().catch(() => null);
        }

        // No default role any more : a NEW user must come with a roleId (400 otherwise) ; an existing user keeps the stored role when none is sent
        const roleId = (typeof u.roleId === 'string' ? u.roleId.trim() : '') || (existingUser && existingUser.roleId) || '';
        if (!roleId) return errorResponse('กรุณาระบุบทบาท (roleId) ของผู้ใช้งาน', 400);
        const roleUpper = String(roleId).toUpperCase();
        const canonicalRole = u.canonicalRole || (
          roleUpper === 'ADMIN' ? 'ADMIN' :
          (roleUpper.includes('ASST') || roleUpper.includes('REVIEW')) ? 'REVIEWER' :
          (roleUpper.includes('APPROV') || roleUpper.includes('MANAGER') || roleUpper.includes('PLANT')) ? 'APPROVER' :
          (roleUpper.includes('PURCHAS') || roleUpper.includes('BUYER')) ? 'PURCHASER' : 'REQUESTER'
        );
        const posKey = u.positionKey || roleId;
        const title = u.title || position || 'Officer';
        const defaultLevel = canonicalRole === 'ADMIN' ? 99 : (canonicalRole === 'APPROVER' ? 3 : (canonicalRole === 'REVIEWER' || canonicalRole === 'PURCHASER' ? 2 : 1));
        const level = Number(u.level || defaultLevel);
        const status = u.status || 'ACTIVE';
        const pic = u.pictureUrl || '';
        const desc = u.description || '';
        const sig = u.signature || null;
        // signature on UPDATE : field not sent (undefined) = keep the stored one ; sent as null / '' = clear it (GAS apiUpsertUser overwrites the row) ; a value = replace
        const sigSent = u.signature !== undefined ? 1 : 0;
        const sigValue = u.signature ? u.signature : '';

        const isOnline = !((level >= 99) || canonicalRole === 'ADMIN') && (roleUpper.includes('ONLINE_PURCHASER') || canonicalRole === 'PURCHASER');
        const canCreatePR = u.canCreatePR !== undefined ? (u.canCreatePR ? 1 : 0) : (level >= 1 && !isOnline ? 1 : 0);
        const canSubmitPR = u.canSubmitPR !== undefined ? (u.canSubmitPR ? 1 : 0) : canCreatePR;
        const canDeleteOwnDraft = u.canDeleteOwnDraft !== undefined ? (u.canDeleteOwnDraft ? 1 : 0) : (level >= 1 && !isOnline ? 1 : 0);
        const canReview = u.canReview !== undefined ? (u.canReview ? 1 : 0) : (level >= 2 && !isOnline ? 1 : 0);
        const canFinalApprove = u.canFinalApprove !== undefined ? (u.canFinalApprove ? 1 : 0) : (level >= 3 ? 1 : 0);
        const canOnlinePurchase = u.canOnlinePurchase !== undefined ? (u.canOnlinePurchase ? 1 : 0) : (isOnline || level >= 99 ? 1 : 0);
        const canReceiveGoods = u.canReceiveGoods !== undefined ? (u.canReceiveGoods ? 1 : 0) : (!isOnline && (level === 1 || level >= 99 || roleUpper.includes('WH')) ? 1 : 0);
        const canCloseOwnPO = u.canCloseOwnPO !== undefined ? (u.canCloseOwnPO ? 1 : 0) : (level === 1 || isOnline || level >= 99 ? 1 : 0);
        const canManageMaster = u.canManageMaster !== undefined ? (u.canManageMaster ? 1 : 0) : (!isOnline && level >= 1 ? 1 : 0);
        const canDeleteMaster = u.canDeleteMaster !== undefined ? (u.canDeleteMaster ? 1 : 0) : (level >= 99 ? 1 : 0);
        const canViewBudget = u.canViewBudget !== undefined ? (u.canViewBudget ? 1 : 0) : (!isOnline && level >= 2 ? 1 : 0);
        const canViewBudgetMenu = u.canViewBudgetMenu !== undefined ? (u.canViewBudgetMenu ? 1 : 0) : (!isOnline && level >= 2 ? 1 : 0);
        const canSetBudget = u.canSetBudget !== undefined ? (u.canSetBudget ? 1 : 0) : (level >= 3 ? 1 : 0);
        const canViewAllDepts = u.canViewAllDepts !== undefined ? (u.canViewAllDepts ? 1 : 0) : (isOnline || level >= 2 || dept === 'ALL' ? 1 : 0);
        const now = new Date().toISOString();

        // E-signature : PNG / JPEG / WebP data URL (<= 400k chars) or a Drive URL. An unchanged stored value is not re-checked (old users keep working).
        if (u.signature !== undefined && u.signature !== null && u.signature !== '' && !(existingUser && existingUser.signature === u.signature)) {
          const sigErr = checkUserSignature(u.signature);
          if (sigErr) return errorResponse(sigErr, 400);
        }

        // 2. Validate duplicate username against OTHER users
        if (username) {
          const excludeId = existingUser ? existingUser.id : (rawId || '___NONE___');
          const dupUser = await db.prepare(
            'SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) AND id != ? LIMIT 1'
          ).bind(username, excludeId).first().catch(() => null);
          if (dupUser) {
            return errorResponse(`Username "${username}" มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น`, 400);
          }
        }

        if (existingUser) {
          // UPDATE
          // The admin setting his OWN password : profile + password change in ONE batch (a partial save would leave the old password with a new profile or
          // the reverse). Passwords of other users are a separate statement as before (they are not part of the profile save).
          const selfPw = plainPass && existingUser.id === authUser.userId ? await buildPasswordStmt(existingUser.id, plainPass) : null;
          const runProfile = async (stmt) => (selfPw ? db.batch([stmt, selfPw.stmt]) : stmt.run());
          try {
            await runProfile(db.prepare(`
              UPDATE users SET
                employeeId = CASE WHEN ? != '' THEN ? ELSE employeeId END,
                username = CASE WHEN ? != '' THEN ? ELSE username END,
                email = CASE WHEN ? != '' THEN ? ELSE email END,
                password = CASE WHEN ? != '' THEN ? ELSE password END,
                pin = CASE WHEN ? != '' THEN ? ELSE pin END,
                name = ?,
                employeeName = ?,
                displayName = ?,
                position = ?,
                department = ?,
                primaryDepartment = ?,
                allowedDepartments = ?,
                roleId = ?,
                canonicalRole = ?,
                positionKey = ?,
                title = ?,
                level = ?,
                status = ?,
                pictureUrl = ?,
                description = ?,
                signature = CASE WHEN ? = 1 THEN ? ELSE signature END,
                canCreatePR = ?,
                canSubmitPR = ?,
                canDeleteOwnDraft = ?,
                canReview = ?,
                canFinalApprove = ?,
                canOnlinePurchase = ?,
                canReceiveGoods = ?,
                canCloseOwnPO = ?,
                canManageMaster = ?,
                canDeleteMaster = ?,
                canViewBudget = ?,
                canViewBudgetMenu = ?,
                canSetBudget = ?,
                canViewAllDepts = ?,
                updatedAt = ?
              WHERE id = ?
            `).bind(
              empId, empId,
              username, username,
              emailGiven, emailGiven,
              rawPass, rawPass,
              pin, pin,
              name, empName, dispName,
              position, dept, primaryDept, allowedDepts,
              roleId, canonicalRole, posKey, title,
              level, status, pic, desc,
              sigSent, sigValue,
              canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
              canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
              canSetBudget, canViewAllDepts, now,
              existingUser.id
            ));
          } catch (fullUpdateErr) {
            console.error('[users API] Full update failed, attempting core column fallback:', fullUpdateErr && fullUpdateErr.message);
            await runProfile(db.prepare(`
              UPDATE users SET
                username = CASE WHEN ? != '' THEN ? ELSE username END,
                password = CASE WHEN ? != '' THEN ? ELSE password END,
                pin = CASE WHEN ? != '' THEN ? ELSE pin END,
                name = ?,
                employeeName = ?,
                position = ?,
                department = ?,
                primaryDepartment = ?,
                allowedDepartments = ?,
                roleId = ?,
                level = ?,
                status = ?,
                signature = CASE WHEN ? = 1 THEN ? ELSE signature END,
                updatedAt = ?
              WHERE id = ?
            `).bind(
              username, username,
              rawPass, rawPass,
              pin, pin,
              name, empName,
              position, dept, primaryDept, allowedDepts,
              roleId, level, status,
              sigSent, sigValue,
              now,
              existingUser.id
            ));
          }

          if (selfPw) await audit('PASSWORD_CHANGE', 'user', existingUser.id, { viaUserAdmin: true });
          else if (plainPass) await storeUserPassword(existingUser.id, plainPass);
          const updatedUserRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(existingUser.id).first();
          if (updatedUserRow && isUserActive(existingUser) && !isUserActive(updatedUserRow)) await revokeTokens(existingUser.id);
          return jsonResponse(formatSafeUser(updatedUserRow || { ...existingUser, ...u }));
        } else {
          // INSERT
          const newId = rawId || `USR-${Date.now()}-${uid()}`;
          const defaultPass = ''; // no default password: user cannot log in until a password is set
          try {
            await db.prepare(`
              INSERT INTO users (
                id, employeeId, username, email, password, pin, name, employeeName, displayName,
                position, department, primaryDepartment, allowedDepartments, roleId, canonicalRole,
                positionKey, title, level, status, pictureUrl, description, signature,
                canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
                canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
                canSetBudget, canViewAllDepts, createdAt, updatedAt
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              newId, empId || `EMP-${uid().slice(0, 8).toUpperCase()}`, username, email, defaultPass, pin || defaultPass, name, empName, dispName,
              position, dept, primaryDept, allowedDepts, roleId, canonicalRole,
              posKey, title, level, status, pic, desc, sig,
              canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
              canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
              canSetBudget, canViewAllDepts, now, now
            ).run();
          } catch (fullInsertErr) {
            console.error('[users API] Full insert failed, attempting core column fallback:', fullInsertErr && fullInsertErr.message);
            await db.prepare(`
              INSERT INTO users (
                id, employeeId, username, password, pin, name, employeeName,
                position, department, primaryDepartment, allowedDepartments, roleId, level, status, signature, updatedAt
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              newId, empId || `EMP-${uid().slice(0, 8).toUpperCase()}`, username, defaultPass, pin || defaultPass, name, empName,
              position, dept, primaryDept, allowedDepts, roleId, level, status, sig, now
            ).run();
          }

          if (plainPass) await storeUserPassword(newId, plainPass);
          const savedUserRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(newId).first();
          return jsonResponse(formatSafeUser(savedUserRow || u));
        }
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE users SET status = \'INACTIVE\', tokenVersion = COALESCE(tokenVersion, 0) + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ? OR username = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 9. Stock Logs (/api/stock-logs) ──
    if (path === '/api/stock-logs') {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 500').all();
        return jsonResponse(stockLogViews(filterStockLogs(scopeViewer, utcIsoRows(withGrnNumber(res.results || [])))));
      }

      if (method === 'POST') {
        const log = await request.json().catch(() => ({}));
        const logList = Array.isArray(log) ? log : [log];
        // Department gate (same behaviour as /api/products/batch) : the client posts the whole stock-log list, so a row for a product of a department
        // the user cannot reach is skipped (not written, id returned in `skipped`) and the rest is written - never an error for the normal flow.
        const skipped = [];
        const ignored = [];
        let written = 0;
        for (const l of logList) {
          if (!l || typeof l !== 'object') continue;
          // Goods-receipt stock rows are written by POST /api/pos/:id/receive only (they move stock and count against the PO's ceiling) : a client row with a
          // GRN document type, or with an id in the server's receipt namespace (LOG:...), is ignored here (never an error : the client re-posts its whole list)
          // (docType compared trimmed / upper-cased / without separators : 'grn ', 'GR-N', 'Goods_Receipt' ... are the same thing. The clients send no docType for
          // manual stock rows and the server derives it from the type, so a block-list of the receipt family is used rather than a list of allowed names.)
          const dtNorm = String(l.docType || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (String(l.id || '').trim().startsWith('LOG:') || dtNorm === 'GR' || dtNorm.startsWith('GRN') || /GOODSRECEIPT|GOODSRECEIVED|^RECEIVE|^RECEIPT/.test(dtNorm)) { ignored.push(l.id || null); continue; }
          const id = l.id || `LOG-${Date.now()}-${uid()}`;
          // find the product like /api/stock/issue : id -> code -> name (as the client sends them). Candidates of a code / name may exist in several
          // departments : the first one the user can reach wins ; a product that exists but none of them is reachable -> the log is skipped.
          const idKeys = [...new Set([l.productId].filter((x) => x && typeof x === 'string'))]; // the log's own `id` is NOT a product id
          const wantDept = normalizeDeptCode(l.department || l.category || '');
          // several products share a code / name across departments : the one in the log's own department first, then a stable order
          const rank = (rows) => rows.map((r) => r).sort((a, b) => {
            const ra = wantDept && normalizeDeptCode(a.department || a.category) === wantDept ? 0 : 1;
            const rb = wantDept && normalizeDeptCode(b.department || b.category) === wantDept ? 0 : 1;
            return ra - rb || String(a.id).localeCompare(String(b.id));
          });
          const codeKey = String(l.productCode || l.itemCode || l.sku || '').trim();
          const nameKey = String(l.productName || l.name || l.itemName || '').trim();
          const reach = (p) => {
            const d = p.department || p.category || '';
            return !d || canAccessDepartment(authUser, normalizeDeptCode(d));
          };
          let pr = null;
          let blocked = false;
          const consider = (rows) => {
            if (!rows.length) return false;
            const ok = rows.find(reach);
            if (ok) { pr = ok; return true; }
            blocked = true;
            return true;
          };
          for (const k of idKeys) {
            const r = await db.prepare('SELECT id, department, category FROM products WHERE id = ? LIMIT 1').bind(k).first().catch(() => null);
            if (r && consider([r])) break;
          }
          if (!pr && !blocked && codeKey) {
            const r = await db.prepare('SELECT id, department, category FROM products WHERE LOWER(code) = LOWER(?) AND COALESCE(isDeleted, 0) = 0 ORDER BY id LIMIT 50').bind(codeKey).all().catch(() => null);
            consider(rank((r && r.results) || []));
          }
          if (!pr && !blocked && nameKey) {
            const r = await db.prepare('SELECT id, department, category FROM products WHERE LOWER(name) = LOWER(?) AND COALESCE(isDeleted, 0) = 0 ORDER BY id LIMIT 50').bind(nameKey).all().catch(() => null);
            consider(rank((r && r.results) || []));
          }
          const prodId = pr ? pr.id : ''; // never the client's unverified value : an unresolved log belongs to no product id
          // the department the gate used (the product's ; the log's own only when there is no product / it has none) is the one stored
          const gateDept = (pr && (pr.department || pr.category)) || l.department || l.category || '';
          if (blocked) {
            const known = l.id ? await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(l.id).first().catch(() => null) : null;
            if (!known) skipped.push(id);
            continue;
          }
          {
            if (gateDept &&!canAccessDepartment(authUser, normalizeDeptCode(gateDept))) {
              // the client re-posts the whole log list : a log id already stored is old news (silent) ; a NEW id is something the user meant to record
              const known = l.id ? await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(l.id).first().catch(() => null) : null;
              if (!known) skipped.push(id);
              continue;
            }
          }
          written++;
          const prodCode = l.productCode || l.itemCode || l.sku || '';
          const prodName = l.productName || l.name || l.itemName || '';
          const type = (l.type || (Number(l.changeQty) < 0 ? 'OUT' : 'IN')).toUpperCase();
          // (an IN row with no docType is a manual / adjustment row : the receipt type GRN is only written by POST /api/pos/:id/receive)
          const docType = l.docType || (type === 'OUT' ? 'ISSUE' : 'ADJUST');
          const docNo = l.docNo || l.documentNo || l.referenceNo || l.grnNumber || l.poNumber || '';
          const refNo = l.referenceNo || l.refPo || l.poNo || l.poNumber || l.docNo || '';
          const poNo = l.poNo || l.poNumber || l.refPo || '';
          const qty = Math.abs(Number(l.quantity ?? l.qty ?? l.changeQty ?? 0));
          const changeQty = l.changeQty !== undefined ? Number(l.changeQty) : (type === 'OUT' ? -qty : qty);
          const balance = Number(l.balance ?? l.balanceAfter ?? l.currentStock ?? 0);
          const unit = l.unit || l.stockUnit || l.purchaseUnit || 'ชิ้น';
          // no department on the log and no product to take it from : the user's own (primary) department, 'PD' only when the user has none (ALL / admin)
          const ownDept = [authUser.primaryDepartment, authUser.department].map(normalizeDeptCode).find((d) => d && !isWildcardDept(d)) || '';
          const dept = normalizeDeptCode(gateDept || ownDept || 'PD');
          const location = l.location || l.locationName || l.targetLocation || l.targetUnit || l.issueUnit || l.issuedTo || '';
          const issuedTo = l.issuedTo || l.issueUnit || location || '';
          const issueUnit = l.issueUnit || l.unitId || l.unitName || issuedTo || '';
          const unitCost = Number(l.unitCost ?? l.unitPrice ?? l.baseUnitCost ?? l.price ?? 0);
          const totalCost = Number(l.totalCost ?? l.totalValue ?? l.totalPrice ?? (qty * unitCost));
          const actorId = authUser.roleKey;
          const actorName = authUser.name || authUser.username || 'System';
          const performedBy = actorName;
          const notes = l.notes || l.note || l.reason || '';
          // server time (client warehouseService/inventoryService always stamp "now" ; the client `date` is kept in its own column)
          const createdAt = new Date().toISOString();

          await db.prepare(`
            INSERT INTO stock_logs (
              id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo,
              quantity, changeQty, balance, unit, department, location, issuedTo, issueUnit,
              unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt,
              conversionRate, unitPrice, totalPrice, locationId, date, grnNumber
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `).bind(
            id, prodId, prodCode, prodName, type, docType, docNo, refNo, poNo,
            qty, changeQty, balance, unit, dept, location, issuedTo, issueUnit,
            unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt,
            optNum(l.conversionRate), optNum(l.unitPrice), optNum(l.totalPrice), l.locationId || null, l.date || null, l.grnNumber || null
          ).run().catch(err => {
            console.error('Error inserting stock_log:', err && err.message);
          });
          await audit('STOCK_LOG', 'stock_log', id, { actorUserId: authUser.userId });
        }
        return jsonResponse({ success: true, count: written, ...(skipped.length ? { skipped } : {}), ...(ignored.length ? { ignored } : {}) });
      }
    }

    // ── 9.1 Stock Issue Atomic Endpoint (/api/stock/issue or /api/inventory/issue) ──
    if (path === '/api/stock/issue' || path === '/api/inventory/issue') {
      if (!db) return errorResponse('Database not available', 500);
      if (method === 'POST') {
        const payload = await request.json().catch(() => ({}));
        const productId = payload.productId || payload.id;
        const productCode = payload.productCode || payload.code || payload.sku;
        const rawQty = payload.quantity !== undefined ? payload.quantity : (payload.qty !== undefined ? payload.qty : payload.issueQty);
        // (the sign is ignored as before : a negative quantity is the same issue) ; same shape / ceiling / 4 dp rule as adjust
        const rawAbs = typeof rawQty === 'number' ? Math.abs(rawQty) : (typeof rawQty === 'string' ? rawQty.trim().replace(/^-/, '') : rawQty);
        const parsedIssue = parseStockQty(rawAbs);
        if (parsedIssue.error) {
          return errorResponse(`จำนวนที่เบิกจ่ายไม่ถูกต้อง: ${parsedIssue.error}`, 400);
        }
        const quantity = parsedIssue.qty;

        // 1. ค้นหาสินค้าในตาราง products ด้วย id หรือ code
        let prod = null;
        if (productId) {
          prod = await db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1').bind(productId).first();
        }
        if (!prod && productCode) {
          prod = await db.prepare('SELECT * FROM products WHERE code = ? LIMIT 1').bind(productCode).first();
        }

        if (!prod) {
          return errorResponse('ไม่พบสินค้านี้ในระบบเพื่อตัดสต็อก', 404);
        }
        // stock of another department cannot be issued (the screens only list the user's own departments' products)
        // department of the product, category as the fallback ; a product with neither belongs to nobody in particular -> admin only
        const prodDept = prod.department || prod.category || '';
        if (prodDept ? !canAccessDepartment(authUser, normalizeDeptCode(prodDept)) : !normalizeUser(authUser).isAdmin) return errorResponse(FORBIDDEN_MSG, 403);

        const currentStock = Number(prod.currentStock || 0);
        const sUnit = prod.usageUnit || prod.purchaseUnit || 'ชิ้น';
        // both sides at 4 dp : "issue all" sends the raw balance (a float sum such as 0.30000000000000004 / 0.29999999999999993) and must always fit
        if (round4(currentStock) < quantity) {
          return errorResponse(`จำนวนคงเหลือไม่พอเบิก (มี ${currentStock} ${sUnit}, ต้องการเบิก ${quantity} ${sUnit})`, 400);
        }

        let newBalance = Math.round((currentStock - quantity) * 10000) / 10000;
        const department = prod.department || prod.category || payload.department || 'PD'; // the department the gate used (the product's)
        const issuedTo = payload.issuedTo || payload.issueUnit || payload.location || '';
        const location = payload.location || payload.targetLocation || payload.targetUnit || issuedTo || '';
        const issueUnit = payload.issueUnit || location || issuedTo || '';
        const reason = payload.reason || payload.note || payload.notes || 'เบิกจ่ายด่วน';
        const requesterId = authUser.roleKey;
        const requesterName = authUser.name || authUser.username || issuedTo || 'System';
        // issue cost = the product's moving average cost (GAS apiAppendStockMovements OUT : avgCost || price), with the same fail-safe the screen shows
        // (stock > 0 and no avgCost -> latest IN price) ; computed here, never taken from the client
        const unitCost = await serverIssueUnitCost(db, prod);
        const totalCost = Math.round(quantity * unitCost * 100) / 100;

        // the log id is ALWAYS server-generated (a client id could overwrite/collide with an existing movement)
        const logId = `LOG-${department}-${Date.now()}-${uid()}`;
        const docNo = payload.docNo || `REQ-${Date.now().toString().slice(-4)}${uid().slice(0, 4)}`;
        const nowIso = new Date().toISOString();

        // 2. ตัดยอดสต็อกแบบอะตอมมิก: ตัดได้เฉพาะเมื่อยอดพอ (race-safe) ; ไม่พอ -> ข้อความเดิม
        const deducted = await db.prepare(`
          UPDATE products SET
            currentStock = MAX(0, ROUND(currentStock - ?, 4)),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? AND ROUND(currentStock, 4) >= ?
          RETURNING currentStock
        `).bind(quantity, prod.id, quantity).first();
        if (!deducted) {
          const fresh = await db.prepare('SELECT currentStock FROM products WHERE id = ? LIMIT 1').bind(prod.id).first().catch(() => null);
          const nowStock = Number(fresh && fresh.currentStock != null ? fresh.currentStock : currentStock);
          return errorResponse(`จำนวนคงเหลือไม่พอเบิก (มี ${nowStock} ${sUnit}, ต้องการเบิก ${quantity} ${sUnit})`, 400);
        }
        newBalance = Math.round(Number(deducted.currentStock) * 10000) / 10000;

        // 3. บันทึกประวัติการเคลื่อนไหวลงใน stock_logs (append-only ; id ซ้ำ = ไม่เขียนทับ และคืนสต็อกที่เพิ่งตัด)
        const logged = await db.prepare(`
          INSERT INTO stock_logs (
            id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo,
            quantity, changeQty, balance, unit, department, location, issuedTo, issueUnit,
            unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt
          )
          VALUES (?, ?, ?, ?, 'OUT', 'ISSUE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
          RETURNING id
        `).bind(
          logId,
          prod.id,
          prod.code,
          prod.name,
          docNo,
          docNo,
          payload.poNo || '',
          quantity,
          -quantity,
          newBalance,
          sUnit,
          department,
          location,
          issuedTo,
          issueUnit,
          unitCost,
          totalCost,
          requesterId,
          requesterName,
          requesterName,
          reason,
          nowIso
        ).first().catch(async (e) => {
          // the log could not be written: give the stock back so stock and log never diverge, then fail the request
          await db.prepare('UPDATE products SET currentStock = currentStock + ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').bind(quantity, prod.id).run().catch(() => {});
          throw e;
        });
        if (!logged) {
          await db.prepare('UPDATE products SET currentStock = currentStock + ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').bind(quantity, prod.id).run().catch(() => {});
          return jsonResponse({ success: true, duplicate: true, message: 'รายการเบิกจ่ายนี้ถูกบันทึกแล้ว' });
        }
        await audit('STOCK_ISSUE', 'stock_log', logId, { actorUserId: authUser.userId, productId: prod.id, quantity });

        const updatedProduct = {
          ...productView({ ...prod, currentStock: newBalance }),
          currentStock: newBalance,
          stockBalance: newBalance,
          updatedAt: nowIso
        };

        const logEntry = {
          id: logId,
          timestamp: nowIso,
          date: nowIso,
          type: 'OUT',
          docType: 'ISSUE',
          docNo,
          referenceNo: docNo,
          productId: prod.id,
          productCode: prod.code,
          productName: prod.name,
          name: prod.name,
          department,
          location,
          changeQty: -quantity,
          qty: quantity,
          quantity,
          unit: sUnit,
          balanceAfter: newBalance,
          balance: newBalance,
          unitCost,
          totalCost,
          issuedTo,
          issueUnit,
          reason,
          notes: reason,
          actorId: requesterId,
          actorName: requesterName,
          performedBy: requesterName,
          createdAt: nowIso
        };

        return jsonResponse({
          success: true,
          updatedProduct,
          product: updatedProduct,
          logEntry
        });
      }
    }

    // ── 9.2 Manual stock movements : Stock Adjustment (+/-) and Manual Stock-In (/api/stock/adjust, /api/stock/manual-in) ──
    // The screens (StockAdjustmentModal / ManualStockInModal) only move the balance and write one log row (type IN / OUT, doc ADJ-IN-/ADJ-OUT-/MAN-IN-) ;
    // they never touch the moving-average cost (no price on those forms). The server owns the arithmetic : balance, log, audit in ONE db.batch,
    // never below zero (same message as the modal), actor from the token, department gate like /api/stock/issue, replay of the same requestId is a no-op.
    if ((path === '/api/stock/adjust' || path === '/api/stock/manual-in') && method === 'POST') {
      if (!db) return errorResponse('Database not available', 500);
      const manualIn = path === '/api/stock/manual-in';
      const payload = await request.json().catch(() => ({}));
      const dir = manualIn ? 'IN' : String(payload.direction || payload.actionType || payload.type || '').trim().toUpperCase();
      if (dir !== 'IN' && dir !== 'OUT') return errorResponse('ประเภทการปรับปรุงไม่ถูกต้อง', 400);
      const parsedQty = parseStockQty(payload.quantity ?? payload.qty);
      if (parsedQty.error) return errorResponse(parsedQty.error, 400);
      const qty = parsedQty.qty;
      // per user per minute (like the audit-log endpoint) : a stuck / hostile client cannot flood the ledger
      const nowMs = Date.now();
      const recentMoves = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE performedBy = ? AND action IN ('STOCK_ADJUST', 'STOCK_MANUAL_IN') AND createdAtMs > ?").bind(authUser.userId, nowMs - 60000).first().catch(() => null);
      // the limit could not be checked : refuse (never let the write through unchecked)
      if (!recentMoves) return errorResponse('ระบบตรวจจำนวนครั้งการปรับปรุงสต็อกไม่ได้ชั่วคราว กรุณาลองใหม่', 503);
      if (Number(recentMoves.c) >= STOCK_MANUAL_PER_MIN) return errorResponse('ปรับปรุงสต็อกถี่เกินไป กรุณารอสักครู่', 429);
      const reasonText = String(payload.reason || '').trim().slice(0, 300);
      if (!reasonText) return errorResponse('กรุณาระบุเหตุผล', 400);
      const customNote = String(payload.customNote || payload.note || '').trim().slice(0, 500);
      const pid = String(payload.productId || payload.id || '').trim();
      const pcode = String(payload.productCode || payload.code || '').trim();
      let prod = null;
      if (pid) prod = await db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1').bind(pid).first();
      if (!prod && !pid && pcode) prod = await db.prepare('SELECT * FROM products WHERE code = ? AND COALESCE(isDeleted, 0) = 0 ORDER BY id LIMIT 1').bind(pcode).first();
      if (!prod || Number(prod.isDeleted || 0) === 1) return errorResponse('ไม่พบสินค้าในระบบ', 404);
      const prodDept = prod.department || prod.category || '';
      if (prodDept ? !canAccessDepartment(authUser, normalizeDeptCode(prodDept)) : !normalizeUser(authUser).isAdmin) return errorResponse(FORBIDDEN_MSG, 403);

      const sUnit = prod.usageUnit || prod.purchaseUnit || 'ชิ้น';
      const delta = dir === 'IN' ? qty : -qty;
      const currentStock = Number(prod.currentStock || 0);
      const lackMsg = (have) => `ไม่สามารถปรับลด (${qty}) ได้มากกว่ายอดคงเหลือปัจจุบัน (${have})`;
      if (dir === 'OUT' && qty > round4(currentStock)) return errorResponse(lackMsg(round4(currentStock)), 400);

      // idempotency : the client sends one requestId per confirmed form ; the log id derives from (user, requestId) so a replay hits the primary key
      const reqKey = String(payload.requestId || payload.idempotencyKey || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      const dept = normalizeDeptCode(prodDept || 'PD');
      // id = hash of (kind | product | user | requestId) : the same requestId on another product / direction / user is a NEW movement
      const kind = manualIn ? 'MIN' : `ADJ${dir}`;
      let logId = `LOG-${dept}-${Date.now()}-${uid()}`;
      if (reqKey) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, String(prod.id), String(authUser.userId), reqKey])));
        logId = `LOG-${kind}-${[...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      }
      const viewProduct = async () => {
        const fresh = await db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1').bind(prod.id).first().catch(() => null);
        const f = fresh || prod;
        const bal = Math.round(Number(f.currentStock || 0) * 10000) / 10000;
        return { ...productView({ ...f, currentStock: bal }), currentStock: bal, stockBalance: bal };
      };
      if (reqKey) {
        const known = await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(logId).first().catch(() => null);
        if (known) {
          const up = await viewProduct();
          return jsonResponse({ success: true, duplicate: true, message: 'รายการนี้ถูกบันทึกแล้ว', updatedProduct: up, product: up });
        }
      }

      // (leading format kept : ADJ-IN- / ADJ-OUT- / MAN-IN- + 6 digits ; the tail of the log id keeps two movements in the same millisecond apart)
      const suffix = `${Date.now().toString().slice(-6)}-${logId.slice(-4)}`;
      const docNo = manualIn ? `MAN-IN-${suffix}` : `ADJ-${dir}-${suffix}`;
      const noteText = `${manualIn ? '[รับเข้าด้วยตนเอง]' : `[ปรับปรุงสต็อก ${dir === 'IN' ? '+ เพิ่ม' : '- ลด'}]`} ${reasonText}${customNote ? ` — ${customNote}` : ''}`;
      const actorName = authUser.name || authUser.username || 'System';
      const nowIso = new Date().toISOString();
      const unitCost = await serverIssueUnitCost(db, prod);
      const totalCost = Math.round(qty * unitCost * 100) / 100;
      // location : the product's storage point (name in `location`, id in `locationId`) so the movement shows where the stock sits
      const locationId = prod.defaultLocationId || null;
      const locRow = locationId ? await db.prepare('SELECT name FROM storage_locations WHERE id = ? LIMIT 1').bind(locationId).first().catch(() => null) : null;
      const location = (locRow && locRow.name) || '';
      try {
        await db.batch([
          // log first : the row exists only when the balance can take the change ; its `balance` is computed inside the same transaction
          db.prepare(`
            INSERT INTO stock_logs (
              id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo,
              quantity, changeQty, balance, unit, department, location, issuedTo, issueUnit,
              unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt, locationId
            )
            SELECT ?, id, ?, ?, ?, 'ADJUST', ?, ?, '', ?, ?, ROUND(COALESCE(currentStock, 0) + ?, 4), ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?
            FROM products WHERE id = ? AND ROUND(COALESCE(currentStock, 0) + ?, 4) >= 0
          `).bind(logId, prod.code, prod.name, dir, docNo, docNo, qty, delta, delta, sUnit, dept, location, unitCost, totalCost, authUser.roleKey, actorName, actorName, noteText, nowIso, locationId, prod.id, delta),
          db.prepare(`
            UPDATE products SET currentStock = ROUND(COALESCE(currentStock, 0) + ?, 4), updatedAt = CURRENT_TIMESTAMP
            WHERE id = ? AND ROUND(COALESCE(currentStock, 0) + ?, 4) >= 0 AND EXISTS (SELECT 1 FROM stock_logs WHERE id = ?)
          `).bind(delta, prod.id, delta, logId),
          // audit only when the log row exists (same guard as the stock update : a movement refused inside the transaction leaves no audit)
          db.prepare('INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp, createdAtMs) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stock_logs WHERE id = ?)')
            .bind(`AUD-${Date.now()}-${uid()}`, manualIn ? 'STOCK_MANUAL_IN' : 'STOCK_ADJUST', 'stock_log', logId, authUser.userId,
              JSON.stringify({ roleKey: authUser.roleKey, productId: prod.id, direction: dir, quantity: qty, reason: reasonText, docNo }), nowIso, nowMs, logId)
        ]);
      } catch (e) {
        // a replay racing the first request hits the primary key : the whole batch rolled back, nothing was added twice
        const known = reqKey ? await db.prepare('SELECT 1 AS x FROM stock_logs WHERE id = ? LIMIT 1').bind(logId).first().catch(() => null) : null;
        if (known) {
          const up = await viewProduct();
          return jsonResponse({ success: true, duplicate: true, message: 'รายการนี้ถูกบันทึกแล้ว', updatedProduct: up, product: up });
        }
        console.error('[stock-manual] batch failed:', e && e.message);
        return errorResponse('ไม่สามารถบันทึกการปรับปรุงสต็อกได้ กรุณาลองใหม่', 500);
      }
      const logRow = await db.prepare('SELECT * FROM stock_logs WHERE id = ? LIMIT 1').bind(logId).first().catch(() => null);
      if (!logRow) {
        // refused inside the transaction : a concurrent movement took the stock between the check and the write
        const fresh = await db.prepare('SELECT currentStock FROM products WHERE id = ? LIMIT 1').bind(prod.id).first().catch(() => null);
        return errorResponse(lackMsg(Number(fresh && fresh.currentStock != null ? fresh.currentStock : currentStock)), 400);
      }
      const up = await viewProduct();
      return jsonResponse({
        success: true,
        updatedProduct: up,
        product: up,
        logEntry: { ...logRow, timestamp: nowIso, date: nowIso, balanceAfter: logRow.balance, qty, reason: reasonText }
      });
    }

    // ── 10. Budgets & Ledger (/api/budgets & /api/budget-transactions) ──
    if (path === '/api/budgets/adjust' && method === 'POST') {
      if (!db) return jsonResponse({ success: false });
      const params = await request.json().catch(() => ({}));
      const { dept, action, newAmount, previousAmount, delta, reason, targetMonth } = params;
      if (!canAdjustBudget(authUser, params)) return errorResponse(FORBIDDEN_MSG, 403);
      const actor = authUser.name || authUser.username;
      const cleanDept = ledgerDeptCode(dept) || 'PD';
      const numAmount = Number(newAmount ?? delta ?? 0);
      const mKey = targetMonth || bangkokMonth();

      const existing = await db.prepare('SELECT * FROM budgets WHERE id = ?').bind(cleanDept).first().catch(() => null);
      let history = {};
      if (existing?.monthsJson) {
        history = parseJsonSafe(existing.monthsJson, {});
      }

      let baseAlloc = Number(existing?.monthlyBudget || 0);
      if (baseAlloc === 0) {
        const deptMaster = await db.prepare('SELECT monthlyBudget FROM departments WHERE code = ?').bind(cleanDept).first().catch(() => null);
        baseAlloc = Number(deptMaster?.monthlyBudget || 0);
      }

      // Refund / rollback / deduct flows (client handleRefundBudget, rollbackBudget, deductBudget; mock server budgetRoutes.js):
      // amounts are computed from SERVER state only - client newAmount / previousAmount are ignored (they would set monthlyBudget wrongly).
      const act = String(action || '').toUpperCase();
      if (act === 'TOP_UP' || act === 'BUDGET_ROLLBACK' || act === 'BUDGET_DEDUCT') {
        const amt = Math.abs(Number(delta));
        if (!Number.isFinite(amt) || amt <= 0) return errorResponse('ยอดเงินไม่ถูกต้อง', 400);
        if (!/^\d{4}-\d{2}$/.test(String(mKey))) return errorResponse('รอบเดือนไม่ถูกต้อง', 400);
        const monthPath = `$."${mKey}"`;
        const curMonthly = Number(existing?.monthlyBudget || 0);
        const monthBase = history[mKey] !== undefined ? Number(history[mKey]) : baseAlloc;
        const nowIso = new Date().toISOString();
        const txId2 = `BTX-${Date.now()}-${uid()}-${cleanDept}`;
        // T4.6: whoever has no budget permission (requester / online purchaser) may only ADD budget (TOP_UP / BUDGET_ROLLBACK) against a real PO of
        // that department, within what that PO actually cut from the budget (same base as the settle cap) ; budget writers stay unrestricted.
        const docRef = str100(params.docNo || params.poNumber || params.referenceDoc || params.refDocNo);
        let gate = null;
        if (!canWriteBudget(resolvePermissions(authUser)) && (act === 'TOP_UP' || act === 'BUDGET_ROLLBACK')) {
          const g = await resolveRefundPo(db, authUser, { docNo: docRef, dept: cleanDept });
          if (g.error) return errorResponse(g.error.message, g.error.status);
          if (amt > g.ctx.capLeft + 0.005) return errorResponse('ยอดคืนเกินมูลค่าที่ตัดงบไว้ของ PO นี้', 400);
          gate = g.ctx;
        }
        const labelPo = gate ? gate.poNumber : (docRef || null);
        const stmts2 = [db.prepare(`
          INSERT OR IGNORE INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
          VALUES (?, ?, ${bangkokYear()}, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
        `).bind(cleanDept, cleanDept, curMonthly || baseAlloc, curMonthly || baseAlloc, curMonthly || baseAlloc, JSON.stringify(history))];
        let label; let prevVal; let newVal; let signed;
        let updStmt;
        // gated (non-writer) rows: the ledger row goes in FIRST with the cap checked inside its own INSERT ... SELECT ... WHERE, and the budget
        // UPDATE only applies when that row exists - so two concurrent credits can never exceed the cap together (the loser gets 409)
        const onlyIfLedger = gate ? ' AND EXISTS (SELECT 1 FROM budget_transactions WHERE id = ?)' : '';
        const onlyIfLedgerBind = gate ? [txId2] : [];
        if (act === 'TOP_UP') {
          const finalAmt = monthBase + amt;
          history[mKey] = finalAmt;
          // relative updates (no read-modify-write of the totals) so concurrent top-ups cannot lose each other
          updStmt = db.prepare(`
            UPDATE budgets SET
              monthlyBudget = monthlyBudget + ?,
              totalAllocated = totalAllocated + ?,
              totalRemaining = totalRemaining + ?,
              monthsJson = json_set(COALESCE(NULLIF(monthsJson, ''), '{}'), ?, COALESCE(json_extract(COALESCE(NULLIF(monthsJson, ''), '{}'), ?), ?) + ?),
              updatedAt = CURRENT_TIMESTAMP
            WHERE id = ?${onlyIfLedger}
          `).bind(amt, amt, amt, monthPath, monthPath, baseAlloc, amt, cleanDept, ...onlyIfLedgerBind);
          label = 'เติมงบประมาณพิเศษ (Budget Top-up)'; prevVal = monthBase; newVal = finalAmt; signed = amt;
        } else if (act === 'BUDGET_ROLLBACK') {
          updStmt = db.prepare(`
            UPDATE budgets SET
              totalUsed = MAX(0, totalUsed - ?),
              totalRemaining = totalRemaining + ?,
              refundCreditsJson = json_set(COALESCE(NULLIF(refundCreditsJson, ''), '{}'), ?, COALESCE(json_extract(COALESCE(NULLIF(refundCreditsJson, ''), '{}'), ?), 0) + ?),
              updatedAt = CURRENT_TIMESTAMP
            WHERE id = ?${onlyIfLedger}
          `).bind(amt, amt, monthPath, monthPath, amt, cleanDept, ...onlyIfLedgerBind);
          const used = Number(existing?.totalUsed || 0);
          label = 'คืนงบประมาณ (Budget Reversal)'; prevVal = used; newVal = Math.max(0, used - amt); signed = amt;
        } else {
          updStmt = db.prepare(`
            UPDATE budgets SET totalUsed = totalUsed + ?, totalRemaining = totalRemaining - ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(amt, amt, cleanDept);
          const used = Number(existing?.totalUsed || 0);
          label = 'หักงบประมาณเพิ่มเติม (Budget Deduct)'; prevVal = used; newVal = used + amt; signed = -amt;
        }
        const guard = gate ? refundCapGuard(amt, gate) : { sql: '', binds: [] };
        const ledgerStmt = db.prepare(`
          INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date, docType, docNo, poNumber, actorUserId)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE 1 ${guard.sql}
          ON CONFLICT(id) DO NOTHING
          RETURNING id
        `).bind(txId2, cleanDept, cleanDept, act, act, label, amt, signed, prevVal, newVal, act === 'TOP_UP' ? 1 : 0,
          actor || 'Staff', reason || label, mKey, mKey, nowIso, nowIso, labelPo ? 'PO' : null, labelPo, labelPo, authUser.userId, ...guard.binds);
        if (gate) stmts2.push(ledgerStmt, updStmt); else stmts2.push(updStmt, ledgerStmt);
        let batchOut;
        try {
          batchOut = await db.batch(stmts2);
        } catch (e) {
          console.error('[budgets/adjust] batch failed:', e && e.message);
          return errorResponse('ไม่สามารถบันทึกงบประมาณได้', 500);
        }
        if (gate) {
          const won = batchOut && batchOut[1] && Array.isArray(batchOut[1].results) && batchOut[1].results.length > 0;
          if (!won) return errorResponse('ยอดคืนเกินมูลค่าที่ตัดงบไว้ของ PO นี้ (มีการคืนพร้อมกัน) กรุณารีเฟรชหน้าแล้วลองอีกครั้ง', 409);
        }
        await audit('BUDGET_ADJUST', 'budget', cleanDept, { actorUserId: authUser.userId, action: act, amount: amt });
        return jsonResponse({
          success: true,
          budget: { department: cleanDept, monthlyBudget: act === 'TOP_UP' ? newVal : curMonthly, history },
          transaction: { id: txId2, type: act, typeLabel: label, amount: amt, delta: signed, previousAmount: prevVal, newAmount: newVal, period: mKey }
        });
      }

      const prevAlloc = (previousAmount !== undefined && previousAmount !== null)
        ? Number(previousAmount)
        : (history[mKey] !== undefined ? Number(history[mKey]) : baseAlloc);

      const deltaAmount = (delta !== undefined && delta !== null) ? Number(delta) : (numAmount - prevAlloc);
      const isInitial = prevAlloc === 0;
      const movementAmount = isInitial ? numAmount : Math.abs(deltaAmount);
      const txType = isInitial ? 'MONTHLY_ALLOCATION' : (deltaAmount >= 0 ? 'TOP_UP' : 'BUDGET_ADJUSTMENT_DOWN');
      const txTypeLabel = isInitial 
        ? 'จัดสรรงบประมาณประจำเดือน' 
        : (deltaAmount >= 0 ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดงบประมาณ');

      history[mKey] = numAmount;

      await db.prepare(`
        INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
        VALUES (?, ?, ${bangkokYear()}, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          monthlyBudget = excluded.monthlyBudget,
          totalAllocated = excluded.totalAllocated,
          monthsJson = excluded.monthsJson,
          updatedAt = CURRENT_TIMESTAMP
      `).bind(cleanDept, cleanDept, numAmount, numAmount, numAmount, JSON.stringify(history)).run().catch(() => {});

      const now = new Date().toISOString();
      const txId = `BTX-${Date.now()}-${uid()}-${cleanDept}`;
      await db.prepare(`
        INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(
        txId,
        cleanDept,
        cleanDept,
        txType,
        txType,
        txTypeLabel,
        movementAmount,
        deltaAmount,
        prevAlloc,
        numAmount,
        deltaAmount >= 0 ? 1 : 0,
        actor || 'Staff',
        reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${mKey}` : (deltaAmount >= 0 ? `ปรับเพิ่มงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmount.toLocaleString()}` : `ปรับลดงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmount.toLocaleString()}`)),
        mKey,
        mKey,
        now,
        now
      ).run().catch(() => {});

      return jsonResponse({
        success: true,
        budget: { department: cleanDept, monthlyBudget: numAmount, history },
        transaction: {
          id: txId,
          type: txType,
          typeLabel: txTypeLabel,
          amount: movementAmount,
          delta: deltaAmount,
          previousAmount: prevAlloc,
          newAmount: numAmount,
          period: mKey
        }
      });
    }

    if (path === '/api/budgets/allocate' && method === 'POST') {
      if (!db) return jsonResponse({ success: false });
      const { period, allocations, previousAmounts, reason, transactionId, transactions } = await request.json().catch(() => ({}));
      const actor = authUser.name || authUser.username;
      const mKey = period || bangkokMonth();
      if (allocations && typeof allocations === 'object') {
        const now = new Date().toISOString();
        for (const [dept, amt] of Object.entries(allocations)) {
          const cleanDept = ledgerDeptCode(dept);
          if (!cleanDept || isWildcardDept(cleanDept)) continue;
          const numAmt = Number(amt || 0);
          const existing = await db.prepare('SELECT * FROM budgets WHERE id = ?').bind(cleanDept).first().catch(() => null);
          let history = {};
          if (existing?.monthsJson) {
            history = parseJsonSafe(existing.monthsJson, {});
          }

          let baseAlloc = Number(existing?.monthlyBudget || 0);
          if (baseAlloc === 0) {
            const deptMaster = await db.prepare('SELECT monthlyBudget FROM departments WHERE code = ?').bind(cleanDept).first().catch(() => null);
            baseAlloc = Number(deptMaster?.monthlyBudget || 0);
          }

          const explicitPrev = (previousAmounts && previousAmounts[cleanDept] !== undefined && previousAmounts[cleanDept] !== null)
            ? Number(previousAmounts[cleanDept])
            : null;
          const prevAlloc = explicitPrev !== null
            ? explicitPrev
            : (history[mKey] !== undefined ? Number(history[mKey]) : baseAlloc);

          const deltaAmount = numAmt - prevAlloc;
          const isInitial = prevAlloc === 0;
          const movementAmount = isInitial ? numAmt : Math.abs(deltaAmount);
          const txType = isInitial ? 'MONTHLY_ALLOCATION' : (deltaAmount >= 0 ? 'TOP_UP' : 'BUDGET_ADJUSTMENT_DOWN');
          const txTypeLabel = isInitial 
            ? 'จัดสรรงบประมาณประจำเดือน' 
            : (deltaAmount >= 0 ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดงบประมาณ');

          history[mKey] = numAmt;
          await db.prepare(`
            INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
            VALUES (?, ?, ${bangkokYear()}, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              monthlyBudget = excluded.monthlyBudget,
              totalAllocated = excluded.totalAllocated,
              monthsJson = excluded.monthsJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(cleanDept, cleanDept, numAmt, numAmt, numAmt, JSON.stringify(history)).run().catch(() => {});

          // ledger is append-only: a client-supplied id that already exists is never rewritten ; we then fall back to a server id
          const serverTxId = () => `BTX-ALLOC-${cleanDept}-${mKey}-${Date.now()}-${uid()}`;
          const singleDept = Object.keys(allocations).filter((k) => k && k !== 'ALL').length === 1;
          const clientTxId = (transactions && (transactions[cleanDept]?.id || transactions[dept]?.id)) || (singleDept ? transactionId : null);
          const allocSql = `
            INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            RETURNING id
          `;
          const allocBind = (id) => [
            id,
            cleanDept,
            cleanDept,
            txType,
            txType,
            txTypeLabel,
            movementAmount,
            deltaAmount,
            prevAlloc,
            numAmt,
            deltaAmount >= 0 ? 1 : 0,
            actor || 'Staff',
            reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${mKey}` : (deltaAmount >= 0 ? `ปรับเพิ่มงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmt.toLocaleString()}` : `ปรับลดงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmt.toLocaleString()}`)),
            mKey,
            mKey,
            now,
            now
          ];
          let allocRow = await db.prepare(allocSql).bind(...allocBind(clientTxId || serverTxId())).first().catch(() => null);
          if (!allocRow) allocRow = await db.prepare(allocSql).bind(...allocBind(serverTxId())).first().catch(() => null);
          await audit('BUDGET_ALLOCATE', 'budget', cleanDept, { actorUserId: authUser.userId, period: mKey, amount: numAmt });
        }
      }
      return jsonResponse({ success: true, period: mKey, allocations });
    }

    if (path === '/api/budgets' || path.startsWith('/api/budgets/')) {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] }));
        return jsonResponse(filterBudgetRows(scopeViewer, utcIsoRows(res.results || [])));
      }
      // POST /api/budgets/reset (client BudgetView self-heal -> budgetService.resetBudgetData) : acknowledged, NOTHING is written.
      // The client calls it from a local heuristic ("bloated mock baseline") with a baseline it generated itself ; applying that to
      // the shared D1 budgets would wipe real figures. The mock backend (server/routes/budgetRoutes.js) has no such route at all.
      // (Before T3.2 this POST fell into the generic upsert below and overwrote budgets with the client's baseline.)
      if (method === 'POST' && path === '/api/budgets/reset') {
        return jsonResponse({ success: true, applied: false, message: 'reset ไม่ทำงานฝั่ง server (ไม่แก้ข้อมูลงบประมาณ)' });
      }
      // PUT /api/budgets/:dept (budgetService reconcile after a claim refund) : same upsert as POST /api/budgets for one department
      if (method === 'PUT' && path.startsWith('/api/budgets/')) {
        const deptSeg = decodeURIComponent(path.slice('/api/budgets/'.length));
        if (!deptSeg || deptSeg.includes('/') || ['adjust', 'allocate', 'reset'].includes(deptSeg.toLowerCase())) return errorResponse('เส้นทางไม่ถูกต้อง', 400);
        if (isWildcardDept(ledgerDeptCode(deptSeg))) return errorResponse('แผนกไม่ถูกต้อง', 400);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('ข้อมูลงบประมาณไม่ถูกต้อง', 400);
        const code = ledgerDeptCode(deptSeg);
        const known = await knownDepartmentCodes(db);
        if (known && known.size > 0 && !known.has(code)) return errorResponse('ไม่พบแผนกนี้ในระบบ', 400);

        if (canWriteBudget(resolvePermissions(authUser))) {
          // budget writer = GAS apiSaveBudgets parity : the body's figures (spent -> totalUsed, variance -> totalRemaining, refundCredits ...)
          // are stored as sent, so a claim refund closed by an approver/admin (creditDepartmentBudget) is what the next bootstrap returns
          const before = await db.prepare('SELECT totalUsed FROM budgets WHERE id = ?').bind(code).first();
          const spentSent = Number(budgetSpentOf(body));
          const drop = before && Number.isFinite(spentSent) ? Math.round((Number(before.totalUsed || 0) - spentSent) * 100) / 100 : 0;
          // the client's own ledger row (actionType REFUND_SETTLEMENT) is acknowledged but not stored, so the server records the credit itself ;
          // the row goes in the SAME batch as the upsert (all or nothing)
          const extra = drop > 0 ? [claimCreditLedgerStmt(db, { code, credit: drop, prevUsed: Number(before.totalUsed || 0), actor: authUser.name || authUser.username, actorUserId: authUser.userId, role: authUser.title || authUser.canonicalRole || authUser.roleKey, guardUsed: null, docNo: str100(body.docNo || body.poNumber || body.referenceDoc || body.refDocNo) || null, transactionId: str100(body.transactionId || body.idempotencyKey, 200) || null })] : [];
          const bad = await upsertBudgetEntry(db, code, body, { overwriteTotals: true, extraStmts: extra });
          if (bad) return errorResponse(bad, 400);
          return jsonResponse({ success: true, id: code });
        }

        // Everybody else (requester settling a PO, online purchaser resolving a claim): the ONLY thing accepted is a refund credit, i.e. what
        // budgetService.creditDepartmentBudget sends = the department budget with `spent` lowered. The amount is the difference between the
        // stored totalUsed (D1) and body.spent ; totals / remaining / refundCredits in the body are never trusted. Same limits as adjust
        // BUDGET_ROLLBACK (own department unless online purchaser, amount > 0, no wildcard) and monthlyBudget / allocation are never touched.
        const cur = await db.prepare('SELECT monthlyBudget, totalUsed FROM budgets WHERE id = ?').bind(code).first();
        if (!cur) return errorResponse('ไม่พบงบประมาณของแผนกนี้', 404);
        const sentMonthly = body.monthlyBudget ?? body.totalBudget;
        if (sentMonthly !== undefined && sentMonthly !== null && sentMonthly !== '' && !(Math.abs(Number(sentMonthly) - Number(cur.monthlyBudget || 0)) <= 0.005)) {
          return errorResponse(FORBIDDEN_MSG, 403); // changing the allocation needs the budget permission
        }
        const spentNow = Number(budgetSpentOf(body));
        if (!Number.isFinite(spentNow) || spentNow < 0) return errorResponse(FORBIDDEN_MSG, 403);
        const credit = Math.round((Number(cur.totalUsed || 0) - spentNow) * 100) / 100;
        if (credit <= 0) {
          // nothing to credit (already applied, e.g. through adjust BUDGET_ROLLBACK) - acknowledged, nothing written
          // `spent` above the stored figure = the client is stale (someone else changed the budget) : 409 so it reloads, nothing is written
          if (credit < 0) return errorResponse('ข้อมูลงบประมาณในเครื่องไม่เป็นปัจจุบัน กรุณารีเฟรชหน้าแล้วลองอีกครั้ง', 409);
          return jsonResponse({ success: true, id: code, applied: false });
        }
        if (!canAdjustBudget(authUser, { dept: code, action: 'BUDGET_ROLLBACK', delta: credit })) return errorResponse(FORBIDDEN_MSG, 403);
        // T4.6: the credit must name a real PO of this department (budgetService.creditDepartmentBudget sends referenceDoc / docNo / poNumber) and stay
        // within what that PO cut from the budget (resolveRefundPo : same base as the settle cap, counting every earlier refund of the PO)
        const tid = str100(body.transactionId || body.idempotencyKey, 200);
        if (tid) {
          const dupTx = await db.prepare('SELECT id FROM budget_transactions WHERE transactionId = ? LIMIT 1').bind(tid).first();
          if (dupTx) return jsonResponse({ success: true, id: code, applied: false, duplicate: true }); // the very same refund again (retry)
        }
        const g = await resolveRefundPo(db, authUser, { docNo: body.docNo || body.poNumber || body.referenceDoc || body.refDocNo, dept: code });
        if (g.error) return errorResponse(g.error.message, g.error.status);
        if (credit > g.ctx.capLeft + 0.005) return errorResponse('ยอดคืนเกินมูลค่าที่ตัดงบไว้ของ PO นี้', 400);
        const month = bangkokMonth();
        const mp = `$."${month}"`;
        // ledger row + budget update in ONE batch, both conditional on totalUsed still being exactly the figure the credit was computed from :
        // two concurrent credits read the same totalUsed, only the first passes ; the loser inserts no ledger row (RETURNING comes back empty),
        // changes nothing and gets 409 (reload).
        const creditTxId = `TX-CC-${Date.now()}-${uid()}`;
        const batchRes = await db.batch([
          claimCreditLedgerStmt(db, { id: creditTxId, code, credit, prevUsed: Number(cur.totalUsed || 0), actor: authUser.name || authUser.username, actorUserId: authUser.userId, role: authUser.title || authUser.canonicalRole || authUser.roleKey, guardUsed: Number(cur.totalUsed || 0), docNo: g.ctx.poNumber, transactionId: tid || null, gate: g.ctx }),
          db.prepare(`
            UPDATE budgets SET
              totalUsed = MAX(0, totalUsed - ?),
              totalRemaining = totalRemaining + ?,
              refundCreditsJson = json_set(COALESCE(NULLIF(refundCreditsJson, ''), '{}'), ?, COALESCE(json_extract(COALESCE(NULLIF(refundCreditsJson, ''), '{}'), ?), 0) + ?),
              updatedAt = CURRENT_TIMESTAMP
            WHERE id = ? AND totalUsed = ? AND EXISTS (SELECT 1 FROM budget_transactions WHERE id = ?)
          `).bind(credit, credit, mp, mp, credit, code, Number(cur.totalUsed || 0), creditTxId) // no ledger row (cap / race lost) => no budget change
        ]);
        const won = batchRes && batchRes[0] && Array.isArray(batchRes[0].results) && batchRes[0].results.length > 0;
        if (!won) return errorResponse('ข้อมูลงบประมาณถูกแก้ไขพร้อมกัน กรุณารีเฟรชหน้าแล้วลองอีกครั้ง', 409);
        await audit('BUDGET_REFUND_CREDIT', 'budget', code, { actorUserId: authUser.userId, amount: credit });
        return jsonResponse({ success: true, id: code, applied: true, credited: credit });
      }
      if (method === 'POST' && path === '/api/budgets') {
        const body = await request.json().catch(() => ({}));
        const entries = Array.isArray(body)
          ? body.map(b => [b.department || b.dept || b.id, b])
          : Object.entries(body || {});

        for (const [dept, b] of entries) {
          if (!dept || isWildcardDept(ledgerDeptCode(dept))) continue;
          const bad = await upsertBudgetEntry(db, dept, b);
          if (bad) return errorResponse(bad, 400);
        }
        return jsonResponse({ success: true });
      }
    }

    if (path === '/api/budget-transactions' || path.startsWith('/api/budget-transactions/')) {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        // BudgetView builds allocations / history from the whole ledger held in storage, so the default is "everything", capped at the newest
        // 5000 rows (the bootstrap carries 500). Filters (all optional): ?year=YYYY ?period=YYYY-MM ?department=PD ?limit=N (max 20000).
        const sp = new URL(request.url).searchParams;
        const where = [];
        const binds = [];
        const year = sp.get('year');
        const period = sp.get('period');
        const dept = sp.get('department') || sp.get('dept');
        if (year && /^\d{4}$/.test(year)) { where.push("(COALESCE(period, targetMonth, substr(createdAt, 1, 7)) LIKE ?)"); binds.push(`${year}-%`); }
        if (period && /^\d{4}-\d{2}$/.test(period)) { where.push('(period = ? OR targetMonth = ? OR substr(createdAt, 1, 7) = ?)'); binds.push(period, period, period); }
        // old rows may carry "ฝ่าย PD" : strip that prefix too (TRIM after, since "ฝ่าย PD" has a space)
        if (dept && !isWildcardDept(ledgerDeptCode(dept))) { where.push('TRIM(REPLACE(REPLACE(UPPER(department), ?, ?), ?, ?)) = ?'); binds.push('DEPT-', '', 'ฝ่าย', '', ledgerDeptCode(dept)); }
        const limit = Math.min(Math.max(parseInt(sp.get('limit') || '5000', 10) || 5000, 1), 20000);
        const res = await db.prepare(`SELECT * FROM budget_transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
          .bind(...binds, limit).all().catch(() => ({ results: [] }));
        return jsonResponse(filterLedger(scopeViewer, utcIsoRows(res.results || [])));
      }

      if (method === 'POST') {
        const tx = await request.json().catch(() => ({}));
        // Idempotency Guard (parity gas/Code.gs:3636-3653): ประเภทคืนงบ/ยกเลิก ถ้ามี type + docNo เดิมอยู่แล้ว ไม่เขียนซ้ำ
        const IDEMPOTENT_TYPES = ['PR_CANCEL_RELEASE', 'PO_CANCEL_RELEASE', 'BUDGET_ROLLBACK', 'CLAIM_REFUND'];
        const txTypeUpper = String((tx && tx.type) || '').toUpperCase();
        const txDocRef = String((tx && (tx.docRef || tx.docNo || tx.referenceDoc)) || '').trim();
        // Types the server owns: PO_COMMITMENT / REFUND_SETTLEMENT are never accepted from a client (settle writes REFUND_SETTLEMENT itself).
        // PR_COMMITMENT is written by the client on approval (workflowEngine.js:1710) so it is accepted ONLY when it matches a real PR:
        // docNo = an existing PR (REVIEWED or later - the ledger POST can arrive just before the PR PUT), |amount| <= the PR total, once per PR.
        const txActionUpper = String((tx && (tx.actionType || tx.type)) || '').toUpperCase().trim();
        const kinds = [txTypeUpper.trim(), txActionUpper];
        if (kinds.some((k) => k === 'PO_COMMITMENT')) return errorResponse(FORBIDDEN_MSG, 403);
        // REFUND_SETTLEMENT rows are written only by the server (settle, and the claim credit of PUT /api/budgets/:dept as CLAIM_CREDIT).
        // creditDepartmentBudget posts its own REFUND_SETTLEMENT row right after the PUT and rolls the credit back locally if that POST fails,
        // so it is acknowledged (200, duplicate, nothing stored) exactly like PR_COMMITMENT below - never a 403.
        if (kinds.some((k) => k === 'REFUND_SETTLEMENT')) {
          // The PUT body carries no PO number, so the CLAIM_CREDIT row the server wrote for this refund has no reference yet. The client's row
          // (docNo + transactionId = creditDepartmentBudget's idempotency key) names it : copy ONLY those labels onto the caller's own most
          // recent unlabelled CLAIM_CREDIT row of that department/amount (last 10 min). Nothing else of the body is stored. This keeps the
          // client's idempotency check (budgetService.js:488 : transactionId / docNo + amount) working after a bootstrap replaced its local ledger.
          const refDoc = str100(tx && (tx.docNo || tx.poNumber || tx.referenceDoc));
          const refTid = str100(tx && (tx.transactionId || tx.idempotencyKey), 200);
          const refAmt = Math.abs(Number(tx && (tx.refundAmount ?? tx.creditAmount ?? tx.amount)));
          const refDept = ledgerDeptCode(tx && (tx.dept || tx.department));
          // labelled only when the referenced PO really exists in the same department ; matched by user id (actorUserId), not by display name
          if (refDoc && refAmt > 0 && refDept) {
            await db.prepare(`
              UPDATE budget_transactions SET docNo = ?, poNumber = ?, docType = 'PO', transactionId = ?
              WHERE id = (SELECT id FROM budget_transactions WHERE actionType = 'CLAIM_CREDIT' AND docNo IS NULL AND dept = ? AND ABS(amount) = ?
                            AND actorUserId = ? AND createdAt >= ?
                            AND EXISTS (SELECT 1 FROM pos WHERE (poNumber = ? OR id = ?) AND UPPER(REPLACE(department, 'DEPT-', '')) = ?)
                          ORDER BY rowid DESC LIMIT 1)
            `).bind(refDoc, refDoc, refTid || null, refDept, refAmt, authUser.userId, new Date(Date.now() - 10 * 60 * 1000).toISOString(), refDoc, refDoc, refDept).run().catch(() => {});
          }
          return jsonResponse({ success: true, duplicate: true, serverManaged: true, transaction: tx });
        }
        // PR_COMMITMENT is server-written (writePrCommitment, when the PR is approved) : the client's own row is acknowledged but never stored
        // (answer 200/duplicate so the client does not break ; its order "ledger POST first, PR PUT second" therefore does not matter)
        const isPrCommit = kinds.some((k) => k === 'PR_COMMITMENT');
        if (isPrCommit) return jsonResponse({ success: true, duplicate: true, serverManaged: true, transaction: tx });
        // T5.3b: who may put what into the ledger. Budget writers (BUDGET_WRITE) are unrestricted as before. Everybody else may only post the
        // record types the client really sends (budgetService.logBudgetTransaction from workflowEngine : PR_RELEASE, ACTUAL_SPEND, PO_CANCEL_REFUND ;
        // the GAS-side names PR_CANCEL_RELEASE / PO_CANCEL_RELEASE / CLAIM_REFUND), for a department they can reach. Allocation types (MONTHLY_ALLOCATION,
        // TOP_UP, SET_BUDGET, *ADJUSTMENT*) need the budget permission. BUDGET_ROLLBACK / TOP_UP rows are what the refund cap adds up, and the server
        // writes them itself (adjust / PUT credit / settle) : a client copy from a non-writer is acknowledged and NOT stored, so nobody can
        // pre-fill another PO's cap with rows of his own.
        // department of the row : dept and department are each normalised (ledgerDeptCode). A value that was SENT but is empty after
        // normalising ("ฝ่าย", " ") is refused, two values that differ are refused, and the one code is stored in BOTH columns.
        const sent = (v) => v !== undefined && v !== null && v !== '';
        const sentDepts = [tx && tx.dept, tx && tx.department].filter(sent).map(ledgerDeptCode);
        if (sentDepts.some((d) => !d) || new Set(sentDepts).size > 1) {
          return canWriteBudget(resolvePermissions(authUser)) ? errorResponse('แผนกในรายการบัญชีงบไม่ถูกต้อง', 400) : errorResponse(FORBIDDEN_MSG, 403);
        }
        const ledgerCode = sentDepts[0] || '';
        if (!canWriteBudget(resolvePermissions(authUser))) {
          if (kinds.some((k) => k === 'BUDGET_ROLLBACK' || k === 'TOP_UP')) return jsonResponse({ success: true, duplicate: true, serverManaged: true, transaction: tx });
          if (!LEDGER_TYPES_FOR_STAFF.has(txTypeUpper.trim()) || !kinds.every((k) => !k || LEDGER_TYPES_FOR_STAFF.has(k))) return errorResponse(FORBIDDEN_MSG, 403);
          // BOTH columns are stored (dept and department) : each one that is sent must be reachable and they must name the same department,
          // otherwise a request could be checked on `dept` and recorded under another `department`
          if (!ledgerCode || isWildcardDept(ledgerCode) || !canAccessDepartment(authUser, ledgerCode)) return errorResponse(FORBIDDEN_MSG, 403);
        }
        // Ledger is append-only: an existing id is never modified (answer duplicate)
        if (tx && tx.id) {
          const sameId = await db.prepare('SELECT * FROM budget_transactions WHERE id = ? LIMIT 1').bind(String(tx.id)).first().catch(() => null);
          if (sameId) return jsonResponse({ success: true, duplicate: true, transaction: sameId });
        }
        const guardDoc = (tx && tx.id && IDEMPOTENT_TYPES.includes(txTypeUpper)) ? txDocRef : '';
        if (tx && tx.id) {
          // actor/actorRole come from the verified token, never from the request body
          const ledgerActor = authUser.name || authUser.username || 'Staff';
          const ledgerActorRole = authUser.title || authUser.canonicalRole || authUser.roleKey || null;
          // single atomic statement: insert only when no same type+docNo row exists (idempotency guard, parity Code.gs:3636-3653)
          await db.prepare(`
            INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date,
              refundAmount, creditAmount, docType, docNo, poNumber, transactionId, actorRole)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT (? != '' AND EXISTS (SELECT 1 FROM budget_transactions WHERE UPPER(type) = ? AND docNo = ?))
            ON CONFLICT(id) DO NOTHING
          `).bind(
            String(tx.id),
            ledgerCode || 'PD', // ONE code for both columns ("ฝ่าย PD" -> "PD") ; 'PD' only when the caller sent neither (writers' old default)
            ledgerCode || 'PD',
            tx.type || 'MONTHLY_ALLOCATION',
            tx.actionType || tx.type || 'MONTHLY_ALLOCATION',
            tx.typeLabel || 'จัดสรรงบประมาณประจำเดือน',
            finiteOr0(tx.amount),
            finiteOr0(tx.delta),
            finiteOr0(tx.previousAmount),
            finiteOr0(tx.newAmount),
            tx.isAllocation ? 1 : 0,
            ledgerActor,
            tx.note || tx.remark || '',
            tx.targetMonth || tx.period || '',
            tx.period || tx.targetMonth || '',
            new Date().toISOString(), // server time (client budgetService always stamps "now" ; no back-dated flow exists)
            new Date().toISOString(),
            optNum(tx.refundAmount),
            optNum(tx.creditAmount),
            tx.docType || null,
            txDocRef || null,
            tx.poNumber || null,
            tx.transactionId || tx.idempotencyKey || null,
            ledgerActorRole,
            guardDoc, txTypeUpper, guardDoc
          ).run().catch(() => {});
          if (guardDoc) {
            const first = await db.prepare('SELECT * FROM budget_transactions WHERE UPPER(type) = ? AND docNo = ? ORDER BY rowid LIMIT 1').bind(txTypeUpper, guardDoc).first().catch(() => null);
            if (first && first.id !== String(tx.id)) return jsonResponse({ success: true, duplicate: true, transaction: first });
          }
          await audit('BUDGET_TX', 'budget_transaction', tx.id, { actorUserId: authUser.userId, type: txTypeUpper, docNo: txDocRef });
        }
        return jsonResponse({ success: true, transaction: tx });
      }
    }

    // ── 11. Health & Status Check (/api/health) ──
    if (path === '/api/health') {
      return jsonResponse({
        status: 'UP',
        platform: 'Cloudflare Pages Functions + D1',
        d1Connected: Boolean(db),
        time: new Date().toISOString()
      });
    }

    // Fallback : nothing above handled this request. Never a silent 200 (the client would believe the write succeeded).
    // Table of served routes + the 404/405 rule : functions/_lib/routes.js
    const miss = classifyUnhandled(method, path);
    if (miss.status === 405) {
      return new Response(JSON.stringify({ error: 'ไม่รองรับ method นี้กับเส้นทางนี้', success: false, path, method }), {
        status: 405,
        headers: { ...corsHeaders, Allow: miss.allow.join(', ') }
      });
    }
    return new Response(JSON.stringify({ error: 'ไม่พบเส้นทาง API', success: false, path, method }), { status: 404, headers: corsHeaders });

  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.message, err.status);
    console.error('[api] unhandled error:', err && err.message);
    return errorResponse('Internal error', 500);
  }
}
