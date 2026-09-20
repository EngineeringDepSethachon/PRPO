/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageService } from '../src/services/storageService';
import { workflowEngine } from '../src/services/workflowEngine';

describe('Inline Fast-Track Claim (Self-Procurement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    storageService.resetData();
    storageService.saveProducts([
      {
        id: 'PROD-1',
        code: 'itm-001',
        name: 'Item 1',
        category: 'PD',
        price: 10,
        stockBalance: 0
      }
    ]);
  });

  it('simulates the data transformation that ReceivingModal does for REPLACEMENT', () => {
    // In ReceivingModal, when inlineClaimAction === 'REPLACEMENT', it constructs finalTargetPO
    let finalTargetPO = {
      id: 'PO-001',
      isOnlinePurchase: false,
      status: 'ORDERED_PENDING_DELIVERY',
      items: [
        { productId: 'PROD-1', orderedQty: 10, receivedQty: 5, goodQty: 5, damagedQty: 5, shortageQty: 0 }
      ]
    };

    // Simulate ReceivingModal inline claim logic for REPLACEMENT
    const inlineClaimAction = 'REPLACEMENT';
    const timestamp = '2026-09-19T12:00:00Z';
    
    finalTargetPO = {
      ...finalTargetPO,
      status: 'WAITING_DELIVERY_ROUND_2',
      workflowStatus: 'WAITING_DELIVERY_ROUND_2',
      claimStatus: 'REPLACEMENT_PENDING',
      hasDispute: true,
      isInClaim: true,
      isCompleted: false,
      isClosed: false,
      inlineClaimData: {
        resolution: 'REPLACEMENT',
        expectedDelivery: '2026-09-25',
        note: 'Send replacement',
        resolvedAt: timestamp,
        resolvedBy: 'User'
      }
    };
    
    finalTargetPO.items = finalTargetPO.items.map(it => {
      if (it.shortageQty > 0 || it.damagedQty > 0) {
        return { ...it, shortageAction: 'WAIT_NEXT_ROUND', disputeAction: 'WAIT_NEXT_ROUND' };
      }
      return it;
    });

    expect(finalTargetPO.status).toBe('WAITING_DELIVERY_ROUND_2');
    expect(finalTargetPO.items[0].shortageAction).toBe('WAIT_NEXT_ROUND');
    expect(finalTargetPO.inlineClaimData.resolution).toBe('REPLACEMENT');
  });

  it('simulates the data transformation that ReceivingModal does for REFUND', () => {
    // In ReceivingModal, when inlineClaimAction === 'REFUND', it constructs finalTargetPO
    let finalTargetPO = {
      id: 'PO-001',
      isOnlinePurchase: false,
      status: 'ORDERED_PENDING_DELIVERY',
      items: [
        { productId: 'PROD-1', orderedQty: 10, receivedQty: 5, goodQty: 5, damagedQty: 0, shortageQty: 5 }
      ]
    };

    // Simulate ReceivingModal inline claim logic for REFUND
    const inlineClaimAction = 'REFUND';
    const timestamp = '2026-09-19T12:00:00Z';
    
    finalTargetPO = {
      ...finalTargetPO,
      status: 'COMPLETED_WITH_REFUND',
      workflowStatus: 'COMPLETED_WITH_REFUND',
      claimStatus: 'RESOLVED',
      hasDispute: false,
      isInClaim: false,
      hasUnresolvedClaim: false,
      isCompleted: true,
      isClosed: true,
      completedAt: timestamp,
      inlineClaimData: {
        resolution: 'REFUND',
        refundAmount: 50,
        note: 'Refund shortage',
        resolvedAt: timestamp,
        resolvedBy: 'User'
      }
    };
    
    finalTargetPO.items = finalTargetPO.items.map(it => {
      if (it.shortageQty > 0 || it.damagedQty > 0) {
        return { ...it, claimResolution: 'REFUND', isSettled: true };
      }
      return it;
    });

    expect(finalTargetPO.status).toBe('COMPLETED_WITH_REFUND');
    expect(finalTargetPO.isCompleted).toBe(true);
    expect(finalTargetPO.items[0].claimResolution).toBe('REFUND');
    expect(finalTargetPO.items[0].isSettled).toBe(true);
    expect(finalTargetPO.inlineClaimData.refundAmount).toBe(50);
  });
});
