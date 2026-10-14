// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useBudgetContext } from '../src/context/BudgetContext.jsx';

describe('BudgetContext summary source by backend mode', () => {
  beforeEach(() => { localStorage.clear(); vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('cloudflare: no app context -> empty summary (no simulated numbers), zero-based calc', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const ctx = useBudgetContext();
    expect(ctx.budgetSummary).toEqual({ current: {}, trends: {} });
    const s = ctx.calculateBudgetSummary('2026-10');
    expect(s.period).toBe('2026-10');
    Object.values(s.current).forEach(d => {
      expect(d.actualSpent).toBe(0);
      expect(d.committed).toBe(0);
    });
  });

  it('mock: legacy engine summary unchanged', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const ctx = useBudgetContext();
    expect(ctx.budgetSummary.current).toBeTruthy();
    expect(ctx.budgetSummary.targetMonth).toBeTruthy();
  });
});
