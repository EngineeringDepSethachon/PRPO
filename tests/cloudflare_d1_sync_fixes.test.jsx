import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup.js';
import { apiService } from '../src/services/apiService';
import { budgetService } from '../src/services/budgetService';
import { storageService } from '../src/services/storageService';
import { onRequest } from '../functions/api/[[route]].js';

import { signToken } from '../functions/_lib/auth.js';

const TEST_SECRET = 'unit-test-secret-0123456789abcdef';

// Calls onRequest with a valid Bearer token and a DB wrapper that answers the auth-middleware user lookup.
async function callApi(request, mockDb) {
  const token = await signToken({ userId: 'USR-T', role: 'ADMIN', level: 99 }, TEST_SECRET);
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const authed = new Request(request, { headers });
  const db = {
    prepare: (query) => {
      if (query.includes('FROM users WHERE id = ?')) {
        return { bind: () => ({ first: async () => ({ id: 'USR-T', username: 'tester', name: 'Tester', status: 'ACTIVE', level: 99 }) }) };
      }
      return mockDb.prepare(query);
    },
    batch: async (stmts) => (mockDb.batch ? mockDb.batch(stmts) : Promise.all(stmts.map((s) => s.run())))
  };
  return onRequest({ request: authed, env: { DB: db, AUTH_TOKEN_SECRET: TEST_SECRET } });
}

describe('Cloudflare D1 & Pages Functions Sync & Bug Fix Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('1. apiService.createPR Return Contract', () => {
    it('returns the real PR object when backend returns { success: true, count: 1, pr: ... }', async () => {
      const originalFetch = global.fetch;
      const createdPrPayload = {
        id: 'PR-TEST-999',
        prNo: 'PD099/2026',
        department: 'PD',
        totalAmount: 5000,
        status: 'SUBMITTED',
        items: [{ id: 'ITEM-1', name: 'น้ำมันเครื่อง', qty: 2, price: 2500 }]
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          count: 1,
          pr: createdPrPayload,
          id: 'PR-TEST-999',
          prNo: 'PD099/2026'
        })
      });

      const res = await apiService.createPR(createdPrPayload, { name: 'Wichai', role: 'REQUESTER' });
      expect(res).toBeDefined();
      expect(res.id).toBe('PR-TEST-999');
      expect(res.prNo).toBe('PD099/2026');
      expect(res.totalAmount).toBe(5000);

      global.fetch = originalFetch;
    });

    it('falls back to local PR object if backend response envelope does not contain id or pr', async () => {
      const originalFetch = global.fetch;
      const localPr = {
        id: 'PR-LOCAL-001',
        prNo: 'QC001/2026',
        department: 'QC',
        totalAmount: 1200
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, count: 1 })
      });

      const res = await apiService.createPR(localPr, { name: 'Somying', role: 'REQUESTER' });
      expect(res).toBeDefined();
      expect(res.id).toMatch(/^PR-/);
      expect(res.prNo).toBe('QC001/2026');

      global.fetch = originalFetch;
    });
  });

  describe('2. Cloudflare Pages Function: Goods Receiving & Settle Endpoints', () => {
    it('handles POST /api/pos/:id/receive, increments product stock and creates stock_log', async () => {
      const mockDb = {
        prepare: vi.fn().mockImplementation((query) => {
          return {
            bind: vi.fn().mockImplementation((...params) => ({
              first: async () => {
                if (query.includes('UPDATE pos SET updatedAt = ?')) return { id: 'PO-TEST-001' }; // T4.5c optimistic lock acquired
                if (query.includes('COUNT(*) AS n FROM stock_logs')) return { n: 1 }; // the receipt's stock log exists after the batch
                if (query.includes('FROM pos WHERE')) {
                  return {
                    id: 'PO-TEST-001',
                    poNumber: 'PO-PD-2026-001',
                    department: 'PD',
                    status: 'ORDERED',
                    itemsJson: JSON.stringify([{ id: 'ITM-1', productId: 'PROD-001', code: 'P01', name: 'อะไหล่', qty: 10, receivedQty: 0 }]),
                    timelineJson: JSON.stringify([]),
                    evidenceJson: JSON.stringify({})
                  };
                }
                if (query.includes('FROM products WHERE')) {
                  return { id: 'PROD-001', code: 'P01', name: 'อะไหล่', currentStock: 15 };
                }
                return null;
              },
              run: async () => ({ success: true }),
              all: async () => ({ results: [] })
            })),
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
            first: async () => null
          };
        }),
        batch: async () => [] // T4.5c: stock + log + PO update are committed in one db.batch
      };

      const request = new Request('https://prpo.pages.dev/api/pos/PO-TEST-001/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receivingItems: [{ productId: 'PROD-001', goodQty: 5, defectiveQty: 0, storageLocation: 'LOC-PD-001' }],
          note: 'ตรวจรับครึ่งหนึ่ง',
          user: { name: 'Somkid', title: 'Warehouse' }
        })
      });

      const response = await callApi(request, mockDb);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.po.status).toBe('PARTIAL');
      expect(json.po.items[0].receivedQty).toBe(5);
    });

    it('handles POST /api/pos/:id/settle with refund, appends budget_transactions and credits budget', async () => {
      let insertedTx = null;
      let updatedBudget = null;

      const mockDb = {
        prepare: vi.fn().mockImplementation((query) => {
          return {
            bind: vi.fn().mockImplementation((...params) => ({
              first: async () => {
                if (query.includes('FROM prs WHERE')) return { id: 'PR-1', prNumber: 'PR-PD-2026-009', department: 'PD' };
                if (query.includes('AS prCommit')) return { prCommit: 1000, refunded: 0 }; // T4.5d: validated PR_COMMITMENT of a real PR
                if (query.includes('FROM pos WHERE')) {
                  return {
                    id: 'PO-SETTLE-001',
                    poNumber: 'PO-PD-2026-009',
                    prNumber: 'PR-PD-2026-009',
                    department: 'PD',
                    status: 'ORDERED',
                    grandTotal: 1000,
                    extraJson: JSON.stringify({ approvedTotal: 1000 }) // server snapshot of the PO value
                  };
                }
                return null;
              },
              run: async () => {
                if (query.includes('INSERT INTO budget_transactions')) {
                  insertedTx = params;
                }
                if (query.includes('UPDATE budgets')) {
                  updatedBudget = params;
                }
                return { success: true };
              }
            })),
            run: async () => ({ success: true })
          };
        }),
        // T4.5: settle now writes ledger + budgets + PO status in one db.batch
        batch: async (stmts) => { for (const s of stmts) await s.run(); return []; }
      };

      const request = new Request('https://prpo.pages.dev/api/pos/PO-SETTLE-001/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refundAmount: 350,
          actor: 'Nat Online',
          note: 'คืนเงินส่วนต่างร้านค้า'
        })
      });

      const response = await callApi(request, mockDb);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(insertedTx).toBeDefined();
      expect(insertedTx[3]).toBe(350); // refundAmount
      expect(updatedBudget).toBeDefined();
    });

    it('handles PUT /api/pos/:id, persists vendorName, vendorId, grandTotal and timeline', async () => {
      let boundParams = null;
      const mockDb = {
        prepare: vi.fn().mockImplementation((query) => {
          return {
            bind: vi.fn().mockImplementation((...params) => {
              if (query.includes('UPDATE pos SET')) {
                boundParams = params;
              }
              return {
                run: async () => ({ success: true })
              };
            })
          };
        })
      };

      const request = new Request('https://prpo.pages.dev/api/pos/PO-TEST-002', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ORDERED',
          vendorId: 'VEND-SHOPEE-01',
          vendorName: 'Shopee Official Store',
          totalAmount: 1850,
          grandTotal: 1850,
          items: [{ id: 'I1', qty: 2, price: 925 }],
          timeline: [{ action: 'ส่งต่องาน' }]
        })
      });

      const response = await callApi(request, mockDb);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(boundParams).toBeDefined();
      expect(boundParams[1]).toBe('VEND-SHOPEE-01');
      expect(boundParams[2]).toBe('Shopee Official Store');
      expect(boundParams[3]).toBe(1850); // totalAmount
      expect(boundParams[5]).toBe(1850); // grandTotal
    });
  });

  describe('3. budgetService.allocateMonthlyBudget Sync', () => {
    it('dispatches /api/budgets/allocate with transactions and allocations payload', async () => {
      const originalFetch = global.fetch;
      const fetchedEndpoints = [];

      global.fetch = vi.fn().mockImplementation(async (url, opts) => {
        fetchedEndpoints.push({ url, body: JSON.parse(opts.body) });
        return {
          ok: true,
          json: async () => ({ success: true })
        };
      });

      storageService.saveBudgets({
        PD: { monthlyBudget: 1000000, spent: 0, variance: 1000000 }
      });

      await budgetService.allocateMonthlyBudget({
        period: '2026-10',
        allocations: { PD: 1500000 },
        previousAmounts: { PD: 1000000 },
        actor: 'Somchai (Asst Mgr)',
        reason: 'เพิ่มงบฝ่ายผลิต'
      });

      const allocateCall = fetchedEndpoints.find(c => c.url === '/api/budgets/allocate');
      expect(allocateCall).toBeDefined();
      expect(allocateCall.body.period).toBe('2026-10');
      expect(allocateCall.body.allocations.PD).toBe(1500000);
      expect(allocateCall.body.transactions).toBeDefined();
      expect(allocateCall.body.transactions.PD.delta).toBe(500000);

      global.fetch = originalFetch;
    });
  });
});
