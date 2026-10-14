import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';
import { apiService } from '../src/services/apiService';
import { budgetService } from '../src/services/budgetService';
import { storageService } from '../src/services/storageService';
import { modalService } from '../src/services/modalService';
import { cfBackground } from '../src/services/cfGuard';

const ADMIN = { id: 'USR-ADMIN', name: 'Admin', role: 'ADMIN', roleId: 'ADMIN', title: 'Admin', level: 99 };

const httpFail = (status) => vi.fn().mockResolvedValue({
  ok: false,
  status,
  json: async () => ({ error: `server said ${status}` })
});
const networkFail = () => vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

const seedPR = (over = {}) => {
  const pr = {
    id: 'PR-CF-001',
    prNo: 'PD001/2026',
    department: 'PD',
    status: 'SUBMITTED',
    totalAmount: 1000,
    items: [{ id: 'PRI-1', name: 'Item 1', qty: 2, price: 500 }],
    ...over
  };
  storageService.savePR(pr);
  return pr;
};

const seedPO = () => {
  const po = {
    id: 'PO-CF-001',
    poNo: 'PO-PD-2026-001',
    prId: 'PR-CF-001',
    department: 'PD',
    status: 'OPEN',
    items: [{ productId: 'PROD-CF-1', name: 'Item', qty: 2, purchaseQty: 2, orderedQty: 2, price: 10 }]
  };
  storageService.savePOs([po]);
  return po;
};

const seedProducts = () => {
  storageService.saveProducts([
    { id: 'PROD-CF-1', code: 'CF1', name: 'สินค้าทดสอบ', department: 'PD', category: 'PD', stockBalance: 20, stockUnit: 'ชิ้น', unit: 'ชิ้น', price: 10, status: 'ACTIVE', isActive: true }
  ]);
};

describe('T3.6 cloudflare mode: no silent fallback / no swallowed API errors', () => {
  let originalFetch;
  let errorSpy;

  beforeEach(() => {
    originalFetch = global.fetch;
    storageService.resetData();
    localStorage.clear();
    storageService.saveBudgets({ PD: { monthlyBudget: 1000, spent: 0, pending: 0, variance: 1000, history: { '2026-10': 1000 }, historicalSpent: {} } });
    storageService.saveBudgetTransactions([]);
    modalService._lastErrorAt = 0;
    modalService._lastErrorAuto = false;
    errorSpy = vi.spyOn(modalService, 'alert').mockImplementation(() => Promise.resolve(true));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('cloudflare mode: core writes throw and leave local state untouched', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    });

    it('1. createPR: 409 from API -> throws, no PR committed locally', async () => {
      global.fetch = httpFail(409);
      const before = storageService.getPRs().length;
      await expect(
        apiService.createPR({ department: 'PD', items: [{ id: 'I1', name: 'x', qty: 1, price: 10 }] }, ADMIN)
      ).rejects.toThrow(/server said 409/);
      expect(storageService.getPRs().length).toBe(before);
      await new Promise(r => setTimeout(r, 10));
      expect(errorSpy).toHaveBeenCalledTimes(1); // safety-net modal for a caller that shows nothing
    });

    it('1b. caller that shows its own error (UI catch) -> exactly one modal per action', async () => {
      global.fetch = httpFail(500);
      seedProducts();
      try {
        await apiService.saveProduct({ code: 'NEW1', name: 'ใหม่', category: 'PD', department: 'PD', price: 5, stockUnit: 'ชิ้น' });
      } catch (err) {
        modalService.error('เกิดข้อผิดพลาด', err.message); // what the existing UI catch does
      }
      await new Promise(r => setTimeout(r, 10));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0].message).toMatch(/server said 500/);
    });

    it('2b. failed action rolls back and asks the app to reload from the server', async () => {
      const { setCfReloadHandler } = await import('../src/services/cfGuard');
      const reload = vi.fn();
      const off = setCfReloadHandler(reload);
      global.fetch = httpFail(500);
      seedProducts();
      await expect(apiService.deleteProduct('PROD-CF-1')).rejects.toThrow();
      off();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('2. updatePRStatus: PUT /api/prs/:id 500 -> throws, PR status unchanged', async () => {
      seedPR();
      global.fetch = httpFail(500);
      await expect(apiService.updatePRStatus('PR-CF-001', 'REVIEWED', ADMIN, 'ok')).rejects.toThrow();
      expect(storageService.getPRs().find(p => p.id === 'PR-CF-001').status).toBe('SUBMITTED');
    });

    it('3. cancelPR: network failure -> throws, PR not cancelled locally', async () => {
      seedPR();
      global.fetch = networkFail();
      await expect(apiService.cancelPR('PR-CF-001', ADMIN, 'เหตุผล')).rejects.toThrow();
      expect(storageService.getPRs().find(p => p.id === 'PR-CF-001').status).toBe('SUBMITTED');
    });

    it('4. saveProduct: 500 -> throws, product list unchanged', async () => {
      seedProducts();
      global.fetch = httpFail(500);
      await expect(
        apiService.saveProduct({ code: 'NEW1', name: 'ใหม่', category: 'PD', department: 'PD', price: 5, stockUnit: 'ชิ้น' })
      ).rejects.toThrow(/server said 500/);
      expect(storageService.getProducts().map(p => p.id)).toEqual(['PROD-CF-1']);
    });

    it('5. saveVendor: network failure -> throws, vendor list unchanged', async () => {
      storageService.saveVendors([]);
      global.fetch = networkFail();
      await expect(
        apiService.saveVendor({ code: 'V-1', name: 'ร้านทดสอบ', department: 'PD' })
      ).rejects.toThrow();
      expect(storageService.getVendors().length).toBe(0);
    });

    it('6. deleteProduct: 500 -> throws, product still present', async () => {
      seedProducts();
      global.fetch = httpFail(500);
      await expect(apiService.deleteProduct('PROD-CF-1')).rejects.toThrow(/server said 500/);
      expect(storageService.getProducts().some(p => p.id === 'PROD-CF-1')).toBe(true);
    });

    it('7. issueStock: 500 -> throws, stock balance not decremented', async () => {
      seedProducts();
      global.fetch = httpFail(500);
      await expect(
        apiService.issueStock({ productId: 'PROD-CF-1', productCode: 'CF1', department: 'PD', quantity: 3, issuedTo: 'ไลน์ A', reason: 't' })
      ).rejects.toThrow();
      expect(storageService.getProducts().find(p => p.id === 'PROD-CF-1').stockBalance).toBe(20);
    });

    it('8. adjustBudget: 500 -> throws, no local budget/transaction written', async () => {
      global.fetch = httpFail(500);
      const budgetsBefore = JSON.stringify(storageService.getBudgets());
      await expect(
        apiService.adjustBudget({ dept: 'PD', action: 'SET_BUDGET', newAmount: 5000, previousAmount: 1000, delta: 4000, actor: 'Admin', targetMonth: '2026-10' })
      ).rejects.toThrow(/server said 500/);
      expect(JSON.stringify(storageService.getBudgets())).toBe(budgetsBefore);
      expect(storageService.getBudgetTransactions().length).toBe(0);
    });

    it('9. allocateMonthlyBudget: 500 -> throws and rolls local budgets + ledger back', async () => {
      global.fetch = httpFail(500);
      const budgetsBefore = JSON.stringify(storageService.getBudgets());
      await expect(
        budgetService.allocateMonthlyBudget({ period: '2026-11', allocations: { PD: 7000 }, actor: 'Admin', reason: 't' })
      ).rejects.toThrow(/server said 500/);
      expect(JSON.stringify(storageService.getBudgets())).toBe(budgetsBefore);
      expect(storageService.getBudgetTransactions().length).toBe(0);
    });

    it('10. updatePOStatus: PUT /api/pos/:id 500 -> throws, PO status unchanged', async () => {
      seedPR();
      seedPO();
      global.fetch = httpFail(500);
      await expect(apiService.updatePOStatus('PO-CF-001', 'CANCELLED', ADMIN, 'x')).rejects.toThrow();
      expect(storageService.getPOs().find(p => p.id === 'PO-CF-001').status).toBe('OPEN');
    });

    it('11. receiveGoods: 404 does NOT fall back to local engine -> throws, PO unchanged', async () => {
      seedPR();
      seedPO();
      seedProducts();
      global.fetch = httpFail(404);
      await expect(
        apiService.receiveGoods('PO-CF-001', [{ productId: 'PROD-CF-1', receivedThisTime: 2 }], ADMIN)
      ).rejects.toThrow();
      expect(storageService.getPOs().find(p => p.id === 'PO-CF-001').status).toBe('OPEN');
      expect(storageService.getProducts().find(p => p.id === 'PROD-CF-1').stockBalance).toBe(20);
    });

    it('12. saveUser: 500 -> throws, user list unchanged', async () => {
      const before = storageService.getUsers().length;
      global.fetch = httpFail(500);
      await expect(
        apiService.saveUser({ username: 'cf.newuser', name: 'New User', roleId: 'REQUESTER', department: 'PD' }, 'Admin')
      ).rejects.toThrow(/server said 500/);
      expect(storageService.getUsers().length).toBe(before);
    });

    it('secondary fire-and-forget (cfBackground): never throws, console.warn on failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = httpFail(500);
      await expect(cfBackground('ledger', '/api/budget-transactions', { method: 'POST' })).resolves.toBeDefined();
      global.fetch = networkFail();
      await expect(cfBackground('ledger', '/api/budget-transactions', { method: 'POST' })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('secondary ledger sync (logBudgetTransaction): failed sync warns and does not keep the ledger row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = httpFail(500);
      await budgetService.logBudgetTransaction({ department: 'PD', type: 'PR_COMMIT', amount: 100, docRef: 'PR-LEDGER-1' });
      expect(warn).toHaveBeenCalled();
      expect(storageService.getBudgetTransactions().some(t => t.docNo === 'PR-LEDGER-1')).toBe(false);
    });
  });

  describe('mock mode: behaviour unchanged (best-effort local fallback)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    });

    it('createPR: 409 still returns the local PR without throwing', async () => {
      global.fetch = httpFail(409);
      const pr = await apiService.createPR({ department: 'PD', items: [{ id: 'I1', name: 'x', qty: 1, price: 10 }] }, ADMIN);
      expect(pr).toBeDefined();
      expect(pr.id).toBeTruthy();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('updatePRStatus: API 500 / offline is ignored, local status still changes', async () => {
      seedPR();
      global.fetch = networkFail();
      const res = await apiService.updatePRStatus('PR-CF-001', 'REVIEWED', ADMIN, 'ok');
      expect(res.pr.status).toBe('REVIEWED');
      expect(storageService.getPRs().find(p => p.id === 'PR-CF-001').status).toBe('REVIEWED');
    });

    it('saveProduct: API 500 falls back to localStorage', async () => {
      seedProducts();
      global.fetch = httpFail(500);
      const saved = await apiService.saveProduct({ code: 'NEW1', name: 'ใหม่', category: 'PD', department: 'PD', price: 5, stockUnit: 'ชิ้น' });
      expect(saved.code).toBe('NEW1');
      expect(storageService.getProducts().some(p => p.code === 'NEW1')).toBe(true);
    });

    it('adjustBudget: API 500 falls back to local budget change', async () => {
      global.fetch = httpFail(500);
      const res = await apiService.adjustBudget({ dept: 'PD', action: 'SET_BUDGET', newAmount: 5000, previousAmount: 1000, delta: 4000, actor: 'Admin', targetMonth: '2026-10' });
      expect(res.success).toBe(true);
      expect(storageService.getBudgetTransactions().length).toBeGreaterThan(0);
    });

    it('cfBackground: silent in mock mode (no console.warn)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = httpFail(500);
      await cfBackground('ledger', '/api/budget-transactions', { method: 'POST' });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
