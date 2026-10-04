import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import BudgetView from '../src/views/BudgetView';
import MonthlyBudgetManagement from '../src/views/budget/MonthlyBudgetManagement';
import MonthlyBudgetView from '../src/views/budget/MonthlyBudgetView';
import { storageService } from '../src/services/storageService';
import { budgetService, CLEAN_BUDGET_BASELINE, generateCleanBudgetBaseline } from '../src/services/budgetService';
import { apiService } from '../src/services/apiService';
import { workflowEngine } from '../src/services/workflowEngine';

describe('Domain Suite: Budget Management & Financial Ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    storageService.resetData();
    budgetService.resetBudgetData();
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 1: Monthly Budget Clean Baseline & Operational Period Alignment
  // ══════════════════════════════════════════════════════════════════
  describe('1. Monthly Budget Clean Baseline & Operational Period Alignment', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      storageService.resetData();
      budgetService.resetBudgetData();
    });

    // ── Requirement 1: Reset Active Budget Month to 2026-09 (กันยายน 2569) ──
    it('Requirement 1: Budget view defaults immediately to operational period "กันยายน 2569" (2026-09)', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget']}>
          <BudgetView
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
          />
        </MemoryRouter>
      );

      // Verify Thai month representation
      expect(html).toContain('กันยายน 2569');
      expect(html).toContain('(2026-09)');
      // Verify it does NOT default to futuristic 2027-01 (มกราคม 2570)
      expect(html).not.toContain('มกราคม 2570');
    });

    it('Requirement 1b: MonthlyBudgetView and MonthlyBudgetManagement aliases both render default period "กันยายน 2569"', () => {
      const html1 = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget']}>
          <MonthlyBudgetView
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
          />
        </MemoryRouter>
      );
      expect(html1).toContain('กันยายน 2569');

      const html2 = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget']}>
          <MonthlyBudgetManagement
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
          />
        </MemoryRouter>
      );
      expect(html2).toContain('กันยายน 2569');
    });

    // ── Requirement 2: Clean Departmental Allocations & ฿0 Initial Spent ──
    it('Requirement 2: Departmental allocations match realistic baselines (PD: ฿1M, QC: ฿150k, WH: ฿120k, PUR: ฿100k, ENG: ฿205k) with ฿0 spent', () => {
      const baseline = storageService.getBudgets();

      expect(baseline.PD.monthlyBudget).toBe(1000000);
      expect(baseline.PD.spent).toBe(0);
      expect(baseline.PD.variance).toBe(1000000);

      expect(baseline.QC.monthlyBudget).toBe(150000);
      expect(baseline.QC.spent).toBe(0);
      expect(baseline.QC.variance).toBe(150000);

      expect(baseline.WH.monthlyBudget).toBe(120000);
      expect(baseline.WH.spent).toBe(0);
      expect(baseline.WH.variance).toBe(120000);

      expect(baseline.PUR.monthlyBudget).toBe(100000);
      expect(baseline.PUR.spent).toBe(0);
      expect(baseline.PUR.variance).toBe(100000);

      expect(baseline.ENG.monthlyBudget).toBe(205000);
      expect(baseline.ENG.spent).toBe(0);
      expect(baseline.ENG.variance).toBe(205000);

      // Baseline contains strictly the active month 2026-09
      expect(Object.keys(baseline.PD.history)).toEqual(['2026-09']);
      expect(Object.keys(baseline.PD.historicalSpent)).toEqual(['2026-09']);
    });

    // ── Requirement 3: Elimination of Past Empty Placeholder Rows ──
    it('Requirement 3: Historical comparison table renders ONLY 1 row: "กันยายน 2569 (เดือนปัจจุบัน)" and eliminates empty past months', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget?tab=trends']}>
          <BudgetView
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
            prs={[]}
            pos={[]}
          />
        </MemoryRouter>
      );

      // Active month must appear as current month row
      expect(html).toContain('กันยายน 2569');
      expect(html).toContain('เดือนปัจจุบัน');
      expect(html).toContain('฿1,575,000'); // Total allocated for ALL departments (1M + 150k + 120k + 100k + 205k)
      expect(html).toContain('รอบบัญชีปัจจุบัน (2026-09)');

      // Past months (มี.ค. - ส.ค. 2569) must NOT appear in the table
      expect(html).not.toContain('สิงหาคม 2569');
      expect(html).not.toContain('กรกฎาคม 2569');
      expect(html).not.toContain('มิถุนายน 2569');
      expect(html).not.toContain('พฤษภาคม 2569');
      expect(html).not.toContain('เมษายน 2569');
      expect(html).not.toContain('มีนาคม 2569');
    });

    // ── Requirement 4: Dynamic Period Growth on Actual PR/PO Transactions ──
    it('Requirement 4: Dynamic period growth displays past/future months ONLY when actual PR/PO transactions exist', () => {
      // Inject a real PO in August 2026 (2026-08)
      const augPO = {
        id: 'PO-PD-2026-AUG',
        poNo: 'PO-PD-2026-088',
        department: 'PD',
        status: 'CLOSED',
        issueDate: '2026-08-15',
        items: [{ name: 'August Raw Material', price: 50000, qty: 1 }]
      };

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget?tab=trends']}>
          <BudgetView
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
            prs={[]}
            pos={[augPO]}
          />
        </MemoryRouter>
      );

      // Now August 2026 dynamically appears because a real transaction exists
      expect(html).toContain('สิงหาคม 2569');
      expect(html).toContain('กันยายน 2569');

      // Months without any transactions (e.g. July, June, May) remain excluded
      expect(html).not.toContain('กรกฎาคม 2569');
      expect(html).not.toContain('มิถุนายน 2569');
    });

    // ── Requirement 5: Data Reset Capability & Real-time PR/PO Updates ──
    it('Requirement 5a: resetBudgetData cleanly re-seeds minimal baseline idempotently', () => {
      // Corrupt storage with legacy bloated phantom numbers and multiple history months
      storageService.saveBudgets({
        PD: {
          monthlyBudget: 4000000,
          spent: 999999,
          variance: 3000001,
          history: { '2026-01': 4000000, '2026-09': 4000000 },
          historicalSpent: { '2026-01': 999999, '2026-09': 0 }
        }
      });
      expect(storageService.getBudgets().PD.monthlyBudget).toBe(4000000);

      // Call reset utility
      const resetResult = budgetService.resetBudgetData();
      expect(resetResult.PD.monthlyBudget).toBe(1000000);
      expect(resetResult.PD.spent).toBe(0);
      expect(Object.keys(resetResult.PD.history)).toEqual(['2026-09']);

      const reloaded = storageService.getBudgets();
      expect(reloaded.PD.monthlyBudget).toBe(1000000);
      expect(reloaded.PD.spent).toBe(0);
      expect(reloaded.QC.monthlyBudget).toBe(150000);
      expect(reloaded.WH.monthlyBudget).toBe(120000);
      expect(reloaded.PUR.monthlyBudget).toBe(100000);
      expect(reloaded.ENG.monthlyBudget).toBe(205000);
      expect(Object.keys(reloaded.PD.history)).toEqual(['2026-09']);
    });

    it('Requirement 5b: Real active PR and PO deductions update committed and spent in real-time', () => {
      // PR commitment for PD in 2026-09: ฿25,000
      const pr = {
        id: 'PR-PD-001',
        prNo: 'PR-PD-001',
        department: 'PD',
        status: 'APPROVED',
        requestedDate: '2026-09-05',
        totalAmount: 25000
      };
      storageService.savePRs([pr]);

      // Closed PO for PD in 2026-09: ฿15,000
      const po = {
        id: 'PO-PD-001',
        poNo: 'PO-PD-2026-001',
        department: 'PD',
        status: 'CLOSED',
        issueDate: '2026-09-10',
        items: [{ name: 'Part A', price: 15000, qty: 1 }]
      };
      storageService.savePOs([po]);

      const summary = apiService.calculateBudgetSummary('2026-09');
      const pdSummary = summary.trends['2026-09'].PD;

      expect(pdSummary.baseAllocated).toBe(1000000);
      expect(pdSummary.actualSpent).toBe(15000);
      expect(pdSummary.committed).toBe(25000);
      expect(pdSummary.totalSpent).toBe(40000);
      expect(pdSummary.remaining).toBe(960000); // 1,000,000 - 40,000
      expect(pdSummary.percentage).toBe(4); // 40,000 / 1,000,000 * 100
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 2: Department Budget Credit & Financial Ledger Sync
  // ══════════════════════════════════════════════════════════════════
  describe('2. Department Budget Credit & Financial Ledger Sync', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      storageService.resetData();
    });

    // ── Scenario 1: Retroactive Auto-Sync of PO-PD-2026-001 ──
    it('Scenario 1 (Retroactive Auto-Sync of PO-PD-2026-001): automatically detects, credits, and backfills missing ฿246.00 refund from PO-PD-2026-001', async () => {
      const po = {
        id: 'PO-1789291527812-1',
        poNo: 'PO-PD-2026-001',
        department: 'PD',
        status: 'ORDERED_PENDING_DELIVERY',
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            status: 'RESOLVED',
            isResolved: true,
            type: 'REFUND',
            refundAmount: 246,
            note: '[ร้าน แ้ก้กเก้ดเ้ด]: คืนเงินนนนนค่ะ',
            resolvedAt: '2026-09-13T09:39:44.460Z',
            resolvedBy: 'คุณนัท (Online Purchaser)'
          }
        },
        items: [
          {
            productId: 'PROD-2',
            code: 'ITM-002',
            name: 'น้ำมันหล่อลื่น (ลิตร)',
            claimResolution: 'REFUND',
            refundAmount: 246
          }
        ]
      };

      storageService.savePOs([po]);

      // Initial state: ensure transaction does not exist yet
      let txs = storageService.getBudgetTransactions();
      const existing001 = txs.find(t => t.docNo === 'PO-PD-2026-001' || t.referenceDoc === 'PO-PD-2026-001');
      expect(existing001).toBeUndefined();

      // Execute retroactive auto-sync
      const syncResult = budgetService.syncSettledRefundsToBudget([po]);
      expect(syncResult.success).toBe(true);
      expect(syncResult.syncedCount).toBeGreaterThanOrEqual(1);

      // Ledger now contains the canonical record for PO-PD-2026-001
      txs = storageService.getBudgetTransactions();
      const reconciledTx = txs.find(t => t.docNo === 'PO-PD-2026-001' || t.referenceDoc === 'PO-PD-2026-001');
      expect(reconciledTx).toBeDefined();
      expect(reconciledTx.amount).toBe(246);
      expect(reconciledTx.refundAmount).toBe(246);
      expect(reconciledTx.department).toBe('PD');
      expect(reconciledTx.departmentName).toBe('ฝ่าย PD');
      expect(reconciledTx.type).toBe('BUDGET_ROLLBACK');
    });

    // ── Scenario 2: Table UI Formatting ──
    it('Scenario 2 (Table UI Formatting): renders ISO timestamp, BUDGET_ROLLBACK, ฝ่าย PD, +฿246.00 (emerald bold font), PO-PD-2026-001 (badge), and remark', () => {
      const po = {
        id: 'PO-1789291527812-1',
        poNo: 'PO-PD-2026-001',
        department: 'PD',
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            status: 'RESOLVED',
            isResolved: true,
            type: 'REFUND',
            refundAmount: 246,
            note: '[ร้าน แ้ก้กเก้ดเ้ด]: คืนเงินนนนนค่ะ'
          }
        }
      };
      storageService.savePOs([po]);
      budgetService.syncSettledRefundsToBudget([po]);

      // Render MonthlyBudgetManagement / BudgetView
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget?tab=history']}>
          <MonthlyBudgetManagement
            pos={[po]}
            departments={[{ code: 'PD', name: 'ฝ่ายผลิต', monthlyBudget: 40000 }]}
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['PD'] }}
          />
        </MemoryRouter>
      );

      // Verify Tab 3 presence and rendered table columns

      // Check that +฿246.00 is rendered with emerald bold font, NOT +฿0
      expect(html).toContain('+฿246.00');
      expect(html).toContain('text-emerald-600 font-mono');
      expect(html).not.toContain('+฿0.00');

      // Check that reference doc is PO-PD-2026-001 as badge, NOT '-'
      expect(html).toContain('PO-PD-2026-001');

      // Check Department format is "ฝ่าย PD"
      expect(html).toContain('ฝ่าย PD');

      // Check Type is คืนงบประมาณ
      expect(html).toContain('คืนงบประมาณ');

      // Check Remark
      expect(html).toContain('คืนเงินค่าสินค้าเสียหาย/ของขาดจาก PO-PD-2026-001');
    });

    // ── Scenario 3: Department Summary Metric Consistency ──
    it('Scenario 3 (Department Summary Metric Consistency): PD budgetSpent is reduced by ฿246.00 and budgetRemaining is increased by ฿246.00', async () => {
      // Set baseline budgets
      const baselineBudgets = {
        PD: {
          monthlyBudget: 40000,
          spent: 10000,
          actualExpense: 10000,
          variance: 30000,
          remainingBudget: 30000,
          history: { '2026-09': 40000 },
          historicalSpent: { '2026-09': 10000 }
        }
      };
      storageService.saveBudgets(baselineBudgets);

      const po = {
        id: 'PO-1789291527812-1',
        poNo: 'PO-PD-2026-001',
        department: 'PD',
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            status: 'RESOLVED',
            isResolved: true,
            type: 'REFUND',
            refundAmount: 246,
            note: '[ร้าน แ้ก้กเก้ดเ้ด]: คืนเงินนนนนค่ะ'
          }
        }
      };
      storageService.savePOs([po]);

      const creditRes = await budgetService.creditDepartmentBudget({
        departmentId: 'PD',
        department: 'PD',
        amount: 246,
        referencePo: 'PO-PD-2026-001',
        storeKey: 'Shopee_แ้ก้กเก้ดเ้ด',
        reason: 'คืนเงินค่าสินค้าเสียหาย/ของขาดจาก PO-PD-2026-001'
      });

      expect(creditRes.success).toBe(true);
      expect(creditRes.budgetSpent).toBe(9754); // 10000 - 246
      expect(creditRes.budgetRemaining).toBe(30246); // 30000 + 246

      const updatedBudgets = storageService.getBudgets();
      expect(updatedBudgets['PD'].spent).toBe(9754);
      expect(updatedBudgets['PD'].variance).toBe(30246);
      expect(updatedBudgets['PD'].remainingBudget).toBe(30246);
    });

    // ── Scenario 4: Strict Idempotency ──
    it('Scenario 4 (Strict Idempotency): refreshing or running sync multiple times does NOT duplicate transaction or repeatedly credit budget', async () => {
      const po = {
        id: 'PO-1789291527812-1',
        poNo: 'PO-PD-2026-001',
        department: 'PD',
        storeClaims: {
          'Shopee_แ้ก้กเก้ดเ้ด': {
            status: 'RESOLVED',
            isResolved: true,
            type: 'REFUND',
            refundAmount: 246,
            note: '[ร้าน แ้ก้กเก้ดเ้ด]: คืนเงินนนนนค่ะ'
          }
        }
      };
      storageService.savePOs([po]);

      // First execution
      const run1 = budgetService.syncSettledRefundsToBudget([po]);
      expect(run1.syncedCount).toBe(1);

      const txs1 = storageService.getBudgetTransactions();
      const count1 = txs1.filter(t => t.docNo === 'PO-PD-2026-001').length;
      expect(count1).toBe(1);

      const budgetsAfter1 = storageService.getBudgets();
      const spent1 = budgetsAfter1['PD']?.spent;

      // Second execution (simulate page refresh or tab switch)
      const run2 = budgetService.syncSettledRefundsToBudget([po]);
      expect(run2.syncedCount).toBe(0); // 0 new syncs

      const txs2 = storageService.getBudgetTransactions();
      const count2 = txs2.filter(t => t.docNo === 'PO-PD-2026-001').length;
      expect(count2).toBe(1); // strictly 1, no duplicates!

      // Third execution (direct creditDepartmentBudget call)
      const run3 = await budgetService.creditDepartmentBudget({
        department: 'PD',
        amount: 246,
        referencePo: 'PO-PD-2026-001',
        storeKey: 'Shopee_แ้ก้กเก้ดเ้ด'
      });
      expect(run3.alreadyReconciled).toBe(true);

      const budgetsAfter3 = storageService.getBudgets();
      expect(budgetsAfter3['PD']?.spent).toBe(spent1); // budget spent unchanged!
    });
  });

  // ── 3. Budget Adjustment & Delta Calculation (1M -> 1.5M = +500,000) ──
  describe('3. Budget Top Up & Delta Calculation (Starting 1,000,000 to 1,500,000 logs +500,000)', () => {
    beforeEach(() => {
      budgetService.resetBudgetData();
    });

    it('Scenario 3a: allocateMonthlyBudget from 1,000,000 to 1,500,000 records delta = +500,000, amount = 500,000, and TOP_UP', async () => {
      // Starting baseline has PD = 1,000,000
      const initialBudgets = storageService.getBudgets();
      expect(Number(initialBudgets.PD.monthlyBudget)).toBe(1000000);

      // Adjust PD to 1,500,000
      await budgetService.allocateMonthlyBudget({
        period: '2026-09',
        allocations: { PD: 1500000 },
        previousAmounts: { PD: 1000000 },
        actor: 'Admin',
        reason: 'ปรับเพิ่มงบประมาณฝ่ายผลิต'
      });

      const txs = storageService.getBudgetTransactions();
      const latestTx = txs.filter(t => t.dept === 'PD' && t.period === '2026-09').pop();

      expect(latestTx).toBeDefined();
      expect(latestTx.type).toBe('TOP_UP');
      expect(latestTx.typeLabel).toBe('ปรับเพิ่มงบประมาณ');
      expect(latestTx.amount).toBe(500000); // 500,000 NOT 1,500,000!
      expect(latestTx.delta).toBe(500000);
      expect(latestTx.previousAmount).toBe(1000000);
      expect(latestTx.newAmount).toBe(1500000);
      expect(latestTx.isAllocation).toBe(true);

      const updatedBudgets = storageService.getBudgets();
      expect(updatedBudgets.PD.monthlyBudget).toBe(1500000);
    });

    it('Scenario 3b: apiService.updateBudget from 1,000,000 to 1,500,000 records delta = +500,000 and TOP_UP', async () => {
      const initialBudgets = storageService.getBudgets();
      expect(Number(initialBudgets.PD.monthlyBudget)).toBe(1000000);

      const result = await apiService.updateBudget('PD', 1500000, '2026-09', 'ผู้ดูแลระบบ');

      expect(result.success).toBe(true);
      expect(result.transaction).toBeDefined();
      expect(result.transaction.type).toBe('TOP_UP');
      expect(result.transaction.typeLabel).toBe('ปรับเพิ่มงบประมาณ');
      expect(result.transaction.amount).toBe(500000);
      expect(result.transaction.delta).toBe(500000);
      expect(result.transaction.previousAmount).toBe(1000000);
      expect(result.transaction.newAmount).toBe(1500000);
    });

    it('Scenario 3c: BudgetView renders +฿500,000.00 and ปรับเพิ่มงบประมาณ badge, NOT +฿1,500,000.00', async () => {
      // Log an adjustment transaction from 1,000,000 to 1,500,000
      const testTx = {
        id: 'BTX-TEST-1500',
        dept: 'PD',
        department: 'PD',
        type: 'TOP_UP',
        actionType: 'TOP_UP',
        typeLabel: 'ปรับเพิ่มงบประมาณ',
        amount: 500000,
        delta: 500000,
        previousAmount: 1000000,
        newAmount: 1500000,
        isAllocation: true,
        note: 'ปรับเพิ่มงบประมาณจาก ฿1,000,000 เป็น ฿1,500,000',
        createdAt: '2026-09-15T10:00:00.000Z',
        date: '2026-09-15 10:00:00',
        targetMonth: '2026-09',
        period: '2026-09'
      };
      storageService.saveBudgetTransactions([testTx]);

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget?tab=history&month=2026-09']}>
          <BudgetView
            currentUser={{ id: 'ADMIN', roleId: 'ADMIN', level: 99, assignedDepartments: ['ALL'] }}
            prs={[]}
            pos={[]}
          />
        </MemoryRouter>
      );

      // Verify +฿500,000.00 and badge appear
      expect(html).toContain('+฿500,000.00');
      expect(html).toContain('ปรับเพิ่มงบประมาณ');
      // Verify +฿1,500,000.00 is NOT displayed as the transaction delta
      expect(html).not.toContain('+฿1,500,000.00');
    });
  });
});
