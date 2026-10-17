// @vitest-environment jsdom
// M11 A2/A3 (FR-03): การ์ดสินค้าในงานจัดซื้อออนไลน์ (ProductActionCard) + การใช้งานใน OnlineOrderCard
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

// lightbox จริงใช้ portal/hook หลายตัว : แทนด้วยตัวแทนเรียบง่ายเพื่อตรวจว่าถูกเปิดด้วยรูป/ลำดับ/ชื่อที่ถูกต้อง
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

const IMG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const IMG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const baseItem = {
  id: 'ITM-001',
  code: 'ITM-001',
  name: 'สายรัดพาเลทอย่างหนา 15 มม.',
  unit: 'ม้วน'
};
const twoImages = [
  { url: IMG1, previewUrl: IMG1, name: 'a.png' },
  { url: IMG2, previewUrl: IMG2, name: 'b.png' }
];

const renderCard = (props = {}) => render(
  <ProductActionCard
    item={baseItem}
    products={[]}
    url="https://shopee.co.th/product/111/222"
    platform="Shopee"
    qty={10}
    unit="ม้วน"
    price={387.5}
    images={twoImages}
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
});

describe('ProductActionCard : รูปสินค้า', () => {
  it('รูปสินค้าขนาดใหญ่ w-24 (sm:w-28) และมีป้าย +N เมื่อมีมากกว่า 1 รูป', () => {
    const { container } = renderCard();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(IMG1);
    const thumb = img.closest('button');
    expect(thumb.className).toContain('w-24');
    expect(thumb.className).toContain('h-24');
    expect(thumb.className).toContain('sm:w-28');
    expect(thumb.className).toContain('rounded-xl');
    expect(img.className).toContain('object-cover');
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('รูปเดียว → ไม่มีป้าย +N', () => {
    renderCard({ images: [twoImages[0]] });
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it('คลิกรูป → onOpenImage(images, 0, ชื่อสินค้า) ; คลิก +N → ลำดับที่ 1', () => {
    const onOpenImage = vi.fn();
    const { container } = renderCard({ onOpenImage });
    fireEvent.click(container.querySelector('img').closest('button'));
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    expect(onOpenImage).toHaveBeenLastCalledWith(twoImages, 0, baseItem.name);
    fireEvent.click(screen.getByText('+1'));
    expect(onOpenImage).toHaveBeenLastCalledWith(twoImages, 1, baseItem.name);
  });

  it('ไม่มีรูป → กล่องว่างขนาด w-24 พร้อมไอคอน (ไม่มี img)', () => {
    const { container } = renderCard({ images: [] });
    expect(container.querySelector('img')).toBeNull();
    const box = screen.getByTestId('product-card-no-image');
    expect(box.className).toContain('w-24');
    expect(box.querySelector('svg')).toBeTruthy();
  });
});

describe('ProductActionCard : ลิงก์ร้านค้า', () => {
  it('CTA เป็น <a> ที่ href ผ่าน sanitize + target/rel + ป้าย Shopee และโดเมน', () => {
    renderCard({ url: 'shopee.co.th/product/111/222', platform: '' });
    const cta = screen.getByTestId('product-card-cta');
    expect(cta.tagName).toBe('A');
    expect(cta.getAttribute('href')).toBe('https://shopee.co.th/product/111/222');
    expect(cta.getAttribute('target')).toBe('_blank');
    expect(cta.getAttribute('rel')).toBe('noopener noreferrer');
    expect(cta.textContent).toContain('เปิดลิงก์ร้านค้าออนไลน์');
    expect(cta.className).toContain('min-h-[44px]');
    const badge = screen.getByTestId('product-card-platform');
    expect(badge.textContent).toContain('Shopee');
    expect(badge.textContent).toContain('shopee.co.th');
  });

  it('โดเมนที่ไม่รู้จัก → ป้ายแสดงเฉพาะโดเมน', () => {
    renderCard({ url: 'https://www.example-shop.com/p/1', platform: '' });
    expect(screen.getByTestId('product-card-platform').textContent).toBe('example-shop.com');
  });

  it('เว็บที่ไม่รู้จักไม่ถูกติดป้าย platform ที่ส่งมา และโดเมนปลอมไม่ได้ป้าย Shopee', () => {
    const { unmount } = renderCard({ url: 'https://www.homepro.co.th/p/1', platform: 'Shopee' });
    expect(screen.getByTestId('product-card-platform').textContent).toBe('homepro.co.th');
    unmount();
    renderCard({ url: 'https://shopee.evil.com/p/1', platform: 'Shopee' });
    expect(screen.getByTestId('product-card-platform').textContent).toBe('shopee.evil.com');
  });

  it('ป้ายจำนวน/ราคา: โหมดแก้ไข = ต้องซื้อ/อนุมัติ ; readOnly = สั่งจริง ; override ด้วย qtyLabel/priceLabel ; code เลือกเองได้', () => {
    const { unmount } = renderCard({ item: { ...baseItem, sku: 'SKU-9' } });
    expect(screen.getByText(/จำนวนที่ต้องซื้อ/)).toBeTruthy();
    expect(screen.getByText(/ราคาต่อหน่วยที่อนุมัติ/)).toBeTruthy();
    expect(screen.getByText('ITM-001')).toBeTruthy();
    unmount();
    const r2 = renderCard({ readOnly: true, item: { ...baseItem, sku: 'SKU-9' }, code: 'SKU-9' });
    expect(screen.getByText(/จำนวนที่สั่งจริง/)).toBeTruthy();
    expect(screen.getByText(/ราคาต่อหน่วยจริง/)).toBeTruthy();
    expect(screen.queryByText(/จำนวนที่ต้องซื้อ/)).toBeNull();
    expect(screen.getByText('SKU-9')).toBeTruthy();
    r2.unmount();
    renderCard({ readOnly: true, qtyLabel: 'ก', priceLabel: 'ข' });
    expect(screen.getByText(/^ก/)).toBeTruthy();
    expect(screen.getByText(/^ข/)).toBeTruthy();
  });

  it('คัดลอกลิงก์ → navigator.clipboard.writeText(url) และแสดง "คัดลอกแล้ว" ก่อนกลับเป็นเดิมหลัง 1.5 วิ', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderCard();
    await act(async () => { fireEvent.click(screen.getByTestId('product-card-copy')); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('https://shopee.co.th/product/111/222');
    expect(screen.getByTestId('product-card-copy').textContent).toContain('คัดลอกแล้ว');
    act(() => { vi.advanceTimersByTime(1600); });
    expect(screen.getByTestId('product-card-copy').textContent).toContain('คัดลอกลิงก์');
  });

  it('ไม่มี clipboard (และ execCommand ไม่ได้) → แสดงช่องลิงก์ให้กดเลือกเอง ไม่ error', async () => {
    removeClipboard();
    renderCard();
    await act(async () => { fireEvent.click(screen.getByTestId('product-card-copy')); });
    const input = screen.getByLabelText(/ลิงก์สินค้า/);
    expect(input.value).toBe('https://shopee.co.th/product/111/222');
    expect(input.readOnly).toBe(true);
  });

  it('clipboard.writeText reject → fallback เป็นช่องลิงก์', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    renderCard();
    await act(async () => { fireEvent.click(screen.getByTestId('product-card-copy')); });
    expect(screen.getByLabelText(/ลิงก์สินค้า/)).toBeTruthy();
  });

  it('item ไม่มี URL → ข้อความ "ไม่มีลิงก์ร้านค้า" และไม่มี CTA/ปุ่มคัดลอก', () => {
    renderCard({ url: '' });
    expect(screen.getByText('ไม่มีลิงก์ร้านค้า')).toBeTruthy();
    expect(screen.queryByTestId('product-card-cta')).toBeNull();
    expect(screen.queryByTestId('product-card-copy')).toBeNull();
    expect(screen.queryByText(/เปิดลิงก์ร้านค้าออนไลน์/)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)'
  ])('URL อันตราย (%s) → ไม่มี CTA และไม่มี href', (bad) => {
    const { container } = renderCard({ url: bad });
    expect(screen.queryByTestId('product-card-cta')).toBeNull();
    expect(screen.getByText('ไม่มีลิงก์ร้านค้า')).toBeTruthy();
    expect(container.querySelector('a[href]')).toBeNull();
  });
});

describe('ProductActionCard : เนื้อหา', () => {
  it('หมายเหตุที่เป็น <img onerror> แสดงเป็นข้อความ ไม่ถูก render เป็น element', () => {
    const evil = '<img src=x onerror="window.__pwned=1"> สเปกพิเศษ';
    const { container } = renderCard({ images: [], item: { ...baseItem, productRemark: evil } });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(window.__pwned).toBeUndefined();
  });

  it('แสดงชื่อ รหัส จำนวนที่ต้องซื้อ และราคาต่อหน่วยที่อนุมัติ ด้วยตัวใหญ่ + children slot', () => {
    renderCard({ children: <span data-testid="slot">ตัวควบคุม</span>, badges: <span>ป้ายทดสอบ</span> });
    expect(screen.getByText(baseItem.name).className).toContain('font-bold');
    expect(screen.getByText(baseItem.name).className).toContain('line-clamp-2');
    expect(screen.getByText('ITM-001')).toBeTruthy();
    expect(screen.getByTestId('product-card-qty').textContent).toBe('10');
    expect(screen.getByTestId('product-card-qty').className).toContain('text-lg');
    expect(screen.getByTestId('product-card-price').textContent).toBe('฿387.50');
    expect(screen.getByTestId('slot')).toBeTruthy();
    expect(screen.getByText('ป้ายทดสอบ')).toBeTruthy();
    expect(screen.getByText(/จำนวนที่ต้องซื้อ/)).toBeTruthy();
    expect(screen.getByText(/ราคาต่อหน่วยที่อนุมัติ/)).toBeTruthy();
  });
});

// ── การใช้งานจริงใน OnlineOrderCard (ฟังก์ชันเดิมต้องครบ) ──
const pendingPO = {
  id: 'PO-PD-2026-002',
  poNo: 'PO-PD-2026-002',
  prNo: 'PR-PD-2026-089',
  department: 'PD',
  purchaseChannel: 'ONLINE',
  status: 'PENDING_ORDER',
  vendorName: 'Shopee Official Store',
  estimatedAmount: 2400.00,
  totalAmount: 2400.00,
  items: [{
    id: 'ITM-003', productId: 'PROD-003', sku: 'ITM-003', name: 'ถุงมือกันบาด Level 5',
    qty: 20, purchaseQty: 20, price: 120.00, unitPrice: 120.00, unit: 'คู่', platform: 'Shopee', storePlatform: 'Shopee',
    actualStoreName: 'SafetyFirst Shop', productUrl: 'https://shopee.co.th/product/555/666',
    productRemark: 'ขนาด L เท่านั้น',
    images: twoImages, attachments: twoImages
  }]
};
const claimPO = {
  id: 'PO-PD-2026-003', poNo: 'PO-PD-2026-003', prNo: 'PR-PD-2026-090', department: 'PD', purchaseChannel: 'ONLINE',
  status: 'IN_CLAIM', hasDispute: true, vendorName: 'ToolMaster Store', estimatedAmount: 3500.00, totalAmount: 3500.00,
  items: [{
    id: 'ITM-004', productId: 'PROD-004', sku: 'ITM-004', name: 'ชุดเครื่องมือช่างซ่อมบำรุง', qty: 2, purchaseQty: 2,
    price: 1750.00, unitPrice: 1750.00, unit: 'ชุด', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'ToolMaster Store',
    shortageQty: 1, damagedQty: 0, hasDispute: true, orderRefNo: 'REF-777', productUrl: 'https://shopee.co.th/product/777/888'
  }]
};
const closedPO = {
  id: 'PO-PD-2026-001', poNo: 'PO-PD-2026-001', prNo: 'PR-PD-2026-088', department: 'PD', purchaseChannel: 'ONLINE',
  status: 'COMPLETED', claimStatus: 'RESOLVED', vendorName: 'Shopee Marketplace', estimatedAmount: 5105.00, totalAmount: 5105.00, refundAmount: 517.60,
  storeClaims: {
    'Shopee_storea': { storeKey: 'Shopee_storea', status: 'RESOLVED', type: 'REFUND', refundAmount: 246.00, resolvedAt: '2026-09-13T09:39:00.000Z' },
    'Shopee_packpro thailand': { storeKey: 'Shopee_packpro thailand', status: 'RESOLVED', type: 'REFUND', refundAmount: 271.60, resolvedAt: '2026-09-13T09:39:00.000Z' }
  },
  items: [
    { id: 'ITM-001', productId: 'PROD-001', sku: 'ITM-001', name: 'สายรัดพาเลทอย่างหนา 15 มม.', qty: 10, purchaseQty: 10, price: 387.50, unitPrice: 387.50, unit: 'ม้วน', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'PackPro Thailand', productUrl: 'https://shopee.co.th/product/111/222' },
    { id: 'ITM-002', productId: 'PROD-002', sku: 'ITM-002', name: 'น้ำมันหล่อลื่นอเนกประสงค์เกรดอาหาร', qty: 5, purchaseQty: 5, price: 246.00, unitPrice: 246.00, unit: 'ถัง', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'StoreA', refundAmt: 246.00, shortageQty: 1 }
  ]
};
const role = { id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true };

const renderOrder = (po, activeTab, extra = {}) => render(
  <MemoryRouter>
    <AppProvider>
      <OnlineOrderCard po={po} activeTab={activeTab} currentRole={role} onUpdate={() => {}} {...extra} />
    </AppProvider>
  </MemoryRouter>
);

describe('OnlineOrderCard : ใช้ ProductActionCard (แท็บรอสั่งซื้อ)', () => {
  beforeEach(() => {
    localStorage.clear();
    storageService.resetData();
  });

  it('แสดงการ์ดใหญ่: รูป w-24, CTA ลิงก์ร้านค้า, หมายเหตุสินค้า (ไม่ซ้ำ), ไม่มีไอคอนลิงก์เดิม', () => {
    const { container } = renderOrder(pendingPO, 'PENDING');
    const card = screen.getByTestId('product-action-card');
    expect(card.getAttribute('data-readonly')).toBe('false');
    expect(card.querySelector('img').closest('button').className).toContain('w-24');
    const cta = within(card).getByTestId('product-card-cta');
    expect(cta.getAttribute('href')).toBe('https://shopee.co.th/product/555/666');
    expect(cta.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(card).getByTestId('product-card-platform').textContent).toContain('Shopee');
    expect(container.textContent.split('ขนาด L เท่านั้น').length - 1).toBe(1);
    expect(container.querySelector('a[title="เปิดลิงก์สินค้าจริง"]')).toBeNull();
    expect(within(card).getByTestId('product-card-qty').textContent).toBe('20');
    expect(within(card).getByTestId('product-card-price').textContent).toBe('฿120.00');
  });

  it('คลิกรูป → เปิด lightbox ด้วยรูปทั้งหมดและชื่อสินค้า', () => {
    renderOrder(pendingPO, 'PENDING');
    expect(screen.queryByTestId('lightbox')).toBeNull();
    const card = screen.getByTestId('product-action-card');
    fireEvent.click(card.querySelector('img').closest('button'));
    const lb = screen.getByTestId('lightbox');
    expect(lb.getAttribute('data-index')).toBe('0');
    expect(lb.getAttribute('data-count')).toBe('2');
    expect(lb.getAttribute('data-title')).toBe('ถุงมือกันบาด Level 5');
  });

  it('ปุ่ม +/- และช่องราคารวมยังเปลี่ยนค่าได้ และแสดงค่าเฉลี่ยต่อหน่วย', () => {
    renderOrder(pendingPO, 'PENDING');
    const card = screen.getByTestId('product-action-card');
    const qtyInput = within(card).getByTitle('จำนวนสั่งซื้อจริง (คู่)');
    expect(qtyInput.value).toBe('20');
    fireEvent.click(within(card).getByTitle('เพิ่มจำนวน'));
    expect(within(card).getByTitle('จำนวนสั่งซื้อจริง (คู่)').value).toBe('21');
    fireEvent.click(within(card).getByTitle('ลดจำนวน'));
    fireEvent.click(within(card).getByTitle('ลดจำนวน'));
    expect(within(card).getByTitle('จำนวนสั่งซื้อจริง (คู่)').value).toBe('19');

    const total = within(card).getByTitle('ราคารวมที่จ่ายจริง');
    fireEvent.change(total, { target: { value: '1900' } });
    expect(within(card).getByTitle('ราคารวมที่จ่ายจริง').value).toBe('1900');
    expect(card.textContent).toContain('เฉลี่ย @ ฿100.00 / คู่');
  });

  it('คัดลอกชื่อสินค้ายังทำงาน (navigator.clipboard.writeText ด้วยชื่อสินค้า)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderOrder(pendingPO, 'PENDING');
    fireEvent.click(screen.getByTitle('คัดลอกชื่อสินค้า'));
    expect(writeText).toHaveBeenCalledWith('ถุงมือกันบาด Level 5');
  });
});

describe('OnlineOrderCard : โหมดอ่านอย่างเดียว / เคลม / ปิดงาน', () => {
  beforeEach(() => {
    localStorage.clear();
    storageService.resetData();
  });

  it('แท็บ CLAIM: ใช้การ์ด readOnly คงป้ายขาด + มูลค่าที่ต้องเคลม + Ref + CTA', () => {
    renderOrder(claimPO, 'CLAIM');
    const card = screen.getByTestId('product-action-card');
    expect(card.getAttribute('data-readonly')).toBe('true');
    expect(card.textContent).toContain('🚨 ขาด 1 ชุด');
    expect(card.textContent).toContain('มูลค่าที่ต้องเคลม');
    expect(card.textContent).toContain('Ref: REF-777');
    expect(within(card).getByTestId('product-card-cta').getAttribute('href')).toBe('https://shopee.co.th/product/777/888');
    expect(within(card).getByTestId('product-card-no-image')).toBeTruthy();
  });

  it('แท็บ CLOSED (ขยายแล้ว): ทุกรายการเป็นการ์ด และป้ายเคลม/เงินคืนยังอยู่ ; รายการไม่มี URL ไม่มี CTA', () => {
    renderOrder(closedPO, 'CLOSED', { defaultExpanded: true });
    const cards = screen.getAllByTestId('product-action-card');
    expect(cards.length).toBe(2);
    const withUrl = cards.find(c => c.textContent.includes('สายรัดพาเลท'));
    const noUrl = cards.find(c => c.textContent.includes('น้ำมันหล่อลื่น'));
    expect(within(withUrl).getByTestId('product-card-cta')).toBeTruthy();
    expect(within(noUrl).queryByTestId('product-card-cta')).toBeNull();
    expect(within(noUrl).getByText('ไม่มีลิงก์ร้านค้า')).toBeTruthy();
    expect(noUrl.textContent).toContain('ได้รับเงินคืน ฿246.00 เข้าแผนกแล้ว');
  });
});
