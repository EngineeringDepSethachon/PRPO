// @vitest-environment node
// P6 phase 2 : fallback-scan quota, touched-only reindex, one access rule for read/write file checks, deleted-PR files through a PO,
// general ledger by department, orphan Drive files cleanup, Pages security headers.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { _resetDriveCache } from '../functions/_lib/drive.js';
import { sanitizeWriteBody, MAX_FALLBACK_SCANS_PER_REQUEST, MAX_FALLBACK_SCANS_PER_MINUTE } from '../functions/_lib/sanitize.js';
import { _resetScanThrottle, reindexTouched } from '../functions/_lib/filerefs.js';
import { findAuthorizedAttachment } from '../functions/_lib/files.js';
import { parseCleanupBody, MIN_AGE_HOURS, MAX_PER_RUN, MAX_CHECKS_PER_RUN } from '../functions/_lib/orphans.js';
import { buildViewer, filterLedger } from '../functions/_lib/scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0007_attachments_upload.sql', '0008_ws3_hardening.sql', '0009_upload_attempts.sql', '0010_token_version.sql', '0011_file_refs.sql', '0013_attachments_storage.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const ROOT = 'ROOTFOLDER1234567890';
const FOLDER = 'FOLDERPD1234567890ab';

const PERSONAS = {
  PD: { id: 'U-PD', username: 'req.pd', name: 'Req PD', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  QC: { id: 'U-QC', username: 'req.qc', name: 'Req QC', department: 'QC', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
const asUser = (k) => { const u = PERSONAS[k]; return { ...u, userId: u.id, allowedDepartments: u.allowedDepartments || JSON.stringify([u.department]) }; };

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb, log) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { log && log.push(q); sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { log && log.push(q); const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => { log && log.push(q); return { results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) }; }
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.all()); return o; } };
}
const jres = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const newDb = () => {
  const sdb = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
  return sdb;
};
const addAtt = (sdb, fileId, o = {}) => sdb.prepare(`INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, poNumber, docNo, docType, folderId, folderPath, uploadedBy, uploaderId, docRef, createdAtMs, docGone)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`ATT-${fileId}`, fileId, 'p.png', 'image/png', 12, o.category ?? 'GRN', o.poNumber ?? '', o.docNo ?? '', 'X', FOLDER, 'x', 'u', o.uploaderId ?? 'U-X', o.docRef ?? '', o.createdAtMs ?? Date.now(), o.docGone ?? 0);

// ───────────────────────────── 1. fallback scan quota ─────────────────────────────
describe.skipIf(!DatabaseSync)('P6 A1 : write-side fallback scan quota', () => {
  let sdb; let queries; let db;
  const scans = () => queries.filter((q) => /FROM prs WHERE instr\(/.test(q)).length; // one per scanHolders run
  const idsBody = (prefix, n) => ({ items: Array.from({ length: n }, (_, i) => ({ imageUrl: `https://drive.google.com/uc?export=view&id=${prefix}${String(i).padStart(16, '0')}` })) });
  beforeEach(() => { sdb = newDb(); queries = []; db = makeD1(sdb, queries); _resetScanThrottle(); });

  it('100 random NEW ids in one request cost at most 5 table scans ; the rest could not be decided -> 429, nothing is cut or written', async () => {
    const body = idsBody('RANDOMID', 100);
    const before = JSON.stringify(body);
    const bad = await sanitizeWriteBody(db, body, asUser('PD'));
    expect(MAX_FALLBACK_SCANS_PER_REQUEST).toBe(5);
    expect(scans()).toBe(5);
    expect(bad).toMatchObject({ status: 429 });
    expect(JSON.stringify(body)).toBe(before); // no silent cut
    const row = sdb.prepare("SELECT n FROM upload_attempts WHERE userId = 'fs:U-PD'").get();
    expect(row.n).toBe(5);
  });

  it('up to 5 new ids that are checked and NOT allowed are still cleared as before (a refusal is not a quota problem)', async () => {
    const body = idsBody('FOREIGNID', 3);
    expect(await sanitizeWriteBody(db, body, asUser('PD'))).toBeNull();
    expect(body.items.every((it) => it.imageUrl === '')).toBe(true);
  });

  it('per user per minute (D1 counter, key fs:<userId>) : after the quota no more scans, even with fresh ids', async () => {
    for (let i = 0; i < MAX_FALLBACK_SCANS_PER_MINUTE / MAX_FALLBACK_SCANS_PER_REQUEST; i++) await sanitizeWriteBody(db, idsBody(`ROUND${i}X`, 5), asUser('PD'));
    expect(scans()).toBe(MAX_FALLBACK_SCANS_PER_MINUTE);
    queries.length = 0;
    const body = idsBody('LATEROUND', 3);
    const bad = await sanitizeWriteBody(db, body, asUser('PD'));
    expect(scans()).toBe(0);
    expect(bad).toMatchObject({ status: 429 });
    expect(body.items.every((it) => it.imageUrl !== '')).toBe(true);
    // another user has his own counter
    await sanitizeWriteBody(db, idsBody('OTHERUSER', 2), asUser('QC'));
    expect(scans()).toBe(2);
  });

  it('an over-quota id that REALLY belongs to the caller\'s document is still kept when the index knows it (no scan needed)', async () => {
    const F = 'INDEXEDFILE0123456789';
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-1','PR-PD-1','PD','DRAFT','[]',?)").run(JSON.stringify([{ fileId: F }]));
    sdb.prepare("INSERT INTO file_refs (fileId, docTable, docId, docNo) VALUES (?, 'prs', 'id-1', 'PR-PD-1')").run(F);
    await sanitizeWriteBody(db, idsBody('BURNQUOTA', 5), asUser('PD'));
    sdb.prepare("UPDATE upload_attempts SET n = ? WHERE userId = 'fs:U-PD'").run(MAX_FALLBACK_SCANS_PER_MINUTE);
    const body = { items: [{ imageUrl: `https://drive.google.com/uc?export=view&id=${F}` }] };
    await sanitizeWriteBody(db, body, asUser('PD'));
    expect(body.items[0].imageUrl).toContain(F);
  });

  it('counter unavailable : fail closed (no scan) and the request is answered 503 without cutting anything ; hourly counters are never deleted by the minute cleanup', async () => {
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    sdb.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?,?,?)').run('dl:U-PD', hour, 7);
    sdb.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?,?,?)').run('fs:U-PD', 1000, 3); // an old minute row
    await sanitizeWriteBody(db, idsBody('CLEANUPXX', 1), asUser('PD'));
    expect(sdb.prepare("SELECT n FROM upload_attempts WHERE userId = 'dl:U-PD'").get().n).toBe(7);
    expect(sdb.prepare("SELECT COUNT(*) c FROM upload_attempts WHERE userId = 'fs:U-PD' AND windowStart = 1000").get().c).toBe(0);
    sdb.exec('DROP TABLE upload_attempts');
    queries.length = 0;
    const body = idsBody('NOCOUNTER', 2);
    const bad = await sanitizeWriteBody(db, body, asUser('PD'));
    expect(scans()).toBe(0);
    expect(bad).toMatchObject({ status: 503 });
    expect(body.items.every((it) => it.imageUrl !== '')).toBe(true);
  });

  describe('a document that already holds its files keeps them when it is saved again (no scan, no quota)', () => {
    const FILES = Array.from({ length: 7 }, (_, i) => `LEGACYHELDFILE${i}0123456789`);
    const addPr7 = () => sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-7','PD007/2026','PD','DRAFT','[]',?)")
      .run(JSON.stringify(FILES.map((f, i) => ({ fileId: f, name: `f${i}.png` }))));
    const saveBody = () => ({ id: 'id-7', prNumber: 'PD007/2026', attachments: FILES.map((f, i) => ({ fileId: f, name: `f${i}.png` })) });
    beforeEach(() => {
      addPr7(); // NOT in file_refs ; the attachments rows belong to somebody else (the saver is not the uploader) and are not bound to the PR
      for (const f of FILES) addAtt(sdb, f, { category: 'PR', uploaderId: 'U-X' });
    });

    it('a PR of 7 unindexed files saved by a non-uploader : all 7 stay (files 6 and 7 are not lost)', async () => {
      const body = saveBody();
      expect(await sanitizeWriteBody(db, body, asUser('PD'))).toBeNull();
      expect(body.attachments.map((a) => a.fileId)).toEqual(FILES);
      expect(scans()).toBe(0);
    });

    it('... also when the quota is already used up, and when the document is named only by the URL (hint.docKey)', async () => {
      sdb.prepare('INSERT INTO upload_attempts (userId, windowStart, n) VALUES (?,?,?)').run('fs:U-PD', Math.floor(Date.now() / 60000) * 60000, 999);
      const body = { attachments: FILES.map((f) => ({ fileId: f })) };
      expect(await sanitizeWriteBody(db, body, asUser('PD'), { docKey: 'id-7' })).toBeNull();
      expect(body.attachments.map((a) => a.fileId)).toEqual(FILES);
    });

    it('... and through the API : PUT /api/prs/id-7 keeps all 7', async () => {
      for (const u of Object.values(PERSONAS)) {
        sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
          .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
      }
      const token = await signToken({ sub: 'U-PD', userId: 'U-PD', role: 'REQUESTER_PD', level: 1 }, SECRET);
      const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/prs/id-7', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ attachments: FILES.map((f) => ({ fileId: f, name: 'x.png' })) }) }), env: { DB: db, AUTH_TOKEN_SECRET: SECRET } });
      expect(res.status).toBe(200);
      const stored = JSON.parse(sdb.prepare("SELECT attachmentsJson FROM prs WHERE id = 'id-7'").get().attachmentsJson);
      expect(stored.map((a) => a.fileId)).toEqual(FILES);
      expect(sdb.prepare('SELECT COUNT(*) c FROM file_refs WHERE docId = ?').get('id-7').c).toBe(7); // indexed by this save
    });

    it('a document the caller may NOT use grants nothing ; a different department is cut as before', async () => {
      const body = { id: 'id-7', attachments: FILES.slice(0, 2).map((f) => ({ fileId: f })) };
      expect(await sanitizeWriteBody(db, body, asUser('QC'))).toBeNull();
      expect(body.attachments.every((a) => a.fileId === '')).toBe(true);
    });
  });
});

// ───────────────────────────── 2. reindex only what the request wrote ─────────────────────────────
describe.skipIf(!DatabaseSync)('P6 A2 : reindexTouched', () => {
  it('reindexes exactly the touched ids and binds only the saver\'s upload on a touched PR', async () => {
    const sdb = newDb(); const db = makeD1(sdb);
    const F1 = 'TOUCHEDFILE01234567890'; const F2 = 'UNTOUCHEDFILE1234567890';
    const ins = sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, updatedAt) VALUES (?,?, 'PD','DRAFT','[]',?, CURRENT_TIMESTAMP)");
    ins.run('id-A', 'PD001/2026', JSON.stringify([{ fileId: F1 }]));
    ins.run('id-B', 'PD002/2026', JSON.stringify([{ fileId: F2 }])); // also updated "just now" by somebody else
    addAtt(sdb, F1, { category: 'PR', uploaderId: 'U-PD' });
    addAtt(sdb, F2, { category: 'PR', uploaderId: 'U-PD' });
    await reindexTouched(db, { prs: new Set(['id-A']), pos: new Set() }, 'U-PD');
    expect(sdb.prepare('SELECT docId FROM file_refs WHERE fileId = ?').all(F1).map((r) => r.docId)).toEqual(['id-A']);
    expect(sdb.prepare('SELECT COUNT(*) c FROM file_refs WHERE fileId = ?').get(F2).c).toBe(0);
    expect(sdb.prepare('SELECT docRef FROM attachments WHERE fileId = ?').get(F1).docRef).toBe('PD001/2026');
    expect(sdb.prepare('SELECT docRef FROM attachments WHERE fileId = ?').get(F2).docRef).toBe('');
    // nothing touched = nothing done
    await reindexTouched(db, undefined, 'U-PD');
    await reindexTouched(db, { prs: new Set(), pos: new Set() }, 'U-PD');
    expect(sdb.prepare('SELECT COUNT(*) c FROM file_refs').get().c).toBe(1);
  });

  it('through the API : PUT /api/prs/:id reindexes that PR only ; the route source no longer scans updatedAt', async () => {
    const sdb = newDb();
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    const F1 = 'APIFILEONE01234567890'; const F2 = 'APIFILETWO01234567890';
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, updatedAt) VALUES ('id-A','PD001/2026','PD','DRAFT','[]','[]', CURRENT_TIMESTAMP)").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, updatedAt) VALUES ('id-B','PD002/2026','PD','DRAFT','[]',?, CURRENT_TIMESTAMP)").run(JSON.stringify([{ fileId: F2 }]));
    addAtt(sdb, F1, { category: 'PR', uploaderId: 'U-PD' });
    addAtt(sdb, F2, { category: 'PR', uploaderId: 'U-PD' });
    const env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    const token = await signToken({ sub: 'U-PD', userId: 'U-PD', role: 'REQUESTER_PD', level: 1 }, SECRET);
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/prs/id-A', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ attachments: [{ fileId: F1, name: 'a.png' }] }) }), env });
    expect(res.status).toBe(200);
    expect(sdb.prepare('SELECT docId FROM file_refs WHERE fileId = ?').all(F1).map((r) => r.docId)).toEqual(['id-A']);
    expect(sdb.prepare('SELECT docRef FROM attachments WHERE fileId = ?').get(F1).docRef).toBe('PD001/2026');
    expect(sdb.prepare('SELECT COUNT(*) c FROM file_refs WHERE fileId = ?').get(F2).c).toBe(0); // the other PR was not touched by this request
    expect(readRel('functions', 'api', '[[route]].js')).not.toMatch(/reindexRecentDocs|datetime\(updatedAt\)/);
    expect(readRel('functions', '_lib', 'filerefs.js')).not.toMatch(/datetime\(updatedAt\)/);
  });
});

// ───────────────────────────── 3 + 4. one access rule ; deleted PR through its PO ─────────────────────────────
describe.skipIf(!DatabaseSync)('P6 A3/A4 : attachment access rule (read == write)', () => {
  let sdb; let db;
  beforeEach(() => { sdb = newDb(); db = makeD1(sdb); _resetScanThrottle(); });
  const writeAllows = async (who, fileId) => {
    const body = { items: [{ imageUrl: `https://drive.google.com/uc?export=view&id=${fileId}` }] };
    await sanitizeWriteBody(db, body, asUser(who));
    return body.items[0].imageUrl !== '';
  };
  const readAllows = async (who, fileId) => Boolean(await findAuthorizedAttachment(db, asUser(who), fileId));
  const both = async (who, fileId) => { const w = await writeAllows(who, fileId); const r = await readAllows(who, fileId); expect(w, `write == read for ${who}`).toBe(r); return w; };

  it('a PR attachment is resolved by prNumber (a PO whose id equals that number is not consulted)', async () => {
    const F = 'PRBYNUMBERFILE1234567';
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('X-1','PO-QC-1','QC','ORDERED','[]')").run();
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('id-pr','X-1','PD','DRAFT','[]')").run();
    addAtt(sdb, F, { category: 'PR', docRef: 'X-1', poNumber: '', docNo: 'X-1' });
    expect(await both('PD', F)).toBe(true);
    expect(await both('QC', F)).toBe(false);
  });

  it('a PO attachment is resolved poNumber first (ORDER BY poNumber = ?)', async () => {
    const F = 'POORDERFILE0123456789';
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('P-1','PO-OTHER','QC','ORDERED','[]')").run(); // id equals the reference
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('id-b','P-1','PD','ORDERED','[]')").run(); // number equals the reference
    addAtt(sdb, F, { category: 'GRN', docRef: 'P-1', poNumber: 'P-1', docNo: 'P-1' });
    expect(await both('PD', F)).toBe(true);
    expect(await both('QC', F)).toBe(false);
  });

  it('a row whose PR was deleted (docGone) is closed for everybody ... ', async () => {
    const F = 'GONEPRFILE01234567890';
    addAtt(sdb, F, { category: 'PR', docRef: 'PD009/2026', docNo: 'PD009/2026', docGone: 1 });
    expect(await both('PD', F)).toBe(false);
    expect(await both('QC', F)).toBe(false);
  });

  it('... except through a PO made from that PR that holds the file and names the PR number', async () => {
    const F = 'GONEPRFILE2345678901';
    addAtt(sdb, F, { category: 'PR', docRef: 'PD009/2026', docNo: 'PD009/2026', docGone: 1 });
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-po','PO-PD-9','PD009/2026','PD','ORDERED','[]',?)")
      .run(JSON.stringify({ prAttachments: [{ fileId: F, name: 'q.png' }] }));
    expect(await both('PD', F)).toBe(true);   // may use that PO
    expect(await both('QC', F)).toBe(false);  // may not
    expect(await both('ADMIN', F)).toBe(true);
  });

  it('a PO that holds the id but names ANOTHER PR (or mentions it only in free text) opens nothing', async () => {
    const F = 'GONEPRFILE3456789012';
    addAtt(sdb, F, { category: 'PR', docRef: 'PD009/2026', docNo: 'PD009/2026', docGone: 1 });
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-po1','PO-PD-1','PD111/2026','PD','ORDERED','[]',?)")
      .run(JSON.stringify({ prAttachments: [{ fileId: F }] }));
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-po2','PO-PD-2','PD009/2026','PD','ORDERED','[]',?)")
      .run(JSON.stringify({ note: `see ${F}` }));
    expect(await both('PD', F)).toBe(false);
  });

  it('a docGone row of a non-PR category does not get the PO exception', async () => {
    const F = 'GONEGRNFILE234567890';
    addAtt(sdb, F, { category: 'GRN', docRef: 'PO-PD-9', poNumber: 'PO-PD-9', docNo: 'PO-PD-9', docGone: 1 });
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, extraJson) VALUES ('id-po','PO-PD-9','PO-PD-9','PD','ORDERED','[]',?)").run(JSON.stringify({ prAttachments: [{ fileId: F }] }));
    expect(await both('PD', F)).toBe(false);
  });

  it('a NEW PO may not use an id equal to an existing PR number (409)', async () => {
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('id-pr','PD001/2026','PD','APPROVED','[]')").run();
    const env = { DB: db, AUTH_TOKEN_SECRET: SECRET };
    const token = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
    const post = (id) => onRequest({ request: new Request('https://prpo.pages.dev/api/pos', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, prNumber: 'PD001/2026', department: 'PD', status: 'ORDERED', items: [] }) }), env });
    expect((await post('PD001/2026')).status).toBe(409);
    expect((await post('PO-NEW-ID-1')).status).toBe(200);
  });
});

// ───────────────────────────── 6. general ledger by department ─────────────────────────────
describe('P6 B6 : ledger rows (general and PO-linked) follow their department', () => {
  const rows = [
    { id: 'T1', department: 'PD', type: 'TOP_UP', amount: 1 },                                  // general (no PO)
    { id: 'T2', dept: 'QC', type: 'TOP_UP', amount: 1 },                                         // general, legacy `dept` column only
    { id: 'T3', department: 'PD', type: 'PO_COMMITMENT', poNumber: 'PO-PD-1', amount: 1 },      // PO-linked
    { id: 'T4', department: 'QC', type: 'REFUND_SETTLEMENT', poNumber: 'PO-QC-1', amount: 1 },
    { id: 'T5', type: 'TOP_UP', amount: 1 }                                                      // no department at all
  ];
  const idsFor = (who) => filterLedger(buildViewer(asUser(who)), rows).map((r) => r.id);
  it('a department user gets only the rows of own department', () => {
    expect(idsFor('PD')).toEqual(['T1', 'T3']);
    expect(idsFor('QC')).toEqual(['T2', 'T4']);
  });
  it('admin gets all rows, including the one without department', () => {
    expect(idsFor('ADMIN')).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });
});

// ───────────────────────────── 7. orphan cleanup ─────────────────────────────
let pem;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});

describe('P6 B7 : parseCleanupBody', () => {
  it('dry run unless the body says dryRun === false (boolean) ; age and limit are clamped', () => {
    for (const b of [undefined, null, {}, [], { dryRun: 'false' }, { dryRun: 0 }, { dryRun: true }, 'x']) expect(parseCleanupBody(b).dryRun).toBe(true);
    expect(parseCleanupBody({ dryRun: false }).dryRun).toBe(false);
    expect(parseCleanupBody({ olderThanHours: 1 }).olderThanHours).toBe(MIN_AGE_HOURS);
    expect(parseCleanupBody({ olderThanHours: 'abc' }).olderThanHours).toBe(MIN_AGE_HOURS);
    expect(parseCleanupBody({ olderThanHours: 72 }).olderThanHours).toBe(72);
    expect(parseCleanupBody({ limit: 100000 }).limit).toBe(MAX_PER_RUN);
    expect(parseCleanupBody({ limit: 3 }).limit).toBe(3);
  });
});

describe.skipIf(!DatabaseSync)('P6 B7 : POST /api/admin/cleanup-orphans', () => {
  let sdb; let env; let gcalls; let driveFiles; const tokens = {};
  const OLD = Date.now() - 48 * 3600 * 1000;
  const F = { orphan: 'ORPHANFILE0123456789a', recent: 'RECENTFILE0123456789ab', held: 'HELDBYPRFILE0123456789', indexed: 'INDEXEDFILE0123456789a', bound: 'BOUNDFILE0123456789abc', freetext: 'FREETEXTFILE123456789a', gone: 'NOTINDRIVE0123456789ab' };

  function installGoogle() {
    gcalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); gcalls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return jres({ access_token: 'tok', expires_in: 3600 });
      const m = url.match(/\/drive\/v3\/files\/([^?]+)\?/);
      if (!m) return jres({}, 404);
      const id = decodeURIComponent(m[1]);
      const f = driveFiles[id];
      if (!f) return jres({ error: { message: 'not found' } }, 404);
      if ((init.method || 'GET').toUpperCase() === 'PATCH') { f.trashed = JSON.parse(init.body).trashed; return jres({ id }); }
      return jres({ id, mimeType: 'image/png', size: '12', parents: f.parents || [FOLDER], trashed: Boolean(f.trashed) });
    }));
  }
  const call = (who, body) => onRequest({ request: new Request('https://prpo.pages.dev/api/admin/cleanup-orphans', { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });

  beforeEach(async () => {
    _resetDriveCache(); _resetScanThrottle();
    sdb = newDb();
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    addAtt(sdb, F.orphan, { category: 'PR', createdAtMs: OLD });
    addAtt(sdb, F.recent, { category: 'PR', createdAtMs: Date.now() - 3600 * 1000 });
    addAtt(sdb, F.held, { category: 'PR', createdAtMs: OLD });
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-h','PD001/2026','PD','DRAFT','[]',?)").run(JSON.stringify([{ fileId: F.held }])); // not indexed (pre-0011)
    addAtt(sdb, F.indexed, { category: 'PR', createdAtMs: OLD });
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-i','PD002/2026','PD','DRAFT','[]',?)").run(JSON.stringify([{ fileId: F.indexed }]));
    sdb.prepare("INSERT INTO file_refs (fileId, docTable, docId, docNo) VALUES (?, 'prs', 'id-i', 'PD002/2026')").run(F.indexed);
    addAtt(sdb, F.bound, { category: 'PR', docRef: 'PD003/2026', docNo: 'PD003/2026', createdAtMs: OLD });
    addAtt(sdb, F.freetext, { category: 'PR', createdAtMs: OLD }); // only mentioned in free text of a PR : that is NOT holding it
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, extraJson) VALUES ('id-f','PD004/2026','PD','DRAFT','[]','[]',?)").run(JSON.stringify({ note: `see ${F.freetext}` }));
    addAtt(sdb, F.gone, { category: 'PR', createdAtMs: OLD });
    driveFiles = Object.fromEntries(Object.values(F).map((id) => [id, {}]));
    delete driveFiles[F.gone];
    installGoogle();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('only an admin : others get 403 and nothing reaches Google', async () => {
    expect((await call('PD', {})).status).toBe(403);
    expect((await call('QC', { dryRun: false })).status).toBe(403);
    expect(gcalls.length).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) c FROM attachments WHERE docGone = 2').get().c).toBe(0);
  });

  it('401 without a token', async () => {
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/admin/cleanup-orphans', { method: 'POST', body: '{}' }), env });
    expect(res.status).toBe(401);
  });

  it('DRY RUN is the default (empty body / no body / dryRun true) : lists orphans, never calls Google, changes nothing', async () => {
    for (const body of [undefined, {}, { dryRun: true }, { dryRun: 'no' }]) {
      const res = await call('ADMIN', body);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.dryRun).toBe(true);
      expect(j.orphans.map((o) => o.fileId).sort()).toEqual([F.freetext, F.gone, F.orphan].sort());
      expect(j.orphans.find((o) => o.fileId === F.orphan).ageHours).toBeGreaterThanOrEqual(47);
    }
    expect(gcalls.length).toBe(0);
    expect(sdb.prepare('SELECT COUNT(*) c FROM attachments WHERE docGone != 0').get().c).toBe(0);
  });

  it('never lists: recent uploads, bound rows, files held by a PR (indexed or not)', async () => {
    const j = await (await call('ADMIN', {})).json();
    const ids = j.orphans.map((o) => o.fileId);
    for (const keep of [F.recent, F.held, F.indexed, F.bound]) expect(ids).not.toContain(keep);
    // olderThanHours can only make it stricter
    const strict = await (await call('ADMIN', { olderThanHours: 1 })).json();
    expect(strict.olderThanHours).toBe(24);
    expect(strict.orphans.map((o) => o.fileId)).not.toContain(F.recent);
  });

  it('dryRun:false : orphans move to the Drive TRASH only (PATCH trashed:true, never DELETE), rows are closed, held files untouched', async () => {
    const res = await call('ADMIN', { dryRun: false });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.dryRun).toBe(false);
    expect(j.trashed.map((o) => o.fileId).sort()).toEqual([F.freetext, F.orphan].sort());
    expect(j.skipped).toEqual([expect.objectContaining({ fileId: F.gone, attachmentId: `ATT-${F.gone}`, reason: 'NOT_IN_DRIVE' })]);
    // the audit trail names every file that was moved or skipped
    const aud = sdb.prepare("SELECT details FROM audit_logs WHERE action = 'ORPHAN_CLEANUP'").get();
    const d = JSON.parse(aud.details);
    expect(d.trashedFiles.map((x) => x.fileId).sort()).toEqual([F.freetext, F.orphan].sort());
    expect(d.trashedFiles[0]).toEqual({ fileId: expect.any(String), attachmentId: expect.stringMatching(/^ATT-/), fileName: 'p.png' });
    expect(d.skippedFiles).toEqual([{ fileId: F.gone, attachmentId: `ATT-${F.gone}`, fileName: 'p.png', reason: 'NOT_IN_DRIVE' }]);
    expect(gcalls.some((c) => c.method === 'DELETE')).toBe(false);
    const patches = gcalls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(2);
    for (const p of patches) expect(JSON.parse(p.body)).toEqual({ trashed: true });
    expect(driveFiles[F.orphan].trashed).toBe(true);
    for (const keep of [F.recent, F.held, F.indexed, F.bound]) expect(driveFiles[keep].trashed).toBeUndefined();
    expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(F.orphan).docGone).toBe(2);
    expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(F.held).docGone).toBe(0);
    // listed once only
    expect((await (await call('ADMIN', {})).json()).orphanCount).toBe(0);
    // nobody can open a trashed orphan through the API any more (not even the uploader)
    expect(await findAuthorizedAttachment(makeD1(sdb), { ...asUser('PD'), userId: 'U-X' }, F.orphan)).toBeNull();
  });

  it('a file that is not in the upload folder any more is not trashed', async () => {
    driveFiles[F.orphan].parents = ['SOMEOTHERFOLDER1234567'];
    const j = await (await call('ADMIN', { dryRun: false })).json();
    expect(j.skipped.find((s) => s.fileId === F.orphan).reason).toBe('NOT_IN_UPLOAD_FOLDER');
    expect(driveFiles[F.orphan].trashed).toBeUndefined();
  });

  it('limit caps how many files one call trashes', async () => {
    const j = await (await call('ADMIN', { dryRun: false, limit: 1 })).json();
    expect(j.trashed.length + j.skipped.length).toBeLessThanOrEqual(1);
    expect(gcalls.filter((c) => c.method === 'PATCH').length).toBeLessThanOrEqual(1);
  });

  it('the work per call is bounded : only MAX_CHECKS_PER_RUN files are verified, then it says truncated', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `HELDMANY${String(i).padStart(14, '0')}`);
    many.forEach((f, i) => addAtt(sdb, f, { category: 'PR', createdAtMs: OLD - 1000 - i }));
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-many','PD099/2026','PD','DRAFT','[]',?)").run(JSON.stringify(many.map((f) => ({ fileId: f }))));
    // the 40 older rows come first (oldest first) and are all held by one unindexed PR : the check budget (25) is used up before the listing ends
    const j = await (await call('ADMIN', {})).json();
    expect(j.checked).toBeLessThanOrEqual(MAX_CHECKS_PER_RUN);
    expect(j.truncated).toBe(true);
    expect(j.orphanCount).toBeLessThanOrEqual(MAX_PER_RUN);
  });

  describe('races with a save (TOCTOU) : claim first, check again, give the row back when anything changed', () => {
    const onToken = { fn: null };
    beforeEach(() => {
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token') && onToken.fn) { const f = onToken.fn; onToken.fn = null; f(); }
        return inner(url, init);
      }));
    });
    it('a save bound the row after the listing : nothing is trashed, the row is untouched ("CHANGED")', async () => {
      onToken.fn = () => sdb.prepare("UPDATE attachments SET docRef = 'PD777/2026', docNo = 'PD777/2026' WHERE fileId = ?").run(F.orphan);
      const j = await (await call('ADMIN', { dryRun: false })).json();
      expect(j.skipped.find((s) => s.fileId === F.orphan).reason).toBe('CHANGED');
      expect(driveFiles[F.orphan].trashed).toBeUndefined();
      expect(sdb.prepare('SELECT docGone, docRef FROM attachments WHERE fileId = ?').get(F.orphan)).toMatchObject({ docGone: 0, docRef: 'PD777/2026' });
    });
    it('a PR started to hold the file after the listing : not trashed, row given back ("HELD")', async () => {
      onToken.fn = () => sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('id-new','PD888/2026','PD','DRAFT','[]',?)").run(JSON.stringify([{ fileId: F.orphan }]));
      const j = await (await call('ADMIN', { dryRun: false })).json();
      expect(j.skipped.find((s) => s.fileId === F.orphan).reason).toBe('HELD');
      expect(driveFiles[F.orphan].trashed).toBeUndefined();
      expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(F.orphan).docGone).toBe(0);
    });
  });
});

describe.skipIf(!DatabaseSync)('P6 B7 : POST /api/admin/restore-orphan (the way back)', () => {
  let sdb; let env; let gcalls; let driveFiles; const tokens = {};
  const FILE = 'RESTOREME0123456789ab';
  const post = (who, url, body) => onRequest({ request: new Request(`https://prpo.pages.dev${url}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
  beforeEach(async () => {
    _resetDriveCache(); _resetScanThrottle();
    sdb = newDb();
    for (const u of Object.values(PERSONAS)) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
        .run(u.id, u.username, '', u.name, u.department, u.allowedDepartments || JSON.stringify([u.department]), u.roleId, u.canonicalRole, u.level);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET, GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: pem, DRIVE_ROOT_FOLDER_ID: ROOT };
    for (const [k, u] of Object.entries(PERSONAS)) tokens[k] = await signToken({ sub: u.id, userId: u.id, role: u.roleId, level: u.level }, SECRET);
    addAtt(sdb, FILE, { category: 'PR', createdAtMs: Date.now() - 48 * 3600 * 1000 });
    driveFiles = { [FILE]: {} };
    gcalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      url = String(url); gcalls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return jres({ access_token: 'tok', expires_in: 3600 });
      const m = url.match(/\/drive\/v3\/files\/([^?]+)\?/);
      const f = m && driveFiles[decodeURIComponent(m[1])];
      if (!f) return jres({ error: { message: 'not found' } }, 404);
      if ((init.method || 'GET').toUpperCase() === 'PATCH') { f.trashed = JSON.parse(init.body).trashed; return jres({}); }
      return jres({ id: FILE, parents: f.parents || [FOLDER], trashed: Boolean(f.trashed) });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('cleanup then restore : the file leaves the trash, the row is open again, the restore is audited', async () => {
    expect((await (await post('ADMIN', '/api/admin/cleanup-orphans', { dryRun: false })).json()).trashedCount).toBe(1);
    expect(driveFiles[FILE].trashed).toBe(true);
    expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(FILE).docGone).toBe(2);
    const res = await post('ADMIN', '/api/admin/restore-orphan', { fileId: FILE });
    expect(res.status).toBe(200);
    expect(driveFiles[FILE].trashed).toBe(false);
    expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(FILE).docGone).toBe(0);
    expect(JSON.parse(sdb.prepare("SELECT details FROM audit_logs WHERE action = 'ORPHAN_RESTORE'").get().details)).toMatchObject({ fileId: FILE, attachmentId: `ATT-${FILE}`, fileName: 'p.png' });
    expect((await post('ADMIN', '/api/admin/restore-orphan', { fileId: FILE })).status).toBe(404); // nothing left to restore
  });

  it('admin only ; bad / unknown ids ; a file that is not in the upload folder is not touched', async () => {
    sdb.prepare('UPDATE attachments SET docGone = 2').run();
    gcalls.length = 0;
    expect((await post('PD', '/api/admin/restore-orphan', { fileId: FILE })).status).toBe(403);
    expect(gcalls.length).toBe(0);
    expect((await post('ADMIN', '/api/admin/restore-orphan', {})).status).toBe(400);
    expect((await post('ADMIN', '/api/admin/restore-orphan', { fileId: '../x' })).status).toBe(400);
    expect((await post('ADMIN', '/api/admin/restore-orphan', { fileId: 'NEVERUPLOADED0123456789' })).status).toBe(404);
    driveFiles[FILE].parents = ['SOMEOTHERFOLDER1234567'];
    expect((await post('ADMIN', '/api/admin/restore-orphan', { fileId: FILE })).status).toBe(409);
    expect(sdb.prepare('SELECT docGone FROM attachments WHERE fileId = ?').get(FILE).docGone).toBe(2);
  });
});

// ───────────────────────────── backfill script for existing D1 data ─────────────────────────────
describe.skipIf(!DatabaseSync)('P6 backfill-file-refs.js (local sqlite only)', () => {
  it('reports by default, writes SQL with --out, inserts with --apply ; INSERT OR IGNORE so it can be run twice ; free text is not a reference', async () => {
    const { runBackfill } = await import('../scripts/backfill-file-refs.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpo-backfill-test-'));
    const dbFile = path.join(dir, 'd1.sqlite');
    const sqlFile = path.join(dir, 'out.sql');
    try {
      const sdb = newDb();
      sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson, extraJson) VALUES ('p1','PD001/2026','PD','DRAFT','[]',?,?)")
        .run(JSON.stringify([{ fileId: 'BACKFILLFILE01234567890' }]), JSON.stringify({ note: 'see FREETEXTBACKFILE0123456' }));
      sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, extraJson) VALUES ('o1','PO-PD-1','PD','ORDERED','[]',?)").run(JSON.stringify({ prAttachments: [{ fileId: 'BACKFILLPOFILE0123456789' }] }));
      sdb.prepare("INSERT INTO pr_items (id, prId, imageUrl) VALUES ('i1','p1','https://drive.google.com/uc?id=BACKFILLITEMFILE0123456')").run();
      sdb.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
      sdb.close();
      const r1 = runBackfill({ db: dbFile });
      expect(r1).toMatchObject({ toAdd: 3, applied: false, wroteSql: false });
      const peek = new DatabaseSync(dbFile);
      expect(peek.prepare('SELECT COUNT(*) c FROM file_refs').get().c).toBe(0); // report only
      peek.close();
      const r2 = runBackfill({ db: dbFile, out: sqlFile });
      expect(r2.wroteSql).toBe(true);
      const text = fs.readFileSync(sqlFile, 'utf8');
      expect(text.match(/INSERT OR IGNORE INTO file_refs/g).length).toBe(3);
      expect(text).not.toContain('FREETEXTBACKFILE');
      expect(() => runBackfill({ db: dbFile, out: sqlFile })).toThrow(); // never overwrites
      expect(runBackfill({ db: dbFile, apply: true })).toMatchObject({ toAdd: 3, applied: true });
      expect(runBackfill({ db: dbFile, apply: true })).toMatchObject({ toAdd: 0, alreadyIndexed: 3 });
      expect(() => runBackfill({ db: path.join(dir, 'nope.sqlite') })).toThrow();
      expect(() => runBackfill({ db: sqlFile })).toThrow(); // not a sqlite file name
    } finally {
      for (const f of [sqlFile, dbFile]) { try { fs.unlinkSync(f); } catch { /* not created */ } }
      try { fs.rmdirSync(dir); } catch { /* not empty : left for the OS temp cleanup */ }
    }
  });
});

// ───────────────────────────── 8. Pages security headers ─────────────────────────────
describe('P6 B8 : public/_headers (Cloudflare Pages)', () => {
  const headers = readRel('public', '_headers');
  const csp = (headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';
  const directive = (name) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
  const indexHtml = fs.existsSync(path.join(here, '..', 'dist', 'index.html')) ? readRel('dist', 'index.html') : readRel('index.html');

  it('has the standard hardening headers for every path', () => {
    expect(headers).toMatch(/^\/\*\s*$/m);
    expect(headers).toMatch(/^\s*X-Frame-Options:\s*DENY\s*$/m);
    expect(headers).toMatch(/^\s*X-Content-Type-Options:\s*nosniff\s*$/m);
    expect(headers).toMatch(/^\s*Referrer-Policy:\s*\S+/m);
    expect(headers).toMatch(/^\s*Permissions-Policy:\s*\S+/m);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('object-src')).not.toContain('*');
  });

  it('script-src stays free of unsafe-inline / unsafe-eval and the built index.html has no inline script', () => {
    const scripts = directive('script-src');
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain('*');
    const tags = [...indexHtml.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const attrs of tags) expect(attrs, 'every <script> is an external file').toMatch(/\bsrc=/);
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=\s*["']/i); // no inline event handlers
  });

  it('allows exactly what the app loads from outside', () => {
    // fonts of index.html
    for (const m of indexHtml.matchAll(/(?:href|src)="(https:\/\/[^"/]+)/g)) {
      const host = m[1];
      const all = csp;
      if (host === 'https://fonts.googleapis.com') expect(directive('style-src')).toContain(host);
      else if (host === 'https://fonts.gstatic.com') expect(directive('font-src')).toContain(host);
      else expect(all, `index.html loads ${host}`).toContain(host);
    }
    expect(directive('style-src')).toContain("'unsafe-inline'"); // loading shell <style> + React style=""
    // files proxied as blob: (images, PDF in an iframe), embedded data: images, legacy Drive thumbnails
    expect(directive('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:', 'https://drive.google.com', 'https://lh3.googleusercontent.com']));
    expect(directive('img-src')).not.toContain('https://*.googleusercontent.com'); // only the lh3-lh6 hosts the server accepts (sanitize.js DRIVE_HOST_RE)
    expect(directive('frame-src')).toEqual(expect.arrayContaining(['blob:', 'https://drive.google.com']));
    expect(directive('connect-src')).toEqual(expect.arrayContaining(["'self'"]));
  });

  it('no third-party script / font CDN : the PO PDF libraries and fonts come from the app itself', () => {
    const pdf = readRel('src', 'utils', 'generatePoPdf.js');
    expect(pdf).not.toMatch(/import\(\s*['"]https?:/);
    expect(pdf).toMatch(/import\(\s*'pdf-lib'\s*\)/);
    expect(pdf).toMatch(/import\(\s*'@pdf-lib\/fontkit'\s*\)/);
    expect(pdf).toContain("'/fonts/THSarabunNew.ttf'");
    expect(fs.existsSync(path.join(here, '..', 'public', 'fonts', 'THSarabunNew.ttf'))).toBe(true);
    expect(fs.existsSync(path.join(here, '..', 'public', 'fonts', 'THSarabunNew-Bold.ttf'))).toBe(true);
    for (const host of ['esm.sh', 'cdn.jsdelivr.net']) expect(headers.replace(/^#.*$/gm, '')).not.toContain(host);
    expect(directive('script-src')).toEqual(["'self'"]);
    // the file the _headers comment points to is this one
    expect(headers).toContain('tests/cf_p6_phase2.test.js');
    expect(headers).not.toContain('cf_headers.test.js');
  });

  it('a Pages _headers file is plain "path / indented header" lines (no stray text that Pages would reject)', () => {
    const lines = headers.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    for (const l of lines) {
      if (/^\s/.test(l)) expect(l.trim(), 'header line').toMatch(/^[A-Za-z-]+:\s*\S/);
      else expect(l.trim(), 'path line').toMatch(/^\/\S*$/);
    }
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(2000); // Pages limit per header rule
  });
});
