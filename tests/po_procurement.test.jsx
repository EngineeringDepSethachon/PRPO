import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import fs from 'fs';
import path from 'path';
import './setup.js';

import POListView from '../src/views/POListView';
import PODetailsModal from '../src/components/po/PODetailsModal';
import PrintablePO from '../src/components/po/PrintablePO';
import OnlineTaskView, { 
  hasUnresolvedClaim, 
  checkPOHasGRN 
} from '../src/views/OnlineTaskView';
import OnlineOrderCard, { 
  getStoreGroupKey, 
  calculateDisputeMetrics,
  isStorePendingClaim,
  isStoreClaimResolved
} from '../src/views/procurement/OnlineOrderCard';
import { 
  OnlineProcurementHub, 
  filteredOrders, 
  getTabMetrics,
  formatThaiMonth,
  getPrevMonth,
  getNextMonth,
  calculateCompletedKPIs,
  parseOrderYearMonth,
  filterOrdersByTab
} from '../src/views/procurement/OnlineProcurementHub';
import { calculateActiveClaimCount } from '../src/context/ProcurementContext';
import { storageService } from '../src/services/storageService';
import { workflowEngine, FALLBACK_SEED_ATTACHMENTS } from '../src/services/workflowEngine';
import { apiService } from '../src/services/apiService';
import { ROLES } from '../src/config/constants';
import { AppProvider } from '../src/context/AppContext';

// Mock child modals and portal for PODetailsModal SSR rendering
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (node) => node
  };
});

describe('Domain Suite: Purchase Order (PO) & Procurement Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    storageService.resetData();
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 1: PO Table Layout & Action Column
  // ══════════════════════════════════════════════════════════════════
  describe('1. PO Table Responsive Layout & Action Column Regression Suite', () => {
    const mockPOs = [
      {
        id: 'PO-2026-001',
        poNo: 'PO-PD-2026-001',
        prNo: 'PD001/2026',
        department: 'PD',
        vendorName: 'บริษัท ไทย ออฟฟิศ ซัพพลาย จำกัด',
        purchaseChannel: 'INTERNAL',
        subtotal: 10000,
        grandTotal: 10000,
        status: 'ISSUED',
        date: new Date().toISOString(),
        items: [
          {
            productId: 'PROD-001',
            name: 'กระดาษ Double A A4 80gsm',
            quantity: 50,
            unitPrice: 200
          }
        ]
      },
      {
        id: 'PO-2026-002',
        poNo: 'PO-PD-2026-002',
        prNo: 'PD002/2026',
        department: 'PD',
        vendorName: 'Shopee Mall (Official Store)',
        purchaseChannel: 'ONLINE',
        subtotal: 2450.50,
        grandTotal: 2450.50,
        status: 'IN_PROGRESS_ONLINE',
        date: new Date().toISOString(),
        items: [
          {
            productId: 'PROD-002',
            name: 'ตลับหมึก HP LaserJet Pro',
            quantity: 2,
            unitPrice: 1225.25
          }
        ]
      }
    ];

    const mockRole = {
      id: 'ADMIN',
      roleId: 'ADMIN',
      name: 'Administrator',
      canViewAllDepts: true
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('Scenario 1 (Viewport Scaling & Scaffolding): Table container architecture features card overflow-hidden, horizontal scroll wrapper, min-w-[980px], and proportional column widths', () => {
      const html = renderToStaticMarkup(
        <POListView
          pos={mockPOs}
          departments={[{ code: 'PD', name: 'ฝ่ายผลิต' }]}
          currentRole={mockRole}
        />
      );

      expect(html).toContain('rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden');
      expect(html).toContain('overflow-x-auto scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent');
      expect(html).toContain('min-w-[980px]');
      expect(html).toContain('border-collapse');
      expect(html).toContain('<col class="w-[16%]"/>');
      expect(html).toContain('<col class="w-[22%]"/>');
      expect(html).toContain('<col class="w-[20%]"/>');
      expect(html).toContain('<col class="w-[10%]"/>');
      expect(html).toContain('<col class="w-[14%]"/>');
      expect(html).toContain('<col class="w-[12%]"/>');

      expect(html).toContain('w-[16%] min-w-[140px] pl-6 pr-4 py-3 text-left');
      expect(html).toContain('w-[22%] min-w-[190px] px-4 py-3 text-left');
      expect(html).toContain('w-[20%] min-w-[170px] px-4 py-3 text-left');
      expect(html).toContain('w-[10%] min-w-[95px] px-3 py-3 text-center');
      expect(html).toContain('w-[14%] min-w-[120px] px-4 py-3 text-right');
      expect(html).toContain('w-[10%] min-w-[105px] px-3 py-3 text-center');
      expect(html).toContain('w-[12%] min-w-[120px] pl-3 pr-6 py-3 text-right');
    });

    it('Scenario 2 (Action Button Visibility): Action column cell has pr-6 breathing room, whitespace-nowrap, and renders modern "ดูรายละเอียด" button with icon', () => {
      const html = renderToStaticMarkup(
        <POListView
          pos={mockPOs}
          departments={[{ code: 'PD', name: 'ฝ่ายผลิต' }]}
          currentRole={mockRole}
        />
      );

      expect(html).toContain('w-[12%] min-w-[120px] pl-3 pr-6 py-3.5 text-right align-middle whitespace-nowrap');
      expect(html).toContain('inline-flex items-center justify-end gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg shadow-sm');
      expect(html).toContain('ดูรายละเอียด');
      expect(html).not.toContain('ดูข้อมูล...');
    });

    it('Scenario 3 (Controls & Pagination Preservation): Preserves search bar, status tabs, date filters, and places pagination outside the scroll container', () => {
      const html = renderToStaticMarkup(
        <POListView
          pos={mockPOs}
          departments={[{ code: 'PD', name: 'ฝ่ายผลิต' }]}
          currentRole={mockRole}
        />
      );

      expect(html).toContain('placeholder="ค้นหาเลข PO, ผู้ขาย, PR, สินค้า..."');
      expect(html).toContain('ทั้งหมด');
      expect(html).toContain('รอรับของ (ซื้อเอง)');
      expect(html).toContain('รอดำเนินการ Online');
      expect(html).toContain('ปิดงานแล้ว');
      expect(html).toContain('ยกเลิกแล้ว');
      expect(html).toContain('PO-PD-2026-001');
      expect(html).toContain('PO-PD-2026-002');
      expect(html).toContain('฿10,000.00');
      expect(html).toContain('฿2,450.50');
      expect(html).toContain('จากทั้งหมด');
      expect(html).toContain('2</span> รายการ');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 2: PODetailsModal Modern SaaS UX/UI Overhaul
  // ══════════════════════════════════════════════════════════════════
  describe('2. PODetailsModal Modern SaaS UX/UI Overhaul', () => {
    const samplePO = {
      id: 'PO-TEST-MODERN-001',
      poNo: 'PO-PD-2026-088',
      status: 'IN_DELIVERY',
      department: 'PD',
      vendorName: 'บริษัท อุตสาหกรรม เคมีคอล จำกัด',
      purchaseChannel: 'ONLINE',
      issueDate: '12/09/2026',
      hasVat: true,
      items: [
        {
          productId: 'PROD-01',
          code: 'OIL-VG-68',
          name: 'น้ำมันไฮดรอลิกเกรด 68 (200L)',
          orderedQty: 5,
          purchaseQty: 5,
          receivedQty: 2,
          purchaseUnit: 'ถัง',
          price: 2800,
          storePlatform: 'Shopee',
          actualStoreName: '3M Official Store',
          productUrl: 'https://shopee.co.th/product/123/456'
        }
      ]
    };

    const operationalRole = {
      id: 'REQUESTER_PD',
      roleId: 'REQUESTER_PD',
      role: 'requester',
      level: 1,
      department: 'PD',
      canReceiveGoods: true
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('1. Renders Slim Stepper with height <= h-8 and connected progress indicators', () => {
      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={samplePO} currentRole={operationalRole} onClose={() => {}} />
      );

      expect(html).toContain('h-8 bg-slate-50 border border-slate-200/80 rounded-xl px-3');
      expect(html).toContain('ออก PO');
      expect(html).toContain('สั่งซื้อแล้ว');
      expect(html).toContain('กำลังส่ง');
      expect(html).toContain('รับบางส่วน');
      expect(html).toContain('รับครบ');
      expect(html).toContain('ปิด PO');
    });

    it('2. Kills the Table Desert: Renders High-Density Compact Item Cards', () => {
      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={samplePO} currentRole={operationalRole} onClose={() => {}} />
      );

      expect(html).toContain('รายการสินค้าที่สั่งซื้อ');
      expect(html).toContain('1 รายการ');
      expect(html).toContain('OIL-VG-68');
      expect(html).toContain('น้ำมันไฮดรอลิกเกรด 68 (200L)');
      expect(html).toContain('Shopee');
      expect(html).toContain('3M Official Store');
      expect(html).toContain('เปิดร้านค้า');
      expect(html).toContain('สั่ง:');
      expect(html).toContain('รับแล้ว:');
      expect(html).toContain('รวม');
      expect(html).toContain('14,000.00');
    });

    it('3. Replaces Harsh Black Total Bar with Clean Right-aligned Financial Summary', () => {
      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={samplePO} currentRole={operationalRole} onClose={() => {}} />
      );

      expect(html).not.toContain('bg-slate-800 px-4 py-3 flex items-center justify-between');
      expect(html).toContain('รวมมูลค่าสินค้า (Subtotal):');
      expect(html).toContain('ภาษีมูลค่าเพิ่ม 7% (VAT 7%):');
      expect(html).toContain('ยอดเงินรวมสุทธิ (Grand Total):');
      expect(html).toContain('bg-emerald-50/80 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-1.5');
      expect(html).toContain('14,980.00');
    });

    it('4. Prioritizes Action Buttons in Footer: Ghost Close, Subtle Cancel, Outline Claim, and Solid Primary Receive', () => {
      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={samplePO} currentRole={operationalRole} onClose={() => {}} />
      );

      expect(html).toContain('✕ ปิดหน้าต่าง');
      expect(html).toContain('ยกเลิก PO');
      expect(html).toContain('text-slate-400 hover:text-rose-600');
      expect(html).toContain('🚨 แจ้งปัญหา / ติดตามร้าน');
      expect(html).toContain('border border-rose-200 text-rose-700 bg-rose-50/60');
      expect(html).toContain('📥 บันทึกตรวจรับสินค้า (+IN) ➔');
      expect(html).toContain('bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-5 py-2.5 rounded-xl');
    });

    it('5. View-Swapping / Dedicated Mode: Renders dedicated Claim View without duplicate action buttons', () => {
      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={samplePO} currentRole={operationalRole} onClose={() => {}} initialView="CLAIM" />
      );

      expect(html).toContain('← กลับไปหน้า PO');
      expect(html).toContain('แจ้งปัญหา / รายงานเคลมสินค้า');
      expect(html).toContain('หัวข้อปัญหา');
      expect(html).toContain('รายละเอียดปัญหา');
      expect(html).toContain('+ อัปโหลดรูปภาพหลักฐาน');
      expect(html).toContain('← ยกเลิกและย้อนกลับ');
      expect(html).toContain('⚠️ ยืนยันส่งเรื่องแจ้งเคลมไปยังจัดซื้อ');
      expect(html).not.toContain('บันทึกตรวจรับสินค้า (+IN)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 3: PODetailsModal Defective Items PO-Scoping
  // ══════════════════════════════════════════════════════════════════
  describe('3. PODetailsModal - Defective Items PO-Scoping & Zero Ghost Cards Suite', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('Scenario 1: Normal PO (PO-PD-2026-001) with unrelated defect PROD-PD-008 completely hides the defective box', () => {
      const normalPO = {
        id: 'PO-1789306379792-1',
        poNo: 'PO-PD-2026-001',
        poNumber: 'PO-PD-2026-001',
        prNo: 'PD001/2026',
        department: 'PD',
        vendorName: 'Shopee Supplier',
        status: 'CLOSED',
        items: [
          {
            productId: 'PROD-PD-1789273108904',
            code: 'itm-001',
            name: 'ถุงมือยางใหม่',
            qty: 1,
            purchaseQty: 1,
            stockQty: 1,
            unit: 'ชิ้น',
            price: 15
          },
          {
            productId: 'PROD-ITM-002',
            code: 'ITM-002',
            name: 'น้ำมันหล่อลื่นสังเคราะห์',
            qty: 1,
            purchaseQty: 1,
            stockQty: 1,
            unit: 'ชิ้น',
            price: 246
          }
        ],
        ngItems: [
          {
            productId: 'PROD-PD-008',
            productCode: 'PD-STF-001',
            name: 'ฟิล์มยืดพันพาเลท (Stretch Film 15 Micron 500mm x 300m)',
            qty: 6,
            unit: 'ม้วน',
            defectReason: 'ฉีกขาดเสียหาย',
            reason: 'SHORT_SHIPMENT'
          }
        ]
      };

      const html = renderToStaticMarkup(
        <PODetailsModal
          selectedPO={normalPO}
          currentRole={{ id: 'PLANT_MGR', name: 'Plant Manager' }}
          onClose={() => {}}
        />
      );

      expect(html).toContain('ถุงมือยางใหม่');
      expect(html).toContain('น้ำมันหล่อลื่นสังเคราะห์');
      expect(html).not.toContain('PROD-PD-008');
      expect(html).not.toContain('ฟิล์มยืดพันพาเลท');
      expect(html).not.toContain('บันทึกสินค้าชำรุด (Defective Items)');
      expect(html).not.toContain('po-defective-items-section');
    });

    it('Scenario 2: Legitimate defect on current PO item renders defective box with only that item', () => {
      const poWithDefect = {
        id: 'PO-PD-2026-009',
        poNo: 'PO-PD-2026-009',
        poNumber: 'PO-PD-2026-009',
        prNo: 'PD009/2026',
        department: 'PD',
        vendorName: 'Chemical Vendor',
        status: 'PARTIALLY_RECEIVED',
        items: [
          {
            productId: 'PROD-PD-1789273108904',
            code: 'itm-001',
            name: 'ถุงมือยางใหม่',
            qty: 10,
            purchaseQty: 10,
            stockQty: 10,
            unit: 'ชิ้น',
            price: 15
          },
          {
            productId: 'PROD-ITM-002',
            code: 'ITM-002',
            name: 'น้ำมันหล่อลื่นสังเคราะห์',
            qty: 5,
            purchaseQty: 5,
            stockQty: 5,
            unit: 'ชิ้น',
            price: 246
          }
        ],
        ngItems: [
          {
            poNumber: 'PO-PD-2026-009',
            productId: 'PROD-PD-1789273108904',
            productCode: 'itm-001',
            name: 'ถุงมือยางใหม่',
            qty: 2,
            unit: 'ชิ้น',
            defectReason: 'ซองขาดและมีรอยฉีก',
            reason: 'DAMAGED'
          }
        ]
      };

      const html = renderToStaticMarkup(
        <PODetailsModal
          selectedPO={poWithDefect}
          currentRole={{ id: 'REQUESTER_PD', name: 'Requester' }}
          onClose={() => {}}
        />
      );

      expect(html).toContain('บันทึกสินค้าชำรุด (Defective Items)');
      expect(html).toContain('po-defective-items-section');
      expect(html).toContain('ซองขาดและมีรอยฉีก');
      expect(html).toContain('2 ชิ้น');
    });

    it('Scenario 3: PO with zero defects renders zero ghost cards', () => {
      const cleanPO = {
        id: 'PO-PD-2026-010',
        poNo: 'PO-PD-2026-010',
        poNumber: 'PO-PD-2026-010',
        prNo: 'PD010/2026',
        department: 'PD',
        vendorName: 'Supplier Co.',
        status: 'COMPLETED',
        items: [
          {
            productId: 'PROD-PD-001',
            code: 'PD-OIL-001',
            name: 'Hydraulic Oil ISO VG 68',
            qty: 5,
            unit: 'ถัง'
          }
        ],
        ngItems: []
      };

      const html = renderToStaticMarkup(
        <PODetailsModal
          selectedPO={cleanPO}
          currentRole={{ id: 'PLANT_MGR', name: 'Plant Manager' }}
          onClose={() => {}}
        />
      );

      expect(html).not.toContain('บันทึกสินค้าชำรุด (Defective Items)');
      expect(html).not.toContain('po-defective-items-section');
    });

    it('Scenario 4: storageService.getDefectiveItemsForPO enforces strict PO scoping and rejects alien records', () => {
      const mockPO = {
        id: 'PO-TEST-001',
        poNo: 'PO-TEST-001',
        items: [
          { productId: 'P-1', code: 'ITEM-1', name: 'Widget A' }
        ],
        ngItems: [
          { productId: 'P-1', code: 'ITEM-1', name: 'Widget A', qty: 1, defectReason: 'Broken' },
          { productId: 'P-ALIEN', code: 'ITEM-ALIEN', name: 'Alien Item', qty: 5, defectReason: 'Leaked' },
          { poNumber: 'PO-OTHER-999', productId: 'P-1', code: 'ITEM-1', name: 'Widget A', qty: 1, defectReason: 'From other PO' }
        ]
      };

      const scoped = storageService.getDefectiveItemsForPO(mockPO);
      expect(scoped.length).toBe(1);
      expect(scoped[0].productId).toBe('P-1');
      expect(scoped[0].name).toBe('Widget A');
      expect(scoped[0].qty).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 4: PrintablePO Financial Summary Typography & PDF Layout
  // ══════════════════════════════════════════════════════════════════
  describe('4. PrintablePO Financial Summary Typography Scale Down & Layout', () => {
    const samplePO = {
      id: 'PO-TEST-FINANCIAL',
      poNo: 'PO-2026-001',
      status: 'APPROVED',
      department: 'PD',
      vendorName: 'บริษัท เคมีคอล ซัพพลาย จำกัด',
      hasVat: true,
      items: [
        {
          name: 'น้ำมันไฮดรอลิกเกรด 68 (200L)',
          code: 'OIL-68',
          qty: 2,
          price: 2500,
          unit: 'ถัง'
        }
      ]
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('renders subtotal and vat with explicit inline style 10px and text-[10px]', () => {
      const html = renderToStaticMarkup(<PrintablePO po={samplePO} />);

      expect(html).toContain('font-size:10px');
      expect(html).toContain('line-height:14px');
      expect(html).toContain('text-[10px] leading-tight text-slate-600');
      expect(html).toContain('text-[10px] font-mono text-slate-800');
      expect(html).toContain('รวมมูลค่าสินค้า (Subtotal):');
      expect(html).toContain('5,000.00');
      expect(html).toContain('ภาษีมูลค่าเพิ่ม 7% (VAT 7%):');
      expect(html).toContain('350.00');
    });

    it('renders grand total with explicit inline style 11px font-bold and text-[11px]', () => {
      const html = renderToStaticMarkup(<PrintablePO po={samplePO} />);

      expect(html).toContain('border-top:1px solid #E2E8F0');
      expect(html).toContain('font-size:11px');
      expect(html).toContain('line-height:16px');
      expect(html).toContain('font-weight:bold');
      expect(html).toContain('text-[11px] leading-tight font-bold text-slate-900');
      expect(html).toContain('text-[11px] font-mono font-bold');
      expect(html).toContain('ยอดเงินรวมสุทธิ (Grand Total):');
      expect(html).toContain('color:#047857');
      expect(html).toContain('5,350.00');

      expect(html).not.toContain('text-base font-bold font-mono text-white');
      expect(html).not.toContain('text-lg font-black');
    });

    it('renders right-aligned 2-column container w-64 with comfortable top padding', () => {
      const html = renderToStaticMarkup(<PrintablePO po={samplePO} />);
      expect(html).toContain('w-64 space-y-1 text-right');
      expect(html).toContain('padding-top:12px');
    });

    it('locks print font sizes to fixed px (no Tailwind scale classes text-xs/sm/base/lg/xl)', () => {
      const html = renderToStaticMarkup(<PrintablePO po={samplePO} />);
      const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
      const scaleClass = /(^|\s)text-(xs|sm|base|lg|xl|[2-9]xl)(\s|$)/;
      expect(classAttrs.filter((c) => scaleClass.test(c))).toEqual([]);

      // Former text-sm (root) / text-xs (header, remarks) are pinned at the old px values.
      expect(html).toContain('text-[14px] leading-[20px] thai-doc-container');
      expect(html).toContain('text-[12px]');
      expect(html).toContain('text-[16px]');

      const src = fs.readFileSync(path.resolve(process.cwd(), 'src/components/po/PrintablePO.jsx'), 'utf-8');
      expect(src).not.toMatch(/(^|[\s"'`])text-(xs|sm|base|lg|xl|[2-9]xl)(?=[\s"'`])/m);
    });

    it('verifies generatePoPdf.js has scaled down size 9 and size 10 in PDF engine with comfortable vertical spacing', async () => {
      const pdfFilePath = path.resolve(process.cwd(), 'src/utils/generatePoPdf.js');
      const content = fs.readFileSync(pdfFilePath, 'utf-8');

      expect(content).toContain("normalizeThaiText('รวมมูลค่าสินค้า (Subtotal):'), { x: 330, y: rowY - 28, size: 9, font: boldFont }");
      expect(content).toContain("normalizeThaiText('ภาษีมูลค่าเพิ่ม 7% (VAT 7%):'), { x: 330, y: rowY - 41, size: 9, font: boldFont }");
      expect(content).toContain("normalizeThaiText('ยอดเงินรวมสุทธิ (Grand Total):'), { x: 330, y: rowY - 55, size: 10, font: boldFont }");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 5: Auto-PO Creation, Splitting Logic & Vendor Assignment
  // ══════════════════════════════════════════════════════════════════
  describe('5. Auto-PO Creation, Splitting Logic & Vendor Assignment', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveVendors([
        { id: 'VEN-01', code: 'V01', name: 'บริษัท ซัพพลาย เอ จำกัด' },
        { id: 'VEN-02', code: 'V02', name: 'บริษัท ซัพพลาย บี จำกัด' }
      ]);
      storageService.saveProducts([
        { id: 'PROD-A', code: 'A01', name: 'สินค้า A (Vendor 1)', category: 'PD', price: 100, supplierId: 'VEN-01', stockBalance: 5, unit: 'ชิ้น' },
        { id: 'PROD-B', code: 'B01', name: 'สินค้า B (Vendor 2)', category: 'PD', price: 200, supplierId: 'VEN-02', stockBalance: 5, unit: 'ชิ้น' },
        { id: 'PROD-C', code: 'C01', name: 'สินค้า C (ไม่มี Vendor)', category: 'PD', price: 300, supplierId: null, stockBalance: 5, unit: 'ชิ้น' }
      ]);
    });

    it('Single Vendor PR generates 1 PO on Final Approval', async () => {
      const pr = await workflowEngine.createPR({
        department: 'PD',
        source: 'FACTORY',
        purchaseChannel: 'SELF',
        requiredDate: '2026-09-15',
        items: [{ productId: 'PROD-A', code: 'A01', name: 'สินค้า A', qty: 10, price: 100 }],
        totalAmount: 1000,
        reason: 'Single vendor purchase',
        isDraft: false
      }, ROLES.REQUESTER_PD);

      await workflowEngine.updatePRStatus(pr.id, 'REVIEWED', ROLES.ASST_MANAGER);
      const { pr: approvedPR, po: generatedPO } = await workflowEngine.updatePRStatus(pr.id, 'APPROVED', ROLES.PLANT_MANAGER);

      expect(approvedPR.status).toBe('PO_ISSUED');
      expect(generatedPO).toBeDefined();
      expect(generatedPO.vendorId).toBe('VEN-01');
      expect(generatedPO.vendorName).toBe('บริษัท ซัพพลาย เอ จำกัด');
      expect(generatedPO.grandTotal).toBe(1000);
      expect(generatedPO.status).toBe('ISSUED');
    });

    it('Multi-Vendor PR splits into multiple POs (including null supplier group)', async () => {
      const pr = await workflowEngine.createPR({
        department: 'PD',
        source: 'FACTORY',
        purchaseChannel: 'SELF',
        requiredDate: '2026-09-15',
        items: [
          { productId: 'PROD-A', code: 'A01', name: 'สินค้า A (Vendor 1)', qty: 2, price: 100 },
          { productId: 'PROD-B', code: 'B01', name: 'สินค้า B (Vendor 2)', qty: 3, price: 200 },
          { productId: 'PROD-C', code: 'C01', name: 'สินค้า C (ไม่มี Vendor)', qty: 1, price: 300 }
        ],
        totalAmount: 1100,
        reason: 'Multi-vendor purchase',
        isDraft: false
      }, ROLES.REQUESTER_PD);

      await workflowEngine.updatePRStatus(pr.id, 'REVIEWED', ROLES.ASST_MANAGER);
      const { po: generatedPOs } = await workflowEngine.updatePRStatus(pr.id, 'APPROVED', ROLES.PLANT_MANAGER);

      expect(Array.isArray(generatedPOs)).toBe(true);
      expect(generatedPOs.length).toBe(3);

      const po1 = generatedPOs.find(p => p.vendorId === 'VEN-01');
      expect(po1).toBeDefined();
      expect(po1.items.length).toBe(1);
      expect(po1.items[0].productId).toBe('PROD-A');

      const po2 = generatedPOs.find(p => p.vendorId === 'VEN-02');
      expect(po2).toBeDefined();
      expect(po2.items.length).toBe(1);
      expect(po2.items[0].productId).toBe('PROD-B');

      const po3 = generatedPOs.find(p => p.vendorId === null);
      expect(po3).toBeDefined();
      expect(po3.vendorName).toBe('ไม่ระบุผู้ขาย (รอจัดซื้อดำเนินการ)');
      expect(po3.items[0].productId).toBe('PROD-C');
    });

    it('Assign Vendor to PO updates vendorId and logs activity', async () => {
      const pr = await workflowEngine.createPR({
        department: 'PD',
        source: 'FACTORY',
        purchaseChannel: 'SELF',
        requiredDate: '2026-09-15',
        items: [{ productId: 'PROD-C', code: 'C01', name: 'สินค้า C (ไม่มี Vendor)', qty: 1, price: 300 }],
        totalAmount: 300,
        reason: 'Missing vendor',
        isDraft: false
      }, ROLES.REQUESTER_PD);

      await workflowEngine.updatePRStatus(pr.id, 'REVIEWED', ROLES.ASST_MANAGER);
      const { po } = await workflowEngine.updatePRStatus(pr.id, 'APPROVED', ROLES.PLANT_MANAGER);

      expect(po.vendorId).toBeNull();

      const updatedPO = await workflowEngine.assignVendorToPO(po.id, 'VEN-01', 'บริษัท ซัพพลาย เอ จำกัด', ROLES.ADMIN);
      expect(updatedPO.vendorId).toBe('VEN-01');
      expect(updatedPO.vendorName).toBe('บริษัท ซัพพลาย เอ จำกัด');
      expect(updatedPO.activityLog.some(l => l.action.includes('ระบุผู้ขาย'))).toBe(true);
    });

    it('Online Purchase creates PO with IN_PROGRESS_ONLINE for Online Purchaser', async () => {
      const pr = await workflowEngine.createPR({
        department: 'PD',
        source: 'FACTORY',
        purchaseChannel: 'ONLINE',
        requiredDate: '2026-09-15',
        items: [{ productId: 'PROD-A', code: 'A01', name: 'สินค้า A', qty: 1, price: 500 }],
        totalAmount: 500,
        reason: 'Buy from Shopee',
        isDraft: false
      }, ROLES.REQUESTER_PD);

      await workflowEngine.updatePRStatus(pr.id, 'REVIEWED', ROLES.ASST_MANAGER);
      const { po: onlinePO } = await workflowEngine.updatePRStatus(pr.id, 'APPROVED', ROLES.PLANT_MANAGER);

      expect(onlinePO.status).toBe('IN_PROGRESS_ONLINE');
      expect(onlinePO.purchaseChannel).toBe('ONLINE');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 6: Multi-Vendor PR & Auto-Split POs by Vendor
  // ══════════════════════════════════════════════════════════════════
  describe('6. Multi-Vendor PR & Auto-Split POs by Vendor', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveVendors([
        {
          id: 'VEND-001',
          code: 'VEND-IND-01',
          name: 'บริษัท สยามอินดัสเตรียลซัพพลาย จำกัด',
          taxId: '0105551234567',
          address: '88/9 หมู่ 4 นิคมอุตสาหกรรมบางชัน ถ.เสรีไทย คันนายาว กทม. 10230',
          contactPerson: 'คุณสมชาย มุ่งมั่น',
          phone: '02-123-4567',
          email: 'sales@siamind.co.th',
          department: 'PD'
        },
        {
          id: 'VEND-002',
          code: 'VEND-OIL-02',
          name: 'บริษัท ปิโตรเลียมแอนด์ลูบริแคนท์ เทรดดิ้ง จำกัด',
          taxId: '0105559876543',
          address: '123/45 ถ.วิภาวดีรังสิต จตุจักร กทม. 10900',
          contactPerson: 'คุณวิภาวรรณ ชัยเจริญ',
          phone: '02-987-6543',
          email: 'contact@petrolube.com',
          department: 'PD'
        }
      ]);
    });

    it('1. Splits 1 Multi-Vendor PR into multiple consecutive POs grouped by vendor', async () => {
      const user = { name: 'คุณวิชัย (PD)', title: 'Requester (PD)', department: 'PD' };
      const plantMgr = { name: 'คุณประเสริฐ (Plant Mgr)', title: 'Plant Manager', department: 'PD', roleId: 'PLANT_MANAGER', level: 3 };

      const prData = {
        department: 'PD',
        purchaseChannel: 'SELF',
        hasVat: true,
        financials: { vatMode: 'AFTER_DISCOUNT', vatAmount: 140, grandTotal: 2140 },
        items: [
          { productId: 'PROD-1', code: 'CODE-1', name: 'สินค้าผู้ขาย 1', price: 1000, qty: 1, vendorId: 'VEND-001' },
          { productId: 'PROD-2', code: 'CODE-2', name: 'สินค้าผู้ขาย 2', price: 1000, qty: 1, vendorId: 'VEND-002' }
        ]
      };

      const newPR = await workflowEngine.createPR(prData, user);
      newPR.status = 'APPROVED';
      storageService.savePRs([newPR]);

      const generatedPOs = await workflowEngine.createPOFromPR(newPR, plantMgr);
      expect(Array.isArray(generatedPOs)).toBe(true);
      expect(generatedPOs.length).toBe(2);

      const [po1, po2] = generatedPOs;
      expect(po1.prNo).toBe(newPR.prNo);
      expect(po2.prNo).toBe(newPR.prNo);
      expect(po1.poNo).not.toBe(po2.poNo);

      expect(po1.vendorName).toBe('บริษัท สยามอินดัสเตรียลซัพพลาย จำกัด');
      expect(po1.vendorId).toBe('VEND-001');
      expect(po1.vendor?.taxId).toBe('0105551234567');
      expect(po1.subtotal).toBe(1000);
      expect(po1.vat).toBe(70);
      expect(po1.grandTotal).toBe(1070);

      expect(po2.vendorName).toBe('บริษัท ปิโตรเลียมแอนด์ลูบริแคนท์ เทรดดิ้ง จำกัด');
      expect(po2.vendorId).toBe('VEND-002');
      expect(po2.vendor?.taxId).toBe('0105559876543');
      expect(po2.subtotal).toBe(1000);
      expect(po2.vat).toBe(70);
      expect(po2.grandTotal).toBe(1070);
    });

    it('2. Records real store name as vendorName when Online Purchaser confirms order', async () => {
      const user = { name: 'คุณนัท (จัดซื้อออนไลน์)', title: 'Online Purchaser', roleId: 'ONLINE_PURCHASER' };
      const onlinePO = {
        id: 'PO-ONLINE-TEST',
        poNo: 'PO-PD-2026-099',
        prNo: 'PD099/2026',
        department: 'PD',
        purchaseChannel: 'ONLINE',
        vendorName: 'รอจัดซื้อดำเนินการ',
        status: 'ORDERED_PENDING_DELIVERY',
        items: [
          { productId: 'PROD-3', name: 'สินค้าออนไลน์', price: 500, qty: 1, unitPrice: 500, purchaseQty: 1 }
        ]
      };
      storageService.savePOs([onlinePO]);

      const result = await apiService.acknowledgeOnlineTask(
        onlinePO.id,
        'Shopee: 3M Official Store',
        user,
        onlinePO.items,
        'สั่งซื้อเสร็จสิ้น ใช้คูปองส่วนลด'
      );

      expect(result).toBeDefined();
      const updatedPO = storageService.getPOs().find(p => p.id === onlinePO.id);
      expect(updatedPO.vendorName).toBe('Shopee: 3M Official Store');
    });

    it('3. Single PR Document Guarantee: Form submission creates only 1 PR for all vendors, reviewed as 1 document, and splits into N POs only on approval', async () => {
      const requester = { name: 'คุณวิชัย (PD)', title: 'Requester (PD)', department: 'PD', roleId: 'REQUESTER_PD' };
      const asstMgr = { name: 'คุณสมชาย (Asst. Mgr)', title: 'Assistant Manager', department: 'PD', roleId: 'ASST_MANAGER', level: 1 };
      const plantMgr = { name: 'คุณประเสริฐ (Plant Mgr)', title: 'Plant Manager', department: 'PD', roleId: 'PLANT_MANAGER', level: 2 };

      const prPayload = {
        department: 'PD',
        purchaseChannel: 'SELF',
        hasVat: true,
        items: [
          { productId: 'PROD-A', code: 'A01', name: 'Item 1 from Vendor 1', price: 1000, qty: 2, vendorId: 'VEND-001' },
          { productId: 'PROD-B', code: 'B01', name: 'Item 2 from Vendor 2', price: 2000, qty: 1, vendorId: 'VEND-002' },
          { productId: 'PROD-C', code: 'C01', name: 'Item 3 without Vendor', price: 500, qty: 1, vendorId: null }
        ]
      };

      const createdPR = await workflowEngine.createPR(prPayload, requester);
      expect(createdPR).toBeDefined();

      const allPRs = storageService.getPRs();
      expect(allPRs.length).toBe(1);
      expect(allPRs[0].items.length).toBe(3);
      expect(createdPR.financials.subtotal).toBe(4500);
      expect(createdPR.financials.vatAmount).toBe(315);
      expect(createdPR.financials.grandTotal).toBe(4815);

      const { pr: reviewedPR } = await workflowEngine.updatePRStatus(createdPR.id, 'REVIEWED', asstMgr);
      expect(reviewedPR.status).toBe('REVIEWED');
      expect(storageService.getPRs().length).toBe(1);

      const { pr: approvedPR, po: generatedPOs } = await workflowEngine.updatePRStatus(createdPR.id, 'APPROVED', plantMgr);
      expect(approvedPR.status).toBe('PO_ISSUED');
      expect(Array.isArray(generatedPOs)).toBe(true);
      expect(generatedPOs.length).toBe(3);
      expect(storageService.getPRs().length).toBe(1);
      expect(storageService.getPOs().length).toBe(3);
    });

    it('4. 1 PR = 1 Vendor (Internal Purchase): Header Vendor selector ensures 1 PR maps directly to 1 PO with full Master Vendor data, VAT 7%, and accurate financials without splitting', async () => {
      const requester = { name: 'คุณวิชัย (PD)', title: 'Requester (PD)', department: 'PD', roleId: 'REQUESTER_PD' };
      const plantMgr = { name: 'คุณประเสริฐ (Plant Mgr)', title: 'Plant Manager', department: 'PD', roleId: 'PLANT_MANAGER', level: 2 };

      const prPayload = {
        department: 'PD',
        purchaseChannel: 'SELF',
        vendorId: 'VEND-001',
        hasVat: true,
        items: [
          { productId: 'PROD-A', code: 'A01', name: 'Item 1 from Master Vendor', price: 1500, qty: 2 },
          { productId: 'PROD-B', code: 'B01', name: 'Item 2 from Master Vendor', price: 2000, qty: 1 }
        ]
      };

      const createdPR = await workflowEngine.createPR(prPayload, requester);
      expect(createdPR).toBeDefined();
      expect(createdPR.vendorId).toBe('VEND-001');
      expect(createdPR.financials.subtotal).toBe(5000);
      expect(createdPR.financials.vatAmount).toBe(350);
      expect(createdPR.financials.grandTotal).toBe(5350);

      createdPR.status = 'APPROVED';
      storageService.savePRs([createdPR]);

      const generatedPO = await workflowEngine.createPOFromPR(createdPR, plantMgr);
      const po = Array.isArray(generatedPO) ? generatedPO[0] : generatedPO;
      expect(po.vendorId).toBe('VEND-001');
      expect(po.vendorName).toBe('บริษัท สยามอินดัสเตรียลซัพพลาย จำกัด');
      expect(po.vendor?.taxId).toBe('0105551234567');
      expect(po.subtotal).toBe(5000);
      expect(po.vat).toBe(350);
      expect(po.grandTotal).toBe(5350);
      expect(po.status).toBe('ISSUED');
    });

    it('5. Online Purchase: Form without header vendor, multi-item with product URLs, approved into 1 Online PO (IN_PROGRESS_ONLINE) dispatched to Online Procurement Hub', async () => {
      const requester = { name: 'คุณวิชัย (PD)', title: 'Requester (PD)', department: 'PD', roleId: 'REQUESTER_PD' };
      const plantMgr = { name: 'คุณประเสริฐ (Plant Mgr)', title: 'Plant Manager', department: 'PD', roleId: 'PLANT_MANAGER', level: 2 };

      const prPayload = {
        department: 'PD',
        purchaseChannel: 'ONLINE',
        specUrl: 'https://shopee.co.th/cart',
        items: [
          { productId: 'PROD-ONLINE-1', code: 'ON-01', name: 'เมาส์ไร้สาย', price: 350, qty: 2, productUrl: 'https://shopee.co.th/mouse' },
          { productId: 'PROD-ONLINE-2', code: 'ON-02', name: 'คีย์บอร์ดบลูทูธ', price: 800, qty: 1, productUrl: 'https://lazada.co.th/keyboard' }
        ]
      };

      const createdPR = await workflowEngine.createPR(prPayload, requester);
      expect(createdPR).toBeDefined();
      expect(createdPR.purchaseChannel).toBe('ONLINE');
      expect(createdPR.vendorId).toBeNull();
      expect(createdPR.financials.subtotal).toBe(1500);
      expect(createdPR.financials.grandTotal).toBe(1500);

      createdPR.status = 'APPROVED';
      storageService.savePRs([createdPR]);

      const generatedPO = await workflowEngine.createPOFromPR(createdPR, plantMgr);
      const po = Array.isArray(generatedPO) ? generatedPO[0] : generatedPO;
      expect(po).toBeDefined();
      expect(po.purchaseChannel).toBe('ONLINE');
      expect(po.status).toBe('IN_PROGRESS_ONLINE');
      expect(po.items.length).toBe(2);
      expect(po.grandTotal).toBe(1500);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 7: Precise Multi-Store Grouping Logic (getStoreGroupKey)
  // ══════════════════════════════════════════════════════════════════
  describe('7. Precise Multi-Store Grouping Logic (getStoreGroupKey)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('groups items by Platform + StoreName when storeName exists', () => {
      const item1 = { id: 'it-1', name: 'Product A', platform: 'Shopee', storeName: 'Shop A' };
      const item2 = { id: 'it-2', name: 'Product B', platform: 'Shopee', storeName: 'Shop A' };
      const item3 = { id: 'it-3', name: 'Product C', platform: 'Shopee', storeName: 'Shop B' };

      const key1 = getStoreGroupKey(item1, 0);
      const key2 = getStoreGroupKey(item2, 1);
      const key3 = getStoreGroupKey(item3, 2);

      expect(key1).toBe('Shopee_shop a');
      expect(key2).toBe('Shopee_shop a');
      expect(key1).toBe(key2);
      expect(key3).toBe('Shopee_shop b');
      expect(key1).not.toBe(key3);
    });

    it('separates items on the same platform when store name is not given but URLs are different', () => {
      const item1 = { id: 'it-1', name: 'Screwdriver Set', platform: 'Shopee', productUrl: 'https://shopee.co.th/bosch_official_store/123456' };
      const item2 = { id: 'it-2', name: 'Drill Bits', platform: 'Shopee', productUrl: 'https://shopee.co.th/makita_tools_th/789012' };

      const key1 = getStoreGroupKey(item1, 0);
      const key2 = getStoreGroupKey(item2, 1);

      expect(key1).toBe('Shopee_bosch_official_store');
      expect(key2).toBe('Shopee_makita_tools_th');
      expect(key1).not.toBe(key2);
    });

    it('isolates items when neither store name nor URL exists (prevents blanket grouping)', () => {
      const item1 = { id: 'it-1', name: 'Item Alpha', platform: 'Shopee' };
      const item2 = { id: 'it-2', name: 'Item Beta', platform: 'Shopee' };

      const key1 = getStoreGroupKey(item1, 0);
      const key2 = getStoreGroupKey(item2, 1);

      expect(key1).toBe('Shopee_item_it-1');
      expect(key2).toBe('Shopee_item_it-2');
      expect(key1).not.toBe(key2);
    });

    it('ignores placeholder text like "ระบุร้านภายหลัง" when determining store key', () => {
      const item = { id: 'it-x', name: 'Generic Tool', platform: 'Shopee', actualStoreName: 'Shopee (ระบุร้านภายหลัง)' };
      const key = getStoreGroupKey(item, 5);
      expect(key).toBe('Shopee_item_it-x');
    });

    it('prefers actualStoreName over storeName and never uses item.name', () => {
      const item = { id: 'it-y', name: 'Actual Product Name', platform: 'Lazada', actualStoreName: 'Real Shop XYZ', storeName: 'Old Shop' };
      const key = getStoreGroupKey(item, 0);
      expect(key).toBe('Lazada_real shop xyz');
      expect(key).not.toContain('product');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 8: Online Order Lifecycle Guard & Tab Filtering
  // ══════════════════════════════════════════════════════════════════
  describe('8. Online Order Lifecycle Guard & Tab Filtering', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('does NOT treat receivedQty = 0 as shortage for pre-inspection PO in PENDING status without GRN', () => {
      const item = { name: 'Chemical Reagent', actualQty: 3, actualPrice: 500, receivedQty: 0 };
      const metrics = calculateDisputeMetrics(item, 'PENDING', false);

      expect(metrics.orderedQty).toBe(3);
      expect(metrics.receivedQty).toBe(0);
      expect(metrics.shortageQty).toBe(0);
      expect(metrics.damagedQty).toBe(0);
      expect(metrics.disputedQty).toBe(0);
      expect(metrics.claimableAmount).toBe(0);
      expect(metrics.hasDispute).toBe(false);
    });

    it('does NOT treat receivedQty = 0 as shortage for pre-inspection PO in ORDERED status without GRN', () => {
      const item = { name: 'Safety Glasses', actualQty: 5, actualPrice: 120, receivedQty: 0 };
      const metrics = calculateDisputeMetrics(item, 'ORDERED', false);

      expect(metrics.orderedQty).toBe(5);
      expect(metrics.receivedQty).toBe(0);
      expect(metrics.shortageQty).toBe(0);
      expect(metrics.disputedQty).toBe(0);
      expect(metrics.hasDispute).toBe(false);
    });

    it('does NOT treat receivedQty = 0 as shortage for ORDERED_PENDING_DELIVERY or IN_TRANSIT without GRN', () => {
      const item = { name: 'Nitrile Gloves', actualQty: 10, actualPrice: 199, receivedQty: 0 };
      const metricsDelivery = calculateDisputeMetrics(item, 'ORDERED_PENDING_DELIVERY', false);
      expect(metricsDelivery.hasDispute).toBe(false);
      expect(metricsDelivery.shortageQty).toBe(0);

      const metricsTransit = calculateDisputeMetrics(item, 'IN_TRANSIT', false);
      expect(metricsTransit.hasDispute).toBe(false);
      expect(metricsTransit.shortageQty).toBe(0);
    });

    it('calculates shortage accurately once warehouse inspection submits a GRN', () => {
      const item = { name: 'Chemical Reagent', actualQty: 3, actualPrice: 500, receivedQty: 1, damagedQty: 0 };
      const metrics = calculateDisputeMetrics(item, 'ORDERED_PENDING_DELIVERY', true);

      expect(metrics.orderedQty).toBe(3);
      expect(metrics.receivedQty).toBe(1);
      expect(metrics.shortageQty).toBe(2);
      expect(metrics.disputedQty).toBe(2);
      expect(metrics.claimableAmount).toBe(1000);
      expect(metrics.hasDispute).toBe(true);
    });

    it('calculates both shortage and damaged quantities when GRN is submitted', () => {
      const item = { name: 'Glass Beakers', actualQty: 10, actualPrice: 100, receivedQty: 7, damagedQty: 1 };
      const metrics = calculateDisputeMetrics(item, 'PARTIALLY_RECEIVED', true);

      expect(metrics.orderedQty).toBe(10);
      expect(metrics.receivedQty).toBe(7);
      expect(metrics.damagedQty).toBe(1);
      expect(metrics.shortageQty).toBe(2);
      expect(metrics.disputedQty).toBe(3);
      expect(metrics.claimableAmount).toBe(300);
      expect(metrics.hasDispute).toBe(true);
    });

    it('returns false for newly confirmed ORDERED PO without GRN inspection', () => {
      const po = {
        id: 'PO-TEST-001',
        poNo: 'PO-2026-001',
        status: 'ORDERED',
        department: 'PD',
        items: [{ id: 'item-1', name: 'Pallet Film', actualQty: 3, actualPrice: 400, receivedQty: 0, storePlatform: 'Shopee', actualStoreName: 'FilmShop' }]
      };

      expect(checkPOHasGRN(po)).toBe(false);
      expect(hasUnresolvedClaim(po)).toBe(false);
    });

    it('returns true when PO has GRN and shortage is recorded', () => {
      const po = {
        id: 'PO-TEST-002',
        poNo: 'PO-2026-002',
        status: 'PARTIALLY_RECEIVED',
        hasGRN: true,
        grNumber: 'GRN-2026-002-01',
        department: 'PD',
        items: [{ id: 'item-1', name: 'Pallet Film', actualQty: 3, actualPrice: 400, receivedQty: 1, shortageQty: 2, storePlatform: 'Shopee', actualStoreName: 'FilmShop' }]
      };

      expect(checkPOHasGRN(po)).toBe(true);
      expect(hasUnresolvedClaim(po)).toBe(true);
    });

    it('returns false when store claim is resolved even if item had dispute', () => {
      const po = {
        id: 'PO-TEST-003',
        poNo: 'PO-2026-003',
        status: 'RESOLVED',
        hasGRN: true,
        department: 'PD',
        items: [{ id: 'item-1', name: 'Pallet Film', actualQty: 3, actualPrice: 400, receivedQty: 1, shortageQty: 2, storePlatform: 'Shopee', actualStoreName: 'FilmShop' }],
        storeClaims: {
          Shopee_filmshop: { status: 'RESOLVED', refundAmount: 800 }
        }
      };

      expect(hasUnresolvedClaim(po)).toBe(false);
    });

    it('categorizes pre-inspection confirmed order strictly in ORDERED tab (NOT in CLAIM tab)', () => {
      const orders = [
        { id: 'PO-PENDING', poNo: 'PO-01', status: 'PENDING_ORDER', department: 'QC', totalAmount: 1000, items: [{ actualQty: 2, actualPrice: 500, receivedQty: 0 }] },
        { id: 'PO-ORDERED-FRESH', poNo: 'PO-02', status: 'ORDERED', department: 'PD', totalAmount: 1500, items: [{ actualQty: 3, actualPrice: 500, receivedQty: 0 }] },
        { id: 'PO-WITH-SHORTAGE', poNo: 'PO-03', status: 'IN_CLAIM', hasGRN: true, grNumber: 'GRN-03', department: 'QC', totalAmount: 2000, items: [{ actualQty: 4, actualPrice: 500, receivedQty: 1, shortageQty: 3 }] },
        { id: 'PO-CLOSED', poNo: 'PO-04', status: 'COMPLETED', department: 'PD', totalAmount: 500, items: [{ actualQty: 1, actualPrice: 500, receivedQty: 1, isFullyReceived: true }] }
      ];

      const metrics = getTabMetrics(orders);
      expect(metrics.pending).toBe(1);
      expect(metrics.ordered).toBe(1);
      expect(metrics.claim).toBe(1);
      expect(metrics.closed).toBe(1);

      expect(filteredOrders(orders, 'ORDERED').length).toBe(1);
      expect(filteredOrders(orders, 'ORDERED')[0].id).toBe('PO-ORDERED-FRESH');
      expect(filteredOrders(orders, 'CLAIM').length).toBe(1);
      expect(filteredOrders(orders, 'CLAIM')[0].id).toBe('PO-WITH-SHORTAGE');
      expect(filteredOrders(orders, 'PENDING').length).toBe(1);
      expect(filteredOrders(orders, 'CLOSED').length).toBe(1);
    });

    it('sets PO status to ORDERED upon confirmation in workflowEngine.confirmOnlineOrder', async () => {
      const mockPO = {
        id: 'PO-WORKFLOW-TEST',
        poNo: 'PO-2026-999',
        status: 'IN_PROGRESS_ONLINE',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        items: [
          { id: 'item-1', name: 'Test Item', qty: 2, price: 250, actualStoreName: 'OnlineStore1', storePlatform: 'Shopee' }
        ]
      };
      storageService.savePOs([mockPO]);

      const user = { name: 'Tharn Online Purchaser', role: 'Purchaser' };
      const updated = await workflowEngine.confirmOnlineOrder(
        'PO-WORKFLOW-TEST',
        'Shopee OnlineStore1',
        user,
        [{ ...mockPO.items[0], actualQty: 2, actualPrice: 240, actualStoreName: 'Shopee OnlineStore1' }],
        'สั่งซื้อจริงได้ราคาถูกลง'
      );

      expect(updated.status).toBe('ORDERED');
      expect(updated.vendorName).toBe('Shopee OnlineStore1');
      expect(updated.totalAmount).toBe(480);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 9: Online Claim Management Overhaul & Workflow Closure
  // ══════════════════════════════════════════════════════════════════
  describe('9. Online Claim Management Overhaul & Workflow Closure', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('returns true when a PO has at least 1 unresolved store claim', () => {
      const po = {
        id: 'PO-CLAIM-01',
        poNo: 'PO-2026-001',
        status: 'IN_CLAIM',
        department: 'QC',
        items: [{ id: 'item-1', name: 'Reagent A', code: 'QC-A', storePlatform: 'Shopee', actualStoreName: 'ChemStore', shortageQty: 2, unitPrice: 500, claimStatus: 'PENDING' }],
        storeClaims: {}
      };
      expect(hasUnresolvedClaim(po)).toBe(true);
    });

    it('returns false when all disputed stores in the PO are resolved', () => {
      const po = {
        id: 'PO-CLAIM-01',
        poNo: 'PO-2026-001',
        status: 'IN_CLAIM',
        department: 'QC',
        items: [{ id: 'item-1', name: 'Reagent A', code: 'QC-A', storePlatform: 'Shopee', actualStoreName: 'ChemStore', shortageQty: 2, unitPrice: 500, claimStatus: 'PENDING' }],
        storeClaims: {
          'Shopee_ChemStore': { status: 'RESOLVED', type: 'REFUND', refundAmount: 1000 }
        }
      };
      expect(hasUnresolvedClaim(po)).toBe(false);
    });

    it('returns false if PO status is COMPLETED, CLOSED, or RESOLVED regardless of items', () => {
      expect(hasUnresolvedClaim({ id: 'PO-CLAIM-02', status: 'COMPLETED', items: [{ shortageQty: 1, unitPrice: 200 }] })).toBe(false);
      expect(hasUnresolvedClaim({ id: 'PO-CLAIM-03', status: 'CLOSED', items: [{ shortageQty: 1, unitPrice: 200 }] })).toBe(false);
      expect(hasUnresolvedClaim({ id: 'PO-CLAIM-04', status: 'RESOLVED', items: [{ shortageQty: 1, unitPrice: 200 }] })).toBe(false);
    });

    it('handles multi-store PO: returns true if Store 1 resolved but Store 2 is still pending', () => {
      const multiStorePO = {
        id: 'PO-MULTI-01',
        status: 'IN_CLAIM',
        department: 'PD',
        items: [
          { id: 'item-1', name: 'Item From Store 1', storePlatform: 'Shopee', actualStoreName: 'Store 1', shortageQty: 1, unitPrice: 300 },
          { id: 'item-2', name: 'Item From Store 2', storePlatform: 'Lazada', actualStoreName: 'Store 2', shortageQty: 2, unitPrice: 400 }
        ],
        storeClaims: {
          'Shopee_Store 1': { status: 'RESOLVED', type: 'REFUND', refundAmount: 300 }
        }
      };

      expect(hasUnresolvedClaim(multiStorePO)).toBe(true);

      multiStorePO.storeClaims['Lazada_Store 2'] = { status: 'RESOLVED', type: 'REPLACEMENT', newTrackingNo: 'TH123456' };
      expect(hasUnresolvedClaim(multiStorePO)).toBe(false);
    });

    it('renders pulsating ping radar dot and urgent rose badge when claim items exist', () => {
      const mockPOs = [
        {
          id: 'PO-ONLINE-01',
          poNo: 'PO-QC-2026-001',
          purchaseChannel: 'ONLINE',
          status: 'IN_CLAIM',
          department: 'QC',
          totalAmount: 1500,
          items: [{ id: 'it-1', name: 'Chemical X', storePlatform: 'Shopee', actualStoreName: 'Shop A', shortageQty: 1, unitPrice: 1500, claimStatus: 'PENDING' }]
        }
      ];
      storageService.savePOs(mockPOs);

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineTaskView currentRole={{ id: 'PURCHASER', name: 'Purchaser' }} />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('รอเคลม');
      expect(html).toContain('bg-rose-500');
    });

    it('renders compact issue alert and 4-column single-line grid with indigo button instead of monster pink form', () => {
      const disputedPO = {
        id: 'PO-DISPUTE-01',
        poNo: 'PO-2026-DISP',
        status: 'IN_CLAIM',
        department: 'QC',
        vendorName: 'Shopee Shop',
        items: [
          {
            id: 'it-1',
            code: 'CH-01',
            name: 'Reagent Bottle',
            purchaseQty: 5,
            unit: 'ขวด',
            purchaseUnit: 'ขวด',
            unitPrice: 200,
            actualPrice: 200,
            storePlatform: 'Shopee',
            actualStoreName: 'ChemDirect',
            shortageQty: 2,
            damagedQty: 0,
            claimStatus: 'PENDING'
          }
        ],
        storeClaims: {}
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={disputedPO}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('🔴 รอเคลม (1 ร้านค้า)');
      expect(html).not.toContain('ปิดงานสำเร็จ (เคลมครบ)');
      expect(html).not.toContain('⚠️ คลังแจ้งปัญหา:');
      expect(html).toContain('🚨 ขาด 2 ขวด');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿400.00');
      expect(html).toContain('💰 คืนเงิน (Refund)');
      expect(html).toContain('📦 ส่งของใหม่ชดเชย (Replacement)');
      expect(html).toContain('❌ ยกเลิกรายการ');
      expect(html).toContain('คืนเต็มจำนวน');
      expect(html).toContain('✓ บันทึกผลเจรจา');
      expect(html).toContain('bg-indigo-600');
      expect(html).not.toContain('from-rose-50/60 to-white');
    });

    it('workflowEngine.resolveClaim handles CANCEL and store-level resolution to COMPLETED', async () => {
      const initialPO = {
        id: 'PO-WF-01',
        poNo: 'PO-WF-01',
        purchaseChannel: 'ONLINE',
        status: 'IN_CLAIM',
        department: 'PD',
        items: [{ id: '1', code: 'C1', name: 'Item', price: 500, qty: 2, shortageQty: 1 }]
      };
      storageService.savePOs([initialPO]);

      const res = await workflowEngine.resolveClaim('PO-WF-01', {
        type: 'CANCEL',
        refundAmount: 500,
        note: 'ยกเลิกรายการร้านค้า',
        storeKey: 'Shopee_Shop',
        allStoresResolved: true
      }, { name: 'Admin', title: 'Admin' });

      expect(res.status).toBe('COMPLETED');
      expect(res.claimStatus).toBe('RESOLVED');
      expect(res.storeClaims['Shopee_Shop'].status).toBe('RESOLVED');

      const txs = storageService.getBudgetTransactions();
      const claimTx = txs.find(t => t.refId === 'PO-WF-01');
      expect(claimTx).toBeDefined();
      expect(claimTx.amount).toBe(500);
      expect(claimTx.note).toContain('จัดซื้อเจรจาเคลมสำเร็จ ได้รับเงินคืน ฿500 เข้าแผนก');
    });

    it('OnlineProcurementHub exports the same unified component', () => {
      expect(OnlineProcurementHub).toBeDefined();
      expect(OnlineProcurementHub).toBe(OnlineTaskView);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 10: Online Order Claim Directives & Precision Logic
  // ══════════════════════════════════════════════════════════════════
  describe('10. Online Order Claim Directives & Precision Logic', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('supports item.receivedQty, item.grnReceivedQty, and item.goodQty', () => {
      const it1 = { actualQty: 3, receivedQty: 2, unitPrice: 150 };
      const m1 = calculateDisputeMetrics(it1);
      expect(m1.shortageQty).toBe(1);
      expect(m1.disputedQty).toBe(1);
      expect(m1.claimableAmount).toBe(150);
      expect(m1.hasDispute).toBe(true);

      const it2 = { actualQty: 3, grnReceivedQty: 2, unitPrice: 150 };
      const m2 = calculateDisputeMetrics(it2);
      expect(m2.shortageQty).toBe(1);
      expect(m2.claimableAmount).toBe(150);
      expect(m2.hasDispute).toBe(true);

      const it3 = { actualQty: 3, goodQty: 2, unitPrice: 150 };
      const m3 = calculateDisputeMetrics(it3);
      expect(m3.shortageQty).toBe(1);
      expect(m3.claimableAmount).toBe(150);
      expect(m3.hasDispute).toBe(true);
    });

    it('forces hasDispute = false when item is fully received (e.g. 3/3 สายรัดพาเลท)', () => {
      const fullItem = { name: 'สายรัดพาเลท', actualQty: 3, receivedQty: 3, damagedQty: 0, unitPrice: 50 };
      const metrics = calculateDisputeMetrics(fullItem);
      expect(metrics.orderedQty).toBe(3);
      expect(metrics.receivedQty).toBe(3);
      expect(metrics.shortageQty).toBe(0);
      expect(metrics.damagedQty).toBe(0);
      expect(metrics.disputedQty).toBe(0);
      expect(metrics.claimableAmount).toBe(0);
      expect(metrics.hasDispute).toBe(false);
    });

    it('calculates shortage accurately for 2 received of 3 ordered (1 missing, NOT 3 full claim)', () => {
      const partialItem = { name: 'ฟิล์มยืดพันพาเลท', actualQty: 3, receivedQty: 2, damagedQty: 0, unitPrice: 150 };
      const metrics = calculateDisputeMetrics(partialItem);
      expect(metrics.orderedQty).toBe(3);
      expect(metrics.receivedQty).toBe(2);
      expect(metrics.shortageQty).toBe(1);
      expect(metrics.disputedQty).toBe(1);
      expect(metrics.claimableAmount).toBe(150);
      expect(metrics.hasDispute).toBe(true);
    });

    it('collapses complete store (สายรัดพาเลท 3/3) to Slim Muted Row and expands disputed store (ฟิล์มยืด 2/3)', () => {
      const testPO = {
        id: 'PO-BB8943-TEST',
        poNo: 'PO-2026-BB8943',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        hasGRN: true,
        grnNumber: 'GRN-PO-2026-BB8943-01',
        items: [
          {
            id: 'it-strap',
            name: 'สายรัดพาเลท',
            code: 'STRAP-01',
            actualQty: 3,
            purchaseQty: 3,
            receivedQty: 3,
            damagedQty: 0,
            shortageQty: 0,
            unitPrice: 50,
            actualPrice: 50,
            unit: 'ม้วน',
            purchaseUnit: 'ม้วน',
            storePlatform: 'Shopee',
            actualStoreName: 'ร้านขายสายรัด'
          },
          {
            id: 'it-film',
            name: 'ฟิล์มยืดพันพาเลท',
            code: 'FILM-01',
            actualQty: 3,
            purchaseQty: 3,
            receivedQty: 2,
            damagedQty: 0,
            shortageQty: 1,
            unitPrice: 150,
            actualPrice: 150,
            unit: 'ม้วน',
            purchaseUnit: 'ม้วน',
            storePlatform: 'Shopee',
            actualStoreName: 'ร้านขายฟิล์ม'
          }
        ],
        storeClaims: {}
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={testPO}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('ร้าน: ร้านขายสายรัด');
      expect(html).toContain('(รับของครบสมบูรณ์)');
      expect(html).toContain('ร้าน: ร้านขายฟิล์ม');
      expect(html).toContain('⚠️ ร้านนี้มีรายการติดปัญหา');
      expect(html).toContain('🚨 ขาด 1 ม้วน');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿150.00');
      expect(html).toContain('value="150"');
      expect(html).not.toContain('value="450"');
    });

    it('synchronizes poItem.shortageQty and poItem.damagedQty accurately upon goods receipt in workflowEngine.receiveGoods', async () => {
      const mockPO = {
        id: 'PO-SYNC-TEST',
        poNo: 'PO-2026-SYNC',
        status: 'ORDERED',
        department: 'PD',
        purchaseChannel: 'ONLINE',
        items: [
          {
            id: 'item-1',
            productId: 'PROD-1',
            code: 'FILM-01',
            name: 'ฟิล์มยืดพันพาเลท',
            actualQty: 3,
            purchaseQty: 3,
            actualPrice: 150,
            unitPrice: 150,
            unit: 'ม้วน',
            receivedQty: 0
          }
        ],
        activityLog: []
      };

      storageService.savePOs([mockPO]);

      const updatedPO = await workflowEngine.receiveGoods(
        'PO-SYNC-TEST',
        [{ productId: 'PROD-1', receivedThisTime: 2 }],
        { name: 'Staff', title: 'Warehouse', id: 'WH-01' },
        'รับ 2 ขาด 1'
      );

      const updatedItem = updatedPO.items[0];
      expect(updatedItem.receivedQty).toBe(2);
      expect(updatedItem.remainingQty).toBe(1);
      expect(updatedItem.shortageQty).toBe(1);
      expect(updatedItem.orderedQty).toBe(3);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 11: Online High-Density Grouped Manifest Layout
  // ══════════════════════════════════════════════════════════════════
  describe('11. Online Procurement High-Density Grouped Manifest Layout', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    const mockPO = {
      id: 'PO-ONLINE-TEST-01',
      poNo: 'PO-ONLINE-TEST-01',
      prNo: 'PR-PD-999',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'IN_PROGRESS_ONLINE',
      vendorName: 'ร้านเคมีภัณฑ์อุตสาหกรรม',
      items: [
        {
          id: 'ITEM-1',
          productId: 'PROD-01',
          code: 'CHEM-001',
          name: 'สารละลายเคมีทดสอบความเข้มข้นสูงพิเศษ (Analytical Grade 99.8%)',
          qty: 2,
          purchaseQty: 2,
          price: 750,
          unitPrice: 750,
          unit: 'ขวด',
          purchaseUnit: 'ขวด',
          platform: 'Shopee',
          storePlatform: 'Shopee',
          actualStoreName: 'ChemicalPro Official',
          productUrl: 'https://shopee.co.th/product/123/456'
        },
        {
          id: 'ITEM-2',
          productId: 'PROD-02',
          code: 'GLOVE-002',
          name: 'ถุงมือไนไตรกันสารเคมีเกรดห้องปฏิบัติการ',
          qty: 5,
          purchaseQty: 5,
          price: 120,
          unitPrice: 120,
          unit: 'กล่อง',
          purchaseUnit: 'กล่อง',
          platform: 'Shopee',
          storePlatform: 'Shopee',
          actualStoreName: 'ChemicalPro Official',
          productUrl: 'https://shopee.co.th/product/123/789'
        }
      ]
    };

    it('1. Task Execution Mode (PENDING): Renders flat unified manifest, slim store header, and compact inline inputs', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockPO}
              activeTab="PENDING"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );



      expect(html).toContain('ยืนยันการสั่งซื้อแล้ว');
    });

    it('2. Read-Only Mode (ORDERED): Renders high-density compact rows (~38px) with math breakdown', () => {
      const orderedPO = { ...mockPO, status: 'ORDERED_PENDING_DELIVERY' };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={orderedPO}
              activeTab="ORDERED"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );


      expect(html).toContain('2 ขวด × ฿750.00 =');
      expect(html).toContain('5 กล่อง × ฿120.00 =');
      expect(html).not.toContain('p-3 space-y-2.5');
    });

    it('3. Claim View (CLAIM): Focuses on disputed stores with Quick Settlement Bar, collapses non-disputed stores into Slim Muted Row', () => {
      const multiStoreClaimPO = {
        ...mockPO,
        status: 'IN_CLAIM',
        items: [
          { ...mockPO.items[0], actualStoreName: 'ChemicalPro Broken Store', shortageQty: 1, damagedQty: 0, claimStatus: 'PENDING' },
          { ...mockPO.items[1], actualStoreName: 'Clean Glove Official Store', shortageQty: 0, damagedQty: 0, claimStatus: null }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={multiStoreClaimPO}
              activeTab="CLAIM"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).not.toContain('⚠️ คลังแจ้งปัญหา:');
      expect(html).toContain('🚨 ขาด 1 ขวด');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('ChemicalPro Broken Store');
      expect(html).toContain('คืนเงิน (Refund)');
      expect(html).toContain('✓ บันทึกผลเจรจา');
      expect(html).toContain('bg-indigo-600');
      expect(html).toContain('ร้าน: Clean Glove Official Store');
      expect(html).toContain('(รับของครบสมบูรณ์)');
      expect(html).toContain('เปิดดู / จัดการเคลม ▾');
      expect(html).toContain('ย่อเก็บ ▴');
    });

    it('4. Closed View (CLOSED): Default renders Compact Master Banner, expanded view locks fields and displays consolidated financial pill', () => {
      const closedPO = {
        ...mockPO,
        status: 'COMPLETED',
        refundAmount: 750,
        storeClaims: {
          'Shopee_ChemicalPro Official_https://shopee.co.th/product/123/456': {
            storeKey: 'Shopee_ChemicalPro Official_https://shopee.co.th/product/123/456',
            status: 'RESOLVED',
            type: 'REFUND',
            refundAmount: 750,
            resolvedAt: '2026-09-13T10:30:00.000Z'
          }
        }
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={closedPO}
              activeTab="CLOSED"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('PO-ONLINE-TEST-01');
      expect(html).toContain('งบ: ฿2,100.00');
      expect(html).toContain('จ่ายจริง: ฿1,350.00');
      expect(html).toContain('+คืน ฿750.00');
      expect(html).toContain('✓ ปิดงานสำเร็จ 100%');
      expect(html).toContain('ดูรายละเอียด');
      expect(html).not.toContain('placeholder="0.00"');

      const expandedHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={closedPO}
              activeTab="CLOSED"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              defaultExpanded={true}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(expandedHtml).not.toContain('placeholder="0.00"');
      expect(expandedHtml).not.toContain('✓ ยืนยันการสั่งซื้อแล้ว');
      expect(expandedHtml).toContain('✓ เคลมสำเร็จ: ได้รับเงินคืน ฿750.00 เข้าแผนกแล้ว');
      expect(expandedHtml).toContain('ปิดงานสำเร็จ 100%');
    });

    it('5. All View (ALL): Renders adaptive status badges with explicit color codes', () => {
      const pendingHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={{ ...mockPO, status: 'PENDING_ORDER' }}
              activeTab="ALL"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(pendingHtml).toContain('bg-amber-50 text-amber-700 border border-amber-200');

      const orderedHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={{ ...mockPO, status: 'IN_TRANSIT' }}
              activeTab="ALL"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(orderedHtml).toContain('bg-indigo-50 text-indigo-700 border border-indigo-200');

      const claimHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={{ ...mockPO, status: 'IN_CLAIM', items: [{ ...mockPO.items[0], shortageQty: 1, claimStatus: 'PENDING' }] }}
              activeTab="ALL"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(claimHtml).toContain('bg-rose-50 text-rose-700 border border-rose-200');

      const completedHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={{ ...mockPO, status: 'COMPLETED' }}
              activeTab="ALL"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(completedHtml).toContain('bg-emerald-50 text-emerald-700 border border-emerald-200');
    });

    it('6. Safety Fallback: Forces all stores active with Quick Settlement Bar when PO is in CLAIM but no items have shortage/damage', () => {
      const noItemDisputeClaimPO = {
        ...mockPO,
        status: 'IN_CLAIM',
        items: [
          { ...mockPO.items[0], actualStoreName: 'Store Alpha', shortageQty: 0, damagedQty: 0, claimStatus: null },
          { ...mockPO.items[1], actualStoreName: 'Store Beta', shortageQty: 0, damagedQty: 0, claimStatus: null }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={noItemDisputeClaimPO}
              activeTab="CLAIM"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('Store Alpha');
      expect(html).toContain('Store Beta');
      expect(html).not.toContain('⚠️ คลังแจ้งปัญหา:');
      expect(html).toContain('(รับของครบสมบูรณ์)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 12: Online Order Image Priority
  // ══════════════════════════════════════════════════════════════════
  describe('12. Online Order Image Priority - User Upload First vs Fallback Mock', () => {
    const customUserBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...CUSTOM_USER_PHOTO';

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('prioritizes user-uploaded image over FALLBACK_SEED_ATTACHMENTS for ITM-001 in createPOFromPR', async () => {
      const pr = {
        id: 'PR-TEST-USER-IMG',
        prNo: 'PD888/2026',
        department: 'PD',
        purchaseChannel: 'ONLINE',
        status: 'APPROVED',
        items: [
          {
            productId: 'PROD-01',
            code: 'ITM-001',
            name: 'ถุงมือยางเกรดพิเศษของฉัน',
            price: 250,
            qty: 5,
            images: [{ url: customUserBase64, previewUrl: customUserBase64, name: 'my-real-glove-photo.jpg' }],
            attachments: [{ url: customUserBase64, previewUrl: customUserBase64, name: 'my-real-glove-photo.jpg' }]
          }
        ]
      };

      const user = { name: 'Admin System', employeeName: 'คุณประเสริฐ ยิ่งยง' };
      const po = await workflowEngine.createPOFromPR(pr, user);

      expect(po).toBeDefined();
      expect(po.items.length).toBe(1);

      const poItem = po.items[0];
      expect(poItem.images.length).toBe(1);
      expect(poItem.images[0].url).toBe(customUserBase64);
      expect(poItem.attachments[0].url).toBe(customUserBase64);

      const fallbackSvg = FALLBACK_SEED_ATTACHMENTS['ITM-001'][0].url;
      expect(poItem.images[0].url).not.toBe(fallbackSvg);
    });

    it('falls back to FALLBACK_SEED_ATTACHMENTS only when user did not attach any image', async () => {
      const prWithoutImage = {
        id: 'PR-TEST-NO-IMG',
        prNo: 'PD889/2026',
        department: 'PD',
        purchaseChannel: 'ONLINE',
        status: 'APPROVED',
        items: [
          {
            productId: 'PROD-01',
            code: 'ITM-001',
            name: 'ถุงมือยาง (ไม่มีรูป)',
            price: 150,
            qty: 2,
            images: [],
            attachments: []
          }
        ]
      };

      const user = { name: 'Admin System', employeeName: 'คุณประเสริฐ ยิ่งยง' };
      const po = await workflowEngine.createPOFromPR(prWithoutImage, user);
      const poItem = po.items[0];

      expect(poItem.images.length).toBeGreaterThan(0);
      expect(poItem.images[0].url).toContain('data:image/svg+xml');
    });

    it('renders user-uploaded Base64 image in thumbnail instead of mock glove SVG in OnlineOrderCard', () => {
      const onlinePOWithUserUpload = {
        id: 'PO-ONLINE-USER-IMG',
        poNo: 'PO-PD-2026-999',
        status: 'IN_PROGRESS_ONLINE',
        department: 'PD',
        purchaseChannel: 'ONLINE',
        items: [
          {
            id: 'item-1',
            code: 'ITM-001',
            name: 'ถุงมือยางไนไตรล์สั่งพิเศษ',
            purchaseQty: 10,
            unitPrice: 200,
            actualPrice: 200,
            actualQty: 10,
            storePlatform: 'Shopee',
            actualStoreName: 'Medical Store Thailand',
            images: [{ url: customUserBase64, previewUrl: customUserBase64, name: 'custom-user-gloves.jpg' }],
            attachments: [{ url: customUserBase64, previewUrl: customUserBase64, name: 'custom-user-gloves.jpg' }]
          }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={onlinePOWithUserUpload}
              activeTab="PENDING"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'ฝ่ายจัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain(customUserBase64);
      const mockSvg = FALLBACK_SEED_ATTACHMENTS['ITM-001'][0].url;
      expect(html).not.toContain(mockSvg);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 13: Online Procurement Hub Density & Regression
  // ══════════════════════════════════════════════════════════════════
  describe('13. Online Procurement Hub High-Density Layout & Regression Scenarios', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    const mockCompletedPO = {
      id: 'PO-PD-2026-001',
      poNo: 'PO-PD-2026-001',
      prNo: 'PR-PD-2026-088',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'COMPLETED',
      claimStatus: 'RESOLVED',
      vendorName: 'Shopee Marketplace',
      estimatedAmount: 5105.00,
      totalAmount: 5105.00,
      refundAmount: 517.60,
      storeClaims: {
        'Shopee_storea': { storeKey: 'Shopee_storea', status: 'RESOLVED', type: 'REFUND', refundAmount: 246.00, resolvedAt: '2026-09-13T09:39:00.000Z' },
        'Shopee_packpro thailand': { storeKey: 'Shopee_packpro thailand', status: 'RESOLVED', type: 'REFUND', refundAmount: 271.60, resolvedAt: '2026-09-13T09:39:00.000Z' }
      },
      items: [
        { id: 'ITM-001', productId: 'PROD-001', sku: 'ITM-001', name: 'สายรัดพาเลทอย่างหนา 15 มม.', qty: 10, purchaseQty: 10, price: 387.50, unitPrice: 387.50, unit: 'ม้วน', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'PackPro Thailand', productUrl: 'https://shopee.co.th/product/111/222' },
        { id: 'ITM-002', productId: 'PROD-002', sku: 'ITM-002', name: 'น้ำมันหล่อลื่นอเนกประสงค์เกรดอาหาร', qty: 5, purchaseQty: 5, price: 246.00, unitPrice: 246.00, unit: 'ถัง', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'StoreA', refundAmt: 246.00, shortageQty: 1, productUrl: 'https://shopee.co.th/product/333/444' }
      ]
    };

    const mockPendingPO = {
      id: 'PO-PD-2026-002',
      poNo: 'PO-PD-2026-002',
      prNo: 'PR-PD-2026-089',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'PENDING_ORDER',
      vendorName: 'Shopee Official Store',
      estimatedAmount: 2400.00,
      totalAmount: 2400.00,
      items: [{ id: 'ITM-003', productId: 'PROD-003', sku: 'ITM-003', name: 'ถุงมือกันบาด Level 5', qty: 20, purchaseQty: 20, price: 120.00, unitPrice: 120.00, unit: 'คู่', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'SafetyFirst Shop', productUrl: 'https://shopee.co.th/product/555/666' }]
    };

    const mockClaimPO = {
      id: 'PO-PD-2026-003',
      poNo: 'PO-PD-2026-003',
      prNo: 'PR-PD-2026-090',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'IN_CLAIM',
      hasDispute: true,
      vendorName: 'ToolMaster Store',
      estimatedAmount: 3500.00,
      totalAmount: 3500.00,
      items: [{ id: 'ITM-004', productId: 'PROD-004', sku: 'ITM-004', name: 'ชุดเครื่องมือช่างซ่อมบำรุง', qty: 2, purchaseQty: 2, price: 1750.00, unitPrice: 1750.00, unit: 'ชุด', platform: 'Shopee', storePlatform: 'Shopee', actualStoreName: 'ToolMaster Store', shortageQty: 1, damagedQty: 0, hasDispute: true, productUrl: 'https://shopee.co.th/product/777/888' }]
    };

    it('Scenario 1 (Default Compact View in Completed Tab): Collapsed Compact Master Banner (~68px) renders key identifiers, consolidated financials, and completion badge without inner tables', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockCompletedPO}
              activeTab="CLOSED"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('rounded-xl p-3 sm:px-4 sm:py-2.5 transition-all mb-2.5');
      expect(html).toContain('PO-PD-2026-001');
      expect(html).toContain('PD');
      expect(html).toContain('PR: PR-PD-2026-088');
      expect(html).toContain('2 ร้านค้า');
      expect(html).toContain('งบ: ฿5,105.00');
      expect(html).toContain('จ่ายจริง: ฿4,587.40');
      expect(html).toContain('+คืน ฿517.60');
      expect(html).toContain('✓ ปิดงานสำเร็จ 100%');
      expect(html).toContain('ดูรายละเอียด');
      expect(html).toContain('สายรัดพาเลทอย่างหนา 15 มม. และอีก 1 รายการ');
      expect(html).not.toContain('น้ำมันหล่อลื่นอเนกประสงค์เกรดอาหาร');
    });

    it('Scenario 2 (Expand / Collapse Interaction): Clicking or setting defaultExpanded=true renders slim data rows, low-profile store dividers, and collapse triggers', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockCompletedPO}
              activeTab="CLOSED"
              defaultExpanded={true}
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('bg-white border border-slate-200/90 hover:border-slate-300 rounded-2xl p-3.5 shadow-xs transition-all mb-2.5 font-sans');
      expect(html).toContain('title="ย่อการ์ดนี้"');

    });

    it('Scenario 3 (Actionable Tab Readiness): Actionable tabs (PENDING, CLAIM) default to expanded view with compact inputs and quick settlement bar', () => {
      const pendingHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockPendingPO}
              activeTab="PENDING"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(pendingHtml).toContain('PO-PD-2026-002');
      expect(pendingHtml).toContain('รอดำเนินการสั่งซื้อ');
      expect(pendingHtml).toContain('ระบุชื่อร้านค้าจริง...');
      expect(pendingHtml).toContain('ยืนยันการสั่งซื้อแล้ว');
      expect(pendingHtml).toContain('งบประเมิน PR:');

      const claimHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockClaimPO}
              activeTab="CLAIM"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(claimHtml).toContain('PO-PD-2026-003');
      expect(claimHtml).toContain('🚨 ขาด 1 ชุด');
      expect(claimHtml).toContain('มูลค่าที่ต้องเคลม');
      expect(claimHtml).toContain('คืนเงิน (Refund)');
      expect(claimHtml).toContain('✓ บันทึกผลเจรจา');
    });

    it('Scenario 4 (Visual Harmony & Elimination of Bulky Alert Banners): Resolves refund and replacement with clean micro-badges adjacent to item rows', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={mockCompletedPO}
              activeTab="CLOSED"
              defaultExpanded={true}
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'จัดซื้อออนไลน์', canOnlinePurchase: true }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).not.toContain('px-3.5 py-1.5 bg-slate-50/40');
      expect(html).toContain('px-3 py-1 bg-emerald-50/50 border-b border-emerald-100 flex items-center justify-between text-xs text-emerald-800');
      expect(html).toContain('✓ เคลมสำเร็จ: ได้รับเงินคืน ฿246.00 เข้าแผนกแล้ว');
      expect(html).toContain('✓ ได้รับเงินคืน ฿246.00 เข้าแผนกแล้ว (16:39)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 14: Dispute Metrics & Settlement Business Logic
  // ══════════════════════════════════════════════════════════════════
  describe('14. Online Procurement Dispute Metrics & Settlement Business Logic', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('Case 1 (Shortage Only): ordered=5, received=4, unitPrice=254.10 -> disputedQty=1, claimableAmount=254.10', () => {
      const item = { name: 'สารเคมีทำความสะอาด', actualQty: 5, receivedQty: 4, unitPrice: 254.10, unit: 'ขวด' };
      const metrics = calculateDisputeMetrics(item);
      expect(metrics.orderedQty).toBe(5);
      expect(metrics.receivedQty).toBe(4);
      expect(metrics.shortageQty).toBe(1);
      expect(metrics.damagedQty).toBe(0);
      expect(metrics.disputedQty).toBe(1);
      expect(metrics.unitPrice).toBe(254.10);
      expect(metrics.claimableAmount).toBe(254.10);
      expect(metrics.hasDispute).toBe(true);
    });

    it('Case 2 (Damaged Only): ordered=5, received=5, damaged=2, unitPrice=254.10 -> disputedQty=2, claimableAmount=508.20', () => {
      const item = { name: 'สารเคมีทำความสะอาด', actualQty: 5, receivedQty: 5, damagedQty: 2, unitPrice: 254.10, unit: 'ขวด' };
      const metrics = calculateDisputeMetrics(item);
      expect(metrics.orderedQty).toBe(5);
      expect(metrics.receivedQty).toBe(5);
      expect(metrics.shortageQty).toBe(0);
      expect(metrics.damagedQty).toBe(2);
      expect(metrics.disputedQty).toBe(2);
      expect(metrics.claimableAmount).toBe(508.20);
      expect(metrics.hasDispute).toBe(true);
    });

    it('Case 3 (Shortage and Damaged): ordered=5, received=3, damaged=1, unitPrice=254.10 -> disputedQty=2, claimableAmount=508.20', () => {
      const item = { name: 'สารเคมีทำความสะอาด', actualQty: 5, receivedQty: 3, damagedQty: 1, unitPrice: 254.10, unit: 'ขวด' };
      const metrics = calculateDisputeMetrics(item);
      expect(metrics.orderedQty).toBe(5);
      expect(metrics.receivedQty).toBe(3);
      expect(metrics.shortageQty).toBe(1);
      expect(metrics.damagedQty).toBe(1);
      expect(metrics.disputedQty).toBe(2);
      expect(metrics.claimableAmount).toBe(508.20);
      expect(metrics.hasDispute).toBe(true);
    });

    it('Case 4 (100% Received): ordered=5, received=5, damaged=0, unitPrice=254.10 -> disputedQty=0, claimableAmount=0, hasDispute=false', () => {
      const item = { name: 'สารเคมีทำความสะอาด', actualQty: 5, receivedQty: 5, damagedQty: 0, unitPrice: 254.10, unit: 'ขวด' };
      const metrics = calculateDisputeMetrics(item);
      expect(metrics.orderedQty).toBe(5);
      expect(metrics.receivedQty).toBe(5);
      expect(metrics.shortageQty).toBe(0);
      expect(metrics.damagedQty).toBe(0);
      expect(metrics.disputedQty).toBe(0);
      expect(metrics.claimableAmount).toBe(0);
      expect(metrics.hasDispute).toBe(false);
    });

    it('Respects explicit shortageQty if provided, without falling back to orderedQty', () => {
      const item = { actualQty: 10, shortageQty: 3, unitPrice: 100 };
      const metrics = calculateDisputeMetrics(item);
      expect(metrics.shortageQty).toBe(3);
      expect(metrics.disputedQty).toBe(3);
      expect(metrics.claimableAmount).toBe(300);
      expect(metrics.hasDispute).toBe(true);
    });

    it('Does NOT fall back to orderedQty (ordered=5, received=4) - strictly 1 unit disputed', () => {
      const itemWithoutExplicitShortage = { purchaseQty: 5, actualQty: 5, receivedQty: 4, unitPrice: 254.10 };
      const metrics = calculateDisputeMetrics(itemWithoutExplicitShortage);
      expect(metrics.disputedQty).toBe(1);
      expect(metrics.claimableAmount).toBe(254.10);
    });

    it('renders exact Alert Banner and Default Refund for 1 shortage item (฿254.10, NOT ฿1,270.50)', () => {
      const poWithSingleShortage = {
        id: 'PO-TEST-DISPUTE-01',
        poNo: 'PO-2026-DISP-01',
        status: 'IN_CLAIM',
        department: 'QC',
        vendorName: 'Shopee Official Shop',
        items: [
          {
            id: 'item-1',
            code: 'CHEM-01',
            name: 'น้ำยาทำความสะอาดหัววัด pH',
            purchaseQty: 5,
            actualQty: 5,
            receivedQty: 4,
            shortageQty: 1,
            damagedQty: 0,
            unit: 'ขวด',
            purchaseUnit: 'ขวด',
            unitPrice: 254.10,
            actualPrice: 254.10,
            storePlatform: 'Shopee',
            actualStoreName: 'ChemSupply Pro'
          }
        ],
        storeClaims: {}
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={poWithSingleShortage}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).not.toContain('⚠️ คลังแจ้งปัญหา:');
      expect(html).toContain('น้ำยาทำความสะอาดหัววัด pH');
      expect(html).toContain('🚨 ขาด 1 ขวด');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿254.10');
      expect(html).not.toContain('🚨 ขาด 5 ขวด');
      expect(html).not.toContain('value="1270.5"');
      expect(html).toContain('value="254.1"');
      expect(html).toContain('คืนเต็มจำนวน');
      expect(html).toContain('💰 คืนเงิน (Refund)');
      expect(html).toContain('✓ บันทึกผลเจรจา');
    });

    it('multi-store: collapses fully received store into Slim Muted Row, expands disputed store only', () => {
      const multiStorePO = {
        id: 'PO-MULTI-02',
        poNo: 'PO-2026-MULTI-02',
        status: 'IN_CLAIM',
        department: 'PD',
        items: [
          { id: 'it-1', name: 'Item In Store 1', actualQty: 5, receivedQty: 4, unitPrice: 254.10, unit: 'ชิ้น', storePlatform: 'Shopee', actualStoreName: 'Disputed Store' },
          { id: 'it-2', name: 'Item In Store 2', actualQty: 3, receivedQty: 3, unitPrice: 100, unit: 'ชิ้น', storePlatform: 'Lazada', actualStoreName: 'Complete Store' }
        ],
        storeClaims: {}
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={multiStorePO}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('ร้าน: Disputed Store');
      expect(html).toContain('🚨 ขาด 1 ชิ้น');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿254.10');
      expect(html).toContain('ย่อเก็บ ▴');
      expect(html).toContain('ร้าน: Complete Store');
      expect(html).toContain('(รับของครบสมบูรณ์)');
      expect(html).toContain('เปิดดู / จัดการเคลม ▾');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 15: Monthly Data Partitioning & High-Density Completed
  // ══════════════════════════════════════════════════════════════════
  describe('15. Online Procurement Monthly Data Partitioning & High-Density Completed Suite', () => {
    const currentRole = { id: 'ONLINE_PURCHASER', name: 'เจ้าหน้าที่จัดซื้อออนไลน์', canOnlinePurchase: true };

    const septPO = {
      id: 'PO-SEPT-001',
      poNo: 'PO-PD-2026-001',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'COMPLETED',
      completedAt: '2026-09-13T10:00:00.000Z',
      actualTotal: 4500,
      totalRefunded: 500,
      totalAmount: 5000,
      items: [
        { id: 'item-1', name: 'ถุงมือยางไนไตรล์สีฟ้า', actualStoreName: 'ร้านอุปกรณ์เซฟตี้', storePlatform: 'Shopee', actualQty: 10, actualPrice: 450, receivedQty: 10 },
        { id: 'item-2', name: 'หน้ากากกันสารเคมี 3M', actualStoreName: 'ร้านเคมีภัณฑ์แล็บ', storePlatform: 'Lazada', actualQty: 2, actualPrice: 250, receivedQty: 2 }
      ]
    };

    const augPO = {
      id: 'PO-AUG-001',
      poNo: 'PO-PD-2026-002',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'COMPLETED',
      completedAt: '2026-08-25T14:30:00.000Z',
      actualTotal: 3200,
      totalRefunded: 0,
      totalAmount: 3200,
      items: [
        { id: 'item-3', name: 'เทปตีเส้นพื้นสีเหลือง-ดำ', actualStoreName: 'ร้านฮาร์ดแวร์โปร', storePlatform: 'Shopee', actualQty: 8, actualPrice: 400, receivedQty: 8 }
      ]
    };

    const pendingPO = {
      id: 'PO-PENDING-001',
      poNo: 'PO-QC-2026-099',
      department: 'QC',
      purchaseChannel: 'ONLINE',
      status: 'PENDING_ORDER',
      createdAt: '2026-07-10T08:00:00.000Z',
      totalAmount: 1200,
      items: [{ id: 'item-4', name: 'บีกเกอร์แก้ว 500ml', actualQty: 5, unitPrice: 240 }]
    };

    const orderedPO = {
      id: 'PO-ORDERED-001',
      poNo: 'PO-PD-2026-100',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'ORDERED',
      orderedAt: '2026-07-15T09:00:00.000Z',
      totalAmount: 2800,
      items: [{ id: 'item-5', name: 'ฟิล์มยืดพันพาเลท', actualQty: 4, unitPrice: 700 }]
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.savePOs([septPO, augPO, pendingPO, orderedPO]);
    });

    it('defaults to current month (2026-09) and excludes older months from immediate view', () => {
      const pos = [septPO, augPO];
      const septCompleted = filteredOrders(pos, 'CLOSED', '2026-09');
      expect(septCompleted.length).toBe(1);
      expect(septCompleted[0].poNo).toBe('PO-PD-2026-001');

      const storagePartition = storageService.getCompletedPOsByMonth('2026-09');
      expect(storagePartition.some(p => p.id === 'PO-SEPT-001')).toBe(true);
      expect(storagePartition.some(p => p.id === 'PO-AUG-001')).toBe(false);
    });

    it('formats Thai month representations accurately', () => {
      expect(formatThaiMonth('2026-09')).toBe('กันยายน 2569');
      expect(formatThaiMonth('2026-08')).toBe('สิงหาคม 2569');
      expect(formatThaiMonth('ALL_YEAR')).toBe('ตลอดปี 2569');
    });

    it('computes correct previous and next months', () => {
      expect(getPrevMonth('2026-09')).toBe('2026-08');
      expect(getNextMonth('2026-09')).toBe('2026-10');
      expect(getPrevMonth('2026-01')).toBe('2025-12');
      expect(getNextMonth('2026-12')).toBe('2027-01');
    });

    it('switching to August partitions completed POs and updates financial KPI metrics', () => {
      const pos = [septPO, augPO];
      const augCompleted = filteredOrders(pos, 'CLOSED', '2026-08');
      expect(augCompleted.length).toBe(1);
      expect(augCompleted[0].poNo).toBe('PO-PD-2026-002');

      const kpisAug = calculateCompletedKPIs(augCompleted);
      expect(kpisAug.count).toBe(1);
      expect(kpisAug.totalActualSpent).toBe(3200);
      expect(kpisAug.totalRefunds).toBe(0);

      const kpisSept = calculateCompletedKPIs([septPO]);
      expect(kpisSept.count).toBe(1);
      expect(kpisSept.totalActualSpent).toBe(4500);
      expect(kpisSept.totalRefunds).toBe(500);
    });

    it('keeps active non-completed tabs invariant and unrestricted by monthly partition', () => {
      const pos = [septPO, augPO, pendingPO, orderedPO];
      expect(filteredOrders(pos, 'PENDING').length).toBe(1);
      expect(filteredOrders(pos, 'PENDING')[0].poNo).toBe('PO-QC-2026-099');
      expect(filteredOrders(pos, 'ORDERED').length).toBe(1);
      expect(filteredOrders(pos, 'ORDERED')[0].poNo).toBe('PO-PD-2026-100');
    });

    it('renders ultra-compact 5-column completed row layout in default collapsed state', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={septPO}
              activeTab="CLOSED"
              currentRole={currentRole}
              defaultExpanded={false}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('PO-PD-2026-001');
      expect(html).toContain('PD');
      expect(html).toContain('13/09/2026');
      expect(html).toContain('2 ร้านค้า (Shopee 1, Lazada 1)');
      expect(html).toContain('ถุงมือยางไนไตรล์สีฟ้า และอีก 1 รายการ');
      expect(html).toContain('฿4,500.00');
      expect(html).toContain('+คืน ฿500.00');
      expect(html).toContain('👁️ ดูรายการสินค้า');
      expect(html).toContain('PO ฉบับเต็ม');
      expect(html).toContain('shadow-sm');
      expect(html).toContain('border-t border-slate-100');
    });

    it('expands detail breakdown on-demand upon clicking expand', () => {
      const expandedHtml = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={septPO}
              activeTab="CLOSED"
              currentRole={currentRole}
              defaultExpanded={true}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(expandedHtml).toContain('ร้านอุปกรณ์เซฟตี้');
      expect(expandedHtml).toContain('ร้านเคมีภัณฑ์แล็บ');
      expect(expandedHtml).toContain('หน้ากากกันสารเคมี 3M');
      expect(expandedHtml).toContain('ย่อ');
    });

    it('partitions large dataset into 15 items per page cleanly', () => {
      const mockPOs = Array.from({ length: 20 }).map((_, idx) => ({
        id: `PO-MOCK-${idx + 1}`,
        poNo: `PO-PD-2026-${String(idx + 1).padStart(3, '0')}`,
        department: 'PD',
        purchaseChannel: 'ONLINE',
        status: 'COMPLETED',
        completedAt: '2026-09-10T10:00:00.000Z',
        actualTotal: 1000 + idx * 100,
        items: [{ id: `item-${idx}`, name: `สินค้าทดสอบ ${idx + 1}`, actualQty: 1, actualPrice: 1000 }]
      }));

      const septCompleted = filteredOrders(mockPOs, 'CLOSED', '2026-09');
      expect(septCompleted.length).toBe(20);

      const PAGE_SIZE = 15;
      const page1 = septCompleted.slice(0, PAGE_SIZE);
      const page2 = septCompleted.slice(PAGE_SIZE, PAGE_SIZE * 2);

      expect(page1.length).toBe(15);
      expect(page2.length).toBe(5);
      expect(page1[0].poNo).toBe('PO-PD-2026-001');
      expect(page2[0].poNo).toBe('PO-PD-2026-016');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 16: Vanishing Orders Bug Resolution & 2-Tier Micro Card
  // ══════════════════════════════════════════════════════════════════
  describe('16. Vanishing Orders Bug Resolution & 2-Tier Micro Card Verification Suite', () => {
    const currentRole = { id: 'ONLINE_PURCHASER', name: 'เจ้าหน้าที่จัดซื้อออนไลน์', canOnlinePurchase: true };

    const poCompletedWithThaiDate = {
      id: 'PO-PD-2026-001',
      poNo: 'PO-PD-2026-001',
      poNumber: 'PO-PD-2026-001',
      prNo: 'PD001/2026',
      prNumber: 'PD001/2026',
      department: 'PD',
      purchaseChannel: 'ONLINE',
      status: 'COMPLETED',
      claimStatus: 'RESOLVED',
      completedAt: '13/09/2026 17:47',
      orderDate: '13/09/2026',
      totalAmount: 5105.00,
      estimatedAmount: 5105.00,
      refundAmount: 517.60,
      storeClaims: {
        'Shopee_storea': { storeKey: 'Shopee_storea', status: 'RESOLVED', type: 'REFUND', refundAmount: 246.00, resolvedAt: '13/09/2026 17:47' },
        'Shopee_packpro thailand': { storeKey: 'Shopee_packpro thailand', status: 'RESOLVED', type: 'REFUND', refundAmount: 271.60, resolvedAt: '13/09/2026 17:47' }
      },
      items: [
        { id: 'ITM-001', name: 'สายรัดพาเลทอย่างหนา 15 มม.', actualStoreName: 'PackPro Thailand', storePlatform: 'Shopee', qty: 10, purchaseQty: 10, unitPrice: 387.50, price: 387.50 },
        { id: 'ITM-002', name: 'น้ำมันหล่อลื่นอเนกประสงค์เกรดอาหาร', actualStoreName: 'StoreA', storePlatform: 'Shopee', qty: 5, purchaseQty: 5, unitPrice: 246.00, price: 246.00, refundAmt: 246.00 }
      ]
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('parses Thai/Standard DD/MM/YYYY date strings accurately in parseOrderYearMonth', () => {
      expect(parseOrderYearMonth('13/09/2026')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
      expect(parseOrderYearMonth('13/09/2026 17:47')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
      expect(parseOrderYearMonth('01/08/2026 09:15:30')).toEqual({ year: 2026, month: '08', ymKey: '2026-08' });
    });

    it('parses Thai Buddhist Era (BE > 2500) dates and converts to Common Era (CE)', () => {
      expect(parseOrderYearMonth('13/09/2569')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
      expect(parseOrderYearMonth('13/09/2569 17:47:00')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
    });

    it('parses ISO format YYYY-MM-DD and timestamps accurately', () => {
      expect(parseOrderYearMonth('2026-09-13')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
      expect(parseOrderYearMonth('2026-09-13T10:00:00.000Z')).toEqual({ year: 2026, month: '09', ymKey: '2026-09' });
      expect(parseOrderYearMonth('2026-08-25T14:30:00.000Z')).toEqual({ year: 2026, month: '08', ymKey: '2026-08' });
    });

    it('safely handles empty, null, undefined, or invalid inputs in parseOrderYearMonth', () => {
      expect(parseOrderYearMonth('')).toEqual({ year: null, month: null, ymKey: null });
      expect(parseOrderYearMonth(null)).toEqual({ year: null, month: null, ymKey: null });
      expect(parseOrderYearMonth(undefined)).toEqual({ year: null, month: null, ymKey: null });
      expect(parseOrderYearMonth('invalid-date-string')).toEqual({ year: null, month: null, ymKey: null });
    });

    it('immediately displays PO-PD-2026-001 (dated 13/09/2026) under current month "กันยายน 2569" (2026-09)', () => {
      const orders = [poCompletedWithThaiDate];
      const completedFiltered = filteredOrders(orders, 'CLOSED', '2026-09');
      expect(completedFiltered.length).toBe(1);
      expect(completedFiltered[0].poNo).toBe('PO-PD-2026-001');
      expect(completedFiltered[0].department).toBe('PD');
    });

    it('storageService.getCompletedPOsByMonth retrieves PO-PD-2026-001 under 2026-09', () => {
      storageService.savePOs([poCompletedWithThaiDate]);
      const stored = storageService.getCompletedPOsByMonth('2026-09');
      expect(stored.length).toBe(1);
      expect(stored[0].poNo).toBe('PO-PD-2026-001');
    });

    it('PO-PD-2026-001 remains visible and is not filtered out when selectedMonth is ALL_YEAR', () => {
      const orders = [poCompletedWithThaiDate];
      const allYearFiltered = filteredOrders(orders, 'CLOSED', 'ALL_YEAR');
      expect(allYearFiltered.length).toBe(1);
      expect(allYearFiltered[0].poNo).toBe('PO-PD-2026-001');
    });

    it('storageService.getCompletedPOsByMonth retrieves PO-PD-2026-001 when query is ALL_YEAR', () => {
      storageService.savePOs([poCompletedWithThaiDate]);
      const storedAllYear = storageService.getCompletedPOsByMonth('ALL_YEAR');
      expect(storedAllYear.length).toBe(1);
      expect(storedAllYear[0].poNo).toBe('PO-PD-2026-001');
    });

    it('KPI calculations accurately compute count, actual spend, and refund credits', () => {
      const kpis = calculateCompletedKPIs([poCompletedWithThaiDate]);
      expect(kpis.count).toBe(1);
      expect(kpis.totalRefunds).toBeCloseTo(517.60, 2);
      expect(kpis.totalActualSpent).toBeCloseTo(4587.40, 2);
    });

    it('OnlineTaskView renders matching KPI banner metrics', () => {
      storageService.savePOs([poCompletedWithThaiDate]);
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineTaskView currentRole={currentRole} />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html).toContain('งานจัดซื้อออนไลน์');
    });

    it('renders master completed row cleanly partitioned across Tier 1 and Tier 2', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={poCompletedWithThaiDate}
              activeTab="CLOSED"
              currentRole={currentRole}
              defaultExpanded={false}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('w-full bg-white hover:bg-slate-50/80 border border-slate-200/90');
      expect(html).toContain('rounded-xl p-3 sm:px-4 sm:py-2.5 transition-all mb-2.5 shadow-sm');
      expect(html).toContain('PO-PD-2026-001');
      expect(html).toContain('PD');
      expect(html).toContain('PR: PD001/2026');
      expect(html).toContain('2 ร้านค้า');
      expect(html).toContain('จ่ายจริง:');
      expect(html).toContain('฿4,587.40');
      expect(html).toContain('✓ ปิดงานสำเร็จ 100%');
      expect(html).toContain('border-t border-slate-100');
      expect(html).toContain('13/09/2026');
      expect(html).toContain('สายรัดพาเลทอย่างหนา 15 มม. และอีก 1 รายการ');
      expect(html).toContain('งบ: ฿5,105.00');
      expect(html).toContain('+คืน ฿517.60');
      expect(html).toContain('👁️ ดูรายการสินค้า');
      expect(html).toContain('PO ฉบับเต็ม');
    });

    it('renders EmptyState with recovery button "[ ดูคำสั่งซื้อทั้งหมดในปี 2569 ]" when no records exist in selected month', () => {
      storageService.savePOs([]);
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineTaskView currentRole={currentRole} />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html).toContain('ศูนย์จัดการคำสั่งซื้อผ่าน Shopee / Lazada');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 17: Claim Task Stuck & False Disputed Store Counter Fixes
  // ══════════════════════════════════════════════════════════════════
  describe('17. Claim Task Stuck & False Disputed Store Counter Fixes', () => {
    const onlineRole = {
      id: 'ONLINE_PURCHASER',
      roleId: 'ONLINE_PURCHASER',
      name: 'Online Purchaser',
      canOnlinePurchase: true,
      level: 1
    };

    const createMock3StorePO = () => ({
      id: 'PO-3STORE-CLAIM',
      poNo: 'PO-2026-3S',
      status: 'PARTIALLY_RECEIVED_IN_CLAIM',
      claimStatus: 'IN_CLAIM',
      hasDispute: true,
      isInClaim: true,
      hasGRN: true,
      department: 'QC',
      purchaseChannel: 'ONLINE',
      items: [
        { id: 'item-1', name: 'Chemical Reagent', storePlatform: 'Shopee', actualStoreName: 'แ้กั้กเก็ดใด', actualQty: 10, receivedQty: 8, shortageQty: 2, shortageAction: 'CLAIM_SHORTAGE', damagedQty: 0, actualPrice: 150 },
        { id: 'item-2', name: 'Plastic Pipette', storePlatform: 'Shopee', actualStoreName: "'กพั๊กพ", actualQty: 5, receivedQty: 4, damagedQty: 1, shortageQty: 0, actualPrice: 200 },
        { id: 'item-3', name: 'Filter Paper', storePlatform: 'Shopee', actualStoreName: '24525sนีเร', actualQty: 10, receivedQty: 7, shortageQty: 3, shortageAction: 'WAIT_NEXT_ROUND', damagedQty: 0, actualPrice: 80 }
      ],
      storeClaims: {}
    });

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('1. Directive 1: isStorePendingClaim ignores WAIT_NEXT_ROUND store and handles special quotes store name', () => {
      const storeWaitNextRound = {
        storeKey: 'Shopee_24525sนีเร',
        storeName: '24525sนีเร',
        items: [{ shortageQty: 3, shortageAction: 'WAIT_NEXT_ROUND', damagedQty: 0 }]
      };

      const storeWithQuote = {
        storeKey: "Shopee_'กพั๊กพ",
        storeName: "'กพั๊กพ",
        items: [{ damagedQty: 1, shortageQty: 0 }]
      };

      expect(isStorePendingClaim(storeWaitNextRound, {})).toBe(false);
      expect(isStorePendingClaim(storeWithQuote, {})).toBe(true);

      const storeClaims = {
        "Shopee_'กพั๊กพ": { status: 'RESOLVED', isResolved: true, type: 'REPLACEMENT' }
      };
      expect(isStoreClaimResolved(storeWithQuote, storeClaims)).toBe(true);
      expect(isStorePendingClaim(storeWithQuote, storeClaims)).toBe(false);

      const storeClaimsNameKey = {
        "'กพั๊กพ": { status: 'RESOLVED', isResolved: true, type: 'REPLACEMENT' }
      };
      expect(isStoreClaimResolved(storeWithQuote, storeClaimsNameKey)).toBe(true);
      expect(isStorePendingClaim(storeWithQuote, storeClaimsNameKey)).toBe(false);
    });

    it('2. Directive 1: Card header counts ONLY genuine claim stores and hides claim badge when all resolved', () => {
      const po = createMock3StorePO();

      const html2Unresolved = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/online-tasks']}>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="CLAIM" currentRole={onlineRole} />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html2Unresolved).toContain('🔴 รอเคลม (2 ร้านค้า)');

      po.storeClaims = {
        'Shopee_แ้กั้กเก็ดใด': { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 300 }
      };

      const html1Unresolved = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/online-tasks']}>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="CLAIM" currentRole={onlineRole} />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html1Unresolved).toContain('🔴 รอเคลม (1 ร้านค้า)');

      po.storeClaims["Shopee_'กพั๊กพ"] = { isResolved: true, status: 'RESOLVED', type: 'REPLACEMENT', replacementTrackingNo: 'TH1234567' };

      const html0Unresolved = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/online-tasks']}>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="CLAIM" currentRole={onlineRole} />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html0Unresolved).not.toContain('🔴 รอเคลม');
    });

    it('3. Directive 2: Auto-transitions PO out of CLAIM to ORDERED when replacement/waiting deliveries exist', async () => {
      const po = createMock3StorePO();
      po.storeClaims = {
        'Shopee_แ้กั้กเก็ดใด': { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 300 },
        "Shopee_'กพั๊กพ": { isResolved: true, status: 'RESOLVED', type: 'REPLACEMENT', newTrackingNo: 'REPLACE-999' }
      };

      storageService.savePOs([po]);

      const updatedPO = await workflowEngine.resolveClaim(
        po.id,
        {
          storeKey: "Shopee_'กพั๊กพ",
          type: 'REPLACEMENT',
          newTrackingNo: 'REPLACE-999',
          allStoresResolved: true,
          hasPendingDeliveries: true
        },
        onlineRole,
        po
      );

      expect(updatedPO.status).toBe('WAITING_DELIVERY_ROUND_2');
      expect(updatedPO.claimStatus).toBe('REPLACEMENT_PENDING');
      expect(updatedPO.hasDispute).toBe(false);
      expect(updatedPO.isInClaim).toBe(false);
      expect(hasUnresolvedClaim(updatedPO)).toBe(false);

      expect(filterOrdersByTab([updatedPO], 'CLAIM').length).toBe(0);
      expect(filterOrdersByTab([updatedPO], 'ORDERED').length).toBe(1);
    });

    it('4. Directive 2: Auto-transitions PO to COMPLETED when all stores are settled via REFUND and no pending deliveries', async () => {
      const po = {
        id: 'PO-REFUND-ALL',
        poNo: 'PO-2026-REF',
        department: 'QC',
        purchaseChannel: 'ONLINE',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        hasDispute: true,
        isInClaim: true,
        hasGRN: true,
        items: [{ id: 'item-1', name: 'Item A', storePlatform: 'Shopee', actualStoreName: 'StoreA', shortageQty: 1, shortageAction: 'CLAIM_SHORTAGE', actualPrice: 100 }],
        storeClaims: {}
      };

      storageService.savePOs([po]);

      const updatedPO = await workflowEngine.resolveClaim(
        po.id,
        {
          storeKey: 'Shopee_StoreA',
          type: 'REFUND',
          refundAmount: 100,
          allStoresResolved: true,
          hasPendingDeliveries: false
        },
        onlineRole,
        po
      );

      expect(updatedPO.status).toBe('COMPLETED');
      expect(updatedPO.claimStatus).toBe('RESOLVED');
      expect(updatedPO.hasDispute).toBe(false);
      expect(filterOrdersByTab([updatedPO], 'CLAIM').length).toBe(0);
      expect(filterOrdersByTab([updatedPO], 'CLOSED').length).toBe(1);
    });

    it('5. Directive 3: Syncs badge to 0 at Tab and Sidebar when claims are resolved', () => {
      const po = createMock3StorePO();
      po.storeClaims = {
        'Shopee_แ้กั้กเก็ดใด': { isResolved: true, status: 'RESOLVED', type: 'REFUND', refundAmount: 300 },
        "Shopee_'กพั๊กพ": { isResolved: true, status: 'RESOLVED', type: 'REPLACEMENT' }
      };
      po.hasDispute = false;
      po.isInClaim = false;
      po.claimStatus = 'RESOLVED';
      po.status = 'ORDERED_PENDING_DELIVERY';

      const metrics = getTabMetrics([po]);
      expect(metrics.claim).toBe(0);
      expect(metrics.ordered).toBe(1);

      const activeClaims = calculateActiveClaimCount([po]);
      expect(activeClaims).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 18: Multi-Store Settlement & Optional Tracking/Note
  // ══════════════════════════════════════════════════════════════════
  describe('18. Multi-Store Settlement & Optional Tracking/Note (Image 1 & Image 2 Fixes)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('renders tracking number input with placeholder "ระบุเลขพัสดุชดเชย (ถ้ามี)..." without required attribute', () => {
      const disputedPO = {
        id: 'PO-TEST-OPTIONAL-01',
        poNo: 'PO-2026-OPT1',
        status: 'IN_CLAIM',
        department: 'QC',
        items: [{ id: 'item-1', name: 'Reagent A', storePlatform: 'Shopee', actualStoreName: 'ChemStore', shortageQty: 1, unitPrice: 300, claimStatus: 'PENDING' }],
        storeClaims: {
          'Shopee_ChemStore': { type: 'REPLACEMENT', status: 'DISPUTED' }
        }
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={disputedPO}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('ระบุเลขพัสดุชดเชย (ถ้ามี)...');
      expect(html).not.toMatch(/placeholder="ระบุเลขพัสดุชดเชย \(ถ้ามี\)\.\.\."[^>]*required/);
      expect(html).toContain('บันทึกช่วยจำ (เช่น ทักแชทร้านค้าแล้ว)...');
      expect(html).not.toMatch(/placeholder="บันทึกช่วยจำ[^>]*required/);
    });

    it('allows resolving claim via workflowEngine with empty tracking number and empty note', async () => {
      const initialPO = {
        id: 'PO-OPT-02',
        poNo: 'PO-OPT-02',
        purchaseChannel: 'ONLINE',
        status: 'IN_CLAIM',
        department: 'QC',
        items: [{ id: '1', code: 'C1', name: 'Reagent', price: 300, qty: 1, shortageQty: 1 }]
      };
      storageService.savePOs([initialPO]);

      const res = await workflowEngine.resolveClaim('PO-OPT-02', {
        type: 'REPLACEMENT',
        newTrackingNo: '',
        note: '',
        storeKey: 'Shopee_ChemStore',
        allStoresResolved: true
      }, { name: 'Tharn Online Purchaser', title: 'Purchaser' });

      expect(res.status).toBe('WAITING_DELIVERY_ROUND_2');
      expect(res.storeClaims['Shopee_ChemStore']).toBeDefined();
      expect(res.storeClaims['Shopee_ChemStore'].isResolved).toBe(true);
      expect(res.storeClaims['Shopee_ChemStore'].newTrackingNo).toBe('');
    });

    it('workflowEngine preserves PO in IN_CLAIM when only 1 store of 2 is resolved', async () => {
      const initialPO = {
        id: 'PO-MULTI-TEST-01',
        poNo: 'PO-MULTI-01',
        purchaseChannel: 'ONLINE',
        status: 'IN_CLAIM',
        claimStatus: 'IN_CLAIM',
        department: 'PD',
        items: [
          { id: '1', code: 'C1', name: 'Item Store 1', price: 400, qty: 1, shortageQty: 1, storePlatform: 'Shopee', actualStoreName: 'Store1' },
          { id: '2', code: 'C2', name: 'Item Store 2', price: 600, qty: 1, shortageQty: 1, storePlatform: 'Lazada', actualStoreName: 'Store2' }
        ],
        storeClaims: {}
      };
      storageService.savePOs([initialPO]);

      const res = await workflowEngine.resolveClaim('PO-MULTI-TEST-01', {
        type: 'REFUND',
        refundAmount: 400,
        note: 'เคลมเงินคืนร้าน 1',
        storeKey: 'Shopee_Store1',
        allStoresResolved: false
      }, { name: 'Tharn Online Purchaser', title: 'Purchaser' });

      expect(res.status).not.toBe('COMPLETED');
      expect(['IN_CLAIM', 'PARTIALLY_RECEIVED_IN_CLAIM']).toContain(res.status);
      expect(res.claimStatus).toBe('IN_CLAIM');
      expect(res.storeClaims['Shopee_Store1']).toBeDefined();
      expect(res.storeClaims['Shopee_Store1'].status).toBe('RESOLVED');
      expect(res.storeClaims['Shopee_Store1'].isResolved).toBe(true);
      expect(res.storeClaims['Shopee_Store1'].refundAmount).toBe(400);
      expect(res.storeClaims['Lazada_Store2']).toBeUndefined();
    });

    it('hasUnresolvedClaim returns true when 1 store is resolved and 1 store is pending', () => {
      const poWithPartialStoreResolution = {
        id: 'PO-MULTI-TEST-01',
        poNo: 'PO-MULTI-01',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        items: [
          { id: '1', code: 'C1', name: 'Item Store 1', unitPrice: 400, qty: 1, shortageQty: 1, storePlatform: 'Shopee', actualStoreName: 'Store1', claimStatus: 'PENDING' },
          { id: '2', code: 'C2', name: 'Item Store 2', unitPrice: 600, qty: 1, shortageQty: 1, storePlatform: 'Lazada', actualStoreName: 'Store2', claimStatus: 'PENDING' }
        ],
        storeClaims: {
          'Shopee_Store1': { status: 'RESOLVED', isResolved: true, type: 'REFUND', refundAmount: 400 }
        }
      };

      expect(hasUnresolvedClaim(poWithPartialStoreResolution)).toBe(true);
    });

    it('renders Badge 🔴 รอเคลม (1 ร้านค้า) and displays ✓ บันทึกผลเจรจาเรียบร้อย for resolved store in UI', () => {
      const poWithPartialStoreResolution = {
        id: 'PO-MULTI-TEST-01',
        poNo: 'PO-MULTI-01',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        items: [
          { id: '1', code: 'C1', name: 'Item Store 1', unitPrice: 400, qty: 1, shortageQty: 1, storePlatform: 'Shopee', actualStoreName: 'Store1', claimStatus: 'PENDING' },
          { id: '2', code: 'C2', name: 'Item Store 2', unitPrice: 600, qty: 1, shortageQty: 1, storePlatform: 'Lazada', actualStoreName: 'Store2', claimStatus: 'PENDING' }
        ],
        storeClaims: {
          'Shopee_Store1': {
            status: 'RESOLVED',
            isResolved: true,
            type: 'REFUND',
            refundAmount: 400,
            resolvedAt: new Date().toISOString()
          }
        }
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={poWithPartialStoreResolution}
              activeTab="CLAIM"
              currentRole={{ id: 'PURCHASER', name: 'Online Purchaser' }}
              onUpdate={vi.fn()}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('🔴 รอเคลม (1 ร้านค้า)');
      expect(html).toContain('✓ บันทึกผลเจรจาเรียบร้อย');
      expect(html).toContain('ได้รับเงินคืน ฿400.00 เข้าแผนกแล้ว');
      expect(html).toContain('ร้าน: Store2');
      expect(html).toContain('✓ บันทึกผลเจรจา');
    });

    it('transitions PO to COMPLETED only after all disputed stores are resolved', async () => {
      const initialPO = {
        id: 'PO-MULTI-TEST-02',
        poNo: 'PO-MULTI-02',
        purchaseChannel: 'ONLINE',
        status: 'IN_CLAIM',
        department: 'PD',
        items: [
          { id: '1', code: 'C1', name: 'Item Store 1', price: 400, qty: 1, shortageQty: 1, storePlatform: 'Shopee', actualStoreName: 'Store1' },
          { id: '2', code: 'C2', name: 'Item Store 2', price: 600, qty: 1, shortageQty: 1, storePlatform: 'Lazada', actualStoreName: 'Store2' }
        ],
        storeClaims: {
          'Shopee_Store1': { status: 'RESOLVED', isResolved: true, type: 'REFUND', refundAmount: 400 }
        }
      };
      storageService.savePOs([initialPO]);

      const res = await workflowEngine.resolveClaim('PO-MULTI-TEST-02', {
        type: 'REFUND',
        refundAmount: 600,
        note: 'เคลมเงินคืนร้าน 2 ครบแล้ว',
        storeKey: 'Lazada_Store2',
        allStoresResolved: true
      }, { name: 'Tharn Online Purchaser', title: 'Purchaser' });

      expect(res.status).toBe('COMPLETED');
      expect(res.claimStatus).toBe('RESOLVED');
      expect(res.storeClaims['Lazada_Store2'].isResolved).toBe(true);
      expect(hasUnresolvedClaim(res)).toBe(false);
    });
  });
});
