import { describe, it, expect, vi } from 'vitest';
import '../../../tests/setup.js';
import { workflowEngine } from '../workflowEngine';
import { notificationService } from '../notificationService';
import { storageService } from '../storageService.js';

// Mock notificationService and storageService
vi.mock('../notificationService', () => ({
  notificationService: {
    dispatch: vi.fn()
  }
}));

vi.mock('../storageService.js', () => ({
  storageService: {
    getPOs: vi.fn(),
    savePOs: vi.fn(),
    appendActivityLog: vi.fn(),
    appendBudgetTransaction: vi.fn(),
    saveBudgets: vi.fn()
  }
}));

describe('workflowEngine: Claim Resolution', () => {
  it('resolveClaim sets po.status to WAITING_DELIVERY_ROUND_2 when action is REPLACEMENT', async () => {
    const mockUser = { name: 'Test Purchaser', id: 'PUR01' };
    const mockPO = {
      id: 'PO-001',
      poNo: 'PO-2026-001',
      department: 'QC',
      status: 'CLAIM_PENDING',
      claimStatus: 'IN_CLAIM',
      hasDispute: true,
      isInClaim: true,
      storeClaims: {
        'Store A': {
          status: 'PENDING',
          isResolved: false
        }
      },
      items: [
        { name: 'Item 1', orderedQty: 10, receivedQty: 8, damagedQty: 2, actualStoreName: 'Store A', storeKey: 'Store A' }
      ]
    };

    const resolution = {
      type: 'REPLACEMENT',
      storeKey: 'Store A',
      storeName: 'Store A',
      allStoresResolved: true,
      hasPendingDeliveries: true,
      expectedDate: '2026-09-30'
    };

    storageService.getPOs.mockReturnValue([mockPO]);
    const updatedPO = await workflowEngine.resolveClaim(mockPO.id, resolution, mockUser, 'ONLINE');

    expect(updatedPO.status).toBe('WAITING_DELIVERY_ROUND_2');
    expect(updatedPO.claimStatus).toBe('REPLACEMENT_PENDING');
    expect(updatedPO.hasDispute).toBe(false);
    expect(updatedPO.isInClaim).toBe(false);
  });
});
