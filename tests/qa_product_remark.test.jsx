// @vitest-environment jsdom
// QA เพิ่มเติมสำหรับ FR-02 (M10 T1): edge case ของ getItemRemark / ProductRemarkNote
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ProductRemarkNote, { getItemRemark } from '../src/components/common/ProductRemarkNote';

afterEach(() => cleanup());

const products = [
  { id: 'P1', code: 'AB-001', name: 'A', remark: 'หมายเหตุ P1' },
  { id: 'P2', code: 'AB-002', name: 'B', remark: '   ' },
  { id: 'P3', code: 'AB-003', name: 'C', remark: 'หมายเหตุ P3' },
  { id: 7, code: 'NUM-7', name: 'D', remark: 'เลขล้วน' }
];

describe('QA FR-02 getItemRemark : edge case', () => {
  it('productRemark เป็นช่องว่างล้วน → ตกไปใช้ product.remark', () => {
    expect(getItemRemark({ productId: 'P1', productRemark: '   \n ' }, products)).toBe('หมายเหตุ P1');
  });

  it('productRemark และ product.remark เป็นช่องว่างล้วน → ""', () => {
    expect(getItemRemark({ productId: 'P2', productRemark: '  ' }, products)).toBe('');
  });

  it('productRemark ไม่ใช่ string (ตัวเลข/object) → ไม่พัง และตกไป product.remark', () => {
    expect(getItemRemark({ productId: 'P1', productRemark: 123 }, products)).toBe('หมายเหตุ P1');
    expect(getItemRemark({ productId: 'P1', productRemark: {} }, products)).toBe('หมายเหตุ P1');
    expect(getItemRemark({ productId: 'P1', productRemark: null }, products)).toBe('หมายเหตุ P1');
  });

  it('productRemark ถูก trim', () => {
    expect(getItemRemark({ productRemark: '  สเปก  ' }, [])).toBe('สเปก');
  });

  it('productRemark ใช้ได้แม้ไม่มี products เลย (undefined / null / ไม่ใช่ array)', () => {
    expect(getItemRemark({ productRemark: 'x' })).toBe('x');
    expect(getItemRemark({ productRemark: 'x' }, null)).toBe('x');
    expect(getItemRemark({ productId: 'P1' }, null)).toBe('');
    expect(getItemRemark({ productId: 'P1' }, {})).toBe('');
  });

  it('item.code ตรงแต่ productId ไม่ตรง → fallback ด้วย code (ไม่สนตัวพิมพ์/ช่องว่าง)', () => {
    expect(getItemRemark({ productId: 'ไม่มีจริง', code: ' ab-003 ' }, products)).toBe('หมายเหตุ P3');
  });

  it('productId ตรงแต่ code คนละตัว → ใช้ productId เป็นหลัก', () => {
    expect(getItemRemark({ productId: 'P1', code: 'AB-003' }, products)).toBe('หมายเหตุ P1');
  });

  it('productId ตรงสินค้าที่ไม่มี remark → ไม่ไปเอา remark ของสินค้าอื่นตาม code', () => {
    expect(getItemRemark({ productId: 'P2', code: 'AB-003' }, products)).toBe('');
  });

  it('productId เป็นตัวเลขเทียบกับ id string (และกลับกัน)', () => {
    expect(getItemRemark({ productId: '7' }, products)).toBe('เลขล้วน');
    expect(getItemRemark({ productId: 7 }, products)).toBe('เลขล้วน');
  });

  it('item ไม่มีทั้ง productId และ code (Non-Catalog) → ""', () => {
    expect(getItemRemark({ name: 'ของพิเศษ', isCustom: true }, products)).toBe('');
    expect(getItemRemark({ productId: '', code: '' }, products)).toBe('');
    expect(getItemRemark(undefined, products)).toBe('');
  });

  it('products มีสมาชิก null/undefined ปนอยู่ → ไม่พัง', () => {
    expect(getItemRemark({ productId: 'P1' }, [null, undefined, ...products])).toBe('หมายเหตุ P1');
    expect(getItemRemark({ code: 'AB-001' }, [null, { id: 'X' }, ...products])).toBe('หมายเหตุ P1');
  });
});

describe('QA FR-02 ProductRemarkNote : render', () => {
  it('remark ว่าง / ช่องว่างล้วน → ไม่ render อะไรเลย', () => {
    const a = render(<ProductRemarkNote item={{ productId: 'P1', productRemark: '   ' }} products={[]} />);
    expect(a.container.innerHTML).toBe('');
    cleanup();
    const b = render(<ProductRemarkNote item={{ productId: 'P2' }} products={products} />);
    expect(b.container.innerHTML).toBe('');
  });

  it('ข้อความที่มี HTML/สคริปต์ → แสดงเป็น text ไม่ถูกตีความเป็น element', () => {
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    const { container } = render(<ProductRemarkNote item={{ productRemark: evil }} products={[]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain(evil);
  });

  it('หมายเหตุหลายบรรทัด → คงข้อความครบ และ class รองรับการขึ้นบรรทัด', () => {
    const { container } = render(<ProductRemarkNote item={{ productRemark: 'บรรทัด1\nบรรทัด2' }} products={[]} />);
    expect(container.textContent).toContain('บรรทัด1\nบรรทัด2');
    expect(container.firstChild.className).toMatch(/whitespace-pre/);
    expect(container.firstChild.className).toMatch(/break-words/);
  });

  it('className จากผู้เรียกถูกต่อท้าย', () => {
    const { container } = render(<ProductRemarkNote item={{ productRemark: 'x' }} className="mt-9" />);
    expect(container.firstChild.className).toContain('mt-9');
  });

  it('ไม่ส่ง products เลย → ใช้ productRemark ของ item ได้', () => {
    render(<ProductRemarkNote item={{ productRemark: 'เฉพาะ item' }} />);
    expect(screen.getByText(/เฉพาะ item/)).toBeTruthy();
  });
});

describe('QA FR-02 source check', () => {
  const read = (...p) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

  it('ไฟล์ที่เกี่ยวข้องไม่มี dangerouslySetInnerHTML', () => {
    const files = [
      ['src', 'components', 'common', 'ProductRemarkNote.jsx'],
      ['src', 'views', 'PRCreateView.jsx'],
      ['src', 'components', 'pr', 'PRDetailsModal.jsx'],
      ['src', 'views', 'procurement', 'OnlineOrderCard.jsx'],
      ['src', 'components', 'po', 'PODetailsModal.jsx']
    ];
    for (const f of files) expect(read(...f)).not.toContain('dangerouslySetInnerHTML');
  });

  // M11 A2: แถวสินค้าใน OnlineOrderCard เปลี่ยนเป็น ProductActionCard (key ที่การ์ด ; หมายเหตุอยู่ในการ์ด ไม่ซ้ำสองที่)
  it('OnlineOrderCard : key ของ list อยู่ที่ ProductActionCard ทั้งสองแถว และหมายเหตุ render ในการ์ดที่เดียว', () => {
    const src = read('src', 'views', 'procurement', 'OnlineOrderCard.jsx');
    const cards = src.match(/<ProductActionCard\s+key=\{currentItem\.id \|\| resolvedIdx\}/g) || [];
    expect(cards.length).toBe(2);
    expect(src).not.toContain('<ProductRemarkNote');
    const card = read('src', 'components', 'procurement', 'ProductActionCard.jsx');
    expect(card.match(/<ProductRemarkNote item=\{item\}/g) || []).toHaveLength(1);
    expect(card).not.toContain('dangerouslySetInnerHTML');
  });

  it('PRCreateView : ไม่แสดงกล่องหมายเหตุกับรายการ Non-Catalog (isCustom)', () => {
    const src = read('src', 'views', 'PRCreateView.jsx');
    expect(src).toMatch(/!item\.isCustom && \(\s*<ProductRemarkNote/);
  });
});
