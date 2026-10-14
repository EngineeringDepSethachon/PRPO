import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { useAppContext } from './AppContext';
import { storageService } from '../services/storageService';
import { apiService } from '../services/apiService';
import { workflowEngine } from '../services/workflowEngine';
import { budgetService } from '../services/budgetService';

const BudgetContext = createContext(null);

/**
 * Standalone & Context-Shared rollbackBudget implementation
 */
export async function rollbackBudget(department, refundAmount, reason = 'คืนงบประมาณจากการตรวจรับ/เคลมสินค้า', options = {}) {
  const dept = (department || 'PD').toUpperCase();
  const amount = Number(refundAmount);
  if (!amount || amount <= 0) {
    throw new Error('ยอดเงินคืนงบประมาณต้องมากกว่า 0 บาท');
  }

  const budgets = storageService.getBudgets();
  if (!budgets[dept]) {
    budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };
  }

  const currentSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
  const newSpent = Math.max(0, currentSpent - amount);

  budgets[dept].spent = newSpent;
  budgets[dept].actualExpense = newSpent;

  const monthly = Number(budgets[dept].monthlyBudget || 0);
  const newVariance = monthly - newSpent;

  budgets[dept].variance = newVariance;
  budgets[dept].remainingBudget = newVariance;

  const today = new Date();
  const targetMonth = options.targetMonth || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
  budgets[dept].refundCredits[targetMonth] = (Number(budgets[dept].refundCredits[targetMonth]) || 0) + amount;

  storageService.saveBudgets(budgets);

  const tx = {
    id: `BTX-ROLLBACK-${Date.now()}`,
    date: today.toISOString().replace('T', ' ').slice(0, 19),
    createdAt: today.toISOString(),
    dept,
    type: 'BUDGET_ROLLBACK',
    typeLabel: 'คืนงบประมาณ (Budget Reversal)',
    previousAmount: currentSpent,
    newAmount: newSpent,
    amount,
    delta: amount,
    actor: options.actor || 'Budget Specialist',
    refDocNo: options.refDocNo || options.docNo || '',
    note: reason || 'คืนงบประมาณจากการตรวจรับสินค้า / สินค้าชำรุดเสียหาย',
    targetMonth
  };

  storageService.appendBudgetTransaction(tx);

  try {
    await apiService.adjustBudget({
      dept,
      action: 'BUDGET_ROLLBACK',
      previousAmount: currentSpent,
      newAmount: newSpent,
      delta: amount,
      reason,
      actor: tx.actor,
      targetMonth
    });
  } catch {
    // Graceful offline fallback
  }

  const newSummary = workflowEngine.calculateBudgetSummary(targetMonth);
  return {
    success: true,
    department: dept,
    refundAmount: amount,
    actualExpense: newSpent,
    remainingBudget: newVariance,
    budgetSummary: newSummary,
    transaction: tx
  };
}

/**
 * Standalone & Context-Shared deductBudget implementation (for Over-Budget orders)
 */
export async function deductBudget(department, extraAmount, reason = 'หักงบประมาณเพิ่มเติมจากการสั่งซื้อเกินงบ PR', options = {}) {
  const dept = (department || 'PD').toUpperCase();
  const amount = Number(extraAmount);
  if (!amount || amount <= 0) {
    throw new Error('ยอดเงินหักงบประมาณต้องมากกว่า 0 บาท');
  }

  const budgets = storageService.getBudgets();
  if (!budgets[dept]) {
    budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };
  }

  const currentSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
  const newSpent = currentSpent + amount;

  budgets[dept].spent = newSpent;
  budgets[dept].actualExpense = newSpent;

  const monthly = Number(budgets[dept].monthlyBudget || 0);
  const newVariance = monthly - newSpent;

  budgets[dept].variance = newVariance;
  budgets[dept].remainingBudget = newVariance;

  const today = new Date();
  const targetMonth = options.targetMonth || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  storageService.saveBudgets(budgets);

  const tx = {
    id: `BTX-DEDUCT-${Date.now()}`,
    date: today.toISOString().replace('T', ' ').slice(0, 19),
    createdAt: today.toISOString(),
    dept,
    type: 'BUDGET_OVERSPENT',
    typeLabel: 'หักงบประมาณเพิ่มเติม (Budget Additional Charge)',
    previousAmount: currentSpent,
    newAmount: newSpent,
    amount,
    delta: -amount,
    actor: options.actor || 'Online Purchaser',
    refDocNo: options.refDocNo || options.docNo || '',
    note: reason,
    targetMonth
  };

  storageService.appendBudgetTransaction(tx);

  try {
    await apiService.adjustBudget({
      dept,
      action: 'BUDGET_DEDUCT',
      previousAmount: currentSpent,
      newAmount: newSpent,
      delta: -amount,
      reason,
      actor: tx.actor,
      targetMonth
    });
  } catch {
    // Graceful offline fallback
  }

  const newSummary = workflowEngine.calculateBudgetSummary(targetMonth);
  return {
    success: true,
    department: dept,
    deductedAmount: amount,
    actualExpense: newSpent,
    remainingBudget: newVariance,
    budgetSummary: newSummary,
    transaction: tx
  };
}

export function BudgetProvider({ children }) {
  let app = null;
  try {
    app = useAppContext();
  } catch {
    app = null;
  }

  React.useEffect(() => {
    budgetService.syncSettledRefundsToBudget();
  }, []);

  const handleRollbackBudget = useCallback(async (department, refundAmount, reason, options) => {
    if (app?.rollbackBudget) {
      return app.rollbackBudget(department, refundAmount, reason, options);
    }
    return rollbackBudget(department, refundAmount, reason, options);
  }, [app]);

  const handleDeductBudget = useCallback(async (department, extraAmount, reason, options) => {
    if (app?.deductBudget) {
      return app.deductBudget(department, extraAmount, reason, options);
    }
    return deductBudget(department, extraAmount, reason, options);
  }, [app]);

  const value = useMemo(() => ({
    budgets: app?.budgets || storageService.getBudgets(),
    budgetSummary: app?.budgetSummary || workflowEngine.calculateBudgetSummary(),
    budgetTransactions: app?.budgetTransactions || storageService.getBudgetTransactions(),
    updateBudget: app?.updateBudget || apiService.updateBudget.bind(apiService),
    adjustBudget: app?.adjustBudget || apiService.adjustBudget.bind(apiService),
    refundBudget: app?.refundBudget || apiService.adjustBudget.bind(apiService),
    rollbackBudget: handleRollbackBudget,
    deductBudget: handleDeductBudget,
    calculateBudgetSummary: (m) => workflowEngine.calculateBudgetSummary(m)
  }), [app, handleRollbackBudget, handleDeductBudget]);

  return (
    <BudgetContext.Provider value={value}>
      {children}
    </BudgetContext.Provider>
  );
}

const hasHookDispatcher = () => {
  try {
    return Boolean(
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.H ||
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher?.current
    );
  } catch {
    return false;
  }
};

export const useBudgetContext = () => {
  let context = null;
  if (hasHookDispatcher()) {
    try {
      context = useContext(BudgetContext);
    } catch {
      context = null;
    }
  }

  if (!context) {
    const budgets = storageService.getBudgets();
    return {
      budgets,
      budgetSummary: workflowEngine.calculateBudgetSummary(),
      budgetTransactions: storageService.getBudgetTransactions(),
      updateBudget: apiService.updateBudget.bind(apiService),
      adjustBudget: apiService.adjustBudget.bind(apiService),
      rollbackBudget,
      deductBudget,
      calculateBudgetSummary: (m) => workflowEngine.calculateBudgetSummary(m)
    };
  }
  return context;
};

export default BudgetContext;
