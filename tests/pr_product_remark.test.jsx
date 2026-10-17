// @vitest-environment jsdom
// FR-02 (v1.1.0) : หมายเหตุสินค้า (products.remark ที่มากับ bootstrap) แสดงในรายการ PR / งานออนไลน์ / PO
// ลำดับการหา: item.productRemark → product.remark (productId, รอง code) → ''
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import { storageService } from '../src/services/storageService';
import { AppProvider } from '../src/context/AppContext';
import ProductRemarkNote, { getItemRemark } from '../src/components/common/ProductRemarkNote';
import PRDetailsModal from '../src/components/pr/PRDetailsModal';
import PODetailsModal from '../src/components/po/PODetailsModal';
import PRCreateView from '../src/views/PRCreateView';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return { ...actual, createPortal: (node) => node };
});

const REMARK = 'ทนความร้อนถึง 120 องศา';
const LABEL = /สเปก\/หมายเหตุ:/;

const masterProducts = [
  { id: 'PROD-R1', code: 'PD-R-001', name: 'สายพานลำเลียง', category: 'PD', unit: 'เส้น', price: 500, stockBalance: 5, remark: REMARK },
  { id: 'PROD-R2', code: 'PD-R-002', name: 'ลูกปืน', category: 'PD', unit: 'ชิ้น', price: 80, stockBalance: 5, remark: '' }
];

const reviewerRole = { id: 'USR-MGR-01', name: 'ผู้จัดการโรงงาน (Approver)', department: 'PD', roleId: 'APPROVER_PLANT', level: 3 };
const admin = { id: 'ADMIN', roleId: 'ADMIN', role: 'admin', name: 'System Admin', level: 99, department: 'ALL', canViewAllDepts: true };

beforeEach(() => {
  localStorage.clear();
  storageService.resetData();
  storageService.saveProducts(masterProducts);
});
afterEach(() => cleanup());

describe('FR-02 getItemRemark (helper)', () => {
  it('(a1) item.productRemark ใช้ก่อนเสมอ แม้ product จะมี remark อื่น', () => {
    const item = { productId: 'PROD-R1', productRemark: 'ค่าที่คัดลอกตอนสร้าง PR' };
    expect(getItemRemark(item, masterProducts)).toBe('ค่าที่คัดลอกตอนสร้าง PR');
  });

  it('(a2) ไม่มี productRemark → ใช้ product.remark ของ productId ที่ตรงกัน', () => {
    expect(getItemRemark({ productId: 'PROD-R1' }, masterProducts)).toBe(REMARK);
  });

  it('(a3) productId หาไม่เจอ → fallback ด้วย code', () => {
    expect(getItemRemark({ productId: 'NOPE', code: 'pd-r-001' }, masterProducts)).toBe(REMARK);
  });

  it('(a4) ไม่มี remark ทั้ง item และ product → คืน ""', () => {
    expect(getItemRemark({ productId: 'PROD-R2' }, masterProducts)).toBe('');
    expect(getItemRemark({ productId: 'NOPE' }, masterProducts)).toBe('');
    expect(getItemRemark({ productId: 'PROD-R1' }, [])).toBe('');
    expect(getItemRemark(null, masterProducts)).toBe('');
  });

  it('ProductRemarkNote : ไม่มี remark → render null (ไม่มีป้ายว่าง)', () => {
    const { container } = render(<ProductRemarkNote item={{ productId: 'PROD-R2' }} products={masterProducts} />);
    expect(container.innerHTML).toBe('');
  });

  it('ProductRemarkNote : มี remark → แสดงป้ายและข้อความเป็น text ธรรมดา', () => {
    render(<ProductRemarkNote item={{ productId: 'PROD-R1' }} products={masterProducts} />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.getByText(/ทนความร้อนถึง 120 องศา/)).toBeTruthy();
  });
});

describe('FR-02 PRDetailsModal : PR เก่าที่ item ไม่มี productRemark', () => {
  it('(b) แสดง remark จาก products ของ bootstrap', () => {
    const oldPR = {
      id: 'PR-OLD-1', prNo: 'PD010/2026', department: 'PD', requestedBy: 'สมชาย ผู้ขอซื้อ', status: 'SUBMITTED',
      purchaseChannel: 'SELF', totalAmount: 1000,
      items: [{ id: 'IT-1', productId: 'PROD-R1', code: 'PD-R-001', name: 'สายพานลำเลียง', qty: 2, price: 500, unit: 'เส้น' }]
    };
    render(
      <MemoryRouter>
        <PRDetailsModal selectedPR={oldPR} currentRole={reviewerRole} onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getAllByText(LABEL).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ทนความร้อนถึง 120 องศา/).length).toBeGreaterThan(0);
  });

  it('สินค้าที่ไม่มี remark ไม่แสดงป้าย', () => {
    const pr = {
      id: 'PR-OLD-2', prNo: 'PD011/2026', department: 'PD', requestedBy: 'สมชาย ผู้ขอซื้อ', status: 'SUBMITTED',
      purchaseChannel: 'SELF', totalAmount: 80,
      items: [{ id: 'IT-2', productId: 'PROD-R2', code: 'PD-R-002', name: 'ลูกปืน', qty: 1, price: 80, unit: 'ชิ้น' }]
    };
    render(
      <MemoryRouter>
        <PRDetailsModal selectedPR={pr} currentRole={reviewerRole} onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getAllByText('ลูกปืน').length).toBeGreaterThan(0);
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});

describe('FR-02 PODetailsModal : รายการสินค้าใน PO', () => {
  it('(c) แสดง remark ใต้ชื่อสินค้า ทั้งจาก products (productId) และจาก item.productRemark', () => {
    const po = {
      id: 'PO-R-1', poNo: 'PO-PD-2026-R1', prNo: 'PD010/2026', department: 'PD', purchaseChannel: 'SELF',
      status: 'ISSUED', requestedBy: 'สมชาย ผู้ขอซื้อ', requesterId: 'REQ-1', issueDate: '2026-10-17', vendorName: 'สยามไทย',
      items: [
        { productId: 'PROD-R1', code: 'PD-R-001', name: 'สายพานลำเลียง', orderedQty: 2, purchaseQty: 2, receivedQty: 0, price: 500, total: 1000 },
        { productId: 'NOPE', code: 'X-999', name: 'รายการพิเศษ', productRemark: 'หมายเหตุจาก PR', orderedQty: 1, purchaseQty: 1, receivedQty: 0, price: 10, total: 10 }
      ]
    };
    render(<PODetailsModal selectedPO={po} currentRole={admin} onClose={() => {}} />);
    expect(screen.getAllByText(LABEL).length).toBe(2);
    expect(screen.getAllByText(/ทนความร้อนถึง 120 องศา/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/หมายเหตุจาก PR/).length).toBeGreaterThan(0);
  });
});

describe('FR-02 PRCreateView : แถวรายการสินค้า', () => {
  it('(d) แถวที่เลือกสินค้าแล้วแสดง remark ของสินค้านั้น', () => {
    const DEPTS = [{ id: 'PD', code: 'PD', name: 'ฝ่ายผลิต' }, { id: 'QC', code: 'QC', name: 'ฝ่ายควบคุมคุณภาพ' }];
    const role = { id: 'USR-6539', name: 'กัลยาณี พลไกร', roleId: 'ASST_MANAGER', level: 2, department: 'PD', primaryDepartment: 'PD', allowedDepartments: ['PD', 'QC'], assignedDepartments: ['PD', 'QC'], canReview: true };
    const products = [{ id: 'PROD-PD-001', code: 'PD-OIL-068', name: 'น้ำมันไฮดรอลิก', category: 'PD', unit: 'ลิตร', price: 100, stockBalance: 10, remark: 'ISO VG46 ถัง 20 ลิตร' }];
    render(
      <MemoryRouter>
        <AppProvider>
          <PRCreateView currentRole={role} products={products} vendors={[]} departments={DEPTS} />
        </AppProvider>
      </MemoryRouter>
    );
    expect(screen.getAllByText(LABEL).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ISO VG46 ถัง 20 ลิตร/).length).toBeGreaterThan(0);
  });

  it('(d3) เปิดแก้ PR เดิม : item ที่ productRemark ถูกเก็บไว้ยังเห็นกล่องหมายเหตุ แม้สินค้าไม่อยู่ใน products (ปิดใช้งาน/ย้ายแผนก)', () => {
    const DEPTS = [{ id: 'PD', code: 'PD', name: 'ฝ่ายผลิต' }];
    const role = { id: 'USR-6539', name: 'กัลยาณี พลไกร', roleId: 'ASST_MANAGER', level: 2, department: 'PD', primaryDepartment: 'PD', allowedDepartments: ['PD'], assignedDepartments: ['PD'], canReview: true };
    const editingPR = {
      id: 'PR-EDIT-1', prNo: 'PD020/2026', department: 'PD', purchaseChannel: 'SELF', status: 'DRAFT',
      items: [{ id: 'IT-E1', productId: 'PROD-GONE', code: 'PD-GONE-1', name: 'สินค้าที่ถูกปิดใช้งาน', qty: 1, purchaseQty: 1, price: 50, unit: 'ชิ้น', productRemark: 'หมายเหตุเดิมจาก PR' }]
    };
    render(
      <MemoryRouter>
        <AppProvider>
          <PRCreateView currentRole={role} products={[]} vendors={[]} departments={DEPTS} editingPR={editingPR} />
        </AppProvider>
      </MemoryRouter>
    );
    expect(screen.getAllByText(LABEL).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/หมายเหตุเดิมจาก PR/).length).toBeGreaterThan(0);
  });

  it('(d2) ตรรกะคัดลอก productRemark ตอนเลือกสินค้าและตอน submit อยู่ในไฟล์ (source check ของ handleItemChange และ payload)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'views', 'PRCreateView.jsx'), 'utf8');
    expect(src).toContain("updated[index].productRemark = prod.remark || '';");
    expect(src).toContain("productRemark: prod?.remark || item.productRemark || '',");
  });
});
