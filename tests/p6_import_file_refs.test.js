// @vitest-environment node
// P6 A1 : scripts/import-sheets-to-d1.js backfills file_refs for imported PR / PO (same rule as the API : filerefs.docFileIds)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runImport } from '../scripts/import-sheets-to-d1.js';
import { findDocsHoldingFile, _resetScanThrottle } from '../functions/_lib/filerefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DRIVE = (id) => `https://drive.google.com/uc?export=view&id=${id}`;
const F = { item: 'IMPORTEDITEMFILE0123456', att: 'IMPORTEDATTACHFILE01234', po: 'IMPORTEDPOFILE01234567', prItem: 'IMPORTEDPRITEMFILE01234', free: 'FREETEXTONLYFILE0123456' };

async function withSheets(sheets, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpo-import-test-'));
  const made = [];
  try {
    for (const [name, rows] of Object.entries(sheets)) { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(rows)); made.push(f); }
    return await fn(dir);
  } finally {
    for (const f of made) fs.unlinkSync(f); // only the files created above, one by one
    fs.rmdirSync(dir);
  }
}

const SHEETS = {
  PRs: [
    { id: 'p1', prNo: 'PD001/2026', department: 'PD', status: 'SUBMITTED', note: `see ${F.free}`, items: [{ name: 'x', imageUrl: DRIVE(F.item) }], attachments: [{ fileId: F.att, name: 'a.pdf' }] },
    { id: 'p2', prNo: 'PD002/2026', department: 'PD', status: 'SUBMITTED', items: [] }
  ],
  PRItems: [{ id: 'i1', prId: 'p2', prNo: 'PD002/2026', name: 'y', qty: 1, imageUrl: DRIVE(F.prItem) }],
  POs: [{ id: 'o1', poNo: 'PO-PD-2026-001', prNo: 'PD001/2026', department: 'PD', status: 'ORDERED', items: [{ name: 'z', images: [{ fileId: F.po, name: 'q.png' }] }] }]
};

describe.skipIf(!DatabaseSync)('import-sheets-to-d1 : file_refs backfill', () => {
  const build = (sql) => {
    const sdb = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(path.join(here, '..', 'migrations')).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) sdb.exec(fs.readFileSync(path.join(here, '..', 'migrations', f), 'utf8'));
    sdb.exec(sql);
    return sdb;
  };
  const d1 = (sdb) => {
    const mk = (q, p) => ({
      run: async () => { sdb.prepare(q).run(...p); return {}; },
      first: async () => sdb.prepare(q).get(...p) || null,
      all: async () => ({ results: sdb.prepare(q).all(...p) })
    });
    return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async () => [] };
  };

  it('emits INSERT OR IGNORE INTO file_refs for the files a document HOLDS (not for ids in free text) and the SQL runs on migrated D1', async () => {
    const { sql, report } = await withSheets(SHEETS, (dir) => runImport({ inDir: dir }));
    expect(sql).toContain('INSERT OR IGNORE INTO file_refs');
    expect(report.some((r) => r.sheet.startsWith('file_refs'))).toBe(true);
    const sdb = build(sql);
    const refs = sdb.prepare('SELECT fileId, docTable, docId, docNo FROM file_refs ORDER BY fileId').all().map((r) => ({ ...r }));
    expect(refs).toEqual([
      { fileId: F.att, docTable: 'prs', docId: 'p1', docNo: 'PD001/2026' },
      { fileId: F.item, docTable: 'prs', docId: 'p1', docNo: 'PD001/2026' },
      { fileId: F.po, docTable: 'pos', docId: 'o1', docNo: 'PO-PD-2026-001' },
      { fileId: F.prItem, docTable: 'prs', docId: 'p2', docNo: 'PD002/2026' }
    ].sort((a, b) => a.fileId.localeCompare(b.fileId)));
    expect(refs.map((r) => r.fileId)).not.toContain(F.free);
  });

  it('the server finds the imported documents from the index alone (no fallback scan is allowed to run)', async () => {
    const { sql } = await withSheets(SHEETS, (dir) => runImport({ inDir: dir }));
    const db = d1(build(sql));
    _resetScanThrottle();
    const noScan = async () => { throw new Error('fallback scan must not run'); };
    for (const [id, table, docId] of [[F.att, 'prs', 'p1'], [F.po, 'pos', 'o1'], [F.prItem, 'prs', 'p2']]) {
      const docs = await findDocsHoldingFile(db, id, () => true, { scanGate: noScan });
      expect(docs.map((d) => `${d._table}:${d.id}`)).toEqual([`${table}:${docId}`]);
    }
  });

  it('fileRefs:false (--no-file-refs) leaves them out', async () => {
    const { sql } = await withSheets(SHEETS, (dir) => runImport({ inDir: dir, fileRefs: false }));
    expect(sql).not.toContain('file_refs');
  });
});
