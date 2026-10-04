import { storageService, isGAS, callGAS, sanitizePayloadForGAS } from './storageService';
import { workflowEngine } from './workflowEngine';
import { auditService } from './auditService';
import { modalService } from './modalService';
import { PO_STATUS } from '../config/constants';
import { clearMockTransactions, resetMockTransactions } from '../utils/dataResetHelper';
import { matchDepartment } from '../utils/permissions';
import { applyProductCostFailSafe } from './productService';

// API Service Layer for Data & Operations
export const apiService = {
  // --- Audit Trail Operations ---
  async getAuditLogs(filters, forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const gasLogs = await callGAS('apiGetAuditLogs');
          if (Array.isArray(gasLogs)) {
            storageService.saveAuditLogs(gasLogs);
            return gasLogs;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetAuditLogs error:', e.message);
        }
      }
      return auditService.getLogs(filters);
    }
    return auditService.getLogs(filters);
  },
  async clearAuditLogs() {
    return auditService.clearLogs();
  },
  // --- Data Getters ---
  async getInitialPayload() {
    if (isGAS()) {
      try {
        const payload = await callGAS('apiGetInitialPayload');
        if (payload && typeof payload === 'object') {
          storageService.applyInitialPayload(payload);
          return payload;
        }
      } catch (e) {
        console.warn('[apiService] GAS apiGetInitialPayload error:', e.message);
      }
    }
    return null;
  },
  async getBootstrapData() {
    // 1. Ensure local client storage is hydrated before API request
    try {
      storageService.hydrateFromClientStorage?.();
    } catch (e) {}

    // 2. Fetch from Google Apps Script Backend
    if (isGAS()) {
      try {
        const payload = await callGAS('apiGetBootstrapData');
        if (payload && typeof payload === 'object') {
          // Persist all returned collections in batch to localStorage
          if (typeof storageService.applyInitialPayload === 'function') {
            storageService.applyInitialPayload(payload);
          } else {
            if (Array.isArray(payload.prs)) storageService.savePRs(payload.prs);
            if (Array.isArray(payload.pos)) storageService.savePOs(payload.pos);
            const prods = payload.inventory || payload.products;
            if (Array.isArray(prods)) {
              const logs = payload.stockLogs || storageService.getStockLogs() || [];
              const safeProds = applyProductCostFailSafe(prods, logs);
              storageService.saveProducts(safeProds);
              payload.products = safeProds;
              payload.inventory = safeProds;
            }
            if (Array.isArray(payload.stockLogs)) storageService.saveStockLogs(payload.stockLogs);
            if (Array.isArray(payload.vendors)) storageService.saveVendors(payload.vendors);
            if (Array.isArray(payload.storageLocations)) storageService.saveStorageLocations(payload.storageLocations);
            if (Array.isArray(payload.usageUnits)) storageService.saveUsageUnits(payload.usageUnits);
            if (Array.isArray(payload.departments)) storageService.saveDepartments(payload.departments);
            if (Array.isArray(payload.users)) storageService.saveUsers(payload.users);
            if (payload.budgets && typeof payload.budgets === 'object') storageService.saveBudgets(payload.budgets);
            if (Array.isArray(payload.budgetTransactions)) storageService.saveBudgetTransactions(payload.budgetTransactions);
            if (Array.isArray(payload.notifications)) storageService.saveNotifications(payload.notifications);
          }
          return payload;
        }
      } catch (e) {
        console.warn('[apiService] GAS apiGetBootstrapData error:', e.message);
      }
    }

    // 3. Fallback for local dev server / offline mode
    try {
      const res = await fetch('/api/bootstrap');
      if (res.ok) {
        const payload = await res.json();
        if (payload && typeof payload === 'object') {
          if (typeof storageService.applyInitialPayload === 'function') {
            storageService.applyInitialPayload(payload);
          }
          return payload;
        }
      }
    } catch (e) {}

    // 4. Return cached dataset from storageService (localStorage)
    const cachedProducts = storageService.getProducts() || [];
    return {
      prs: storageService.getPRs() || [],
      pos: storageService.getPOs() || [],
      inventory: cachedProducts,
      products: cachedProducts,
      stockLogs: storageService.getStockLogs() || [],
      vendors: storageService.getVendors() || [],
      storageLocations: storageService.getStorageLocations() || [],
      usageUnits: storageService.getUsageUnits() || [],
      departments: storageService.getDepartments() || [],
      users: storageService.getUsers() || [],
      budgets: storageService.getBudgets() || {},
      budgetTransactions: storageService.getBudgetTransactions() || [],
      notifications: storageService.getNotifications() || []
    };
  },
  async getProducts(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetProducts');
          if (Array.isArray(data)) {
            const logs = storageService.getStockLogs() || [];
            const failSafeData = applyProductCostFailSafe(data, logs);
            storageService.saveProducts(failSafeData);
            return failSafeData;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetProducts fallback:', e.message);
        }
      }
      return storageService.getProducts();
    }
    try {
      const res = await fetch('/api/products');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const logs = storageService.getStockLogs() || [];
          const failSafeData = applyProductCostFailSafe(data, logs);
          storageService.saveProducts(failSafeData);
          return failSafeData;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/products fallback to storageService:', e.message);
    }
    return storageService.getProducts();
  },
  async getVendors(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetVendors');
          if (Array.isArray(data)) {
            storageService.saveVendors(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetVendors fallback:', e.message);
        }
      }
      return storageService.getVendors();
    }
    try {
      const res = await fetch('/api/vendors');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          storageService.saveVendors(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/vendors fallback to storageService:', e.message);
    }
    return storageService.getVendors();
  },
  async getStorageLocations(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetStorageLocations');
          if (Array.isArray(data)) {
            storageService.saveStorageLocations(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetStorageLocations fallback:', e.message);
        }
      }
      return storageService.getStorageLocations();
    }
    try {
      const res = await fetch('/api/storage-locations');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          storageService.saveStorageLocations(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/storage-locations fallback to storageService:', e.message);
    }
    return storageService.getStorageLocations();
  },
  async getUsageUnits(department, forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetUsageUnits');
          if (Array.isArray(data)) {
            storageService.saveUsageUnits(data);
            if (department && department !== 'ALL') {
              return data.filter(u => u.department === department);
            }
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetUsageUnits fallback:', e.message);
        }
      }
      return storageService.getUsageUnits(department);
    }
    try {
      const url = department && department !== 'ALL' 
        ? `/api/usage-units?department=${encodeURIComponent(department)}`
        : '/api/usage-units';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          if (!department || department === 'ALL') {
            storageService.saveUsageUnits(data);
          }
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/usage-units fallback to storageService:', e.message);
    }
    return storageService.getUsageUnits(department);
  },
  async getUsers(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetUsers');
          if (Array.isArray(data)) {
            storageService.saveUsers(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetUsers fallback:', e.message);
        }
      }
      return storageService.getUsers();
    }
    try {
      const res = await fetch('/api/users');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          storageService.saveUsers(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/users fallback to storageService:', e.message);
    }
    return storageService.getUsers();
  },
  async getDepartments(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetDepartments');
          if (Array.isArray(data)) {
            storageService.saveDepartments(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetDepartments fallback:', e.message);
        }
      }
      return storageService.getDepartments();
    }
    try {
      const res = await fetch('/api/departments');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          storageService.saveDepartments(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/departments fallback to storageService:', e.message);
    }
    return storageService.getDepartments();
  },
  async getPRs(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetPRs');
          if (Array.isArray(data)) {
            const seen = new Set();
            const unique = data.filter(p => {
              const key = p.id || p.prNo;
              if (!key || seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            storageService.savePRs(unique);
            return unique;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetPRs fallback:', e.message);
        }
      }
      return storageService.getPRs();
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('app_data_cleared') === 'true') {
      return storageService.getPRs();
    }
    try {
      const res = await fetch('/api/prs');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const seen = new Set();
          const unique = data.filter(p => {
            const key = p.id || p.prNo;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          storageService.savePRs(unique);
          return unique;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/prs fallback to storageService:', e.message);
    }
    const local = storageService.getPRs();
    const seenLocal = new Set();
    return (Array.isArray(local) ? local : []).filter(p => {
      const key = p.id || p.prNo;
      if (!key || seenLocal.has(key)) return false;
      seenLocal.add(key);
      return true;
    });
  },
  async getPOs(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetPOs');
          if (Array.isArray(data)) {
            const seen = new Set();
            const unique = data.filter(p => {
              const key = p.poNo || p.poNumber || p.id;
              if (!key || seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            storageService.savePOs(unique);
            return unique;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetPOs fallback:', e.message);
        }
      }
      return storageService.getPOs();
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('app_data_cleared') === 'true') {
      return storageService.getPOs();
    }
    try {
      const res = await fetch('/api/pos');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const seen = new Set();
          const unique = data.filter(p => {
            const key = p.poNo || p.poNumber || p.id;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          storageService.savePOs(unique);
          return unique;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/pos fallback to storageService:', e.message);
    }
    const local = storageService.getPOs();
    const seenLocal = new Set();
    return (Array.isArray(local) ? local : []).filter(p => {
      const key = p.poNo || p.poNumber || p.id;
      if (!key || seenLocal.has(key)) return false;
      seenLocal.add(key);
      return true;
    });
  },
  async getStockLogs(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetStockLogs');
          if (Array.isArray(data)) {
            storageService.saveStockLogs(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetStockLogs fallback:', e.message);
        }
      }
      return storageService.getStockLogs();
    }
    try {
      const res = await fetch('/api/stock-logs');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          storageService.saveStockLogs(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/stock-logs fallback to storageService:', e.message);
    }
    return storageService.getStockLogs();
  },
  async getBudgets(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetBudgets');
          if (data && typeof data === 'object') {
            storageService.saveBudgets(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetBudgets fallback:', e.message);
        }
      }
      return storageService.getBudgets();
    }
    try {
      const res = await fetch('/api/budgets');
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          storageService.saveBudgets(data);
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/budgets fallback to storageService:', e.message);
    }
    return storageService.getBudgets();
  },
  async getNotifications(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetNotifications');
          if (Array.isArray(data)) {
            storageService.saveNotifications(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetNotifications fallback:', e.message);
        }
      }
      return storageService.getNotifications();
    }
    try {
      const res = await fetch('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data;
        }
      }
    } catch (e) {
      console.warn('[apiService] GET /api/notifications fallback:', e.message);
    }
    return [];
  },
  
  async getBudgetTransactions(forceFetch = false) {
    if (isGAS()) {
      if (forceFetch) {
        try {
          const data = await callGAS('apiGetBudgetTransactions');
          if (Array.isArray(data)) {
            storageService.saveBudgetTransactions(data);
            return data;
          }
        } catch (e) {
          console.warn('[apiService] GAS apiGetBudgetTransactions fallback:', e.message);
        }
      }
      return storageService.getBudgetTransactions();
    }
    try {
      const res = await fetch('/api/budget-transactions');
      if (res.ok) {
        const data = await res.json();
        storageService.saveBudgetTransactions(data);
        return data;
      }
    } catch (e) {
      console.warn('[apiService] GET /api/budget-transactions fallback to storageService:', e.message);
    }
    return storageService.getBudgetTransactions();
  },

  async adjustBudget(params) {
    try {
      const res = await fetch('/api/budgets/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.budgets) storageService.saveBudgets(data.budgets);
        if (data.transactions) storageService.saveBudgetTransactions(data.transactions);
        return data;
      }
    } catch (e) {
      console.warn('[apiService] POST /api/budgets/adjust fallback to storageService:', e.message);
    }

    // Local fallback
    const { dept, action, newAmount, previousAmount, delta, reason, actor, targetMonth } = params;
    const budgets = storageService.getBudgets();
    if (!budgets[dept]) budgets[dept] = { monthlyBudget: 0, spent: 0, pending: 0, variance: 0, history: {}, historicalSpent: {} };
    const today = new Date();
    const currentActiveMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const monthKey = targetMonth || currentActiveMonth;

    // Strict Zero-based: Previous budget strictly refers to the same month's allocated history
    const prevInMonth = (budgets[dept]?.history && budgets[dept].history[monthKey] !== undefined && budgets[dept].history[monthKey] !== null)
      ? Number(budgets[dept].history[monthKey])
      : 0;
    const prev = previousAmount !== undefined ? Number(previousAmount) : prevInMonth;
    const finalAmount = action === 'TOP_UP' ? prev + Number(delta || 0) : Number(newAmount ?? prev);

    if (action === 'BUDGET_ROLLBACK') {
      const rollbackAmt = Number(delta || 0);
      const curSpent = previousAmount !== undefined ? Number(previousAmount) : Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
      const newSpent = newAmount !== undefined ? Number(newAmount) : Math.max(0, curSpent - rollbackAmt);
      budgets[dept].spent = newSpent;
      budgets[dept].actualExpense = newSpent;
      const monthlyAlloc = Number(budgets[dept].monthlyBudget) || 0;
      budgets[dept].variance = monthlyAlloc - newSpent;
      budgets[dept].remainingBudget = budgets[dept].variance;
      if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
      budgets[dept].refundCredits[monthKey] = (Number(budgets[dept].refundCredits[monthKey]) || 0) + rollbackAmt;
    } else {
      if (monthKey === '2026-09' || monthKey === currentActiveMonth) {
        budgets[dept].monthlyBudget = finalAmount;
        budgets[dept].variance = finalAmount - (Number(budgets[dept].spent) || 0);
        budgets[dept].remainingBudget = budgets[dept].variance;
      }
      if (!budgets[dept].history) budgets[dept].history = {};
      budgets[dept].history[monthKey] = finalAmount;
    }
    storageService.saveBudgets(budgets);

    const isInitial = (action === 'MONTHLY_ALLOCATION') || (prev === 0 && action !== 'BUDGET_ROLLBACK');
    let txType = action || 'ADJUST';
    let txTypeLabel = 'ปรับปรุงงบประมาณ';
    let amountDiff = 0;

    if (action === 'BUDGET_ROLLBACK') {
      txType = 'BUDGET_ROLLBACK';
      txTypeLabel = 'คืนงบประมาณ (Budget Reversal)';
      amountDiff = Number(delta || 0);
    } else if (isInitial) {
      txType = 'MONTHLY_ALLOCATION';
      txTypeLabel = 'จัดสรรงบประมาณประจำเดือน';
      amountDiff = finalAmount;
    } else if (action === 'TOP_UP') {
      txType = 'TOP_UP';
      txTypeLabel = 'เติมงบประมาณพิเศษ (Top-up)';
      amountDiff = Number(delta || 0);
    } else {
      txType = 'SET_BUDGET';
      txTypeLabel = (finalAmount - prev >= 0) ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดยอดงบประมาณ';
      amountDiff = finalAmount - prev;
    }

    const newTx = {
      id: `BTX-${Date.now()}`,
      date: today.toISOString().replace('T', ' ').slice(0, 19),
      createdAt: today.toISOString(),
      dept,
      type: txType,
      typeLabel: txTypeLabel,
      previousAmount: prev,
      newAmount: finalAmount,
      amount: amountDiff,
      actor: actor || 'Staff',
      note: reason || (txType === 'MONTHLY_ALLOCATION' ? `จัดสรรงบประมาณประจำเดือน ${monthKey}` : 'ปรับปรุงงบประมาณ'),
      targetMonth: monthKey,
      period: monthKey
    };
    storageService.appendBudgetTransaction(newTx);
    return { success: true, budget: budgets[dept], transaction: newTx, budgets };
  },

  async updateBudget(department, newAmount, targetMonth = null, actor = null, reason = null) {
    const today = new Date();
    const currentActiveMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const monthKey = targetMonth || currentActiveMonth;
    const budgets = await this.getBudgets();
    const deptObj = budgets[department] || {};
    // Strict Zero-based: Previous budget strictly refers to the same month's allocated history
    const prevInMonth = (deptObj.history && deptObj.history[monthKey] !== undefined && deptObj.history[monthKey] !== null)
      ? Number(deptObj.history[monthKey])
      : 0;
    const isInitial = prevInMonth === 0;
    const delta = isInitial ? Number(newAmount) : (Number(newAmount) - prevInMonth);
    const action = isInitial ? 'MONTHLY_ALLOCATION' : 'SET_BUDGET';

    return this.adjustBudget({
      dept: department,
      action,
      newAmount: Number(newAmount),
      previousAmount: prevInMonth,
      delta,
      reason: reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${monthKey}` : `ปรับปรุงงบประมาณประจำเดือน ${monthKey}`),
      actor: actor || 'ผู้ดูแลระบบ',
      targetMonth: monthKey
    });
  },

  // --- Budget & Over-Budget Check ---
  calculateBudgetSummary(targetMonthStr) {
    return workflowEngine.calculateBudgetSummary(targetMonthStr);
  },

  isOverBudget(department, amount) {
    return workflowEngine.isOverBudget(department, amount);
  },

  // --- PR Operations ---
  async createPR(prData, user, isDraft = false) {
    // 1. Generate new PR payload via workflow engine logic & validation
    const newPR = await workflowEngine.createPR(prData, user, isDraft);

    if (isGAS()) {
      try {
        const gasResult = await callGAS('apiCreatePR', sanitizePayloadForGAS(newPR), sanitizePayloadForGAS(user));
        if (gasResult && typeof gasResult === 'object') {
          const finalPR = Object.assign({}, newPR, gasResult);
          if (typeof finalPR.items === 'string') {
            try { finalPR.items = JSON.parse(finalPR.items); } catch (e) {}
          }
          try {
            if (storageService && typeof storageService.savePR === 'function') {
              storageService.savePR(finalPR);
            } else if (storageService && typeof storageService.upsertPR === 'function') {
              storageService.upsertPR(finalPR);
            }
          } catch (storageErr) {
            console.warn('[apiService] Storage sync non-blocking error in createPR:', storageErr);
          }
          return finalPR;
        }
        return newPR;
      } catch (e) {
        console.error('[apiService] GAS apiCreatePR error:', e.message);
        modalService.error('สร้างใบขอซื้อ (PR) ไม่สำเร็จ', e.message);
        throw e;
      }
    }

    // 2. Direct Sync to Local API Backend File
    try {
      const res = await fetch('/api/prs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPR)
      });
      if (res.ok) {
        const savedPR = await res.json();
        return savedPR || newPR;
      }
    } catch (e) {
      console.warn('[apiService] POST /api/prs backend sync warning:', e.message);
    }
    return newPR;
  },

  async updatePR(prId, prData, user, isDraft = false) {
    const updated = await workflowEngine.updatePR(prId, prData, user, isDraft);
    if (isGAS()) {
      try {
        const rpcName = !isDraft ? 'apiUpdatePR' : 'apiSavePR';
        const payloadToSend = sanitizePayloadForGAS({ ...updated, action: !isDraft ? 'RESUBMIT' : 'UPDATE' });
        const gasResult = await callGAS(rpcName, payloadToSend, sanitizePayloadForGAS(user));
        if (gasResult && typeof gasResult === 'object') {
          const finalPR = Object.assign({}, updated, gasResult);
          if (typeof finalPR.items === 'string') {
            try { finalPR.items = JSON.parse(finalPR.items); } catch (e) {}
          }
          try {
            if (storageService && typeof storageService.savePR === 'function') {
              storageService.savePR(finalPR);
            } else if (storageService && typeof storageService.upsertPR === 'function') {
              storageService.upsertPR(finalPR);
            }
          } catch (storageErr) {
            console.warn('[apiService] Storage sync non-blocking error in updatePR:', storageErr);
          }
          return finalPR;
        }
        return updated;
      } catch (e) {
        console.error(`[apiService] GAS updatePR error:`, e.message);
        modalService.error('แก้ไขใบขอซื้อ (PR) ไม่สำเร็จ', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/prs/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {}
    return updated;
  },

  async submitPR(prId, user, memoData = null) {
    const result = await workflowEngine.submitPR(prId, user, memoData);
    if (isGAS()) {
      try {
        await callGAS('apiUpdatePR', sanitizePayloadForGAS({ ...result, action: 'RESUBMIT' }), sanitizePayloadForGAS(user));
      } catch (e) {
        console.error('[apiService] GAS submitPR error:', e.message);
        modalService.error('ยื่นส่ง PR ไม่สำเร็จ', e.message);
        throw e;
      }
      return result;
    }
    try {
      await fetch(`/api/prs/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      });
    } catch (e) {}
    return result;
  },

  async updatePRStatus(prId, nextStatus, user, note = '') {
    const result = await workflowEngine.updatePRStatus(prId, nextStatus, user, note);
    if (isGAS()) {
      try {
        if (result?.pr) {
          const prPayload = sanitizePayloadForGAS({ ...result.pr, comment: note, reason: note });
          const userPayload = sanitizePayloadForGAS(user);
          let gasResult = null;
          if (nextStatus === 'REVIEWED') {
            gasResult = await callGAS('apiReviewPR', prPayload, userPayload);
          } else if (nextStatus === 'APPROVED') {
            gasResult = await callGAS('apiApprovePR', prPayload, userPayload);
          } else if (nextStatus === 'CANCELLED') {
            gasResult = await callGAS('apiCancelPR', prPayload, userPayload);
          } else {
            gasResult = await callGAS('apiSavePR', prPayload, userPayload);
          }
          if (gasResult && typeof gasResult === 'object') {
            const returnedPR = gasResult.data || gasResult;
            result.pr = Object.assign({}, result.pr, returnedPR);
            try {
              if (storageService && typeof storageService.savePR === 'function') {
                storageService.savePR(result.pr);
              }
            } catch (storageErr) {}
          }
        }
        if (result?.po) {
          const poList = Array.isArray(result.po) ? result.po : [result.po];
          for (const singlePo of poList) {
            await callGAS('apiCreatePO', sanitizePayloadForGAS(singlePo), sanitizePayloadForGAS(user));
          }
        }
      } catch (e) {
        console.error('[apiService] GAS updatePRStatus error:', e.message);
        modalService.error('ปรับสถานะ PR ไม่สำเร็จ', e.message);
        throw e;
      }
      return result;
    }
    try {
      if (result?.pr) {
        await fetch(`/api/prs/${prId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.pr)
        });
      }
      if (result?.po) {
        const poList = Array.isArray(result.po) ? result.po : [result.po];
        for (const singlePo of poList) {
          await fetch('/api/pos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(singlePo)
          });
        }
      }
    } catch (e) {}
    return result;
  },

  async rejectPR(prId, user, reason) {
    const updated = await workflowEngine.rejectPR(prId, user, reason);
    if (isGAS()) {
      try {
        const payloadToSend = sanitizePayloadForGAS({ ...updated, reason, rejectReason: reason, comment: reason });
        const gasResult = await callGAS('apiRejectPR', payloadToSend, sanitizePayloadForGAS(user));
        let finalPR = updated;
        if (gasResult && typeof gasResult === 'object') {
          finalPR = Object.assign({}, updated, gasResult.data || gasResult);
        }
        try {
          if (storageService && typeof storageService.savePR === 'function') {
            storageService.savePR(finalPR);
          }
        } catch (storageErr) {}
        return finalPR;
      } catch (e) {
        console.error('[apiService] GAS apiRejectPR error:', e.message);
        modalService.error('ปฏิเสธ PR ไม่สำเร็จ', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/prs/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {}
    return updated;
  },

  async editPRItems(prId, items, user, reason = '') {
    const updated = await workflowEngine.editPRItems(prId, items, user, reason);
    if (isGAS()) {
      try {
        const gasResult = await callGAS('apiSavePR', sanitizePayloadForGAS(updated), sanitizePayloadForGAS(user));
        let finalPR = updated;
        if (gasResult && typeof gasResult === 'object') {
          finalPR = Object.assign({}, updated, gasResult.data || gasResult);
        }
        try {
          if (storageService && typeof storageService.savePR === 'function') {
            storageService.savePR(finalPR);
          }
        } catch (storageErr) {}
        return finalPR;
      } catch (e) {
        console.error('[apiService] GAS apiSavePR error:', e.message);
        modalService.error('แก้ไขรายการ PR ไม่สำเร็จ', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/prs/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {}
    return updated;
  },

  async cancelPR(prId, user, reason) {
    const cancelled = await workflowEngine.cancelPR(prId, user, reason);
    if (isGAS()) {
      try {
        const payloadToSend = sanitizePayloadForGAS({ ...cancelled, reason, comment: reason });
        const gasResult = await callGAS('apiCancelPR', payloadToSend, sanitizePayloadForGAS(user));
        let finalPR = cancelled;
        if (gasResult && typeof gasResult === 'object') {
          finalPR = Object.assign({}, cancelled, gasResult.data || gasResult);
        }
        try {
          if (storageService && typeof storageService.savePR === 'function') {
            storageService.savePR(finalPR);
          }
        } catch (storageErr) {}
        return finalPR;
      } catch (e) {
        console.error('[apiService] GAS apiCancelPR error:', e.message);
        modalService.error('ยกเลิก PR ไม่สำเร็จ', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/prs/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelled)
      });
    } catch (e) {}
    return cancelled;
  },

  async cancelPO(poId, user, reason) {
    const cancelled = await workflowEngine.cancelPO(poId, user, reason);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', cancelled, user);
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        modalService.error('ยกเลิก PO ไม่สำเร็จ', e.message);
        throw e;
      }
      return cancelled;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelled)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return cancelled;
  },

  async acknowledgeOnlineTask(poId, vendorName, user, updatedItems = null, varianceNote = '') {
    const updated = await workflowEngine.acknowledgeOnlineTask(poId, vendorName, user, updatedItems, varianceNote);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', updated);
      } catch (e) {
        console.warn('[apiService] GAS apiSavePO error:', e.message);
      }
      return updated;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return updated;
  },

  async confirmOnlineOrder(poId, vendorName, user, updatedItems = null, varianceNote = '') {
    return this.acknowledgeOnlineTask(poId, vendorName, user, updatedItems, varianceNote);
  },

  async resetPOQC2026001() {
    const res = storageService.resetPOQC2026001();
    if (res) {
      try {
        await fetch(`/api/pos/${res.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(res)
        });
      } catch (e) {
        console.warn('[apiService] Backend PUT fallback:', e.message);
      }
    }
    return res;
  },

  async resetMockTransactions(options) {
    return resetMockTransactions(options);
  },

  async clearMockTransactions(options) {
    return resetMockTransactions(options);
  },

  // --- PO & Receive Goods Operations ---
  async assignVendor(poId, vendorId, customVendorName, user) {
    const updated = await workflowEngine.assignVendor(poId, vendorId, customVendorName, user);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', updated, user);
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        modalService.error('มอบหมายผู้ขายไม่สำเร็จ', e.message);
        throw e;
      }
      return updated;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return updated;
  },

  // Generic claim filing — supports both ONLINE and SELF-BUY channels
  async fileClaim(poId, claimData, user) {
    const updated = await workflowEngine.fileClaim(poId, claimData, user);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', updated, user);
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        modalService.error('ยื่นเคลมพัสดุไม่สำเร็จ', e.message);
        throw e;
      }
      return updated;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return updated;
  },
  async fileOnlineClaim(poId, claimData, user) {
    return this.fileClaim(poId, claimData, user);
  },

  // Generic claim resolution — supports both ONLINE and SELF-BUY channels
  async resolveClaim(poId, resolution, user) {
    const resolved = await workflowEngine.resolveClaim(poId, resolution, user);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', resolved, user);

        // --- TRIGGER ACTUAL SPENT BUDGET TRANSACTION ---
        if (['CLOSE_WITH_REFUND', 'REFUND', 'CANCEL'].includes(resolution.type) && resolved.refundAmount > 0) {
          const refundAmt = Math.round(Number(resolved.refundAmount) * 100) / 100;
          const refPo = resolved.poNo || resolved.poNumber || resolved.id;
          const localTxs = storageService.getBudgetTransactions() || [];
          const targetTx = localTxs.slice().reverse().find(tx => tx.poNumber === refPo && tx.refundAmount === refundAmt);
          if (targetTx) {
            await callGAS('apiAppendBudgetTransaction', targetTx, user).catch(e => {
              console.warn('[apiService] Backend budget sync warning:', e.message);
            });
          }
        }
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        modalService.error('บันทึกผลการเคลมไม่สำเร็จ', e.message);
        throw e;
      }
      return resolved;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolved)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return resolved;
  },
  async resolveOnlineClaim(poId, resolution, user) {
    return this.resolveClaim(poId, resolution, user);
  },

  async updatePOStatus(poId, nextStatus, user, note = '') {
    const updated = await workflowEngine.updatePOStatus(poId, nextStatus, user, note);
    if (isGAS()) {
      try {
        await callGAS('apiSavePO', updated, user);
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        modalService.error('ปรับสถานะ PO ไม่สำเร็จ', e.message);
        throw e;
      }
      return updated;
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return updated;
  },

  async updateActualPrice(poId, itemIndex, actPrice, user) {
    return workflowEngine.updateActualPrice(poId, itemIndex, actPrice, user);
  },

  async closePO(poId, user, note = '') {
    return workflowEngine.closePO(poId, user, note);
  },

  // Update PO document attributes, status, and line items atomically
  async updatePO(poId, poData, user) {
    const pos = storageService.getPOs() || [];
    const idx = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    let updated = poData;
    if (idx !== -1) {
      updated = { ...pos[idx], ...poData };
      pos[idx] = updated;
      storageService.savePOs(pos);
    }
    if (isGAS()) {
      try {
        const gasResult = await callGAS('apiSavePO', updated, user);
        return gasResult || updated;
      } catch (e) {
        console.error('[apiService] GAS apiSavePO error:', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/pos/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
    } catch (e) {
      console.warn('[apiService] Backend PUT /api/pos/:id fallback:', e.message);
    }
    return updated;
  },

  // Online PO Settlement & Cost Reconciliation
  async settlePO(poId, settlementData, user) {
    const updated = await workflowEngine.settlePO(poId, settlementData, user);
    if (isGAS()) {
      try {
        const gasResult = await callGAS('apiSettlePO', sanitizePayloadForGAS({
          poId,
          ...settlementData
        }), sanitizePayloadForGAS(user));
        if (gasResult && gasResult.success && gasResult.data) {
          return gasResult.data;
        }
      } catch (e) {
        console.error('[apiService] GAS apiSettlePO error:', e.message);
        modalService.error('ปิดยอดจ่ายจริงไม่สำเร็จ', e.message);
        throw e;
      }
    }
    try {
      await fetch(`/api/pos/${poId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settlementData, user })
      });
    } catch (e) {
      console.warn('[apiService] Backend POST /api/pos/:id/settle fallback:', e.message);
    }
    return updated;
  },

  // Partial or Full goods receiving — handles PARTIAL → CLOSED transitions
  async receiveGoods(poId, receivingItems, user, note = '', options = {}) {
    const grNumber = options.grNumber || options.grId || `GR-${poId}-${Date.now()}`;
    const payload = {
      poId,
      receivingItems,
      user,
      note,
      options: { ...options, grNumber, grId: grNumber },
      grNumber
    };

    if (isGAS()) {
      return workflowEngine.receiveGoods(poId, receivingItems, user, note, { ...options, grNumber, grId: grNumber });
    }

    try {
      const res = await fetch(`/api/pos/${poId}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        if (data.po) {
          const currentPOs = storageService.getPOs();
          const updatedPOs = currentPOs.map(p => p.id === data.po.id ? data.po : p);
          storageService.savePOs(updatedPOs);
        }
        if (data.products) {
          storageService.saveProducts(data.products);
        }
        if (data.stockLogs) {
          storageService.saveStockLogs(data.stockLogs);
        }
        if (data.budgets) {
          storageService.saveBudgets(data.budgets);
        }
        return { ...(data.po || {}), backendData: data };
      } else if (res.status === 404) {
        // PO not in backend disk (e.g. Vitest in-memory test environment) -> fallback to workflowEngine
        return workflowEngine.receiveGoods(poId, receivingItems, user, note, { ...options, grNumber, grId: grNumber });
      } else {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP error ${res.status}`);
      }
    } catch (e) {
      if (e.message && !e.message.includes('fetch') && !e.message.includes('Failed to fetch')) {
        throw e; // Validation errors from backend should be thrown to the user
      }
      console.warn('[apiService] Backend receive offline, falling back to workflowEngine:', e.message);
      return workflowEngine.receiveGoods(poId, receivingItems, user, note, { ...options, grNumber, grId: grNumber });
    }
  },

  async receiveAllGoods(poId, user, note = '', options = {}) {
    // Convenience wrapper: build receivingItems from all remaining quantities
    const pos = await this.getPOs();
    const po = pos.find(p => p.id === poId);
    if (!po) throw new Error('PO not found');
    const receivingItems = po.items.map(item => ({
      productId: item.productId,
      receivedThisTime: Number(item.orderedQty ?? item.purchaseQty ?? item.qty) - (Number(item.receivedQty) || 0)
    }));
    return workflowEngine.receiveGoods(poId, receivingItems, user, note, options);
  },

  // Short-Close PO (ปิด PO ก่อนกำหนดเมื่อได้ของไม่ครบและไม่รอของแล้ว)
  async shortClosePO(poId, reason, user) {
    return workflowEngine.shortClosePO(poId, reason, user);
  },

  // --- Quick Issue Stock (เบิกจ่ายสินค้า) ---
  async issueStock(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('VALIDATION_ERROR: ข้อมูลการเบิกจ่ายไม่ถูกต้อง');
    }

    const productId = payload.productId || payload.id;
    const rawQty = payload.quantity !== undefined ? payload.quantity : (payload.qty !== undefined ? payload.qty : payload.issueQty);
    const quantity = Math.abs(Number(rawQty));
    if (isNaN(quantity) || quantity <= 0) {
      throw new Error('จำนวนที่เบิกจ่ายไม่ถูกต้อง');
    }

    const productCode = payload.productCode || payload.code || payload.sku;
    const department = payload.department || payload.category;
    const issuedTo = payload.issuedTo || payload.issueUnit || payload.unitName || '';
    const reason = payload.reason || payload.note || 'เบิกจ่ายด่วน';
    const requesterId = payload.requesterId || payload.userId || (payload.user && (payload.user.id || payload.user.username)) || '';
    const requesterName = payload.requesterName || payload.userName || (payload.user && (payload.user.name || payload.user.displayName)) || issuedTo || '';
    const user = payload.user || { id: requesterId, name: requesterName, department };

    let gasResult = null;
    if (isGAS()) {
      try {
        const gasPayload = {
          productId,
          productCode,
          department,
          quantity,
          issuedTo,
          reason,
          requesterId,
          requesterName
        };
        gasResult = await callGAS('apiIssueStock', gasPayload);
      } catch (gasErr) {
        console.error('[apiService] apiIssueStock GAS error:', gasErr);
        throw gasErr;
      }
    }

    // Update workflow engine & storageService for immediate local state
    const updatedProduct = await workflowEngine.quickIssueStock(
      productId,
      quantity,
      user,
      reason,
      issuedTo
    );

    // Sync with local express backend if in dev/express mode
    try {
      if (updatedProduct && !isGAS()) {
        await fetch(`/api/products/${productId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedProduct)
        }).catch(() => {});
      }
      const logs = storageService.getStockLogs();
      if (logs && logs.length > 0 && !isGAS()) {
        await fetch('/api/stock-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(logs)
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('[apiService] issueStock backend sync warning:', e.message);
    }

    try {
      const pName = updatedProduct?.name || gasResult?.updatedProduct?.name || productId;
      const pUnit = updatedProduct?.stockUnit || updatedProduct?.unit || 'ชิ้น';
      const uUnit = issuedTo ? ` ให้${issuedTo}` : '';
      auditService.logAction({
        action: 'STOCK_ISSUE',
        actor: user,
        department: updatedProduct?.category || department || 'PD',
        docNo: updatedProduct?.code || productCode || productId,
        docType: 'STOCK',
        details: `เบิกจ่ายพัสดุ: ${pName} จำนวน ${quantity} ${pUnit}${uUnit}`
      });
    } catch (auditErr) {
      console.warn('[apiService] issueStock audit error:', auditErr);
    }

    const latestLogs = storageService.getStockLogs();
    const finalLog = gasResult?.logEntry || (latestLogs && latestLogs[0]);

    return {
      success: true,
      updatedProduct: gasResult?.updatedProduct || updatedProduct,
      product: gasResult?.updatedProduct || updatedProduct,
      logEntry: finalLog
    };
  },

  async quickIssueStock(productId, issueQty, user, note = '', issueUnit = '') {
    const products = storageService.getProducts();
    const prod = products.find(p => p.id === productId || p.code === productId);
    const payload = {
      productId: prod?.id || productId,
      productCode: prod?.code,
      department: prod?.department || prod?.category || user?.department,
      quantity: issueQty,
      issuedTo: issueUnit,
      reason: note,
      requesterId: user?.id || user?.username,
      requesterName: user?.name,
      user
    };
    const res = await this.issueStock(payload);
    return res.updatedProduct || res.product;
  },

  // --- Master Data CRUD ---
  async saveProduct(product, user = null) {
    const products = await this.getProducts();
    const isUpdate = Boolean(product.id && product._mode !== 'CREATE');
    const targetCode = String(product.code || product.sku || '').trim().toUpperCase();
    const rawCat = product.category || product.department || 'PD';
    const cat = String(rawCat).replace(/^DEPT-/, '').trim().toUpperCase() || 'PD';
    product.category = cat;
    product.department = cat;
    product.dept = cat;

    if (targetCode) {
      const isDuplicate = products.some(p => {
        const pId = String(p.id || '').trim();
        const pCode = String(p.code || p.sku || '').trim().toUpperCase();
        if (isUpdate && product.id && pId === String(product.id).trim()) return false;
        const isSameDept = matchDepartment(p.department || p.category || p.dept, cat);
        return isSameDept && pCode === targetCode;
      });
      if (isDuplicate) {
        throw new Error(`รหัสสินค้านี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น (${targetCode})`);
      }
    }

    if (!product.id) {
      product.id = `PROD-${cat}-${Date.now()}`;
    }

    if (isGAS()) {
      const saved = await callGAS('apiSaveMasterItem', 'Products', product);
      const savedProduct = (saved && typeof saved === 'object' && saved.id) ? saved : product;
      const targetId = String(savedProduct.id || '').trim().toLowerCase();
      const targetCode = String(savedProduct.code || savedProduct.sku || '').trim().toLowerCase();
      const updatedList = isUpdate 
        ? products.map(p => {
            const pId = String(p.id || '').trim().toLowerCase();
            const pCode = String(p.code || p.sku || '').trim().toLowerCase();
            const isSameDept = matchDepartment(p.department || p.category || p.dept, cat);
            return (pId === targetId || (isSameDept && pCode === targetCode)) ? savedProduct : p;
          }) 
        : [savedProduct, ...products];
      storageService.saveProducts(updatedList);
      
      auditService.logAction({
        action: isUpdate ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED',
        actor: user || 'Admin / Master Manager',
        department: savedProduct.category || 'PD',
        docNo: savedProduct.code || savedProduct.id,
        docType: 'PRODUCT',
        details: `${isUpdate ? 'แก้ไขข้อมูลสินค้า' : 'เพิ่มสินค้าใหม่'}: [${savedProduct.code || savedProduct.sku || savedProduct.id}] ${savedProduct.name}`
      });

      return savedProduct;
    }

    try {
      const url = isUpdate ? `/api/products/${encodeURIComponent(product.id)}` : '/api/products';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product)
      });
      if (res.ok) {
        const resData = await res.json();
        const saved = (resData && (resData.id || resData.code) && resData.name)
          ? { ...product, ...resData }
          : product;
        const targetId = String(product.id || '').trim().toLowerCase();
        const targetCode = String(product.code || '').trim().toLowerCase();
        const updatedList = isUpdate 
          ? products.map(p => {
              const pId = String(p.id || '').trim().toLowerCase();
              const pCode = String(p.code || '').trim().toLowerCase();
              const isSameDept = matchDepartment(p.department || p.category || p.dept, cat);
              return (pId === targetId || (isSameDept && pCode === targetCode)) ? saved : p;
            }) 
          : [saved, ...products];
        storageService.saveProducts(updatedList);
        
        auditService.logAction({
          action: isUpdate ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED',
          actor: user || 'Admin / Master Manager',
          department: product.category,
          docNo: product.code || product.id,
          docType: 'PRODUCT',
          details: `${isUpdate ? 'แก้ไขข้อมูลสินค้า' : 'เพิ่มสินค้าใหม่'}: [${product.code || product.sku || product.id}] ${product.name}`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveProduct API error, falling back:', e.message);
    }

    if (isUpdate) {
      const targetId = String(product.id || '').trim().toLowerCase();
      const targetCode = String(product.code || '').trim().toLowerCase();
      const idx = products.findIndex(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        const pCode = String(p.code || '').trim().toLowerCase();
        const isSameDept = matchDepartment(p.department || p.category || p.dept, cat);
        return (targetId && pId === targetId) || (isSameDept && targetCode && pCode === targetCode);
      });
      if (idx !== -1) products[idx] = { ...products[idx], ...product };
      else products.unshift(product);
    } else {
      products.unshift(product);
    }
    storageService.saveProducts(products);

    auditService.logAction({
      action: isUpdate ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED',
      actor: user || 'Admin / Master Manager',
      department: product.category,
      docNo: product.code || product.id,
      docType: 'PRODUCT',
      details: `${isUpdate ? 'แก้ไขข้อมูลสินค้า' : 'เพิ่มสินค้าใหม่'}: [${product.code || product.sku || product.id}] ${product.name}`
    });

    return product;
  },

  async deleteProduct(productId, user = null) {
    const targetStr = String(productId || '').trim().toLowerCase();

    if (isGAS()) {
      try {
        await callGAS('apiDeleteMasterItem', 'Products', productId);
      } catch (e) {
        console.warn('[apiService] GAS apiDeleteMasterItem error:', e.message);
      }
      const currentProducts = storageService.getProducts();
      const filtered = currentProducts.filter(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        const pCode = String(p.code || '').trim().toLowerCase();
        return pId !== targetStr && pCode !== targetStr;
      });
      storageService.saveProducts(filtered);

      auditService.logAction({
        action: 'PRODUCT_DELETED',
        actor: typeof user === 'object' ? (user?.name || user?.username || 'Admin') : (user || 'Admin / Master Manager'),
        docNo: productId,
        docType: 'PRODUCT',
        details: `ลบรายการสินค้า: [${productId}] ออกจากระบบ`
      });

      return true;
    }

    try {
      await fetch(`/api/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
    } catch (e) {
      console.warn('[apiService] Backend deleteProduct offline or failed:', e);
    }
    const currentProducts = storageService.getProducts();
    const filtered = currentProducts.filter(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || '').trim().toLowerCase();
      return pId !== targetStr && pCode !== targetStr;
    });
    storageService.saveProducts(filtered);

    auditService.logAction({
      action: 'PRODUCT_DELETED',
      actor: typeof user === 'object' ? (user?.name || user?.username || 'Admin') : (user || 'Admin / Master Manager'),
      docNo: productId,
      docType: 'PRODUCT',
      details: `ลบรายการสินค้า: [${productId}] ออกจากระบบ`
    });

    return true;
  },

  async saveVendor(vendor, user = null) {
    const vendors = await this.getVendors();
    const isUpdate = Boolean(vendor.id);
    const targetCode = String(vendor.code || vendor.vendorCode || vendor.id || '').trim().toUpperCase();
    const targetDept = String(vendor.department || 'ALL').trim().toUpperCase();
    if (targetCode) {
      const isDuplicate = vendors.some(v => {
        if (String(v.id || '') === String(vendor.id || '')) return false;
        const vCode = String(v.code || v.vendorCode || v.id || '').trim().toUpperCase();
        if (vCode !== targetCode) return false;
        const vDept = String(v.department || 'ALL').trim().toUpperCase();
        return (targetDept === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, targetDept));
      });
      if (isDuplicate) {
        throw new Error(`รหัสผู้ขาย "${targetCode}" มีอยู่ในระบบแล้ว กรุณาระบุรหัสผู้ขายอื่น`);
      }
    }

    if (!vendor.id) {
      vendor.id = `VEN-${Date.now()}`;
    }

    if (isGAS()) {
      const saved = await callGAS('apiSaveMasterItem', 'Vendors', vendor);
      const savedVendor = (saved && typeof saved === 'object' && saved.id) ? saved : vendor;
      const targetId = String(savedVendor.id || '').trim().toLowerCase();
      const targetCode = String(savedVendor.code || '').trim().toLowerCase();
      const updatedList = isUpdate 
        ? vendors.map(v => {
            const vId = String(v.id || '').trim().toLowerCase();
            const vCode = String(v.code || '').trim().toLowerCase();
            const vDept = String(v.department || 'ALL').trim().toUpperCase();
            const isSameScope = (targetDept === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, targetDept));
            return (vId === targetId || (isSameScope && vCode === targetCode)) ? savedVendor : v;
          }) 
        : [savedVendor, ...vendors];
      storageService.saveVendors(updatedList);
      
      auditService.logAction({
        action: isUpdate ? 'VENDOR_UPDATED' : 'VENDOR_CREATED',
        actor: user || 'Admin / Vendor Manager',
        department: savedVendor.category || 'ALL',
        docNo: savedVendor.code || savedVendor.id,
        docType: 'VENDOR',
        details: `${isUpdate ? 'ปรับปรุงข้อมูลผู้ขาย' : 'เพิ่มผู้ขายรายใหม่'} "${savedVendor.name}" (${savedVendor.code || savedVendor.id})`
      });

      return savedVendor;
    }

    try {
      const url = isUpdate ? `/api/vendors/${encodeURIComponent(vendor.id)}` : '/api/vendors';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vendor)
      });
      if (res.ok) {
        const resData = await res.json();
        const saved = (resData && (resData.id || resData.code) && resData.name)
          ? { ...vendor, ...resData }
          : vendor;
        const targetId = String(vendor.id || '').trim().toLowerCase();
        const targetCode = String(vendor.code || '').trim().toLowerCase();
        const updatedList = isUpdate 
          ? vendors.map(v => {
              const vId = String(v.id || '').trim().toLowerCase();
              const vCode = String(v.code || '').trim().toLowerCase();
              const vDept = String(v.department || 'ALL').trim().toUpperCase();
              const isSameScope = (targetDept === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, targetDept));
              return (vId === targetId || (isSameScope && vCode === targetCode)) ? saved : v;
            }) 
          : [saved, ...vendors];
        storageService.saveVendors(updatedList);
        
        auditService.logAction({
          action: isUpdate ? 'VENDOR_UPDATED' : 'VENDOR_CREATED',
          actor: user || 'Admin / Vendor Manager',
          department: vendor.category || 'ALL',
          docNo: vendor.code || vendor.id,
          docType: 'VENDOR',
          details: `${isUpdate ? 'ปรับปรุงข้อมูลผู้ขาย' : 'เพิ่มผู้ขายรายใหม่'} "${vendor.name}" (${vendor.code || vendor.id})`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveVendor API fallback:', e.message);
    }

    if (isUpdate) {
      const targetId = String(vendor.id || '').trim().toLowerCase();
      const targetCode = String(vendor.code || '').trim().toLowerCase();
      const idx = vendors.findIndex(v => {
        const vId = String(v.id || '').trim().toLowerCase();
        const vCode = String(v.code || '').trim().toLowerCase();
        const vDept = String(v.department || 'ALL').trim().toUpperCase();
        const isSameScope = (targetDept === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, targetDept));
        return (targetId && vId === targetId) || (isSameScope && targetCode && vCode === targetCode);
      });
      if (idx !== -1) vendors[idx] = vendor;
      else vendors.unshift(vendor);
    } else {
      vendors.unshift(vendor);
    }
    storageService.saveVendors(vendors);

    auditService.logAction({
      action: isUpdate ? 'VENDOR_UPDATED' : 'VENDOR_CREATED',
      actor: user || 'Admin / Vendor Manager',
      department: vendor.category || 'ALL',
      docNo: vendor.code || vendor.id,
      docType: 'VENDOR',
      details: `${isUpdate ? 'ปรับปรุงข้อมูลผู้ขาย' : 'เพิ่มผู้ขายรายใหม่'} "${vendor.name}" (${vendor.code || vendor.id})`
    });

    return vendor;
  },

  async deleteVendor(vendorId, user = null) {
    const targetStr = String(vendorId || '').trim().toLowerCase();

    if (isGAS()) {
      try {
        await callGAS('apiDeleteMasterItem', 'Vendors', vendorId);
      } catch (e) {
        console.warn('[apiService] GAS apiDeleteMasterItem error:', e.message);
      }
      const currentVendors = storageService.getVendors();
      const filtered = currentVendors.filter(v => {
        const vId = String(v.id || '').trim().toLowerCase();
        const vCode = String(v.code || '').trim().toLowerCase();
        return vId !== targetStr && vCode !== targetStr;
      });
      storageService.saveVendors(filtered);

      auditService.logAction({
        action: 'VENDOR_DELETED',
        actor: typeof user === 'object' ? (user?.name || user?.username || 'Admin') : (user || 'Admin / Master Manager'),
        docNo: vendorId,
        docType: 'VENDOR',
        details: `ลบข้อมูลผู้จัดจำหน่าย "${vendorId}" ออกจากระบบ`
      });

      return true;
    }

    try {
      await fetch(`/api/vendors/${encodeURIComponent(vendorId)}`, { method: 'DELETE' });
    } catch (e) {
      console.warn('[apiService] Backend deleteVendor offline or failed:', e);
    }
    const currentVendors = storageService.getVendors();
    const filtered = currentVendors.filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      return vId !== targetStr && vCode !== targetStr;
    });
    storageService.saveVendors(filtered);

    auditService.logAction({
      action: 'VENDOR_DELETED',
      actor: typeof user === 'object' ? (user?.name || user?.username || 'Admin') : (user || 'Admin / Master Manager'),
      docNo: vendorId,
      docType: 'VENDOR',
      details: `ลบข้อมูลผู้จัดจำหน่าย "${vendorId}" ออกจากระบบ`
    });

    return true;
  },

  async saveStorageLocation(location, user = null) {
    const locations = await this.getStorageLocations();
    const isUpdate = Boolean(location.id);
    const targetName = (location.name || '').trim().toLowerCase();

    if (targetName) {
      const isDuplicate = locations.some(l => l.id !== location.id && (l.name || '').trim().toLowerCase() === targetName);
      if (isDuplicate) {
        throw new Error(`ชื่อจุดจัดเก็บ "${location.name}" มีอยู่ในระบบแล้ว กรุณาระบุชื่ออื่น`);
      }
    }

    if (!location.id) {
      const dept = location.department || 'ALL';
      location.id = `LOC-${dept}-${Date.now().toString().slice(-6)}`;
    }

    if (isGAS()) {
      const saved = await callGAS('apiSaveMasterItem', 'StorageLocations', location);
      const savedLoc = (saved && typeof saved === 'object' && saved.id) ? saved : location;
      const updatedList = isUpdate ? locations.map(l => l.id === location.id ? savedLoc : l) : [savedLoc, ...locations];
      storageService.saveStorageLocations(updatedList);
      
      auditService.logAction({
        action: isUpdate ? 'LOCATION_UPDATED' : 'LOCATION_CREATED',
        actor: user || 'Admin / Warehouse Manager',
        department: savedLoc.department || 'ALL',
        docNo: savedLoc.id,
        docType: 'LOCATION',
        details: `${isUpdate ? 'แก้ไขจุดจัดเก็บ' : 'เพิ่มจุดจัดเก็บใหม่'} "${savedLoc.name}" (${savedLoc.department || 'ALL'})`
      });

      return savedLoc;
    }

    try {
      const url = isUpdate ? `/api/storage-locations/${location.id}` : '/api/storage-locations';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(location)
      });
      if (res.ok) {
        const saved = await res.json();
        const updatedList = isUpdate ? locations.map(l => l.id === location.id ? saved : l) : [saved, ...locations];
        storageService.saveStorageLocations(updatedList);
        
        auditService.logAction({
          action: isUpdate ? 'LOCATION_UPDATED' : 'LOCATION_CREATED',
          actor: user || 'Admin / Warehouse Manager',
          department: location.department || 'ALL',
          docNo: saved.id,
          docType: 'LOCATION',
          details: `${isUpdate ? 'แก้ไขจุดจัดเก็บ' : 'เพิ่มจุดจัดเก็บใหม่'} "${saved.name}" (${saved.department || 'ALL'})`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveStorageLocation API fallback:', e.message);
    }

    const saved = storageService.saveStorageLocation(location);

    auditService.logAction({
      action: isUpdate ? 'LOCATION_UPDATED' : 'LOCATION_CREATED',
      actor: user || 'Admin / Warehouse Manager',
      department: location.department || 'ALL',
      docNo: saved.id,
      docType: 'LOCATION',
      details: `${isUpdate ? 'แก้ไขจุดจัดเก็บ' : 'เพิ่มจุดจัดเก็บใหม่'} "${saved.name}" (${saved.department || 'ALL'})`
    });

    return saved;
  },

  async deleteStorageLocation(locationId, options = {}, user = null) {
    if (isGAS()) {
      try {
        await callGAS('apiDeleteMasterItem', 'StorageLocations', locationId);
      } catch (e) {
        console.warn('[apiService] GAS apiDeleteMasterItem error:', e.message);
      }
      const locations = storageService.getStorageLocations();
      const loc = locations.find(l => l.id === locationId);
      storageService.deleteStorageLocation(locationId, options);

      if (loc) {
        auditService.logAction({
          action: 'LOCATION_DELETED',
          actor: user || 'Admin / Warehouse Manager',
          department: loc.department || 'ALL',
          docNo: loc.id,
          docType: 'LOCATION',
          details: `ลบจุดจัดเก็บสินค้า "${loc.name}" ออกจากระบบ${options.unlinkProducts ? ' (ปลดสินค้าที่ผูกอยู่ออก)' : options.reassignToLocationId ? ' (ย้ายสินค้าไปยังจุดจัดเก็บใหม่)' : ''}`
        });
      }

      return true;
    }

    try {
      await fetch(`/api/storage-locations/${locationId}`, { method: 'DELETE' });
    } catch (e) {}
    const locations = storageService.getStorageLocations();
    const loc = locations.find(l => l.id === locationId);
    storageService.deleteStorageLocation(locationId, options);

    if (loc) {
      auditService.logAction({
        action: 'LOCATION_DELETED',
        actor: user || 'Admin / Warehouse Manager',
        department: loc.department || 'ALL',
        docNo: loc.id,
        docType: 'LOCATION',
        details: `ลบจุดจัดเก็บสินค้า "${loc.name}" ออกจากระบบ${options.unlinkProducts ? ' (ปลดสินค้าที่ผูกอยู่ออก)' : options.reassignToLocationId ? ' (ย้ายสินค้าไปยังจุดจัดเก็บใหม่)' : ''}`
      });
    }

    return true;
  },

  async saveUsageUnit(unit, user = null) {
    const isUpdate = Boolean(unit.id);
    const units = storageService.getUsageUnits();

    // Check duplicate name in same department
    const isDuplicate = units.some(u => 
      u.name.trim().toLowerCase() === unit.name.trim().toLowerCase() &&
      u.department === unit.department &&
      u.id !== unit.id
    );

    if (isDuplicate) {
      throw new Error(`ชื่อหน่วย/ห้อง "${unit.name}" มีอยู่ในแผนก ${unit.department} แล้ว`);
    }

    if (!unit.id) {
      const dept = unit.department || 'PD';
      unit.id = `UNIT-${dept}-${Date.now().toString().slice(-6)}`;
    }

    if (isGAS()) {
      const saved = await callGAS('apiSaveMasterItem', 'UsageUnits', unit);
      const savedUnit = (saved && typeof saved === 'object' && saved.id) ? saved : unit;
      const updatedList = isUpdate ? units.map(u => u.id === unit.id ? savedUnit : u) : [...units, savedUnit];
      storageService.saveUsageUnits(updatedList);

      auditService.logAction({
        action: isUpdate ? 'USAGE_UNIT_UPDATED' : 'USAGE_UNIT_CREATED',
        actor: user || 'Admin / Department Manager',
        department: savedUnit.department || 'PD',
        docNo: savedUnit.id,
        docType: 'USAGE_UNIT',
        details: `${isUpdate ? 'แก้ไขหน่วยเบิกใช้งาน' : 'เพิ่มหน่วยเบิกใช้งานใหม่'} "${savedUnit.name}" (${savedUnit.department})`
      });

      return savedUnit;
    }

    try {
      const url = isUpdate ? `/api/usage-units/${unit.id}` : '/api/usage-units';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unit)
      });
      if (res.ok) {
        const saved = await res.json();
        const updatedList = isUpdate ? units.map(u => u.id === unit.id ? saved : u) : [...units, saved];
        storageService.saveUsageUnits(updatedList);

        auditService.logAction({
          action: isUpdate ? 'USAGE_UNIT_UPDATED' : 'USAGE_UNIT_CREATED',
          actor: user || 'Admin / Department Manager',
          department: unit.department || 'PD',
          docNo: saved.id,
          docType: 'USAGE_UNIT',
          details: `${isUpdate ? 'แก้ไขหน่วยเบิกใช้งาน' : 'เพิ่มหน่วยเบิกใช้งานใหม่'} "${saved.name}" (${saved.department})`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveUsageUnit API fallback:', e.message);
    }

    const saved = storageService.saveUsageUnit(unit);

    auditService.logAction({
      action: isUpdate ? 'USAGE_UNIT_UPDATED' : 'USAGE_UNIT_CREATED',
      actor: user || 'Admin / Department Manager',
      department: unit.department || 'PD',
      docNo: saved.id,
      docType: 'USAGE_UNIT',
      details: `${isUpdate ? 'แก้ไขหน่วยเบิกใช้งาน' : 'เพิ่มหน่วยเบิกใช้งานใหม่'} "${saved.name}" (${saved.department})`
    });

    return saved;
  },

  async deleteUsageUnit(unitId, user = null) {
    if (isGAS()) {
      try {
        await callGAS('apiDeleteMasterItem', 'UsageUnits', unitId);
      } catch (e) {
        console.warn('[apiService] GAS apiDeleteMasterItem error:', e.message);
      }
      const units = storageService.getUsageUnits();
      const unit = units.find(u => u.id === unitId);
      storageService.deleteUsageUnit(unitId);

      if (unit) {
        auditService.logAction({
          action: 'USAGE_UNIT_DELETED',
          actor: user || 'Admin / Department Manager',
          department: unit.department || 'PD',
          docNo: unit.id,
          docType: 'USAGE_UNIT',
          details: `ลบหน่วยเบิกใช้งาน "${unit.name}" (${unit.department}) ออกจากระบบ`
        });
      }

      return true;
    }

    try {
      await fetch(`/api/usage-units/${unitId}`, { method: 'DELETE' });
    } catch (e) {}
    const units = storageService.getUsageUnits();
    const unit = units.find(u => u.id === unitId);
    storageService.deleteUsageUnit(unitId);

    if (unit) {
      auditService.logAction({
        action: 'USAGE_UNIT_DELETED',
        actor: user || 'Admin / Department Manager',
        department: unit.department || 'PD',
        docNo: unit.id,
        docType: 'USAGE_UNIT',
        details: `ลบหน่วยเบิกใช้งาน "${unit.name}" (${unit.department}) ออกจากระบบ`
      });
    }

    return true;
  },

  async saveUser(user, actor = null) {
    const isUpdate = Boolean(user.id);
    const users = storageService.getUsers();

    // Check duplicate username if username is provided
    if (user.username) {
      const isDuplicate = users.some(u =>
        u.username?.trim().toLowerCase() === user.username.trim().toLowerCase() &&
        u.id !== user.id
      );
      if (isDuplicate) {
        throw new Error(`Username "${user.username}" มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น`);
      }
    }

    const primaryDept = user.primaryDepartment || user.department || 'PD';
    const allowedDepts = Array.isArray(user.allowedDepartments) && user.allowedDepartments.length > 0
      ? user.allowedDepartments
      : (primaryDept === 'ALL' ? ['*'] : [primaryDept]);

    const userPayload = {
      ...user,
      primaryDepartment: primaryDept,
      department: primaryDept,
      allowedDepartments: allowedDepts
    };

    if (isGAS()) {
      try {
        await callGAS('apiSaveUser', userPayload);
      } catch (e) {
        console.warn('[apiService] GAS apiSaveUser error, trying apiUpsertUser:', e.message);
        try {
          await callGAS('apiUpsertUser', userPayload);
        } catch (e2) {
          console.warn('[apiService] GAS apiUpsertUser error:', e2.message);
        }
      }
    }

    try {
      const url = isUpdate ? `/api/users/${user.id}` : '/api/users';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userPayload)
      });
      if (res.ok) {
        const resData = await res.json();
        const saved = (resData && (resData.id || resData.username || resData.employeeId) && resData.name)
          ? { ...userPayload, ...resData }
          : userPayload;
        const updatedList = isUpdate ? users.map(u => u.id === user.id ? saved : u) : [...users, saved];
        storageService.saveUsers(updatedList);

        auditService.logAction({
          action: isUpdate ? 'USER_UPDATED' : 'USER_CREATED',
          actor: actor || 'Admin',
          department: saved.primaryDepartment || 'ALL',
          docNo: saved.id,
          docType: 'USER',
          details: `${isUpdate ? 'แก้ไขข้อมูลผู้ใช้' : 'เพิ่มผู้ใช้ใหม่'} "${saved.name}" (${saved.position || saved.title || saved.roleId}) แผนก: ${saved.primaryDepartment} [${(saved.allowedDepartments || []).join(', ')}]`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveUser API fallback:', e.message);
    }

    const saved = storageService.saveUser(userPayload);

    auditService.logAction({
      action: isUpdate ? 'USER_UPDATED' : 'USER_CREATED',
      actor: actor || 'Admin',
      department: saved.primaryDepartment || 'ALL',
      docNo: saved.id,
      docType: 'USER',
      details: `${isUpdate ? 'แก้ไขข้อมูลผู้ใช้' : 'เพิ่มผู้ใช้ใหม่'} "${saved.name}" (${saved.position || saved.title || saved.roleId}) แผนก: ${saved.primaryDepartment} [${(saved.allowedDepartments || []).join(', ')}]`
    });

    return saved;
  },

  async deleteUser(userId, actor = null) {
    if (isGAS()) {
      try {
        await callGAS('apiDeleteUser', userId);
      } catch (e) {
        console.warn('[apiService] GAS apiDeleteUser error:', e.message);
      }
    }
    try {
      await fetch(`/api/users/${userId}`, { method: 'DELETE' });
    } catch (e) {}
    const users = storageService.getUsers();
    const target = users.find(u => u.id === userId);
    storageService.deleteUser(userId);

    if (target) {
      auditService.logAction({
        action: 'USER_DELETED',
        actor: actor || 'Admin',
        department: target.primaryDepartment || target.department || 'ALL',
        docNo: target.id,
        docType: 'USER',
        details: `ลบผู้ใช้งาน "${target.name}" (${target.username}) ออกจากระบบ`
      });
    }

    return true;
  },

  async saveDepartments(departments) {
    storageService.saveDepartments(departments);
    try {
      await fetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(departments)
      });
    } catch (e) {}
  },

  async saveDepartment(deptPayload, actor = null) {
    const isUpdate = Boolean(deptPayload.id);

    

    try {
      const url = isUpdate 
        ? `/api/departments/${deptPayload.id}` 
        : '/api/departments';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deptPayload)
      });
      if (res.ok) {
        const resData = await res.json();
        const saved = (resData && (resData.id || resData.code) && resData.name)
          ? { ...deptPayload, ...resData }
          : deptPayload;
        const depts = storageService.getDepartments();
        const updated = isUpdate ? depts.map(d => d.id === saved.id ? saved : d) : [...depts, saved];
        storageService.saveDepartments(updated);

        auditService.logAction({
          action: isUpdate ? 'DEPARTMENT_UPDATED' : 'DEPARTMENT_CREATED',
          actor: actor || 'Admin',
          department: saved.code,
          docNo: saved.id,
          docType: 'DEPARTMENT',
          details: `${isUpdate ? 'แก้ไขข้อมูลแผนก' : 'เพิ่มแผนกใหม่'} "${saved.name}" (${saved.code}) สถานะ: ${saved.isActive ? 'เปิดใช้งาน' : 'ระงับการใช้งาน'}`
        });

        return saved;
      }
    } catch (e) {
      console.warn('[apiService] saveDepartment API fallback:', e.message);
    }

    const saved = storageService.saveDepartment(deptPayload);
    auditService.logAction({
      action: isUpdate ? 'DEPARTMENT_UPDATED' : 'DEPARTMENT_CREATED',
      actor: actor || 'Admin',
      department: saved.code,
      docNo: saved.id,
      docType: 'DEPARTMENT',
      details: `${isUpdate ? 'แก้ไขข้อมูลแผนก' : 'เพิ่มแผนกใหม่'} "${saved.name}" (${saved.code}) สถานะ: ${saved.isActive ? 'เปิดใช้งาน' : 'ระงับการใช้งาน'}`
    });
    return saved;
  },

  async deleteDepartment(deptId, actor = null) {
    try {
      await fetch(`/api/departments/${deptId}`, { method: 'DELETE' });
    } catch (e) {}
    const depts = storageService.getDepartments();
    const target = depts.find(d => d.id === deptId || d.code === deptId);
    storageService.deleteDepartment(deptId);

    if (target) {
      auditService.logAction({
        action: 'DEPARTMENT_DELETED',
        actor: actor || 'Admin',
        department: target.code,
        docNo: target.id,
        docType: 'DEPARTMENT',
        details: `ลบแผนก "${target.name}" (${target.code}) ออกจากระบบ Master Data`
      });
    }

    return true;
  },

  async getImageBase64(fileId) {
    if (isGAS()) {
      return callGAS('apiGetImageBase64', { fileId });
    }
    return '';
  },

  async makeAllDriveFilesPublic() {
    if (isGAS()) {
      return callGAS('apiMakeAllDriveFilesPublic');
    }
    return { success: true, message: 'Simulated Drive Public Read Migration' };
  }
};
