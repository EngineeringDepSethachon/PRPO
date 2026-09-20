import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEPARTMENTS } from '../config/constants';
import { apiService } from '../services/apiService';
import { storageService } from '../services/storageService';
import { budgetService } from '../services/budgetService';
import { modalService } from '../services/modalService';
import { 
  Wallet, ShieldAlert, TrendingUp,
  Building2, BarChart3, History,
  Edit2, ChevronLeft, ChevronRight, ChevronDown,
  ArrowUpRight, ArrowDownRight, Minus,
  CheckCircle2, AlertTriangle, Calendar, Plus, RotateCw,
  Clock
} from 'lucide-react';
import DepartmentAllocationModal from '../components/budget/DepartmentAllocationModal';
import { useAppContext } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { authService } from '../services/authService';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, 
  Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  Cell, PieChart as RechartsPieChart, Pie
} from 'recharts';
import { safeStringCompare, formatThaiDateTime } from '../utils/formatters';

const RANGE_OPTIONS = [
  { value: 3, label: '3 ด.' },
  { value: 6, label: '6 ด.' },
  { value: 12, label: '12 ด.' },
  { value: 24, label: '24 ด.' }
];

export default function BudgetView({ budgetSummary, currentRole, currentUser, prs = [], pos = [], departments = [], onRefresh }) {
  let context = null;
  try {
    context = useAppContext();
  } catch {
    context = null;
  }

  let auth = null;
  try {
    auth = useAuth();
  } catch {
    auth = null;
  }

  // Dynamic Real-Time Effective User Resolution with Fallback
  const fallbackUser = typeof authService?.getCurrentUser === 'function' ? authService.getCurrentUser() : null;
  const effectiveUser = currentUser || currentRole || auth?.currentUser || auth?.currentRole || fallbackUser;

  let searchParams, setSearchParams;
  try {
    [searchParams, setSearchParams] = useSearchParams();
  } catch {
    searchParams = new URLSearchParams();
    setSearchParams = () => {};
  }
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') || 'overview');
  const [timeRange, setTimeRange] = useState(6);
  const [deptAllocationTarget, setDeptAllocationTarget] = useState(null);
  const [ledgerFilter, setLedgerFilter] = useState('ALL'); // ALL, ACTUAL_SPEND, COMMITMENT, REFUND

  const deptList = useMemo(() => {
    const raw = (departments && departments.length > 0) ? departments : storageService.getDepartments();
    return (raw || []).filter(d => {
      const code = String(d?.code || '').trim().toUpperCase();
      const id = String(d?.id || '').trim().toUpperCase();
      const name = String(d?.name || '');
      return code !== 'ALL' && id !== 'DEPT-ALL' && !name.includes('ส่วนกลาง') && !name.includes('ทุกฝ่าย');
    });
  }, [departments]);

  const deptMap = useMemo(() => {
    return deptList.reduce((acc, d) => {
      acc[d.code] = d;
      return acc;
    }, {});
  }, [deptList]);

  // Self-Healing Retroactive Sync Engine: backfill settled refund credits on load and reset bloated mock baseline
  useEffect(() => {
    const currentB = storageService.getBudgets();
    if (!currentB?.PD || currentB.PD.monthlyBudget > 1000000 || !currentB.PD.historicalSpent || currentB.PD.historicalSpent['2026-08'] !== undefined) {
      budgetService.resetBudgetData();
    }
    budgetService.syncSettledRefundsToBudget(pos, deptList);
  }, [pos, deptList]);

  // 1. User Permission Scoping: Check if current user is Super Admin or Approver (Universal Access)
  const isSuperAdminOrApprover = useMemo(() => {
    const u = effectiveUser;
    if (!u) return false;
    const roleId = String(u.roleId || u.id || '').toUpperCase();
    const positionKey = String(u.positionKey || '').toUpperCase();
    const roleStr = String(u.role || '').toLowerCase();
    const canonicalRole = String(u.canonicalRole || '').toUpperCase();
    const level = Number(u.level || 0);

    // Level 99 Admin or Level 3+ Plant Manager / Final Approver
    if (roleId === 'ADMIN' || roleStr === 'admin' || canonicalRole === 'ADMIN' || level >= 99 || auth?.isAdmin) return true;
    if (roleId === 'PLANT_MANAGER' || positionKey === 'APPROVER' || canonicalRole === 'APPROVER' || u.canFinalApprove || level >= 3) return true;

    // Explicit ALL/* in assignedDepartments or allowedDepartments
    const assigned = Array.isArray(u.assignedDepartments) ? u.assignedDepartments : [];
    const allowed = Array.isArray(u.allowedDepartments) ? u.allowedDepartments : [];
    if (assigned.includes('ALL') || assigned.includes('*') || allowed.includes('ALL') || allowed.includes('*')) return true;
    if (u.department === 'ALL' || u.primaryDepartment === 'ALL') return true;

    return false;
  }, [effectiveUser, auth?.isAdmin]);

  // RBAC Permission: Asst. Manager, Admin, Plant Manager / Approver can allocate/set monthly budget
  const canAllocateBudget = useMemo(() => {
    const u = effectiveUser;
    if (!u) return false;
    const roleId = String(u.roleId || u.id || '').toUpperCase();
    const positionKey = String(u.positionKey || '').toUpperCase();
    const canonicalRole = String(u.canonicalRole || '').toUpperCase();
    const roleStr = String(u.role || '').toUpperCase();
    const username = String(u.username || '').toLowerCase();
    const level = Number(u.level || 0);

    // Online Purchaser has no budget management access
    if (roleId === 'ONLINE_PURCHASER' || u.canOnlinePurchase) return false;

    if (
      roleId === 'ASST_MANAGER' ||
      roleId === 'ADMIN' ||
      roleId === 'PLANT_MANAGER' ||
      roleId === 'APPROVER' ||
      positionKey === 'APPROVER' ||
      positionKey === 'PLANT_MANAGER' ||
      positionKey === 'ASST_MANAGER' ||
      positionKey === 'REVIEWER' ||
      canonicalRole === 'ASST_MANAGER' ||
      canonicalRole === 'ADMIN' ||
      canonicalRole === 'APPROVER' ||
      canonicalRole === 'REVIEWER' ||
      roleStr === 'ASST_MANAGER' ||
      roleStr === 'ADMIN' ||
      roleStr === 'PLANT_MANAGER' ||
      roleStr === 'APPROVER' ||
      u.canFinalApprove ||
      u.canSetBudget === true ||
      u.canAllocateBudget === true ||
      username === 'admin' ||
      username.includes('kallayani') ||
      username.includes('somchai') ||
      level >= 2 ||
      auth?.isAdmin ||
      auth?.canAccess?.('BUDGET_MANAGE')
    ) {
      return true;
    }
    return false;
  }, [effectiveUser, auth]);

  // 2. User Assigned Departments
  const userAssignedDepts = useMemo(() => {
    const u = effectiveUser;
    if (!u) return [];
    const isOnline = Boolean(u.roleId === 'ONLINE_PURCHASER' || u.id === 'ONLINE_PURCHASER');
    if (isSuperAdminOrApprover || u.canViewAllDepts || isOnline) {
      return deptList.map(d => d.code);
    }

    const rawList = Array.isArray(u.assignedDepartments) && u.assignedDepartments.length > 0
      ? u.assignedDepartments
      : (Array.isArray(u.allowedDepartments) && u.allowedDepartments.length > 0
          ? u.allowedDepartments
          : (Array.isArray(u.departments) && u.departments.length > 0
              ? u.departments
              : (u.department ? [u.department] : [])));

    const validCodes = deptList.map(d => d.code);
    const filtered = rawList.filter(code => validCodes.includes(code));
    return filtered.length > 0 ? filtered : (u.department ? [u.department] : []);
  }, [effectiveUser, isSuperAdminOrApprover, deptList]);

  // 3. Department Selection & Security Fallback
  const queryDept = searchParams.get('dept');
  const [selectedDept, setSelectedDept] = useState(() => {
    const isOnline = Boolean(effectiveUser?.roleId === 'ONLINE_PURCHASER' || effectiveUser?.id === 'ONLINE_PURCHASER');
    if (queryDept) {
      if (queryDept === 'ALL' && (isSuperAdminOrApprover || effectiveUser?.canViewAllDepts || isOnline)) return 'ALL';
      if (queryDept === 'ALL' && !isSuperAdminOrApprover && userAssignedDepts.length > 1) return 'ALL';
      if (isSuperAdminOrApprover || userAssignedDepts.includes(queryDept)) {
        return queryDept;
      }
    }
    if (isSuperAdminOrApprover || effectiveUser?.canViewAllDepts || isOnline) return 'ALL';
    return userAssignedDepts.length > 1 ? 'ALL' : (userAssignedDepts[0] || 'ALL');
  });

  // Security Fallback: Automatically reset selectedDept if current value is not permitted
  useEffect(() => {
    const urlDept = searchParams.get('dept');
    if (!isSuperAdminOrApprover) {
      if (selectedDept === 'ALL') {
        if (userAssignedDepts.length <= 1 && userAssignedDepts[0]) {
          setSelectedDept(userAssignedDepts[0]);
        }
      } else if (!userAssignedDepts.includes(selectedDept)) {
        const fallback = userAssignedDepts.length > 1 ? 'ALL' : (userAssignedDepts[0] || 'ALL');
        setSelectedDept(fallback);
        if (urlDept && urlDept !== fallback) {
          const newParams = new URLSearchParams(searchParams);
          newParams.set('dept', fallback);
          setSearchParams(newParams, { replace: true });
        }
      }
    }
  }, [selectedDept, isSuperAdminOrApprover, userAssignedDepts, searchParams, setSearchParams]);

  const handleDeptChange = (newDept) => {
    if (!isSuperAdminOrApprover && newDept !== 'ALL' && !userAssignedDepts.includes(newDept)) {
      return;
    }
    setSelectedDept(newDept);
    const newParams = new URLSearchParams(searchParams);
    if (newDept === 'ALL' && isSuperAdminOrApprover) {
      newParams.delete('dept');
    } else {
      newParams.set('dept', newDept);
    }
    setSearchParams(newParams, { replace: true });
  };

  const [editingBudget, setEditingBudget] = useState(null);
  const [editBaseValue, _setEditBaseValue] = useState('');

  // Month & Year state: Defaults to active real-time operational fiscal period: September 2026 (2026-09 / กันยายน 2569)
  const initialFiscalPeriod = useMemo(() => {
    const urlMonth = searchParams.get('month');
    if (urlMonth && /^\d{4}-\d{2}$/.test(urlMonth)) {
      const [y, m] = urlMonth.split('-').map(Number);
      return { year: y, month: m };
    }
    return { year: 2026, month: 9 };
  }, [searchParams]);

  const [selectedYear, setSelectedYear] = useState(initialFiscalPeriod.year);
  const [selectedMonth, setSelectedMonth] = useState(initialFiscalPeriod.month);
  const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(initialFiscalPeriod.year);
  const monthPickerRef = useRef(null);

  const selectedMonthKey = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

  // Keep pickerYear synced when opening popover
  useEffect(() => {
    if (isMonthPickerOpen) {
      setPickerYear(selectedYear);
    }
  }, [isMonthPickerOpen, selectedYear]);

  // Click outside listener for Popover
  useEffect(() => {
    function handleClickOutside(event) {
      if (monthPickerRef.current && !monthPickerRef.current.contains(event.target)) {
        setIsMonthPickerOpen(false);
      }
    }
    if (isMonthPickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMonthPickerOpen]);

  // Recalculate dynamic budget summary based on selected month (Zero-Based Budgeting)
  const dynamicSummary = useMemo(() => {
    return budgetService.calculatePeriodBudgetSummary(selectedMonthKey, prs, pos);
  }, [selectedMonthKey, budgetSummary, prs, pos]);

  // Thai month names
  const thaiMonths = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
  ];

  const thaiShortMonths = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
  ];

  const handlePrevMonth = () => {
    if (selectedMonth === 1) {
      setSelectedMonth(12);
      setSelectedYear(y => y - 1);
    } else {
      setSelectedMonth(m => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth === 12) {
      setSelectedMonth(1);
      setSelectedYear(y => y + 1);
    } else {
      setSelectedMonth(m => m + 1);
    }
  };

  const handleJumpToCurrentMonth = () => {
    setSelectedYear(2026);
    setSelectedMonth(9);
    setIsMonthPickerOpen(false);
  };

  const handleSelectMonth = (monthIndex) => {
    setSelectedYear(pickerYear);
    setSelectedMonth(monthIndex + 1);
    setIsMonthPickerOpen(false);
  };

  const currentMonthSummary = dynamicSummary?.current || {};

  const deptsToShow = useMemo(() => {
    if (selectedDept === 'ALL') {
      return isSuperAdminOrApprover ? deptList.map(d => d.code) : userAssignedDepts.filter(c => c !== 'ALL');
    }
    if (isSuperAdminOrApprover || userAssignedDepts.includes(selectedDept)) {
      return [selectedDept];
    }
    const filtered = userAssignedDepts.filter(c => c !== 'ALL');
    return filtered.length > 0 ? [filtered[0]] : [];
  }, [selectedDept, isSuperAdminOrApprover, deptList, userAssignedDepts]);

  // Overall Statistics for deptsToShow (for Scoped / Multi-Department KPI summary)
  const summaryStats = useMemo(() => {
    let totalBase = 0;
    let totalActual = 0;
    let totalCommitted = 0;

    deptsToShow.forEach(dept => {
      const rawData = currentMonthSummary[dept] || {};
      const isAllocated = Boolean(rawData.isAllocated);
      const base = isAllocated ? Number(rawData.baseAllocated ?? rawData.allocated ?? 0) : 0;
      const actual = Number(rawData.actualSpent) || 0;
      const committed = Number(rawData.committed) || 0;

      totalBase += base;
      totalActual += actual;
      totalCommitted += committed;
    });

    const totalUsed = totalActual + totalCommitted;
    const totalRemaining = totalBase > 0 ? (totalBase - totalUsed) : 0;
    const usedPercent = totalBase > 0 ? Math.round((totalUsed / totalBase) * 100) : 0;

    return {
      totalBase,
      totalActual,
      totalCommitted,
      totalUsed,
      totalRemaining,
      usedPercent
    };
  }, [deptsToShow, currentMonthSummary, deptMap]);

  // Load budget transaction log (refund entries) scoped to permitted departments & active period
  const budgetTransactions = useMemo(() => {
    // 1. Get Static Txs (Filter only Manual Adjustments & Allocations)
    let staticTxs = storageService.getBudgetTransactions() || [];
    const validStaticTypes = new Set(['MONTHLY_ALLOCATION', 'SET_BUDGET', 'TOP_UP', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP', 'PR_RELEASE', 'REFUND_SETTLEMENT', 'BUDGET_ROLLBACK', 'BUDGET_RESTORED_CLAIM_REFUND']);
    let allTxs = staticTxs.filter(tx => validStaticTypes.has(String(tx.type || tx.transactionType || tx.actionType || '').toUpperCase()));

    // 2. Derive Stateful Ledger from PRs & POs
    const poByPrId = {};
    if (pos) {
      pos.forEach(po => {
        if (['CANCELLED'].includes(String(po.status).toUpperCase())) return;
        const prId = String(po.refPrNo || po.prNo || po.prId || po.referencePr || '').trim();
        if (prId) {
          if (!poByPrId[prId]) poByPrId[prId] = [];
          poByPrId[prId].push(po);
        }
      });
    }

    const processedPoIds = new Set();

    if (prs) {
      prs.forEach(pr => {
        if (!pr || ['REJECTED', 'CANCELLED'].includes(String(pr.status).toUpperCase())) return;
        const prId = String(pr.prNo || pr.id).trim();
        const prDate = pr.requestedDate || pr.createdAt || new Date().toISOString();
        const prTotal = Number(pr.totalEstimate || pr.totalAmount || pr.estimatedTotal || 0);
        
        const linkedPOs = poByPrId[prId] || [];
        
        if (linkedPOs.length === 0) {
          // Rule 1: No POs -> PR Commitment
          if (prTotal > 0 && ['SUBMITTED', 'REVIEWED', 'APPROVED'].includes(String(pr.status).toUpperCase())) {
            allTxs.push({
              id: `VTX-PR-${prId}`,
              type: 'PR_COMMITMENT',
              department: pr.department,
              dept: pr.department,
              amount: prTotal,
              docType: 'PR',
              docNo: prId,
              referenceDoc: prId,
              date: prDate,
              createdAt: prDate,
              actor: pr.requesterName || pr.requester || 'System',
              notes: `ผูกพัน PR อนุมัติแล้วรอสั่งซื้อ (${prId})`,
              period: prDate.substring(0, 7)
            });
          }
        } else {
          // Has POs -> Replace PR Commitment with PO state
          let sumPoCommitment = 0;
          let sumPoActual = 0;
          let sumPoTotalOriginal = 0;

          linkedPOs.forEach(po => {
            const poId = String(po.poNo || po.id).trim();
            processedPoIds.add(poId);
            const poDate = po.issueDate || po.createdAt || prDate;
            const poTotal = Number(po.grandTotal ?? po.totalAmount ?? po.total ?? 0);
            const poStatusUpper = String(po.status || '').toUpperCase();
            const isCompleted = ['CLOSED', 'COMPLETED', 'RECEIVED', 'FULLY_RECEIVED', 'COMPLETED_WITH_REFUND', 'RESOLVED'].includes(poStatusUpper) || Boolean(po.isClosed);
            
            sumPoTotalOriginal += poTotal;

            if (isCompleted) {
              // Level 2 Variance (PO vs Actual Paid)
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

              const netPoAmount = Math.max(0, poTotal - poRefund);
              sumPoActual += netPoAmount;

              // Actual Spend Line
              if (netPoAmount > 0) {
                allTxs.push({
                  id: `VTX-PO-ACT-${poId}`,
                  type: 'ACTUAL_SPEND',
                  department: po.department || pr.department,
                  dept: po.department || pr.department,
                  amount: netPoAmount,
                  docType: 'PO',
                  docNo: poId,
                  referenceDoc: `${prId} ➔ ${poId}`,
                  date: poDate,
                  createdAt: poDate,
                  actor: po.creatorName || po.requesterName || 'System',
                  notes: `ใช้จ่ายจริง PO: ${poId} (สุทธิ)`,
                  period: poDate.substring(0, 7)
                });
              }

              // Level 2 Adjustment Line (Discount/Refund from PO)
              if (poTotal > netPoAmount) {
                allTxs.push({
                  id: `VTX-PO-ADJ-${poId}`,
                  type: 'BUDGET_ADJUSTMENT_DOWN',
                  department: po.department || pr.department,
                  dept: po.department || pr.department,
                  amount: poTotal - netPoAmount,
                  docType: 'PO',
                  docNo: poId,
                  referenceDoc: poId,
                  date: poDate,
                  createdAt: poDate,
                  actor: po.creatorName || 'System',
                  notes: `ส่วนลด/คืนเงินจาก PO: ${poId} (ยอดสั่ง ฿${poTotal.toLocaleString()} -> จ่ายจริง ฿${netPoAmount.toLocaleString()})`,
                  period: poDate.substring(0, 7)
                });
              }

            } else {
              // PO In Progress
              sumPoCommitment += poTotal;
              if (poTotal > 0) {
                allTxs.push({
                  id: `VTX-PO-COM-${poId}`,
                  type: 'COMMITMENT',
                  department: po.department || pr.department,
                  dept: po.department || pr.department,
                  amount: poTotal,
                  docType: 'PO',
                  docNo: poId,
                  referenceDoc: `${prId} ➔ ${poId}`,
                  date: poDate,
                  createdAt: poDate,
                  actor: po.creatorName || po.requesterName || 'System',
                  notes: `ผูกพัน PO: ${poId} (กำลังดำเนินการ)`,
                  period: poDate.substring(0, 7)
                });
              }
            }
          });

          // Level 1 Variance (PR Estimate vs Sum of POs)
          // Evaluate only if PR is COMPLETED (all POs issued) or CLOSED.
          const isPrFullyConsumed = ['COMPLETED', 'CLOSED', 'FULLY_ISSUED'].includes(String(pr.status).toUpperCase()) || (linkedPOs.length > 0 && linkedPOs.every(p => ['CLOSED', 'COMPLETED', 'RECEIVED', 'FULLY_RECEIVED'].includes(String(p.status).toUpperCase())));
          
          if (isPrFullyConsumed) {
            const variance = prTotal - sumPoTotalOriginal;
            if (variance > 0) {
              allTxs.push({
                id: `VTX-PR-ADJ-DN-${prId}`,
                type: 'BUDGET_ADJUSTMENT_DOWN',
                department: pr.department,
                dept: pr.department,
                amount: variance,
                docType: 'PR',
                docNo: prId,
                referenceDoc: prId,
                date: prDate,
                createdAt: prDate,
                actor: pr.requesterName || 'System',
                notes: `คืนงบประมาณประหยัดจาก PR: ${prId} (ตั้งงบ ฿${prTotal.toLocaleString()} -> สั่งซื้อ ฿${sumPoTotalOriginal.toLocaleString()})`,
                period: prDate.substring(0, 7)
              });
            } else if (variance < 0) {
              allTxs.push({
                id: `VTX-PR-ADJ-UP-${prId}`,
                type: 'BUDGET_ADJUSTMENT_UP',
                department: pr.department,
                dept: pr.department,
                amount: Math.abs(variance),
                docType: 'PR',
                docNo: prId,
                referenceDoc: prId,
                date: prDate,
                createdAt: prDate,
                actor: pr.requesterName || 'System',
                notes: `ดึงงบเพิ่มจาก PR: ${prId} (ตั้งงบ ฿${prTotal.toLocaleString()} -> สั่งซื้อ ฿${sumPoTotalOriginal.toLocaleString()})`,
                period: prDate.substring(0, 7)
              });
            }
          }
        }
      });
    }

    // 3. Handle Direct POs (No PR linked)
    if (pos) {
      pos.forEach(po => {
        const poId = String(po.poNo || po.id).trim();
        if (processedPoIds.has(poId) || ['CANCELLED'].includes(String(po.status).toUpperCase())) return;
        
        const poDate = po.issueDate || po.createdAt || new Date().toISOString();
        const poTotal = Number(po.grandTotal ?? po.totalAmount ?? po.total ?? 0);
        const poStatusUpper = String(po.status || '').toUpperCase();
        const isCompleted = ['CLOSED', 'COMPLETED', 'RECEIVED', 'FULLY_RECEIVED', 'COMPLETED_WITH_REFUND', 'RESOLVED'].includes(poStatusUpper) || Boolean(po.isClosed);

        if (isCompleted) {
          // Level 2 Variance (Direct PO)
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

          const netPoAmount = Math.max(0, poTotal - poRefund);

          if (netPoAmount > 0) {
            allTxs.push({
              id: `VTX-DPO-ACT-${poId}`,
              type: 'ACTUAL_SPEND',
              department: po.department,
              dept: po.department,
              amount: netPoAmount,
              docType: 'PO',
              docNo: poId,
              referenceDoc: poId,
              date: poDate,
              createdAt: poDate,
              actor: po.creatorName || po.requesterName || 'System',
              notes: `ใช้จ่ายจริง Direct PO: ${poId} (สุทธิ)`,
              period: poDate.substring(0, 7)
            });
          }

          if (poTotal > netPoAmount) {
            allTxs.push({
              id: `VTX-DPO-ADJ-${poId}`,
              type: 'BUDGET_ADJUSTMENT_DOWN',
              department: po.department,
              dept: po.department,
              amount: poTotal - netPoAmount,
              docType: 'PO',
              docNo: poId,
              referenceDoc: poId,
              date: poDate,
              createdAt: poDate,
              actor: po.creatorName || 'System',
              notes: `ส่วนลด/คืนเงิน Direct PO: ${poId} (ลดลง ฿${(poTotal - netPoAmount).toLocaleString()})`,
              period: poDate.substring(0, 7)
            });
          }
        } else {
          if (poTotal > 0) {
            allTxs.push({
              id: `VTX-DPO-COM-${poId}`,
              type: 'COMMITMENT',
              department: po.department,
              dept: po.department,
              amount: poTotal,
              docType: 'PO',
              docNo: poId,
              referenceDoc: poId,
              date: poDate,
              createdAt: poDate,
              actor: po.creatorName || po.requesterName || 'System',
              notes: `ผูกพัน Direct PO: ${poId}`,
              period: poDate.substring(0, 7)
            });
          }
        }
      });
    }

    // Sort descending by date
    allTxs.sort((a, b) => new Date(b.createdAt || b.date || 0).getTime() - new Date(a.createdAt || a.date || 0).getTime());
    // -------------------------------------------
    return allTxs.filter(tx => {
      const txDept = String(tx.dept || tx.department || '').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase();
      const matchDept = deptsToShow.includes(txDept);
      if (!matchDept) return false;

      // Period matching: matches selectedMonthKey or falls within period if specified
      if (tx.period || tx.targetMonth) {
        const txPeriod = tx.period || tx.targetMonth;
        return txPeriod === selectedMonthKey;
      }
      const txDateStr = String(tx.date || tx.createdAt || tx.timestamp || '');
      if (txDateStr && txDateStr.length >= 7) {
        return txDateStr.substring(0, 7) === selectedMonthKey;
      }
      return true;
    });
  }, [pos, prs, deptsToShow, selectedMonthKey, context?.budgetTransactions]);

  const _handleEditSave = async (dept) => {
    if (!editBaseValue || isNaN(editBaseValue) || Number(editBaseValue) < 0) return;
    if (!deptsToShow.includes(dept)) {
      modalService.error('ปฏิเสธการเข้าถึง', 'คุณไม่มีสิทธิ์แก้ไขงบประมาณของแผนกนี้');
      return;
    }
    try {
      const actorName = currentUser?.name || currentRole?.name || 'ผู้ดูแลระบบ';
      await apiService.updateBudget(dept, Number(editBaseValue), selectedMonthKey, actorName, 'ปรับยอดงบประมาณประจำเดือน (Quick Edit)');
      setEditingBudget(null);
      if (onRefresh) onRefresh();
    } catch (e) {
      modalService.error('เกิดข้อผิดพลาด', 'ไม่สามารถบันทึกงบประมาณได้: ' + e.message);
    }
  };

  const _canEditBudget = canAllocateBudget;

  // Analytics Calculations (6-Month Comparative Dataset & Category Breakdown)
  const analyticsData = useMemo(() => {
    const trendData = [];
    const tableData = [];

    if (dynamicSummary?.trends) {
      const allMonths = Object.keys(dynamicSummary.trends).sort((a, b) => safeStringCompare(a, b));
      const targetIdx = allMonths.indexOf(selectedMonthKey);
      let rawSliceMonths = [];
      if (targetIdx !== -1) {
        const start = Math.max(0, targetIdx - (timeRange - 1));
        rawSliceMonths = allMonths.slice(start, targetIdx + 1);
      } else {
        rawSliceMonths = allMonths.slice(-timeRange);
      }

      // Dynamic Period Growth: Filter to ONLY include active month unless actual PR/PO transactions or approved budget cycles exist
      const currentBudgets = storageService.getBudgets();
      const sliceMonths = rawSliceMonths.filter(monthStr => {
        // 1. Current selected active month is always shown
        if (monthStr === selectedMonthKey) return true;

        // 2. Real PO transactions exist for this month
        const hasActualPO = Array.isArray(pos) && pos.some(po => 
          !['CANCELLED'].includes(po.status) && 
          (po.issueDate?.substring(0, 7) === monthStr || (po.createdAt && String(po.createdAt).substring(0, 7) === monthStr))
        );
        if (hasActualPO) return true;

        // 3. Real PR transactions exist for this month
        const hasActualPR = Array.isArray(prs) && prs.some(pr => 
          !['REJECTED', 'CANCELLED'].includes(pr.status) && 
          (pr.requestedDate?.substring(0, 7) === monthStr || (pr.createdAt && String(pr.createdAt).substring(0, 7) === monthStr))
        );
        if (hasActualPR) return true;

        // 4. Approved budget cycles explicitly defined in department history for this month (excluding empty/simulated months)
        const hasExplicitCycle = Object.values(currentBudgets).some(b => 
          b?.history && b.history[monthStr] !== undefined && b.history[monthStr] > 0
        );
        return hasExplicitCycle;
      });

      sliceMonths.forEach((monthStr, idx) => {
        const data = dynamicSummary.trends[monthStr] || {};
        let allocated = 0;
        let actualSpent = 0;
        let committed = 0;

        Object.keys(data).forEach(dept => {
          if (deptsToShow.includes(dept)) {
            allocated += data[dept]?.allocated || 0;
            actualSpent += data[dept]?.actualSpent || 0;
            committed += data[dept]?.committed || 0;
          }
        });

        const totalSpent = actualSpent + committed;
        const remaining = allocated - totalSpent;
        const percentage = allocated > 0 ? Math.round((totalSpent / allocated) * 100) : 0;

        const [yyyy, mm] = monthStr.split('-');
        const monthShort = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
        const monthFull = [
          "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
          "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
        ];
        const mNum = parseInt(mm, 10);
        const displayMonth = `${monthShort[mNum - 1]} ${(parseInt(yyyy, 10) + 543).toString().substring(2)}`;
        const displayMonthFull = `${monthFull[mNum - 1]} ${parseInt(yyyy, 10) + 543}`;

        // Previous month calculation for MoM comparison in table
        let momDiff = null;
        if (idx > 0 && sliceMonths[idx - 1]) {
          const prevData = dynamicSummary.trends[sliceMonths[idx - 1]] || {};
          let prevSpent = 0;
          Object.keys(prevData).forEach(dept => {
            if (deptsToShow.includes(dept)) {
              prevSpent += (prevData[dept]?.actualSpent || 0) + (prevData[dept]?.committed || 0);
            }
          });
          const diff = totalSpent - prevSpent;
          const percentDiff = prevSpent > 0 ? Math.round((diff / prevSpent) * 1000) / 10 : 0;
          momDiff = { diff, percentDiff, prevSpent };
        }

        const item = {
          month: displayMonth,
          monthFull: displayMonthFull,
          monthRaw: monthStr,
          allocated,
          actualSpent,
          committed,
          totalSpent,
          remaining,
          percentage,
          momDiff,
          isCurrent: monthStr === selectedMonthKey
        };

        trendData.push(item);
        tableData.push(item);
      });
    }

    // Category Spending (Donut Chart)
    const itemMap = {};
    pos.forEach(po => {
      if (po && (deptMap[po.department] || DEPARTMENTS[po.department]) && po.status !== 'CANCELLED' && deptsToShow.includes(po.department) && Array.isArray(po.items)) {
        po.items.forEach(item => {
          if (!item) return;
          const total = item.actUnitPrice ? item.actUnitPrice * item.qty : (item.price || 0) * (item.qty || 0);
          if (!itemMap[item.name]) itemMap[item.name] = 0;
          itemMap[item.name] += total;
        });
      }
    });

    const sortedItems = Object.keys(itemMap).map(k => ({ name: k, value: itemMap[k] })).sort((a, b) => b.value - a.value);
    const top5 = sortedItems.slice(0, 5);
    const others = sortedItems.slice(5).reduce((sum, item) => sum + item.value, 0);
    const categoryData = [...top5];
    if (others > 0) categoryData.push({ name: 'อื่นๆ (Others)', value: others });

    return { trendData, tableData, categoryData };
  }, [pos, selectedDept, dynamicSummary, selectedMonthKey, timeRange, deptsToShow]);

  const effectiveRole = effectiveUser || currentRole || currentUser;
  const isOnlinePurchaser = Boolean(
    effectiveRole?.roleId === 'ONLINE_PURCHASER' ||
    effectiveRole?.id === 'ONLINE_PURCHASER'
  );
  const hasBudgetAccess = isSuperAdminOrApprover || 
    isOnlinePurchaser ||
    effectiveRole?.canViewBudget === true || 
    effectiveRole?.canViewBudgetMenu === true ||
    (effectiveRole && (effectiveRole.roleId === 'ADMIN' || effectiveRole.level >= 99)) ||
    Boolean(auth?.canAccess && auth.canAccess('BUDGET_MANAGE'));

  if (!hasBudgetAccess && effectiveRole) {
    return (
      <div className="w-full my-12 text-center p-8 bg-white rounded-3xl border border-slate-200/80 shadow-sm space-y-4 animate-fade-in">
        <div className="p-4 bg-rose-50 text-rose-600 rounded-2xl w-16 h-16 mx-auto flex items-center justify-center border border-rose-100">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h3 className="text-lg font-bold text-slate-900">สิทธิ์การเข้าถึงถูกจำกัด (Access Restricted)</h3>
        <p className="text-sm text-slate-500 max-w-md mx-auto">
          บทบาท <b>{effectiveRole?.title || effectiveRole?.role || effectiveRole?.canonicalRole || 'ผู้ใช้งาน'}</b> ไม่ได้รับอนุญาตให้ดูข้อมูลการเงินและงบประมาณประจำเดือน
        </p>
      </div>
    );
  }

  // Minimalist Tooltip for Recharts
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const alloc = payload.find(p => p.dataKey === 'allocated')?.value || 0;
      const spent = payload.find(p => p.dataKey === 'actualSpent')?.value || 0;
      const ratio = alloc > 0 ? Math.round((spent / alloc) * 100) : 0;
      const rowItem = payload[0]?.payload;
      const displayLabel = rowItem?.monthFull || label;

      return (
        <div className="bg-slate-900/95 backdrop-blur-md text-white px-3.5 py-2.5 rounded-xl shadow-xl border border-slate-700/60 text-xs space-y-1.5 min-w-[190px]">
          <div className="font-semibold text-slate-200 border-b border-slate-700/80 pb-1 flex justify-between items-center">
            <span>{displayLabel}</span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${
              ratio > 90 ? 'bg-rose-500/20 text-rose-400' : ratio > 70 ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'
            }`}>
              {ratio}% ใช้ไป
            </span>
          </div>
          <div className="flex justify-between items-center text-slate-300">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
              งบจัดสรร:
            </span>
            <span className="font-mono font-medium text-white tabular-nums">฿{alloc.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center text-slate-300">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-indigo-400 inline-block" />
              ใช้จ่ายจริง:
            </span>
            <span className="font-mono font-bold text-indigo-300 tabular-nums">฿{spent.toLocaleString()}</span>
          </div>
          {rowItem && rowItem.remaining !== undefined && (
            <div className="flex justify-between items-center text-slate-400 pt-0.5 border-t border-slate-800">
              <span>ส่วนต่าง:</span>
              <span className={`font-mono text-[11px] ${rowItem.remaining < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {rowItem.remaining < 0 ? '-' : '+'}฿{Math.abs(rowItem.remaining).toLocaleString()}
              </span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full space-y-6 animate-fade-in pb-12">
      {/* Unified Glass Header & Action Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2.5 tracking-tight">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center shadow-xs">
                <Wallet className="w-5 h-5" />
              </div>
              <span>ระบบควบคุมงบประมาณ (Monthly Budget Management)</span>
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 font-normal">
            ระบบตัดรอบงบประมาณรายเดือน พร้อมการวิเคราะห์เปรียบเทียบย้อนหลัง (Comparative Analytics)
          </p>
        </div>

        {/* Right Controls: Decoupled Fiscal Cycle Command Bar & Standalone Department Filter */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
          
          {/* Piece 1: Fiscal Cycle Command Bar (Visual Anchor) */}
          <div 
            ref={monthPickerRef} 
            className="relative bg-white border border-slate-200/80 rounded-2xl p-2 shadow-xs hover:shadow-sm transition-all flex flex-col justify-center"
          >
            {/* Micro Header Label */}
            <div className="flex items-center justify-between px-1 mb-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              <span>รอบงบประมาณประจำเดือน</span>
              <span className="font-mono text-slate-400">({selectedMonthKey})</span>
            </div>

            {/* Stepper & Month Popover Trigger Track */}
            <div className="flex items-center gap-1 select-none">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer shadow-none hover:shadow-2xs"
                title="เดือนก่อนหน้า"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setIsMonthPickerOpen(!isMonthPickerOpen)}
                className="px-3 py-1.5 hover:bg-slate-50 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 text-slate-900 group"
                title="คลิกเพื่อเลือกเดือนจากตาราง 12 เดือน"
              >
                <Calendar className="w-4 h-4 text-emerald-600 shrink-0" />
                <span className="font-mono font-bold text-slate-900 text-sm md:text-base leading-tight tracking-tight whitespace-nowrap">
                  {thaiMonths[selectedMonth - 1]} {selectedYear + 543}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 group-hover:text-slate-700 transition-transform duration-200 ${isMonthPickerOpen ? 'rotate-180 text-emerald-600' : ''}`} />
              </button>

              <button
                type="button"
                onClick={handleNextMonth}
                className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer shadow-none hover:shadow-2xs"
                title="เดือนถัดไป"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* 12-Month Grid Popover Panel */}
            {isMonthPickerOpen && (
              <div className="absolute top-full left-0 sm:left-auto sm:right-0 mt-2 z-50 w-72 bg-white rounded-2xl border border-slate-200 p-4 shadow-2xl animate-fade-in text-slate-900">
                {/* Popover Header: Year Selector */}
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
                  <span className="text-xs font-semibold text-slate-500">เลือกปี</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPickerYear(y => y - 1)}
                      className="p-1 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                      title="ปีก่อนหน้า"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="font-mono text-xs font-bold text-slate-900 px-1">
                      {pickerYear + 543} ({pickerYear})
                    </span>
                    <button
                      type="button"
                      onClick={() => setPickerYear(y => y + 1)}
                      className="p-1 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                      title="ปีถัดไป"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* 12-Month Grid (3 cols x 4 rows) */}
                <div className="grid grid-cols-3 gap-1.5">
                  {thaiShortMonths.map((mShort, idx) => {
                    const isSelected = selectedYear === pickerYear && selectedMonth === idx + 1;
                    const isCurrent = (pickerYear === 2026 && idx === 8);

                    return (
                      <button
                        key={mShort}
                        type="button"
                        onClick={() => handleSelectMonth(idx)}
                        className={`py-2 px-1 rounded-xl text-xs font-semibold transition-all relative flex flex-col items-center justify-center cursor-pointer ${
                          isSelected
                            ? 'bg-slate-900 text-white font-bold shadow-sm'
                            : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        <span>{mShort}</span>
                        {isCurrent && !isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mt-0.5" title="เดือนปัจจุบัน" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Popover Footer: Quick Jump to Current Month */}
                <div className="pt-3 mt-3 border-t border-slate-100 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleJumpToCurrentMonth}
                    className="w-full py-1.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-2xs"
                  >
                    <Calendar className="w-3.5 h-3.5" />
                    <span>กระโดดไปเดือนปัจจุบัน</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Piece 2: Standalone Department Filter */}
          {(isSuperAdminOrApprover || userAssignedDepts.length > 1) && (
            <div className="flex flex-col justify-center">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 mb-1 hidden sm:block">
                แผนก (Department)
              </label>
              <select
                className="rounded-xl border border-slate-200/80 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-xs hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all cursor-pointer h-[42px]"
                value={selectedDept}
                onChange={(e) => handleDeptChange(e.target.value)}
              >
                {isSuperAdminOrApprover ? (
                  <>
                    <option value="ALL">📊 งบประมาณรวมทั้งโรงงาน (Factory Total Overview)</option>
                    {deptList.map(d => (
                      <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
                    ))}
                  </>
                ) : (
                  <>
                    {userAssignedDepts.length > 1 && (
                      <option value="ALL">📊 งบประมาณรวมแผนกในความดูแล ({userAssignedDepts.filter(c => c !== 'ALL').join(', ')})</option>
                    )}
                    {userAssignedDepts.filter(code => code !== 'ALL').map(code => (
                      <option key={code} value={code}>
                        {deptMap[code]?.name || DEPARTMENTS[code]?.name || code} ({code})
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          )}

          {/* Piece 3: Refresh Button */}
          <div className="flex flex-col justify-end">
            <span className="text-[10px] font-bold text-transparent uppercase tracking-wider px-1 mb-1 hidden sm:block select-none pointer-events-none">
              &nbsp;
            </span>
            <button
              type="button"
              id="budget-refresh-btn"
              data-testid="budget-refresh-btn"
              onClick={() => {
                budgetService.resetBudgetData();
                budgetService.syncSettledRefundsToBudget(pos, deptList);
                if (onRefresh) onRefresh();
                if (context?.refreshData) context.refreshData();
              }}
              className="h-[42px] px-3 bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-600 hover:text-slate-900 border border-slate-200/80 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs hover:shadow-sm transition-all cursor-pointer group"
              title="รีเฟรชและรีเซ็ตงบประมาณเป็นฐานข้อมูลปัจจุบัน (Refresh & Reset Budget Baseline)"
            >
              <RotateCw className="w-4 h-4 text-slate-400 group-hover:text-slate-700 group-hover:rotate-180 transition-all duration-300" />
              <span className="hidden xl:inline">รีเฟรช</span>
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Sub-tabs Track */}
      <div className="bg-slate-100/70 p-1 rounded-2xl inline-flex gap-1 border border-slate-200/60 shadow-2xs overflow-x-auto custom-scrollbar max-w-full">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'overview'
              ? 'bg-white text-slate-900 shadow-sm font-bold'
              : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
          }`}
        >
          <BarChart3 className="w-4 h-4 text-emerald-600" />
          <span>ภาพรวมงบประมาณรายเดือน</span>
        </button>
        <button
          onClick={() => setActiveTab('trends')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'trends'
              ? 'bg-white text-slate-900 shadow-sm font-bold'
              : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
          }`}
        >
          <TrendingUp className="w-4 h-4 text-indigo-600" />
          <span>แนวโน้ม & การเปรียบเทียบย้อนหลัง (Comparative Analytics)</span>
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 'history'
              ? 'bg-white text-slate-900 shadow-sm font-bold'
              : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
          }`}
        >
          <History className="w-4 h-4 text-slate-500" />
          <span>สมุดบัญชีความเคลื่อนไหวงบประมาณ (Budget Ledger)</span>
          {budgetTransactions.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              {budgetTransactions.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab 1: Bento Budget Cards */}
      {activeTab === 'overview' && (
        <div className="space-y-5">
          {/* Top Summary KPI Strip: Factory Total Overview (Read-Only) */}
          {deptsToShow.length > 1 && (
            <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 p-5 rounded-3xl border border-slate-700/80 text-white shadow-md space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300 shadow-inner">
                    <Building2 className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-base text-white tracking-tight">
                        {isSuperAdminOrApprover ? 'งบประมาณรวมทั้งโรงงาน (Factory Total Overview)' : `งบประมาณรวมแผนกในความดูแล (${deptsToShow.length} แผนก)`}
                      </h3>
                      <span className="text-[10px] font-mono font-bold text-amber-300 bg-amber-500/20 border border-amber-400/30 px-2.5 py-0.5 rounded-full">
                        🔒 Read-Only (ยอดรวมคำนวณอัตโนมัติ)
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5">
                      ยอดรวมคำนวณจากผลรวมของแผนกจริง ({deptsToShow.join(', ')}) — กรุณาเลือกดูและปรับงบที่การ์ดประจำแผนกด้านล่าง
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono font-bold px-3 py-1 rounded-full border ${
                    summaryStats.usedPercent >= 90 
                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' 
                      : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  }`}>
                    {summaryStats.usedPercent}% รวมใช้ไป
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-3.5 bg-white/5 hover:bg-white/10 transition-colors rounded-2xl border border-white/10">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    งบประมาณรวม ({deptsToShow.length} แผนก)
                  </span>
                  <span className="text-xl font-mono font-bold text-white block mt-1 tabular-nums">
                    ฿{summaryStats.totalBase.toLocaleString()}
                  </span>
                </div>
                <div className="p-3.5 bg-white/5 hover:bg-white/10 transition-colors rounded-2xl border border-white/10">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    ใช้จ่ายจริงรวม
                  </span>
                  <span className="text-xl font-mono font-bold text-indigo-300 block mt-1 tabular-nums">
                    ฿{summaryStats.totalActual.toLocaleString()}
                  </span>
                </div>
                <div className="p-3.5 bg-white/5 hover:bg-white/10 transition-colors rounded-2xl border border-white/10">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    ผูกพันรอของรวม
                  </span>
                  <span className="text-xl font-mono font-bold text-amber-300 block mt-1 tabular-nums">
                    ฿{summaryStats.totalCommitted.toLocaleString()}
                  </span>
                </div>
                <div className="p-3.5 bg-white/5 hover:bg-white/10 transition-colors rounded-2xl border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                      คงเหลือสุทธิ
                    </span>
                  </div>
                  <span className={`text-xl font-mono font-bold block mt-1 tabular-nums ${
                    summaryStats.totalRemaining < 0 ? 'text-rose-400' : 'text-emerald-300'
                  }`}>
                    ฿{summaryStats.totalRemaining.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
            {deptsToShow.map(dept => {
            const rawData = currentMonthSummary[dept] || {};
            const isAllocated = Boolean(rawData.isAllocated);
            const baseAllocated = isAllocated ? Number(rawData.baseAllocated ?? rawData.allocated ?? 0) : 0;
            const actualSpent = Number(rawData.actualSpent) || 0;
            const committed = Number(rawData.committed) || 0;
            const totalSpent = actualSpent + committed;
            const remaining = isAllocated ? (baseAllocated - totalSpent) : 0;

            const actualPercent = (isAllocated && baseAllocated > 0) ? Math.round((actualSpent / baseAllocated) * 100) : 0;
            const committedPercent = (isAllocated && baseAllocated > 0) ? Math.round((committed / baseAllocated) * 100) : 0;
            const totalPercent = (isAllocated && baseAllocated > 0) ? (actualPercent + committedPercent) : 0;

            const _isEditing = editingBudget === dept;
            const isCritical = isAllocated && (totalPercent >= 90 || remaining < 0);
            const isWarning = isAllocated && (totalPercent >= 70 && totalPercent < 90);

            const momDelta = rawData.momDelta;

            return (
              <div 
                key={dept} 
                className={`rounded-3xl border ${isAllocated ? 'border-slate-200/80 bg-white/90' : 'border-dashed border-amber-200 bg-amber-50/20'} p-6 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden flex flex-col justify-between`}
              >
                <div>
                  {/* 1. Header Zone: Clean Department Icon, Title, and Right Actions */}
                  <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-2xl ${isAllocated ? 'bg-indigo-50/80 border-indigo-100/70 text-indigo-600' : 'bg-amber-50 border-amber-100 text-amber-600'} border flex items-center justify-center shadow-2xs`}>
                        <Building2 className="w-5 h-5" />
                      </div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-slate-900 text-base">{deptMap[dept]?.name || DEPARTMENTS[dept]?.name || dept}</h4>
                        <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200/60">
                          {dept}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* MoM Delta Capsule (if allocated) */}
                      {isAllocated && momDelta && (
                        <div className="hidden sm:flex">
                          {momDelta.isHigher ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50/80 text-amber-700 border border-amber-200/70 shadow-2xs">
                              <ArrowUpRight className="w-3.5 h-3.5" />
                              <span>+{momDelta.spentPercentDiff}% vs ด.ก่อน</span>
                            </span>
                          ) : momDelta.isLower ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50/80 text-emerald-700 border border-emerald-200/70 shadow-2xs">
                              <ArrowDownRight className="w-3.5 h-3.5" />
                              <span>ประหยัด ฿{Math.abs(momDelta.spentDiff).toLocaleString()}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-50 text-slate-600 border border-slate-200">
                              <Minus className="w-3.5 h-3.5" />
                              <span>คงที่</span>
                            </span>
                          )}
                        </div>
                      )}

                      {canAllocateBudget && (
                        <button 
                          type="button"
                          id={`btn-edit-budget-${dept}`}
                          data-testid={`btn-edit-budget-${dept}`}
                          onClick={() => setDeptAllocationTarget({
                            dept,
                            deptName: deptMap[dept]?.name || DEPARTMENTS[dept]?.name || dept,
                            currentAmount: baseAllocated
                          })}
                          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
                          title={`จัดการงบประมาณ ${deptMap[dept]?.name || DEPARTMENTS[dept]?.name || dept}`}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 space-y-4">
                    {/* 2. Hero Metric & Dynamic Progress (Visual Hierarchy Anchor) */}
                    <div className="flex items-end justify-between">
                      <div>
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">
                          งบประมาณคงเหลือ (Remaining)
                        </span>
                        <h3 className={`font-mono text-3xl font-extrabold mt-1 tracking-tight tabular-nums ${
                          !isAllocated ? 'text-slate-400' : (remaining < (baseAllocated * 0.1) || remaining < 0 ? 'text-rose-600' : 'text-emerald-600')
                        }`}>
                          {isAllocated ? `${remaining < 0 ? '-' : ''}฿${Math.abs(remaining).toLocaleString()}` : '฿0'}
                        </h3>
                      </div>

                      <div className="text-right flex flex-col items-end">
                        {isAllocated ? (
                          <>
                            <span className={`font-mono text-xl font-bold tabular-nums ${
                              isCritical ? 'text-rose-600' : isWarning ? 'text-amber-600' : 'text-slate-900'
                            }`}>
                              {totalPercent}%
                            </span>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${
                                isCritical ? 'bg-rose-500 animate-pulse' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'
                              }`} />
                              <span className={`text-[11px] font-medium ${
                                isCritical ? 'text-rose-600 font-semibold' : isWarning ? 'text-amber-600' : 'text-slate-500'
                              }`}>
                                {isCritical ? 'ใกล้เต็มงบ' : isWarning ? 'เฝ้าระวัง' : 'ปกติ'}
                              </span>
                            </div>
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                            ยังไม่มีงบประมาณ
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Modern Slim Progress Bar */}
                    <div className="space-y-1.5 pt-1">
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden flex">
                        {isAllocated ? (
                          <>
                            {/* Segment 1: Actual Spent */}
                            <div 
                              className="bg-indigo-600 h-full transition-all duration-300"
                              style={{ width: `${Math.min(actualPercent, 100)}%` }}
                              title={`ใช้จริง: ${actualPercent}%`}
                            />
                            {/* Segment 2: Committed */}
                            <div 
                              className="bg-amber-400 h-full transition-all duration-300"
                              style={{ width: `${Math.min(committedPercent, Math.max(0, 100 - actualPercent))}%` }}
                              title={`ผูกพัน: ${committedPercent}%`}
                            />
                          </>
                        ) : null}
                      </div>
                    </div>

                    {/* 3. Bento Metric Strip (3 Columns) */}
                    <div className="grid grid-cols-3 gap-2 mt-5 bg-slate-50/70 p-3 rounded-2xl border border-slate-100">
                      <div>
                        <span className="text-[11px] font-medium text-slate-500 block">งบตั้งต้น</span>
                        <span className="font-mono text-sm font-bold text-slate-800 tracking-tight tabular-nums block mt-0.5">
                          ฿{baseAllocated.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <span className="text-[11px] font-medium text-slate-500 block">ใช้จริง</span>
                        <span className="font-mono text-sm font-bold text-slate-800 tracking-tight tabular-nums block mt-0.5">
                          ฿{actualSpent.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <span className="text-[11px] font-medium text-slate-500 block">ผูกพันรอของ</span>
                        <span className="font-mono text-sm font-bold text-slate-800 tracking-tight tabular-nums block mt-0.5">
                          ฿{committed.toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* 4. Action Area for Unallocated Month */}
                    {!isAllocated && (
                      <div className="pt-1">
                        {canAllocateBudget ? (
                          <button
                            type="button"
                            onClick={() => setDeptAllocationTarget({
                              dept,
                              deptName: deptMap[dept]?.name || DEPARTMENTS[dept]?.name || dept,
                              currentAmount: 0
                            })}
                            className="w-full py-2.5 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-sm active:scale-98"
                          >
                            <Plus className="w-4 h-4" />
                            <span>จัดสรรงบประมาณประจำเดือน ({dept})</span>
                          </button>
                        ) : (
                          <div className="p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl flex items-center justify-center gap-2 text-slate-500 text-xs font-medium">
                            <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>รอการจัดสรรงบประมาณจาก Asst. Manager</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      )}

      {/* Tab 2: Trends & Comparative Analytics */}
      {activeTab === 'trends' && (
        <div className="space-y-6">
          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Multi-Range Comparative Bar Chart (Allocated vs Actual Spent) */}
            <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                <div>
                  <h4 className="font-bold text-slate-900 text-base">
                    เปรียบเทียบงบประมาณจัดสรร vs ยอดใช้จ่ายจริง (ย้อนหลัง {timeRange} เดือน)
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    เปรียบเทียบ Bar Chart แบบ 2 แท่งคู่กันเพื่อตรวจสอบประสิทธิภาพการใช้งบประมาณรายเดือน
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  {/* Range Selector: Segmented Pill */}
                  <div className="inline-flex items-center bg-slate-100/90 p-1 rounded-xl border border-slate-200/80 shadow-2xs">
                    {RANGE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setTimeRange(opt.value)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          timeRange === opt.value
                            ? 'bg-white text-indigo-700 shadow-xs font-bold'
                            : 'text-slate-500 hover:text-slate-900 hover:bg-white/50'
                        }`}
                        title={`ดูย้อนหลัง ${opt.value} เดือน`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <span className="px-3 py-1 bg-slate-100 rounded-xl text-xs font-semibold text-slate-700 w-fit">
                    {selectedDept === 'ALL' 
                      ? (isSuperAdminOrApprover ? 'งบประมาณรวมทั้งโรงงาน (Factory Total Overview)' : `รวมแผนกในความดูแล (${userAssignedDepts.filter(c => c !== 'ALL').join(', ')})`) 
                      : `แผนก ${selectedDept}`}
                  </span>
                </div>
              </div>

              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart 
                    data={analyticsData.trendData} 
                    barGap={timeRange > 12 ? 1 : 3} 
                    barCategoryGap={timeRange > 12 ? '10%' : '20%'}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis 
                      dataKey="month" 
                      stroke="#94a3b8" 
                      fontSize={timeRange > 12 ? 9 : 11} 
                      tickLine={false}
                      interval={timeRange === 24 ? 1 : 0}
                      angle={timeRange > 6 ? -35 : 0}
                      textAnchor={timeRange > 6 ? 'end' : 'middle'}
                      height={timeRange > 6 ? 42 : 28}
                    />
                    <YAxis 
                      stroke="#94a3b8" 
                      fontSize={11} 
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={v => `฿${(v/1000).toFixed(0)}k`} 
                    />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Legend 
                      verticalAlign="top" 
                      align="right" 
                      iconType="circle"
                      wrapperStyle={{ paddingBottom: '16px', fontSize: '12px' }}
                    />
                    <Bar 
                      dataKey="allocated" 
                      name="งบประมาณจัดสรร" 
                      fill="#CBD5E1" 
                      radius={[3, 3, 0, 0]} 
                      maxBarSize={timeRange === 24 ? 8 : timeRange === 12 ? 14 : 22}
                    />
                    <Bar 
                      dataKey="actualSpent" 
                      name="ยอดใช้จ่ายจริง" 
                      fill="#4F46E5" 
                      radius={[3, 3, 0, 0]} 
                      maxBarSize={timeRange === 24 ? 8 : timeRange === 12 ? 14 : 22}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Category Donut Chart */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm flex flex-col justify-between">
              <div>
                <h4 className="font-bold text-slate-900 text-base">สัดส่วนค่าใช้จ่ายตามรายการ</h4>
                <p className="text-xs text-slate-500 mt-0.5">5 อันดับรายการที่มีการสั่งซื้อสูงสุด</p>
              </div>

              <div className="h-64 my-auto flex items-center justify-center">
                {analyticsData.categoryData.length === 0 ? (
                  <div className="text-xs text-slate-400 text-center">ไม่มีข้อมูลค่าใช้จ่ายตามรายการ</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <RechartsPieChart>
                      <Pie
                        data={analyticsData.categoryData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {analyticsData.categoryData.map((entry, index) => {
                          const colors = ['#4F46E5', '#10B981', '#F59E0B', '#3B82F6', '#8B5CF6', '#94A3B8'];
                          return <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />;
                        })}
                      </Pie>
                      <RechartsTooltip formatter={v => `฿${Number(v).toLocaleString()}`} />
                    </RechartsPieChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="space-y-1.5 pt-2 border-t border-slate-100">
                {analyticsData.categoryData.slice(0, 3).map((item, idx) => {
                  const colors = ['bg-indigo-600', 'bg-emerald-500', 'bg-amber-500'];
                  return (
                    <div key={idx} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-slate-600 truncate max-w-[150px]">
                        <span className={`w-2 h-2 rounded-full ${colors[idx]} inline-block shrink-0`} />
                        <span className="truncate">{item.name}</span>
                      </span>
                      <span className="font-mono font-semibold text-slate-800 tabular-nums">
                        ฿{item.value.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Historical Comparison Table */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="p-5 bg-slate-50/80 border-b border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-indigo-600" />
                  <span>ตารางวิเคราะห์เปรียบเทียบงบประมาณรายเดือน (Historical Monthly Comparison)</span>
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {analyticsData.tableData.length > 1
                    ? `แสดงผลการเบิกจ่าย เปอร์เซ็นต์การใช้งาน ส่วนต่างคงเหลือ และการเปลี่ยนแปลง MoM ย้อนหลัง ${analyticsData.tableData.length} เดือน`
                    : 'แสดงผลการเบิกจ่าย เปอร์เซ็นต์การใช้งาน และส่วนต่างคงเหลือรอบบัญชีปัจจุบัน'}
                </p>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {analyticsData.tableData.length > 1
                  ? `ข้อมูลเปรียบเทียบ ${analyticsData.tableData.length} รอบ (${analyticsData.tableData[0]?.monthRaw} ถึง ${analyticsData.tableData[analyticsData.tableData.length - 1]?.monthRaw})`
                  : `รอบบัญชีปัจจุบัน (${analyticsData.tableData[0]?.monthRaw || selectedMonthKey})`}
              </span>
            </div>

            <div className="overflow-x-auto max-h-[560px] overflow-y-auto custom-scrollbar">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-slate-50/95 backdrop-blur-xs text-slate-500 text-[11px] font-bold uppercase tracking-wider border-b border-slate-200/80 sticky top-0 z-10 shadow-2xs">
                  <tr>
                    <th className="py-3.5 pl-6">เดือน / รอบบัญชี</th>
                    <th className="py-3.5 px-4 text-right">งบจัดสรร (฿)</th>
                    <th className="py-3.5 px-4 text-right">ใช้จ่ายจริง (฿)</th>
                    <th className="py-3.5 px-4 text-right">ผูกพัน (฿)</th>
                    <th className="py-3.5 px-4 text-right">รวมใช้ไป (฿)</th>
                    <th className="py-3.5 px-4 text-center">อัตราการใช้ (%)</th>
                    <th className="py-3.5 px-4 text-right">ส่วนต่างคงเหลือ (฿)</th>
                    <th className="py-3.5 px-4 text-center">เปรียบเทียบ MoM</th>
                    <th className="py-3.5 pr-6 text-center">สถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analyticsData.tableData.map((row) => {
                    const isOver = row.remaining < 0 || row.percentage > 100;
                    const isWatch = row.percentage >= 70 && row.percentage < 90;
                    const isNear = row.percentage >= 90 && row.percentage <= 100;

                    return (
                      <tr 
                        key={row.monthRaw} 
                        className={`transition-colors hover:bg-slate-50/80 ${
                          row.isCurrent ? 'bg-indigo-50/30 font-medium' : ''
                        }`}
                      >
                        <td className="py-3.5 pl-6 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-900 font-semibold">{row.monthFull}</span>
                            {row.isCurrent && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700">
                                เดือนปัจจุบัน
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono text-slate-400 block mt-0.5">
                            {row.monthRaw}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono text-slate-700 tabular-nums">
                          ฿{row.allocated.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono font-semibold text-indigo-600 tabular-nums">
                          ฿{row.actualSpent.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono text-amber-600 tabular-nums">
                          ฿{row.committed.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-900 tabular-nums">
                          ฿{row.totalSpent.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-center font-mono font-bold">
                          <span className={`inline-block px-2 py-0.5 rounded-md text-xs ${
                            isOver ? 'bg-rose-100 text-rose-800' : isNear ? 'bg-rose-50 text-rose-700' : isWatch ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
                          }`}>
                            {row.percentage}%
                          </span>
                        </td>

                        <td className={`py-3.5 px-4 text-right font-mono font-bold tabular-nums ${
                          row.remaining < 0 ? 'text-rose-600' : 'text-emerald-700'
                        }`}>
                          ฿{row.remaining.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-center">
                          {row.momDiff ? (
                            row.momDiff.diff > 0 ? (
                              <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-amber-600">
                                <ArrowUpRight className="w-3.5 h-3.5" />
                                +{row.momDiff.percentDiff}%
                              </span>
                            ) : row.momDiff.diff < 0 ? (
                              <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-emerald-600">
                                <ArrowDownRight className="w-3.5 h-3.5" />
                                ประหยัด ฿{Math.abs(row.momDiff.diff).toLocaleString()}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-400">— คงที่</span>
                            )
                          ) : (
                            <span className="text-[11px] text-slate-400 font-mono">รอบฐาน</span>
                          )}
                        </td>

                        <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                          {isOver ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
                              <AlertTriangle className="w-3 h-3" /> เกินงบ
                            </span>
                          ) : isNear ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                              ใกล้เต็มงบ
                            </span>
                          ) : isWatch ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              เฝ้าระวัง
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <CheckCircle2 className="w-3 h-3" /> ปกติ
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: History & Refund Logs */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col">
          <div className="p-5 bg-slate-50/80 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h4 className="font-bold text-slate-900 text-sm">สมุดบัญชีความเคลื่อนไหวงบประมาณ (Budget Ledger)</h4>
            
            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1 sm:pb-0">
              <button 
                onClick={() => setLedgerFilter('ALL')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${ledgerFilter === 'ALL' ? 'bg-slate-800 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                ทั้งหมด
              </button>
              <button 
                onClick={() => setLedgerFilter('ACTUAL_SPEND')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${ledgerFilter === 'ACTUAL_SPEND' ? 'bg-rose-600 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                ใช้จริง (Actual Spend)
              </button>
              <button 
                onClick={() => setLedgerFilter('COMMITMENT')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${ledgerFilter === 'COMMITMENT' ? 'bg-amber-500 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                ผูกพัน (Commitment)
              </button>
              <button 
                onClick={() => setLedgerFilter('REFUND')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${ledgerFilter === 'REFUND' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                คืนเงิน & ปรับปรุง
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-bold uppercase tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3.5 pl-6">วัน-เวลา</th>
                  <th className="py-3.5 px-4">ประเภทรายการ</th>
                  <th className="py-3.5 px-4">แผนก</th>
                  <th className="py-3.5 px-4 text-right">จำนวนเงิน</th>
                  <th className="py-3.5 px-4">อ้างอิงเอกสาร</th>
                  <th className="py-3.5 pr-6">หมายเหตุ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {budgetTransactions.filter(tx => {
                  const txType = String(tx.type || tx.transactionType || tx.actionType || '').toUpperCase();
                  if (ledgerFilter === 'ACTUAL_SPEND') return ['ACTUAL_SPEND', 'PO_SPEND', 'DIRECT_SPEND'].includes(txType);
                  if (ledgerFilter === 'COMMITMENT') return ['PR_COMMITMENT', 'COMMITMENT', 'PO_COMMITMENT', 'RESERVED'].includes(txType);
                  if (ledgerFilter === 'REFUND') return ['PR_RELEASE', 'PO_CANCEL_REFUND', 'CLAIM_REFUND', 'REFUND_SETTLEMENT', 'BUDGET_ROLLBACK', 'BUDGET_RESTORED_CLAIM_REFUND', 'TOP_UP', 'MONTHLY_ALLOCATION', 'SET_BUDGET', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP'].includes(txType);
                  return true; // ALL
                }).length === 0 ? (
                  <tr>
                    <td colSpan="6" className="p-8 text-center text-slate-400">
                      ยังไม่มีประวัติความเคลื่อนไหวงบประมาณในหมวดหมู่นี้
                    </td>
                  </tr>
                ) : (
                  budgetTransactions.filter(tx => {
                    const txType = String(tx.type || tx.transactionType || tx.actionType || '').toUpperCase();
                    if (ledgerFilter === 'ACTUAL_SPEND') return ['ACTUAL_SPEND', 'PO_SPEND', 'DIRECT_SPEND'].includes(txType);
                    if (ledgerFilter === 'COMMITMENT') return ['PR_COMMITMENT', 'COMMITMENT', 'PO_COMMITMENT', 'RESERVED'].includes(txType);
                    if (ledgerFilter === 'REFUND') return ['PR_RELEASE', 'PO_CANCEL_REFUND', 'CLAIM_REFUND', 'REFUND_SETTLEMENT', 'BUDGET_ROLLBACK', 'BUDGET_RESTORED_CLAIM_REFUND', 'TOP_UP', 'MONTHLY_ALLOCATION', 'SET_BUDGET', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP'].includes(txType);
                    return true;
                  }).map(tx => {
                    const amountNum = Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount ?? 0);

                    const docRef = tx.referenceDoc || tx.docNo || tx.poNumber || tx.poNo || tx.refDocNo || tx.refId || tx.referencePo || (tx.note?.match(/PO-[A-Z0-9-]+/i)?.[0]) || '-';
                    const deptDisplay = tx.departmentName || (tx.department ? (tx.department.startsWith('ฝ่าย') ? tx.department : `ฝ่าย ${tx.department}`) : (tx.dept ? `ฝ่าย ${tx.dept}` : 'ฝ่าย PD'));

                    const rawType = String(tx.type || tx.transactionType || tx.actionType || '').toUpperCase();
                    const isRefund = ['REFUND_SETTLEMENT', 'BUDGET_ROLLBACK', 'REFUND_CREDIT', 'BUDGET_RESTORED_CLAIM_REFUND'].includes(rawType) ||
                                     Boolean(tx.referencePo || (tx.poNumber && !['MONTHLY_ALLOCATION', 'SET_BUDGET'].includes(rawType)) || tx.storeKey || String(tx.note || '').includes('คืนเงิน'));
                    const isMonthlyAlloc = rawType === 'MONTHLY_ALLOCATION' || rawType === 'ALLOCATE_BUDGET' || (rawType === 'SET_BUDGET' && !isRefund && (tx.previousAmount === 0 || tx.isInitialAllocation));
                    const isTopUp = rawType === 'TOP_UP';

                    const isClaimRefund = rawType === 'CLAIM_REFUND' || rawType === 'PO_CANCEL_REFUND' || rawType === 'PR_RELEASE';
                    const isActualSpend = rawType === 'ACTUAL_SPEND';
                    const isCommitment = rawType === 'PR_COMMITMENT';

                    let badgeText = 'ปรับปรุงงบประมาณ';
                    let badgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
                    let isIncome = false;
                    let isExpense = false;

                    if (rawType === 'BUDGET_ADJUSTMENT_DOWN') {
                      badgeText = 'คืนงบประมาณ (ประหยัด)';
                      badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                      isIncome = true;
                    } else if (rawType === 'BUDGET_ADJUSTMENT_UP') {
                      badgeText = 'เพิ่มเงินงบประมาณ (เกินงบ)';
                      badgeClass = 'bg-rose-50 text-rose-700 border-rose-200';
                      isExpense = true;
                    } else if (isRefund || isClaimRefund) {
                      badgeText = 'คืนงบประมาณ';
                      badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                      isIncome = true;
                    } else if (isMonthlyAlloc) {
                      badgeText = 'จัดสรรงบประมาณ';
                      badgeClass = 'bg-indigo-50 text-indigo-700 border-indigo-200';
                      isIncome = true;
                    } else if (isTopUp) {
                      badgeText = 'เติมงบประมาณ';
                      badgeClass = 'bg-teal-50 text-teal-700 border-teal-200';
                      isIncome = true;
                    } else if (isActualSpend) {
                      badgeText = 'ใช้จ่ายจริง';
                      badgeClass = 'bg-rose-50 text-rose-700 border-rose-200';
                      isExpense = true;
                    } else if (isCommitment) {
                      badgeText = 'ผูกพันงบประมาณ';
                      badgeClass = 'bg-amber-50 text-amber-700 border-amber-200';
                      isExpense = true;
                    } else if (amountNum < 0) {
                      badgeText = 'ปรับลดยอดงบประมาณ';
                      badgeClass = 'bg-rose-50 text-rose-700 border-rose-200';
                      isExpense = true;
                    } else {
                      isIncome = true;
                    }

                    // Strict amount sign formatting based on transaction nature (Income vs Expense)
                    const absAmount = Math.abs(amountNum);
                    const signPrefix = isIncome ? '+฿' : isExpense ? '-฿' : '฿';
                    const absAmountFormatted = absAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    const amountColor = isIncome ? 'text-emerald-600' : isExpense ? 'text-rose-600' : 'text-slate-600';

                    return (
                      <tr key={tx.id || tx.transactionId || Math.random()} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3.5 pl-6 whitespace-nowrap text-slate-500 font-mono text-xs">
                          {formatThaiDateTime(tx.createdAt || tx.date)}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${badgeClass}`}>
                            <span>{badgeText}</span>
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-slate-800">
                          {deptDisplay}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                          <span className={`font-semibold ${amountColor} font-mono`}>
                            {signPrefix}{absAmountFormatted}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-indigo-600 font-medium">
                          {docRef !== '-' ? (
                            <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-mono text-xs font-semibold">
                              {docRef}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-3.5 pr-6 text-xs text-slate-600">
                          {tx.remark || tx.note || '-'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}



      {/* ── Department-Level Budget Allocation Modal (Asst. Manager & Admin) ── */}
      <DepartmentAllocationModal
        isOpen={Boolean(deptAllocationTarget)}
        onClose={() => setDeptAllocationTarget(null)}
        department={deptAllocationTarget?.dept}
        departmentName={deptAllocationTarget?.deptName}
        targetPeriod={selectedMonthKey}
        currentAmount={deptAllocationTarget?.currentAmount || 0}
        currentUser={effectiveUser || currentUser}
        currentRole={effectiveUser || currentRole}
        onSuccess={() => {
          setDeptAllocationTarget(null);
          if (onRefresh) onRefresh();
          if (context?.refreshData) context.refreshData();
        }}
      />
    </div>
  );
}
