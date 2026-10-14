#!/usr/bin/env node
/**
 * migrate-files.js : plan for moving attachment files between storage backends (docs/requirements-file-storage.md section 6).
 *
 *   node scripts/migrate-files.js --from r2 --to drive --dry-run --db <local.sqlite> [--limit N] [--doc <docRef>]
 *
 * THIS ROUND = DRY RUN ONLY, READ ONLY :
 *   - reads a LOCAL sqlite file (wrangler local D1 or a copy built from `wrangler d1 export` that the USER ran) opened read-only ; never connects to
 *     Cloudflare / Google, never reads .env / .dev.vars, never writes anything (no R2 call, no Drive call, no SQL executed that changes data)
 *   - prints : number of files, total size, time estimate, per category, and the documents (prs / pos) whose JSON embeds the file ids that a real
 *     move would have to rewrite (found with the same rule as the API : functions/_lib/filerefs.js docFileIds -> sanitize.fileIdsIn)
 *   - without --dry-run it refuses : "ยังไม่รองรับ" (the real move is the TODO below)
 *
 * TODO (next round, needs a Google Workspace Shared Drive + Service Account as Content manager) - interface, spec section 6.2 :
 *   migrateBatch({ rows (<= 20 attachments WHERE storage='r2'), r2 (adapter of storage/r2.js), drive (adapter of storage/drive-adapter.js), db })
 *     per row : r2.open(ref) -> drive.put({ name, mimeType, bytes, category, docRef, uploaderId, date }) (same category / docRef / date folders)
 *       -> verify size + sha256 -> ONE statement : UPDATE attachments SET storage='drive', fileId=<drive id>, objectKey=NULL, migratedFrom='r2:<key>' ...
 *       -> rewrite the fileId inside the documents listed by the dry run (prs / pos JSON + file_refs) -> audit_logs row
 *       -> keep the R2 object 30 days (trash/ prefix), never delete at once ; idempotent (a row already 'drive' is skipped) ;
 *     and the reverse direction (--from drive --to r2) for rollback via migratedFrom.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { computeRefs } from './backfill-file-refs.js';

export const NOT_SUPPORTED_MSG = 'ยังไม่รองรับ : การย้ายไฟล์จริงยังไม่ถูกเขียน (รันได้เฉพาะ --dry-run แบบอ่านอย่างเดียว) ; ดู docs/requirements-file-storage.md ข้อ 6';
export const BATCH_SIZE = 20; // rows per batch of the future real move
// rough estimate for a Workers-side copy R2 -> Drive : fixed cost per file (open + create folder path + verify) + transfer at ~1.5 MB/s
const SECONDS_PER_FILE = 1.5;
const BYTES_PER_SECOND = 1.5 * 1024 * 1024;

/** @returns {object} { from, to, dryRun, db, limit, doc, help } ; throws on unknown arguments */
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--from') a.from = argv[++i];
    else if (t === '--to') a.to = argv[++i];
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--db') a.db = argv[++i];
    else if (t === '--limit') a.limit = argv[++i];
    else if (t === '--doc') a.doc = argv[++i];
    else if (t === '-h' || t === '--help') a.help = true;
    else throw new Error(`อาร์กิวเมนต์ไม่รู้จัก: ${t}`);
  }
  return a;
}

/** Read-only plan. -> { files, totalBytes, estimatedSeconds, batches, byCategory, skippedWithoutKey, documents: [{ docTable, docId, docNo, fileIds }] } */
export function dryRun({ db, from = 'r2', to = 'drive', limit, doc }) {
  if (from !== 'r2' || to !== 'drive') throw new Error(NOT_SUPPORTED_MSG);
  if (!db || !/\.(sqlite3?|db)$/i.test(db) || !fs.existsSync(db) || !fs.statSync(db).isFile()) {
    throw new Error('ต้องระบุ --db เป็นไฟล์ sqlite (.sqlite/.sqlite3/.db) บนเครื่องที่มีอยู่จริง (local D1 หรือสำเนาจาก export) — สคริปต์นี้ไม่ต่อ remote');
  }
  let max = Infinity;
  if (limit !== undefined) {
    max = Number(limit);
    if (!Number.isInteger(max) || max < 1) throw new Error('--limit ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const sdb = new DatabaseSync(db, { readOnly: true });
  try {
    const cols = sdb.prepare("SELECT name FROM pragma_table_info('attachments')").all().map((c) => c.name);
    if (!cols.includes('storage') || !cols.includes('objectKey')) throw new Error('ฐานนี้ยังไม่มีคอลัมน์ storage / objectKey — ต้อง apply migration 0013 ก่อน');
    const where = doc ? "WHERE storage = 'r2' AND (docRef = ? OR poNumber = ? OR docNo = ?)" : "WHERE storage = 'r2'";
    const args = doc ? [doc, doc, doc] : [];
    const all = sdb.prepare(`SELECT id, fileId, fileName, mimeType, fileSize, category, docRef, objectKey FROM attachments ${where} ORDER BY createdAtMs, id`).all(...args);
    const rows = all.slice(0, max);
    const usable = rows.filter((r) => typeof r.objectKey === 'string' && r.objectKey.trim());
    const totalBytes = usable.reduce((s, r) => s + (Number(r.fileSize) || 0), 0);
    const byCategory = {};
    for (const r of usable) {
      const c = (byCategory[r.category || '(none)'] ||= { files: 0, bytes: 0 });
      c.files += 1;
      c.bytes += Number(r.fileSize) || 0;
    }
    const ids = new Set(usable.map((r) => r.fileId));
    const byDoc = new Map();
    if (ids.size) {
      for (const ref of computeRefs(sdb)) {
        if (!ids.has(ref.fileId)) continue;
        const key = `${ref.docTable}|${ref.docId}`;
        if (!byDoc.has(key)) byDoc.set(key, { docTable: ref.docTable, docId: ref.docId, docNo: ref.docNo, fileIds: [] });
        byDoc.get(key).fileIds.push(ref.fileId);
      }
    }
    return {
      mode: 'dry-run', from, to, doc: doc || null, limit: Number.isFinite(max) ? max : null,
      files: usable.length,
      skippedWithoutKey: rows.length - usable.length,
      totalBytes,
      batches: Math.ceil(usable.length / BATCH_SIZE),
      estimatedSeconds: Math.round(usable.length * SECONDS_PER_FILE + totalBytes / BYTES_PER_SECOND),
      byCategory,
      documents: [...byDoc.values()]
    };
  } finally {
    sdb.close();
  }
}

/** The real move is NOT implemented in this round. Kept as the documented entry point (see the TODO header). */
export function migrate() {
  throw new Error(NOT_SUPPORTED_MSG);
}

/** -> report object for a parsed argument set ; throws Error(NOT_SUPPORTED_MSG) for anything but a read-only dry run */
export function run(args) {
  if (!args.dryRun) throw new Error(NOT_SUPPORTED_MSG);
  return dryRun(args);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.from || !args.to) {
      console.log('usage: node scripts/migrate-files.js --from r2 --to drive --dry-run --db <local.sqlite> [--limit N] [--doc <docRef>]   (ย้ายจริงยังไม่รองรับ)');
      process.exit(args.help ? 0 : 1);
    }
    console.log(JSON.stringify(run(args), null, 2));
  } catch (e) {
    console.error('ผิดพลาด:', e.message);
    process.exit(1);
  }
}
