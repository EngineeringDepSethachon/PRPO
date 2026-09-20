import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import { warehouseService } from '../src/services/warehouseService';
import { storageService } from '../src/services/storageService';
import { workflowEngine } from '../src/services/workflowEngine';
import { 
  workspaceService, 
  isTaskForMe, 
  isInProgressTask, 
  getTaskBadgeLabel 
} from '../src/services/workspaceService';
import OnlineOrderCard, { resolveGRNEvidence } from '../src/views/procurement/OnlineOrderCard';
import { hasUnresolvedClaim } from '../src/views/OnlineTaskView';
import { isPendingClaimOrder } from '../src/services/procurementService';
import { recordGoodsReceipt } from '../src/context/ProcurementContext';
import { AppProvider } from '../src/context/AppContext';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (node) => node
  };
});

describe('Mission-Critical Suite: Claim State Machine, Task Blocker & Evidence Drawer', () => {
  const requesterUser = {
    id: 'USR-REQ-QC',
    name: 'นายสมชาย ผู้ตรวจรับ',
    roleId: 'REQUESTER_QC',
    department: 'QC',
    level: 1
  };

  const onlinePurchaserUser = {
    id: 'USR-BUYER',
    name: 'เจ้าหน้าที่จัดซื้อออนไลน์',
    roleId: 'ONLINE_PURCHASER',
    canOnlinePurchase: true,
    department: 'PURCHASING',
    level: 2
  };

  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
    storageService.resetData();
  });

  describe('1. Backend Logic: warehouseService.submitGRN', () => {
    it('locks PO status to CLAIM_PENDING when items have damagedQty > 0 or shortageQty > 0 and NEVER WAITING_DELIVERY_ROUND_2', async () => {
      const initialPO = {
        id: 'PO-CLAIM-001',
        poNo: 'PO-2026-991',
        status: 'ORDERED',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        items: [
          {
            id: 'ITM-01',
            productId: 'PROD-GAUGE-99',
            name: 'เกจวัดแรงดัน',
            code: 'GAUGE-01',
            orderedQty: 10,
            receivedQty: 0,
            price: 500,
            unit: 'อัน'
          }
        ]
      };
      const initialProduct = {
        id: 'PROD-GAUGE-99',
        code: 'GAUGE-01',
        name: 'เกจวัดแรงดัน',
        stockBalance: 5,
        averageCost: 400,
        totalValue: 2000,
        price: 500,
        unit: 'อัน'
      };

      storageService.savePOs([initialPO]);
      storageService.saveProducts([initialProduct]);
      storageService.saveStockLogs([]);

      const grnPayload = {
        grnNumber: 'GRN-2026-991-01',
        receivingItems: [
          {
            productId: 'PROD-GAUGE-99',
            goodQty: 6,
            damagedQty: 2,
            shortageQty: 2,
            defectNote: 'หน้าปัดแตกร้าว 2 อัน และขาดส่ง 2 อัน'
          }
        ],
        defectNote: 'กล่องบุบเสียหาย หน้าปัดแตกร้าว',
        defectImages: ['https://drive.google.com/file/d/evidence-box-1/view'],
        inspectorName: 'นายสมชาย ผู้ตรวจรับ',
        inspectedAt: '2026-09-18T08:30:00.000Z'
      };

      const res = await warehouseService.submitGRN(initialPO.id, grnPayload, { user: requesterUser });
      expect(res.success).toBe(true);

      const savedPOs = storageService.getPOs();
      const updatedPO = savedPOs.find(p => p.id === initialPO.id);

      // กฎเหล็ก: สถานะต้องเป็น CLAIM_PENDING เท่านั้น! ห้ามเป็น WAITING_DELIVERY_ROUND_2
      expect(updatedPO.status).toBe('CLAIM_PENDING');
      expect(updatedPO.claimStatus).toBe('PENDING_CLAIM');
      expect(updatedPO.hasDispute).toBe(true);
      expect(updatedPO.isInClaim).toBe(true);

      // ตรวจสอบสต็อกของดี 6 ชิ้นเข้าคลัง และคำนวณ MAC ตามปกติ
      const savedProducts = storageService.getProducts();
      const updatedProd = savedProducts.find(p => p.id === 'PROD-GAUGE-99');
      expect(updatedProd.stockBalance).toBe(11); // 5 + 6
      // MAC: (5 * 400 + 6 * 500) / 11 = 5000 / 11 = 454.55
      expect(updatedProd.averageCost).toBe(454.55);

      // ตรวจสอบการบันทึกหลักฐาน (Evidence Persistence) ลงใน claimEvidence และ disputeInfo
      expect(updatedPO.claimEvidence).toBeDefined();
      expect(updatedPO.claimEvidence.inspectorName).toBe('นายสมชาย ผู้ตรวจรับ');
      expect(updatedPO.claimEvidence.inspectedAt).toBe('2026-09-18T08:30:00.000Z');
      expect(updatedPO.claimEvidence.defectNote).toContain('กล่องบุบเสียหาย');
      expect(updatedPO.claimEvidence.defectImages).toHaveLength(1);

      expect(updatedPO.disputeInfo).toBeDefined();
      expect(updatedPO.disputeInfo.inspectorName).toBe('นายสมชาย ผู้ตรวจรับ');
      expect(updatedPO.disputeInfo.defectNote).toContain('กล่องบุบเสียหาย');
    });
  });

  describe('2. Workspace Task Routing: workspaceService', () => {
    const claimPendingPO = {
      id: 'PO-CLAIM-002',
      poNo: 'PO-2026-992',
      docType: 'PO',
      status: 'CLAIM_PENDING',
      purchaseChannel: 'ONLINE',
      department: 'QC',
      requestedBy: 'นายสมชาย ผู้ตรวจรับ',
      hasUnresolvedClaim: true,
      items: [{ name: 'สินค้าติดเคลม', orderedQty: 5, receivedQty: 3, damagedQty: 2 }]
    };

    it('blocks Requester from seeing CLAIM_PENDING in To Do tab', () => {
      const isTodo = isTaskForMe(claimPendingPO, requesterUser);
      expect(isTodo).toBe(false);
    });

    it('routes CLAIM_PENDING to In Progress tab for Requester with badge "⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า"', () => {
      const isInProg = isInProgressTask(claimPendingPO, requesterUser);
      expect(isInProg).toBe(true);

      const badgeLabel = getTaskBadgeLabel(claimPendingPO, requesterUser);
      expect(badgeLabel).toBe('⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า');
    });

    it('routes WAITING_DELIVERY_ROUND_2 to To Do tab for Requester immediately', () => {
      const round2PO = {
        ...claimPendingPO,
        status: 'WAITING_DELIVERY_ROUND_2',
        hasUnresolvedClaim: false
      };

      const isTodo = isTaskForMe(round2PO, requesterUser);
      expect(isTodo).toBe(true);

      const isInProg = isInProgressTask(round2PO, requesterUser);
      expect(isInProg).toBe(false);

      const badgeLabel = getTaskBadgeLabel(round2PO, requesterUser);
      expect(badgeLabel).toBe('รอร้านค้าส่งของรอบที่ 2 (ทดแทน)');
    });
  });

  describe('3. State Transitions in Online Procurement Hub', () => {
    it('sets PO status to WAITING_DELIVERY_ROUND_2 when Online Purchaser chooses Replacement', async () => {
      const po = {
        id: 'PO-ONLINE-REP',
        poNo: 'PO-2026-REP',
        status: 'CLAIM_PENDING',
        claimStatus: 'PENDING_CLAIM',
        department: 'QC',
        purchaseChannel: 'ONLINE',
        items: [
          {
            id: 'ITM-REP-1',
            name: 'หัวแร้งไฟฟ้า',
            orderedQty: 5,
            receivedQty: 3,
            damagedQty: 2,
            price: 250,
            storeName: 'ToolsOfficial'
          }
        ]
      };

      storageService.savePOs([po]);

      const updated = await workflowEngine.resolveClaim(
        po.id,
        {
          storeKey: 'Shopee_toolsofficial',
          type: 'REPLACEMENT',
          newTrackingNo: 'TH-REPLACE-888',
          allStoresResolved: true,
          hasPendingDeliveries: true,
          note: 'ร้านค้ายินยอมส่งตัวใหม่มาทดแทน'
        },
        onlinePurchaserUser
      );

      expect(updated.status).toBe('WAITING_DELIVERY_ROUND_2');
      expect(updated.claimStatus).toBe('REPLACEMENT_PENDING');
      expect(updated.hasDispute).toBe(false);
      expect(updated.isInClaim).toBe(false);
    });

    it('sets PO status to COMPLETED and restores budget when Online Purchaser chooses Refund', async () => {
      const po = {
        id: 'PO-ONLINE-REF',
        poNo: 'PO-2026-REF',
        status: 'CLAIM_PENDING',
        claimStatus: 'PENDING_CLAIM',
        department: 'QC',
        purchaseChannel: 'ONLINE',
        items: [
          {
            id: 'ITM-REF-1',
            name: 'มอเตอร์ปั๊มน้ำ',
            orderedQty: 2,
            receivedQty: 1,
            damagedQty: 1,
            price: 1200,
            storeName: 'MotorShop'
          }
        ]
      };

      storageService.savePOs([po]);

      const updated = await workflowEngine.resolveClaim(
        po.id,
        {
          storeKey: 'Shopee_motorshop',
          type: 'REFUND',
          refundAmount: 1200,
          allStoresResolved: true,
          hasPendingDeliveries: false,
          note: 'ร้านค้าคืนเงินเต็มจำนวนเข้า ShopeePay'
        },
        onlinePurchaserUser
      );

      expect(updated.status).toBe('COMPLETED');
      expect(updated.claimStatus).toBe('RESOLVED');
      expect(updated.hasDispute).toBe(false);
      expect(updated.isInClaim).toBe(false);
    });
  });

  describe('4. Evidence Drawer & Lightbox in OnlineOrderCard', () => {
    it('resolveGRNEvidence extracts inspectorName, inspectedAt, defectNote, and images', () => {
      const mockPO = {
        id: 'PO-EV-001',
        poNo: 'PO-2026-EV1',
        claimEvidence: {
          inspectorName: 'น.ส. วิภาดา ผู้ตรวจสอบ',
          inspectedAt: '2026-09-18T10:15:00.000Z',
          defectNote: 'สินค้าแตกหักจากการขนส่ง สภาพกล่องเปียกน้ำ',
          defectImages: [
            'https://drive.google.com/file/d/box_photo_1/view',
            'https://drive.google.com/file/d/broken_part_1/view'
          ]
        }
      };

      const evidence = resolveGRNEvidence(mockPO);
      expect(evidence).toBeDefined();
      expect(evidence.inspectorName).toBe('น.ส. วิภาดา ผู้ตรวจสอบ');
      expect(evidence.inspectedAt).not.toBe('-');
      expect(evidence.defectNote).toContain('สินค้าแตกหักจากการขนส่ง');
      expect(evidence.images).toHaveLength(2);
      expect(evidence.images[0].url).toContain('box_photo_1');
    });

    it('renders GRN Evidence Panel in OnlineOrderCard with inspector info, defect note, and image thumbnails', () => {
      const mockPO = {
        id: 'PO-CARD-EV',
        poNo: 'PO-2026-CEV',
        status: 'CLAIM_PENDING',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        platform: 'Shopee',
        actualStoreName: 'TechStore',
        items: [
          {
            id: 'ITM-CEV-1',
            name: 'เซ็นเซอร์วัดอุณหภูมิ',
            orderedQty: 10,
            receivedQty: 7,
            damagedQty: 3,
            actualPrice: 350,
            storeName: 'TechStore'
          }
        ],
        claimEvidence: {
          inspectorName: 'นายประสิทธิ์ ตรวจรับ',
          inspectedAt: '2026-09-18T11:00:00.000Z',
          defectNote: 'หัวเซ็นเซอร์หัก 3 ตัว ไม่สามารถใช้งานได้',
          defectImages: ['https://drive.google.com/file/d/sensor_broken_img/view']
        }
      };

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard 
              po={mockPO} 
              activeTab="CLAIM" 
              currentRole={onlinePurchaserUser} 
            />
          </AppProvider>
        </MemoryRouter>
      );

      // ตรวจสอบว่ามีกล่องหลักฐานจากหน้างาน (GRN Evidence Panel)
      expect(html).toContain('หลักฐานการตรวจรับ (GRN Evidence)');
      expect(html).toContain('รายงานจาก:');
      expect(html).toContain('นายประสิทธิ์ ตรวจรับ');
      expect(html).toContain('หัวเซ็นเซอร์หัก 3 ตัว ไม่สามารถใช้งานได้');
      expect(html).toContain('sensor_broken_img');
    });
  });

  describe('4. Cyclical Multi-Round Claim & Goods Receipt (Arbitrary N Rounds)', () => {
    it('Round 2: when replacement goods arrive damaged and receiver files claim, PO cycles back to CLAIM_PENDING and does NOT jump to COMPLETED', async () => {
      // Mock PO after Round 1 negotiation where purchaser selected REPLACEMENT
      const poAfterRound1 = {
        id: 'PO-CYCLE-001',
        poNo: 'PO-2026-CYCLE-01',
        docType: 'PO',
        status: 'WAITING_DELIVERY_ROUND_2',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        requestedBy: 'นายสมชาย ผู้ตรวจรับ',
        requesterId: 'USR-REQ-QC',
        platform: 'Shopee',
        actualStoreName: 'TechStore',
        hasGRN: true,
        grnHistory: [
          {
            grnNumber: 'GRN-2026-CYCLE-01-R1',
            round: 1,
            date: '18/09/2026 10:00:00',
            receivedBy: 'นายสมชาย ผู้ตรวจรับ',
            statusAfterRound: 'PARTIALLY_RECEIVED_IN_CLAIM'
          }
        ],
        storeClaims: {
          'Shopee_techstore': {
            storeKey: 'Shopee_techstore',
            storeName: 'TechStore',
            type: 'REPLACEMENT',
            actionType: 'REPLACEMENT',
            isResolved: true,
            status: 'RESOLVED'
          }
        },
        items: [
          {
            id: 'ITM-CYCLE-1',
            productId: 'PROD-C1',
            code: 'C1',
            name: 'จอแสดงผลดิจิทัล',
            orderedQty: 10,
            receivedQty: 9,
            accumulatedReceived: 9,
            damagedQty: 1,
            shortageQty: 0,
            unitPrice: 1000,
            storeName: 'TechStore',
            storePlatform: 'Shopee',
            claimResolution: 'REPLACEMENT',
            replacementPendingQty: 1,
            isSettled: false,
            hasDispute: false
          }
        ]
      };

      storageService.savePOs([poAfterRound1]);

      // Receiver inspects replacement in Round 2: receives 0 good, 1 damaged -> submits GRN with CLAIM_PENDING
      const grnPayloadRound2 = {
        grnNumber: 'GRN-2026-CYCLE-01-R2',
        round: 2,
        receivedDate: '19/09/2026 14:00:00',
        receivedBy: 'นายสมชาย ผู้ตรวจรับ',
        statusOverride: 'CLAIM_PENDING',
        claimEvidence: {
          inspectorName: 'นายสมชาย ผู้ตรวจรับ',
          inspectedAt: '2026-09-19T14:00:00.000Z',
          notes: 'สินค้าทดแทนรอบ 2 แตกหักเสียหายเหมือนเดิม',
          attachments: ['https://drive.google.com/file/d/damaged-r2-img/view']
        },
        receivingItems: [
          {
            productId: 'PROD-C1',
            acceptedQty: 0,
            goodQty: 0,
            damagedQty: 1,
            shortageQty: 0,
            defectReason: 'สินค้าทดแทนรอบ 2 แตกหักเสียหายเหมือนเดิม'
          }
        ]
      };

      const result = await recordGoodsReceipt('PO-CYCLE-001', grnPayloadRound2);
      expect(result.success).toBe(true);

      const updatedPO = result.po;
      // 1. PO Status must cycle to CLAIM_PENDING / PARTIALLY_RECEIVED_IN_CLAIM, NEVER COMPLETED!
      expect(updatedPO.status).not.toBe('COMPLETED');
      expect(updatedPO.status).toBe('CLAIM_PENDING');
      expect(updatedPO.claimStatus).toBe('PENDING_CLAIM');
      expect(updatedPO.hasUnresolvedClaim).toBe(true);
      expect(updatedPO.hasDispute).toBe(true);
      expect(updatedPO.isCompleted).toBe(false);

      // 2. Disputed item state must reset claimResolution and isSettled
      const disputedItem = updatedPO.items[0];
      expect(disputedItem.claimResolution).toBeNull();
      expect(disputedItem.isSettled).toBe(false);
      expect(disputedItem.replacementPendingQty).toBe(0);

      // 3. Online Task View guards
      expect(hasUnresolvedClaim(updatedPO)).toBe(true);
      expect(isPendingClaimOrder(updatedPO)).toBe(true);

      // 4. Workspace View Task routing
      // Requester: Must NOT see in To Do, must see in In Progress!
      expect(isTaskForMe(updatedPO, requesterUser)).toBe(false);
      expect(isInProgressTask(updatedPO, requesterUser)).toBe(true);
      expect(getTaskBadgeLabel(updatedPO, requesterUser)).toBe('⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า');

      // Online Purchaser: Must see in To Do to negotiate Round 2 claim!
      expect(isTaskForMe(updatedPO, onlinePurchaserUser)).toBe(true);
      expect(getTaskBadgeLabel(updatedPO, onlinePurchaserUser)).toBe('🔴 รอเจรจาเคลมร้านค้า');

      // 5. OnlineOrderCard UI Rendering: Must NOT show "✓ ปิดงานสำเร็จ 100%"
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider>
            <OnlineOrderCard 
              po={updatedPO} 
              activeTab="CLAIM" 
              currentRole={onlinePurchaserUser} 
            />
          </AppProvider>
        </MemoryRouter>
      );
      expect(html).not.toContain('✓ ปิดงานสำเร็จ 100%');
      expect(html).toContain('รอเคลม');
    });

    it('Arbitrary Round N: supports N rounds of claiming and re-receiving cyclically without hardcoded round limits', async () => {
      // Simulate Round N-1 PO with grnHistory of 5 rounds
      const roundNPo = {
        id: 'PO-CYCLE-ROUND-N',
        poNo: 'PO-2026-CYCLE-N',
        docType: 'PO',
        status: 'WAITING_DELIVERY_ROUND_2',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        requestedBy: 'นายสมชาย ผู้ตรวจรับ',
        requesterId: 'USR-REQ-QC',
        platform: 'Shopee',
        actualStoreName: 'TechStore',
        hasGRN: true,
        grnHistory: [
          { round: 1, grnNumber: 'GRN-R1' },
          { round: 2, grnNumber: 'GRN-R2' },
          { round: 3, grnNumber: 'GRN-R3' },
          { round: 4, grnNumber: 'GRN-R4' }
        ],
        storeClaims: {
          'Shopee_techstore': {
            type: 'REPLACEMENT',
            isResolved: true,
            status: 'RESOLVED'
          }
        },
        items: [
          {
            id: 'ITM-N',
            productId: 'PROD-N',
            orderedQty: 5,
            receivedQty: 4,
            accumulatedReceived: 4,
            damagedQty: 1,
            unitPrice: 200,
            storeName: 'TechStore',
            storePlatform: 'Shopee',
            claimResolution: 'REPLACEMENT',
            isSettled: false
          }
        ]
      };

      storageService.savePOs([roundNPo]);

      // In round 5, item is damaged again
      const grnPayloadRound5 = {
        grnNumber: 'GRN-R5',
        round: 5,
        receivedDate: '20/09/2026 10:00:00',
        receivedBy: 'นายสมชาย ผู้ตรวจรับ',
        statusOverride: 'CLAIM_PENDING',
        receivingItems: [
          {
            productId: 'PROD-N',
            acceptedQty: 0,
            goodQty: 0,
            damagedQty: 1,
            shortageQty: 0,
            defectReason: 'สินค้าเสียหายรอบที่ 5'
          }
        ]
      };

      const res = await recordGoodsReceipt('PO-CYCLE-ROUND-N', grnPayloadRound5);
      expect(res.po.status).toBe('CLAIM_PENDING');
      expect(res.po.hasUnresolvedClaim).toBe(true);
      expect(hasUnresolvedClaim(res.po)).toBe(true);
      expect(isInProgressTask(res.po, requesterUser)).toBe(true);
      expect(isTaskForMe(res.po, requesterUser)).toBe(false);
      expect(isTaskForMe(res.po, onlinePurchaserUser)).toBe(true);
    });
  });
});
