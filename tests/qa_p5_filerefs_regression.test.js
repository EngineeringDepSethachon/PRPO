// @vitest-environment node
// QA round 3 : write-side file field sanitizing regression + file_refs resilience (before migration 0011).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sanitizeWriteBody } from '../functions/_lib/sanitize.js';
import { reindexTouched, reindexDoc, markDocGone, findDocsHoldingFile, _resetScanThrottle } from '../functions/_lib/filerefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const ALL = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0007_attachments_upload.sql', '0008_ws3_hardening.sql', '0009_upload_attempts.sql', '0010_token_version.sql', '0013_attachments_storage.sql'];
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.all()); return o; } };
}

const FID = 'LEGACYDRIVEFILEID1234567890';
const URL_ = `https://drive.google.com/uc?export=view&id=${FID}`;
const PD = { userId: 'U-PD', id: 'U-PD', username: 'req.pd', name: 'Req PD', department: 'PD', allowedDepartments: '["PD"]', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 };
const QC = { userId: 'U-QC', id: 'U-QC', username: 'req.qc', name: 'Req QC', department: 'QC', allowedDepartments: '["QC"]', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 };

describe.skipIf(!DatabaseSync)('P5 file refs : write-side regression', () => {
  let sdb; let db;
  const build = (withMigration) => {
    sdb = new DatabaseSync(':memory:');
    for (const f of ALL) sdb.exec(readRel('migrations', f));
    if (withMigration) sdb.exec(readRel('migrations', '0011_file_refs.sql'));
    db = makeD1(sdb);
    _resetScanThrottle();
  };
  const addImportedPr = () => sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-PR1','PR-PD-1','PD','SUBMITTED',?, '[]')")
    .run(JSON.stringify([{ name: 'x', imageUrl: URL_ }]));

  beforeEach(() => build(true));

  it('NORMAL : data:image and plain https links in file fields survive', async () => {
    const body = { items: [{ imageUrl: 'data:image/png;base64,AAAA', onlineUrl: 'https://shopee.co.th/p/1' }] };
    expect(await sanitizeWriteBody(db, body, PD)).toBeNull();
    expect(body.items[0].imageUrl).toBe('data:image/png;base64,AAAA');
    expect(body.items[0].onlineUrl).toBe('https://shopee.co.th/p/1');
  });

  it('REGRESSION : re-saving an imported PR (unindexed) keeps its own legacy Drive imageUrl', async () => {
    addImportedPr();
    const body = { id: 'id-PR1', prNumber: 'PR-PD-1', items: [{ name: 'x', imageUrl: URL_ }] };
    await sanitizeWriteBody(db, body, PD);
    expect(body.items[0].imageUrl).toBe(URL_);
  });

  it('FOREIGN : another department cannot keep the same legacy id', async () => {
    addImportedPr();
    const body = { items: [{ imageUrl: URL_ }] };
    await sanitizeWriteBody(db, body, QC);
    expect(body.items[0].imageUrl).toBe('');
  });

  it('BUG PROBE : a foreign probe must not make the owner lose the file in the next minute (scan throttle is per file id, not per user)', async () => {
    addImportedPr();
    await sanitizeWriteBody(db, { items: [{ imageUrl: URL_ }] }, QC); // stranger first : sets throttle
    const body = { id: 'id-PR1', prNumber: 'PR-PD-1', items: [{ name: 'x', imageUrl: URL_ }] };
    await sanitizeWriteBody(db, body, PD);
    expect(body.items[0].imageUrl).toBe(URL_);
  });

  it('DOCUMENTED : a legacy Drive link not held by any stored document and not uploaded via /api/upload is cleared on write', async () => {
    const body = { items: [{ imageUrl: URL_ }], settlementProofUrl: URL_ };
    await sanitizeWriteBody(db, body, PD);
    // current behaviour (data loss for external Drive links) - flip the expectation if product decides to keep them
    expect(body.items[0].imageUrl).toBe('');
  });

  it('RESILIENCE : no file_refs table / docGone column (before apply 0011) : nothing throws', async () => {
    build(false);
    addImportedPr();
    const body = { items: [{ imageUrl: URL_ }] };
    await expect(sanitizeWriteBody(db, body, PD)).resolves.toBeNull();
    await expect(reindexTouched(db, { prs: new Set(['id-PR1']), pos: new Set() }, 'U-PD')).resolves.toBeUndefined();
    await expect(reindexDoc(db, 'prs', { id: 'id-PR1', prNumber: 'PR-PD-1', itemsJson: '[]' }, 'U-PD')).resolves.toBeUndefined();
    await expect(markDocGone(db, 'prs', { id: 'id-PR1', prNumber: 'PR-PD-1' })).resolves.toBeUndefined();
    await expect(findDocsHoldingFile(db, FID)).resolves.toBeDefined();
  });

  it('free-text id never grants access', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, reason) VALUES ('id-PR2','PR-PD-2','PD','SUBMITTED','[]','[]',?)").run(`see ${FID}`);
    const docs = await findDocsHoldingFile(db, FID);
    expect(docs.length).toBe(0);
  });

  it('reindexTouched binds the saver unbound upload to the PR number', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, updatedAt) VALUES ('id-PR3','PR-PD-3','PD','SUBMITTED','[]',?, CURRENT_TIMESTAMP)")
      .run(JSON.stringify([{ fileId: FID, name: 'a' }]));
    sdb.prepare("INSERT INTO attachments (id, fileId, fileName, category, uploaderId, docRef, createdAtMs) VALUES ('A1',?, 'a.png','PR','U-PD','',1)").run(FID);
    await reindexTouched(db, { prs: new Set(['id-PR3']), pos: new Set() }, 'U-PD');
    expect(sdb.prepare('SELECT docRef FROM attachments WHERE id = ?').get('A1').docRef).toBe('PR-PD-3');
    expect(sdb.prepare('SELECT COUNT(*) c FROM file_refs WHERE fileId = ?').get(FID).c).toBe(1);
  });
});
