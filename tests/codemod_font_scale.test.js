// M12 B3 - codemod-font-scale: transformSource() + isExcluded()
import { describe, it, expect } from 'vitest';
import { transformSource, isExcluded, isInScope } from '../scripts/codemod-font-scale.mjs';

const cls = (s) => `<div className="${s}" />`;

describe('transformSource - sizes', () => {
  it.each(['8', '9', '10', '10.5', '11', '13'])('text-[%spx] -> text-xs', (n) => {
    const r = transformSource(cls(`p-2 text-[${n}px] font-bold`));
    expect(r.out).toBe(cls('p-2 text-xs font-bold'));
    expect(r.count).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('handles several tokens, quote styles and template literals', () => {
    const src = [
      `const a = 'text-[9px] text-gray-500';`,
      'const b = `flex text-[11px] ${x ? "text-[13px]" : ""}`;',
      `const c = "text-[8px]";`,
    ].join('\n');
    const r = transformSource(src);
    expect(r.count).toBe(4);
    expect(r.out).not.toMatch(/text-\[\d/);
    expect(r.out).toContain("'text-xs text-gray-500'");
    expect(r.out).toContain('`flex text-xs ${x ? "text-xs" : ""}`');
  });
});

describe('transformSource - variants and important', () => {
  it.each(['sm:', 'md:', 'lg:', 'hover:', 'group-hover:', 'print:', 'md:hover:'])(
    'keeps variant %s',
    (v) => {
      const r = transformSource(cls(`${v}text-[10px]`));
      expect(r.out).toBe(cls(`${v}text-xs`));
      expect(r.count).toBe(1);
    }
  );

  it('keeps the ! important prefix (with and without variant)', () => {
    expect(transformSource(cls('!text-[10px]')).out).toBe(cls('!text-xs'));
    expect(transformSource(cls('md:!text-[11px]')).out).toBe(cls('md:!text-xs'));
    expect(transformSource(cls('print:hover:!text-[9px]')).out).toBe(cls('print:hover:!text-xs'));
  });

  it('does not merge different variants of the same class', () => {
    const r = transformSource(cls('text-[10px] md:text-[10px] !text-[10px]'));
    expect(r.out).toBe(cls('text-xs md:text-xs !text-xs'));
    expect(r.count).toBe(3);
    expect(r.warnings).toEqual([]);
  });
});

describe('transformSource - dedupe + warning', () => {
  it('collapses duplicate text-xs after replacement and warns', () => {
    const r = transformSource(cls('text-xs text-[10px] font-bold'));
    expect(r.out).toBe(cls('text-xs font-bold'));
    expect(r.count).toBe(1);
    expect(r.warnings).toHaveLength(1);
  });

  it('collapses two different tiny sizes in one list', () => {
    const r = transformSource(cls('text-[10px] p-1 text-[11px]'));
    expect(r.out).toBe(cls('text-xs p-1'));
    expect(r.count).toBe(2);
    expect(r.warnings).toHaveLength(1);
  });

  it('dedupes when the original text-xs comes after the replaced one', () => {
    const r = transformSource(cls('text-[9px] mt-1 text-xs'));
    expect(r.out).toBe(cls('text-xs mt-1'));
    expect(r.warnings).toHaveLength(1);
  });

  it('dedupes variant duplicates only within the same variant', () => {
    const r = transformSource(cls('md:text-xs md:text-[10px] text-[10px]'));
    expect(r.out).toBe(cls('md:text-xs text-xs'));
    expect(r.warnings).toHaveLength(1);
  });

  it('does not dedupe across separate strings', () => {
    const r = transformSource(`const a = "text-xs"; const b = "text-[10px]";`);
    expect(r.out).toBe(`const a = "text-xs"; const b = "text-xs";`);
    expect(r.warnings).toEqual([]);
  });
});

describe('transformSource - untouched cases', () => {
  it('does not touch text-[12px] and text-[14px]', () => {
    const src = cls('text-[12px] md:text-[14px] !text-[12px]');
    const r = transformSource(src);
    expect(r.out).toBe(src);
    expect(r.count).toBe(0);
  });

  it('does not touch fontSize in style objects / chart props', () => {
    const src = [
      `<XAxis tick={{ fontSize: 10 }} />`,
      `<div style={{ fontSize: '11px' }} />`,
      `const s = { fontSize: 9, fontSize: "13px" };`,
    ].join('\n');
    const r = transformSource(src);
    expect(r.out).toBe(src);
    expect(r.count).toBe(0);
  });

  it('does not touch dynamic text-[${...}] values', () => {
    const src = 'const c = `text-[${size}px] text-[${n}px]`;';
    const r = transformSource(src);
    expect(r.out).toBe(src);
    expect(r.count).toBe(0);
  });

  it('does not touch longer / look-alike tokens', () => {
    const src = cls('text-[100px] text-[110px] text-[10px]/5 xtext-[10px] text-[10em] text-[1px]');
    const r = transformSource(src);
    expect(r.out).toBe(src);
    expect(r.count).toBe(0);
  });

  it('preserves CRLF line endings and surrounding code', () => {
    const src = 'const a = "text-[10px]";\r\nconst b = 1;\r\n';
    const r = transformSource(src);
    expect(r.out).toBe('const a = "text-xs";\r\nconst b = 1;\r\n');
  });
});

describe('transformSource - idempotent', () => {
  it('second pass changes nothing and counts 0', () => {
    const src = [
      cls('text-[10px] md:text-[11px] !text-[13px] text-[9px]'),
      'const t = `a text-[8px] ${x ? "text-[10.5px]" : ""}`;',
      cls('text-xs text-[10px]'),
    ].join('\n');
    const first = transformSource(src);
    expect(first.count).toBeGreaterThan(0);
    const second = transformSource(first.out);
    expect(second.out).toBe(first.out);
    expect(second.count).toBe(0);
    expect(second.warnings).toEqual([]);
  });
});

describe('isExcluded / isInScope', () => {
  it.each([
    'src/components/po/PrintablePO.jsx',
    'src\\components\\po\\PrintablePO.jsx',
    './src/components/po/PrintablePO.jsx',
    'src/components/po/POPrintTemplate.jsx',
    'src/components/po/POPrintTemplateV2.jsx',
    'src/utils/generatePoPdf.js',
    'src/services/__tests__/foo.test.js',
    'src/components/x/__tests__/Bar.jsx',
  ])('excludes %s', (p) => {
    expect(isExcluded(p)).toBe(true);
  });

  it.each([
    'src/components/po/PODetailsModal.jsx',
    'src/views/DashboardView.jsx',
    'src/utils/generatePoPdfHelper.js',
    'src/utils/formatters.js',
  ])('does not exclude %s', (p) => {
    expect(isExcluded(p)).toBe(false);
  });

  it('scope is src/**/*.{js,jsx} only', () => {
    expect(isInScope('src/a/b.jsx')).toBe(true);
    expect(isInScope('src/a/b.js')).toBe(true);
    expect(isInScope('src/a/b.css')).toBe(false);
    expect(isInScope('tests/a.js')).toBe(false);
    expect(isInScope('cloudflare/x.js')).toBe(false);
  });
});
