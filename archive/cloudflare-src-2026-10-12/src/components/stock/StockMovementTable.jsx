import React, { useState, useMemo, useCallback } from 'react';
import { History, ArrowDownRight, ArrowUpRight, X, MapPin, Search, Calendar, ChevronLeft, ChevronRight, FileText, RefreshCw } from 'lucide-react';
import Portal from '../common/Portal';
import { storageService, normalizeDocNumber } from '../../services/storageService';
import { AppContext } from '../../context/AppContext';
import { matchDepartment, isMultiDeptUser } from '../../utils/permissions';
import { healMACForProduct } from '../../utils/macMigration';

/**
 * Helper แปลง Timestamp ให้เป็น Epoch Milliseconds ที่รองรับทั้ง พ.ศ. และ ค.ศ.
 */
export const parseLogTimestamp = (dateVal) => {
  if (!dateVal) return 0;
  if (typeof dateVal === 'number') return dateVal;
  if (dateVal instanceof Date) return isNaN(dateVal.getTime()) ? 0 : dateVal.getTime();
  
  let str = String(dateVal).trim();
  if (!str) return 0;

  // 1. ตรวจสอบรูปแบบ DD/MM/YYYY [HH:mm[:ss]]
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    let y = parseInt(dmy[3], 10);
    if (y > 2400) y -= 543; // Thai BE to CE
    else if (y < 100) y += 2000;
    const m = parseInt(dmy[2], 10) - 1;
    const d = parseInt(dmy[1], 10);
    const hh = dmy[4] ? parseInt(dmy[4], 10) : 0;
    const mm = dmy[5] ? parseInt(dmy[5], 10) : 0;
    const ss = dmy[6] ? parseInt(dmy[6], 10) : 0;
    const dateObj = new Date(y, m, d, hh, mm, ss);
    if (!isNaN(dateObj.getTime())) {
      return dateObj.getTime();
    }
  }

  // 2. ตรวจจับและแปลงปี พ.ศ. (เช่น 2569 -> 2026) ในรูปแบบ ISO หรือสตริงอื่น
  const thaiYearMatch = str.match(/(?:^|\D)(25\d\d)(?:\D|$)/);
  if (thaiYearMatch) {
    const thaiYear = parseInt(thaiYearMatch[1], 10);
    const ceYear = thaiYear - 543;
    str = str.replace(String(thaiYear), String(ceYear));
  }

  const parsed = new Date(str).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

/**
 * Resilient Date Parser for diverse stock log formats (backward compatibility)
 */
export const parseLogDate = (raw) => {
  const ts = parseLogTimestamp(raw);
  return ts > 0 ? new Date(ts) : null;
};

/**
 * Format timestamp/date to 'DD/MM/YYYY HH:mm' in Bangkok (Asia/Bangkok) timezone in Thai Buddhist Era (พ.ศ.).
 */
export const formatDateTimeThai = (raw) => {
  if (!raw) return '-';
  const ts = parseLogTimestamp(raw);
  if (!ts) return typeof raw === 'string' && raw.trim() ? raw.trim() : '-';

  const d = new Date(ts);
  if (isNaN(d.getTime())) return '-';

  try {
    const formatted = new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      numberingSystem: 'latn'
    }).format(d);
    return formatted.replace(',', '').replace(/\s+/, ' ').trim();
  } catch {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    let year = d.getFullYear();
    if (year < 2400) year += 543;
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
};

/**
 * Movement Type Classifier Helpers
 */
export const isStockIn = (log) => {
  if (!log) return false;
  const type = String(log.type || log.actionType || log.docType || '').trim().toUpperCase();
  if (['OUT', '-OUT', 'ISSUE', 'DISPATCH', 'CONSUME', 'REDUCE', 'ADJUST_OUT'].includes(type)) {
    return false;
  }
  if (['IN', '+IN', 'RECEIVE', 'GRN', 'PURCHASE', 'ADJUST_IN', 'IN_NG', 'INITIAL', 'INITIAL-BALANCE'].includes(type)) {
    return true;
  }
  const doc = String(log.documentNo || log.docNo || log.id || '').toUpperCase();
  if (doc.startsWith('GRN') || doc.startsWith('INIT')) {
    return true;
  }
  if (doc.startsWith('OUT') || doc.startsWith('ISSUE')) {
    return false;
  }
  if (log.changeQty !== undefined && log.changeQty !== null) {
    return Number(log.changeQty) > 0;
  }
  return Number(log.quantity ?? log.qty ?? 0) > 0;
};

export const isStockOut = (log) => {
  if (!log) return false;
  const type = String(log.type || log.actionType || log.docType || '').trim().toUpperCase();
  if (['IN', '+IN', 'RECEIVE', 'GRN', 'PURCHASE', 'ADJUST_IN', 'IN_NG', 'INITIAL', 'INITIAL-BALANCE'].includes(type)) {
    return false;
  }
  if (['OUT', '-OUT', 'ISSUE', 'DISPATCH', 'CONSUME', 'REDUCE', 'ADJUST_OUT'].includes(type)) {
    return true;
  }
  const doc = String(log.documentNo || log.docNo || log.id || '').toUpperCase();
  if (doc.startsWith('GRN') || doc.startsWith('INIT')) {
    return false;
  }
  if (doc.startsWith('OUT') || doc.startsWith('ISSUE')) {
    return true;
  }
  if (log.changeQty !== undefined && log.changeQty !== null) {
    return Number(log.changeQty) < 0;
  }
  return false;
};

export default function StockMovementTable({
  selectedProduct: propSelectedProduct,
  product,
  stockLogs = [],
  pos = [],
  currentUser: propCurrentUser,
  currentRole: propCurrentRole,
  onClose,
  onRefresh,
  initialFilterType,
  filterType: controlledFilterType
}) {
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [internalFilterType, setInternalFilterType] = useState(initialFilterType || 'ALL'); // ALL, IN, OUT
  const filterType = controlledFilterType !== undefined ? controlledFilterType : internalFilterType;
  const setFilterType = (val) => setInternalFilterType(val);
  const [timeFilter, setTimeFilter] = useState('3M'); // 3M (3 เดือนล่าสุด), ALL (ทั้งหมด)
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10); // 10-15 rows per page
  const [activeNoteModal, setActiveNoteModal] = useState(null); // Full Note modal state
  const selectedProduct = product || propSelectedProduct;

  // Retrieve contextual user for department scoping guard
  const appContext = React.useContext(AppContext) || {};
  const effectiveUser = propCurrentUser || propCurrentRole || appContext.currentUser || appContext.currentRole || null;

  // Retrieve pos list from props or storageService as a safe fallback
  const resolvedPOs = useMemo(() => {
    if (pos && pos.length > 0) return pos;
    try {
      return storageService.getPOs() || [];
    } catch {
      return [];
    }
  }, [pos]);

  // Retrieve stock logs with safe fallback to storageService
  const resolvedStockLogs = useMemo(() => {
    if (Array.isArray(stockLogs) && stockLogs.length > 0) return stockLogs;
    try {
      return storageService.getStockLogs() || [];
    } catch {
      return [];
    }
  }, [stockLogs]);

  // Strict Product Scoping & User Department Isolation Guard
  const rawProductLogs = useMemo(() => {
    if (!selectedProduct) return [];
    const targetProductId = String(selectedProduct.id || '').trim();
    const targetDept = String(selectedProduct.department || selectedProduct.category || '').trim();
    const targetCode = String(selectedProduct.code || selectedProduct.sku || '').trim();

    const userDept = String(effectiveUser?.department || effectiveUser?.primaryDepartment || '').trim();
    const isMultiDept = effectiveUser ? isMultiDeptUser(effectiveUser) : true;

    return resolvedStockLogs.filter(log => {
      if (!log) return false;

      // 0. User Department Protection Guard:
      // If user is a single department user, log must match user's department
      if (userDept && !isMultiDept && !matchDepartment(log.department || targetDept, userDept)) {
        return false;
      }

      // Department consistency guard: If log has department and target has department, they must match
      if (log.department && targetDept && !matchDepartment(log.department, targetDept)) {
        return false;
      }

      // 1. ตรวจสอบด้วย Product ID คอลัมน์หลัก (แม่นยำสูงสุด)
      if (targetProductId && log.productId) {
        return String(log.productId).trim() === targetProductId;
      }

      // 2. Fallback: ถ้า log เก่าไม่มี productId ให้ตรวจสอบทั้ง Department และ Code คู่กันเสมอ
      const isSameDept = matchDepartment(log.department || targetDept, targetDept);
      const isSameCode = String(log.productCode || log.code || log.sku || '').trim() === targetCode;

      return isSameDept && isSameCode;
    });
  }, [resolvedStockLogs, selectedProduct, effectiveUser]);

  // Self-Healing Data (Migration): If product.stock > 0 but movement logs are empty,
  // auto-generate the initial balance log and persist it so stock and history reconcile
  const scopedLogs = useMemo(() => {
    if (!selectedProduct) return [];
    const stockVal = Number(selectedProduct.stockBalance ?? selectedProduct.stock ?? selectedProduct.qty) || 0;

    if (rawProductLogs.length === 0 && stockVal > 0) {
      const conversionRate = Number(selectedProduct.conversionRate || selectedProduct.conversionRatio) || 1;
      const unitCostInStock = (Number(selectedProduct.price) || 0) / conversionRate;
      const initialSyntheticLog = {
        id: `INIT-${selectedProduct.id || selectedProduct.code || 'SYS'}`,
        date: selectedProduct.createdAt ? new Date(selectedProduct.createdAt).toISOString() : new Date().toISOString(),
        displayDate: selectedProduct.createdAt ? new Date(selectedProduct.createdAt).toISOString() : new Date().toISOString(),
        timestamp: selectedProduct.createdAt ? new Date(selectedProduct.createdAt).toISOString() : new Date().toISOString(),
        productId: selectedProduct.id,
        productCode: selectedProduct.code,
        name: selectedProduct.name,
        department: selectedProduct.department || selectedProduct.category || 'PD',
        type: 'IN',
        documentNo: 'INITIAL-BALANCE',
        docNo: 'INITIAL-BALANCE',
        poNo: '-',
        poNumber: '-',
        qty: stockVal,
        balance: stockVal,
        unit: selectedProduct.stockUnit || selectedProduct.unit || 'ชิ้น',
        unitPrice: unitCostInStock,
        totalPrice: unitCostInStock * stockVal,
        conversionRate: conversionRate,
        user: 'System Initial Balance',
        locationId: selectedProduct.locationId || '',
        locationName: selectedProduct.locationName || '',
        note: 'ยอดยกมาจากระบบเริ่มต้น (System Initial Balance)'
      };
      return [initialSyntheticLog];
    }

    // ตัดข้อมูลซ้ำซ้อน (Deduplication) ของประวัติสต็อก
    const uniqueLogs = Array.from(
      new Map(rawProductLogs.map(item => [item.id || `${item.timestamp}_${item.type}_${item.documentNo}`, item])).values()
    );

    return uniqueLogs;
  }, [rawProductLogs, selectedProduct]);

  // Persist self-healed initial balance log to storage & backend if missing
  React.useEffect(() => {
    if (!selectedProduct) return;
    const stockVal = Number(selectedProduct.stockBalance ?? selectedProduct.stock ?? selectedProduct.qty) || 0;
    if (stockVal > 0 && rawProductLogs.length === 0) {
      const allLogs = storageService.getStockLogs() || [];
      const targetProductId = String(selectedProduct.id || '').trim();
      const targetDept = String(selectedProduct.department || selectedProduct.category || '').trim();
      const targetCode = String(selectedProduct.code || selectedProduct.sku || '').trim();

      const hasAny = allLogs.some(l => {
        if (!l) return false;
        if (l.department && targetDept && !matchDepartment(l.department, targetDept)) return false;
        if (targetProductId && l.productId) {
          return String(l.productId).trim() === targetProductId;
        }
        return matchDepartment(l.department, targetDept) && String(l.productCode || l.code || '').trim() === targetCode;
      });

      if (!hasAny) {
        const conversionRate = Number(selectedProduct.conversionRate || selectedProduct.conversionRatio) || 1;
        const unitCostInStock = (Number(selectedProduct.price) || 0) / conversionRate;
        const healedLog = {
          id: `INIT-${selectedProduct.id || selectedProduct.code || Date.now()}`,
          date: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          productId: selectedProduct.id,
          productCode: selectedProduct.code,
          name: selectedProduct.name,
          department: selectedProduct.department || selectedProduct.category || 'PD',
          type: 'IN',
          documentNo: 'INITIAL-BALANCE',
          docNo: 'INITIAL-BALANCE',
          poNo: '-',
          poNumber: '-',
          qty: stockVal,
          balance: stockVal,
          unit: selectedProduct.stockUnit || selectedProduct.unit || 'ชิ้น',
          unitPrice: unitCostInStock,
          totalPrice: unitCostInStock * stockVal,
          conversionRate: conversionRate,
          user: 'System Initial Balance',
          locationId: selectedProduct.locationId || '',
          locationName: selectedProduct.locationName || '',
          note: 'ยอดยกมาจากระบบเริ่มต้น (System Initial Balance)'
        };
        const updated = [healedLog, ...allLogs];
        storageService.saveStockLogs(updated);
        try {
          fetch('/api/stock-logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
          }).catch(() => {});
        } catch {}
      }
    }
  }, [selectedProduct, rawProductLogs.length]);

  // Single-Stream Data Processing Pipeline:
  // ขั้นตอนที่ 2: กรองตามแท็บ (ALL, IN, OUT), ช่วงเวลา และการค้นหา
  const filteredLogs = useMemo(() => {
    return scopedLogs.filter(log => {
      // Type Filter (ALL, IN, +IN, OUT, -OUT)
      const activeTab = String(filterType || 'ALL').toUpperCase();
      if (activeTab.includes('OUT')) {
        if (!isStockOut(log)) return false; // ต้องเป็นรายการเบิกจ่ายเท่านั้น
      } else if (activeTab.includes('IN')) {
        if (!isStockIn(log)) return false;  // ต้องเป็นรายการรับเข้าเท่านั้น
      }

      // Time Range Filter (3M / 3_MONTHS: 3 เดือนล่าสุด)
      if (timeFilter === '3M' || timeFilter === '3_MONTHS') {
        const t = parseLogTimestamp(log.timestamp || log.date || log.createdAt);
        const threeMonthsAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
        if (t > 0 && t < threeMonthsAgo) return false;
      }

      // Search Query Filter
      if (!searchQuery.trim()) return true;

      const q = searchQuery.trim().toLowerCase();
      const normDoc = normalizeDocNumber(log).toLowerCase();
      const rawDoc = String(log.documentNo || log.docNo || log.referenceDoc || log.id || log.grnNo || log.grNumber || '').toLowerCase();
      const parentPo = String(log.refPo || log.poNumber || log.poNo || '').toLowerCase();
      const user = String(log.user || log.actorName || log.issuedTo || log.requester || '').toLowerCase();
      const note = String(log.note || log.notes || log.remark || log.remarks || log.reason || '').toLowerCase();

      // Stem matching for PO numbers
      let qPoStem = q;
      if (q.startsWith('grn-')) {
        const match = q.match(/grn-(po-[a-z0-9-]+?)(?:-\d{2})?$/i);
        if (match) qPoStem = match[1].toLowerCase();
      }

      return (
        normDoc.includes(q) ||
        rawDoc.includes(q) ||
        parentPo.includes(q) ||
        parentPo.includes(qPoStem) ||
        normDoc.includes(qPoStem) ||
        user.includes(q) ||
        note.includes(q)
      );
    });
  }, [scopedLogs, filterType, timeFilter, searchQuery]);

  // ขั้นตอนที่ 3: เรียงลำดับจากล่าสุดไปเก่าสุดเสมอ (Newest First / Descending)
  const sortedLogs = useMemo(() => {
    return [...filteredLogs].sort((a, b) => {
      const timeA = parseLogTimestamp(a.timestamp || a.date || a.createdAt);
      const timeB = parseLogTimestamp(b.timestamp || b.date || b.createdAt);
      return timeB - timeA;
    });
  }, [filteredLogs]);

  // Helper to format currency numbers (stable reference via useCallback)
  const formatCurrency = useCallback((val) => {
    if (val === null || val === undefined || isNaN(val)) return '-';
    return Number(val).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, []);

  /**
   * Pre-computed purchase detail lookup Map (Performance)
   * Runs once per sortedLogs/resolvedPOs change instead of
   * re-computing on every render cycle for every visible row.
   * Returns: Map<log.id, { poNumber, totalPurchaseAmount, avgUnitPrice }>
   */
  const purchaseDetailMap = useMemo(() => {
    const map = new Map();
    const _compute = (log) => {
      // Only calculate and display for incoming inventory (+IN / IN_NG)
      if (log.type !== 'IN' && log.type !== 'IN_NG') {
        return { poNumber: '-', totalPurchaseAmount: '-', avgUnitPrice: '-' };
      }

      const conversionRate = Number(
        selectedProduct?.conversionRate ||
        selectedProduct?.conversionRatio ||
        log.conversionRate ||
        log.conversionRatio ||
        1
      ) || 1;

      // 1. Direct fields already attached to the stock log
      let poNumber = log.poNo || log.poNumber || (log.docNo && String(log.docNo).startsWith('PO-') ? log.docNo : null);
      let totalAmount = log.totalAmount !== undefined && log.totalAmount !== null
        ? Number(log.totalAmount)
        : (log.totalPrice !== undefined && log.totalPrice !== null ? Number(log.totalPrice) : null);
      let unitPrice = log.baseUnitCost !== undefined && log.baseUnitCost !== null
        ? Number(log.baseUnitCost)
        : (log.unitPrice !== undefined && log.unitPrice !== null ? Number(log.unitPrice) : null);

      // 2. If PO number not directly found, try to extract from note
      if (!poNumber && (log.note || log.notes)) {
        const fullNote = String(log.note || log.notes);
        const match = fullNote.match(/PO[-\s]?([A-Z0-9\-_/]+)/i);
        if (match) {
          poNumber = match[0].trim();
        }
      }

      // 3. Match with PO in state/storage
      if (poNumber || log.poId) {
        const matchedPO = resolvedPOs.find(p =>
          (poNumber && (p.poNo === poNumber || p.poNumber === poNumber)) ||
          (log.poId && p.id === log.poId) ||
          (log.docNo && (p.poNo === log.docNo || p.id === log.docNo))
        );

        if (matchedPO) {
          if (!poNumber) poNumber = matchedPO.poNo || matchedPO.poNumber;

          // Find matching item in PO items
          const matchedItem = (matchedPO.items || []).find(item =>
            (item.productId && (item.productId === log.productId || item.productId === selectedProduct.id)) ||
            (item.code && (item.code === log.productCode || item.code === selectedProduct.code)) ||
            (item.name && selectedProduct.name && item.name === selectedProduct.name)
          );

          if (matchedItem) {
            const itemPrice = Number(matchedItem.actUnitPrice ?? matchedItem.actualPrice ?? matchedItem.price) || 0;
            const discountAmt = Number(matchedItem.discountAmount) || 0;
            const itemTotal = matchedItem.total !== undefined
              ? Number(matchedItem.total)
              : Math.max(0, (itemPrice * (Number(matchedItem.purchaseQty ?? matchedItem.qty) || 1)) - discountAmt);

            const convRate = Number(matchedItem.conversionRate || conversionRate) > 0
              ? Number(matchedItem.conversionRate || conversionRate)
              : 1;

            if (unitPrice === null || unitPrice === 0 || (unitPrice === itemPrice && convRate > 1)) {
              unitPrice = itemPrice / convRate;
            }

            if (totalAmount === null || totalAmount === 0 || (totalAmount === (Number(log.qty) * itemPrice) && convRate > 1)) {
              if (Number(log.qty) > 0 && unitPrice > 0) {
                totalAmount = unitPrice * Number(log.qty);
              } else {
                totalAmount = itemTotal;
              }
            }
          } else if ((totalAmount === null || totalAmount === 0) && matchedPO.grandTotal) {
            if (matchedPO.items?.length === 1) {
              totalAmount = Number(matchedPO.grandTotal);
            }
          }
        }
      }

      // 4. Initial balance / Unmatched log Dual-UOM normalization
      if (conversionRate > 1) {
        const prodPrice = Number(selectedProduct?.price) || 0;
        const isDocInit = String(log.documentNo || log.docNo || '').toUpperCase().includes('INITIAL');
        if (unitPrice === prodPrice || isDocInit || (totalAmount && Math.abs(totalAmount - (Number(log.qty) * prodPrice)) < 0.01)) {
          unitPrice = (unitPrice && unitPrice !== prodPrice ? unitPrice : prodPrice) / conversionRate;
          totalAmount = Number(log.qty) * unitPrice;
        }
      }

      // 5. Fallback calculation for unitPrice
      const qtyNum = Number(log.qty) || 0;
      if ((unitPrice === null || unitPrice === 0) && totalAmount !== null && qtyNum > 0) {
        unitPrice = totalAmount / qtyNum;
      } else if ((totalAmount === null || totalAmount === 0) && unitPrice !== null && qtyNum > 0) {
        totalAmount = unitPrice * qtyNum;
      }

      const stockUnitName = selectedProduct?.stockUnit || selectedProduct?.unit || log.unit || 'ชิ้น';

      return {
        poNumber: poNumber || log.poNo || log.poNumber || '-',
        totalPurchaseAmount: totalAmount !== null && totalAmount > 0 ? `${formatCurrency(totalAmount)} ฿` : '-',
        avgUnitPrice: unitPrice !== null && unitPrice > 0 ? `฿${formatCurrency(unitPrice)} / ${stockUnitName}` : '-',
        rawTotalAmount: totalAmount,
        rawUnitPrice: unitPrice
      };
    };

    sortedLogs.forEach(log => {
      map.set(log.id, _compute(log));
    });
    return map;
  }, [sortedLogs, resolvedPOs, selectedProduct, formatCurrency]);

  // ขั้นตอนที่ 4: แบ่งหน้า Pagination
  const totalPages = Math.max(1, Math.ceil(sortedLogs.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  
  const pagedLogs = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize;
    return sortedLogs.slice(start, start + pageSize);
  }, [sortedLogs, safeCurrentPage, pageSize]);

  // Generate Page Numbers for Pagination
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (safeCurrentPage > 3) pages.push('...');
      const start = Math.max(2, safeCurrentPage - 1);
      const end = Math.min(totalPages - 1, safeCurrentPage + 1);
      for (let i = start; i <= end; i++) {
        if (!pages.includes(i)) pages.push(i);
      }
      if (safeCurrentPage < totalPages - 2) pages.push('...');
      if (!pages.includes(totalPages)) pages.push(totalPages);
    }
    return pages;
  };

  return (
    <Portal>
      <div className="fixed inset-0 glass-backdrop z-[100] flex items-center justify-center p-4 overflow-y-auto animate-fade-in">
        <div className="bg-white rounded-3xl border border-slate-200/90 shadow-2xl p-6 sm:p-7 max-w-6xl w-full text-slate-800 space-y-4 my-8 animate-zoom-in">
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shadow-2xs">
                <History className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2">
                  <span>ประวัติการเคลื่อนไหวสินค้า (Stock Movement Log)</span>
                </h3>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold">[{selectedProduct.code}] {selectedProduct.name}</span>
                  <span>•</span>
                  <span>คงเหลือ: <span className="font-bold text-indigo-600 font-mono tabular-nums">{selectedProduct.stockBalance}</span> {selectedProduct.stockUnit || selectedProduct.baseUom || selectedProduct.unit || 'ชิ้น'}</span>
                  {Number(selectedProduct.conversionRate || selectedProduct.conversionRatio) > 1 && (selectedProduct.purchaseUnit || selectedProduct.purchaseUom) && (
                    <>
                      <span>•</span>
                      <span className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-sans">
                        (1 {selectedProduct.purchaseUnit || selectedProduct.purchaseUom} = {Number(selectedProduct.conversionRate || selectedProduct.conversionRatio).toLocaleString()} {selectedProduct.stockUnit || selectedProduct.baseUom || selectedProduct.unit || 'ชิ้น'})
                      </span>
                    </>
                  )}
                  {selectedProduct.locationName && (
                    <>
                      <span>•</span>
                      <span className="inline-flex items-center gap-1 text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">
                        <MapPin className="w-3 h-3 text-indigo-600" />
                        <span>{selectedProduct.locationName}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isRecalculating}
                onClick={async () => {
                  if (isRecalculating) return;
                  setIsRecalculating(true);
                  try {
                    const targetKey = selectedProduct?.id || selectedProduct?.code;
                    const healed = await healMACForProduct(targetKey);
                    if (healed && Number(healed.averageCost || healed.avgCost || 0) > 0) {
                      const finalCost = Number(healed.averageCost || healed.avgCost).toFixed(2);
                      alert(`คำนวณต้นทุนเฉลี่ยใหม่สำเร็จ: ฿${finalCost}`);
                      // Global Cache Invalidation: refresh context so other views get updated immediately without reload
                      if (typeof onRefresh === 'function') {
                        await onRefresh();
                      } else if (typeof appContext.refreshData === 'function') {
                        await appContext.refreshData();
                      }
                    } else {
                      alert('ไม่สามารถคำนวณใหม่ได้ (อาจไม่มีประวัติรับเข้า)');
                    }
                  } catch (err) {
                    console.error('[StockMovementTable] Error recalculating MAC:', err);
                    alert('เกิดข้อผิดพลาดในการคำนวณต้นทุนเฉลี่ย: ' + err.message);
                  } finally {
                    setIsRecalculating(false);
                  }
                }}
                className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-3 py-1.5 rounded-xl border border-indigo-100 bg-white transition-colors cursor-pointer text-xs font-bold flex items-center gap-1.5 shadow-2xs hover:shadow-xs disabled:opacity-50"
                title="ระบบจะล้างค่าต้นทุนเฉลี่ยเก่า และคำนวณใหม่ทั้งหมดตามประวัติรับเข้าจริง (ตัดแถวขยะออก)"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRecalculating ? 'animate-spin' : ''}`} />
                <span>{isRecalculating ? 'กำลังคำนวณ...' : 'คำนวณต้นทุนเฉลี่ยใหม่'}</span>
              </button>
              <button 
                onClick={onClose} 
                className="text-slate-400 hover:text-slate-700 p-2 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer" 
                title="ปิด"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Filters & Search Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: Type Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500 mr-1 uppercase tracking-wider">ประเภท:</span>
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => { setFilterType('ALL'); setCurrentPage(1); }}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    filterType === 'ALL' ? 'bg-white text-slate-900 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ทั้งหมด
                </button>
                <button
                  type="button"
                  onClick={() => { setFilterType('IN'); setCurrentPage(1); }}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    filterType === 'IN' || filterType === '+IN' ? 'bg-emerald-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  +IN (รับเข้า)
                </button>
                <button
                  type="button"
                  onClick={() => { setFilterType('OUT'); setCurrentPage(1); }}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    filterType === 'OUT' || filterType === '-OUT' ? 'bg-rose-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  -OUT (เบิกจ่าย)
                </button>
              </div>
            </div>

            {/* Right: Time Period Filter & Search */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Filter ช่วงเวลา: 3 เดือนล่าสุด (Default) / ทั้งหมด */}
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/40">
                <div className="flex items-center gap-1 pl-1.5 pr-1 text-slate-400">
                  <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                </div>
                <button
                  type="button"
                  onClick={() => { setTimeFilter('3M'); setCurrentPage(1); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    timeFilter === '3M' ? 'bg-indigo-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  3 เดือนล่าสุด
                </button>
                <button
                  type="button"
                  onClick={() => { setTimeFilter('ALL'); setCurrentPage(1); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    timeFilter === 'ALL' ? 'bg-indigo-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ทั้งหมด
                </button>
              </div>

              {/* Document / PO Search Input */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="ค้นหาเลขที่เอกสาร / PO..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  className="pl-8 pr-7 py-1.5 bg-slate-50 hover:bg-white focus:bg-white border border-slate-200/80 rounded-xl text-xs placeholder:text-slate-400 text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 w-52 sm:w-56 transition-all shadow-2xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => { setSearchQuery(''); setCurrentPage(1); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
                    title="ล้างคำค้นหา"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Table Container with Scrollbar & Sticky Header (max-h-[55vh] overflow-y-auto) */}
          <div className="overflow-x-auto overflow-y-auto max-h-[55vh] border border-slate-200/80 rounded-2xl custom-scrollbar relative shadow-2xs">
            <table className="w-full text-left text-xs sm:text-sm min-w-[950px]">
              <thead className="sticky top-0 z-10 bg-slate-50 shadow-2xs text-slate-500 font-bold text-[11px] uppercase tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3.5 pl-5 whitespace-nowrap">วัน-เวลา</th>
                  <th className="py-3.5 px-3 whitespace-nowrap">ประเภท</th>
                  <th className="py-3.5 px-3 whitespace-nowrap">เลขที่เอกสาร</th>
                  <th className="py-3.5 px-3 text-right whitespace-nowrap">จำนวน</th>
                  <th className="py-3.5 px-3 text-right whitespace-nowrap">ยอดคงเหลือ</th>
                  <th className="py-3.5 px-3 whitespace-nowrap text-left bg-indigo-50/40 text-indigo-900">เลขที่ PO</th>
                  <th className="py-3.5 px-3 text-right whitespace-nowrap bg-indigo-50/40 text-indigo-900">มูลค่ารวม / ซื้อ (฿)</th>
                  <th className="py-3.5 px-3 text-right whitespace-nowrap bg-indigo-50/40 text-indigo-900">ต้นทุนเฉลี่ย/หน่วย</th>
                  <th className="py-3.5 px-3 whitespace-nowrap">ผู้ทำรายการ</th>
                  <th className="py-3.5 pr-5 whitespace-nowrap">หมายเหตุ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {sortedLogs.length === 0 ? (
                  <tr>
                    <td colSpan="10" className="p-8 text-center text-slate-400">
                      ไม่พบประวัติความเคลื่อนไหวตามเงื่อนไขที่เลือก
                    </td>
                  </tr>
                ) : (
                  pagedLogs.map(log => {
                    const purchase = purchaseDetailMap.get(log.id) || { poNumber: '-', totalPurchaseAmount: '-', avgUnitPrice: '-' };
                    const isIncoming = isStockIn(log);
                    const isNg = String(log.type || '').toUpperCase() === 'IN_NG';
                    const rawDate = log.timestamp || log.displayDate || log.date || log.createdAt;
                    const normalizedDocNo = normalizeDocNumber(log) || log.docNo || log.documentNo || log.grnNo || log.grnNumber || log.grNumber || '-';
                    const rawNote = log.notes || log.note || log.remark || log.remarks || '';
                    const noteText = String(rawNote).trim();
                    const isNoteLong = noteText.length > 25;
                    const itemStockUnit = selectedProduct?.stockUnit || selectedProduct?.baseUom || selectedProduct?.unit || log.stockUnit || log.unit || 'ชิ้น';
                    const purchaseUnit = log.purchaseUnit || log.purchaseUom || (selectedProduct?.purchaseUnit && selectedProduct?.purchaseUnit !== itemStockUnit ? selectedProduct?.purchaseUnit : null);
                    const conversionRate = Number(log.conversionRate || log.conversionRatio || selectedProduct?.conversionRate || selectedProduct?.conversionRatio || 1);

                    let dualUomText = null;
                    if (purchaseUnit && purchaseUnit !== itemStockUnit && conversionRate > 1) {
                      const purchaseQty = log.receivedQty !== undefined && log.receivedQty !== null && Number(log.receivedQty) > 0
                        ? Number(log.receivedQty)
                        : (Math.abs(Number(log.changeQty ?? log.quantity ?? log.qty ?? 0)) / conversionRate);
                      if (purchaseQty > 0) {
                        const formattedPurchaseQty = Number.isInteger(purchaseQty) ? purchaseQty : Number(purchaseQty.toFixed(2));
                        dualUomText = `${formattedPurchaseQty.toLocaleString()} ${purchaseUnit}`;
                      }
                    }

                    return (
                      <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                        {/* 1. Date: Formatted as DD/MM/YYYY HH:mm in Bangkok Time */}
                        <td className="py-3 pl-5 text-slate-600 whitespace-nowrap font-mono text-xs">
                          {formatDateTimeThai(rawDate)}
                        </td>

                        {/* 2. Type */}
                        <td className="py-3 px-3 whitespace-nowrap">
                          {isNg ? (
                            <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 font-bold px-2.5 py-0.5 rounded-full text-[10px] border border-amber-200">
                              <ArrowDownRight className="w-3 h-3 text-amber-600" /> IN (NG)
                            </span>
                          ) : isIncoming ? (
                            <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 font-bold px-2.5 py-0.5 rounded-full text-[10px] border border-emerald-200">
                              <ArrowDownRight className="w-3 h-3 text-emerald-600" /> IN
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-700 font-bold px-2.5 py-0.5 rounded-full text-[10px] border border-rose-200">
                              <ArrowUpRight className="w-3 h-3 text-rose-600" /> OUT
                            </span>
                          )}
                        </td>

                        {/* 3. Document Number */}
                        <td className="py-3 px-3 font-mono text-xs whitespace-nowrap">
                          {(() => {
                            const parentPo = log.poNo || log.poNumber || log.refPo || (purchase && purchase.poNumber !== '-' ? purchase.poNumber : null) || (String(log.docNo || log.documentNo || '').startsWith('PO-') ? (log.docNo || log.documentNo) : null);
                            return (
                              <div>
                                <span className="font-mono font-bold text-slate-800">{normalizedDocNo}</span>
                                {parentPo && parentPo !== '-' && parentPo !== normalizedDocNo && (
                                  <div className="text-[11px] text-slate-400 font-sans">อ้างอิง: {parentPo}</div>
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        {/* 4. Quantity */}
                        <td className={`py-3 px-3 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                          isIncoming ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          <div className="flex items-baseline justify-end gap-1">
                            <span>
                              {isIncoming
                                ? `+${Math.abs(Number(log.changeQty ?? log.quantity ?? log.qty ?? 0)).toLocaleString()}`
                                : `-${Math.abs(Number(log.changeQty ?? log.quantity ?? log.qty ?? 0)).toLocaleString()}`}
                            </span>
                            <span className="text-xs font-normal font-sans opacity-90">
                              {itemStockUnit}
                            </span>
                            {dualUomText && (
                              <span className="text-[11px] font-normal font-sans text-slate-400 ml-0.5" title={`แปลงจากหน่วยสั่งซื้อ: ${dualUomText}`}>
                                ({dualUomText})
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 5. Balance */}
                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                          <div className="flex items-baseline justify-end gap-1">
                            <span>
                              {Number(log.balanceAfter ?? log.balance ?? 0).toLocaleString()}
                            </span>
                            <span className="text-xs font-normal font-sans text-slate-500">
                              {itemStockUnit}
                            </span>
                          </div>
                        </td>

                        {/* 6. PO Number */}
                        <td className="py-3 px-3 font-mono text-xs whitespace-nowrap text-left">
                          {isIncoming && ((log.poNo && log.poNo !== '-') || (log.poNumber && log.poNumber !== '-') || (purchase && purchase.poNumber !== '-')) ? (
                            <span className="inline-block px-2 py-0.5 rounded-md bg-indigo-50 font-bold text-indigo-700 border border-indigo-200/70">
                              {(log.poNo && log.poNo !== '-') ? log.poNo : ((log.poNumber && log.poNumber !== '-') ? log.poNumber : purchase.poNumber)}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">-</span>
                          )}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                          {isIncoming && log.totalAmount !== undefined && Number(log.totalAmount) > 0 ? (
                            <span className="font-semibold text-slate-900">
                              {formatCurrency(log.totalAmount)} ฿
                            </span>
                          ) : isIncoming && purchase.totalPurchaseAmount !== '-' ? (
                            <span className="font-semibold text-slate-900">
                              {purchase.totalPurchaseAmount}
                            </span>
                          ) : isIncoming && log.totalPrice !== undefined && Number(log.totalPrice) > 0 ? (
                            <span className="font-semibold text-slate-900">
                              {formatCurrency(log.totalPrice)} ฿
                            </span>
                          ) : !isIncoming && log.totalCost !== undefined ? (
                            <span className="font-semibold text-rose-700">
                              {formatCurrency(log.totalCost)} ฿
                            </span>
                          ) : !isIncoming && log.totalPrice !== undefined ? (
                            <span className="font-semibold text-rose-700">
                              {formatCurrency(log.totalPrice)} ฿
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">-</span>
                          )}
                        </td>

                        {/* 8. Average Unit Price / Cost */}
                        <td className="py-3 px-3 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                          {isIncoming && log.unitPrice !== undefined && Number(log.unitPrice) > 0 ? (
                            <span className="font-semibold text-indigo-700 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100">
                              ฿{formatCurrency(log.unitPrice)} / {selectedProduct?.stockUnit || selectedProduct?.unit || log.unit || 'ชิ้น'}
                            </span>
                          ) : isIncoming && purchase.avgUnitPrice !== '-' ? (
                            <span className="font-semibold text-indigo-700 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100">
                              {purchase.avgUnitPrice}
                            </span>
                          ) : isIncoming && log.baseUnitCost !== undefined && Number(log.baseUnitCost) > 0 ? (
                            <span className="font-semibold text-indigo-700 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100">
                              ฿{formatCurrency(log.baseUnitCost)} / {selectedProduct?.stockUnit || selectedProduct?.unit || log.unit || 'ชิ้น'}
                            </span>
                          ) : !isIncoming && log.unitCost !== undefined ? (
                            <span className="font-semibold text-rose-700 bg-rose-50/50 px-2 py-0.5 rounded border border-rose-100">
                              ฿{formatCurrency(log.unitCost)} / {selectedProduct?.stockUnit || selectedProduct?.unit || log.unit || 'ชิ้น'}
                            </span>
                          ) : !isIncoming && log.unitPrice !== undefined ? (
                            <span className="font-semibold text-rose-700 bg-rose-50/50 px-2 py-0.5 rounded border border-rose-100">
                              ฿{formatCurrency(log.unitPrice)} / {selectedProduct?.stockUnit || selectedProduct?.unit || log.unit || 'ชิ้น'}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">-</span>
                          )}
                        </td>

                        {/* 9. User */}
                        <td className="py-3 px-3 text-slate-700 text-xs whitespace-nowrap">
                          {log.actorName || log.user || '-'}
                        </td>

                        {/* 10. Note: With Full Tooltip and "ดูโน้ต" button for long notes */}
                        <td className="py-3 pr-5 text-slate-600 text-xs">
                          {!noteText ? (
                            <span className="text-slate-300">-</span>
                          ) : (
                            <div className="flex items-center gap-1.5 max-w-[200px]">
                              <span className="truncate text-slate-600" title={noteText}>
                                {noteText}
                              </span>
                              {isNoteLong && (
                                <button
                                  type="button"
                                  onClick={() => setActiveNoteModal({
                                    docNo: normalizedDocNo,
                                    date: formatDateTimeThai(rawDate),
                                    note: noteText
                                  })}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded border border-indigo-200/80 transition-colors whitespace-nowrap cursor-pointer shadow-2xs"
                                  title="คลิกเพื่อดูโน้ตเต็ม"
                                >
                                  ดูโน้ต
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination & Summary Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-1 pt-1 text-xs text-slate-500 select-none">
            {/* Left: Item Range Summary & Page Size selector */}
            <div className="flex items-center gap-3">
              <span>
                แสดง <span className="font-mono font-semibold text-slate-800">{sortedLogs.length === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1}</span> - <span className="font-mono font-semibold text-slate-800">{Math.min(safeCurrentPage * pageSize, sortedLogs.length)}</span> จากทั้งหมด <span className="font-mono font-semibold text-slate-800">{sortedLogs.length}</span> รายการ
              </span>
              <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200">
                <span className="text-[11px] text-slate-400">แสดงหน้าละ:</span>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="bg-slate-50 border border-slate-200 text-slate-700 text-[11px] font-mono font-semibold rounded-lg px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer shadow-2xs"
                >
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                  <option value={25}>25</option>
                </select>
              </div>
            </div>

            {/* Right: Page Navigation Buttons < 1 2 3 > */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={safeCurrentPage === 1}
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  className="p-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="หน้าก่อนหน้า"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>

                {getPageNumbers().map((pg, idx) => (
                  pg === '...' ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-slate-400 select-none">...</span>
                  ) : (
                    <button
                      key={pg}
                      type="button"
                      onClick={() => setCurrentPage(pg)}
                      className={`min-w-6 h-6 px-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                        safeCurrentPage === pg
                          ? 'bg-indigo-600 text-white shadow-xs font-bold'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`}
                    >
                      {pg}
                    </button>
                  )
                ))}

                <button
                  type="button"
                  disabled={safeCurrentPage === totalPages}
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  className="p-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="หน้าถัดไป"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-100">
            <span>หมายเหตุ: รายการรับเข้า (+IN) แสดงราคาซื้อจริงตามเอกสารจัดซื้อ ส่วนรายการเบิกจ่าย (-OUT) แสดงมูลค่าต้นทุนเฉลี่ย ณ วันและเวลาที่ทำรายการ</span>
            <button
              onClick={onClose}
              className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-xs transition-all cursor-pointer"
            >
              ปิดหน้าต่าง
            </button>
          </div>

          {/* Note Details Modal / Popover */}
          {activeNoteModal && (
            <div
              className="fixed inset-0 z-[120] bg-slate-900/40 backdrop-blur-2xs flex items-center justify-center p-4 animate-fade-in"
              onClick={() => setActiveNoteModal(null)}
            >
              <div
                className="bg-white rounded-2xl p-5 max-w-md w-full shadow-2xl border border-slate-200 animate-zoom-in"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">หมายเหตุ / บันทึก</h4>
                      <div className="text-[11px] text-slate-400 font-mono">
                        เอกสาร: {activeNoteModal.docNo} • {activeNoteModal.date}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setActiveNoteModal(null)}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="py-3.5 my-3 text-xs sm:text-sm text-slate-700 leading-relaxed whitespace-pre-wrap break-words bg-slate-50 p-3 rounded-xl border border-slate-100 font-sans">
                  {activeNoteModal.note}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => setActiveNoteModal(null)}
                    className="px-4 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-xl transition-colors cursor-pointer"
                  >
                    ปิด
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </Portal>
  );
}
