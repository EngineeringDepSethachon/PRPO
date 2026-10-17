#!/usr/bin/env node
// M12 B3 - codemod: Tailwind tiny arbitrary font sizes -> text-xs
//
//   text-[8px] text-[9px] text-[10px] text-[10.5px] text-[11px] text-[13px]  ->  text-xs
//   (variants such as sm: md: lg: hover: group-hover: print: and the ! important prefix are preserved)
//
// Usage:
//   node scripts/codemod-font-scale.mjs           dry-run (prints table, writes nothing)
//   node scripts/codemod-font-scale.mjs --write   apply changes to files
//
// Scope: src/**/*.{js,jsx}, minus the exclusion list in isExcluded().
// Untouched on purpose: text-[12px], text-[14px], `fontSize: 10` style objects, dynamic text-[${...}].
// Idempotent: a second run finds nothing to change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TINY_SIZES = ['8', '9', '10', '10.5', '11', '13'];
export const REPLACEMENT = 'text-xs';

// <variants>(!)text-[<size>px] bounded by start / whitespace / quote / backtick / ${ on the left,
// and end / whitespace / quote / backtick / ${ on the right.
const SIZE_ALT = TINY_SIZES.map((s) => s.replace('.', '\\.')).join('|');
const TOKEN_RE = new RegExp(
  '(?<=^|[\\s"\'`]|\\$\\{)' +
    '((?:[^\\s"\'`:]+:)*)' + // variants (captured)
    '(!?)' + // important
    `text-\\[(?:${SIZE_ALT})px\\]` +
    '(?=$|[\\s"\'`]|\\$\\{)',
  'g'
);

/**
 * Dedupe tokens within one string segment: keep the first occurrence of every
 * token that was produced by the replacement. Returns { text, removed }.
 */
function dedupeSegment(text, producedTokens) {
  const parts = text.split(/(\s+)/); // even index = token, odd index = whitespace
  const seen = new Set();
  const keep = [];
  let removed = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const tok = parts[i];
    const ws = i > 0 ? parts[i - 1] : '';
    if (producedTokens.has(tok)) {
      if (seen.has(tok)) {
        removed++;
        continue; // drop token and the whitespace in front of it
      }
      seen.add(tok);
    }
    if (i > 0) keep.push(ws);
    keep.push(tok);
  }
  return { text: keep.join(''), removed };
}

/**
 * @param {string} source
 * @returns {{ out: string, count: number, warnings: string[] }}
 */
export function transformSource(source) {
  let count = 0;
  const warnings = [];

  // Work per "string segment" (text between quote / backtick characters) so that
  // duplicate detection only looks at one class list.
  const out = source.replace(/[^"'`]+/g, (segment, offset) => {
    const produced = new Set();
    let segCount = 0;
    let replaced = segment.replace(TOKEN_RE, (_m, variants, important) => {
      segCount++;
      const tok = `${variants}${important}${REPLACEMENT}`;
      produced.add(tok);
      return tok;
    });
    if (segCount === 0) return segment;
    count += segCount;

    const dd = dedupeSegment(replaced, produced);
    if (dd.removed > 0) {
      const line = source.slice(0, offset).split('\n').length;
      warnings.push(
        `line ${line}: ${dd.removed} duplicate "${REPLACEMENT}" class removed after replacement`
      );
      replaced = dd.text;
    }
    return replaced;
  });

  return { out, count, warnings };
}

function toPosix(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * True when a project-relative path must NOT be transformed.
 * @param {string} relPath e.g. "src/components/po/PrintablePO.jsx"
 */
export function isExcluded(relPath) {
  const p = toPosix(relPath);
  const base = p.split('/').pop();
  if (p === 'src/components/po/PrintablePO.jsx') return true;
  if (base.includes('POPrintTemplate')) return true;
  if (p === 'src/utils/generatePoPdf.js') return true;
  if (/(^|\/)__tests__(\/|$)/.test(p)) return true;
  return false;
}

/** True for src/**\/*.{js,jsx}. */
export function isInScope(relPath) {
  const p = toPosix(relPath);
  return p.startsWith('src/') && /\.(js|jsx)$/.test(p);
}

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walk(full, acc);
    } else if (ent.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function countMatches(source, re) {
  return (source.match(re) || []).length;
}

export function run({ root, write }) {
  const srcDir = path.join(root, 'src');
  const files = walk(srcDir)
    .map((f) => toPosix(path.relative(root, f)))
    .filter((rel) => isInScope(rel) && !isExcluded(rel))
    .sort();

  const rows = [];
  const allWarnings = [];
  let total = 0;
  let left12 = 0;
  let left14 = 0;

  for (const rel of files) {
    const abs = path.join(root, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const { out, count, warnings } = transformSource(src);
    left12 += countMatches(out, /text-\[12px\]/g);
    left14 += countMatches(out, /text-\[14px\]/g);
    if (count > 0) {
      rows.push({ file: rel, count });
      total += count;
      for (const w of warnings) allWarnings.push(`${rel}: ${w}`);
      if (write && out !== src) fs.writeFileSync(abs, out, 'utf8');
    }
  }

  return { rows, total, warnings: allWarnings, left12, left14, scanned: files.length };
}

function main() {
  const write = process.argv.includes('--write');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = run({ root, write });

  console.log(write ? 'MODE: WRITE (files modified)' : 'MODE: DRY-RUN (no files written)');
  console.log(`Scanned ${res.scanned} files in src/**/*.{js,jsx} (exclusions applied)\n`);
  if (res.rows.length === 0) {
    console.log('Nothing to change.');
  } else {
    const w = Math.max(...res.rows.map((r) => r.file.length));
    console.log(`${'File'.padEnd(w)}  Changes`);
    console.log(`${'-'.repeat(w)}  -------`);
    for (const r of res.rows) console.log(`${r.file.padEnd(w)}  ${String(r.count).padStart(7)}`);
    console.log(`${'-'.repeat(w)}  -------`);
    console.log(`${'TOTAL'.padEnd(w)}  ${String(res.total).padStart(7)}  (${res.rows.length} files)`);
  }
  console.log(`\nWarnings: ${res.warnings.length}`);
  for (const w of res.warnings) console.log(`  - ${w}`);
  console.log(
    `\nRemaining in scope (untouched by design): text-[12px] x${res.left12}, text-[14px] x${res.left14}`
  );
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main();
