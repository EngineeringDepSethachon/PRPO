#!/usr/bin/env node
/**
 * backfill-file-refs.js : เติมตารางดัชนี file_refs (migration 0011) ให้เอกสาร PR/PO ที่มีอยู่แล้วใน D1
 *
 * ใช้กับ D1 ที่มีข้อมูลก่อนมีดัชนี (หรือข้อมูลที่ import โดยไม่เติม file_refs) : ทำให้ server หาเอกสารที่ถือไฟล์จากดัชนีได้เลย
 * ไม่ต้องสแกนตาราง (ถ้าไม่เติม server ก็ยังทำงานได้ — มันสแกนแบบจำกัดแล้วทำดัชนีเองทีละไฟล์ ; สคริปต์นี้แค่ทำให้เร็วและแน่นอนขึ้น)
 * ใช้กติกาเดียวกับ API : functions/_lib/filerefs.js docFileIds (ตำแหน่งไฟล์จริงเท่านั้น ไม่นับ id ที่พิมพ์ในข้อความอิสระ)
 *
 * ปลอดภัยโดยตั้งใจ : ทำงานกับ "ไฟล์ sqlite บนเครื่อง" เท่านั้น (ไม่เรียก wrangler ไม่แตะ remote ไม่อ่าน .env)
 *   --db <ไฟล์.sqlite>   ฐาน local ของ wrangler (เช่น .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
 *                        จาก `wrangler d1 migrations apply prpo-db --local` / `wrangler pages dev --persist-to ...`) หรือสำเนาที่สร้างจาก export
 *   (ไม่ใส่อะไรเพิ่ม)    = รายงานจำนวนที่จะเติม ไม่เขียนอะไร
 *   --out <ไฟล์.sql>    = เขียนคำสั่ง INSERT OR IGNORE INTO file_refs ลงไฟล์ .sql (ไม่ทับไฟล์เดิมเว้นแต่ --force)
 *   --apply             = INSERT OR IGNORE ลงไฟล์ sqlite นั้นเลย (ใช้กับฐาน local เท่านั้น ; INSERT OR IGNORE ไม่ทับ/ลบอะไร)
 *
 * D1 remote : ผู้ใช้รันเอง ไม่มีสคริปต์ไหนในโปรเจกต์นี้แตะ remote —
 *   1) wrangler d1 export prpo-db --remote --output=<ไฟล์นอก repo>.sql     (ผู้ใช้รัน)
 *   2) สร้าง sqlite local จาก export นั้น แล้วรัน  node scripts/backfill-file-refs.js --db <local.sqlite> --out <backfill.sql>
 *   3) ตรวจไฟล์ backfill.sql แล้ว  wrangler d1 execute prpo-db --remote --file=<backfill.sql>   (ผู้ใช้รัน ; INSERT OR IGNORE รันซ้ำได้)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { docFileIds, MAX_REFS_PER_DOC } from '../functions/_lib/filerefs.js';

const sqlLit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/\0/g, '').replace(/'/g, "''").replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'")}'`);

/** -> [{ fileId, docTable, docId, docNo }] for every PR / PO in the database */
export function computeRefs(sdb) {
  const refs = [];
  const itemsByPr = new Map();
  try {
    for (const it of sdb.prepare('SELECT prId, images, attachments, imageUrl, driveUrl, fileId FROM pr_items').all()) {
      if (!itemsByPr.has(it.prId)) itemsByPr.set(it.prId, []);
      itemsByPr.get(it.prId).push(it);
    }
  } catch { /* no pr_items table : nothing to add */ }
  for (const row of sdb.prepare('SELECT * FROM prs').all()) {
    for (const fileId of [...docFileIds('prs', row, itemsByPr.get(row.id) || [])].slice(0, MAX_REFS_PER_DOC)) refs.push({ fileId, docTable: 'prs', docId: row.id, docNo: row.prNumber || null });
  }
  for (const row of sdb.prepare('SELECT * FROM pos').all()) {
    for (const fileId of [...docFileIds('pos', row)].slice(0, MAX_REFS_PER_DOC)) refs.push({ fileId, docTable: 'pos', docId: row.id, docNo: row.poNumber || null });
  }
  return refs;
}

export const refSql = (r) => `INSERT OR IGNORE INTO file_refs (fileId, docTable, docId, docNo) VALUES (${sqlLit(r.fileId)}, ${sqlLit(r.docTable)}, ${sqlLit(r.docId)}, ${sqlLit(r.docNo)});`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--db') a.db = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--apply') a.apply = true;
    else if (t === '--force') a.force = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else throw new Error(`อาร์กิวเมนต์ไม่รู้จัก: ${t}`);
  }
  return a;
}

export function runBackfill({ db, out, apply = false, force = false }) {
  if (!db || !/\.(sqlite3?|db)$/i.test(db) || !fs.existsSync(db) || !fs.statSync(db).isFile()) throw new Error('ต้องระบุ --db เป็นไฟล์ sqlite (.sqlite/.sqlite3/.db) ที่มีอยู่จริงบนเครื่อง');
  if (out && (!/\.sql$/i.test(out) || (fs.existsSync(out) && !force))) throw new Error('--out ต้องลงท้าย .sql และห้ามมีไฟล์อยู่แล้ว (ใช้ --force เพื่อทับ)');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const sdb = new DatabaseSync(db);
  try {
    const hasTable = sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_refs'").get();
    if (!hasTable) throw new Error('ฐานนี้ยังไม่มีตาราง file_refs — ต้อง apply migration 0011 ก่อน');
    const refs = computeRefs(sdb);
    const existing = new Set(sdb.prepare('SELECT fileId, docTable, docId FROM file_refs').all().map((r) => `${r.fileId}|${r.docTable}|${r.docId}`));
    const fresh = refs.filter((r) => !existing.has(`${r.fileId}|${r.docTable}|${r.docId}`));
    if (out) fs.writeFileSync(out, `-- สร้างโดย scripts/backfill-file-refs.js ; INSERT OR IGNORE รันซ้ำได้\n${fresh.map(refSql).join('\n')}\n`, 'utf8');
    if (apply) {
      const ins = sdb.prepare('INSERT OR IGNORE INTO file_refs (fileId, docTable, docId, docNo) VALUES (?, ?, ?, ?)');
      for (const r of fresh) ins.run(r.fileId, r.docTable, r.docId, r.docNo);
    }
    return { documentsRefs: refs.length, alreadyIndexed: refs.length - fresh.length, toAdd: fresh.length, wroteSql: Boolean(out), applied: Boolean(apply) };
  } finally {
    sdb.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.db) {
      console.log('usage: node scripts/backfill-file-refs.js --db <local.sqlite> [--out <file.sql>] [--apply] [--force]   (ไม่ใส่ --out/--apply = รายงานอย่างเดียว)');
      process.exit(args.help ? 0 : 1);
    }
    console.log(JSON.stringify(runBackfill(args), null, 2));
  } catch (e) {
    console.error('ผิดพลาด:', e.message);
    process.exit(1);
  }
}
