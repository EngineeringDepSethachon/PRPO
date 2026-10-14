// @vitest-environment node
// R2 stage B : wrangler/R2 config, scripts/migrate-files.js (dry-run only, read only), pictureUrl rejects the /api/files proxy path, client proxy id
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run, parseArgs, dryRun, NOT_SUPPORTED_MSG } from '../scripts/migrate-files.js';
import { sanitizeUrlField } from '../functions/_lib/sanitize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

describe('R2 config', () => {
  it('wrangler.toml (production + preview) binds FILES to the right buckets and sets FILE_STORAGE = r2', () => {
    const t = read('wrangler.toml');
    expect(t).toMatch(/\[\[r2_buckets\]\]\s*\r?\nbinding = "FILES"\s*\r?\nbucket_name = "prpo-files"/);
    expect(t).toMatch(/\[\[env\.preview\.r2_buckets\]\]\s*\r?\nbinding = "FILES"\s*\r?\nbucket_name = "prpo-files-preview"/);
    expect(t).toMatch(/\[vars\]\s*\r?\nFILE_STORAGE = "r2"/);
    expect(t).toMatch(/\[env\.preview\.vars\]\s*\r?\nFILE_STORAGE = "r2"/);
  });
  it('wrangler.toml.example and the prepare-cloudflare.js templates carry the same bindings', () => {
    for (const f of ['wrangler.toml.example', 'scripts/prepare-cloudflare.js']) {
      const t = read(f);
      expect(t, f).toContain('binding = "FILES"');
      expect(t, f).toContain('bucket_name = "prpo-files"');
      expect(t, f).toContain('bucket_name = "prpo-files-preview"');
      expect(t, f).toContain('FILE_STORAGE = "r2"');
    }
  });
  it('.dev.vars.example documents FILE_STORAGE without a secret ; playwright.cf.config.js gives the e2e a local R2 binding', () => {
    expect(read('.dev.vars.example')).toMatch(/FILE_STORAGE/);
    const pw = read('playwright.cf.config.js');
    expect(pw).toContain('--r2 FILES');
    expect(pw).not.toMatch(/--remote|--experimental-json-config/);
  });
});

describe('migrate-files.js (dry run only)', () => {
  it('parses the documented flags', () => {
    expect(parseArgs(['--from', 'r2', '--to', 'drive', '--dry-run', '--limit', '5', '--doc', 'PO-1', '--db', 'x.sqlite'])).toMatchObject({ from: 'r2', to: 'drive', dryRun: true, limit: '5', doc: 'PO-1', db: 'x.sqlite' });
    expect(() => parseArgs(['--remote'])).toThrow();
  });
  it('without --dry-run it refuses with the "ยังไม่รองรับ" message (nothing is opened)', () => {
    expect(() => run({ from: 'r2', to: 'drive', db: 'nope.sqlite' })).toThrow(/ยังไม่รองรับ/);
    expect(NOT_SUPPORTED_MSG).toContain('ยังไม่รองรับ');
  });
  it('other directions are refused as not supported yet', () => {
    expect(() => dryRun({ from: 'drive', to: 'r2', db: 'nope.sqlite' })).toThrow(/ยังไม่รองรับ/);
  });
  it('needs a local sqlite file', () => {
    expect(() => run({ dryRun: true, from: 'r2', to: 'drive' })).toThrow(/--db/);
    expect(() => run({ dryRun: true, from: 'r2', to: 'drive', db: 'https://example.com/x.sqlite' })).toThrow(/--db/);
  });

  describe.skipIf(!DatabaseSync)('against a local sqlite', () => {
    const R2A = '11111111-1111-4111-8111-111111111111';
    const R2B = '22222222-2222-4222-8222-222222222222';
    const R2C = '33333333-3333-4333-8333-333333333333';
    const DRV = 'DRIVEFILEIDDRIVEFILEID01';
    function withDb(fn) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpo-migfiles-'));
      const file = path.join(dir, 'm.sqlite');
      try {
        const sdb = new DatabaseSync(file);
        for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) sdb.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
        const ins = sdb.prepare('INSERT INTO attachments (id, fileId, fileName, mimeType, fileSize, category, docRef, createdAtMs, storage, objectKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        ins.run('A1', R2A, 'a.png', 'image/png', 1000, 'PR', 'PD001/2026', 1, 'r2', 'PR/2026/10/PD001_2026/a__a.png');
        ins.run('A2', R2B, 'b.pdf', 'application/pdf', 3 * 1048576, 'PO', 'PO-PD-2026-001', 2, 'r2', 'PO/2026/10/PO-PD-2026-001/b__b.pdf');
        ins.run('A3', R2C, 'c.png', 'image/png', 50, 'GRN', 'PO-PD-2026-001', 3, 'r2', null); // r2 row without a key : reported, not counted
        ins.run('A4', DRV, 'd.png', 'image/png', 70, 'PR', 'PD001/2026', 4, 'drive', null); // already Drive : never listed
        sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('pr1', 'PD001/2026', 'PD', 'SUBMITTED', '[]', ?)")
          .run(JSON.stringify([{ id: 'A1', fileId: R2A, url: `/api/files/${R2A}`, name: 'a.png' }]));
        sdb.close();
        return fn(file);
      } finally {
        // Windows can hold a just-written file for a moment (scanner / indexer) : retry the unlink of OUR OWN temp files, one by one
        for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
          for (let i = 0; i < 40; i++) {
            try { fs.unlinkSync(f); break; } catch (e) {
              if (e.code === 'ENOENT') break;
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            }
          }
        }
        try { fs.rmdirSync(dir); } catch { /* leftover empty-ish temp dir is harmless */ }
      }
    }

    it('counts the r2 files / bytes / batches / estimate and lists the documents that embed their ids', () => {
      withDb((db) => {
        const r = run({ dryRun: true, from: 'r2', to: 'drive', db });
        expect(r).toMatchObject({ mode: 'dry-run', files: 2, skippedWithoutKey: 1, totalBytes: 1000 + 3 * 1048576, batches: 1 });
        expect(r.estimatedSeconds).toBeGreaterThan(0);
        expect(r.byCategory).toMatchObject({ PR: { files: 1, bytes: 1000 }, PO: { files: 1, bytes: 3 * 1048576 } });
        expect(r.documents).toEqual([{ docTable: 'prs', docId: 'pr1', docNo: 'PD001/2026', fileIds: [R2A] }]);
      });
    });
    it('--limit and --doc narrow the plan', () => {
      withDb((db) => {
        expect(run({ dryRun: true, from: 'r2', to: 'drive', db, limit: '1' }).files).toBe(1);
        const d = run({ dryRun: true, from: 'r2', to: 'drive', db, doc: 'PO-PD-2026-001' });
        expect(d.files).toBe(1);
        expect(d.documents).toEqual([]);
        expect(() => run({ dryRun: true, from: 'r2', to: 'drive', db, limit: '0' })).toThrow(/--limit/);
      });
    });
    it('is read only : the database file is byte-identical afterwards', () => {
      withDb((db) => {
        const before = fs.readFileSync(db);
        run({ dryRun: true, from: 'r2', to: 'drive', db });
        expect(Buffer.compare(before, fs.readFileSync(db))).toBe(0);
      });
    });
  });

  it('never talks to a remote or the secrets files', () => {
    const src = read('scripts/migrate-files.js');
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/fetch\(|wrangler|spawn|exec\(|\.env|\.dev\.vars|--remote/);
  });
});

describe('users.pictureUrl vs the R2 proxy path', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  it('does not accept /api/files/<id> (a plain <img> cannot send the token)', () => {
    expect(sanitizeUrlField(`/api/files/${ID}`)).toEqual({ value: '' });
    expect(sanitizeUrlField(`/api/files/${ID}?download=1`)).toEqual({ value: '' });
  });
  it('still accepts the Drive allow-list and data:image as before', () => {
    expect(sanitizeUrlField('https://lh3.googleusercontent.com/d/ABCDEFGHIJKLMNOPQRSTUVWX')).toEqual({ value: 'https://lh3.googleusercontent.com/d/ABCDEFGHIJKLMNOPQRSTUVWX' });
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeUrlField(png)).toEqual({ value: png });
    expect(sanitizeUrlField('https://evil.example/x.png')).toEqual({ value: '' });
  });
});
