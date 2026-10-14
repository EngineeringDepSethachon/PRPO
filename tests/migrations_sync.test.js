// @vitest-environment node
// migrations/ (root) = the ONLY source of truth. cloudflare/migrations/ must not exist (or be empty) and prepare-cloudflare must not recreate it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'migrations');
const COPY = path.join(ROOT, 'cloudflare', 'migrations');

describe('migrations/ at root is the single source of truth', () => {
  it('migrations/ has SQL files', () => {
    expect(fs.readdirSync(SRC).filter((n) => /\.sql$/i.test(n)).length).toBeGreaterThan(0);
  });

  it('cloudflare/migrations does not exist (or is empty)', () => {
    const files = fs.existsSync(COPY) ? fs.readdirSync(COPY) : [];
    expect(files, 'delete the stale copies in cloudflare/migrations').toEqual([]);
  });

  it('prepare-cloudflare.js does not copy migrations any more', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-cloudflare.js'), 'utf8');
    expect(src).not.toMatch(/copyRecursiveSync\([^)]*migrations/);
    expect(src).not.toMatch(/CF_DIR,\s*'migrations'/);
  });

  it('the wrangler.toml / .example templates inside prepare-cloudflare.js carry migrations_dir = "../migrations" (survives a re-run)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-cloudflare.js'), 'utf8');
    const m = src.match(/migrations_dir = "\.\.\/migrations"/g) || [];
    expect(m.length).toBeGreaterThanOrEqual(3); // toml prod + toml preview + example
    const toml = src.slice(src.indexOf('const wranglerTomlContent'), src.indexOf('const wranglerTomlContent') + 1200);
    expect(toml).toContain('migrations_dir = "../migrations"');
  });

  it('migration numbers are unique and contiguous up to 0013 ; 0013 (attachments storage) is additive only', () => {
    const names = fs.readdirSync(SRC).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
    const nums = names.map((n) => Number(n.slice(0, 4)));
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.slice(0, 13)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const sql = fs.readFileSync(path.join(SRC, '0013_attachments_storage.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bDROP\b/i);
    for (const col of ['storage TEXT NOT NULL DEFAULT \'drive\'', 'objectKey TEXT', 'migratedFrom TEXT']) expect(sql).toContain(`ADD COLUMN ${col}`);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_attachments_storage ON attachments\(storage\)/);
  });

  it('cloudflare/wrangler.toml points migrations_dir at ../migrations', () => {
    const toml = fs.readFileSync(path.join(ROOT, 'cloudflare', 'wrangler.toml'), 'utf8');
    expect(toml).toMatch(/^\s*migrations_dir\s*=\s*"\.\.\/migrations"/m);
  });
});
