// Which stored documents really HOLD a Drive file, and may this user use it. Shared by the write side (sanitize.js : fileIdAllowed) and the read side
// (files.js : GET /api/files/:id) so both apply the same rule. Not a route (folder starts with "_").
//
// "Holds" = the id sits in a real FILE position of the document (sanitize.fileIdsIn - the same positions the write side verifies with
// allowedFileIds). An id typed into free text never counts. The answer comes from the file_refs index (migration 0011), which is rebuilt for a
// document whenever it is saved (reindexDoc) ; every hit is re-checked against the stored document, so a stale row grants nothing.
// Documents saved before the index existed are found by a bounded, throttled instr() scan (candidates only - nothing is granted by instr) and then
// indexed (self-healing).

import { fileIdsIn, fileRefOf } from './sanitize.js';
import { buildViewer, canSeeDocument } from './scope.js';
import { canAccessDepartment } from './rbac.js';

const PAGE = 50;
const SCAN_PAGES = 3;               // fallback scan : at most 150 candidate rows per table
const ORPHAN_SCAN_PAGES = 200;      // orphan check : up to 10 000 candidate rows per table (beyond that = treated as held)
const SCAN_THROTTLE_MS = 60 * 1000; // ... and at most once a minute per file id (per isolate)
export const MAX_REFS_PER_DOC = 200;
const MAX_TOUCHED_DOCS = 200;       // documents reindexed after one request
const COLS = {
  prs: [['itemsJson', 'items'], ['attachmentsJson', 'attachments'], ['extraJson', '']],
  pos: [['itemsJson', 'items'], ['evidenceJson', ''], ['extraJson', '']]
};
const ITEM_JSON_COLS = [['images', 'images'], ['attachments', 'attachments']];
const ITEM_PLAIN_COLS = ['imageUrl', 'driveUrl', 'fileId'];

function parseObj(s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
/** the document as the list endpoints show it to scope.js (extraJson merged under the columns ; requestedBy falls back to requesterName) */
export function docView(row, table) {
  const view = { ...parseObj(row.extraJson), ...row };
  if (!view.requestedBy) view.requestedBy = row.requesterName || '';
  if (table) Object.defineProperty(view, '_table', { value: table, enumerable: false });
  return view;
}

/** every Drive id a stored document holds as a file. itemRows : pr_items rows of a PR (imported line items). */
export function docFileIds(table, row, itemRows = []) {
  const out = new Set();
  for (const [col, hint] of COLS[table] || []) {
    if (typeof row[col] === 'string' && row[col]) for (const id of fileIdsIn(row[col], hint)) out.add(id);
  }
  for (const it of itemRows) {
    for (const [col, hint] of ITEM_JSON_COLS) if (typeof it[col] === 'string' && it[col]) for (const id of fileIdsIn(it[col], hint)) out.add(id);
    for (const col of ITEM_PLAIN_COLS) { const id = fileRefOf(it[col]); if (id) out.add(id); }
  }
  return out;
}

/**
 * Drive ids that the stored PR / PO named by `keys` (document id or number) ALREADY hold as files, limited to documents the caller may use.
 * The write side treats these as allowed without any scan : a document that holds a file keeps it when it is saved again (legacy / imported /
 * not yet indexed files must not be lost by a re-save). Never throws (database error = nothing granted).
 */
export async function fileIdsHeldByDocs(db, authUser, keys) {
  const held = new Set();
  const viewer = buildViewer(authUser);
  for (const key of [...new Set(keys)].slice(0, 60)) {
    for (const table of ['prs', 'pos']) {
      try {
        const no = table === 'prs' ? 'prNumber' : 'poNumber';
        const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? OR ${no} = ? ORDER BY (id = ?) DESC LIMIT 1`).bind(key, key, key).first();
        if (!row || !mayUseDoc(authUser, viewer, docView(row, table))) continue;
        for (const id of docFileIds(table, row, table === 'prs' ? await itemRowsOf(db, row.id) : [])) held.add(id);
      } catch { /* nothing granted */ }
    }
  }
  return held;
}

async function itemRowsOf(db, prId) {
  try { return ((await db.prepare('SELECT images, attachments, imageUrl, driveUrl, fileId FROM pr_items WHERE prId = ?').bind(prId).all()).results) || []; } catch { return []; }
}

/**
 * Rebuild the index rows of one saved document ; a PR also binds the saver's still unbound uploads it now holds to its number
 * (attachments.docRef is '' for a file attached while the PR was being created). Never throws.
 */
export async function reindexDoc(db, table, row, saverUserId) {
  try {
    const items = table === 'prs' ? await itemRowsOf(db, row.id) : [];
    const ids = [...docFileIds(table, row, items)].slice(0, MAX_REFS_PER_DOC);
    const no = table === 'prs' ? row.prNumber : row.poNumber;
    const stmts = [db.prepare('DELETE FROM file_refs WHERE docTable = ? AND docId = ?').bind(table, row.id)];
    for (const id of ids) stmts.push(db.prepare('INSERT OR IGNORE INTO file_refs (fileId, docTable, docId, docNo) VALUES (?, ?, ?, ?)').bind(id, table, row.id, no || null));
    await db.batch(stmts);
    if (table === 'prs' && saverUserId && no && ids.length) {
      // only the saver's own uploads, only files this document holds, only rows with no document yet
      const marks = ids.map(() => '?').join(',');
      await db.prepare(`UPDATE attachments SET docRef = ?, docNo = ? WHERE uploaderId = ? AND COALESCE(docRef, '') = '' AND COALESCE(docGone, 0) = 0 AND fileId IN (${marks})`)
        .bind(no, no, saverUserId, ...ids).run();
    }
  } catch (e) {
    console.error('[file_refs] reindex failed:', e && e.message);
  }
}

/**
 * after a PR / PO write : reindex exactly the documents that request really wrote (the route handlers record their ids in state.touched =
 * { prs: Set<id>, pos: Set<id> }) - no scan of "recently updated" rows, so another user's concurrent save is never touched and only a PR the
 * saver wrote in THIS request gets his unbound uploads bound to its number. Never throws.
 */
export async function reindexTouched(db, touched, saverUserId) {
  if (!db || !touched) return;
  for (const table of ['prs', 'pos']) {
    const ids = [...(touched[table] || [])].slice(0, MAX_TOUCHED_DOCS);
    for (const id of ids) {
      let row = null;
      try { row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(); } catch { row = null; }
      if (row) await reindexDoc(db, table, row, saverUserId);
    }
  }
}

/** a PR was deleted : drop its index rows and mark its attachments (the Drive files stay). Never throws. */
export async function markDocGone(db, table, row) {
  try {
    await db.prepare('DELETE FROM file_refs WHERE docTable = ? AND docId = ?').bind(table, row.id).run();
    if (table === 'prs' && row.prNumber) {
      await db.prepare('UPDATE attachments SET docGone = 1 WHERE docRef = ? OR docNo = ?').bind(row.prNumber, row.prNumber).run();
    }
  } catch (e) {
    console.error('[file_refs] markDocGone failed:', e && e.message);
  }
}

async function loadDocs(db, hits) {
  const docs = [];
  for (const h of hits) {
    if (h.docTable !== 'prs' && h.docTable !== 'pos') continue;
    const row = await db.prepare(`SELECT * FROM ${h.docTable} WHERE id = ?`).bind(h.docId).first().catch(() => null);
    if (row) docs.push({ table: h.docTable, row });
  }
  return docs;
}

const lastScan = new Map(); // fileId -> ms of the last fallback scan
export function _resetScanThrottle() { lastScan.clear(); }

async function scanCandidates(db, sql, id, pages = SCAN_PAGES, state = null) {
  const rows = [];
  let last = -1;
  for (let page = 0; page < pages; page++) {
    const res = ((await db.prepare(sql).bind(id, last).all()).results) || [];
    for (const r of res) { rows.push(r); last = Math.max(last, Number(r._rid)); }
    if (res.length < PAGE) return rows;
  }
  if (state) state.truncated = true; // more candidate rows may exist beyond the page limit
  return rows;
}

async function scanHolders(db, id, pages = SCAN_PAGES, state = null) {
  const found = [];
  const prs = await scanCandidates(db, `SELECT rowid AS _rid, * FROM prs WHERE instr(COALESCE(itemsJson,'') || COALESCE(attachmentsJson,'') || COALESCE(extraJson,''), ?) > 0 AND rowid > ? ORDER BY rowid LIMIT ${PAGE}`, id, pages, state);
  for (const r of prs) if (docFileIds('prs', r, await itemRowsOf(db, r.id)).has(id)) found.push({ table: 'prs', row: r });
  const pos = await scanCandidates(db, `SELECT rowid AS _rid, * FROM pos WHERE instr(COALESCE(itemsJson,'') || COALESCE(evidenceJson,'') || COALESCE(extraJson,''), ?) > 0 AND rowid > ? ORDER BY rowid LIMIT ${PAGE}`, id, pages, state);
  for (const r of pos) if (docFileIds('pos', r).has(id)) found.push({ table: 'pos', row: r });
  // imported line items live in pr_items : their PR holds them
  const items = await scanCandidates(db, `SELECT i.rowid AS _rid, p.id AS _pid FROM pr_items i JOIN prs p ON p.id = i.prId
    WHERE instr(COALESCE(i.images,'') || COALESCE(i.attachments,'') || COALESCE(i.imageUrl,'') || COALESCE(i.fileId,'') || COALESCE(i.driveUrl,''), ?) > 0 AND i.rowid > ? ORDER BY i.rowid LIMIT ${PAGE}`, id, pages, state);
  const seen = new Set(found.filter((f) => f.table === 'prs').map((f) => f.row.id));
  for (const it of items) {
    if (seen.has(it._pid)) continue;
    const row = await db.prepare('SELECT * FROM prs WHERE id = ?').bind(it._pid).first().catch(() => null);
    if (row && docFileIds('prs', row, await itemRowsOf(db, row.id)).has(id)) { found.push({ table: 'prs', row }); seen.add(row.id); }
  }
  return found;
}

/**
 * Does ANY stored PR / PO / PR line item hold `id` as a file ? For the orphan cleanup : an index miss is not enough, so the whole tables are scanned
 * (not throttled, many pages). Anything uncertain counts as HELD (database error, scan too large for the page limit) - never "orphan".
 */
export async function fileHeldByAnyDoc(db, id) {
  try {
    const hits = ((await db.prepare('SELECT docTable, docId FROM file_refs WHERE fileId = ? LIMIT 50').bind(id).all()).results) || [];
    for (const d of await loadDocs(db, hits)) {
      const items = d.table === 'prs' ? await itemRowsOf(db, d.row.id) : [];
      if (docFileIds(d.table, d.row, items).has(id)) return true;
    }
    const state = { truncated: false };
    const found = await scanHolders(db, id, ORPHAN_SCAN_PAGES, state);
    return found.length > 0 || state.truncated;
  } catch {
    return true;
  }
}

/**
 * -> document views (prs / pos) that hold `id` as a file (view._table = 'prs' | 'pos')
 * opts.scanGate : async () => boolean, asked right before the fallback scan ; false = the scan is NOT run (write side quota, see sanitize.js)
 */
export async function findDocsHoldingFile(db, id, accept = () => true, opts = {}) {
  let hits = [];
  try { hits = ((await db.prepare('SELECT docTable, docId FROM file_refs WHERE fileId = ? LIMIT 50').bind(id).all()).results) || []; } catch { hits = []; }
  const verified = [];
  for (const d of await loadDocs(db, hits)) {
    const items = d.table === 'prs' ? await itemRowsOf(db, d.row.id) : [];
    if (docFileIds(d.table, d.row, items).has(id)) verified.push(d);
    else await db.prepare('DELETE FROM file_refs WHERE fileId = ? AND docTable = ? AND docId = ?').bind(id, d.table, d.row.id).run().catch(() => {}); // stale row
  }
  if (!verified.some((d) => accept(docView(d.row, d.table)))) {
    // nothing indexed lets the caller in (saved before migration 0011, or imported, or only partly indexed) : bounded + throttled scan, then index
    // what really holds the file
    const now = Date.now();
    if (!(lastScan.get(id) > now - SCAN_THROTTLE_MS) && (!opts.scanGate || await opts.scanGate())) {
      lastScan.set(id, now);
      if (lastScan.size > 5000) lastScan.clear();
      for (const d of await scanHolders(db, id)) {
        if (verified.some((v) => v.table === d.table && v.row.id === d.row.id)) continue;
        verified.push(d);
        await db.prepare('INSERT OR IGNORE INTO file_refs (fileId, docTable, docId, docNo) VALUES (?, ?, ?, ?)')
          .bind(id, d.table, d.row.id, (d.table === 'prs' ? d.row.prNumber : d.row.poNumber) || null).run().catch(() => {});
      }
    }
  }
  return verified.map((d) => docView(d.row, d.table));
}

/** write rule (canAccessDepartment) OR read rule (scope.canSeeDocument) : whoever may do either with the document may use the file it holds */
export function mayUseDoc(authUser, viewer, doc) {
  return canSeeDocument(viewer, doc) || canAccessDepartment(authUser, doc.department);
}

export async function userMayUseFileViaDocs(db, authUser, id, opts = {}) {
  const viewer = buildViewer(authUser);
  const accept = (d) => mayUseDoc(authUser, viewer, d);
  return (await findDocsHoldingFile(db, id, accept, opts)).some(accept);
}

// ── one access rule for an id's attachments rows : GET /api/files/:id (files.js) and the write-side file field check (sanitize.js) ──
// The table is decided by the row's category and the reference is matched the way upload.js stored it : a PR attachment's docRef is always the PR
// NUMBER (the server issues PR numbers), PO / GRN / CLAIM use the PO number (or id, as upload.js findPo resolves it).
export async function findDocByRef(db, ref, isPr) {
  const row = isPr
    ? await db.prepare('SELECT * FROM prs WHERE prNumber = ? LIMIT 1').bind(ref).first().catch(() => null)
    : await db.prepare('SELECT * FROM pos WHERE poNumber = ? OR id = ? ORDER BY (poNumber = ?) DESC LIMIT 1').bind(ref, ref, ref).first().catch(() => null);
  return row ? docView(row, isPr ? 'prs' : 'pos') : null;
}

// a PO that was made from the PR keeps showing the PR's files (prAttachments) : whoever may use THAT PO may open them - the PO must really hold the
// file in a file position and must name this very PR (prNumber / prId), so an unrelated document holding the id gives nothing.
// prDoc may be just { prNumber, id } (the PR itself was deleted : only its number is left in the attachments row).
export async function poOfThisPrHoldsFile(db, authUser, viewer, prDoc, fileId, opts = {}) {
  const accept = (d) => d._table === 'pos'
    && ((d.prNumber && d.prNumber === prDoc.prNumber) || (d.prId && (d.prId === prDoc.id || d.prId === prDoc.prNumber)))
    && mayUseDoc(authUser, viewer, d);
  return (await findDocsHoldingFile(db, fileId, accept, opts)).some(accept);
}

/**
 * -> the attachments row (of `atts`, all rows of one file id) the caller may use, or null.
 * A row that points at a document is decided by that document only (missing document = nobody) ; a deleted PR (docGone) is decided by a PO that was
 * made from it and holds the file. Rows without a document (and, when opts.noRowsFallback, an id with no row at all) fall back to a stored document
 * that really holds the id in a file position. opts.uploaderAlways / opts.admin : write-side extras. opts.scanGate : see findDocsHoldingFile.
 */
export async function attachmentRowAccess(db, authUser, fileId, atts, opts = {}) {
  const viewer = buildViewer(authUser);
  let unbound = false;
  for (const a of atts) {
    if (Number(a.docGone) === 2) continue; // orphan cleanup moved the Drive file to the trash : nobody
    if (opts.uploaderAlways && a.uploaderId && a.uploaderId === authUser.userId) return a;
    if (opts.admin) return a;
    const refs = [...new Set([a.docRef, a.poNumber, a.docNo].map((r) => String(r || '').trim()).filter(Boolean))];
    const isPr = String(a.category || '').toUpperCase() === 'PR';
    if (!refs.length) {
      unbound = true; // no document yet : uploader, or a stored document that really holds the file (below)
      if (a.uploaderId && a.uploaderId === authUser.userId) return a;
      continue;
    }
    if (Number(a.docGone) === 1) {
      // the PR is gone : only a PO made from it (names this PR number) that holds the file and that the caller may use
      if (isPr) for (const ref of refs) if (await poOfThisPrHoldsFile(db, authUser, viewer, { prNumber: ref, id: ref }, fileId, opts)) return a;
      continue;
    }
    for (const ref of refs) {
      const doc = await findDocByRef(db, ref, isPr);
      if (!doc) continue;
      if (mayUseDoc(authUser, viewer, doc)) return a;
      if (isPr && await poOfThisPrHoldsFile(db, authUser, viewer, doc, fileId, opts)) return a;
    }
  }
  if (!unbound && !(opts.noRowsFallback && atts.length === 0)) return null;
  return (await userMayUseFileViaDocs(db, authUser, fileId, opts)) ? (atts[0] || { fileId }) : null;
}
