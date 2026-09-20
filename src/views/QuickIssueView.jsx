import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { storageService } from '../services/storageService';
import { apiService } from '../services/apiService';
import { ISSUE_LOCATIONS, ISSUE_LOCATION_CONFIG } from '../config/constants';
import { hasDepartmentAccess, getUserAccessibleDepartments, matchDepartment } from '../utils/permissions';
import { 
  SendToBack, CheckCircle2, AlertCircle, AlertTriangle, 
  PackageCheck, Layers, MapPin, Clock, ArrowRight,
  History, Boxes, Building2, User, Sparkles, PlusCircle, Check,
  BarChart2, Calendar, Filter, Search, Download, ChevronRight,
  LayoutGrid, ListFilter, SlidersHorizontal, DoorClosed, DoorOpen, Briefcase,
  FileSpreadsheet, ArrowUpRight, ArrowDownRight, Tag, PieChart,
  RefreshCw, TrendingUp, HelpCircle, Zap,
  Minus, Plus
} from 'lucide-react';
import SearchableSelect from '../components/common/SearchableSelect';
import Pagination from '../components/common/Pagination';
import { safeStringCompare, formatThaiDateTime, parseSafeDate } from '../utils/formatters';
import { healMACForProduct } from '../utils/macMigration';

const ISSUE_REASONS = [
  'เบิกใช้ในสายการผลิต (Production Line)',
  'เบิกสำหรับสุ่มทดสอบ QC / Lab Test',
  'เบิกสำหรับงานซ่อมบำรุง (Maintenance / PM)',
  'เบิกใช้ทั่วไปภายในแผนก',
  'ปรับปรุงยอดสินค้าชำรุด / เสื่อมสภาพ',
  'อื่นๆ (ระบุในหมายเหตุ)'
];

// Helper to reliably parse date from stock logs using parseSafeDate
const parseLogDate = (log) => {
  if (!log) return new Date();
  return parseSafeDate(log.timestamp || log.date);
};

// Helper to extract unit / room name from log
// Priority: log.location (new GAS field) > log.issueUnit > note bracket pattern
const getLogUnit = (log) => {
  if (log.location && String(log.location).trim()) return String(log.location).trim();
  if (log.issueUnit && String(log.issueUnit).trim()) return String(log.issueUnit).trim();
  if (log.issuedTo && String(log.issuedTo).trim() && !String(log.issuedTo).includes('@')) {
    return String(log.issuedTo).trim();
  }
  if (log.note) {
    const match = log.note.match(/\[(.*?)\]/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return 'ไม่ระบุหน่วย';
};

// Helper to check if a log is a stock-out event
const isStockOutLog = (log) => {
  const typeStr = String(log.type || '').toUpperCase();
  if (['OUT', 'ISSUE', 'DISPATCH'].includes(typeStr)) return true;
  // Negative changeQty is always a deduction
  if (Number(log.changeQty) < 0) return true;
  return false;
};

export default function QuickIssueView({
  products = [],
  stockLogs = [],
  usageUnits: propUsageUnits,
  departments = [],
  currentRole,
  currentUser: propCurrentUser,
  onRefresh,
  onNavigate,
  onQuickPR,
  onIssueStock
}) {
  const user = useMemo(() => propCurrentUser || currentRole || {}, [propCurrentUser, currentRole]);

  const deptList = useMemo(() => {
    return (departments && departments.length > 0) ? departments : storageService.getDepartments();
  }, [departments]);

  const userAccessibleDepts = useMemo(() => {
    const allCodes = deptList.map(d => d.code);
    return getUserAccessibleDepartments(user, allCodes);
  }, [user, deptList]);
  const hasMultiDeptAccess = userAccessibleDepts.length > 1;

  const [activeTab, setActiveTab] = useState('ISSUE'); // 'ISSUE' | 'STATS'

  const allUsageUnits = useMemo(() => {
    if (propUsageUnits && Array.isArray(propUsageUnits)) return propUsageUnits;
    return [];
  }, [propUsageUnits]);

  // Usage units strictly filtered by user's permitted departments
  const userAllowedUnits = useMemo(() => {
    return allUsageUnits.filter(u => hasDepartmentAccess(user, u.department));
  }, [allUsageUnits, user]);

  // Form State
  const [categoryFilter, setCategoryFilter] = useState(() => hasMultiDeptAccess ? 'ALL' : (userAccessibleDepts[0] || user?.department || 'PD'));
  const [selectedProdId, setSelectedProdId] = useState('');
  const [issueQty, setIssueQty] = useState(1);
  const [reason, setReason] = useState(ISSUE_REASONS[0]);
  const [note, setNote] = useState('');
  const [productionUnit, setProductionUnit] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [customUnitCost, setCustomUnitCost] = useState(null);
  const [costUpdateToast, setCostUpdateToast] = useState('');

  // Statistics & Analytics Filter State
  const [statsUnitFilter, setStatsUnitFilter] = useState('ALL'); // 'ALL' | 'ห้อง K1' | ...
  const [statsTimeFilter, setStatsTimeFilter] = useState('ALL'); // 'ALL' | 'TODAY' | 'WEEK' | 'MONTH' | 'CUSTOM'
  const [statsCustomStart, setStatsCustomStart] = useState('');
  const [statsCustomEnd, setStatsCustomEnd] = useState('');
  const [statsDeptFilter, setStatsDeptFilter] = useState(() => hasMultiDeptAccess ? 'ALL' : (userAccessibleDepts[0] || user?.department || 'PD'));
  const [statsSearchQuery, setStatsSearchQuery] = useState('');
  const [statsViewMode, setStatsViewMode] = useState('MATRIX'); // 'MATRIX' (Item x Unit table) | 'LOGS' (Detailed table)

  // Pagination for Stats views (MATRIX and LOGS)
  const [matrixPage, setMatrixPage] = useState(1);
  const [matrixPageSize, setMatrixPageSize] = useState(10);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(10);

  // Auto-reset page when filters change
  useEffect(() => {
    setMatrixPage(1);
    setLogsPage(1);
  }, [statsUnitFilter, statsTimeFilter, statsCustomStart, statsCustomEnd, statsDeptFilter, statsSearchQuery, statsViewMode]);

  // Synchronize department & unit filters when user/role changes (Fast Switcher)
  useEffect(() => {
    const initialDept = hasMultiDeptAccess ? 'ALL' : (userAccessibleDepts[0] || user?.department || 'PD');
    setStatsDeptFilter(initialDept);
    setStatsUnitFilter('ALL');
    setCategoryFilter(hasMultiDeptAccess ? 'ALL' : (userAccessibleDepts[0] || user?.department || 'PD'));
  }, [user?.id, user?.username, hasMultiDeptAccess, userAccessibleDepts, user?.department]);

  // Department and Category Filtered Products (Allow Inactive products with remaining stock to be issued)
  const filteredProducts = useMemo(() => {
    return products
      .filter(p => {
        const isInactive = p.isActive === false || String(p.status || '').toUpperCase() === 'INACTIVE';
        const stock = Number(p.stockBalance || 0);
        // Directive 3: Inactive items with stock > 0 remain available to be issued until exhausted.
        // Inactive items with stock <= 0 are excluded from quick issue.
        if (isInactive && stock <= 0) return false;
        const pCat = p.category || p.department || 'PD';
        const matchesDept = hasDepartmentAccess(user, pCat);
        const matchesCat = categoryFilter === 'ALL' || pCat === categoryFilter;
        return matchesDept && matchesCat;
      })
      .sort((a, b) => safeStringCompare(a?.code, b?.code));
  }, [products, user, categoryFilter]);

  // Transform to SearchableSelect options
  const productOptions = useMemo(() => {
    return filteredProducts.map(p => {
      const isInactive = p.isActive === false || String(p.status || '').toUpperCase() === 'INACTIVE';
      const sUnit = p.stockUnit || p.unit || 'ชิ้น';
      const pUnit = p.purchaseUnit || p.unit || sUnit;
      const rate = Number(p.conversionRate) > 0 ? Number(p.conversionRate) : 1;
      const dualText = rate > 1 
        ? ` • (≈ ${((p.stockBalance || 0) / rate).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} ${pUnit})` 
        : '';
      const pCat = p.category || p.department || 'PD';
      return {
        value: p.id,
        label: isInactive ? `${p.name} (ยกเลิกใช้งาน/รอเคลียร์สต็อก)` : p.name,
        code: p.code,
        subLabel: `จุดเก็บ: ${p.locationName || 'คลังหลัก'} • คงเหลือ: ${Number(p.stockBalance || 0).toLocaleString()} ${sUnit}${dualText}${isInactive ? ' • [ปิดใช้งาน/รอเคลียร์สต็อก]' : ` • ROP: ${Number(p.reorderPoint || 0).toLocaleString()} ${sUnit}`}`,
        badge: isInactive ? 'รอเคลียร์สต็อก' : (pCat === 'PD' ? 'ฝ่ายผลิต' : 'ฝ่าย QC'),
        badgeClass: isInactive ? 'bg-amber-100 text-amber-800 border-amber-200' : undefined,
        keywords: `${p.code} ${p.name} ${sUnit} ${pUnit} ${pCat} ${p.locationName || ''} ${isInactive ? 'inactive ยกเลิก ปิดการใช้งาน เคลียร์สต็อก' : ''}`
      };
    });
  }, [filteredProducts]);

  // Fresh fetch on mount: Always retrieve latest product & inventory data
  useEffect(() => {
    if (typeof onRefresh === 'function') {
      onRefresh(true);
    }
  }, [onRefresh]);

  // Set initial product if not set
  React.useEffect(() => {
    if (filteredProducts.length > 0 && (!selectedProdId || !filteredProducts.some(p => p.id === selectedProdId))) {
      setSelectedProdId(filteredProducts[0].id);
    }
  }, [filteredProducts, selectedProdId]);

  const selectedProduct = filteredProducts.find(p => p.id === selectedProdId) || products.find(p => p.id === selectedProdId);

  // Target department for form based on selected product or current role
  const formDept = useMemo(() => {
    if (selectedProduct?.category) return selectedProduct.category;
    if (selectedProduct?.department) return selectedProduct.department;
    if (currentRole?.department && !currentRole.canViewAllDepts) return currentRole.department;
    return categoryFilter !== 'ALL' ? categoryFilter : 'PD';
  }, [selectedProduct, currentRole, categoryFilter]);

  // Dynamic usage units for form tab (Department-Scoped)
  const formUsageUnits = useMemo(() => {
    const matched = allUsageUnits.filter(u => u.department === formDept && u.status !== 'INACTIVE');
    if (matched.length > 0) return matched;
    const fallbackDept = allUsageUnits.filter(u => u.department === formDept);
    if (fallbackDept.length > 0) return fallbackDept;
    return allUsageUnits;
  }, [allUsageUnits, formDept]);

  // Dynamic displayed units for Statistics Tab based on dropdown filter
  const displayedUnits = useMemo(() => {
    if (statsDeptFilter === 'ALL') {
      return userAllowedUnits;
    }
    return userAllowedUnits.filter(u => u.department === statsDeptFilter);
  }, [userAllowedUnits, statsDeptFilter]);

  // Dynamic usage unit config map for styling & dots
  const usageUnitConfigMap = useMemo(() => {
    const map = { ...ISSUE_LOCATION_CONFIG };
    allUsageUnits.forEach(u => {
      map[u.name] = {
        id: u.name,
        label: u.name,
        color: u.color || 'bg-slate-100 text-slate-700 border-slate-200',
        badgeBg: u.badgeBg || 'bg-slate-100 text-slate-800',
        dot: u.dot || 'bg-slate-500',
        department: u.department
      };
    });
    return map;
  }, [allUsageUnits]);

  // Auto-select first unit of the department when department changes or current selection is invalid
  useEffect(() => {
    if (formUsageUnits.length > 0) {
      const exists = formUsageUnits.some(u => u.name === productionUnit);
      if (!exists) {
        setProductionUnit(formUsageUnits[0].name);
      }
    }
  }, [formUsageUnits, productionUnit]);

  // Reset statsUnitFilter if it does not belong to displayedUnits
  useEffect(() => {
    if (statsUnitFilter !== 'ALL') {
      const exists = displayedUnits.some(u => u.name === statsUnitFilter);
      if (!exists) setStatsUnitFilter('ALL');
    }
  }, [displayedUnits, statsUnitFilter]);

  // Post-issue balance calculation & ROP Warning logic
  const isInactive = selectedProduct?.isActive === false || String(selectedProduct?.status || '').toUpperCase() === 'INACTIVE';
  const currentBalance = Number(selectedProduct?.stockBalance || 0);
  const qtyNumber = Number(issueQty || 0);
  const postIssueBalance = Math.round((currentBalance - qtyNumber) * 10000) / 10000;
  const reorderPoint = Number(selectedProduct?.reorderPoint || 0);
  const willTriggerROP = !isInactive && selectedProduct && postIssueBalance <= reorderPoint && postIssueBalance >= 0;
  const isOutOfStock = selectedProduct && postIssueBalance < 0;

  const sUnit = selectedProduct?.stockUnit || selectedProduct?.unit || 'ชิ้น';
  const pUnit = selectedProduct?.purchaseUnit || selectedProduct?.unit || sUnit;
  const rate = Number(selectedProduct?.conversionRate) > 0 ? Number(selectedProduct.conversionRate) : 1;

  // Moving Average Cost (MAC) with Auto-fallback Fail-safe:
  // If product.averageCost > 0, use it immediately.
  // If 0/empty but product has remaining stock, fall back to unitPrice from latest IN log in stockLogs.
  const effectiveUnitCost = useMemo(() => {
    const rawCost = Number(
      selectedProduct?.averageCost !== undefined && selectedProduct?.averageCost !== '' && selectedProduct?.averageCost !== null
        ? selectedProduct.averageCost
        : (selectedProduct?.avgCost !== undefined && selectedProduct?.avgCost !== '' && selectedProduct?.avgCost !== null
          ? selectedProduct.avgCost
          : (selectedProduct?.unitCost || 0))
    );
    if (rawCost > 0) return rawCost;

    if (stockLogs && stockLogs.length > 0 && selectedProduct) {
      const pId = String(selectedProduct.id || '').trim().toLowerCase();
      const pCode = String(selectedProduct.code || selectedProduct.sku || '').trim().toLowerCase();
      const pName = String(selectedProduct.name || '').trim().toLowerCase();

      const inLogs = stockLogs.filter(l => {
        if (!l) return false;
        const lSku = String(l.productCode || l.code || l.sku || '').trim().toLowerCase();
        const lId = String(l.productId || '').trim().toLowerCase();
        const lName = String(l.name || l.productName || '').trim().toLowerCase();
        const match = (pId && lId === pId) || (pCode && (lSku === pCode || lId === pCode)) || (pName && lName === pName);
        const lType = String(l.type || '').toUpperCase();
        const qty = Number(l.quantity !== undefined ? l.quantity : (l.qty || 0));
        return match && lType === 'IN' && qty > 0;
      });

      if (inLogs.length > 0) {
        inLogs.sort((a, b) => new Date(b.timestamp || b.date || 0).getTime() - new Date(a.timestamp || a.date || 0).getTime());
        const fallbackCost = Number(
          inLogs[0].unitPrice !== undefined ? inLogs[0].unitPrice : 
          (inLogs[0].actualUnitPrice !== undefined ? inLogs[0].actualUnitPrice : 
          (inLogs[0].unitCost || inLogs[0].baseUnitCost || 0))
        );
        if (fallbackCost > 0) return fallbackCost;
      }
    }

    return 0;
  }, [selectedProduct, stockLogs]);

  // Reset custom cost override and feedback when selected product changes
  useEffect(() => {
    setCostUpdateToast('');
    setCustomUnitCost(null);
  }, [selectedProdId]);

  const currentUnitCost = useMemo(() => {
    if (customUnitCost && customUnitCost.productId === selectedProdId) {
      return customUnitCost.cost;
    }
    return effectiveUnitCost;
  }, [customUnitCost, selectedProdId, effectiveUnitCost]);

  const handleRecalculateCost = async () => {
    if (!selectedProduct || isRecalculating) return;
    setIsRecalculating(true);
    setCostUpdateToast('');
    try {
      const targetKey = selectedProduct.id || selectedProduct.code || selectedProduct.name;
      const healed = await healMACForProduct(targetKey);
      const newCost = Number(healed?.averageCost ?? healed?.avgCost ?? 0);
      if (healed && newCost > 0) {
        setCustomUnitCost({ productId: selectedProduct.id, cost: newCost });
        setCostUpdateToast(`อัปเดตต้นทุนแล้ว: ฿${newCost.toFixed(2)}/${sUnit}`);
        if (typeof onRefresh === 'function') {
          await onRefresh();
        }
      } else {
        setCostUpdateToast('ไม่พบประวัติรับเข้าสำหรับคำนวณ');
      }
    } catch (err) {
      console.error('[QuickIssueView] Error recalculating MAC:', err);
      setCostUpdateToast('เกิดข้อผิดพลาดในการคำนวณ');
    } finally {
      setIsRecalculating(false);
      setTimeout(() => {
        setCostUpdateToast('');
      }, 4000);
    }
  };

  // Recent OUT stock logs for this department (Live sidebar)
  const recentIssueLogs = useMemo(() => {
    return stockLogs
      .filter(log => {
        // Accept OUT, ISSUE, DISPATCH and negative changeQty
        if (!isStockOutLog(log)) return false;
        if (currentRole.canViewAllDepts) return true;
        if (log.department) return matchDepartment(log.department, currentRole.department);
        const prod = products.find(p => {
          if (log.productId && p.id === log.productId) return true;
          return p.code === log.productCode && matchDepartment(p.department || p.category, currentRole.department);
        });
        return prod ? matchDepartment(prod.department || prod.category, currentRole.department) : true;
      })
      .slice(0, 6);
  }, [stockLogs, products, currentRole]);

  const handleQuickQty = (amount) => {
    if (amount === 'max') {
      setIssueQty(currentBalance > 0 ? currentBalance : 1);
    } else {
      setIssueQty(prev => {
        const next = Math.round((Number(prev || 0) + amount) * 10000) / 10000;
        return Math.min(Math.max(0.01, next), Math.max(0.01, currentBalance));
      });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSuccessMsg('');
    setErrorMsg('');

    if (!selectedProdId) {
      return setErrorMsg('กรุณาเลือกสินค้าที่ต้องการเบิกจ่าย');
    }

    if (!productionUnit) {
      return setErrorMsg('กรุณาเลือกหน่วยที่ต้องการเบิก');
    }

    if (qtyNumber <= 0) {
      return setErrorMsg('จำนวนที่ต้องการเบิกต้องมากกว่า 0');
    }

    if (currentBalance < qtyNumber) {
      return setErrorMsg(`จำนวนที่ขอเบิก (${qtyNumber} ${sUnit}) เกินกว่ายอดคงเหลือในคลัง (${currentBalance} ${sUnit})`);
    }

    setIsSubmitting(true);
    try {
      const fullNote = `[${productionUnit}] ${reason}${note.trim() ? ` — ${note.trim()}` : ''}`;
      const payload = {
        productId: selectedProduct.id,
        productCode: selectedProduct.code,
        department: selectedProduct.department || selectedProduct.category || user?.department || 'PD',
        quantity: qtyNumber,
        issuedTo: productionUnit,
        location: productionUnit,   // ชื่อห้องที่เลือก เช่น 'ห้อง K1' → บันทึกลงชีต StockLogs
        reason: fullNote,
        requesterId: user?.id || user?.username,
        requesterName: user?.name,
        user
      };

      if (onIssueStock) {
        await onIssueStock(payload);
      } else {
        await apiService.issueStock(payload);
      }

      setSuccessMsg(`เบิกสินค้า [${selectedProduct.name}] สำหรับ ${productionUnit} จำนวน ${qtyNumber} ${sUnit} สำเร็จ! ยอดสต็อกตัดจ่ายเรียบร้อย`);
      setIssueQty(1);
      setNote('');
      if (onRefresh) onRefresh();
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Filtered OUT Logs for Statistics ───
  const filteredStatsLogs = useMemo(() => {
    // Accept OUT, ISSUE, DISPATCH types and negative changeQty
    let logs = stockLogs.filter(log => isStockOutLog(log));

    // Role department permission filter
    logs = logs.filter(log => {
      const logDept = log.department;
      if (logDept) return hasDepartmentAccess(user, logDept);
      const prod = products.find(p => {
        if (log.productId && p.id === log.productId) return true;
        return p.code === log.productCode;
      });
      const prodCat = prod?.category || prod?.department || logDept;
      return hasDepartmentAccess(user, prodCat);
    });

    // UI Department filter
    if (statsDeptFilter !== 'ALL') {
      logs = logs.filter(log => {
        const logDept = log.department;
        if (logDept) return matchDepartment(logDept, statsDeptFilter);
        const prod = products.find(p => {
          if (log.productId && p.id === log.productId) return true;
          return p.code === log.productCode;
        });
        const prodCat = prod?.category || prod?.department || logDept;
        return matchDepartment(prodCat, statsDeptFilter);
      });
    }

    // Unit filter (match against location, issueUnit, issuedTo, or note bracket)
    if (statsUnitFilter !== 'ALL') {
      logs = logs.filter(log => getLogUnit(log) === statsUnitFilter);
    }

    // Time filter
    const now = new Date();
    logs = logs.filter(log => {
      const logDate = parseLogDate(log);

      if (statsTimeFilter === 'TODAY') {
        return logDate.toDateString() === now.toDateString();
      } else if (statsTimeFilter === 'WEEK') {
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        weekAgo.setHours(0, 0, 0, 0);
        return logDate >= weekAgo;
      } else if (statsTimeFilter === 'MONTH') {
        return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear();
      } else if (statsTimeFilter === 'LAST_MONTH') {
        const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
        const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        return logDate.getMonth() === lastMonth && logDate.getFullYear() === year;
      } else if (statsTimeFilter === 'CUSTOM') {
        if (statsCustomStart) {
          const start = new Date(statsCustomStart);
          start.setHours(0, 0, 0, 0);
          if (logDate < start) return false;
        }
        if (statsCustomEnd) {
          const end = new Date(statsCustomEnd);
          end.setHours(23, 59, 59, 999);
          if (logDate > end) return false;
        }
      }
      return true;
    });

    // Search filter
    if (statsSearchQuery.trim()) {
      const q = statsSearchQuery.trim().toLowerCase();
      logs = logs.filter(log => {
        const prod = products.find(p => p.id === log.productId || p.code === log.productCode);
        const name = prod?.name?.toLowerCase() || '';
        const code = log.productCode?.toLowerCase() || '';
        const note = log.note?.toLowerCase() || '';
        const actor = (log.actorName || log.user || '')?.toLowerCase() || '';
        const unit = getLogUnit(log).toLowerCase();
        return name.includes(q) || code.includes(q) || note.includes(q) || actor.includes(q) || unit.includes(q);
      });
    }

    return logs;
  }, [stockLogs, products, user, statsUnitFilter, statsTimeFilter, statsCustomStart, statsCustomEnd, statsDeptFilter, statsSearchQuery]);

  // ─── Aggregated Statistics Calculations ───
  const analytics = useMemo(() => {
    const totalIssues = filteredStatsLogs.length;
    const totalQty = filteredStatsLogs.reduce((sum, log) => sum + (Number(log.qty) || 0), 0);
    const totalValue = filteredStatsLogs.reduce((sum, log) => {
      const prod = products.find(p => p.id === log.productId || p.code === log.productCode);
      const cost = Number(log.totalCost ?? ((Number(log.qty) || 0) * (prod?.avgCost || prod?.costPrice || prod?.price || 0)));
      return sum + cost;
    }, 0);

    // 1. Group by Unit
    const unitMap = {};
    displayedUnits.forEach(u => {
      unitMap[u.name] = {
        name: u.name,
        department: u.department,
        color: u.color,
        badgeBg: u.badgeBg,
        dot: u.dot,
        count: 0,
        totalQty: 0,
        totalValue: 0,
        items: {},
        lastIssued: null
      };
    });

    filteredStatsLogs.forEach(log => {
      const unitName = getLogUnit(log);
      if (!unitMap[unitName]) {
        const found = allUsageUnits.find(u => u.name === unitName);
        unitMap[unitName] = {
          name: unitName,
          department: found?.department || 'ALL',
          color: found?.color || 'bg-slate-100 text-slate-700',
          badgeBg: found?.badgeBg || 'bg-slate-100 text-slate-800',
          dot: found?.dot || 'bg-slate-500',
          count: 0,
          totalQty: 0,
          totalValue: 0,
          items: {},
          lastIssued: null
        };
      }
      unitMap[unitName].count += 1;
      unitMap[unitName].totalQty += Number(log.qty) || 0;

      const pCode = log.productCode || log.productId || 'UNKNOWN';
      const prod = products.find(p => p.id === log.productId || p.code === log.productCode);
      const pName = prod?.name || pCode;
      const pUnit = prod?.stockUnit || prod?.unit || log.unit || 'ชิ้น';
      const dept = prod?.category || 'PD';
      const cost = Number(log.totalCost ?? ((Number(log.qty) || 0) * (prod?.avgCost || prod?.costPrice || prod?.price || 0)));
      
      unitMap[unitName].totalValue += cost;

      if (!unitMap[unitName].items[pCode]) {
        unitMap[unitName].items[pCode] = {
          code: pCode,
          name: pName,
          unit: pUnit,
          dept: dept,
          qty: 0,
          count: 0,
          totalValue: 0,
          unitCost: Number(log.unitCost ?? (prod?.avgCost || prod?.costPrice || prod?.price || 0)),
          lastDate: log.date || '-'
        };
      }
      unitMap[unitName].items[pCode].qty += Number(log.qty) || 0;
      unitMap[unitName].items[pCode].count += 1;
      unitMap[unitName].items[pCode].totalValue += cost;
      unitMap[unitName].items[pCode].lastDate = log.date || unitMap[unitName].items[pCode].lastDate;
    });

    const unitList = Object.values(unitMap).map(u => ({
      ...u,
      topItems: Object.values(u.items).sort((a, b) => b.qty - a.qty),
      uniqueItemCount: Object.keys(u.items).length
    })).sort((a, b) => b.count - a.count);

    // Most active unit
    const mostActiveUnit = unitList.find(u => u.count > 0) || null;

    // 2. Group by Product (Top products across all filtered logs)
    const productMap = {};
    filteredStatsLogs.forEach(log => {
      const code = log.productCode || 'UNKNOWN';
      const prod = products.find(p => p.id === log.productId || p.code === log.productCode);
      const name = prod?.name || code;
      const unit = prod?.stockUnit || prod?.unit || log.unit || 'ชิ้น';
      const dept = prod?.category || 'PD';

      if (!productMap[code]) {
        productMap[code] = {
          code,
          name,
          unit,
          dept,
          qty: 0,
          count: 0,
          usedInUnits: {}
        };
      }
      productMap[code].qty += Number(log.qty) || 0;
      productMap[code].count += 1;

      const unitName = getLogUnit(log);
      productMap[code].usedInUnits[unitName] = (productMap[code].usedInUnits[unitName] || 0) + (Number(log.qty) || 0);
    });

    const topProducts = Object.values(productMap).sort((a, b) => b.qty - a.qty);
    const mostIssuedProduct = topProducts[0] || null;

    // 3. Matrix of (Unit x Product) rows
    const matrixRows = [];
    Object.values(unitMap).forEach(u => {
      Object.values(u.items).forEach(item => {
        matrixRows.push({
          unitName: u.name,
          ...item,
          pctOfTotal: totalValue > 0 ? ((item.totalValue / totalValue) * 100).toFixed(1) : 0
        });
      });
    });
    return {
      totalIssues,
      totalQty,
      totalValue,
      unitList,
      mostActiveUnit,
      topProducts,
      mostIssuedProduct,
      matrixRows,
      uniqueProductCount: topProducts.length
    };
  }, [filteredStatsLogs, products]);

  // Pagination slicing for MATRIX view
  const matrixTotalPages = Math.ceil(analytics.matrixRows.length / matrixPageSize) || 1;
  const paginatedMatrixRows = useMemo(() => {
    const start = (matrixPage - 1) * matrixPageSize;
    return analytics.matrixRows.slice(start, start + matrixPageSize);
  }, [analytics.matrixRows, matrixPage, matrixPageSize]);

  // Pagination slicing for LOGS view
  const logsTotalPages = Math.ceil(filteredStatsLogs.length / logsPageSize) || 1;
  const paginatedStatsLogs = useMemo(() => {
    const start = (logsPage - 1) * logsPageSize;
    return filteredStatsLogs.slice(start, start + logsPageSize);
  }, [filteredStatsLogs, logsPage, logsPageSize]);

  // Unit count badges for quick filter pills
  const unitBadgeCounts = useMemo(() => {
    const counts = { ALL: 0 };
    displayedUnits.forEach(u => { counts[u.name] = 0; });
    stockLogs.forEach(log => {
      // Accept OUT, ISSUE, DISPATCH types and negative changeQty
      if (!isStockOutLog(log)) return;
      const logDept = log.department;
      let prodCat = logDept;
      if (!prodCat) {
        const prod = products.find(p => {
          if (log.productId && p.id === log.productId) return true;
          return p.code === log.productCode;
        });
        prodCat = prod?.category || prod?.department;
      }
      if (!hasDepartmentAccess(user, prodCat)) return;
      if (statsDeptFilter !== 'ALL' && !matchDepartment(prodCat, statsDeptFilter)) return;

      const u = getLogUnit(log);
      if (counts[u] !== undefined) {
        counts[u] += 1;
        counts.ALL = (counts.ALL || 0) + 1;
      }
    });
    return counts;
  }, [stockLogs, displayedUnits, products, user, statsDeptFilter]);

  // Recent issue history for the currently selected product (sidebar in Issue Form)
  // Deduplicated, strict LIFO sorted (latest first), windowed to 20 records
  const recentIssuesForProduct = useMemo(() => {
    if (!selectedProduct || !stockLogs || stockLogs.length === 0) return [];
    const targetId = String(selectedProduct.id || '').trim();
    const targetCode = String(selectedProduct.code || selectedProduct.sku || '').trim();
    const targetDept = String(selectedProduct.department || selectedProduct.category || '').trim();

    // 1. Filter out only stock-out logs matching this product
    const matchingLogs = stockLogs.filter(log => {
      if (!isStockOutLog(log)) return false;
      // Match by productId (most reliable)
      if (targetId && log.productId && String(log.productId).trim() === targetId) return true;
      // Fallback: match by code + department
      const logCode = String(log.productCode || log.code || '').trim();
      if (!logCode || logCode !== targetCode) return false;
      const logDept = String(log.department || '').trim();
      return !logDept || !targetDept || matchDepartment(logDept, targetDept);
    });

    // 2. Strict LIFO Sorting before deduplicating or slicing (Descending by safe date)
    matchingLogs.sort((a, b) => {
      const timeB = parseSafeDate(b.timestamp || b.date).getTime();
      const timeA = parseSafeDate(a.timestamp || a.date).getTime();
      return timeB - timeA;
    });

    // 3. Deduplication: Filter out duplicates using Map / Composite Unique Key
    const seenIds = new Set();
    const seenSignatures = new Set();
    const dedupedLogs = [];

    for (const log of matchingLogs) {
      const logId = log.id ? String(log.id).trim() : '';
      if (logId && seenIds.has(logId)) {
        continue;
      }

      // Composite signature: timestamp (minute resolution) + productId + changeQty + unit
      const pId = String(log.productId || log.productCode || targetId).trim();
      const qty = Math.abs(Number(log.qty || log.changeQty || 0));
      const safeTime = parseSafeDate(log.timestamp || log.date).getTime();
      const timeMinute = Math.floor(safeTime / 60000);
      const signature = `${pId}_${qty}_${timeMinute}_${String(log.issuedTo || log.location || '').trim()}`;

      if (seenSignatures.has(signature)) {
        continue;
      }

      if (logId) seenIds.add(logId);
      seenSignatures.add(signature);
      dedupedLogs.push(log);
    }

    // 4. Data Windowing (limit to 20 most recent items)
    return dedupedLogs.slice(0, 20);
  }, [selectedProduct, stockLogs]);

  // Export to CSV
  const handleExportCSV = () => {
    if (analytics.matrixRows.length === 0) return;
    const headers = ['หน่วยที่เบิก', 'รหัสสินค้า', 'ชื่อสินค้า', 'แผนก', 'จำนวนครั้งที่เบิก', 'ยอดรวมที่เบิก', 'หน่วยนับ', 'ต้นทุนเฉลี่ย (บาท)', 'มูลค่ารวม (บาท)', 'เบิกล่าสุด'];
    const rows = analytics.matrixRows.map(r => [
      `"${r.unitName}"`,
      `"${r.code}"`,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.dept}"`,
      r.count,
      r.qty,
      `"${r.unit}"`,
      Number(r.unitCost || 0).toFixed(2),
      Number(r.totalValue || 0).toFixed(2),
      `"${r.lastDate}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Stock_Issue_Statistics_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="w-full space-y-6 animate-fade-in-up pb-10">
      
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2.5">
            <div className="p-2 bg-amber-50 rounded-2xl border border-amber-200/60 shadow-2xs flex items-center justify-center">
              <Zap size={22} strokeWidth={2} className="text-amber-500 fill-amber-100" />
            </div>
            <span>เบิกสินค้าออกจากสต็อก (Quick Issue)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1 font-normal">
            บันทึกตัดยอดสต็อกสินค้าทันที (-OUT) พร้อมจำลองสต็อกคงเหลือแบบ Real-time
          </p>
        </div>

        {/* Department Badge with Glowing Dot */}
        <div className="flex items-center gap-2 px-3.5 py-1.5 bg-white rounded-full border border-slate-200/80 shadow-2xs w-fit text-xs font-medium text-slate-600">
          <span className="w-2 h-2 rounded-full bg-emerald-500 ring-4 ring-emerald-100 shrink-0" />
          <span className="text-slate-500">สิทธิ์การเบิก:</span>
          <span className="font-semibold text-slate-900">
            {currentRole?.department === 'ALL' ? 'ทุกแผนก (ALL)' : `แผนก ${currentRole?.department || user?.department || 'ALL'}`}
          </span>
        </div>
      </div>

      {/* ── Alert Notifications ── */}
      {successMsg && (
        <div className="p-3.5 bg-emerald-50/80 border border-emerald-200/80 text-emerald-900 rounded-2xl flex items-center justify-between gap-2.5 text-xs font-medium shadow-2xs animate-fade-in">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg('')} className="text-emerald-700 hover:text-emerald-900 text-xs cursor-pointer font-bold p-1">
            ✕
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="p-3.5 bg-rose-50/80 border border-rose-200/80 text-rose-900 rounded-2xl flex items-center justify-between gap-2.5 text-xs font-medium shadow-2xs animate-fade-in">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg('')} className="text-rose-700 hover:text-rose-900 text-xs cursor-pointer font-bold p-1">
            ✕
          </button>
        </div>
      )}

      {/* ── Floating Capsule Bar Navigation ── */}
      <div className="flex items-center">
        <div className="bg-slate-100/90 p-1.5 rounded-full inline-flex gap-1 border border-slate-200/50 shadow-2xs">
          <button
            onClick={() => setActiveTab('ISSUE')}
            className={`transition-all cursor-pointer flex items-center gap-2 text-xs sm:text-sm ${
              activeTab === 'ISSUE' 
                ? 'bg-white shadow-sm font-semibold text-slate-900 rounded-full px-5 py-2' 
                : 'text-slate-500 hover:text-slate-900 font-medium px-5 py-2 rounded-full'
            }`}
          >
            <Zap size={16} strokeWidth={1.75} className={activeTab === 'ISSUE' ? 'text-amber-500' : 'text-slate-400'} />
            <span>ฟอร์มเบิกสินค้า</span>
          </button>
          <button
            onClick={() => setActiveTab('STATS')}
            className={`transition-all flex items-center gap-2 cursor-pointer text-xs sm:text-sm ${
              activeTab === 'STATS' 
                ? 'bg-white shadow-sm font-semibold text-slate-900 rounded-full px-5 py-2' 
                : 'text-slate-500 hover:text-slate-900 font-medium px-5 py-2 rounded-full'
            }`}
          >
            <BarChart2 className="w-4 h-4" />
            <span>สถิติการใช้งาน & วิเคราะห์ตามหน่วย</span>
            {stockLogs.filter(l => l.type === 'OUT').length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-slate-900 text-white ml-0.5">
                {stockLogs.filter(l => l.type === 'OUT').length}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === 'ISSUE' ? (
      /* ─────────────────────────────────────────────────────────────
         TAB 1: QUICK ISSUE FORM
         ───────────────────────────────────────────────────────────── */
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* ── Left Column: Issue Form (7 cols = 60%) ── */}
        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-100 shadow-sm p-6 sm:p-7 space-y-5">
          
          {/* Department Filter Toggle */}
          <div className="flex items-center justify-between gap-2 pb-3.5 border-b border-slate-100 flex-wrap">
            <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-slate-700" />
              <span>ระบุข้อมูลการเบิกจ่ายสินค้า</span>
            </span>

            {currentRole.canViewAllDepts && (
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/50 text-xs">
                <button
                  type="button"
                  onClick={() => setCategoryFilter('ALL')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    categoryFilter === 'ALL' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  ทั้งหมด ({products.length})
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter('PD')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    categoryFilter === 'PD' ? 'bg-white text-blue-700 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  ฝ่ายผลิต (PD)
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter('QC')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    categoryFilter === 'QC' ? 'bg-white text-amber-700 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  ฝ่าย QC
                </button>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 0. Unit / Room Selector (Clean Segmented Switcher) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <DoorOpen size={15} className="text-slate-600 shrink-0" />
                  <span>หน่วยที่เบิก / พื้นที่ใช้งาน (Location / Unit)</span>
                  <span className="text-rose-500">*</span>
                </label>
                <span className="text-[11px] text-slate-400 font-normal">เลือกห้องหรือพื้นที่ที่นำสินค้าไปใช้</span>
              </div>

              {/* Clean Segmented Switcher Capsule Bar or Empty State Alert */}
              {formUsageUnits.length === 0 ? (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 bg-amber-50/80 border border-amber-200/80 rounded-2xl text-xs text-amber-900 shadow-2xs">
                  <div className="flex items-center gap-2.5">
                    <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                    <span>ยังไม่มีข้อมูลหน่วยเบิกใช้งาน/ห้องในระบบ</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (onNavigate) {
                        onNavigate('master-data', { tab: 'rooms' });
                      } else {
                        window.location.hash = '#/master-data?tab=rooms';
                      }
                    }}
                    className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl text-xs shadow-2xs transition-colors shrink-0 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>เพิ่มหน่วยเบิกใน Master Data</span>
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100/80 rounded-2xl border border-slate-200/60">
                  {formUsageUnits.map(unit => {
                    const isSelected = productionUnit === unit.name;
                    return (
                      <button
                        key={unit.id || unit.name}
                        type="button"
                        onClick={() => setProductionUnit(unit.name)}
                        className={`px-3.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 ${
                          isSelected
                            ? 'bg-slate-950 text-white font-semibold shadow-sm'
                            : 'px-3.5 py-1.5 rounded-xl text-xs font-medium text-slate-600 hover:text-slate-900 transition-all'
                        }`}
                      >
                        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                        <span>{unit.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 1. Product Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                <span>เลือกสินค้าจากคลัง <span className="text-rose-500">*</span></span>
                {selectedProduct && (
                  <span className="font-mono text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md font-medium">
                    {selectedProduct.code}
                  </span>
                )}
              </label>
              <SearchableSelect
                options={productOptions}
                value={selectedProdId}
                onChange={val => setSelectedProdId(val)}
                placeholder="-- พิมพ์ชื่อสินค้า หรือรหัสสินค้า --"
                searchPlaceholder="พิมพ์ชื่อสินค้า, รหัส, หรือตำแหน่งจัดเก็บ..."
                emptyMessage="ไม่พบสินค้าที่ตรงกับการค้นหา"
                required
              />
              
              {/* Compact Micro-badge Info Strip */}
              {selectedProduct && (
                <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 font-normal px-1">
                  <div className="flex items-center gap-2">
                    {rate > 1 && (
                      <span className="text-indigo-600 bg-indigo-50/80 px-2 py-0.5 rounded-md border border-indigo-100 font-mono text-[10px]">
                        1 {pUnit} = {rate} {sUnit}
                      </span>
                    )}
                    <span className="text-slate-500 flex items-center gap-1">
                      <PackageCheck size={15} className="text-slate-400 shrink-0" />
                      <span>จุดจัดเก็บ: <strong className="text-slate-700 font-medium">{selectedProduct.locationName || 'คลังหลัก'}</strong></span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span>จุดสั่งซื้อ ROP:</span>
                    <strong className="text-amber-800 font-mono font-medium">{Number(reorderPoint).toLocaleString()} {sUnit}</strong>
                  </div>
                </div>
              )}
            </div>

            {/* 2. Compact Ergonomic Quantity Stepper */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <span>จำนวนที่ต้องการเบิก ({sUnit})</span>
                  <span className="text-rose-500">*</span>
                </span>
                {selectedProduct && (
                  <span className="text-[11px] text-slate-400 font-normal">
                    คงเหลือในคลัง: <strong className="font-mono text-slate-700 font-semibold">{Number(currentBalance).toLocaleString()} {sUnit}</strong>
                  </span>
                )}
              </label>

              {/* Compact Tactile Stepper Row */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleQuickQty(-1)}
                    disabled={qtyNumber <= 0.01}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200/80 transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title="ลด 1"
                  >
                    <Minus className="w-4 h-4" />
                  </button>

                  <input
                    type="number"
                    step="any"
                    min="0.001"
                    max={Math.max(0.001, currentBalance)}
                    value={issueQty}
                    onChange={e => setIssueQty(e.target.value)}
                    required
                    placeholder="0"
                    className="font-mono text-xl font-bold text-center w-20 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 outline-none transition-all text-slate-900"
                  />

                  <button
                    type="button"
                    onClick={() => handleQuickQty(1)}
                    disabled={currentBalance > 0 && qtyNumber >= currentBalance}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200/80 transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title="เพิ่ม 1"
                  >
                    <Plus className="w-4 h-4" />
                  </button>

                  <span className="font-medium text-xs text-slate-500 px-2.5 py-1.5 bg-slate-100/80 rounded-xl border border-slate-200/60 font-mono shrink-0">
                    {sUnit}
                  </span>
                </div>

                {/* Helper Chips: [+1], [+5], [Max] with Ghost Border */}
                <div className="flex items-center gap-1.5 ml-auto sm:ml-0">
                  <button
                    type="button"
                    onClick={() => handleQuickQty(1)}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-200/80 hover:border-slate-300 rounded-xl transition-all active:scale-95 cursor-pointer shadow-2xs font-mono"
                  >
                    +1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickQty(5)}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-200/80 hover:border-slate-300 rounded-xl transition-all active:scale-95 cursor-pointer shadow-2xs font-mono"
                  >
                    +5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickQty('max')}
                    className="px-2.5 py-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800 bg-amber-50/60 hover:bg-amber-100/70 border border-amber-200/80 rounded-xl transition-all active:scale-95 cursor-pointer shadow-2xs font-mono"
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Micro Alert Strip */}
              {isOutOfStock ? (
                <div className="text-xs text-rose-700 bg-rose-50/80 border border-rose-200/70 px-3 py-1.5 rounded-xl flex items-center gap-2 mt-2 animate-fade-in">
                  <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>จำนวนที่ขอเบิกเกินยอดคงเหลือในคลัง ({Number(currentBalance).toLocaleString()} {sUnit})</span>
                </div>
              ) : willTriggerROP ? (
                <div className="text-xs text-amber-700 bg-amber-50/80 border border-amber-200/70 px-3 py-1.5 rounded-xl flex items-center gap-2 mt-2 animate-fade-in">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>หลังเบิกยอดจะเหลือ <strong>{Number(postIssueBalance).toLocaleString()} {sUnit}</strong> ซึ่งแตะจุดสั่งซื้อ ROP ({Number(reorderPoint).toLocaleString()} {sUnit})</span>
                </div>
              ) : isInactive ? (
                <div className="text-xs text-amber-800 bg-amber-50/90 border border-amber-200 px-3 py-1.5 rounded-xl flex items-center gap-2 mt-2 animate-fade-in">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  <span>สินค้านี้<strong>ยกเลิกใช้งานแล้ว</strong> — สามารถเบิกสต็อกคงเหลือ ({Number(currentBalance).toLocaleString()} {sUnit}) จนหมดได้ โดยระบบจะไม่แจ้งเตือนสั่งซื้อ ROP ซ้ำ</span>
                </div>
              ) : null}
            </div>

            {/* 3. Reason Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                <span>วัตถุประสงค์การเบิก <span className="text-rose-500">*</span></span>
              </label>
              <select
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900 cursor-pointer"
              >
                {ISSUE_REASONS.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* 4. Additional Note */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800">
                หมายเหตุเพิ่มเติม (ถ้ามี)
              </label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="เช่น กะดึก, ซ่อมบำรุงเครื่องจักร No.3, หรืองานทดสอบพิเศษ..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-900"
              />
            </div>

            {/* 5. Master Action Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting || isOutOfStock || !productionUnit}
                className="w-full bg-slate-950 hover:bg-slate-900 text-white py-3.5 rounded-2xl font-semibold text-xs shadow-lg shadow-slate-950/20 active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <PackageCheck className="w-4 h-4 text-emerald-400" />
                <span>{isSubmitting ? 'กำลังบันทึกตัดยอด...' : (!productionUnit ? 'กรุณาเลือกหน่วยเบิกใช้งาน' : `ยืนยันการเบิกจ่ายสินค้า (-OUT) สู่ ${productionUnit}`)}</span>
              </button>
            </div>
          </form>
        </div>

        {/* ── Right Column: Live Stock Impact Inspector (Single Bento Card) ── */}
        <div className="lg:col-span-5">
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-5 sm:p-6 space-y-4">
            
            {/* ส่วนบน: รหัส SKU Badge Monospace + ชื่ออะไหล่ + ป้ายตำแหน่งจัดเก็บ */}
            {selectedProduct ? (
              <div className="space-y-2 pb-4 border-b border-slate-100">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold bg-slate-900 text-white px-2.5 py-0.5 rounded-lg shadow-2xs">
                      {selectedProduct.code}
                    </span>
                    <span className="text-[11px] font-medium text-slate-500 bg-slate-100/90 px-2 py-0.5 rounded-md border border-slate-200/50 flex items-center gap-1">
                      <PackageCheck size={15} className="text-slate-400 shrink-0" />
                      <span>{selectedProduct.locationName || 'คลังหลัก'}</span>
                    </span>
                    {isInactive && (
                      <span className="text-[10px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                        ● ยกเลิกใช้งาน / รอเคลียร์สต็อก
                      </span>
                    )}
                  </div>
                  {rate > 1 && (
                    <span className="text-[10px] font-mono text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md">
                      1 {pUnit} = {rate} {sUnit}
                    </span>
                  )}
                </div>

                <h3 className="font-bold text-sm sm:text-base text-slate-900 leading-snug">
                  {selectedProduct.name}
                </h3>
              </div>
            ) : (
              <div className="pb-4 border-b border-slate-100 space-y-3">
                <div className="text-slate-400 text-xs italic">
                  กรุณาเลือกสินค้าเพื่อดูข้อมูลสต็อก
                </div>
                <div className="bg-blue-50/80 rounded-2xl p-3.5 border border-blue-100 flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[10px] font-medium text-blue-600 uppercase tracking-wider block">มูลค่าเงินที่เบิกครั้งนี้</span>
                    <p className="font-mono text-base font-bold text-blue-700 mt-0.5">฿0.00</p>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[9px] font-medium text-slate-400 block">(คำนวณจากต้นทุนเฉลี่ย)</span>
                    <p className="font-mono text-[11px] text-slate-400 mt-0.5">฿0.00 / ชิ้น</p>
                    <button
                      type="button"
                      disabled={true}
                      className="mt-2 text-xs font-semibold text-blue-600 bg-white border border-blue-200 px-3 py-1.5 rounded-lg shadow-2xs flex items-center gap-1.5 opacity-50 cursor-not-allowed"
                      title="กรุณาเลือกสินค้าก่อนคำนวณต้นทุน"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>คำนวณต้นทุนเฉลี่ยใหม่</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ส่วนกลาง (Stock Impact Metric) */}
            {selectedProduct && (
              <div className="space-y-3 pb-4 border-b border-slate-100">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">จำลองผลกระทบสต็อก</span>
                  <span className="text-[11px] text-slate-400 font-mono">
                    ROP: {Number(reorderPoint).toLocaleString()} {sUnit}
                  </span>
                </div>

                {/* การแสดงผลเปรียบเทียบแบบกระชับ: คงเหลือ X -> หลังเบิก Y */}
                <div className="bg-slate-50/80 rounded-2xl p-3.5 border border-slate-100/90 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider block">คงเหลือ</span>
                    <p className="font-mono text-base font-bold text-slate-800 tabular-nums mt-0.5">
                      {Number(currentBalance).toLocaleString()} <span className="text-xs font-normal text-slate-500">{sUnit}</span>
                    </p>
                  </div>

                  <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />

                  <div className="text-right">
                    <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider block">หลังเบิก</span>
                    <p className={`font-mono text-base font-bold tabular-nums mt-0.5 ${
                      postIssueBalance < 0 
                        ? 'text-rose-600' 
                        : isInactive
                          ? 'text-amber-600'
                          : postIssueBalance <= reorderPoint 
                            ? 'text-amber-600' 
                            : 'text-emerald-600'
                    }`}>
                      {Number(postIssueBalance).toLocaleString(undefined, { maximumFractionDigits: 4 })} <span className="text-xs font-normal text-slate-500">{sUnit}</span>
                    </p>
                  </div>
                </div>

                {/* หลอดความจุสต็อก: ความสูงมินิมอล h-1.5 rounded-full bg-slate-100 พร้อมแถบสีแจ้งเตือน */}
                <div className="space-y-1.5">
                  <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-300 ${
                        postIssueBalance < 0 
                          ? 'bg-rose-500' 
                          : isInactive
                            ? 'bg-amber-500'
                            : postIssueBalance <= reorderPoint 
                              ? 'bg-amber-500' 
                              : 'bg-emerald-500'
                      }`}
                      style={{ 
                        width: `${currentBalance > 0 ? Math.max(4, Math.min(100, (postIssueBalance / Math.max(currentBalance, reorderPoint * 2)) * 100)) : 0}%` 
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      {postIssueBalance < 0 
                        ? 'สินค้าไม่พอเบิก' 
                        : isInactive
                          ? 'ยกเลิกใช้งาน / รอเคลียร์สต็อก'
                          : postIssueBalance <= reorderPoint 
                            ? 'สต็อกแตะจุดสั่งซื้อ ROP' 
                            : 'ระดับสต็อกเพียงพอ'}
                    </span>
                    <span className="font-mono">
                      -{qtyNumber} {sUnit}
                    </span>
                  </div>
                </div>

                <div className="bg-blue-50/80 rounded-2xl p-3.5 border border-blue-100 flex items-start justify-between mt-3 gap-3">
                  <div>
                    <span className="text-[10px] font-medium text-blue-600 uppercase tracking-wider block">มูลค่าเงินที่เบิกครั้งนี้</span>
                    <p className="font-mono text-base font-bold text-blue-700 mt-0.5">
                      ฿{(currentUnitCost * qtyNumber).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    {costUpdateToast && (
                      <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                        <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                        <span>{costUpdateToast}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[9px] font-medium text-slate-400 block">(คำนวณจากต้นทุนเฉลี่ย)</span>
                    <p className="font-mono text-[11px] text-slate-600 font-semibold mt-0.5">
                      ฿{currentUnitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {sUnit}
                    </p>
                    <button
                      type="button"
                      disabled={!selectedProduct || isRecalculating}
                      onClick={handleRecalculateCost}
                      className="mt-2 text-xs font-semibold text-blue-600 bg-white hover:bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-lg transition-all shadow-2xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      title="คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนักใหม่ตามประวัติรับเข้าจริง"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRecalculating ? 'animate-spin' : ''}`} />
                      <span>{isRecalculating ? 'กำลังคำนวณ...' : 'คำนวณต้นทุนเฉลี่ยใหม่'}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ส่วนล่าง: ประวัติการเบิกล่าสุดของสินค้าที่เลือก (Scrollable Frame max-h-[360px]) */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-slate-400" />
                  <span>ประวัติการเบิกล่าสุด ({recentIssuesForProduct.length} รายการ)</span>
                </span>
                {recentIssuesForProduct.length > 0 && (
                  <span className="text-[10px] text-slate-400 font-mono">{recentIssuesForProduct.length} รายการ</span>
                )}
              </div>

              {recentIssuesForProduct.length > 0 ? (
                <div className="max-h-[360px] overflow-y-auto pr-1 space-y-2 custom-scrollbar">
                  <div className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 bg-slate-50/40 px-3">
                    {recentIssuesForProduct.map((log, idx) => {
                      const logUnit = getLogUnit(log);
                      const safeDate = formatThaiDateTime(log.timestamp || log.date);
                      return (
                        <div key={log.id || `issue-${idx}-${log.timestamp}`} className="py-2.5 first:pt-2.5 last:pb-2.5 flex items-center justify-between gap-2.5 text-xs">
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200/60">
                                {logUnit}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400">
                                {log.productCode}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 truncate">
                              {log.reason || log.note || 'เบิกใช้งาน'} • {safeDate}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-mono font-bold text-slate-800 bg-white border border-slate-200/80 px-2 py-0.5 rounded-lg text-xs block mb-0.5 shadow-2xs">
                              -{Math.abs(log.qty || log.changeQty || 0)}
                            </span>
                            <span className="text-[10px] text-rose-500 font-mono font-semibold block">
                              (฿{Number(log.totalCost ?? (Math.abs(log.qty || log.changeQty || 0) * (selectedProduct?.avgCost || selectedProduct?.price || 0))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center">
                  <p className="text-xs text-slate-400 italic">ยังไม่มีประวัติการเบิกจ่ายสินค้านี้</p>
                </div>
              )}

              {/* ส่วนท้าย (Footer): นำทางไปยังหน้าประวัติสต็อกเต็มรูปแบบ (StockMovementTable) */}
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">แสดงสูงสุด 20 รายการล่าสุด (LIFO)</span>
                <button
                  type="button"
                  onClick={() => {
                    if (onNavigate) {
                      onNavigate('stock-card');
                    } else {
                      window.location.hash = '#/inventory/stock-card';
                    }
                  }}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors cursor-pointer group"
                >
                  <span>ดูประวัติการเคลื่อนไหวทั้งหมด</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
              </div>
            </div>

          </div>
        </div>

      </div>
      ) : (
      /* ─────────────────────────────────────────────────────────────
         TAB 2: COMPREHENSIVE USAGE STATISTICS & UNIT BREAKDOWN
         ───────────────────────────────────────────────────────────── */
      <div className="space-y-6 animate-fade-in">
        
        {/* ── Filter Toolbar ── */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-indigo-600" />
              <h3 className="text-sm font-bold text-slate-800">ตัวกรองสถิติการใช้งาน (Filters)</h3>
            </div>

              {/* View Mode Switcher */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200/60 self-start md:self-auto">
                <button
                  type="button"
                  onClick={() => setStatsViewMode('MATRIX')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  statsViewMode === 'MATRIX'
                    ? 'bg-white text-slate-900 shadow-xs font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <TableIcon className="w-3.5 h-3.5" />
                <span>ตารางหน่วย × รายการสินค้า</span>
              </button>
              <button
                type="button"
                onClick={() => setStatsViewMode('LOGS')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  statsViewMode === 'LOGS'
                    ? 'bg-white text-slate-900 shadow-xs font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ListFilter className="w-3.5 h-3.5" />
                <span>ประวัติทั้งหมด ({filteredStatsLogs.length})</span>
              </button>
            </div>
          </div>

          {/* 1. Unit Quick Filter Pills */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span className="flex items-center gap-1.5">
                <DoorClosed className="w-3.5 h-3.5 text-indigo-600" />
                <span>เลือกดูหน่วยที่เบิก (Location Filter):</span>
              </span>
              <span className="text-[11px] text-slate-400 font-normal">คลิกเลือกหน่วยเพื่อเจาะลึกเฉพาะห้องนั้นๆ</span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStatsUnitFilter('ALL')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer border ${
                  statsUnitFilter === 'ALL'
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>ทุกหน่วย (All Units)</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${statsUnitFilter === 'ALL' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  {unitBadgeCounts.ALL || 0}
                </span>
              </button>

              {displayedUnits.map(unit => {
                const isSelected = statsUnitFilter === unit.name;
                const dot = unit.dot || 'bg-slate-500';
                const color = unit.color || 'bg-slate-100 text-slate-700 border-slate-200';
                const count = unitBadgeCounts[unit.name] || 0;
                return (
                  <button
                    key={unit.id || unit.name}
                    type="button"
                    onClick={() => setStatsUnitFilter(unit.name)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer border ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900 shadow-xs ring-2 ring-indigo-500/20'
                        : `${color} hover:shadow-2xs`
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${isSelected ? 'bg-indigo-400' : dot}`} />
                    <span>{unit.name}</span>
                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${isSelected ? 'bg-white/20 text-white' : 'bg-white/80 text-slate-700 border border-slate-200/50'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Secondary Filter Bar: Time + Department + Search */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
            
            {/* Time Filter Select */}
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">ช่วงเวลา (Time Period)</label>
              <select
                value={statsTimeFilter}
                onChange={e => setStatsTimeFilter(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              >
                <option value="ALL">ทั้งหมด (All Time)</option>
                <option value="TODAY">วันนี้ (Today)</option>
                <option value="WEEK">7 วันล่าสุด (Last 7 Days)</option>
                <option value="MONTH">เดือนนี้ (This Month)</option>
                <option value="LAST_MONTH">เดือนที่แล้ว (Last Month)</option>
                <option value="CUSTOM">กำหนดช่วงวันเอง (Custom Range)</option>
              </select>
            </div>

            {/* Department Filter (Scoped to User Permissions) */}
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">แผนกสินค้า (Department)</label>
              <select
                value={statsDeptFilter}
                onChange={e => setStatsDeptFilter(e.target.value)}
                disabled={!hasMultiDeptAccess}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:opacity-75 disabled:bg-slate-100/80 cursor-pointer disabled:cursor-not-allowed"
              >
                {hasMultiDeptAccess && (
                  <option value="ALL">ทุกแผนก (PD + QC)</option>
                )}
                {userAccessibleDepts.includes('PD') && (
                  <option value="PD">ฝ่ายผลิต (PD)</option>
                )}
                {userAccessibleDepts.includes('QC') && (
                  <option value="QC">ฝ่าย QC</option>
                )}
                {userAccessibleDepts.filter(d => d !== 'PD' && d !== 'QC').map(d => (
                  <option key={d} value={d}>แผนก {d}</option>
                ))}
              </select>
            </div>

            {/* Search Input */}
            <div className="lg:col-span-2">
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">ค้นหารายการ / รหัส / ผู้เบิก</label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={statsSearchQuery}
                  onChange={e => setStatsSearchQuery(e.target.value)}
                  placeholder="พิมพ์ชื่อสินค้า, รหัสสินค้า, หมายเหตุ, หรือชื่อผู้เบิก..."
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                />
                {statsSearchQuery && (
                  <button 
                    onClick={() => setStatsSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-0.5"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* Custom Date Range Picker (Conditional) */}
            {statsTimeFilter === 'CUSTOM' && (
              <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 animate-fade-in">
                <div>
                  <label className="text-[11px] font-semibold text-indigo-900 block mb-1">ตั้งแต่วันที่</label>
                  <input
                    type="date"
                    value={statsCustomStart}
                    onChange={e => setStatsCustomStart(e.target.value)}
                    className="w-full bg-white border border-indigo-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-indigo-900 block mb-1">ถึงวันที่</label>
                  <input
                    type="date"
                    value={statsCustomEnd}
                    onChange={e => setStatsCustomEnd(e.target.value)}
                    className="w-full bg-white border border-indigo-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Top 4 KPI Executive Summary Scorecards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          
          {/* KPI 1: Total Issues */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">จำนวนครั้งที่เบิกจ่าย</p>
                <h3 className="text-2xl sm:text-3xl font-black text-slate-900 font-mono mt-1 tracking-tight">
                  {analytics.totalIssues}
                  <span className="text-xs font-semibold text-slate-400 ml-1.5 font-sans">ครั้ง</span>
                </h3>
              </div>
              <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shrink-0 shadow-2xs">
                <History className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-3 pt-2.5 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
              <span>ขอบเขต: {statsUnitFilter === 'ALL' ? 'ทุกหน่วย' : statsUnitFilter}</span>
              <span className="font-semibold text-indigo-600">Active Logs</span>
            </div>
          </div>

          {/* KPI 2: Total Items Value Out */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">มูลค่าตัดจ่ายรวม</p>
                <h3 className="text-2xl sm:text-3xl font-black text-rose-600 font-mono mt-1 tracking-tight">
                  <span className="text-base mr-1">฿</span>
                  {analytics.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </h3>
              </div>
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 border border-rose-100 flex items-center justify-center shrink-0 shadow-2xs">
                <SendToBack className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-3 pt-2.5 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
              <span>ปริมาณสินค้าเบิกจ่าย:</span>
              <span className="font-bold text-slate-800 font-mono">{analytics.totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })} หน่วย</span>
            </div>
          </div>

          {/* KPI 3: Top Active Unit */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">หน่วยที่เบิกใช้งานสูงสุด</p>
                <h3 className="text-lg sm:text-xl font-bold text-slate-900 mt-1 truncate" title={analytics.mostActiveUnit?.name || '-'}>
                  {analytics.mostActiveUnit ? analytics.mostActiveUnit.name : '-'}
                </h3>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  {analytics.mostActiveUnit ? `${analytics.mostActiveUnit.count} ครั้ง (${analytics.mostActiveUnit.totalQty.toLocaleString()} หน่วย)` : 'ไม่มีข้อมูล'}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center shrink-0 shadow-2xs">
                <Building2 className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-3 pt-2.5 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
              <span>อันดับ 1 ในการเบิก</span>
              <span className="font-semibold text-emerald-700">Top Consumer</span>
            </div>
          </div>

          {/* KPI 4: Top Product */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">สินค้าที่ถูกเบิกมากที่สุด</p>
                <h3 className="text-sm sm:text-base font-bold text-slate-900 mt-1 truncate" title={analytics.mostIssuedProduct?.name || '-'}>
                  {analytics.mostIssuedProduct ? analytics.mostIssuedProduct.name : '-'}
                </h3>
                <p className="text-xs font-mono font-bold text-indigo-600 mt-0.5">
                  {analytics.mostIssuedProduct ? `${analytics.mostIssuedProduct.qty.toLocaleString()} ${analytics.mostIssuedProduct.unit} (${analytics.mostIssuedProduct.count} ครั้ง)` : 'ไม่มีข้อมูล'}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center shrink-0 shadow-2xs">
                <Sparkles className="w-5 h-5" />
              </div>
            </div>
            <div className="mt-3 pt-2.5 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
              <span>รหัส: {analytics.mostIssuedProduct?.code || '-'}</span>
              <span className="font-semibold text-amber-700">Top Item</span>
            </div>
          </div>

        </div>


        {/* ── View Mode 2: Detailed Matrix (Unit × Product Aggregation) ── */}
        {statsViewMode === 'MATRIX' && (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center gap-2">
                  <TableIcon className="w-4 h-4 text-indigo-600" />
                  <span>ตารางสรุป "หน่วยไหนใช้งานอะไร" (Unit × Item Usage Matrix)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  แสดงรายการสินค้าที่แต่ละห้องเบิกไปใช้งาน พร้อมความถี่ ยอดรวม และสัดส่วน
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-mono font-semibold">
                  พบ {analytics.matrixRows.length} รายการ
                </span>
                <button
                  type="button"
                  onClick={handleExportCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded-xl border border-slate-200 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-slate-500" />
                  <span>CSV</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto overflow-y-auto max-h-[550px] custom-scrollbar relative">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 shadow-2xs text-slate-500 font-bold text-[11px] uppercase tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3.5 px-4 pl-6">หน่วยที่เบิก (Location)</th>
                    <th className="py-3.5 px-4">รหัสสินค้า</th>
                    <th className="py-3.5 px-4">ชื่อสินค้า</th>
                    <th className="py-3.5 px-4 text-center">แผนก</th>
                    <th className="py-3.5 px-4 text-center">จำนวนครั้ง</th>
                    <th className="py-3.5 px-4 text-right">ยอดรวมที่เบิก</th>
                    <th className="py-3.5 px-4 text-right">ต้นทุนเฉลี่ย</th>
                    <th className="py-3.5 px-4 text-right">มูลค่ารวม (บาท)</th>
                    <th className="py-3.5 px-4 text-right">สัดส่วน (%)</th>
                    <th className="py-3.5 px-4 text-right pr-6">เบิกล่าสุด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedMatrixRows.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="p-8 text-center text-slate-400">
                        <PackageCheck className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                        <p className="font-semibold text-slate-600">ไม่พบข้อมูลการเบิกจ่ายตามเงื่อนไขที่เลือก</p>
                        <p className="text-xs text-slate-400 mt-1">ลองเปลี่ยนตัวกรองหน่วยหรือช่วงเวลาเพื่อดูข้อมูล</p>
                      </td>
                    </tr>
                  ) : (
                    paginatedMatrixRows.map((row, idx) => {
                      const config = usageUnitConfigMap[row.unitName] || { color: 'bg-slate-100 text-slate-700', badgeBg: 'bg-slate-100 text-slate-800' };
                      return (
                        <tr key={`${row.unitName}-${row.code}-${idx}`} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4 pl-6">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${config.color}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${config.dot || 'bg-slate-500'}`} />
                              {row.unitName}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-slate-700 text-xs">
                            {row.code}
                          </td>
                          <td className="py-3 px-4 font-semibold text-slate-800 max-w-[280px] truncate" title={row.name}>
                            {row.name}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              row.dept === 'PD' ? 'bg-blue-50 text-blue-700 border border-blue-200/60' : 'bg-amber-50 text-amber-700 border border-amber-200/60'
                            }`}>
                              {row.dept}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center font-mono font-bold text-slate-700">
                            {row.count} ครั้ง
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-rose-600 text-sm">
                            {row.qty.toLocaleString()} <span className="text-xs font-normal text-slate-400 font-sans">{row.unit}</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-500 text-xs">
                            ฿{Number(row.unitCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-slate-700 text-sm">
                            ฿{Number(row.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-600">
                            <div className="flex items-center justify-end gap-1.5">
                              <span>{row.pctOfTotal}%</span>
                              <div className="w-10 bg-slate-100 h-1.5 rounded-full overflow-hidden hidden sm:block">
                                <div className="bg-rose-500 h-full rounded-full" style={{ width: `${Math.min(100, Math.max(5, row.pctOfTotal))}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right pr-6 text-xs text-slate-500 whitespace-nowrap">
                            {row.lastDate}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Matrix Table Footer Pagination */}
            <Pagination
              currentPage={matrixPage}
              totalPages={matrixTotalPages}
              totalItems={analytics.matrixRows.length}
              pageSize={matrixPageSize}
              onPageChange={setMatrixPage}
              onPageSizeChange={setMatrixPageSize}
            />
          </div>
        )}

        {/* ── View Mode 3: Detailed Transaction Issue Logs ── */}
        {statsViewMode === 'LOGS' && (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center gap-2">
                  <ListFilter className="w-4 h-4 text-indigo-600" />
                  <span>ประวัติรายการเบิกจ่ายรายครั้ง (Detailed Issue Logs)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  บันทึกประวัติการเบิกสินค้าตัดสต็อกทุกรายการพร้อมผู้ทำรายการและเวลา
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-mono font-semibold">
                  ทั้งหมด {filteredStatsLogs.length} รายการ
                </span>
                <button
                  type="button"
                  onClick={handleExportCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded-xl border border-slate-200 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-slate-500" />
                  <span>CSV</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto overflow-y-auto max-h-[550px] custom-scrollbar relative">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 shadow-2xs text-slate-500 font-bold text-[11px] uppercase tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3.5 px-4 pl-6">วัน-เวลา</th>
                    <th className="py-3.5 px-4">เลขที่เอกสาร</th>
                    <th className="py-3.5 px-4">หน่วยที่เบิก</th>
                    <th className="py-3.5 px-4">สินค้า</th>
                    <th className="py-3.5 px-4 text-right">จำนวนที่เบิก</th>
                    <th className="py-3.5 px-4 text-right">คงเหลือ</th>
                    <th className="py-3.5 px-4">ผู้ทำรายการ</th>
                    <th className="py-3.5 px-4 pr-6">วัตถุประสงค์ / หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedStatsLogs.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="p-8 text-center text-slate-400">
                        <PackageCheck className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                        <p className="font-semibold text-slate-600">ไม่พบประวัติการเบิกจ่ายตามเงื่อนไขที่เลือก</p>
                      </td>
                    </tr>
                  ) : (
                    paginatedStatsLogs.map(log => {
                      const logUnit = getLogUnit(log);
                      const unitConf = usageUnitConfigMap[logUnit] || { color: 'bg-slate-100 text-slate-700 border-slate-200' };
                      const prod = products.find(p => p.id === log.productId || p.code === log.productCode);
                      return (
                        <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4 pl-6 text-slate-600 whitespace-nowrap text-xs">
                            {log.date}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-slate-800 text-xs">
                            {log.docNo}
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-bold border ${unitConf.color}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${unitConf.dot || 'bg-slate-500'}`} />
                              {logUnit}
                            </span>
                          </td>
                          <td className="py-3 px-4 max-w-[220px]">
                            <span className="font-mono text-[11px] font-semibold text-slate-500 block">{log.productCode}</span>
                            <span className="font-semibold text-slate-800 truncate block text-xs" title={prod?.name || log.productCode}>
                              {prod?.name || log.productCode}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-rose-600 text-sm whitespace-nowrap">
                            -{log.qty} <span className="text-xs font-normal text-slate-400 font-sans">{prod?.stockUnit || prod?.unit || log.unit || 'ชิ้น'}</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold text-slate-700">
                            {log.balance}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                            {log.user || 'ผู้เบิก'}
                          </td>
                          <td className="py-3 px-4 pr-6 text-xs text-slate-500 max-w-[200px] truncate" title={log.note}>
                            {log.note || '-'}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Logs Table Footer Pagination */}
            <Pagination
              currentPage={logsPage}
              totalPages={logsTotalPages}
              totalItems={filteredStatsLogs.length}
              pageSize={logsPageSize}
              onPageChange={setLogsPage}
              onPageSizeChange={setLogsPageSize}
            />
          </div>
        )}

      </div>
      )}

    </div>
  );
}

// Icon helper
function TableIcon(props) {
  return (
    <svg 
      {...props}
      xmlns="http://www.w3.org/2000/svg" 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
    </svg>
  );
}
