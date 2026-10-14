// @vitest-environment node
// QA (prae) T4.5 read-through: pure rbac.js checks. Tests marked BUG are expected to FAIL until fixed.
import { describe, it, expect } from 'vitest';
import { authorize, canAdjustBudget, canTransitionPR, matchRule } from '../functions/_lib/rbac.js';

const L1 = { id: 'U-L1', username: 'req.pd', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 };
const L2 = { id: 'U-L2', username: 'asst.am', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 };
const ONLINE = { id: 'U-ON', username: 'nat.on', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 };

describe('T4.5 QA - normal flows are not 403', () => {
  it('level 1 refund/credit flows pass (PUT budgets/:dept, adjust refund, ledger, stock-logs, products PUT)', () => {
    expect(authorize(L1, 'PUT', '/api/budgets/PD')).toBe(true); // T3.5 fix: route-level BUDGET_ADJUST ; the handler lets non-budget users post only a refund credit
    expect(authorize(L1, 'POST', '/api/budgets/adjust')).toBe(true);
    expect(canAdjustBudget(L1, { action: 'TOP_UP', delta: 100 })).toBe(true);
    expect(authorize(L1, 'POST', '/api/budget-transactions')).toBe(true);
    expect(authorize(L1, 'POST', '/api/stock-logs')).toBe(true);
    expect(authorize(L1, 'POST', '/api/stock/issue')).toBe(true);
    expect(authorize(L1, 'PUT', '/api/products/P1')).toBe(true);
    expect(authorize(L1, 'POST', '/api/prs')).toBe(true);
  });
  it('ASST_MANAGER manual stock-in path (products/batch + stock-logs) is allowed', () => {
    expect(authorize(L2, 'POST', '/api/products/batch')).toBe(true);
    expect(authorize(L2, 'POST', '/api/stock-logs')).toBe(true);
  });
  it('online purchaser: budgets/reset is 403 (fire-and-forget in client, not a crash)', () => {
    expect(authorize(ONLINE, 'POST', '/api/budgets/reset')).toBe(false);
    expect(authorize(ONLINE, 'POST', '/api/budgets/adjust')).toBe(true);
  });
});

describe('T4.5 QA - BUGS (expected to fail now)', () => {
  it('BUG-1: trailing slash must not widen budgets/adjust (handler only matches exact path, then falls into the bulk budgets POST)', () => {
    expect(authorize(L1, 'POST', '/api/budgets/adjust/')).toBe(false);
    const r = matchRule('POST', '/api/budgets/adjust/');
    // either denied or mapped to the strict BUDGET_WRITE rule
    expect(r && r.perm).not.toBe('BUDGET_ADJUST');
  });
  it('BUG-2: level 1 refund must not be able to carry a newAmount that overwrites monthlyBudget', () => {
    expect(canAdjustBudget(L1, { action: 'TOP_UP', delta: 1, newAmount: 999999999, dept: 'PD' })).toBe(false);
  });
  it('BUG-3: PR cannot jump DRAFT -> APPROVED for a level 1 user', () => {
    expect(canTransitionPR(L1, 'DRAFT', 'APPROVED')).toBe(false);
  });
  it('BUG-3b: level 2 reviewer cannot jump SUBMITTED -> APPROVED', () => {
    expect(canTransitionPR(L2, 'SUBMITTED', 'APPROVED')).toBe(false);
  });
});
