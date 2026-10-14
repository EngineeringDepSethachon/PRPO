import { describe, it, expect } from 'vitest';
import { budgetService } from '../src/services/budgetService';
import { workflowEngine } from '../src/services/workflowEngine';

// Bug C: legacy engine simulates "historicalSpent" (65-95% of allocation) when a month has no data -> fixed 79% everywhere.
// Cloudflare mode now uses the zero-based budgetService formula (same as BudgetView).
describe('budget summary source (bug C)', () => {
  const month = '2026-10';
  const budgets = { PD: { monthlyBudget: 100000, history: { [month]: 100000 }, historicalSpent: {} } };
  const pos = [{ id: 'PO1', prId: 'PR1', department: 'PD', status: 'CLOSED', issueDate: `${month}-02`, grandTotal: 1000, items: [] }];
  const prs = [];

  it('zero-based summary reports only real spend (no simulated usage)', () => {
    const s = budgetService.calculatePeriodBudgetSummary(month, prs, pos, budgets).current.PD;
    expect(s.allocated).toBe(100000);
    expect(s.actualSpent).toBe(1000);
    expect(s.committed).toBe(0);
    expect(s.percentage).toBe(1);
  });

  it('month with no spend is 0 used, not a hash-simulated percentage', () => {
    const s = budgetService.calculatePeriodBudgetSummary('2026-09', [], [], budgets).current.PD;
    expect(s.actualSpent).toBe(0);
    expect(s.committed).toBe(0);
  });

  it('documents the legacy engine behaviour that CF mode no longer uses', () => {
    expect(typeof workflowEngine.calculateBudgetSummary).toBe('function');
  });
});
