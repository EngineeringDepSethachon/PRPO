// @vitest-environment node
// QA (prae) - M12 FR-04 font scale: things the codemod/guard tests do not cover.
// Static checks only (no DOM). Run: npx vitest run tests/qa_font_scale.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindConfig from '../tailwind.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
      walk(full, acc);
    } else if (ent.isFile() && /\.(jsx?|tsx?)$/.test(ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const srcFiles = () =>
  walk(path.join(root, 'src')).map((f) => path.relative(root, f).split(path.sep).join('/'));

const PRINTABLE = 'src/components/po/PrintablePO.jsx';

describe('PrintablePO keeps its fixed px sizes (PDF/print layout must not scale)', () => {
  const src = read(PRINTABLE);

  it('uses no tailwind scale class for font size (xs/sm/base/lg/xl, any variant)', () => {
    const re = /(^|[\s"'`:])(?:[a-z-]+:)*!?text-(xs|sm|base|lg|xl)(?![\w-])/;
    const offenders = src.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => re.test(l)).map(([, n]) => n);
    expect(offenders).toEqual([]);
  });

  it('still declares its sizes as arbitrary px values', () => {
    const matches = src.match(/text-\[\d+(\.\d+)?px\]/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(40);
  });

  it('uses no rem/em arbitrary font sizes (would follow the root scale)', () => {
    expect(src).not.toMatch(/text-\[[\d.]+(rem|em)\]/);
  });

  it('keeps the inline px fontSize on the settlement lines', () => {
    expect(src).toMatch(/fontSize: '10px', lineHeight: '14px'/);
    expect(src).toMatch(/fontSize: '11px', lineHeight: '16px'/);
  });
});

describe('untouched areas stay untouched', () => {
  it('generatePoPdf.js has no tailwind classes', () => {
    const src = read('src/utils/generatePoPdf.js');
    expect(src).not.toMatch(/className/);
    expect(src).not.toMatch(/\btext-(xs|sm|base)\b/);
  });

  it('index.html shell loader font-size stays 14px', () => {
    expect(read('index.html')).toMatch(/\.shell-text\s*\{[^}]*font-size:\s*14px/);
  });

  it('recharts axis/legend fontSize in BudgetView unchanged (9/11 ticks, 12px legend)', () => {
    const src = read('src/views/BudgetView.jsx');
    expect(src).toContain('fontSize={timeRange > 12 ? 9 : 11}');
    expect(src).toContain('fontSize={11}');
    expect(src).toContain("fontSize: '12px'");
  });

  it('only xs-xl are overridden; 2xl and above come from the tailwind default', () => {
    const fs_ = tailwindConfig.theme.extend.fontSize;
    expect(Object.keys(fs_).sort()).toEqual(['base', 'lg', 'sm', 'xl', 'xs']);
    expect(tailwindConfig.theme.fontSize).toBeUndefined();
  });
});

describe('scale values (FR-04)', () => {
  it.each([
    ['xs', '0.875rem', '1.25rem'],
    ['sm', '1rem', '1.5rem'],
    ['base', '1.125rem', '1.75rem'],
    ['lg', '1.25rem', '1.75rem'],
    ['xl', '1.375rem', '1.875rem'],
  ])('%s = %s / %s', (k, size, lh) => {
    const v = tailwindConfig.theme.extend.fontSize[k];
    expect(v[0]).toBe(size);
    expect(v[1]).toEqual({ lineHeight: lh });
  });

  it('scale is strictly increasing', () => {
    const order = ['xs', 'sm', 'base', 'lg', 'xl'];
    const px = order.map((k) => parseFloat(tailwindConfig.theme.extend.fontSize[k][0]));
    for (let i = 1; i < px.length; i++) expect(px[i]).toBeGreaterThan(px[i - 1]);
  });
});

describe('consistency: no arbitrary font size shrinks text back below the new text-xs', () => {
  it('no text-[Npx|rem|em] anywhere in src except PrintablePO', () => {
    const offenders = [];
    for (const rel of srcFiles()) {
      if (rel === PRINTABLE) continue;
      read(rel).split(/\r?\n/).forEach((line, i) => {
        if (/text-\[\d+(\.\d+)?(px|rem|em)\]/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no inline style fontSize below 14 in jsx except PrintablePO and recharts props', () => {
    const offenders = [];
    for (const rel of srcFiles()) {
      if (rel === PRINTABLE || !rel.endsWith('.jsx')) continue;
      read(rel).split(/\r?\n/).forEach((line, i) => {
        if (/style=\{\{[^}]*fontSize:\s*['"]?(\d+)/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
