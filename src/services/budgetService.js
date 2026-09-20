import { storageService } from './storageService';
import { apiService } from './apiService';
import { auditService } from './auditService';

/**
 * Clean baseline generator matching current fiscal period (September 2026 / 2569)
 * Allocations:
 * - PD (ฝ่ายผลิต): ฿1,000,000.00
 * - QC (ฝ่ายควบคุมคุณภาพ): ฿150,000.00
 * - WH (ฝ่ายคลังสินค้า): ฿120,000.00
 * - PUR (ฝ่ายจัดซื้อ): ฿100,000.00
 * - ENG (ฝ่ายวิศวกรรม): ฿205,000.00
 * With 0 initial spent and strictly the active month (2026-09 / กันยายน 2569), eliminating empty past-month placeholder rows.
 */
export const generateCleanBudgetBaseline = () => {
  const activeMonth = '2026-09';
  const deptConfigs = {
    PD: { monthlyBudget: 1000000 },
    QC: { monthlyBudget: 150000 },
    WH: { monthlyBudget: 120000 },
    PUR: { monthlyBudget: 100000 },
    ENG: { monthlyBudget: 205000 }
  };

  const baseline = {};
  for (const [code, cfg] of Object.entries(deptConfigs)) {
    baseline[code] = {
      monthlyBudget: cfg.monthlyBudget,
      spent: 0,
      actualExpense: 0,
      budgetSpent: 0,
      pending: 0,
      variance: cfg.monthlyBudget,
      remainingBudget: cfg.monthlyBudget,
      budgetRemaining: cfg.monthlyBudget,
      history: {
        [activeMonth]: cfg.monthlyBudget
      },
      historicalSpent: {
        [activeMonth]: 0
      },
      refundCredits: {}
    };
  }
  return baseline;
};

export const CLEAN_BUDGET_BASELINE = generateCleanBudgetBaseline();

/**
 * Calculate dynamic budget summary for a specific period (YYYY-MM).
 * Strict Zero-Based Budgeting:
 * If a department has no explicit allocation in targetPeriod,
 * totalBudget = 0, spentBudget = actualSpent, remainingBudget = 0, isAllocated = false.
 * NO fallback to DEFAULT_MONTHLY_BUDGET or simulated hash factors!
 */
export const calculatePeriodBudgetSummary = (targetPeriodStr, prs = [], pos = [], rawBudgets = null) => {
  const today = new Date();
  const targetPeriod = (targetPeriodStr && /^\d{4}-\d{2}$/.test(targetPeriodStr))
    ? targetPeriodStr
    : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const budgets = rawBudgets || storageService.getBudgets() || {};
  const currentPRs = (Array.isArray(prs) && prs.length > 0) ? prs : (storageService.getPRs() || []);
  const currentPOs = (Array.isArray(pos) && pos.length > 0) ? pos : (storageService.getPOs() || []);

  const depts = ['PD', 'QC', 'WH', 'PUR', 'ENG'];
  try {
    const masterDepts = storageService.getDepartments() || [];
    masterDepts.forEach(d => {
      const c = d.code || d.id;
      if (c && !depts.includes(c)) depts.push(c);
    });
  } catch {}

  const currentSummary = {};
  const trends = {};

  const calculateForMonth = (m) => {
    const summaryForM = {};
    depts.forEach(dept => {
      let allocated = 0;
      let isAllocated = false;

      if (Array.isArray(budgets)) {
        const found = budgets.find(b => (b.department === dept || b.dept === dept) && (b.period === m || b.month === m));
        if (found && (found.totalBudget !== undefined || found.monthlyBudget !== undefined)) {
          allocated = Number(found.totalBudget ?? found.monthlyBudget ?? 0);
          isAllocated = Boolean(found.isAllocated ?? (allocated > 0));
        }
      } else if (budgets && typeof budgets === 'object' && budgets[dept]) {
        const deptObj = budgets[dept];
        if (deptObj.history && deptObj.history[m] !== undefined && deptObj.history[m] !== null) {
          allocated = Number(deptObj.history[m]) || 0;
          isAllocated = allocated > 0;
        } else {
          allocated = 0;
          isAllocated = false;
        }
      }

      // Calculate real actual spent and committed from POs in month m
      let actualSpent = 0;
      let poCommitted = 0;
      currentPOs.forEach(po => {
        if (po && !['CANCELLED'].includes(po.status)) {
          const poDept = String(po.department || po.dept || '').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase();
          if (poDept === dept) {
            const dateStr = String(po.issueDate || po.createdAt || po.date || '').substring(0, 7);
            if (dateStr === m) {
              const poGross = Number(po.grandTotal ?? po.totalAmount ?? po.total ?? 0);
              // Calculate refunds on this PO
              let poRefund = 0;
              if (po.totalRefunded !== undefined && po.totalRefunded !== null) {
                poRefund = Number(po.totalRefunded);
              } else if (po.refundAmount !== undefined && po.refundAmount !== null) {
                poRefund = Number(po.refundAmount);
              } else if (po.storeClaims && typeof po.storeClaims === 'object') {
                Object.values(po.storeClaims).forEach(c => {
                  if (c?.isResolved && (c.type === 'REFUND' || c.resolutionType === 'REFUND' || c.actionType === 'REFUND' || String(c.note || '').includes('คืนเงิน'))) {
                    poRefund += Number(c.refundAmount || 0);
                  }
                });
              }
              if (poRefund === 0 && Array.isArray(po.items)) {
                po.items.forEach(it => {
                  if (it.refundAmount) poRefund += Number(it.refundAmount);
                  else if (it.claimResolution === 'REFUND') {
                    const q = Number(it.refundedQty || it.damagedQty || it.shortageQty || 0);
                    const p = Number(it.actualPrice || it.unitPrice || it.price || 0);
                    poRefund += (q * p);
                  }
                });
              }

              const netPoAmount = Math.max(0, poGross - poRefund);
              const poStatusUpper = String(po.status || '').toUpperCase();
              const isClosedOrCompleted = ['CLOSED', 'COMPLETED', 'RECEIVED', 'FULLY_RECEIVED', 'COMPLETED_WITH_REFUND', 'RESOLVED'].includes(poStatusUpper) || Boolean(po.isClosed);

              if (isClosedOrCompleted) {
                // PO closed/completed: committed = 0, actual spent = net amount
                actualSpent += netPoAmount;
              } else {
                // PO in-progress: committed = net amount
                poCommitted += netPoAmount;
              }
            }
          }
        }
      });
      actualSpent = Math.round(actualSpent * 100) / 100;
      poCommitted = Math.round(poCommitted * 100) / 100;

      // Calculate real committed from PRs in month m
      let committed = poCommitted;
      currentPRs.forEach(pr => {
        if (pr && !['REJECTED', 'CANCELLED', 'DRAFT', 'CLOSED', 'COMPLETED'].includes(pr.status)) {
          // If PR already converted to PO, don't double count
          const hasLinkedPO = currentPOs.some(p => p.prId === pr.id || (p.prNo && p.prNo === pr.prNo) || (p.prNo && p.prNo === pr.id));
          if (!hasLinkedPO) {
            const prDept = String(pr.department || pr.dept || '').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase();
            if (prDept === dept) {
              const dateStr = String(pr.requestedDate || pr.createdAt || '').substring(0, 7);
              if (dateStr === m) {
                committed += Number(pr.totalAmount || 0);
              }
            }
          }
        }
      });
      committed = Math.round(committed * 100) / 100;

      const totalSpent = actualSpent + committed;
      const remaining = isAllocated ? Math.round((allocated - totalSpent) * 100) / 100 : 0;
      const percentage = (isAllocated && allocated > 0) ? Math.min(100, Math.round((totalSpent / allocated) * 100)) : 0;

      summaryForM[dept] = {
        dept,
        department: dept,
        period: m,
        baseAllocated: allocated,
        allocated,
        totalBudget: allocated,
        spentBudget: actualSpent,
        actualSpent,
        committed,
        totalSpent,
        remaining,
        remainingBudget: remaining,
        percentage,
        isAllocated
      };
    });
    return summaryForM;
  };

  // 1. Calculate active targetPeriod
  const targetMonthSummary = calculateForMonth(targetPeriod);
  currentSummary[targetPeriod] = targetMonthSummary;

  // 2. Pre-populate 24-month trend window without fake hash simulation
  const [tYear, tMonthNum] = targetPeriod.split('-').map(Number);
  for (let i = 23; i >= 0; i--) {
    const d = new Date(tYear, tMonthNum - 1 - i, 1);
    const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    trends[mStr] = calculateForMonth(mStr);
  }
  trends[targetPeriod] = targetMonthSummary;

  return {
    current: targetMonthSummary,
    trends,
    period: targetPeriod
  };
};

/**
 * BudgetService (Enterprise Department Budget & Settlement Engine)
 * Authoritative single source of truth for budget crediting, reconciliations,
 * and duplicate-refund protection.
 */
export const budgetService = {
  calculatePeriodBudgetSummary,
  calculateBudgetSummary: calculatePeriodBudgetSummary,

  /**
   * Universal Budget Ledger Logger
   */
  async logBudgetTransaction(entry) {
    if (!entry || !entry.department || !entry.type || entry.amount === undefined) {
      console.warn('Invalid budget transaction entry:', entry);
      return;
    }

    let rawDept = String(entry.department).toUpperCase();
    let deptCode = rawDept.replace(/^ฝ่าย\s*/i, '').replace(/\s*\(.*?\)\s*/g, '').trim();
    if (rawDept.includes('QC') || rawDept.includes('คุณภาพ')) deptCode = 'QC';
    else if (rawDept.includes('PD') || rawDept.includes('ผลิต')) deptCode = 'PD';
    
    const normalizedDept = `ฝ่าย ${deptCode}`;
    const docRef = entry.docRef || entry.docNo || '-';
    // Use Idempotent Transaction Key per user requirement
    const idempotencyKey = `TXN-${docRef}-${entry.type}`;
    const today = new Date();
    const period = entry.period || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    const tx = {
      id: `TX-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      transactionId: idempotencyKey,
      idempotencyKey,
      createdAt: today.toISOString(),
      date: today.toISOString().replace('T', ' ').substring(0, 19),
      period,
      type: entry.type,
      actionType: entry.type,
      transactionType: entry.type,
      typeLabel: entry.type,
      dept: normalizedDept,
      department: normalizedDept,
      departmentName: normalizedDept,
      amount: Number(entry.amount),
      docType: entry.docType || (docRef.startsWith('PR') ? 'PR' : 'PO'),
      docNo: docRef,
      referenceDoc: docRef,
      poNumber: docRef,
      refDocNo: docRef,
      refId: docRef,
      referencePo: docRef,
      actor: entry.recordedBy || 'System',
      actorName: entry.recordedBy || 'System',
      actorRole: 'SYSTEM',
      notes: entry.description || '',
      remark: entry.description || '',
      isReconciled: true
    };

    // Prevent duplicate entries
    const existingTxs = storageService.getBudgetTransactions() || [];
    const isDuplicate = existingTxs.some(ex => {
      if (ex.idempotencyKey && idempotencyKey && ex.idempotencyKey === idempotencyKey) return true;
      if (ex.type === tx.type && (ex.docNo === tx.docNo || ex.referenceDoc === tx.referenceDoc)) return true;
      return false;
    });
    if (isDuplicate) return tx;

    storageService.appendBudgetTransaction(tx);

    try {
      if (typeof fetch === 'function') {
        fetch('/api/budget-transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tx)
        }).catch(() => {});
      }
    } catch {}

    return tx;
  },

  /**
   * Allocate monthly budget for specified period (YYYY-MM)
   * Enforces persistence in storageService & localStorage
   */
  async allocateMonthlyBudget({ period, allocations = {}, actor = 'Asst. Manager', reason = '' }) {
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new Error('รูปแบบรอบเดือนไม่ถูกต้อง ต้องเป็น YYYY-MM (ค.ศ.)');
    }

    const budgets = storageService.getBudgets() || {};
    const today = new Date();
    const currentPeriodStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    for (const [dept, amount] of Object.entries(allocations)) {
      const numAmount = Math.max(0, Number(amount) || 0);
      if (!budgets[dept]) {
        budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };
      }
      // Strict Zero-based: Previous budget strictly refers to the same period history.
      // Initial state of any new month is strictly 0. Never fallback to master data!
      const prevMonthAlloc = (budgets[dept].history[period] !== undefined && budgets[dept].history[period] !== null)
        ? Number(budgets[dept].history[period])
        : 0;
      const isInitial = prevMonthAlloc === 0;

      budgets[dept].history[period] = numAmount;

      // If active current month, update base monthlyBudget
      if (period === currentPeriodStr || period === '2026-09') {
        budgets[dept].monthlyBudget = numAmount;
        budgets[dept].variance = numAmount - (budgets[dept].spent || 0);
        budgets[dept].remainingBudget = budgets[dept].variance;
      }

      const deltaAmount = isInitial ? numAmount : (numAmount - prevMonthAlloc);
      const txType = isInitial ? 'MONTHLY_ALLOCATION' : (deltaAmount >= 0 ? 'TOP_UP' : 'SET_BUDGET');
      const txTypeLabel = isInitial 
        ? 'จัดสรรงบประมาณประจำเดือน' 
        : (deltaAmount >= 0 ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดยอดงบประมาณ');

      // Append budget transaction
      const tx = {
        id: `BTX-ALLOC-${dept}-${period}-${Date.now()}`,
        date: today.toISOString().replace('T', ' ').substring(0, 19),
        createdAt: today.toISOString(),
        type: txType,
        actionType: isInitial ? 'MONTHLY_ALLOCATION' : 'ADJUST_BUDGET',
        typeLabel: txTypeLabel,
        dept,
        department: dept,
        departmentName: `ฝ่าย ${dept}`,
        amount: deltaAmount,
        delta: deltaAmount,
        previousAmount: prevMonthAlloc,
        newAmount: numAmount,
        actor: actor || 'Asst. Manager',
        note: reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${period}` : `ปรับปรุงงบประมาณรอบเดือน ${period}`),
        targetMonth: period,
        period
      };
      storageService.appendBudgetTransaction(tx);
    }

    // Explicit Persistence on localStorage & storageService
    storageService.saveBudgets(budgets);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('prpo_budgets', JSON.stringify(budgets));
    }

    // Audit Log
    try {
      const summaryText = Object.entries(allocations)
        .map(([d, a]) => `${d}: ฿${Number(a).toLocaleString()}`)
        .join(', ');
      auditService.logAction({
        action: 'BUDGET_ALLOCATED',
        docType: 'BUDGET',
        docNo: period,
        details: `จัดสรรงบประมาณประจำเดือน (${period}): ${summaryText}`,
        actor,
        department: 'ALL'
      });
    } catch (e) {
      console.warn('[budgetService] Audit log error:', e);
    }

    // Backend sync attempt
    try {
      if (typeof fetch === 'function') {
        await fetch('/api/budgets/allocate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period, allocations, actor, reason })
        }).catch(() => {});
      }
    } catch {}

    return {
      success: true,
      period,
      allocations,
      budgets
    };
  },

  /**
   * Reset Budget Data to clean minimal baseline matching current fiscal period (2026-09)
   * Writes to storageService and syncs with backend server if available.
   */
  resetBudgetData() {
    const cleanBudgets = generateCleanBudgetBaseline();
    storageService.saveBudgets(cleanBudgets);
    try {
      if (typeof fetch === 'function') {
        fetch('/api/budgets/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanBudgets)
        }).catch(() => {});
      }
    } catch {
      // Graceful offline fallback
    }
    return cleanBudgets;
  },

  /**
   * Credit Department Budget on Claim Refund with strict idempotency
   * Ensures:
   * 1. budgetSpent -= refundValue
   * 2. budgetRemaining += refundValue
   * 3. Idempotent: exact same refund (refPo + storeKey + amount) will not be credited twice
   * 4. Single audit trail in budget transactions log matching canonical table schema
   */
  async creditDepartmentBudget({
    departmentId,
    department,
    prDepartment,
    dept: deptAlias,
    amount,
    refundValue,
    refundAmount,
    referencePo,
    docNo,
    poNumber,
    storeKey = '',
    storeName = '',
    reason = '',
    actor = 'Budget Specialist'
  }) {
    // A. Resilient Department Identification & Calling Contract
    const rawDept = department || departmentId || prDepartment || deptAlias || 'PD';
    const dept = String(rawDept).replace(/^ฝ่าย\s*/i, '').trim().toUpperCase() || 'PD';
    const refundAmt = Math.round((Number(amount ?? refundValue ?? refundAmount ?? 0)) * 100) / 100;
    if (refundAmt <= 0) {
      return { success: false, reason: 'Zero or negative refund amount' };
    }

    const refPo = String(referencePo || docNo || poNumber || '').trim();
    const cleanStoreKey = String(storeKey || '').trim();
    const idempotencyKey = `REFUND_${refPo}_${cleanStoreKey || 'STORE'}_${refundAmt}`;

    // C.1 Check idempotency against both po.processedRefundTransactions and existing budget ledger
    const existingTx = storageService.getBudgetTransactions() || [];
    const pos = storageService.getPOs() || [];
    const targetPO = pos.find(p => p.id === refPo || p.poNo === refPo || p.poNumber === refPo);
    const hasPoTx = Boolean(targetPO && Array.isArray(targetPO.processedRefundTransactions) && targetPO.processedRefundTransactions.includes(idempotencyKey));

    const isAlreadyCredited = hasPoTx || existingTx.some(tx => 
      tx.idempotencyKey === idempotencyKey ||
      tx.transactionId === idempotencyKey ||
      ((tx.docNo === refPo || tx.referenceDoc === refPo || tx.poNumber === refPo || tx.refId === refPo || tx.refDocNo === refPo) &&
       (tx.storeKey === cleanStoreKey || !cleanStoreKey || cleanStoreKey === 'GLOBAL' || cleanStoreKey === 'STORE') &&
       Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount) === refundAmt)
    );

    if (isAlreadyCredited) {
      const budgets = storageService.getBudgets();
      const currentSpent = Number(budgets[dept]?.spent ?? budgets[dept]?.actualExpense ?? budgets[dept]?.budgetSpent ?? 0);
      const remaining = Number(budgets[dept]?.variance ?? budgets[dept]?.remainingBudget ?? budgets[dept]?.budgetRemaining ?? 0);
      return {
        success: true,
        alreadyReconciled: true,
        department: dept,
        amount: refundAmt,
        budgetSpent: currentSpent,
        budgetRemaining: remaining
      };
    }

    if (targetPO) {
      if (!Array.isArray(targetPO.processedRefundTransactions)) {
        targetPO.processedRefundTransactions = [];
      }
      if (!targetPO.processedRefundTransactions.includes(idempotencyKey)) {
        targetPO.processedRefundTransactions.push(idempotencyKey);
        storageService.savePOs(pos);
      }
    }

    // C.2 Deduct from spent and add to remaining in budgets
    const budgets = storageService.getBudgets();
    if (!budgets[dept]) {
      budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };
    }

    const currentSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? budgets[dept].budgetSpent ?? 0);
    const newSpent = Math.max(0, Math.round((currentSpent - refundAmt) * 100) / 100);

    budgets[dept].spent = newSpent;
    budgets[dept].actualExpense = newSpent;
    budgets[dept].budgetSpent = newSpent;

    const monthly = Number(budgets[dept].monthlyBudget || budgets[dept].budgetTotal || 0);
    const newVariance = Math.round((monthly - newSpent) * 100) / 100;

    budgets[dept].variance = newVariance;
    budgets[dept].remainingBudget = newVariance;
    budgets[dept].budgetRemaining = newVariance;

    const today = new Date();
    const targetMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
    budgets[dept].refundCredits[targetMonth] = Math.round(
      ((budgets[dept].refundCredits[targetMonth] || 0) + refundAmt) * 100
    ) / 100;

    storageService.saveBudgets(budgets);

    // Also update Department entity in departments storage for SSOT
    try {
      const depts = storageService.getDepartments() || [];
      const deptItem = depts.find(d => d.code === dept || d.id === dept || d.id === `DEPT-${dept}`);
      if (deptItem) {
        deptItem.budgetTotal = Number(deptItem.budgetTotal || deptItem.monthlyBudget || monthly);
        deptItem.budgetSpent = newSpent;
        deptItem.budgetRemaining = newVariance;
        storageService.saveDepartments(depts);
      }
    } catch {
      // Graceful fallback
    }

    // B. Canonical Budget Transaction Schema matching MonthlyBudgetManagement UI columns & Financial Requirement 2
    const baseNote = `คืนงบประมาณจากการเคลม/ปิดงาน (${refPo || 'PO'})${storeName || cleanStoreKey ? ` - ร้าน: ${storeName || cleanStoreKey}` : ''}`;
    const effectiveNote = reason 
      ? (reason.includes('คืน') ? reason : `${baseNote} (${reason})`)
      : baseNote;
    const tx = {
      id: `TX-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      transactionId: idempotencyKey,
      idempotencyKey,
      timestamp: today.toISOString(),
      createdAt: today.toISOString(),
      date: today.toISOString().replace('T', ' ').substring(0, 19),
      period: targetMonth || '2026-09',
      type: 'BUDGET_ROLLBACK', // Compatible with existing Vitest assertions
      actionType: 'REFUND_SETTLEMENT',
      transactionType: 'REFUND_SETTLEMENT',
      settlementType: 'REFUND_SETTLEMENT',
      typeLabel: 'คืนงบประมาณ (Refund)',
      dept,
      department: dept,
      departmentName: `ฝ่าย ${dept}`,
      amount: Number(refundAmt), // Strictly positive number e.g. 200 or 246
      refundAmount: Number(refundAmt),
      creditAmount: Number(refundAmt),
      delta: Number(refundAmt),
      previousAmount: currentSpent,
      newAmount: newSpent,
      docType: 'PO',
      docNo: refPo,
      referenceDoc: refPo,
      poNumber: refPo,
      poNo: refPo,
      refDocNo: refPo,
      refId: refPo,
      poId: refPo,
      referencePo: refPo,
      storeKey: cleanStoreKey || 'STORE',
      actor: actor || 'ผู้ดูแลระบบจัดซื้อ',
      actorName: actor || 'ผู้ดูแลระบบจัดซื้อ',
      actorRole: 'PURCHASER',
      notes: effectiveNote,
      note: effectiveNote,
      remark: effectiveNote,
      targetMonth,
      isReconciled: true
    };

    storageService.appendBudgetTransaction(tx);

    try {
      if (typeof fetch === 'function') {
        await fetch(`/api/budgets/${dept}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(budgets[dept])
        }).catch(() => {});

        await fetch('/api/budget-transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tx)
        }).catch(() => {});
      }
    } catch {
      // Graceful offline fallback
    }

    return {
      success: true,
      alreadyReconciled: false,
      department: dept,
      amount: refundAmt,
      budgetSpent: newSpent,
      budgetRemaining: newVariance,
      transaction: tx
    };
  },

  /**
   * D. Self-Healing & Retroactive Sync Engine (Crucial for Existing POs)
   * Automatically synchronizes settled claims from stored POs into the budget ledger.
   * Backfills missing refund records (e.g. PO-PD-2026-001 with ฿246.00) idempotently.
   */
  syncSettledRefundsToBudget(providedPOs, providedDepartments) {
    const pos = (Array.isArray(providedPOs) && providedPOs.length > 0) ? providedPOs : (storageService.getPOs() || []);
    const existingTx = storageService.getBudgetTransactions() || [];
    const reconciledRecords = [];
    let syncedCount = 0;

    for (const po of pos) {
      if (!po) continue;
      const targetDepartment = (po.department || po.departmentId || po.prDepartment || po.dept || 'PD')
        .replace(/^ฝ่าย\s*/i, '').trim().toUpperCase() || 'PD';
      const poDocNo = String(po.poNo || po.poNumber || po.id || '').trim();
      if (!poDocNo) continue;

      // 1. Scan storeClaims
      if (po.storeClaims && typeof po.storeClaims === 'object') {
        for (const [storeKey, claim] of Object.entries(po.storeClaims)) {
          if (!claim) continue;
          const isRefundClaim = (
            claim.isResolved === true || 
            claim.status === 'RESOLVED' || 
            claim.type === 'REFUND' || 
            claim.actionType === 'REFUND' || 
            claim.resolutionType === 'REFUND' || 
            claim.type === 'CLOSE_WITH_REFUND' ||
            String(claim.note || '').includes('คืนเงิน')
          ) && (
            claim.type === 'REFUND' ||
            claim.actionType === 'REFUND' ||
            claim.resolutionType === 'REFUND' ||
            claim.type === 'CLOSE_WITH_REFUND' ||
            String(claim.note || '').includes('คืนเงิน')
          );

          const refundVal = Math.round((Number(claim.refundAmount) || 0) * 100) / 100;
          if (isRefundClaim && refundVal > 0) {
            const cleanKey = String(storeKey || '').trim();
            const txSig = `REFUND_${poDocNo}_${cleanKey || 'STORE'}_${refundVal}`;
            
            // Check if already in ledger or processed
            const hasPoTx = Array.isArray(po.processedRefundTransactions) && po.processedRefundTransactions.includes(txSig);
            const existsInLedger = hasPoTx || existingTx.some(tx => 
              tx.idempotencyKey === txSig ||
              tx.transactionId === txSig ||
              ((tx.docNo === poDocNo || tx.referenceDoc === poDocNo || tx.poNumber === poDocNo || tx.refId === poDocNo || tx.refDocNo === poDocNo) &&
               Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount) === refundVal)
            );

            if (!existsInLedger) {
              const storeName = claim.storeName || cleanKey;
              const defaultReason = `คืนเงินค่าสินค้าเสียหาย/ของขาดจาก ${poDocNo}${storeName ? ` (${storeName})` : ''}`;
              const reason = claim.note ? `${defaultReason} - ${claim.note}` : defaultReason;
              this.creditDepartmentBudget({
                departmentId: targetDepartment,
                department: targetDepartment,
                amount: refundVal,
                referencePo: poDocNo,
                storeKey: cleanKey,
                storeName: storeName,
                reason: reason,
                actor: claim.resolvedBy || 'Online Purchaser'
              });
              syncedCount++;
              reconciledRecords.push({ poNo: poDocNo, amount: refundVal, storeKey: cleanKey });
            }
          }
        }
      }

      // 2. Scan items where claimResolution === 'REFUND'
      if (Array.isArray(po.items)) {
        for (const item of po.items) {
          if (!item) continue;
          const isItemRefund = (item.claimResolution === 'REFUND' || item.resolutionType === 'REFUND') && Number(item.refundAmount || 0) > 0;
          if (isItemRefund) {
            const refundVal = Math.round(Number(item.refundAmount) * 100) / 100;
            const itemStore = item.actualStoreName || item.storeName || item.storeKey || 'ITEM';
            const txSig = `REFUND_${poDocNo}_${itemStore}_${refundVal}`;
            const hasPoTx = Array.isArray(po.processedRefundTransactions) && po.processedRefundTransactions.includes(txSig);
            const existsInLedger = hasPoTx || existingTx.some(tx => 
              tx.idempotencyKey === txSig ||
              tx.transactionId === txSig ||
              ((tx.docNo === poDocNo || tx.referenceDoc === poDocNo || tx.poNumber === poDocNo || tx.refId === poDocNo || tx.refDocNo === poDocNo) &&
               Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount) === refundVal)
            );

            if (!existsInLedger) {
              this.creditDepartmentBudget({
                departmentId: targetDepartment,
                department: targetDepartment,
                amount: refundVal,
                referencePo: poDocNo,
                storeKey: itemStore,
                storeName: itemStore,
                reason: `คืนเงินค่าสินค้า ${item.name || item.code} จาก ${poDocNo}`,
                actor: 'Online Purchaser'
              });
              syncedCount++;
              reconciledRecords.push({ poNo: poDocNo, amount: refundVal, storeKey: itemStore });
            }
          }
        }
      }
    }

    return {
      syncedCount,
      reconciledRecords,
      success: true
    };
  }
};
