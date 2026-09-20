import { describe, it, expect, beforeEach } from 'vitest';
import '../../../tests/setup.js';
import { warehouseService } from '../warehouseService';
import { storageService } from '../storageService';

describe('warehouseService: Shortage Leakage Prevention & Claim Locking', () => {
  beforeEach(() => {
    storageService.savePOs([]);
    storageService.saveProducts([]);
    storageService.saveStockLogs([]);
  });

  // Case A (Pure Shortage): ordered: 12, good: 10, damaged: 0, shortage: 2 -> ต้องได้สถานะ CLAIM_PENDING เท่านั้น (ห้ามเป็น WAITING_DELIVERY_ROUND_2)
  it('Case A (Pure Shortage): ordered: 12, good: 10, damaged: 0, shortage: 2 -> locks PO to CLAIM_PENDING and never WAITING_DELIVERY_ROUND_2', async () => {
    const testPO = {
      id: 'PO-SHORTAGE-001',
      poNo: 'PO-2026-SHORTAGE-01',
      status: 'ORDERED',
      purchaseChannel: 'ONLINE',
      department: 'QC',
      items: [
        {
          id: 'ITM-SHORTAGE-1',
          productId: 'PROD-SHORTAGE-1',
          code: 'CODE-S1',
          name: 'สินค้าตัวอย่างทดสอบขาดส่ง',
          orderedQty: 12,
          receivedQty: 0,
          unitPrice: 100,
          unit: 'ชิ้น'
        }
      ]
    };

    const testProd = {
      id: 'PROD-SHORTAGE-1',
      code: 'CODE-S1',
      name: 'สินค้าตัวอย่างทดสอบขาดส่ง',
      stockBalance: 0,
      averageCost: 100,
      totalValue: 0,
      price: 100,
      unit: 'ชิ้น'
    };

    storageService.savePOs([testPO]);
    storageService.saveProducts([testProd]);

    const grnPayload = {
      grnNumber: 'GRN-2026-SHORTAGE-01',
      receivingItems: [
        {
          productId: 'PROD-SHORTAGE-1',
          goodQty: 10,
          damagedQty: 0,
          shortageQty: 2,
          shortageReason: 'SPLIT_SHIPMENT',
          shortageAction: 'WAIT_NEXT_ROUND'
        }
      ],
      inspectorName: 'เจ้าหน้าที่ตรวจรับ',
      receivedDate: '2026-09-19T09:00:00.000Z'
    };

    const res = await warehouseService.submitGRN(testPO.id, grnPayload);
    expect(res.success).toBe(true);

    const pos = storageService.getPOs();
    const updatedPO = pos.find(p => p.id === testPO.id);

    // กฎเหล็ก: ของขาดส่งล้วน ๆ (damaged=0, shortage=2) ต้องได้ CLAIM_PENDING เท่านั้น ห้ามเป็น WAITING_DELIVERY_ROUND_2 เด็ดขาด!
    expect(updatedPO.status).toBe('CLAIM_PENDING');
    expect(updatedPO.status).not.toBe('WAITING_DELIVERY_ROUND_2');
    expect(updatedPO.claimStatus).toBe('PENDING_CLAIM');
    expect(updatedPO.hasDispute).toBe(true);
    expect(updatedPO.isInClaim).toBe(true);

    // ตรวจสอบ item data
    const item = updatedPO.items[0];
    expect(item.receivedQty).toBe(10);
    expect(item.damagedQty).toBe(0);
    expect(item.shortageQty).toBe(2);
    expect(item.hasDispute).toBe(true);

    // ตรวจสอบว่าเฉพาะของดี 10 ชิ้นเท่านั้นที่เข้าคลัง
    const products = storageService.getProducts();
    const prod = products.find(p => p.id === 'PROD-SHORTAGE-1');
    expect(prod.stockBalance).toBe(10);
  });

  // Case B (Multi-Round Incremental Stock): ตรวจรับรอบ 1 ได้ 8/12 → stock +8
  // ตรวจรับรอบ 2 ได้ 4/4 (ค้างรับ) → stock ต้องเป็น +12 รวม (ไม่ใช่ +4 สองรอบทับกัน)
  it('Case B (Multi-Round): round1 receives 8, round2 receives 4 → total stock = 12, each round adds independently', async () => {
    const testPO = {
      id: 'PO-MULTI-001',
      poNo: 'PO-2026-MULTI-01',
      status: 'PARTIAL',
      purchaseChannel: 'ONLINE',
      department: 'PD',
      grnHistory: [{ grnNumber: 'GRN-MULTI-01-01', round: 1, date: '2026-09-01', receivedBy: 'Staff' }],
      items: [
        {
          id: 'ITM-MULTI-1',
          productId: 'PROD-MULTI-1',
          code: 'CODE-M1',
          name: 'สินค้าทดสอบหลายรอบ',
          orderedQty: 12,
          receivedQty: 8,        // รับมาแล้ว 8 ในรอบก่อน
          accumulatedReceived: 8,
          unitPrice: 50,
          unit: 'ชิ้น'
        }
      ]
    };

    const testProd = {
      id: 'PROD-MULTI-1',
      code: 'CODE-M1',
      name: 'สินค้าทดสอบหลายรอบ',
      stockBalance: 8, // มีในคลัง 8 ชิ้นแล้วจากรอบก่อน
      averageCost: 50,
      totalValue: 400,
      price: 50,
      unit: 'ชิ้น'
    };

    storageService.savePOs([testPO]);
    storageService.saveProducts([testProd]);

    // รอบ 2: รับ 4 ชิ้นที่ค้างอยู่
    const grnPayloadRound2 = {
      grnNumber: 'GRN-MULTI-01-02',
      round: 2,
      receivingItems: [
        {
          productId: 'PROD-MULTI-1',
          goodQty: 4,   // รับรอบนี้ 4 ชิ้น
          damagedQty: 0,
          shortageQty: 0
        }
      ],
      inspectorName: 'เจ้าหน้าที่ตรวจรับ',
      receivedDate: '2026-09-19T10:00:00.000Z'
    };

    const res = await warehouseService.submitGRN(testPO.id, grnPayloadRound2);
    expect(res.success).toBe(true);

    const products = storageService.getProducts();
    const prod = products.find(p => p.id === 'PROD-MULTI-1');

    // กฎเหล็ก: รอบ 2 ต้องบวกเฉพาะ 4 ชิ้นที่รับรอบนี้ → stockBalance ต้องเป็น 8 + 4 = 12
    expect(prod.stockBalance).toBe(12);

    const pos = storageService.getPOs();
    const updatedPO = pos.find(p => p.id === testPO.id);
    // PO ต้องปิดสมบูรณ์เพราะรับครบแล้ว
    expect(updatedPO.status).toBe('COMPLETED');
    // item ต้องมี receivedQty = 12 (สะสม)
    const item = updatedPO.items[0];
    expect(item.receivedQty).toBe(12);
    expect(item.shortageQty).toBe(0);
  });

  // Case C (Over-Receive Guard): goodQty ต้องถูก clamp เมื่อเกิน allowedReceiveQty
  it('Case C (Over-Receive Clamp): submitting goodQty=15 when only 4 remain → stock gets +4, not +15', async () => {
    const testPO = {
      id: 'PO-OVERRECEIVE-001',
      poNo: 'PO-2026-OVER-01',
      status: 'PARTIAL',
      purchaseChannel: 'ONLINE',
      department: 'QC',
      items: [
        {
          id: 'ITM-OVER-1',
          productId: 'PROD-OVER-1',
          code: 'CODE-O1',
          name: 'สินค้าทดสอบรับเกิน',
          orderedQty: 10,
          receivedQty: 6,   // รับมาแล้ว 6 → ค้างรับ 4
          accumulatedReceived: 6,
          unitPrice: 100,
          unit: 'ชิ้น'
        }
      ]
    };

    const testProd = {
      id: 'PROD-OVER-1',
      code: 'CODE-O1',
      name: 'สินค้าทดสอบรับเกิน',
      stockBalance: 6,
      averageCost: 100,
      totalValue: 600,
      price: 100,
      unit: 'ชิ้น'
    };

    storageService.savePOs([testPO]);
    storageService.saveProducts([testProd]);

    // ส่ง goodQty=15 ทั้งที่ค้างรับแค่ 4
    const grnPayload = {
      grnNumber: 'GRN-OVER-01',
      receivingItems: [
        {
          productId: 'PROD-OVER-1',
          goodQty: 15,  // ตั้งใจส่งเกิน — ต้องถูก clamp!
          damagedQty: 0
        }
      ],
      receivedDate: '2026-09-19T11:00:00.000Z'
    };

    const res = await warehouseService.submitGRN(testPO.id, grnPayload);
    expect(res.success).toBe(true);

    const products = storageService.getProducts();
    const prod = products.find(p => p.id === 'PROD-OVER-1');

    // กฎเหล็ก: ระบบต้อง clamp goodQty เหลือแค่ 4 (ค้างรับจริง) → stockBalance = 6 + 4 = 10
    expect(prod.stockBalance).toBe(10);
    // ไม่ใช่ 6 + 15 = 21!
    expect(prod.stockBalance).not.toBe(21);
  });

  // Case D (WAITING_DELIVERY_ROUND_2 Guard): สถานะนี้ต้องไม่เกิดจาก GRN path ไม่ว่าจะ set อะไรใน payload
  it('Case D (WAITING_DELIVERY_ROUND_2 Guard): GRN path must never produce WAITING_DELIVERY_ROUND_2 status', async () => {
    const testPO = {
      id: 'PO-ROUND2-GUARD-001',
      poNo: 'PO-2026-GUARD-01',
      status: 'ORDERED',
      purchaseChannel: 'ONLINE',
      department: 'QC',
      items: [
        {
          id: 'ITM-GUARD-1',
          productId: 'PROD-GUARD-1',
          code: 'CODE-G1',
          name: 'สินค้าทดสอบ guard',
          orderedQty: 10,
          receivedQty: 0,
          unitPrice: 50,
          unit: 'ชิ้น'
        }
      ]
    };

    storageService.savePOs([testPO]);
    storageService.saveProducts([]);

    // ลองส่ง shortageAction=WAIT_NEXT_ROUND + waitingRound2=true ใน payload
    const grnPayload = {
      grnNumber: 'GRN-GUARD-01',
      waitingRound2: true,  // ห้ามทำให้เกิด WAITING_DELIVERY_ROUND_2!
      receivingItems: [
        {
          productId: 'PROD-GUARD-1',
          goodQty: 8,
          damagedQty: 0,
          shortageQty: 2,
          shortageAction: 'WAIT_NEXT_ROUND',  // ห้ามทำให้เกิด WAITING_DELIVERY_ROUND_2!
          shortageReason: 'SPLIT_SHIPMENT'
        }
      ],
      receivedDate: '2026-09-19T12:00:00.000Z'
    };

    const res = await warehouseService.submitGRN(testPO.id, grnPayload);
    expect(res.success).toBe(true);

    const pos = storageService.getPOs();
    const updatedPO = pos.find(p => p.id === testPO.id);

    // กฎเหล็ก: ไม่ว่าจะส่ง waitingRound2 หรือ WAIT_NEXT_ROUND มาใน GRN payload
    // warehouseService.submitGRN ต้องไม่ set WAITING_DELIVERY_ROUND_2 เด็ดขาด!
    // สถานะนี้เกิดได้ที่เดียวคือ Online Purchaser กด 'ส่งสินค้าทดแทน' ใน Online Hub
    expect(updatedPO.status).not.toBe('WAITING_DELIVERY_ROUND_2');
    // Online PO ที่มีของขาดส่ง → ต้องได้ CLAIM_PENDING
    expect(updatedPO.status).toBe('CLAIM_PENDING');
  });
});
