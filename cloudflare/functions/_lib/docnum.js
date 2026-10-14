// Server-side document numbers (T3.3). Not a route (folder starts with "_").
// Formats are the ones of gas/SheetService.gs generateSequentialDocId (:735-779) :
//   PR  `${DEPT}${NNN}/${YYYY}`            e.g. PD001/2026
//   PO  `PO-${DEPT}-${YYYY}-${NNN}`        e.g. PO-PD-2026-001
//   GRN `GRN-${poNo}-${NN}` (round)        src/services/warehouseService.js generateGRNNumber
// The counter is the D1 table doc_counters (PK dept, docType, year) - the GAS "PRCounters" sheet bug (row looked up by dept only) is NOT copied.
// Year = current year in Asia/Bangkok (gas/appsscript.json timeZone), never a constant.

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function bangkokYear(now = Date.now()) {
  return new Date(Number(now) + BANGKOK_OFFSET_MS).getUTCFullYear();
}

// current budget month 'YYYY-MM' in Asia/Bangkok (mock server budgetRoutes.js: targetMonth || current month)
export function bangkokMonth(now = Date.now()) {
  const d = new Date(Number(now) + BANGKOK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// what exists today, per type: table/column used to avoid handing out a number that is already taken
// (the client still makes its own numbers, so the server counter must never collide with them)
const TYPES = {
  PR: { table: 'prs', col: 'prNumber', like: (d, y) => `${d}%/${y}`, re: (d, y) => new RegExp(`^${escapeRe(d)}(\\d+)/${y}$`) },
  PO: { table: 'pos', col: 'poNumber', like: (d, y) => `PO-${d}-${y}-%`, re: (d, y) => new RegExp(`^PO-${escapeRe(d)}-${y}-(\\d+)$`) }
};

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeLike(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }

export function cleanDept(dept) {
  return String(dept || 'ALL').toUpperCase().trim() || 'ALL';
}

export function formatDocNumber(docType, dept, year, seq) {
  const type = String(docType || 'PO').toUpperCase().trim();
  const d = cleanDept(dept);
  const nnn = String(seq).padStart(3, '0'); // > 999 simply grows to 4 digits, like GAS
  if (type === 'PO') return `PO-${d}-${year}-${nnn}`;
  if (type === 'PR') return `${d}${nnn}/${year}`;
  return `${type}-${d}-${year}-${nnn}`;
}

export function formatGrnNumber(poNo, round = 1) {
  const clean = String(poNo || '').trim();
  if (!clean) return `GRN-${Date.now()}-01`;
  return `GRN-${clean}-${String(Math.max(1, Math.floor(Number(round)) || 1)).padStart(2, '0')}`;
}

// highest sequence already used in the document table for (type, dept, year) ; 0 when none
async function maxExistingSeq(db, type, dept, year) {
  const t = TYPES[type];
  if (!t) return 0;
  const res = await db.prepare(`SELECT ${t.col} AS no FROM ${t.table} WHERE ${t.col} LIKE ? ESCAPE '\\'`)
    .bind(t.like(escapeLike(dept), year)).all().catch(() => ({ results: [] }));
  const re = t.re(dept, year);
  let max = 0;
  for (const r of (res && res.results) || []) {
    const m = re.exec(String(r.no || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

async function raiseCounter(db, type, dept, year, floor, nowIso) {
  if (!(floor > 0)) return;
  await db.prepare('UPDATE doc_counters SET lastNumber = MAX(lastNumber, ?), updatedAt = ? WHERE dept = ? AND docType = ? AND year = ?')
    .bind(floor, nowIso, dept, type, year).run();
}

// Atomically hand out the next number. The increment is ONE statement (UPDATE ... RETURNING), so concurrent requests never get the same
// sequence ; the loop only handles the case where a document with that exact number already exists (made by the client) :
// the counter is then raised to the highest existing number and the next one is taken.
export async function issueDocNumber(db, { docType, dept, now = Date.now() }) {
  const type = String(docType || 'PO').toUpperCase().trim();
  const d = cleanDept(dept);
  const year = bangkokYear(now);
  const nowIso = new Date(Number(now)).toISOString();
  const t = TYPES[type];

  // first use of (dept, type, year): create the counter row, starting after whatever the client already numbered
  const has = await db.prepare('SELECT lastNumber FROM doc_counters WHERE dept = ? AND docType = ? AND year = ?').bind(d, type, year).first();
  if (!has) {
    await db.prepare('INSERT INTO doc_counters (dept, docType, year, lastNumber, prefix, updatedAt) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(dept, docType, year) DO NOTHING')
      .bind(d, type, year, type, nowIso).run();
    await raiseCounter(db, type, d, year, await maxExistingSeq(db, type, d, year), nowIso);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await db.prepare('UPDATE doc_counters SET lastNumber = lastNumber + 1, updatedAt = ? WHERE dept = ? AND docType = ? AND year = ? RETURNING lastNumber')
      .bind(nowIso, d, type, year).first();
    if (!row) throw new Error('DOC_COUNTER_MISSING');
    const seq = Number(row.lastNumber);
    const docNo = formatDocNumber(type, d, year, seq);
    if (!t) return { docNo, seq, year, dept: d, docType: type };
    const taken = await db.prepare(`SELECT 1 AS x FROM ${t.table} WHERE ${t.col} = ? OR id = ? LIMIT 1`).bind(docNo, docNo).first().catch(() => null);
    if (!taken) return { docNo, seq, year, dept: d, docType: type };
    await raiseCounter(db, type, d, year, await maxExistingSeq(db, type, d, year), nowIso);
  }
  throw new Error('DOC_NUMBER_EXHAUSTED');
}

// GRN: `GRN-${poNo}-${NN}` where NN is the receiving round of that PO (warehouseService.generateGRNNumber).
// Rounds already used = distinct GRN numbers in stock_logs for the PO + receive entries in the PO timeline ; the next free round is returned.
export async function issueGrnNumber(db, { poNo, usedNumbers = [], round } = {}) {
  const used = new Set((usedNumbers || []).map((s) => String(s)));
  const clean = String(poNo || '').trim();
  if (clean) {
    const res = await db.prepare("SELECT DISTINCT docNo FROM stock_logs WHERE poNo = ? AND docType = 'GRN' AND docNo IS NOT NULL").bind(clean).all().catch(() => ({ results: [] }));
    for (const r of (res && res.results) || []) used.add(String(r.docNo));
  }
  let n = Number.isFinite(Number(round)) && Number(round) >= 1 ? Math.floor(Number(round)) : used.size + 1;
  for (let i = 0; i < 1000; i++, n++) {
    const no = formatGrnNumber(clean, n);
    if (!used.has(no)) return no;
  }
  throw new Error('GRN_NUMBER_EXHAUSTED');
}
