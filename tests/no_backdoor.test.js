// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(js|mjs|ts|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Drop comments; the one allowed code mention is the REJECTED_LEGACY_PASSWORDS deny-list.
function codeLines(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .filter((l) => !/const\s+REJECTED_LEGACY_PASSWORDS\s*=/.test(l));
}

describe('no hardcoded credentials / backdoors', () => {
  for (const dir of ['functions', 'cloudflare/functions']) {
    it(`${dir}/** has no admin123 / password123 (outside comments and the deny-list)`, () => {
      const files = listFiles(path.join(ROOT, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const hits = codeLines(fs.readFileSync(f, 'utf8')).filter((l) => /admin123|password123|123456/i.test(l));
        expect(hits, `${path.relative(ROOT, f)}`).toEqual([]);
      }
    });
  }

  it('cloudflare/functions is an exact copy of functions/ (run scripts/prepare-cloudflare.js)', () => {
    for (const f of listFiles(path.join(ROOT, 'functions'))) {
      const rel = path.relative(path.join(ROOT, 'functions'), f);
      const copy = path.join(ROOT, 'cloudflare', 'functions', rel);
      expect(fs.existsSync(copy), `missing ${rel}`).toBe(true);
      expect(fs.readFileSync(copy, 'utf8'), rel).toBe(fs.readFileSync(f, 'utf8'));
    }
  });

  it('no public R2 access : no r2.dev / r2.cloudflarestorage.com URL in code, no public bucket setting in wrangler config', () => {
    for (const dir of ['functions', 'cloudflare/functions', 'src']) {
      for (const f of listFiles(path.join(ROOT, dir))) {
        const hits = codeLines(fs.readFileSync(f, 'utf8')).filter((l) => /\br2\.dev\b|r2\.cloudflarestorage\.com|pub-[0-9a-f]{20,}/i.test(l));
        expect(hits, `${path.relative(ROOT, f)}`).toEqual([]);
      }
    }
    for (const f of ['wrangler.toml', 'wrangler.toml.example', 'cloudflare/wrangler.toml', 'cloudflare/wrangler.toml.example']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) continue;
      const code = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
      expect(code, f).not.toMatch(/r2\.dev|public_access|custom_domain|r2_dev/i);
    }
  });

  it('d1_schema.sql (root and cloudflare/) seeds no users', () => {
    for (const f of ['d1_schema.sql', 'cloudflare/d1_schema.sql']) {
      const sql = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(sql, f).not.toMatch(/INSERT\s+INTO\s+users/i);
      expect(sql, f).not.toMatch(/admin123|password123/i);
    }
  });

  it('wrangler.toml.example (root and cloudflare/) never pairs d1_schema.sql with --remote', () => {
    for (const f of ['wrangler.toml.example', path.join('cloudflare', 'wrangler.toml.example')]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const bad = src.split(/\r?\n/).filter((l) => /d1_schema\.sql/.test(l) && /--remote/.test(l));
      expect(bad, f).toEqual([]);
    }
  });

  it('cloudflare/package.json db:migrate applies migrations and never targets --remote', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudflare', 'package.json'), 'utf8'));
    expect(pkg.scripts['db:migrate']).toBe('npx wrangler d1 migrations apply prpo-db');
    for (const s of Object.values(pkg.scripts)) expect(s).not.toMatch(/--remote/);
  });
});
