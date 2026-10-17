// @vitest-environment node
// M12 B4 - guard: no tiny arbitrary font sizes left in src/ ; tailwind fontSize scale present (Phase 3 FR-04)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcluded, isInScope } from '../scripts/codemod-font-scale.mjs';
import tailwindConfig from '../tailwind.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TINY_RE = /text-\[(8|9|10|10\.5|11|13)px\]/;

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

function scopedSourceFiles() {
  return walk(path.join(root, 'src'))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((rel) => isInScope(rel) && !isExcluded(rel))
    .sort();
}

describe('font scale guard', () => {
  it('scans a non-trivial set of src files', () => {
    expect(scopedSourceFiles().length).toBeGreaterThan(50);
  });

  it('no text-[8|9|10|10.5|11|13px] left in src/**/*.{js,jsx} (exclusions applied)', () => {
    const offenders = [];
    for (const rel of scopedSourceFiles()) {
      const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (TINY_RE.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('tailwind.config.js defines fontSize xs = 0.875rem in theme.extend', () => {
    const xs = tailwindConfig.theme.extend.fontSize.xs;
    expect(xs[0]).toBe('0.875rem');
    expect(xs[1]).toEqual({ lineHeight: '1.25rem' });
  });
});
