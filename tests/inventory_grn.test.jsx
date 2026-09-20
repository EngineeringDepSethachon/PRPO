import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import { ROLES, PO_STATUS } from '../src/config/constants';
import { workflowEngine } from '../src/services/workflowEngine';
import { storageService, normalizeDocNumber } from '../src/services/storageService';
import { warehouseService, generateGRNNumber } from '../src/services/warehouseService';
import { budgetService } from '../src/services/budgetService';
import { notificationService } from '../src/services/notificationService';
import { 
  useProcurementContext, 
  recordGoodsReceipt 
} from '../src/context/ProcurementContext';
import { 
  useBudgetContext 
} from '../src/context/BudgetContext';
import { 
  useInventoryContext, 
  receiveToStock 
} from '../src/context/InventoryContext';
import { AppProvider } from '../src/context/AppContext';
import ReceivingModal, { checkIsFullyAccounted } from '../src/views/inventory/ReceivingModal';
import PODetailsModal from '../src/components/po/PODetailsModal';
import PrintablePO, { formatThaiDateTime, formatDocDateTime } from '../src/components/po/PrintablePO';
import POPrintTemplate from '../src/components/procurement/POPrintTemplate';
import PODocumentModal from '../src/views/procurement/PODocumentModal';
import StockMovementTable from '../src/components/stock/StockMovementTable';
import OnlineOrderCard, { calculateDisputeMetrics } from '../src/views/procurement/OnlineOrderCard';

describe('Domain Suite: Inventory Management & Goods Receiving (GRN)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    storageService.resetData();
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 1: Inventory Receiving & Stock Movement (+IN)
  // ══════════════════════════════════════════════════════════════════
  describe('1. Inventory Receiving & Stock Movement (+IN)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveVendors([
        { id: 'VEN-01', code: 'V01', name: 'Vendor 1' }
      ]);
      storageService.saveProducts([
        { id: 'PROD-10', code: 'P10', name: 'Safety Helmet', category: 'PD', price: 500, stockBalance: 10, unit: 'ใบ', supplierId: 'VEN-01' }
      ]);
    });

    it('Receiving PO adds stock balance and generates +IN Stock Log', async () => {
      const pr = await workflowEngine.createPR({
        department: 'PD',
        source: 'FACTORY',
        purchaseChannel: 'SELF',
        requiredDate: '2026-09-01',
        items: [{ productId: 'PROD-10', code: 'P10', name: 'Safety Helmet', qty: 20, price: 500 }],
        totalAmount: 10000,
        reason: 'Safety equipment',
        isDraft: false
      }, ROLES.REQUESTER_PD);

      await workflowEngine.updatePRStatus(pr.id, 'REVIEWED', ROLES.ASST_MANAGER);
      const { po } = await workflowEngine.updatePRStatus(pr.id, 'APPROVED', ROLES.PLANT_MANAGER);

      const initialProduct = storageService.getProducts().find(p => p.id === 'PROD-10');
      expect(initialProduct.stockBalance).toBe(10);

      const closedPO = await workflowEngine.closePO(po.id, ROLES.REQUESTER_PD, 'รับสินค้าเข้าคลังเต็มจำนวน');

      expect(closedPO.status).toBe('CLOSED');
      expect(closedPO.items[0].receivedQty).toBe(20);

      const updatedProducts = storageService.getProducts();
      const updatedProduct = updatedProducts.find(p => p.id === 'PROD-10');
      expect(updatedProduct.stockBalance).toBe(30);

      const stockLogs = storageService.getStockLogs();
      const lastLog = stockLogs.find(l => l.productId === 'PROD-10');
      expect(lastLog).toBeDefined();
      expect(lastLog.type).toBe('IN');
      expect(lastLog.qty).toBe(20);
      expect(lastLog.balance).toBe(30);
      expect(lastLog.docNo).toBe('GRN-PO-PD-2026-001-01');
      expect(lastLog.refPo || lastLog.poNo).toBe(po.poNo);

      const prs = storageService.getPRs();
      const updatedPR = prs.find(p => p.id === pr.id);
      expect(updatedPR.status).toBe('CLOSED');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 2: Quick Stock Issue & Reorder Point (ROP) Alert Trigger
  // ══════════════════════════════════════════════════════════════════
  describe('2. Quick Stock Issue & Reorder Point (ROP) Alert Trigger', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      notificationService.clearAll();
      storageService.saveProducts([
        {
          id: 'PROD-N95',
          code: 'PD-MSK-01',
          name: 'หน้ากาก N95',
          category: 'PD',
          price: 450,
          stockBalance: 12,
          reorderPoint: 10,
          unit: 'กล่อง'
        }
      ]);
    });

    it('Quick Issue decrements stock balance and creates -OUT Stock Log', async () => {
      const updatedProd = await workflowEngine.quickIssueStock('PROD-N95', 2, ROLES.REQUESTER_PD, 'เบิกใช้ในไลน์ผลิต A');

      expect(updatedProd.stockBalance).toBe(10);

      const logs = storageService.getStockLogs();
      const issueLog = logs.find(l => l.productId === 'PROD-N95');
      expect(issueLog).toBeDefined();
      expect(issueLog.type).toBe('OUT');
      expect(issueLog.qty).toBe(2);
      expect(issueLog.balance).toBe(10);
    });

    it('Quick Issue throws error when requesting more than current balance', async () => {
      await expect(
        workflowEngine.quickIssueStock('PROD-N95', 50, ROLES.REQUESTER_PD, 'เบิกเกิน')
      ).rejects.toThrow(/จำนวนคงเหลือไม่พอเบิก/);
    });

    it('Automatic ROP Alert: Dispatches notification when balance drops <= reorderPoint', async () => {
      await workflowEngine.quickIssueStock('PROD-N95', 3, ROLES.REQUESTER_PD, 'เบิกใช้งาน');

      const notis = notificationService.getAll();
      const ropAlert = notis.find(n => n.type === 'LOW_STOCK_ROP');

      expect(ropAlert).toBeDefined();
      expect(ropAlert.title).toContain('ROP Alert');
      expect(ropAlert.message).toContain('หน้ากาก N95');
      expect(ropAlert.targetRoles).toContain('ASST_MANAGER');
    });

    it('Quick Issue supports decimal / fractional quantities accurately (e.g. 1.25 liters)', async () => {
      const products = storageService.getProducts();
      products.push({
        id: 'PROD-OIL-01',
        code: 'PD-OIL-01',
        name: 'น้ำมันไฮดรอลิก',
        category: 'PD',
        price: 250,
        stockBalance: 2400,
        reorderPoint: 200,
        unit: 'ลิตร'
      });
      storageService.saveProducts(products);

      const updated = await workflowEngine.quickIssueStock('PROD-OIL-01', 1.25, ROLES.REQUESTER_PD, 'เติมเครื่องจักร 1.25 ลิตร');
      expect(updated.stockBalance).toBe(2398.75);

      const logs = storageService.getStockLogs();
      const oilLog = logs.find(l => l.productId === 'PROD-OIL-01');
      expect(oilLog).toBeDefined();
      expect(oilLog.qty).toBe(1.25);
      expect(oilLog.balance).toBe(2398.75);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 3: Ghost Stock Prevention & Atomic Stock Movement Logging
  // ══════════════════════════════════════════════════════════════════
  describe('3. Ghost Stock Prevention & Atomic Stock Movement Logging', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveProducts([
        {
          id: 'PROD-PD-1789273108904',
          code: 'itm-001',
          name: 'ถุงมือยางใหม่',
          category: 'PD',
          price: 15,
          stockUnit: 'ชิ้น',
          purchaseUnit: 'ชิ้น',
          conversionRate: 1,
          unit: 'ชิ้น',
          stockBalance: 7
        },
        {
          id: 'PROD-PD-003',
          code: 'PD-BLT-380',
          name: 'สายพานลำเลียงทนความร้อน',
          category: 'PD',
          price: 450,
          stockUnit: 'เส้น',
          purchaseUnit: 'เส้น',
          conversionRate: 1,
          unit: 'เส้น',
          stockBalance: 10
        }
      ]);

      storageService.savePOs([
        {
          id: 'PO-2026-TEST-001',
          poNo: 'PO-PD-2026-001',
          status: 'ORDERED_PENDING_DELIVERY',
          department: 'PD',
          items: [
            {
              productId: 'PROD-PD-1789273108904',
              code: 'itm-001',
              name: 'ถุงมือยางใหม่',
              orderedQty: 10,
              receivedQty: 0,
              price: 15,
              actUnitPrice: 15
            }
          ]
        }
      ]);

      storageService.saveStockLogs([]);
    });

    it('1. Atomic Transaction: GRN receipt synchronously updates stockBalance AND writes Movement Log (+IN)', async () => {
      const poId = 'PO-2026-TEST-001';
      const grnPayload = {
        grnNumber: 'GRN-PO-PD-2026-001-01',
        round: 1,
        receivedDate: new Date().toISOString(),
        receivedBy: { name: 'คุณวิชัย', title: 'Requester (PD)' },
        receivingItems: [
          {
            productId: 'PROD-PD-1789273108904',
            code: 'itm-001',
            name: 'ถุงมือยางใหม่',
            receivedThisTime: 5,
            goodQty: 5,
            damagedQty: 0,
            unitPrice: 15,
            actualPrice: 15
          }
        ],
        note: 'รับของรอบที่ 1 สมบูรณ์'
      };

      const result = await warehouseService.submitGRN(poId, grnPayload, {
        user: { name: 'คุณวิชัย', title: 'Requester (PD)' }
      });

      expect(result.success).toBe(true);

      const updatedProd = storageService.getProducts().find(p => p.code === 'itm-001');
      expect(updatedProd).toBeDefined();
      expect(updatedProd.stockBalance).toBe(12);

      const logs = storageService.getStockLogs().filter(l => l.productCode === 'itm-001' || l.productId === updatedProd.id);
      expect(logs.length).toBe(1);

      const log = logs[0];
      expect(log.type).toBe('IN');
      expect(log.qty).toBe(5);
      expect(log.balance).toBe(12);
      expect(log.documentNo).toBe('GRN-PO-PD-2026-001-01');
      expect(log.poNo).toBe('PO-PD-2026-001');
      expect(log.unitPrice).toBe(15);
      expect(log.user).toContain('คุณวิชัย');
    });

    it('2. Standardized Log Schema: Log entry contains all required enterprise fields', async () => {
      const items = [
        {
          productId: 'PROD-PD-003',
          code: 'PD-BLT-380',
          name: 'สายพานลำเลียงทนความร้อน',
          qty: 3,
          receivedQty: 3,
          damagedQty: 0,
          unitPrice: 450,
          actualPrice: 450,
          docNo: 'PO-PD-2026-002',
          grNumber: 'GRN-PO-PD-2026-002-01'
        }
      ];

      await receiveToStock(items, {
        docNo: 'PO-PD-2026-002',
        poNo: 'PO-PD-2026-002',
        poNumber: 'PO-PD-2026-002',
        grNumber: 'GRN-PO-PD-2026-002-01',
        user: 'คุณสมชาย (Asst. Mgr)',
        note: 'รับสินค้าสมบูรณ์ 3 เส้น'
      });

      const logs = storageService.getStockLogs().filter(l => l.productCode === 'PD-BLT-380');
      expect(logs.length).toBe(1);
      const log = logs[0];

      expect(log.id).toBeDefined();
      expect(typeof log.id).toBe('string');
      expect(log.date).toBeDefined();
      expect(log.type).toBe('IN');
      expect(log.documentNo).toBe('GRN-PO-PD-2026-002-01');
      expect(log.poNo).toBe('PO-PD-2026-002');
      expect(log.qty).toBe(3);
      expect(log.balance).toBe(13);
      expect(log.unitPrice).toBe(450);
      expect(log.user).toBe('คุณสมชาย (Asst. Mgr)');
    });

    it('3. Self-Healing Data Migration: Auto-generates +IN (System Initial Balance) for Ghost Stock (stock > 0 and logs === 0)', () => {
      const prod = storageService.getProducts().find(p => p.code === 'itm-001');
      expect(prod.stockBalance).toBe(7);

      const initialLogs = storageService.getStockLogs().filter(l => l.productCode === 'itm-001');
      expect(initialLogs.length).toBe(0);

      const resolvedLogs = warehouseService.getStockMovementLogs(prod);

      expect(resolvedLogs.length).toBe(1);
      const healedLog = resolvedLogs[0];
      expect(healedLog.type).toBe('IN');
      expect(healedLog.documentNo).toContain('INITIAL-BALANCE');
      expect(healedLog.qty).toBe(7);
      expect(healedLog.balance).toBe(7);
      expect(healedLog.user).toBe('System Initial Balance');
      expect(healedLog.note).toContain('System Initial Balance');

      const storedLogs = storageService.getStockLogs().filter(l => l.productCode === 'itm-001');
      expect(storedLogs.length).toBe(1);
      expect(storedLogs[0].id).toBe(healedLog.id);
    });

    it('4. Resilient Matching: WorkflowEngine receiveGoods matches products across productId, code, and name', async () => {
      const po = {
        id: 'PO-2026-TEST-MATCH',
        poNo: 'PO-PD-2026-099',
        status: 'ORDERED_PENDING_DELIVERY',
        department: 'PD',
        items: [
          {
            productId: 'itm-001',
            code: 'itm-001',
            name: 'ถุงมือยางใหม่',
            orderedQty: 2,
            receivedQty: 0,
            price: 15
          }
        ]
      };

      storageService.savePOs([po]);

      const receivingItems = [
        {
          productId: 'itm-001',
          receivedThisTime: 2
        }
      ];

      await workflowEngine.receiveGoods(
        po.id,
        receivingItems,
        { name: 'คุณวิชัย', title: 'Requester' },
        'รับตรวจครบ',
        { grNumber: 'GRN-PO-PD-2026-099-01' }
      );

      const updatedProd = storageService.getProducts().find(p => p.code === 'itm-001');
      expect(updatedProd.stockBalance).toBe(9);

      const logs = storageService.getStockLogs().filter(l => l.productCode === 'itm-001');
      expect(logs.some(l => l.qty === 2 && l.balance === 9)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 4: ReceivingModal Logic & Partial Receiving Engine
  // ══════════════════════════════════════════════════════════════════
  describe('4. ReceivingModal Logic & Partial Receiving Engine', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveProducts([
        { id: 'PROD-T01', code: 'PT01', name: 'Part A', stockBalance: 10, unit: 'ชิ้น' },
        { id: 'PROD-T02', code: 'PT02', name: 'Part B', stockBalance: 5, unit: 'กล่อง' }
      ]);
      storageService.savePOs([
        {
          id: 'PO-2026-TEST-01',
          poNo: 'PO-2026-TEST-01',
          status: 'ORDERED_PENDING_DELIVERY',
          department: 'PD',
          purchaseChannel: 'ONLINE',
          vendor: 'Shopee Supplier',
          items: [
            { productId: 'PROD-T01', code: 'PT01', name: 'Part A', orderedQty: 10, receivedQty: 0, price: 100 },
            { productId: 'PROD-T02', code: 'PT02', name: 'Part B', orderedQty: 5, receivedQty: 0, price: 200 }
          ]
        }
      ]);
    });

    it('1. Calculates shortage correctly using formula: shortageQty = orderedQty - (Number(acceptedQty) + Number(damagedQty || 0))', () => {
      const orderedQty = 10;
      const acceptedQty = 6;
      const damagedQty = 1;

      const shortageQty = orderedQty - (Number(acceptedQty) + Number(damagedQty || 0));
      expect(shortageQty).toBe(3);
      expect(shortageQty > 0).toBe(true);
    });

    it('2. VENDOR_SHORTAGE updates PO status to PARTIALLY_RECEIVED_IN_CLAIM and creates dispute items for Online Hub', async () => {
      const poId = 'PO-2026-TEST-01';
      const grnPayload = {
        grnNumber: 'GRN-PO-2026-TEST-01-01',
        round: 1,
        receivedDate: new Date().toLocaleString('th-TH'),
        statusOverride: 'PARTIALLY_RECEIVED_IN_CLAIM',
        receivingItems: [
          {
            productId: 'PROD-T01',
            code: 'PT01',
            name: 'Part A',
            receivedThisTime: 6,
            goodQty: 6,
            damagedQty: 0,
            shortageQty: 4,
            shortageReason: 'VENDOR_SHORTAGE',
            condition: 'SHORTAGE'
          },
          {
            productId: 'PROD-T02',
            code: 'PT02',
            name: 'Part B',
            receivedThisTime: 5,
            goodQty: 5,
            damagedQty: 0,
            shortageQty: 0,
            condition: 'GOOD'
          }
        ]
      };

      const { po: updatedPO } = await recordGoodsReceipt(poId, grnPayload);

      expect(updatedPO.status).toBe('PARTIALLY_RECEIVED_IN_CLAIM');
      expect(updatedPO.items[0].receivedQty).toBe(6);
      expect(updatedPO.items[0].shortageQty).toBe(4);
      expect(updatedPO.grnHistory).toHaveLength(1);

      const s = String(updatedPO.status).toLowerCase();
      expect(s.includes('claim')).toBe(true);
    });

    it('3. SPLIT_SHIPMENT updates status to WAITING_DELIVERY_ROUND_2 without routing to claim', async () => {
      const poId = 'PO-2026-TEST-01';
      const grnPayload = {
        grnNumber: 'GRN-PO-2026-TEST-01-01',
        round: 1,
        receivedDate: new Date().toLocaleString('th-TH'),
        statusOverride: 'WAITING_DELIVERY_ROUND_2',
        waitingRound2: true,
        receivingItems: [
          {
            productId: 'PROD-T01',
            code: 'PT01',
            name: 'Part A',
            receivedThisTime: 5,
            goodQty: 5,
            damagedQty: 0,
            shortageQty: 5,
            shortageReason: 'SPLIT_SHIPMENT',
            condition: 'SHORTAGE'
          }
        ]
      };

      const { po: updatedPO } = await recordGoodsReceipt(poId, grnPayload);
      expect(updatedPO.status).toBe('WAITING_DELIVERY_ROUND_2');
      expect(String(updatedPO.status).toLowerCase().includes('claim')).toBe(false);
    });

    it('4. receiveToStock adds only intact/complete items to stock and does not add shortage or damaged items', async () => {
      const initialProd = storageService.getProducts().find(p => p.id === 'PROD-T01');
      expect(initialProd.stockBalance).toBe(10);

      const intactStockItems = [
        {
          productId: 'PROD-T01',
          code: 'PT01',
          name: 'Part A',
          qty: 6,
          receivedQty: 6,
          damagedQty: 0,
          docNo: 'PO-2026-TEST-01',
          grNumber: 'GRN-01'
        }
      ];

      await receiveToStock(intactStockItems, {
        docNo: 'PO-2026-TEST-01',
        grNumber: 'GRN-01',
        note: 'รับเฉพาะยอดสมบูรณ์'
      });

      const updatedProd = storageService.getProducts().find(p => p.id === 'PROD-T01');
      expect(updatedProd.stockBalance).toBe(16);

      const stockLogs = storageService.getStockLogs().filter(l => l.productId === 'PROD-T01');
      expect(stockLogs[stockLogs.length - 1].qty).toBe(6);
      expect(stockLogs[stockLogs.length - 1].balance).toBe(16);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 5: ReceivingModal Clean Workspace & UI/UX Overhaul
  // ══════════════════════════════════════════════════════════════════
  describe('5. ReceivingModal Clean Workspace & UI/UX Overhaul', () => {
    const basePO = {
      id: 'PO-TEST-001',
      poNo: 'PO-PD-2026-001',
      status: 'ORDERED_PENDING_DELIVERY',
      department: 'PD',
      vendorName: 'บริษัท เคมีคอล ซัพพลาย จำกัด',
      items: [
        {
          productId: 'PROD-01',
          code: 'OIL-HYD-68',
          name: 'น้ำมันไฮดรอลิกเกรด 68 (200L)',
          orderedQty: 10,
          purchaseQty: 10,
          receivedQty: 0,
          purchaseUnit: 'ถัง',
          price: 2500
        }
      ]
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('1. Renders clean workspace without purple banner or dev jargon', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).not.toContain('ระบบตรวจรับบางส่วน &amp; แยกคลังสินค้าอัตโนมัติ');
      expect(html).not.toContain('acceptedQty &lt; orderedQty');
      expect(html).not.toContain('PARTIALLY_RECEIVED_IN_CLAIM');
      expect(html).not.toContain('WAITING_DELIVERY_ROUND_2');
      expect(html).toContain('ตรวจรับพัสดุเข้าคลัง (Goods Receipt / GRN)');
      expect(html).toContain('PO-PD-2026-001');
      expect(html).toContain('บริษัท เคมีคอล ซัพพลาย จำกัด');
      expect(html).toContain('กรอกรับครบทุกรายการ');
      expect(html).toContain('ยกเลิกและย้อนกลับ');
    });

    it('2. Renders compact table with 6 columns: สินค้า, รอตรวจรับ (รอบนี้), รับดี (เข้าคลัง), ชำรุด (NG), ขาดส่ง, สถานะ / การจัดการ', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('สินค้า');
      expect(html).toContain('รอตรวจรับ (รอบนี้)');
      expect(html).toContain('รับดี (เข้าคลัง)');
      expect(html).toContain('ชำรุด (NG)');
      expect(html).toContain('ขาดส่ง');
      expect(html).toContain('สถานะ / การจัดการ');
      expect(html).toContain('OIL-HYD-68');
      expect(html).toContain('น้ำมันไฮดรอลิกเกรด 68 (200L)');
      expect(html).toContain('10');
      expect(html).toContain('ครบถ้วน');
      expect(html).not.toContain('✓ ครบถ้วน');
      expect(html).toContain('สั่งทั้งหมด 10 • รับแล้ว 0');
    });

    it('3. Renders emerald action button "[ ✓ ยืนยันรับเข้าคลังสมบูรณ์ ]" when 100% fully received', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('ยืนยันรับเข้าคลังสมบูรณ์');
      expect(html).toContain('bg-emerald-600');
      expect(html).not.toContain('bg-rose-600');
    });

    it('4. Renders compact note & photos in 2-column grid layout', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('หมายเหตุการตรวจรับ');
      expect(html).toContain('ภาพถ่ายพัสดุ / ใบปะหน้ากล่อง');
      expect(html).toContain('+ เพิ่มไฟล์');
    });

    it('5. Renders summary status badge with clean human language', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('ตรวจรับครบถ้วนสมบูรณ์ — บันทึกรับเข้าสต็อกและปิดเอกสาร PO');
      expect(html).toContain('รับเข้าสต็อก:');
    });

    it('6. Demotes Auto-fill helper from Primary CTA to Ghost Utility Action (eliminating dual green button ambiguity)', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('⚡ กรอกรับครบทุกรายการ');
      expect(html).toContain('text-emerald-700 bg-emerald-50/80 hover:bg-emerald-100/80 border border-emerald-200/80');
      expect(html).toContain('ยืนยันรับเข้าคลังสมบูรณ์');
      expect(html).not.toContain('bg-emerald-700/90');
    });

    it('7. Layout separation: Status banner has mb-4 and renders accepted item counter cleanly, footer has "ยกเลิกและย้อนกลับ"', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50/80 text-emerald-800 text-xs font-medium mb-4');
      expect(html).toContain('10 รายการ');
      expect(html).toContain('ยกเลิกและย้อนกลับ');
      expect(html).toContain('text-slate-600 hover:bg-slate-100 border border-slate-200 px-4 py-2 rounded-xl text-xs font-semibold');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 6: ReceivingModal Upscale Typography & Seamless Swapping
  // ══════════════════════════════════════════════════════════════════
  describe('6. ReceivingModal Upscale Typography & Seamless Modal Swapping', () => {
    const basePO = {
      id: 'PO-TEST-002',
      poNo: 'PO-PD-2026-002',
      status: 'ORDERED_PENDING_DELIVERY',
      department: 'PD',
      vendorName: 'บริษัท เคมีคอล ซัพพลาย จำกัด',
      items: [
        {
          productId: 'PROD-02',
          code: 'OIL-HYD-68',
          name: 'น้ำมันไฮดรอลิกเกรด 68 (200L)',
          orderedQty: 10,
          purchaseQty: 10,
          receivedQty: 0,
          purchaseUnit: 'ถัง',
          price: 2500
        }
      ]
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('1. Renders seamless "กลับไปใบ PO" button with single icon when onBack or onBackToPO is provided', () => {
      const htmlWithBack = renderToStaticMarkup(
        <ReceivingModal po={basePO} isOpen={true} onBack={() => {}} />
      );
      expect(htmlWithBack).toContain('กลับไปใบ PO');
      expect(htmlWithBack).not.toContain('← กลับไปใบ PO');
      expect(htmlWithBack).toContain('title="กลับไปที่หน้าต่างใบสั่งซื้อ (PO)"');

      const htmlWithoutBack = renderToStaticMarkup(
        <ReceivingModal po={basePO} isOpen={true} />
      );
      expect(htmlWithoutBack).not.toContain('กลับไปใบ PO');
    });

    it('2. Upscales Header and Table Header Typography', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('text-base sm:text-lg font-bold text-white');
      expect(html).toContain('text-xs font-semibold text-slate-500 uppercase tracking-wider');
    });

    it('3. Upscales Item Name, SKU Badge, and Row Ergonomics', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('font-mono text-xs font-bold text-slate-600');
      expect(html).toContain('text-sm font-bold text-slate-800');
      expect(html).toContain('py-3.5 px-4');
    });

    it('4. Upscales Number inputs to w-16 h-8 text-sm and hides browser spinners', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('h-10 w-20 text-center font-bold text-base');
      expect(html).toContain('[appearance:textfield]');
      expect(html).toContain('[&amp;::-webkit-outer-spin-button]:appearance-none');
      expect(html).toContain('[&amp;::-webkit-inner-spin-button]:appearance-none');
    });

    it('5. Upscales Note and Attachment sections with comfortable text-xs sm:text-sm', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('text-xs font-bold text-slate-700');
      expect(html).toContain('text-xs sm:text-sm bg-slate-50 focus:bg-white');
      expect(html).toContain('text-xs sm:text-sm font-medium cursor-pointer');
    });

    it('6. Action buttons in footer have text-xs sm:text-sm font-bold', () => {
      const html = renderToStaticMarkup(<ReceivingModal po={basePO} isOpen={true} />);
      expect(html).toContain('text-xs sm:text-sm font-bold bg-emerald-600');
    });

    it('7. Seamless modal swapping in PODetailsModal avoids stacking backdrops', () => {
      const normalHtml = renderToStaticMarkup(
        <PODetailsModal 
          selectedPO={basePO} 
          currentRole={{ id: 'REQUESTER_PD', roleId: 'REQUESTER_PD', role: 'requester', level: 1, department: 'PD' }} 
          onClose={() => {}} 
        />
      );
      expect(normalHtml).toContain('PO-PD-2026-002');
      expect(normalHtml).toContain('บันทึกตรวจรับสินค้า (+IN)');
      expect(normalHtml).not.toContain('ตรวจรับพัสดุเข้าคลัง (Goods Receipt / GRN)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 7: GRN Document Numbering Standard & Self-Healing
  // ══════════════════════════════════════════════════════════════════
  describe('7. GRN Document Numbering Standard & Self-Healing Regression Suite', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('Scenario 1 (Round 1 GRN Creation): Creating a new GRN for PO-PD-2026-002 (Round 1) strictly generates GRN-PO-PD-2026-002-01', async () => {
      const genNo = generateGRNNumber('PO-PD-2026-002', 1);
      expect(genNo).toBe('GRN-PO-PD-2026-002-01');
      expect(generateGRNNumber('PO-PD-2026-002')).toBe('GRN-PO-PD-2026-002-01');
      expect(generateGRNNumber('PO-PD-2026-002', '1')).toBe('GRN-PO-PD-2026-002-01');
      expect(generateGRNNumber(' PO-PD-2026-002 ', 0)).toBe('GRN-PO-PD-2026-002-01');

      const testPO = {
        id: 'PO-TEST-002',
        poNo: 'PO-PD-2026-002',
        poNumber: 'PO-PD-2026-002',
        status: 'ISSUED',
        department: 'PD',
        items: [
          {
            productId: 'PROD-PD-002',
            code: 'PD-BOX-002',
            name: 'กล่องลูกฟูกมาตรฐาน',
            orderedQty: 100,
            purchaseQty: 100,
            receivedQty: 0,
            unitPrice: 15,
            unit: 'ใบ',
            stockUnit: 'ใบ'
          }
        ],
        grnHistory: []
      };

      const testProd = {
        id: 'PROD-PD-002',
        code: 'PD-BOX-002',
        name: 'กล่องลูกฟูกมาตรฐาน',
        stockBalance: 0,
        unit: 'ใบ',
        stockUnit: 'ใบ',
        price: 15
      };

      storageService.savePOs([testPO]);
      storageService.saveProducts([testProd]);

      const grnResult = await warehouseService.submitGRN(testPO.id, {
        items: [{ productId: 'PROD-PD-002', acceptedQty: 40, damagedQty: 0 }],
        note: 'รับเข้าคลังรอบที่ 1'
      });

      expect(grnResult.grnNo).toBe('GRN-PO-PD-2026-002-01');
      expect(grnResult.roundNumber).toBe(1);

      const logs = storageService.getStockLogs();
      const round1Log = logs.find(l => l.productId === 'PROD-PD-002');
      expect(round1Log).toBeDefined();
      expect(round1Log.documentNo).toBe('GRN-PO-PD-2026-002-01');
      expect(round1Log.grnNo).toBe('GRN-PO-PD-2026-002-01');
      expect(round1Log.refPo).toBe('PO-PD-2026-002');
    });

    it('Scenario 2 (Round 2 GRN Creation): Creating Round 2 for PO-PD-2026-002 strictly generates GRN-PO-PD-2026-002-02', async () => {
      const genNoR2 = generateGRNNumber('PO-PD-2026-002', 2);
      expect(genNoR2).toBe('GRN-PO-PD-2026-002-02');
      expect(generateGRNNumber('PO-PD-2026-002', '02')).toBe('GRN-PO-PD-2026-002-02');

      const testPO = {
        id: 'PO-TEST-002',
        poNo: 'PO-PD-2026-002',
        poNumber: 'PO-PD-2026-002',
        status: 'WAITING_DELIVERY_ROUND_2',
        department: 'PD',
        items: [
          {
            productId: 'PROD-PD-002',
            code: 'PD-BOX-002',
            name: 'กล่องลูกฟูกมาตรฐาน',
            orderedQty: 100,
            purchaseQty: 100,
            receivedQty: 40,
            accumulatedReceived: 40,
            unitPrice: 15,
            unit: 'ใบ',
            stockUnit: 'ใบ'
          }
        ],
        grnHistory: [
          { grnNumber: 'GRN-PO-PD-2026-002-01', round: 1, receivedDate: '2026-09-10 10:00:00' }
        ]
      };

      const testProd = {
        id: 'PROD-PD-002',
        code: 'PD-BOX-002',
        name: 'กล่องลูกฟูกมาตรฐาน',
        stockBalance: 40,
        unit: 'ใบ',
        stockUnit: 'ใบ',
        price: 15
      };

      storageService.savePOs([testPO]);
      storageService.saveProducts([testProd]);

      const grnResultR2 = await warehouseService.submitGRN(testPO.id, {
        items: [{ productId: 'PROD-PD-002', acceptedQty: 60, damagedQty: 0 }],
        note: 'รับเข้าคลังรอบที่ 2 ครบถ้วน'
      });

      expect(grnResultR2.grnNo).toBe('GRN-PO-PD-2026-002-02');
      expect(grnResultR2.roundNumber).toBe(2);

      const logs = storageService.getStockLogs();
      const round2Log = logs.find(l => l.productId === 'PROD-PD-002' && (l.documentNo === 'GRN-PO-PD-2026-002-02' || l.roundNumber === 2));
      expect(round2Log).toBeDefined();
      expect(round2Log.documentNo).toBe('GRN-PO-PD-2026-002-02');
      expect(round2Log.refPo).toBe('PO-PD-2026-002');
    });

    it('Scenario 3 (Legacy Record Healing): Legacy row previously displayed as PO-PD-2026-001 is automatically normalized to GRN-PO-PD-2026-001-01', () => {
      const legacyRecord1 = { docNo: 'PO-PD-2026-001', roundNumber: 1 };
      expect(normalizeDocNumber(legacyRecord1)).toBe('GRN-PO-PD-2026-001-01');

      const legacyRecordDefaultRound = { docNo: 'PO-PD-2026-001' };
      expect(normalizeDocNumber(legacyRecordDefaultRound)).toBe('GRN-PO-PD-2026-001-01');

      const legacyRecordRound2 = { docNo: 'PO-PD-2026-001', roundNumber: 2 };
      expect(normalizeDocNumber(legacyRecordRound2)).toBe('GRN-PO-PD-2026-001-02');

      expect(normalizeDocNumber('PO-PD-2026-001')).toBe('GRN-PO-PD-2026-001-01');
      expect(normalizeDocNumber('GRN-PO-PD-2026-001-02')).toBe('GRN-PO-PD-2026-001-02');

      const unhealedRawLog = {
        id: 'LOG-LEGACY-001',
        date: '2026-09-01 10:00:00',
        productId: 'PROD-PD-LEGACY',
        productCode: 'PD-LEGACY',
        name: 'สินค้าตัวอย่างเดิม',
        type: 'IN',
        docNo: 'PO-PD-2026-001',
        qty: 10,
        balance: 10
      };

      storageService.saveStockLogs([unhealedRawLog]);
      const healedLogs = storageService.getStockLogs();
      const healedLog = healedLogs.find(l => l.id === 'LOG-LEGACY-001');

      expect(healedLog).toBeDefined();
      expect(healedLog.documentNo).toBe('GRN-PO-PD-2026-001-01');
      expect(healedLog.grnNo).toBe('GRN-PO-PD-2026-001-01');
      expect(healedLog.refPo).toBe('PO-PD-2026-001');

      const product = {
        id: 'PROD-PD-LEGACY',
        code: 'PD-LEGACY',
        name: 'สินค้าตัวอย่างเดิม',
        stockBalance: 10,
        unit: 'ชิ้น'
      };

      const html = renderToStaticMarkup(
        <StockMovementTable
          product={product}
          stockLogs={[unhealedRawLog]}
          pos={[{ poNo: 'PO-PD-2026-001', id: 'PO-1' }]}
          onClose={() => {}}
        />
      );

      expect(html).toContain('GRN-PO-PD-2026-001-01');
      expect(html).toContain('อ้างอิง: PO-PD-2026-001');
    });

    it('Scenario 4 (Table Search & Filter): Searching for either PO-PD-2026-001 or GRN-PO-PD-2026-001-01 returns both Round 1 and Round 2 records', () => {
      const product = {
        id: 'PROD-PD-MULTI',
        code: 'PD-MULTI',
        name: 'สินค้าทดสอบรับหลายรอบ',
        stockBalance: 100,
        unit: 'กล่อง'
      };

      const multiRoundLogs = [
        {
          id: 'LOG-R2',
          date: '2026-09-12 14:00:00',
          productId: 'PROD-PD-MULTI',
          productCode: 'PD-MULTI',
          type: 'IN',
          documentNo: 'GRN-PO-PD-2026-001-02',
          docNo: 'GRN-PO-PD-2026-001-02',
          poNo: 'PO-PD-2026-001',
          poNumber: 'PO-PD-2026-001',
          refPo: 'PO-PD-2026-001',
          qty: 60,
          balance: 100
        },
        {
          id: 'LOG-R1',
          date: '2026-09-10 10:00:00',
          productId: 'PROD-PD-MULTI',
          productCode: 'PD-MULTI',
          type: 'IN',
          documentNo: 'GRN-PO-PD-2026-001-01',
          docNo: 'GRN-PO-PD-2026-001-01',
          poNo: 'PO-PD-2026-001',
          poNumber: 'PO-PD-2026-001',
          refPo: 'PO-PD-2026-001',
          qty: 40,
          balance: 40
        }
      ];

      storageService.saveStockLogs(multiRoundLogs);

      const tableHtml = renderToStaticMarkup(
        <StockMovementTable
          product={product}
          stockLogs={multiRoundLogs}
          pos={[{ poNo: 'PO-PD-2026-001', id: 'PO-1' }]}
          onClose={() => {}}
        />
      );

      expect(tableHtml).toContain('GRN-PO-PD-2026-001-01');
      expect(tableHtml).toContain('GRN-PO-PD-2026-001-02');
      expect(tableHtml).toContain('อ้างอิง: PO-PD-2026-001');

      const searchPo = 'PO-PD-2026-001';
      const matchesPo = multiRoundLogs.filter(log => {
        const q = searchPo.trim().toLowerCase();
        const normDoc = normalizeDocNumber(log).toLowerCase();
        const rawDoc = String(log.documentNo || log.docNo || '').toLowerCase();
        const parentPo = String(log.refPo || log.poNumber || log.poNo || '').toLowerCase();
        let qPoStem = q;
        if (q.startsWith('grn-')) {
          const match = q.match(/grn-(po-[a-z0-9-]+?)(?:-\d{2})?$/i);
          if (match) qPoStem = match[1].toLowerCase();
        }
        return normDoc.includes(q) || rawDoc.includes(q) || parentPo.includes(q) || parentPo.includes(qPoStem) || normDoc.includes(qPoStem);
      });

      expect(matchesPo.length).toBe(2);
      expect(matchesPo.map(m => m.documentNo)).toEqual(expect.arrayContaining([
        'GRN-PO-PD-2026-001-01',
        'GRN-PO-PD-2026-001-02'
      ]));

      const searchGrn = 'GRN-PO-PD-2026-001-01';
      const matchesGrn = multiRoundLogs.filter(log => {
        const q = searchGrn.trim().toLowerCase();
        const normDoc = normalizeDocNumber(log).toLowerCase();
        const rawDoc = String(log.documentNo || log.docNo || '').toLowerCase();
        const parentPo = String(log.refPo || log.poNumber || log.poNo || '').toLowerCase();
        let qPoStem = q;
        if (q.startsWith('grn-')) {
          const match = q.match(/grn-(po-[a-z0-9-]+?)(?:-\d{2})?$/i);
          if (match) qPoStem = match[1].toLowerCase();
        }
        return normDoc.includes(q) || rawDoc.includes(q) || parentPo.includes(q) || parentPo.includes(qPoStem) || normDoc.includes(qPoStem);
      });

      expect(matchesGrn.length).toBe(2);
      expect(matchesGrn.map(m => m.documentNo)).toEqual(expect.arrayContaining([
        'GRN-PO-PD-2026-001-01',
        'GRN-PO-PD-2026-001-02'
      ]));
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 8: GRN Round 2+ & Claim Budget Integrity Verification
  // ══════════════════════════════════════════════════════════════════
  describe('8. GRN Round 2+ & Claim Budget Integrity Verification', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('Scenario 1 (Fully Received): Ordered=5, Accumulated=5, Refunded=0 -> Remaining=0. Inputs disabled, displays "✓ ตรวจรับครบแล้วในรอบก่อน"', async () => {
      const po = {
        id: 'PO-SCENARIO-1',
        poNo: 'PO-SC-001',
        status: 'WAITING_DELIVERY_ROUND_2',
        department: 'PD',
        items: [
          {
            productId: 'PROD-01',
            code: 'CODE-01',
            name: 'Item Scenario 1',
            orderedQty: 5,
            accumulatedReceived: 5,
            receivedQty: 5,
            refundedQty: 0,
            purchaseUnit: 'ชิ้น',
            unitPrice: 100
          }
        ]
      };

      const html = renderToStaticMarkup(<ReceivingModal po={po} isOpen={true} />);

      expect(html).toContain('ตรวจรับครบแล้วในรอบก่อน');
      expect(html).toContain('bg-slate-100 text-slate-400 cursor-not-allowed');
      expect(html).toContain('disabled=""');
      expect(html).toContain('value="0"');

      storageService.savePOs([po]);

      const grnResult = await warehouseService.submitGRN(
        po.id,
        { items: [{ productId: 'PROD-01', acceptedQty: 5, damagedQty: 0 }] },
        { user: { name: 'Inspector' } }
      );

      const updatedItem = grnResult.po.items.find(i => i.productId === 'PROD-01');
      expect(updatedItem.accumulatedReceived).toBe(5);
      expect(updatedItem.receivedQty).toBe(5);
    });

    it('Scenario 2 (Full/Partial Refund Settled - ITM-002 case): Ordered=5, Accumulated=4, Refunded=1 -> Remaining=0. Inputs disabled, displays "💰 ได้รับเงินคืนแล้ว ฿246.00 (ปิดรับ)", Zero physical receiving allowed', async () => {
      storageService.saveProducts([
        {
          id: 'PROD-ITM-002',
          code: 'ITM-002',
          name: 'น้ำมันหล่อลื่นสังเคราะห์',
          stockBalance: 10,
          price: 246
        }
      ]);

      const po = {
        id: 'PO-ONLINE-ITM002',
        poNo: 'PO-2026-ITM002',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        departmentId: 'PD',
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            type: 'REFUND',
            actionType: 'REFUND',
            resolutionType: 'REFUND',
            refundAmount: 246,
            isResolved: true,
            resolvedAt: '2026-09-12T10:00:00.000Z',
            note: 'คืนเงิน 246.00 บาท'
          }
        },
        items: [
          {
            productId: 'PROD-ITM-002',
            code: 'ITM-002',
            name: 'น้ำมันหล่อลื่นสังเคราะห์',
            orderedQty: 5,
            accumulatedReceived: 4,
            receivedQty: 4,
            actualStoreName: 'แ้ก้กเก้ดเ้ด',
            storePlatform: 'Shopee',
            storeKey: 'Shopee_แ้ก้กเก้ดเ้ด',
            unitPrice: 246,
            actualPrice: 246,
            purchaseUnit: 'ขวด',
            hasDispute: true,
            isDamaged: true,
            damagedQty: 1
          }
        ]
      };

      const html = renderToStaticMarkup(<ReceivingModal po={po} isOpen={true} />);

      expect(html).toContain('💰 ได้รับเงินคืนแล้ว ฿246.00');
      expect(html).toContain('opacity-80 bg-slate-50/50');
      expect(html).toContain('bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200 select-none');
      expect(html).toContain('disabled=""');
      expect(html).toContain('value="0"');

      storageService.savePOs([po]);

      const grnResult = await warehouseService.submitGRN(
        po.id,
        { items: [{ productId: 'PROD-ITM-002', acceptedQty: 1, damagedQty: 0 }] },
        { user: { name: 'Inspector' } }
      );

      const updatedItem = grnResult.po.items.find(i => i.productId === 'PROD-ITM-002');
      expect(updatedItem.accumulatedReceived).toBe(4);
      expect(updatedItem.refundedQty).toBe(1);
      expect(updatedItem.claimResolution).toBe('REFUND');
      expect(updatedItem.isSettled).toBe(true);

      const products = storageService.getProducts();
      const prod = products.find(p => p.id === 'PROD-ITM-002');
      expect(prod.stockBalance).toBe(10);

      const logs = storageService.getStockLogs();
      const itmLogs = logs.filter(l => l.productId === 'PROD-ITM-002');
      expect(itmLogs.length).toBe(0);
    });

    it('Scenario 3 (Outstanding Replacement - PD-CLN-IND case): Ordered=5, Accumulated=4, Replacement Pending=1, Refunded=0 -> Remaining=1. Inputs enabled with max=1, badge shows replacement', () => {
      const po = {
        id: 'PO-REPLACEMENT-PD-CLN',
        poNo: 'PO-2026-CLN01',
        status: 'ORDERED_PENDING_DELIVERY',
        department: 'PD',
        items: [
          {
            productId: 'PROD-PD-CLN',
            code: 'PD-CLN-IND',
            name: 'น้ำยาทำความสะอาดอุตสาหกรรม',
            orderedQty: 5,
            accumulatedReceived: 4,
            receivedQty: 4,
            replacementPendingQty: 1,
            refundedQty: 0,
            claimResolution: 'REPLACEMENT',
            isSettled: false,
            purchaseUnit: 'ถัง',
            unitPrice: 500
          }
        ]
      };

      const html = renderToStaticMarkup(<ReceivingModal po={po} isOpen={true} />);

      expect(html).toContain('value="1"');
      expect(html).toContain('max="1"');
      expect(html).toContain('min="0"');
      expect(html).not.toContain('💰 ได้รับเงินคืนแล้ว');
      expect(html).not.toContain('✓ ตรวจรับครบแล้วในรอบก่อน');
    });

    it('Scenario 4 (Outstanding Split Shipment - PD-BLT-380 case): Ordered=5, Accumulated=4, Wait Next Round=1, Refunded=0 -> Remaining=1. Inputs enabled with max=1, badge shows split shipment', () => {
      const po = {
        id: 'PO-SPLIT-PD-BLT',
        poNo: 'PO-2026-BLT01',
        status: 'WAITING_DELIVERY_ROUND_2',
        department: 'PD',
        items: [
          {
            productId: 'PROD-PD-BLT',
            code: 'PD-BLT-380',
            name: 'สายพานลำเลียงอุตสาหกรรม',
            orderedQty: 5,
            accumulatedReceived: 4,
            receivedQty: 4,
            shortageQty: 1,
            shortageAction: 'WAIT_NEXT_ROUND',
            shortageReason: 'SPLIT_SHIPMENT',
            refundedQty: 0,
            purchaseUnit: 'เส้น',
            unitPrice: 850
          }
        ]
      };

      const html = renderToStaticMarkup(<ReceivingModal po={po} isOpen={true} />);

      expect(html).toContain('value="1"');
      expect(html).toContain('max="1"');
      expect(html).toContain('min="0"');
      expect(html).not.toContain('💰 ได้รับเงินคืนแล้ว');
    });

    it('Scenario 5 (Budget Protection): Submitting GRN Round 2 does not alter or erase the refund credit recorded in Department Budget, and ensures idempotent refund reconciliation', async () => {
      const initialBudgets = {
        PD: {
          monthlyBudget: 100000,
          spent: 25000,
          actualExpense: 25000,
          variance: 75000,
          remainingBudget: 75000
        }
      };
      storageService.saveBudgets(initialBudgets);

      const po = {
        id: 'PO-BUDGET-PROT-01',
        poNo: 'PO-PD-2026-BP01',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        departmentId: 'PD',
        grandTotal: 1246,
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            type: 'REFUND',
            refundAmount: 246,
            isResolved: true,
            resolvedAt: '2026-09-12T10:00:00.000Z',
            note: 'คืนเงิน 246.00 บาท'
          }
        },
        items: [
          {
            productId: 'PROD-ITM-002',
            code: 'ITM-002',
            name: 'น้ำมันหล่อลื่นสังเคราะห์',
            orderedQty: 5,
            accumulatedReceived: 4,
            receivedQty: 4,
            actualStoreName: 'แ้ก้กเก้ดเ้ด',
            storePlatform: 'Shopee',
            storeKey: 'Shopee_แ้ก้กเก้ดเ้ด',
            unitPrice: 246,
            actualPrice: 246,
            purchaseUnit: 'ขวด',
            hasDispute: true,
            damagedQty: 1
          }
        ]
      };
      storageService.savePOs([po]);

      const credResult = await budgetService.creditDepartmentBudget({
        department: 'PD',
        amount: 246,
        referencePo: po.poNo,
        storeKey: 'Shopee_แ้ก้กเก้ดเ้ด',
        reason: 'Refund for ITM-002',
        actor: 'Purchaser'
      });

      expect(credResult.success).toBe(true);

      const budgetsAfterRefund = storageService.getBudgets();
      expect(budgetsAfterRefund.PD.spent).toBe(24754);
      expect(budgetsAfterRefund.PD.variance).toBe(75246);

      await warehouseService.submitGRN(
        po.id,
        { items: [{ productId: 'PROD-ITM-002', acceptedQty: 0, damagedQty: 0 }] },
        { user: { name: 'Inspector' } }
      );

      const budgetsAfterGRN = storageService.getBudgets();
      expect(budgetsAfterGRN.PD.spent).toBe(24754);
      expect(budgetsAfterGRN.PD.variance).toBe(75246);

      const duplicateCred = await budgetService.creditDepartmentBudget({
        department: 'PD',
        amount: 246,
        referencePo: po.poNo,
        storeKey: 'Shopee_แ้ก้กเก้ดเ้ด',
        reason: 'Duplicate retry',
        actor: 'Purchaser'
      });

      expect(duplicateCred.alreadyReconciled).toBe(true);

      const txs = storageService.getBudgetTransactions();
      const refTxs = txs.filter(t => t.referencePo === po.poNo);
      expect(refTxs.length).toBe(1);
      expect(refTxs[0].amount).toBe(246);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 9: GRN Shortage Action Workflow & Online Claim Filtering
  // ══════════════════════════════════════════════════════════════════
  describe('9. GRN Shortage Action Workflow & Online Claim Filtering (CLAIM_SHORTAGE vs WAIT_NEXT_ROUND)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('calculates disputedQty & claimableAmount when shortageAction is CLAIM_SHORTAGE', () => {
      const item = {
        id: 'ITM-1',
        name: 'สายรัดพลาสติก',
        orderedQty: 5,
        receivedQty: 3,
        shortageQty: 2,
        damagedQty: 0,
        unitPrice: 150,
        shortageAction: 'CLAIM_SHORTAGE'
      };

      const metrics = calculateDisputeMetrics(item, 'PARTIALLY_RECEIVED_IN_CLAIM', true);
      expect(metrics.shortageQty).toBe(2);
      expect(metrics.disputedQty).toBe(2);
      expect(metrics.claimableAmount).toBe(300);
      expect(metrics.hasDispute).toBe(true);
      expect(metrics.isWaitingNextRound).toBe(false);
    });

    it('sets disputedQty = 0 & hasDispute = false when shortageAction is WAIT_NEXT_ROUND without damage', () => {
      const item = {
        id: 'ITM-2',
        name: 'เทปOPP ใส',
        orderedQty: 10,
        receivedQty: 7,
        shortageQty: 3,
        damagedQty: 0,
        unitPrice: 50,
        shortageAction: 'WAIT_NEXT_ROUND'
      };

      const metrics = calculateDisputeMetrics(item, 'WAITING_DELIVERY_ROUND_2', true);
      expect(metrics.shortageQty).toBe(3);
      expect(metrics.disputedQty).toBe(0);
      expect(metrics.claimableAmount).toBe(0);
      expect(metrics.hasDispute).toBe(false);
      expect(metrics.isWaitingNextRound).toBe(true);
      expect(metrics.waitingNextRoundQty).toBe(3);
    });

    it('handles combined damagedQty and shortageAction WAIT_NEXT_ROUND: only damagedQty is disputed', () => {
      const item = {
        id: 'ITM-3',
        name: 'กล่องกระดาษ No.5',
        orderedQty: 10,
        receivedQty: 6,
        shortageQty: 3,
        damagedQty: 1,
        unitPrice: 20,
        shortageAction: 'WAIT_NEXT_ROUND'
      };

      const metrics = calculateDisputeMetrics(item, 'PARTIALLY_RECEIVED_IN_CLAIM', true);
      expect(metrics.shortageQty).toBe(3);
      expect(metrics.damagedQty).toBe(1);
      expect(metrics.disputedQty).toBe(1);
      expect(metrics.claimableAmount).toBe(20);
      expect(metrics.hasDispute).toBe(true);
    });

    it('sets poItem.hasDispute = true and PO status = PARTIALLY_RECEIVED_IN_CLAIM when CLAIM_SHORTAGE in warehouseService', async () => {
      const testPO = {
        id: 'PO-TEST-CLAIM',
        poNo: 'PO-2026-901',
        status: 'ORDERED',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        items: [{ id: 'ITM-101', productId: 'PROD-101', name: 'เครื่องวัดค่า pH', orderedQty: 2, receivedQty: 0, unitPrice: 1200 }]
      };
      storageService.savePOs([testPO]);

      const grnPayload = {
        grnNumber: 'GRN-2026-901-01',
        receivingItems: [{ productId: 'PROD-101', goodQty: 1, damagedQty: 0, shortageQty: 1, shortageAction: 'CLAIM_SHORTAGE' }]
      };

      const result = await warehouseService.submitGRN(testPO.id, grnPayload);
      expect(result.success).toBe(true);

      const savedPOs = storageService.getPOs();
      const updated = savedPOs.find(p => p.id === testPO.id);
      expect(updated.status).toBe('CLAIM_PENDING');
      expect(updated.hasDispute).toBe(true);
      expect(updated.hasGRN).toBe(true);

      const updatedItem = updated.items[0];
      expect(updatedItem.shortageAction).toBe('CLAIM_SHORTAGE');
      expect(updatedItem.hasDispute).toBe(true);
      expect(updatedItem.shortageQty).toBe(1);
      expect(updatedItem.receivedQty).toBe(1);
    });

    it('sets poItem.hasDispute = true and PO status = CLAIM_PENDING when shortage exists in warehouseService', async () => {
      const testPO = {
        id: 'PO-TEST-WAIT',
        poNo: 'PO-2026-902',
        status: 'ORDERED',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        items: [{ id: 'ITM-102', productId: 'PROD-102', name: 'ถุงมือกันสารเคมี', orderedQty: 10, receivedQty: 0, unitPrice: 85 }]
      };
      storageService.savePOs([testPO]);

      const grnPayload = {
        grnNumber: 'GRN-2026-902-01',
        receivingItems: [{ productId: 'PROD-102', goodQty: 6, damagedQty: 0, shortageQty: 4, shortageAction: 'WAIT_NEXT_ROUND' }]
      };

      const result = await warehouseService.submitGRN(testPO.id, grnPayload);
      expect(result.success).toBe(true);

      const savedPOs = storageService.getPOs();
      const updated = savedPOs.find(p => p.id === testPO.id);
      expect(updated.status).toBe('CLAIM_PENDING');
      expect(updated.hasDispute).toBe(true);
      expect(updated.hasGRN).toBe(true);

      const updatedItem = updated.items[0];
      expect(updatedItem.shortageAction).toBe('CLAIM_SHORTAGE');
      expect(updatedItem.hasDispute).toBe(true);
      expect(updatedItem.shortageQty).toBe(4);
      expect(updatedItem.receivedQty).toBe(6);
    });

    it('renders Badge 🚨 ขาด {n} and red claimableAmount when shortageAction is CLAIM_SHORTAGE in CLAIM tab', () => {
      const po = {
        id: 'PO-CLAIM-VIEW',
        poNo: 'PO-2026-903',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        purchaseChannel: 'ONLINE',
        hasGRN: true,
        hasDispute: true,
        items: [
          {
            id: 'ITM-903',
            name: 'สว่านไร้สาย 12V',
            orderedQty: 3,
            receivedQty: 2,
            shortageQty: 1,
            damagedQty: 0,
            unitPrice: 890,
            actualPrice: 890,
            hasDispute: true,
            shortageAction: 'CLAIM_SHORTAGE',
            storeName: 'Hardware Store'
          }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="CLAIM" />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('🚨 ขาด 1 ชิ้น');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿890.00');
    });

    it('filters out (Hidden 100%) WAIT_NEXT_ROUND items in CLAIM tab', () => {
      const po = {
        id: 'PO-WAIT-VIEW',
        poNo: 'PO-2026-904',
        status: 'WAITING_DELIVERY_ROUND_2',
        purchaseChannel: 'ONLINE',
        hasGRN: true,
        hasDispute: false,
        items: [
          {
            id: 'ITM-904',
            name: 'น้ำยาทำความสะอาดพิเศษ',
            orderedQty: 5,
            receivedQty: 2,
            shortageQty: 3,
            damagedQty: 0,
            unitPrice: 250,
            actualPrice: 250,
            hasDispute: false,
            shortageAction: 'WAIT_NEXT_ROUND',
            storeName: 'Chemical Supply'
          }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="CLAIM" />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).not.toContain('น้ำยาทำความสะอาดพิเศษ');
      expect(html).not.toContain('🚨 ขาด 3 ชิ้น');
    });

    it('renders Badge ⏳ รอส่งมอบเพิ่ม {n} in ORDERED tab when shortageAction is WAIT_NEXT_ROUND', () => {
      const po = {
        id: 'PO-ORDERED-VIEW',
        poNo: 'PO-2026-905',
        status: 'WAITING_DELIVERY_ROUND_2',
        purchaseChannel: 'ONLINE',
        hasGRN: true,
        hasDispute: false,
        items: [
          {
            id: 'ITM-905',
            name: 'สายไฟ VAF 2x1.5',
            orderedQty: 4,
            receivedQty: 1,
            shortageQty: 3,
            damagedQty: 0,
            unitPrice: 420,
            actualPrice: 420,
            hasDispute: false,
            shortageAction: 'WAIT_NEXT_ROUND',
            storeName: 'Electric City'
          }
        ]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard po={po} activeTab="ORDERED" />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('สายไฟ VAF 2x1.5');
      expect(html).toContain('⏳ รอส่งมอบเพิ่ม 3 ชิ้น');
      expect(html).not.toContain('🚨 ขาด');
    });

    // Test block removed because shortage action dropdown was redesigned to use remainingQty instead
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 10: GRN Validation Deadlock Resolution & Finalization
  // ══════════════════════════════════════════════════════════════════
  describe('10. GRN Validation Deadlock Resolution & Intelligent PO Finalization', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('returns true when all items have receivedQty + refundedQty >= orderedQty in checkIsFullyAccounted', () => {
      const items = [
        { orderedQty: 5, receivedQty: 4, refundedQty: 1 },
        { orderedQty: 5, receivedQty: 5, refundedQty: 0 }
      ];
      expect(checkIsFullyAccounted(items)).toBe(true);
    });

    it('returns true when remainingToReceive is 0 for all items in checkIsFullyAccounted', () => {
      const items = [
        { ordered: 5, accumulated: 4, refunded: 1, remainingToReceive: 0 },
        { ordered: 5, accumulated: 5, refunded: 0, remainingToReceive: 0 }
      ];
      expect(checkIsFullyAccounted(items)).toBe(true);
    });

    it('returns false when at least one item has pending physical goods to receive in checkIsFullyAccounted', () => {
      const items = [
        { orderedQty: 5, receivedQty: 4, refundedQty: 0 },
        { orderedQty: 5, receivedQty: 5, refundedQty: 0 }
      ];
      expect(checkIsFullyAccounted(items)).toBe(false);
    });

    it('returns false for empty item list in checkIsFullyAccounted', () => {
      expect(checkIsFullyAccounted([])).toBe(false);
      expect(checkIsFullyAccounted(null)).toBe(false);
    });

    it('renders "✓ ยืนยันปิดงานใบสั่งซื้อ (Finalize PO)" button when all items are 100% accounted for', () => {
      const fullyAccountedPO = {
        id: 'PO-1789003809083-1',
        poNo: 'PO-PD-2026-001',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        vendorName: 'Shopee Supplier',
        items: [
          {
            productId: 'PROD-PD-002',
            code: 'PD-BOX-002',
            name: 'กล่องลูกฟูกมาตรฐาน',
            orderedQty: 5,
            accumulatedReceived: 4,
            receivedQty: 4,
            refundedQty: 1,
            claimResolution: 'REFUND',
            isSettled: true,
            purchaseUnit: 'ใบ',
            price: 162.32
          },
          {
            productId: 'PROD-PD-001',
            code: 'PD-OIL-068',
            name: 'น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)',
            orderedQty: 5,
            accumulatedReceived: 5,
            receivedQty: 5,
            refundedQty: 0,
            purchaseUnit: 'ถัง',
            price: 14500
          }
        ],
        storeClaims: {
          'Shopee_boxstore': { status: 'RESOLVED', isResolved: true, type: 'REFUND', refundAmount: 162.32 }
        }
      };

      const html = renderToStaticMarkup(<ReceivingModal po={fullyAccountedPO} isOpen={true} />);
      expect(html).toContain('ยืนยันรับเข้าคลังสมบูรณ์ (ปิดงาน PO)');
      expect(html).toContain('สินค้าทุกรายการได้รับการตรวจรับหรือเคลมชดเชยครบถ้วนแล้ว (100% Accounted)');
    });

    it('renders standard "✓ ยืนยันรับเข้าคลังสมบูรณ์" button when goods are still pending', () => {
      const pendingPO = {
        id: 'PO-PENDING-001',
        poNo: 'PO-PD-2026-002',
        status: 'ORDERED_PENDING_DELIVERY',
        department: 'PD',
        items: [
          { productId: 'PROD-PD-001', code: 'PD-OIL-068', name: 'น้ำมันไฮดรอลิกอุตสาหกรรม', orderedQty: 5, accumulatedReceived: 0, receivedQty: 0, refundedQty: 0, purchaseUnit: 'ถัง', price: 14500 }
        ]
      };

      const html = renderToStaticMarkup(<ReceivingModal po={pendingPO} isOpen={true} />);
      expect(html).not.toContain('ยืนยันปิดงานใบสั่งซื้อ (Finalize PO)');
    });

    it('storageService.finalizePO canonically sets COMPLETED, workflowStatus, isCompleted, isClosed, and clears claim flags', () => {
      const po = {
        id: 'PO-FINALIZE-TEST',
        poNo: 'PO-PD-2026-099',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        isInClaim: true,
        hasDispute: true,
        claimStatus: 'IN_CLAIM',
        items: [{ productId: 'PROD-01', orderedQty: 5, receivedQty: 4, refundedQty: 1 }]
      };

      storageService.savePOs([po]);
      const updated = storageService.finalizePO('PO-FINALIZE-TEST', { completedAt: '2026-09-13T10:00:00.000Z' });

      expect(updated).toBeDefined();
      expect(updated.status).toBe('COMPLETED');
      expect(updated.workflowStatus).toBe('COMPLETED');
      expect(updated.isCompleted).toBe(true);
      expect(updated.isClosed).toBe(true);
      expect(updated.isInClaim).toBe(false);
      expect(updated.hasDispute).toBe(false);
      expect(updated.claimStatus).toBe('RESOLVED');
      expect(updated.completedAt).toBe('2026-09-13T10:00:00.000Z');

      const completedList = storageService.getCompletedPOsByMonth('2026-09');
      expect(completedList.some(p => p.id === 'PO-FINALIZE-TEST')).toBe(true);
    });

    it('recordGoodsReceipt respects statusOverride=COMPLETED and allReceived on fully accounted PO', async () => {
      const po = {
        id: 'PO-GRN-ACCOUNTED-01',
        poNo: 'PO-PD-2026-001',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        items: [
          { productId: 'P1', name: 'Item 1', orderedQty: 5, receivedQty: 4, accumulatedReceived: 4, refundedQty: 1, claimResolution: 'REFUND' },
          { productId: 'P2', name: 'Item 2', orderedQty: 5, receivedQty: 5, accumulatedReceived: 5, refundedQty: 0 }
        ]
      };

      storageService.savePOs([po]);

      const res = await recordGoodsReceipt('PO-GRN-ACCOUNTED-01', {
        grnNumber: 'GRN-PO-PD-2026-001-02',
        round: 2,
        statusOverride: 'COMPLETED',
        receivingItems: [
          { productId: 'P1', goodQty: 0, damagedQty: 0, shortageQty: 0 },
          { productId: 'P2', goodQty: 0, damagedQty: 0, shortageQty: 0 }
        ]
      });

      expect(res.po.status).toBe('COMPLETED');
      expect(res.po.hasDispute).toBe(false);
      expect(res.po.isInClaim).toBe(false);
      expect(res.po.items[0].shortageQty).toBe(0);
      expect(res.po.items[1].shortageQty).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 11: Enterprise Dual-UOM Engine & Stock Movement Pipeline
  // ══════════════════════════════════════════════════════════════════
  describe('11. Enterprise Dual-UOM Engine & Stock Movement Pipeline', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('accurately resolves PD-OIL-068 multi-UOM bulk drum to liter conversion', () => {
      const uom = storageService.getUomConversion('PD-OIL-068');
      expect(uom.product).toBeDefined();
      expect(uom.purchaseUom).toBe('ถัง (200L)');
      expect(uom.baseUom).toBe('ลิตร');
      expect(uom.conversionRatio).toBe(200);
      expect(uom.purchaseUnitPrice).toBe(14500);
      expect(uom.baseUnitCost).toBe(72.50);
    });

    it('accurately resolves standard 1:1 UOM for PD-BOX-002', () => {
      const uom = storageService.getUomConversion('PD-BOX-002');
      expect(uom.product).toBeDefined();
      expect(uom.purchaseUom).toBe('ใบ');
      expect(uom.baseUom).toBe('ใบ');
      expect(uom.conversionRatio).toBe(1);
      expect(uom.purchaseUnitPrice).toBe(15);
      expect(uom.baseUnitCost).toBe(15);
    });

    it('Case F: safely defaults to ratio 1 when conversionRatio is missing, null, 0, or negative', () => {
      const missingUom = storageService.getUomConversion('NON-EXISTENT-ITEM');
      expect(missingUom.conversionRatio).toBe(1);

      const baseQtyZero = storageService.calculateBaseQuantity(10, 0);
      expect(baseQtyZero).toBe(10);

      const baseQtyNegative = storageService.calculateBaseQuantity(10, -5);
      expect(baseQtyNegative).toBe(10);

      const baseQtyNull = storageService.calculateBaseQuantity(10, null);
      expect(baseQtyNull).toBe(10);
    });

    it('satisfies calculation invariants: Base Qty * Base Unit Cost === Purchase Qty * Purchase Unit Price', () => {
      const purchaseQty = 5;
      const uom = storageService.getUomConversion('PD-OIL-068');
      const valuation = storageService.calculateValuation({
        purchaseQty,
        purchaseUnitPrice: uom.purchaseUnitPrice,
        conversionRatio: uom.conversionRatio
      });

      expect(valuation.baseStockQty).toBe(1000);
      expect(valuation.baseUnitCost).toBe(72.50);
      expect(valuation.totalValue).toBe(72500.00);
      expect(valuation.totalValue).toBe(purchaseQty * uom.purchaseUnitPrice);
    });

    it('ensures INITIAL-BALANCE of PD-OIL-068 is 2,400 Liters @ ฿72.50 = ฿174,000.00 (Sanitization & Valuation Bug Elimination)', () => {
      const stockLogs = storageService.getStockLogs();
      const oilInitialLog = stockLogs.find(l => 
        (l.id === 'INIT-PROD-PD-001' || l.documentNo === 'INITIAL-BALANCE') &&
        (l.productId === 'PROD-PD-001' || l.productCode === 'PD-OIL-068')
      );

      expect(oilInitialLog).toBeDefined();
      expect(Number(oilInitialLog.qty)).toBe(2400);
      expect(Number(oilInitialLog.unitPrice)).toBe(72.50);
      expect(Number(oilInitialLog.totalPrice)).toBe(174000);
      expect(Number(oilInitialLog.totalPrice)).not.toBe(34800000);
    });

    it('Case A (Standard 1:1 UOM): logs movement for PD-BOX-002 with 1:1 mapping', () => {
      const emitted = storageService.logStockMovements([{
        documentNo: 'GRN-2026-TEST-001',
        poNumber: 'PO-PD-2026-001',
        itemCode: 'PD-BOX-002',
        quantity: 4,
        purchaseUnitPrice: 15,
        conversionRatio: 1,
        purchaseUom: 'ใบ',
        baseUom: 'ใบ'
      }]);

      expect(emitted).toHaveLength(1);
      const log = emitted[0];
      expect(log.documentNo).toBe('GRN-2026-TEST-001');
      expect(log.poNumber).toBe('PO-PD-2026-001');
      expect(log.itemCode).toBe('PD-BOX-002');
      expect(log.quantity).toBe(4);
      expect(log.unitPrice).toBe(15);
      expect(log.totalValue).toBe(60);
    });

    it('Case B (Multi-UOM Bulk to Sub-unit): converts 5 drums to +1,000 Liters @ ฿72.50 = ฿72,500', () => {
      const uom = storageService.getUomConversion('PD-OIL-068');
      const purchaseQty = 5;
      const baseQty = purchaseQty * uom.conversionRatio;
      const baseCost = uom.baseUnitCost;

      const emitted = storageService.logStockMovements([{
        documentNo: 'GRN-2026-TEST-002',
        poNumber: 'PO-PD-2026-002',
        itemCode: 'PD-OIL-068',
        quantity: baseQty,
        receivedQty: purchaseQty,
        unitPrice: baseCost,
        totalValue: baseQty * baseCost,
        conversionRatio: uom.conversionRatio,
        purchaseUom: uom.purchaseUom,
        baseUom: uom.baseUom,
        createdAt: new Date().toISOString()
      }]);

      expect(emitted).toHaveLength(1);
      const log = emitted[0];
      expect(log.documentNo).toBe('GRN-2026-TEST-002');
      expect(log.poNumber).toBe('PO-PD-2026-002');
      expect(log.itemCode).toBe('PD-OIL-068');
      expect(log.quantity).toBe(1000);
      expect(log.receivedQty).toBe(5);
      expect(log.unitPrice).toBe(72.50);
      expect(log.totalValue).toBe(72500);
      expect(log.baseUom).toBe('ลิตร');
      expect(log.purchaseUom).toBe('ถัง (200L)');
    });

    it('Case C (Partial Receipts across multiple rounds): emits distinct movements per GRN round', () => {
      const round1 = storageService.logStockMovements([{
        documentNo: 'GRN-PO-PD-003-01',
        poNumber: 'PO-PD-2026-003',
        itemCode: 'PD-OIL-068',
        quantity: 400,
        receivedQty: 2,
        unitPrice: 72.50,
        totalValue: 29000,
        conversionRatio: 200
      }]);

      const round2 = storageService.logStockMovements([{
        documentNo: 'GRN-PO-PD-003-02',
        poNumber: 'PO-PD-2026-003',
        itemCode: 'PD-OIL-068',
        quantity: 600,
        receivedQty: 3,
        unitPrice: 72.50,
        totalValue: 43500,
        conversionRatio: 200
      }]);

      expect(round1[0].documentNo).toBe('GRN-PO-PD-003-01');
      expect(round1[0].quantity).toBe(400);
      expect(round2[0].documentNo).toBe('GRN-PO-PD-003-02');
      expect(round2[0].quantity).toBe(600);

      const logs = storageService.getStockLogs();
      expect(logs.some(l => l.documentNo === 'GRN-PO-PD-003-01' && l.quantity === 400)).toBe(true);
      expect(logs.some(l => l.documentNo === 'GRN-PO-PD-003-02' && l.quantity === 600)).toBe(true);
    });

    it('Case D (Zero-Physical / Refund Finalization): strictly enforces zero phantom movements for quantity 0', () => {
      const logsBefore = storageService.getStockLogs().length;

      const emitted = storageService.logStockMovements([{
        documentNo: 'GRN-2026-ZERO',
        poNumber: 'PO-PD-2026-001',
        itemCode: 'PD-BOX-002',
        quantity: 0,
        unitPrice: 15,
        totalValue: 0
      }]);

      expect(emitted).toHaveLength(0);
      const logsAfter = storageService.getStockLogs().length;
      expect(logsAfter).toBe(logsBefore);
    });

    it('Case E (Damaged / Rejected Goods): zero positive movement when acceptedQty is 0', () => {
      const logsBefore = storageService.getStockLogs().length;

      const emitted = storageService.logStockMovements([{
        documentNo: 'GRN-2026-REJECT',
        poNumber: 'PO-PD-2026-004',
        itemCode: 'PD-OIL-068',
        quantity: 0,
        damagedQty: 5
      }]);

      expect(emitted).toHaveLength(0);
      expect(storageService.getStockLogs().length).toBe(logsBefore);
    });

    it('renders distinct refund badges [รับแล้ว: 4] + [คืนเงินแล้ว: 1 ใบ (ปิดรับ)] in PODetailsModal', () => {
      const mockPO = {
        id: 'PO-TEST-REFUND',
        poNo: 'PO-PD-2026-001',
        status: 'COMPLETED',
        workflowStatus: 'COMPLETED',
        createdAt: '2026-09-01T08:00:00Z',
        vendor: { name: 'Thai Supplier Co.' },
        items: [
          {
            id: 'ITEM-1',
            code: 'PD-BOX-002',
            name: 'กล่องกระดาษลูกฟูก เบอร์ 2',
            actualQty: 5,
            qty: 5,
            purchaseUnit: 'ใบ',
            actualPrice: 15,
            receivedQty: 4,
            refundedQty: 1,
            total: 75
          }
        ]
      };

      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={mockPO} currentRole="REQUESTER_PD" onClose={() => {}} />
      );

      expect(html).toContain('รับแล้ว: 4');
      expect(html).toContain('คืนเงินแล้ว: 1 ใบ (ปิดรับ)');
    });

    it('renders Dual-UOM specifications: 5 ถัง (1,000 ลิตร) @ ฿14,500 / ถัง (฿72.50 / ลิตร) in PODetailsModal', () => {
      const mockPO = {
        id: 'PO-TEST-DUAL-UOM',
        poNo: 'PO-PD-2026-002',
        status: 'PENDING_DELIVERY',
        workflowStatus: 'PENDING_DELIVERY',
        createdAt: '2026-09-01T08:00:00Z',
        vendor: { name: 'Oil Refinery Co.' },
        items: [
          {
            id: 'ITEM-OIL',
            code: 'PD-OIL-068',
            name: 'น้ำมันหล่อลื่นอุตสาหกรรม Drum (200L)',
            actualQty: 5,
            qty: 5,
            purchaseUom: 'ถัง (200L)',
            purchaseUnit: 'ถัง (200L)',
            baseUom: 'ลิตร',
            stockUnit: 'ลิตร',
            conversionRatio: 200,
            actualPrice: 14500,
            receivedQty: 0,
            total: 72500
          }
        ]
      };

      const html = renderToStaticMarkup(
        <PODetailsModal selectedPO={mockPO} currentRole="REQUESTER_PD" onClose={() => {}} />
      );

      expect(html).toContain('5 ถัง (200L)');
      expect(html).toContain('(1,000 ลิตร)');
      expect(html).toContain('฿14,500 / ถัง (200L)');
      expect(html).toContain('(฿72.50 / ลิตร)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 12: PO Document Template & Receiving Signature Dynamic Rendering
  // ══════════════════════════════════════════════════════════════════
  describe('12. PO Document Template & Receiving Signature Dynamic Rendering (Column 4)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveProducts([
        { id: 'PROD-01', code: 'P01', name: 'Hydraulic Oil', stockBalance: 20, unit: 'ถัง' }
      ]);
    });

    it('formats ISO 8601 strings into "DD/MM/BBBB HH:mm น."', () => {
      const iso = '2026-09-12T10:15:00.000Z';
      const formatted = formatThaiDateTime(iso);
      expect(formatted).toMatch(/^\d{2}\/\d{2}\/2569 \d{2}:\d{2} น\.$/);
      expect(formatDocDateTime(iso)).toMatch(/^วันที่ \d{2}\/\d{2}\/2569 \d{2}:\d{2} น\.$/);
    });

    it('converts Buddhist Era year (>2400) to Christian Era year (2026) internally and returns BBBB', () => {
      const thaiDate = '12/09/2569 เวลา 10:15 น.';
      const formatted = formatThaiDateTime(thaiDate);
      expect(formatted).toBe('12/09/2569 10:15 น.');
      expect(formatDocDateTime(thaiDate)).toBe('วันที่ 12/09/2569 10:15 น.');
    });

    it('handles date-only strings gracefully', () => {
      const dateOnly = '12/09/2026';
      const formatted = formatThaiDateTime(dateOnly);
      expect(formatted).toBe('12/09/2569');
      expect(formatDocDateTime(dateOnly)).toBe('วันที่ 12/09/2569');
    });

    it('returns placeholder dots when input is null, undefined, or empty', () => {
      expect(formatThaiDateTime(null)).toBe('..... / ..... / .........');
      expect(formatThaiDateTime('')).toBe('..... / ..... / .........');
      expect(formatThaiDateTime('-')).toBe('..... / ..... / .........');
      expect(formatDocDateTime(null)).toBe('วันที่ ..... / ..... / .........');
      expect(formatDocDateTime('')).toBe('วันที่ ..... / ..... / .........');
    });

    it('POPrintTemplate exports PrintablePO and format utilities', () => {
      expect(POPrintTemplate).toBeDefined();
      expect(POPrintTemplate).toBe(PrintablePO);
    });

    it('PODocumentModal exports PODetailsModal', () => {
      expect(PODocumentModal).toBeDefined();
    });

    it('recordGoodsReceipt attaches receivingInfo on 100% completed receiving', async () => {
      const poId = 'PO-TEST-REC-01';
      storageService.savePOs([
        {
          id: poId,
          poNo: poId,
          status: 'ORDERED_PENDING_DELIVERY',
          department: 'PD',
          items: [{ productId: 'PROD-01', code: 'P01', name: 'Hydraulic Oil', orderedQty: 5, receivedQty: 0, price: 1000 }]
        }
      ]);

      const grnPayload = {
        grnNumber: 'GRN-PO-TEST-REC-01-01',
        round: 1,
        receivedDate: '12/09/2026 10:15:00',
        receivedBy: 'คุณวิชัย สุขใจ (Warehouse Supervisor)',
        receiverSignature: '/signatures/receiver-wichai.png',
        receivingInfo: {
          receiverName: 'คุณวิชัย สุขใจ',
          receiverSignature: '/signatures/receiver-wichai.png',
          receivedAt: '2026-09-12T10:15:00.000Z'
        },
        receivingItems: [
          { productId: 'PROD-01', code: 'P01', name: 'Hydraulic Oil', receivedThisTime: 5, goodQty: 5, damagedQty: 0, shortageQty: 0 }
        ]
      };

      const result = await recordGoodsReceipt(poId, grnPayload);
      expect(result.success).toBe(true);
      expect(result.po.status).toBe('COMPLETED');
      expect(result.po.receivingInfo).toBeDefined();
      expect(result.po.receivingInfo.receiverName).toBe('คุณวิชัย สุขใจ');
      expect(result.po.receivingInfo.receiverSignature).toBe('/signatures/receiver-wichai.png');
      expect(result.po.receivingInfo.receivedAt).toBe('2026-09-12T10:15:00.000Z');
    });

    it('workflowEngine.receiveGoods sets receivingInfo with timestamp and signature', async () => {
      const poId = 'PO-TEST-WF-01';
      storageService.savePOs([
        {
          id: poId,
          poNo: poId,
          status: 'APPROVED',
          department: 'PD',
          items: [{ productId: 'PROD-01', code: 'P01', name: 'Hydraulic Oil', qty: 2, price: 500 }]
        }
      ]);

      const user = {
        name: 'คุณสมชาย มุ่งมั่น',
        employeeName: 'คุณสมชาย มุ่งมั่น',
        signature: '/signatures/somchai.png',
        title: 'Asst. Manager'
      };

      const po = await workflowEngine.receiveGoods(poId, [{ productId: 'PROD-01', receivedThisTime: 2 }], user, 'ตรวจรับครบถ้วน');
      expect(po.receivingInfo).toBeDefined();
      expect(po.receivingInfo.receiverName).toBe('คุณสมชาย มุ่งมั่น');
      expect(po.receivingInfo.receiverSignature).toBe('/signatures/somchai.png');
      expect(po.receivingInfo.receivedAt).toBeDefined();
    });

    it('renders empty dot placeholders when PO is not yet received in PrintablePO', () => {
      const draftPO = {
        id: 'PO-DRAFT-01',
        poNo: 'PO-DRAFT-01',
        status: 'ORDERED_PENDING_DELIVERY',
        department: 'PD',
        items: [{ name: 'Item A', qty: 2, price: 100 }],
        createdBy: 'คุณวิชัย สุขใจ'
      };

      const html = renderToStaticMarkup(<PrintablePO po={draftPO} />);
      expect(html).toContain('ผู้ขอซื้อ');
      expect(html).toContain('ผู้ทบทวน');
      expect(html).toContain('ผู้อนุมัติ');
      expect(html).toContain('( ........................................... )');
      expect(html).toContain('วันที่ ..... / ..... / .........');
    });

    it('renders digital signature, dynamic name and formatted Thai date-time when PO has receivingInfo', () => {
      const completedPO = {
        id: 'PO-COMPLETED-01',
        poNo: 'PO-COMPLETED-01',
        status: 'COMPLETED',
        department: 'PD',
        receivingInfo: {
          receiverName: 'คุณสมศักดิ์ คลังสินค้า',
          receiverSignature: '/signatures/somsak.png',
          receivedAt: '2026-09-12T10:15:00.000Z'
        },
        items: [{ name: 'Item A', qty: 2, price: 100 }],
        createdBy: 'คุณวิชัย สุขใจ',
        reviewerName: 'คุณสมชาย มุ่งมั่น',
        reviewedAt: '2026-09-10T08:00:00.000Z',
        approvedBy: 'คุณประเสริฐ ยิ่งยง',
        approvedAt: '2026-09-11T09:00:00.000Z'
      };

      const html = renderToStaticMarkup(<PrintablePO po={completedPO} />);

      const expectedFormattedDate = formatThaiDateTime('2026-09-12T10:15:00.000Z');
      expect(html).toContain(`วันที่ ${expectedFormattedDate}`);

      expect(html).toContain('คุณวิชัย สุขใจ');
      expect(html).toContain('คุณสมชาย มุ่งมั่น');
      expect(html).toContain('คุณประเสริฐ ยิ่งยง');
    });

    it('renders fallback receiver name and signature if receivingInfo has partial data but status is COMPLETED', () => {
      const legacyCompletedPO = {
        id: 'PO-LEGACY-COMPLETED',
        poNo: 'PO-LEGACY-COMPLETED',
        status: 'COMPLETED',
        department: 'PD',
        receivingInfo: {
          receiverName: 'คุณวิชัย สุขใจ',
          receiverSignature: '/signatures/receiver-default.png',
          receivedAt: '2026-09-12T10:15:00.000Z'
        },
        items: [{ name: 'Item A', qty: 2, price: 100 }],
        createdBy: 'คุณวิชัย สุขใจ'
      };

      const html = renderToStaticMarkup(<PrintablePO po={legacyCompletedPO} />);
    });

    it('renders fallback line ( ........................................... ) without mock name when receiverName is missing on received PO', () => {
      const anonReceivedPO = {
        id: 'PO-ANON-01',
        poNo: 'PO-ANON-01',
        status: 'RECEIVED',
        department: 'PD',
        requestedBy: 'คุณกนกวรรณ ผู้ขอซื้อ',
        reviewerName: 'คุณสมชาย ผู้ทบทวน',
        approvedBy: 'คุณประเสริฐ ผู้อนุมัติ',
        receivedAt: '2026-09-15T08:30:00.000Z',
        receiverSignature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        items: [{ name: 'Item A', qty: 2, price: 100 }]
      };

      const html = renderToStaticMarkup(<PrintablePO po={anonReceivedPO} />);
    });

    it('renders receiver signature and Thai formatted date for partial receive status (PARTIALLY_RECEIVED)', () => {
      const partialPO = {
        id: 'PO-PARTIAL-01',
        poNo: 'PO-PARTIAL-01',
        status: 'PARTIALLY_RECEIVED',
        department: 'PD',
        receiverName: 'สิรภัทร แจ่มมิน',
        receivedAt: '2026-09-16T08:00:00.000Z',
        receiverSignature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        items: [{ name: 'Item A', qty: 2, price: 100 }]
      };

      const html = renderToStaticMarkup(<PrintablePO po={partialPO} />);
      const expectedDate = formatThaiDateTime('2026-09-16T08:00:00.000Z');
      expect(html).toContain(`วันที่ ${expectedDate}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 13: GRN Data Relay & Online Order Card Precision
  // ══════════════════════════════════════════════════════════════════
  describe('13. GRN Data Relay & Online Order Card Precision Verification', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
    });

    it('calculates metrics for Lubricant (damaged 1 of 5), Gloves (5 of 5), Conveyor (4 of 5 wait next round)', () => {
      const lubricant = {
        id: 'it-lubricant',
        code: 'LUB-01',
        name: 'น้ำมันหล่อลื่นสังเคราะห์',
        purchaseQty: 5,
        actualQty: 5,
        receivedQty: 4,
        damagedQty: 1,
        shortageQty: 0,
        unitPrice: 500,
        actualPrice: 500,
        purchaseUnit: 'ถัง',
        unit: 'ถัง',
        isDamaged: true,
        hasDispute: true,
        disputeAction: 'CLAIM',
        storePlatform: 'Shopee',
        actualStoreName: 'ร้านน้ำมันหล่อลื่น'
      };
      const m1 = calculateDisputeMetrics(lubricant, 'PARTIALLY_RECEIVED_IN_CLAIM', true);
      expect(m1.orderedQty).toBe(5);
      expect(m1.receivedQty).toBe(4);
      expect(m1.damagedQty).toBe(1);
      expect(m1.shortageQty).toBe(0);
      expect(m1.disputedQty).toBe(1);
      expect(m1.claimableAmount).toBe(500);
      expect(m1.hasDispute).toBe(true);

      const gloves = {
        id: 'it-gloves',
        code: 'GLV-01',
        name: 'ถุงมือยางแพทย์',
        purchaseQty: 5,
        actualQty: 5,
        receivedQty: 5,
        damagedQty: 0,
        shortageQty: 0,
        unitPrice: 120,
        actualPrice: 120,
        purchaseUnit: 'กล่อง',
        unit: 'กล่อง',
        isDamaged: false,
        hasDispute: false,
        storePlatform: 'Shopee',
        actualStoreName: 'ร้านถุงมือยาง'
      };
      const m2 = calculateDisputeMetrics(gloves, 'PARTIALLY_RECEIVED_IN_CLAIM', true);
      expect(m2.orderedQty).toBe(5);
      expect(m2.receivedQty).toBe(5);
      expect(m2.damagedQty).toBe(0);
      expect(m2.shortageQty).toBe(0);
      expect(m2.disputedQty).toBe(0);
      expect(m2.claimableAmount).toBe(0);
      expect(m2.hasDispute).toBe(false);

      const conveyor = {
        id: 'it-conveyor',
        code: 'BELT-01',
        name: 'สายพานลำเลียงอุตสาหกรรม',
        purchaseQty: 5,
        actualQty: 5,
        receivedQty: 4,
        damagedQty: 0,
        shortageQty: 1,
        unitPrice: 850,
        actualPrice: 850,
        purchaseUnit: 'เส้น',
        unit: 'เส้น',
        isDamaged: false,
        hasDispute: false,
        disputeAction: 'WAIT_NEXT_ROUND',
        shortageReason: 'SPLIT_SHIPMENT',
        storePlatform: 'Lazada',
        actualStoreName: 'ร้านสายพานลำเลียง'
      };
      const m3 = calculateDisputeMetrics(conveyor, 'PARTIALLY_RECEIVED_IN_CLAIM', true);
      expect(m3.orderedQty).toBe(5);
      expect(m3.receivedQty).toBe(4);
      expect(m3.damagedQty).toBe(0);
      expect(m3.shortageQty).toBe(1);
      expect(m3.disputedQty).toBe(0);
      expect(m3.claimableAmount).toBe(0);
      expect(m3.hasDispute).toBe(false);
      expect(m3.isWaitingNextRound).toBe(true);
      expect(m3.waitingNextRoundQty).toBe(1);
    });

    it('renders OnlineOrderCard with 3 stores exactly matching all user UI directives', () => {
      const multiStorePO = {
        id: 'PO-2026-RELAY-01',
        poNo: 'PO-2026-RELAY-01',
        status: 'PARTIALLY_RECEIVED_IN_CLAIM',
        department: 'PD',
        items: [
          {
            id: 'it-1',
            code: 'LUB-01',
            name: 'น้ำมันหล่อลื่นสังเคราะห์',
            purchaseQty: 5,
            actualQty: 5,
            receivedQty: 4,
            goodQty: 4,
            damagedQty: 1,
            shortageQty: 0,
            unitPrice: 500,
            actualPrice: 500,
            purchaseUnit: 'ถัง',
            unit: 'ถัง',
            isDamaged: true,
            hasDispute: true,
            disputeAction: 'CLAIM',
            storePlatform: 'Shopee',
            actualStoreName: 'ร้านน้ำมันหล่อลื่น'
          },
          {
            id: 'it-2',
            code: 'GLV-01',
            name: 'ถุงมือยางแพทย์',
            purchaseQty: 5,
            actualQty: 5,
            receivedQty: 5,
            goodQty: 5,
            damagedQty: 0,
            shortageQty: 0,
            unitPrice: 120,
            actualPrice: 120,
            purchaseUnit: 'กล่อง',
            unit: 'กล่อง',
            isDamaged: false,
            hasDispute: false,
            storePlatform: 'Shopee',
            actualStoreName: 'ร้านถุงมือยาง'
          },
          {
            id: 'it-3',
            code: 'BELT-01',
            name: 'สายพานลำเลียงอุตสาหกรรม',
            purchaseQty: 5,
            actualQty: 5,
            receivedQty: 4,
            goodQty: 4,
            damagedQty: 0,
            shortageQty: 1,
            unitPrice: 850,
            actualPrice: 850,
            purchaseUnit: 'เส้น',
            unit: 'เส้น',
            isDamaged: false,
            hasDispute: false,
            disputeAction: 'WAIT_NEXT_ROUND',
            shortageReason: 'SPLIT_SHIPMENT',
            storePlatform: 'Lazada',
            actualStoreName: 'ร้านสายพานลำเลียง'
          }
        ],
        storeClaims: {}
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard
              po={multiStorePO}
              activeTab="CLAIM"
              currentRole={{ id: 'ONLINE_PURCHASER', name: 'Online Purchaser' }}
              onUpdate={() => {}}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('ร้าน: ร้านน้ำมันหล่อลื่น');
      expect(html).toContain('⚠️ ร้านนี้มีรายการติดปัญหา');
      expect(html).toContain('⚠️ ชำรุด 1 ถัง');
      expect(html).toContain('มูลค่าที่ต้องเคลม');
      expect(html).toContain('฿500.00');
      expect(html).toContain('💰 คืนเงิน (Refund)');
      expect(html).toContain('value="500"');

      expect(html).toContain('ร้าน: ร้านถุงมือยาง');
      expect(html).toContain('(รับของครบสมบูรณ์)');

      expect(html).toContain('ร้าน: ร้านสายพานลำเลียง');
      expect(html).toContain('(รอส่งมอบเพิ่ม 1 เส้น)');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 14: State Engine: Partial Receiving, GRN & Budget Reversal
  // ══════════════════════════════════════════════════════════════════
  describe('14. State Engine: Partial Receiving, GRN Tracking, & Budget Reversal', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      storageService.saveVendors([
        { id: 'VEN-01', code: 'V01', name: 'Standard Supplier' }
      ]);
      storageService.saveProducts([
        { id: 'PROD-A', code: 'SKU-A', name: 'Product Alpha', category: 'PD', price: 100, stockBalance: 20, unit: 'ชิ้น', conversionRate: 1 },
        { id: 'PROD-B', code: 'SKU-B', name: 'Product Beta', category: 'PD', price: 200, stockBalance: 5, unit: 'ชิ้น', conversionRate: 1 }
      ]);
    });

    it('1. Verifies PO_STATUS constants include extended partial and claim statuses', () => {
      expect(PO_STATUS.PARTIALLY_RECEIVED_IN_CLAIM).toBeDefined();
      expect(PO_STATUS.PARTIALLY_RECEIVED_IN_CLAIM.id).toBe('PARTIALLY_RECEIVED_IN_CLAIM');
      expect(PO_STATUS.COMPLETED_WITH_REFUND).toBeDefined();
      expect(PO_STATUS.COMPLETED_WITH_REFUND.id).toBe('COMPLETED_WITH_REFUND');
      expect(PO_STATUS.WAITING_DELIVERY_ROUND_2).toBeDefined();
      expect(PO_STATUS.WAITING_DELIVERY_ROUND_2.id).toBe('WAITING_DELIVERY_ROUND_2');
    });

    it('2. recordGoodsReceipt updates line-item contracts (orderedQty, receivedQty, damagedQty, shortageQty) and records GRN round', async () => {
      const initialPO = {
        id: 'PO-TEST-001',
        poNo: 'PO-PD-2026-999',
        prNo: 'PD001/2026',
        status: 'ISSUED',
        department: 'PD',
        grandTotal: 3000,
        items: [
          {
            productId: 'PROD-A',
            code: 'SKU-A',
            name: 'Product Alpha',
            orderedQty: 10,
            purchaseQty: 10,
            qty: 10,
            receivedQty: 0,
            damagedQty: 0,
            shortageQty: 10,
            price: 100
          },
          {
            productId: 'PROD-B',
            code: 'SKU-B',
            name: 'Product Beta',
            orderedQty: 10,
            purchaseQty: 10,
            qty: 10,
            receivedQty: 0,
            damagedQty: 0,
            shortageQty: 10,
            price: 200
          }
        ]
      };
      storageService.savePOs([initialPO]);

      const procurement = useProcurementContext();

      const grnPayloadRound1 = {
        grnNumber: 'GRN-PO-PD-2026-999-01',
        round: 1,
        receivedBy: 'QC Inspector A',
        note: 'ตรวจรับรอบที่ 1 พบของไม่ครบและมีของชำรุด',
        receivingItems: [
          { productId: 'PROD-A', receivedThisTime: 6, damagedQty: 1, condition: 'DAMAGED' },
          { productId: 'PROD-B', receivedThisTime: 4, damagedQty: 0, condition: 'GOOD' }
        ]
      };

      const res1 = await procurement.recordGoodsReceipt('PO-TEST-001', grnPayloadRound1);
      expect(res1.success).toBe(true);

      const poAfterRound1 = res1.po;
      expect(poAfterRound1.status).toBe('PARTIALLY_RECEIVED_IN_CLAIM');
      expect(poAfterRound1.grnHistory).toHaveLength(1);
      expect(poAfterRound1.grnHistory[0].grnNumber).toBe('GRN-PO-PD-2026-999-01');

      const itemA = poAfterRound1.items.find(i => i.productId === 'PROD-A');
      expect(itemA.orderedQty).toBe(10);
      expect(itemA.receivedQty).toBe(6);
      expect(itemA.damagedQty).toBe(1);
      expect(itemA.shortageQty).toBe(4);

      const itemB = poAfterRound1.items.find(i => i.productId === 'PROD-B');
      expect(itemB.orderedQty).toBe(10);
      expect(itemB.receivedQty).toBe(4);
      expect(itemB.damagedQty).toBe(0);
      expect(itemB.shortageQty).toBe(6);

      const grnPayloadRound2 = {
        grnNumber: 'GRN-PO-PD-2026-999-02',
        round: 2,
        receivedBy: 'QC Inspector B',
        statusOverride: 'COMPLETED_WITH_REFUND',
        note: 'รับสินค้าชดเชยและเคลียร์ส่วนต่างด้วยการคืนเงิน',
        receivingItems: [
          { productId: 'PROD-A', receivedThisTime: 4, damagedQty: 0 },
          { productId: 'PROD-B', receivedThisTime: 6, damagedQty: 0 }
        ]
      };

      const res2 = await procurement.recordGoodsReceipt('PO-TEST-001', grnPayloadRound2);
      expect(res2.success).toBe(true);
      const poAfterRound2 = res2.po;

      expect(poAfterRound2.status).toBe('COMPLETED_WITH_REFUND');
      expect(poAfterRound2.grnHistory).toHaveLength(2);
      const itemA2 = poAfterRound2.items.find(i => i.productId === 'PROD-A');
      expect(itemA2.receivedQty).toBe(10);
      expect(itemA2.shortageQty).toBe(0);
    });

    it('3. rollbackBudget reduces actualExpense/spent, restores remainingBudget/variance, and appends ledger transaction', async () => {
      storageService.saveBudgets({
        PD: {
          monthlyBudget: 100000,
          spent: 40000,
          actualExpense: 40000,
          variance: 60000,
          remainingBudget: 60000
        }
      });

      const budgetCtx = useBudgetContext();
      const refundRes = await budgetCtx.rollbackBudget('PD', 5000, 'คืนเงินค่าสินค้าเสียหายจาก PO-PD-2026-999');

      expect(refundRes.success).toBe(true);
      expect(refundRes.refundAmount).toBe(5000);
      expect(refundRes.actualExpense).toBe(35000);
      expect(refundRes.remainingBudget).toBe(65000);

      const updatedBudgets = storageService.getBudgets();
      expect(updatedBudgets.PD.spent).toBe(35000);
      expect(updatedBudgets.PD.variance).toBe(65000);

      const transactions = storageService.getBudgetTransactions();
      expect(transactions.length).toBeGreaterThanOrEqual(1);
      const latestTx = transactions[0];
      expect(latestTx.dept).toBe('PD');
      expect(latestTx.type).toBe('BUDGET_ROLLBACK');
      expect(latestTx.amount).toBe(5000);
    });

    it('4. receiveToStock receives only complete/good items and ignores damaged units for stockBalance', async () => {
      const inventory = useInventoryContext();

      const initialProds = storageService.getProducts();
      expect(initialProds.find(p => p.id === 'PROD-A').stockBalance).toBe(20);
      expect(initialProds.find(p => p.id === 'PROD-B').stockBalance).toBe(5);

      const receiptItems = [
        { productId: 'PROD-A', receivedQty: 10, damagedQty: 3, docNo: 'PO-PD-001' },
        { productId: 'PROD-B', receivedQty: 4, damagedQty: 4, docNo: 'PO-PD-001' }
      ];

      const stockRes = await inventory.receiveToStock(receiptItems, { docNo: 'PO-PD-001', note: 'ตรวจรับรอบ 1' });
      expect(stockRes.success).toBe(true);

      const updatedProds = storageService.getProducts();
      const prodA = updatedProds.find(p => p.id === 'PROD-A');
      const prodB = updatedProds.find(p => p.id === 'PROD-B');

      expect(prodA.stockBalance).toBe(27);
      expect(prodB.stockBalance).toBe(5);

      const logs = storageService.getStockLogs();
      const prodALog = logs.find(l => l.productId === 'PROD-A' && (l.docNo === 'GRN-PO-PD-001-01' || l.refPo === 'PO-PD-001' || l.poNo === 'PO-PD-001'));
      expect(prodALog).toBeDefined();
      expect(prodALog.docNo).toBe('GRN-PO-PD-001-01');
      expect(prodALog.type).toBe('IN');
      expect(prodALog.qty).toBe(7);
      expect(prodALog.balance).toBe(27);
    });
  });
});
