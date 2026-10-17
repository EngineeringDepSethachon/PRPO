// @vitest-environment jsdom
// QA (prae) : M11 A2/A3 FR-03 - ProductActionCard + OnlineOrderCard (edge / error / security / responsive)
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

vi.mock('../src/components/common/ImageLightboxModal', () => ({
  default: ({ isOpen, images, initialIndex, title }) => (
    isOpen ? (
      <div data-testid="lightbox" data-index={String(initialIndex)} data-title={title} data-count={String(images?.length || 0)} />
    ) : null
  )
}));

import ProductActionCard from '../src/components/procurement/ProductActionCard';
import OnlineOrderCard from '../src/views/procurement/OnlineOrderCard';
import { AppProvider } from '../src/context/AppContext';
import { storageService } from '../src/services/storageService';

const read = (...p) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

const IMG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const IMG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const mkImg = (u, n) => ({ url: u, previewUrl: u, name: n });
const oneImage = [mkImg(IMG1, 'a.png')];
const threeImages = [mkImg(IMG1, 'a.png'), mkImg(IMG2, 'b.png'), mkImg(IMG1, 'c.png')];

const baseItem = { id: 'ITM-QA', code: 'ITM-QA', name: 'สินค้าทดสอบ QA', unit: 'ชิ้น' };

const renderCard = (props = {}) => render(
  <ProductActionCard
    item={baseItem}
    products={[]}
    url="https://shopee.co.th/product/1/2"
    platform="Shopee"
    qty={3}
    unit="ชิ้น"
    price={100}
    images={oneImage}
    onOpenImage={() => {}}
    {...props}
  />
);

const stubClipboard = (writeText) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
};
const removeClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeClipboard();
  try { delete document.execCommand; } catch { /* ignore */ }
});

describe('QA ProductActionCard : URL edge case', () => {
  it('URL ไม่มี protocol (www.lazada.co.th/...) -> href เติม https:// และป้าย Lazada + โดเมนตัด www', () => {
    renderCard({ url: 'www.lazada.co.th/products/abc', platform: '' });
    const cta = screen.getByTestId('product-card-cta');
    expect(cta.getAttribute('href')).toBe('https://www.lazada.co.th/products/abc');
    const badge = screen.getByTestId('product-card-platform').textContent;
    expect(badge).toContain('Lazada');
    expect(badge).toContain('lazada.co.th');
  });

  it('URL มีช่องว่างหน้า-หลัง -> trim ก่อนเป็น href', () => {
    renderCard({ url: '   https://shopee.co.th/a/b   ' });
    expect(screen.getByTestId('product-card-cta').getAttribute('href')).toBe('https://shopee.co.th/a/b');
  });

  it('http:// (ไม่ใช่ https) ยังเปิดได้และคง protocol เดิม', () => {
    renderCard({ url: 'http://example.org/p?id=1&x=2' });
    expect(screen.getByTestId('product-card-cta').getAttribute('href')).toBe('http://example.org/p?id=1&x=2');
  });

  it.each([
    ['ftp://files.example.com/a'],
    ['mailto:someone@example.com'],
    ['file:///etc/passwd'],
    ['blob:http://localhost/123'],
    ['about:blank'],
    ['   '],
    [null],
    [12345],
    [{ href: 'https://x.com' }]
  ])('URL ที่ใช้ไม่ได้ (%j) -> ไม่มี CTA ไม่มีปุ่มคัดลอก ไม่ crash', (bad) => {
    const { container } = renderCard({ url: bad });
    expect(screen.queryByTestId('product-card-cta')).toBeNull();
    expect(screen.queryByTestId('product-card-copy')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
    expect(screen.getByTestId('product-card-no-link')).toBeTruthy();
  });

  it('URL มี tab/ขึ้นบรรทัดแทรกใน scheme (java\\tscript:) -> ไม่เกิด href ที่ขึ้นต้นด้วย javascript:', () => {
    const { container } = renderCard({ url: 'java\tscript:alert(1)' });
    const a = container.querySelector('a[href]');
    if (a) expect(a.getAttribute('href').toLowerCase().startsWith('javascript:')).toBe(false);
  });

  it('คัดลอกลิงก์ของ URL ไม่มี protocol -> clipboard ได้ค่าที่ sanitize แล้ว (https://...)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderCard({ url: 'shopee.co.th/x/y' });
    await act(async () => { fireEvent.click(screen.getByTestId('product-card-copy')); });
    expect(writeText).toHaveBeenCalledWith('https://shopee.co.th/x/y');
  });

  it('ไม่มี navigator.clipboard แต่ document.execCommand("copy") ใช้ได้ -> แสดง "คัดลอกแล้ว" ไม่ขึ้นช่องกรอกมือ', async () => {
    removeClipboard();
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => true), configurable: true, writable: true });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByTestId('product-card-copy')); });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByTestId('product-card-copy').textContent).toContain('คัดลอกแล้ว');
    expect(screen.queryByLabelText(/ลิงก์สินค้า/)).toBeNull();
  });
});

describe('QA ProductActionCard : รูปภาพ', () => {
  it('3 รูป -> ป้าย +2 ; คลิก +2 -> onOpenImage(images,1,ชื่อ)', () => {
    const onOpenImage = vi.fn();
    renderCard({ images: threeImages, onOpenImage });
    const badge = screen.getByText('+2');
    fireEvent.click(badge);
    expect(onOpenImage).toHaveBeenCalledWith(threeImages, 1, baseItem.name);
  });

  it('ไม่ส่ง images -> ใช้ item.images เป็นรูปหลัก', () => {
    const { container } = renderCard({ images: undefined, item: { ...baseItem, images: oneImage } });
    expect(container.querySelector('img').getAttribute('src')).toBe(IMG1);
  });

  it('images มี null/undefined ปนอยู่ -> กรองทิ้ง ไม่ crash และ +N นับเฉพาะรูปจริง', () => {
    const onOpenImage = vi.fn();
    const { container } = renderCard({ images: [null, oneImage[0], undefined, threeImages[1]], onOpenImage });
    expect(container.querySelector('img')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(container.querySelector('img').closest('button'));
    expect(onOpenImage.mock.calls[0][0]).toHaveLength(2);
  });

  it('ไม่ส่ง onOpenImage -> คลิกรูปไม่ throw', () => {
    const { container } = renderCard({ onOpenImage: undefined });
    expect(() => fireEvent.click(container.querySelector('img').closest('button'))).not.toThrow();
  });
});

describe('QA ProductActionCard : โหมด/เนื้อหา', () => {
  it('readOnly -> data-readonly=true และการ์ดเองไม่มี stepper / input ตัวเลข', () => {
    const { container } = renderCard({ readOnly: true });
    expect(screen.getByTestId('product-action-card').getAttribute('data-readonly')).toBe('true');
    expect(container.querySelector('input[type="number"]')).toBeNull();
    expect(screen.queryByTitle('เพิ่มจำนวน')).toBeNull();
    expect(screen.queryByTitle('ลดจำนวน')).toBeNull();
  });

  it('ไม่ส่ง readOnly -> data-readonly=false', () => {
    renderCard();
    expect(screen.getByTestId('product-action-card').getAttribute('data-readonly')).toBe('false');
  });

  it('badges render ; ไม่มี badges -> ไม่มีกล่อง badges ; ไม่มี children -> ไม่มีกล่องควบคุม', () => {
    const { container, unmount } = renderCard({ badges: <span>ป้าย A</span> });
    expect(screen.getByText('ป้าย A')).toBeTruthy();
    unmount();
    const r2 = renderCard({});
    expect(r2.container.querySelector('[class*="empty:hidden"]')).toBeNull();
    expect(r2.container.querySelector('[class*="sm:ml-auto"]')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('nameExtra render ต่อท้ายชื่อ', () => {
    renderCard({ nameExtra: <button type="button" title="คัดลอกชื่อสินค้า">c</button> });
    expect(screen.getByTitle('คัดลอกชื่อสินค้า')).toBeTruthy();
  });

  it('หมายเหตุว่าง / มีแต่ช่องว่าง -> ไม่มีกรอบหมายเหตุ', () => {
    renderCard({ item: { ...baseItem, productRemark: '' } });
    expect(screen.queryByText(/สเปก\/หมายเหตุ/)).toBeNull();
    cleanup();
    renderCard({ item: { ...baseItem, productRemark: '   \n  ' } });
    expect(screen.queryByText(/สเปก\/หมายเหตุ/)).toBeNull();
  });

  it('มีหมายเหตุ -> แสดงกรอบ ; PR เก่าไม่มี productRemark -> ดึงจาก products ตาม productId', () => {
    renderCard({ item: { ...baseItem, productRemark: 'ใช้เกรดอาหารเท่านั้น' } });
    expect(screen.getByText(/สเปก\/หมายเหตุ/)).toBeTruthy();
    expect(screen.getByText(/ใช้เกรดอาหารเท่านั้น/)).toBeTruthy();
    cleanup();
    renderCard({
      item: { ...baseItem, productId: 'P-9' },
      products: [{ id: 'P-9', code: 'X', remark: 'ต้องมีใบรับรอง' }]
    });
    expect(screen.getByText(/ต้องมีใบรับรอง/)).toBeTruthy();
  });

  it('ชื่อสินค้าที่เป็น <script> แสดงเป็นข้อความ ไม่สร้าง element', () => {
    const { container } = renderCard({ item: { ...baseItem, name: '<script>window.__x=1</script>' } });
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>window.__x=1</script>');
    expect(window.__x).toBeUndefined();
  });

  it('ไม่มี code -> ใช้ sku ; ไม่มีทั้งคู่ -> "ITEM"', () => {
    renderCard({ item: { id: 'x', name: 'n', sku: 'SKU-9' } });
    expect(screen.getByText('SKU-9')).toBeTruthy();
    cleanup();
    renderCard({ item: { id: 'x', name: 'n' } });
    expect(screen.getByText('ITEM')).toBeTruthy();
  });

  it('qty / price ไม่ใช่ตัวเลข -> แสดง "-" ไม่ใช่ NaN', () => {
    renderCard({ qty: undefined, price: 'abc' });
    expect(screen.getByTestId('product-card-qty').textContent).toBe('-');
    expect(screen.getByTestId('product-card-price').textContent).toBe('-');
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('qty = 0 และจำนวนหลักล้าน -> format ถูก', () => {
    renderCard({ qty: 0, price: 0 });
    expect(screen.getByTestId('product-card-qty').textContent).toBe('0');
    expect(screen.getByTestId('product-card-price').textContent).toBe('฿0.00');
    cleanup();
    renderCard({ qty: 1234567, price: 1234.5 });
    expect(screen.getByTestId('product-card-qty').textContent).toBe('1,234,567');
    expect(screen.getByTestId('product-card-price').textContent).toBe('฿1,234.50');
  });

  it('item เป็น undefined -> ไม่ crash', () => {
    expect(() => renderCard({ item: undefined })).not.toThrow();
    expect(screen.getByText('ITEM')).toBeTruthy();
  });
});

describe('QA ProductActionCard : responsive 390px (ตรวจคลาส) + ความปลอดภัยเชิงโครงสร้าง', () => {
  it('layout: มือถือเรียงแนวตั้ง (flex-col) จอใหญ่เรียงแนวนอน ; คอลัมน์กลาง min-w-0 ; ชื่อ break-words ; ป้ายโดเมน break-all ; แถวปุ่ม flex-wrap', () => {
    const { container } = renderCard({ children: <div>c</div> });
    const root = screen.getByTestId('product-action-card');
    expect(root.className).toContain('flex-col');
    expect(root.className).toContain('sm:flex-row');
    expect(container.querySelector('.min-w-0.flex-1')).toBeTruthy();
    expect(screen.getByText(baseItem.name).className).toContain('break-words');
    expect(screen.getByTestId('product-card-platform').className).toContain('break-all');
    expect(screen.getByTestId('product-card-cta').parentElement.className).toContain('flex-wrap');
    // children เต็มความกว้างบนมือถือ
    expect(screen.getByText('c').parentElement.className).toContain('w-full');
  });

  it('ปุ่ม CTA และปุ่มคัดลอกลิงก์ min-h 44px ; รูป w-24 (96px) ขึ้นไป', () => {
    const { container } = renderCard();
    expect(screen.getByTestId('product-card-cta').className).toContain('min-h-[44px]');
    expect(screen.getByTestId('product-card-copy').className).toContain('min-h-[44px]');
    expect(container.querySelector('img').closest('button').className).toMatch(/\bw-24\b/);
  });

  it('source: ไม่มี dangerouslySetInnerHTML / "/api/" literal ; href ใช้ safeUrl ; ทุก target=_blank มี noopener noreferrer', () => {
    const src = read('src', 'components', 'procurement', 'ProductActionCard.jsx');
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toMatch(/['"`]\/api\//);
    expect(src).toContain('href={safeUrl}');
    expect(src.match(/href=\{/g) || []).toHaveLength(1);
    expect((src.match(/target="_blank"/g) || []).length).toBe((src.match(/rel="noopener noreferrer"/g) || []).length);
    expect(src).toContain('sanitizeExternalUrl');
    // clipboard ใช้ safeUrl เท่านั้น
    expect(src).toContain('writeText(safeUrl)');
    expect(src).not.toMatch(/writeText\((rawUrl|url)\)/);
  });

  it('source: OnlineOrderCard ไม่เพิ่ม "/api/" literal ใหม่ในโค้ด (ยกเว้นคอมเมนต์) และไม่ใช้ dangerouslySetInnerHTML', () => {
    const src = read('src', 'views', 'procurement', 'OnlineOrderCard.jsx');
    expect(src).not.toContain('dangerouslySetInnerHTML');
    const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('{/*'));
    expect(codeLines.filter(l => /['"`]\/api\//.test(l))).toEqual([]);
  });
});

// ── OnlineOrderCard integration ──
const role = { id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true };
const renderOrder = (po, activeTab, extra = {}) => render(
  <MemoryRouter>
    <AppProvider>
      <OnlineOrderCard po={po} activeTab={activeTab} currentRole={role} onUpdate={() => {}} {...extra} />
    </AppProvider>
  </MemoryRouter>
);

const mkPending = (itemOverrides = {}) => ({
  id: 'PO-QA-1', poNo: 'PO-QA-1', prNo: 'PR-QA-1', department: 'PD', purchaseChannel: 'ONLINE',
  status: 'PENDING_ORDER', vendorName: 'QA Shop', estimatedAmount: 1000, totalAmount: 1000,
  items: [{
    id: 'ITM-Q1', productId: 'PROD-Q1', sku: 'ITM-Q1', name: 'ท่อลมทดสอบ', qty: 5, purchaseQty: 5, price: 200, unitPrice: 200,
    unit: 'เส้น', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'QA Shop',
    productUrl: 'https://shopee.co.th/product/1/2', images: threeImages, attachments: threeImages,
    ...itemOverrides
  }]
});

describe('QA OnlineOrderCard : การ์ดสินค้า', () => {
  beforeEach(() => {
    localStorage.clear();
    storageService.resetData();
  });

  it('PENDING : 3 รูป -> แสดง +2 และคลิกแล้ว lightbox เปิดที่ลำดับ 1 จาก 3 รูป', () => {
    renderOrder(mkPending(), 'PENDING');
    const card = screen.getByTestId('product-action-card');
    fireEvent.click(within(card).getByText('+2'));
    const lb = screen.getByTestId('lightbox');
    expect(lb.getAttribute('data-index')).toBe('1');
    expect(lb.getAttribute('data-count')).toBe('3');
    expect(lb.getAttribute('data-title')).toBe('ท่อลมทดสอบ');
  });

  it('PENDING : productUrl เป็น javascript: -> ไม่มี CTA/ลิงก์ในการ์ด', () => {
    renderOrder(mkPending({ productUrl: 'javascript:alert(1)' }), 'PENDING');
    const card = screen.getByTestId('product-action-card');
    expect(within(card).queryByTestId('product-card-cta')).toBeNull();
    expect(card.querySelector('a[href]')).toBeNull();
    expect(within(card).getByText('ไม่มีลิงก์ร้านค้า')).toBeTruthy();
  });

  it('PENDING : ป้าย CTA มี target=_blank + rel=noopener noreferrer', () => {
    renderOrder(mkPending(), 'PENDING');
    const cta = screen.getByTestId('product-card-cta');
    expect(cta.getAttribute('target')).toBe('_blank');
    expect(cta.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('PENDING : ช่องจำนวนไม่ลงต่ำกว่า 1 (ปุ่มลดถูก disable ที่ 1) และ stepper ยังอยู่ในการ์ด', () => {
    renderOrder(mkPending({ qty: 1, purchaseQty: 1, actualQty: 1 }), 'PENDING');
    const card = screen.getByTestId('product-action-card');
    expect(within(card).getByTitle('ลดจำนวน').disabled).toBe(true);
    fireEvent.click(within(card).getByTitle('เพิ่มจำนวน'));
    expect(within(card).getByTitle('จำนวนสั่งซื้อจริง (เส้น)').value).toBe('2');
  });

  it('CLAIM : การ์ด readOnly ไม่มี stepper/ช่องราคารวม ; รายการ WAIT_NEXT_ROUND ถูกกรองออก เหลือรายการชำรุด', () => {
    const po = {
      id: 'PO-QA-2', poNo: 'PO-QA-2', prNo: 'PR-QA-2', department: 'PD', purchaseChannel: 'ONLINE',
      status: 'IN_CLAIM', hasDispute: true, vendorName: 'QA Shop', estimatedAmount: 1000, totalAmount: 1000,
      items: [
        {
          id: 'ITM-W', sku: 'ITM-W', name: 'รายการรอส่งรอบหน้า', qty: 4, purchaseQty: 4, price: 100, unitPrice: 100, unit: 'ชิ้น',
          platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'QA Shop',
          shortageQty: 1, damagedQty: 0, shortageAction: 'WAIT_NEXT_ROUND'
        },
        {
          id: 'ITM-D', sku: 'ITM-D', name: 'รายการชำรุด', qty: 4, purchaseQty: 4, price: 100, unitPrice: 100, unit: 'ชิ้น',
          platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'QA Shop',
          shortageQty: 0, damagedQty: 1, hasDispute: true
        }
      ]
    };
    renderOrder(po, 'CLAIM');
    const cards = screen.getAllByTestId('product-action-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('รายการชำรุด');
    expect(cards[0].textContent).not.toContain('รายการรอส่งรอบหน้า');
    expect(cards[0].getAttribute('data-readonly')).toBe('true');
    expect(cards[0].textContent).toContain('ชำรุด 1 ชิ้น');
    expect(cards[0].querySelector('input[type="number"]')).toBeNull();
    expect(within(cards[0]).queryByTitle('เพิ่มจำนวน')).toBeNull();
  });
});
