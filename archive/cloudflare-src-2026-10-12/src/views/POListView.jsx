import React, { useState, useMemo, useEffect } from 'react';
import { 
  ShoppingBag, Search, Truck, 
  Building2, Store, Calendar, ChevronDown, 
  Eye, WalletCards, CheckCircle2 
} from 'lucide-react';
import PODetailsModal from '../components/po/PODetailsModal';
import EmptyState from '../components/common/EmptyState';
import Pagination from '../components/common/Pagination';
import { getUserDepartments, canAccessDepartmentData } from '../utils/permissions';
import { useAppContext } from '../context/AppContext';
import { storageService } from '../services/storageService';
import { sortByNewestFirst } from '../utils/sortUtils';
const PO_TABS = [
  { id: 'ALL', label: 'ทั้งหมด' },
  { id: 'PENDING', label: 'รอรับของ (ซื้อเอง)' },
  { id: 'IN_PROGRESS_ONLINE', label: 'รอดำเนินการ Online' },
  { id: 'CLOSED', label: 'ปิดงานแล้ว' },
  { id: 'CANCELLED', label: 'ยกเลิกแล้ว' }
];

const PERIOD_OPTIONS = [
  { id: 'current_month', label: 'เดือนปัจจุบัน (Default)', shortLabel: 'เดือนนี้' },
  { id: 'last_month', label: 'เดือนที่แล้ว', shortLabel: 'เดือนที่แล้ว' },
  { id: 'current_fiscal_year', label: 'ปีงบประมาณปัจจุบัน (2026)', shortLabel: 'ปี 2026' },
  { id: 'all', label: 'ทั้งหมด (All Time)', shortLabel: 'ทั้งหมด' },
];

const parseDocDate = (doc) => {
  if (!doc) return null;
  const raw = doc.issueDate || doc.issuedDate || doc.createdAt || doc.date || doc.requestedDate || doc.updatedAt;
  if (!raw) return null;

  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // Thai slash format: DD/MM/YYYY or DD/MM/BBBB
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      const day = parseInt(slashMatch[1], 10);
      const month = parseInt(slashMatch[2], 10) - 1;
      let year = parseInt(slashMatch[3], 10);
      if (year > 2400) year -= 543;
      return new Date(year, month, day);
    }

    // ISO format: YYYY-MM-DD
    const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      let year = parseInt(isoMatch[1], 10);
      if (year > 2400) year -= 543;
      const month = parseInt(isoMatch[2], 10) - 1;
      const day = parseInt(isoMatch[3], 10);
      return new Date(year, month, day);
    }

    // Standard Date.parse fallback
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      let yr = parsed.getFullYear();
      if (yr > 2400) yr -= 543;
      return new Date(yr, parsed.getMonth(), parsed.getDate());
    }
  }

  return null;
};

const matchesPeriod = (doc, period) => {
  if (period === 'all') return true;

  const docDate = parseDocDate(doc);
  // If no date found on document, include in current_month and all so unsaved items aren't lost
  if (!docDate) return period === 'current_month' || period === 'all';

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();

  const docYear = docDate.getFullYear();
  const docMonth = docDate.getMonth();

  if (period === 'current_month') {
    return docYear === curYear && docMonth === curMonth;
  }

  if (period === 'last_month') {
    const lastMonthYear = curMonth === 0 ? curYear - 1 : curYear;
    const lastMonth = curMonth === 0 ? 11 : curMonth - 1;
    return docYear === lastMonthYear && docMonth === lastMonth;
  }

  if (period === 'current_fiscal_year') {
    // Current Fiscal Year 2026: 1 Oct 2025 to 30 Sep 2026, or calendar year 2026
    const fyStart = new Date(2025, 9, 1);
    const fyEnd = new Date(2026, 8, 30, 23, 59, 59, 999);
    return (docDate >= fyStart && docDate <= fyEnd) || docYear === 2026;
  }

  return true;
};

const EMPTY_ARRAY = [];

// Clean Short Status Labels (No English in parentheses, compact for tables)
const getShortPOStatus = (status) => {
  switch (status) {
    case 'ISSUED':
      return { label: 'รอรับของ', color: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'IN_DELIVERY':
      return { label: 'กำลังจัดส่ง', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
    case 'IN_PROGRESS_ONLINE':
      return { label: 'รอสั่ง Online', color: 'bg-violet-50 text-violet-700 border-violet-200' };
    case 'ORDERED':
    case 'ORDERED_PENDING_DELIVERY':
      return { label: 'รอจัดส่ง', color: 'bg-purple-50 text-purple-700 border-purple-200' };
    case 'PARTIAL':
      return { label: 'รับบางส่วน', color: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'RECEIVED':
      return { label: 'ตรวจรับแล้ว', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'CANCELLED':
      return { label: 'ยกเลิก', color: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'CLOSED':
      return { label: 'เสร็จสิ้น', color: 'bg-teal-50 text-teal-700 border-teal-200' };
    case 'CLAIM_REPORTED':
      return { label: 'แจ้งเคลม', color: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'CLAIM_IN_PROGRESS':
      return { label: 'กำลังเคลม', color: 'bg-amber-50 text-amber-700 border-amber-200' };
    default:
      return { label: status || 'ไม่ระบุ', color: 'bg-slate-100 text-slate-700 border-slate-200' };
  }
};

export default function POListView({ pos = EMPTY_ARRAY, departments: propDepartments, currentRole, onRefresh }) {
  let context = null;
  try {
    context = useAppContext();
  } catch {}
  const rawDepartments = propDepartments ?? context?.departments ?? EMPTY_ARRAY;
  const currentUser = context?.currentUser;
  const rawRole = typeof currentUser?.role === 'object' 
    ? (currentUser?.role?.id || currentUser?.role?.name || '') 
    : (currentUser?.role || currentRole?.roleId || currentRole?.id || currentRole?.name || '');
  const role = String(rawRole).toLowerCase();

  const _isOperational = ['requester', 'asst_mgr', 'supervisor'].some(r => role.includes(r));
  const _isPlantManager = role.includes('plant_mgr') || role.includes('plant manager');
  const _isPurchaser = role.includes('purchaser');

  // Dynamic Departments from Master Data
  const deptList = useMemo(() => {
    const list = (rawDepartments && rawDepartments.length > 0) ? rawDepartments : (storageService.getDepartments?.() || []);
    return (list || []).filter(d => d.isActive !== false);
  }, [rawDepartments]);

  const userDepts = getUserDepartments(currentRole);
  const canSeeAll = Boolean(
    currentRole?.canViewAllDepts ||
    currentRole?.id === 'ADMIN' ||
    currentRole?.roleId === 'ADMIN' ||
    currentRole?.role === 'admin' ||
    Number(currentRole?.level) >= 99 ||
    userDepts.includes('ALL') ||
    userDepts.includes('*')
  );

  const visibleFilterDepts = useMemo(() => {
    if (canSeeAll) return deptList;
    return deptList.filter(d => userDepts.some(ud => ud.toUpperCase() === d.code?.toUpperCase()));
  }, [deptList, canSeeAll, userDepts]);

  const hasMultipleDepts = canSeeAll || visibleFilterDepts.length > 1;

  const [selectedPO, setSelectedPO] = useState(null);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [selectedPeriod, setSelectedPeriod] = useState('current_month');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const handleViewPODetails = (po) => setSelectedPO(po);

  // Sync department filter whenever user switches role via Fast Switcher
  useEffect(() => {
    setDeptFilter('ALL');
  }, [currentRole?.id, currentRole?.username, currentRole?.department]);

  // Auto-reset page when filter, period or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterStatus, deptFilter, selectedPeriod, searchQuery, pageSize]);

  const isPendingReceipt = (status) => ['ISSUED', 'PARTIAL'].includes(status);
  const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER';

  // Department-based and Role-based access check
  const accessiblePOs = useMemo(() => {
    return pos.filter(po => {
      if (isOnlinePurchaser) return po.purchaseChannel === 'ONLINE';
      return canAccessDepartmentData(currentRole, po.department);
    });
  }, [pos, currentRole, isOnlinePurchaser]);

  // Scoped POs by Department and Period
  const scopedPOs = useMemo(() => {
    return accessiblePOs.filter(po => {
      const matchesDept = deptFilter === 'ALL' || po.department?.toUpperCase() === deptFilter.toUpperCase();
      const matchesTime = matchesPeriod(po, selectedPeriod);
      return matchesDept && matchesTime;
    });
  }, [accessiblePOs, deptFilter, selectedPeriod]);

  // Search & Filter Logic for Table
  const filteredPOs = useMemo(() => {
    const filtered = scopedPOs.filter(po => {
      // Hide cancelled by default unless filter is ALL or CANCELLED
      if (po.status === 'CANCELLED' && filterStatus !== 'ALL' && filterStatus !== 'CANCELLED') return false; 

      // Status filter
      let matchesStatus = true;
      if (filterStatus === 'PENDING') matchesStatus = isPendingReceipt(po.status);
      else if (filterStatus === 'RECEIVED' || filterStatus === 'CLOSED') matchesStatus = ['RECEIVED', 'CLOSED'].includes(po.status);
      else if (filterStatus === 'IN_PROGRESS_ONLINE') matchesStatus = po.status === 'IN_PROGRESS_ONLINE';
      else if (filterStatus === 'CANCELLED') matchesStatus = po.status === 'CANCELLED';

      // Search Query
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch = !q || (
        po.poNo?.toLowerCase().includes(q) ||
        po.vendorName?.toLowerCase().includes(q) ||
        po.prNo?.toLowerCase().includes(q) ||
        po.department?.toLowerCase().includes(q) ||
        po.items?.some(item => item.name?.toLowerCase().includes(q) || item.code?.toLowerCase().includes(q))
      );

      return matchesStatus && matchesSearch;
    });

    return filtered.sort(sortByNewestFirst);
  }, [scopedPOs, filterStatus, searchQuery]);

  // Tab Badge Counters (scoped to period & dept)
  const tabCounts = useMemo(() => {
    return {
      ALL: scopedPOs.filter(po => po.status !== 'CANCELLED').length,
      PENDING: scopedPOs.filter(po => isPendingReceipt(po.status)).length,
      IN_PROGRESS_ONLINE: scopedPOs.filter(po => po.status === 'IN_PROGRESS_ONLINE').length,
      CLOSED: scopedPOs.filter(po => ['RECEIVED', 'CLOSED'].includes(po.status)).length,
      CANCELLED: scopedPOs.filter(po => po.status === 'CANCELLED').length,
    };
  }, [scopedPOs]);

  // Calculated Metrics for Selected Period (3 Unified KPI Boxes)
  const metrics = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const baseDocs = q
      ? scopedPOs.filter(po => 
          po.poNo?.toLowerCase().includes(q) ||
          po.vendorName?.toLowerCase().includes(q) ||
          po.prNo?.toLowerCase().includes(q) ||
          po.department?.toLowerCase().includes(q) ||
          po.items?.some(item => item.name?.toLowerCase().includes(q) || item.code?.toLowerCase().includes(q))
        )
      : scopedPOs;

    const activeBase = baseDocs.filter(po => po.status !== 'CANCELLED');
    const totalCount = activeBase.length;
    const totalAmount = activeBase.reduce((sum, po) => sum + (po.grandTotal || po.subtotal || 0), 0);
    
    const pendingPOs = activeBase.filter(po => isPendingReceipt(po.status) || po.status === 'IN_PROGRESS_ONLINE');
    const pendingCount = pendingPOs.length;
    const pendingAmount = pendingPOs.reduce((sum, po) => sum + (po.grandTotal || po.subtotal || 0), 0);

    const completedPOs = activeBase.filter(po => ['RECEIVED', 'CLOSED'].includes(po.status));
    const completedCount = completedPOs.length;
    const completedAmount = completedPOs.reduce((sum, po) => sum + (po.grandTotal || po.subtotal || 0), 0);

    return { totalCount, totalAmount, pendingCount, pendingAmount, completedCount, completedAmount };
  }, [scopedPOs, searchQuery]);

  const periodLabel = PERIOD_OPTIONS.find(p => p.id === selectedPeriod)?.shortLabel || 'เดือนนี้';

  // Pagination slicing
  const totalPages = Math.ceil(filteredPOs.length / pageSize) || 1;
  const paginatedPOs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredPOs.slice(start, start + pageSize);
  }, [filteredPOs, currentPage, pageSize]);

  return (
    <div className="w-full space-y-5 animate-fade-in pb-10">
      {/* ── 1. Header & Main Action ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shadow-2xs border shrink-0 ${
            isOnlinePurchaser ? 'bg-purple-50 text-purple-600 border-purple-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'
          }`}>
            <ShoppingBag className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight leading-tight">
              {isOnlinePurchaser ? 'ประวัติใบสั่งซื้อออนไลน์ (Online Purchase Orders)' : 'รายการใบสั่งซื้อ (Purchase Orders)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 font-normal mt-0.5">
              {isOnlinePurchaser 
                ? 'ประวัติและสถานะใบสั่งซื้อออนไลน์ทั้งหมด (Shopee / Lazada / ร้านค้าออนไลน์)' 
                : 'ติดตามและจัดการใบสั่งซื้อ ตรวจรับสินค้าเข้าคลัง และบันทึกประวัติการส่งมอบ'}
            </p>
          </div>
        </div>
      </div>

      {/* ── 2. Unified 3-Card KPI Metrics Strip (~84px) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Total Volume */}
        <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block truncate">
              ยอดสั่งซื้อ ({periodLabel})
            </span>
            <div className="text-2xl font-black font-mono text-slate-900 tracking-tight mt-1 tabular-nums truncate">
              ฿{metrics.totalAmount.toLocaleString()}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0 ml-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs">
              <WalletCards className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <span className="text-xs font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200/60">
              {metrics.totalCount} ฉบับ
            </span>
          </div>
        </div>

        {/* Card 2: Pending Receipt */}
        <div className="p-4 rounded-2xl bg-white border border-amber-200/80 bg-linear-to-br from-white to-amber-50/30 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-amber-700 uppercase tracking-wider block truncate">
              รอตรวจรับของ ({periodLabel})
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-black font-mono text-amber-600 tracking-tight tabular-nums">
                {metrics.pendingCount}
              </span>
              <span className="text-xs font-semibold text-amber-700/80">รายการ</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0 ml-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 border border-amber-200/70 flex items-center justify-center shadow-2xs">
              <Truck className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <span className="text-xs font-mono font-bold text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded-md border border-amber-200/60">
              ฿{metrics.pendingAmount.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Card 3: Completed */}
        <div className="p-4 rounded-2xl bg-white border border-emerald-200/80 bg-linear-to-br from-white to-emerald-50/30 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-emerald-700 uppercase tracking-wider block truncate">
              ตรวจรับครบ / ปิดงาน ({periodLabel})
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-black font-mono text-emerald-600 tracking-tight tabular-nums">
                {metrics.completedCount}
              </span>
              <span className="text-xs font-semibold text-emerald-700/80">รายการ</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0 ml-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200/70 flex items-center justify-center shadow-2xs">
              <CheckCircle2 className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <span className="text-xs font-bold text-emerald-700 bg-emerald-100/70 px-2.5 py-0.5 rounded-md border border-emerald-200/60">
              ตรวจรับครบ
            </span>
          </div>
        </div>
      </div>

      {/* ── 3. Synchronized Controls Toolbar (2 Rows) ── */}
      <div className="space-y-3">
        {/* แถวบน (Filter Tabs) */}
        <div className="w-full overflow-x-auto custom-scrollbar pb-0.5">
          <div className="inline-flex items-center gap-1 bg-slate-100/90 p-1 rounded-2xl max-w-full shrink-0">
            {PO_TABS.map(tab => {
              const isSelected = filterStatus === tab.id;
              const count = tabCounts[tab.id] || 0;
              return (
                <button 
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterStatus(tab.id)}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                    isSelected 
                      ? 'bg-slate-900 text-white shadow-xs' 
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                  }`}
                >
                  <span>{tab.label}</span>
                  {count > 0 && (
                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold transition-colors ${
                      isSelected 
                        ? 'bg-white/20 text-white' 
                        : 'bg-slate-200 text-slate-700'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* แถวล่าง (Search & Date Range) */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          {/* ฝั่งซ้าย: กล่อง Search Input ขยายใหญ่ขึ้น h-10 */}
          <div className="relative w-full max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="ค้นหาเลข PO, ผู้ขาย, PR, สินค้า..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-10 text-sm pl-10 pr-10 rounded-xl border border-slate-200 bg-white w-full text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
            />
            {searchQuery ? (
              <button 
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 font-bold text-xs cursor-pointer"
              >
                ✕
              </button>
            ) : (
              <span className="hidden sm:inline absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-mono bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200 pointer-events-none">
                /
              </span>
            )}
          </div>

          {/* ฝั่งขวา: Dropdown ปฏิทินเลือกเดือน & แผนก */}
          <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-auto">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-emerald-600">
                <Calendar size={15} strokeWidth={1.75} />
              </div>
              <select
                value={selectedPeriod}
                onChange={e => setSelectedPeriod(e.target.value)}
                className="h-10 text-sm pl-9 pr-8 rounded-xl border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer appearance-none shadow-2xs"
              >
                {PERIOD_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none text-slate-400">
                <ChevronDown size={15} />
              </div>
            </div>

            {hasMultipleDepts && (
              <div className="relative">
                <select
                  value={deptFilter}
                  onChange={e => setDeptFilter(e.target.value)}
                  className="h-10 text-sm px-3.5 rounded-xl border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer shadow-2xs"
                >
                  <option value="ALL">
                    {canSeeAll ? 'ทุกแผนก (All Depts)' : (visibleFilterDepts.length > 1 ? `ทุกแผนก (${visibleFilterDepts.map(d => d.code).join(', ')})` : 'ทุกแผนก')}
                  </option>
                  {visibleFilterDepts.map(d => (
                    <option key={d.code} value={d.code}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 4. Comfortable PO Table Card ── */}
      <div className="w-full bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="w-full overflow-x-auto scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
          <table className="w-full min-w-[980px] text-left border-collapse">
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[22%]" />
              <col className="w-[20%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
              <col className="w-[10%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr className="bg-slate-50/75 border-b border-slate-200/80 text-xs font-semibold text-slate-600">
                <th className="w-[16%] min-w-[140px] pl-6 pr-4 py-3 text-left">เลขที่เอกสาร</th>
                <th className="w-[22%] min-w-[190px] px-4 py-3 text-left">ร้านค้า / ผู้ขาย</th>
                <th className="w-[20%] min-w-[170px] px-4 py-3 text-left">รายการสินค้า</th>
                <th className="w-[10%] min-w-[95px] px-3 py-3 text-center">ช่องทาง</th>
                <th className="w-[14%] min-w-[120px] px-4 py-3 text-right">ยอดรวมสุทธิ</th>
                <th className="w-[10%] min-w-[105px] px-3 py-3 text-center">สถานะ</th>
                <th className="w-[12%] min-w-[120px] pl-3 pr-6 py-3 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredPOs.length === 0 ? (
                <tr>
                  <td colSpan="7" className="p-0">
                    <EmptyState 
                      title="ไม่พบข้อมูลใบ PO" 
                      description="ลองเปลี่ยนตัวกรอง ค้นหาด้วยคำอื่น หรือกดล้างการค้นหา"
                    />
                  </td>
                </tr>
              ) : (
                paginatedPOs.map(po => {
                  const statusConf = getShortPOStatus(po.status);
                  const itemsList = po.items || [];
                  const firstItemName = itemsList[0]?.name || itemsList[0]?.itemName || '-';

                  return (
                    <tr key={po.id} className="group hover:bg-slate-50/60 transition-colors duration-100 border-b border-slate-100 last:border-b-0">
                      {/* Col 1: เลขที่เอกสาร */}
                      <td className="w-[16%] min-w-[140px] pl-6 pr-4 py-3.5 align-middle text-left">
                        <div className="flex flex-col items-start">
                          <span className="text-sm font-bold font-mono text-slate-900 tracking-tight">
                            {po.poNo}
                          </span>
                          <div className="text-xs text-slate-400 mt-0.5 truncate font-mono">
                            PR: {po.prNo || '-'}
                          </div>
                        </div>
                      </td>

                      {/* Col 2: ร้านค้า / ผู้ขาย */}
                      <td className="w-[22%] min-w-[190px] px-4 py-3.5 align-middle text-left min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate flex items-center gap-1.5" title={po.vendorName || (po.purchaseChannel === 'ONLINE' ? 'สั่งซื้อออนไลน์ (Shopee/Lazada)' : 'ยังไม่ระบุ')}>
                          {po.purchaseChannel === 'ONLINE' ? (
                            <Store className="w-4 h-4 text-purple-600 shrink-0" />
                          ) : (
                            <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="truncate">{po.vendorName || (po.purchaseChannel === 'ONLINE' ? 'สั่งซื้อออนไลน์' : 'ยังไม่ระบุ')}</span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1 truncate">
                          <Building2 size={12} className="text-slate-400 shrink-0" />
                          <span className="truncate">ฝ่าย {po.department}</span>
                        </div>
                      </td>

                      {/* Col 3: รายการสินค้า */}
                      <td className="w-[20%] min-w-[170px] px-4 py-3.5 align-middle text-left min-w-0">
                        <div className="min-w-0 max-w-full">
                          <div className="text-sm text-slate-700 font-medium truncate block max-w-full" title={itemsList.map(i => i?.name || '').filter(Boolean).join(', ')}>
                            {firstItemName}
                          </div>
                          <div className="text-xs text-slate-400 font-mono mt-0.5">
                            ({itemsList.length} รายการ)
                          </div>
                        </div>
                      </td>

                      {/* Col 4: ช่องทาง */}
                      <td className="w-[10%] min-w-[95px] px-3 py-3.5 text-center align-middle whitespace-nowrap">
                        {po.purchaseChannel === 'ONLINE' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200/60 whitespace-nowrap">
                            🛒 ออนไลน์
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200/60 whitespace-nowrap">
                            🏢 ภายใน
                          </span>
                        )}
                      </td>

                      {/* Col 5: ยอดรวมสุทธิ */}
                      <td className="w-[14%] min-w-[120px] px-4 py-3.5 text-right align-middle whitespace-nowrap font-mono font-bold text-slate-800 text-sm sm:text-base tabular-nums">
                        <div className="flex flex-col items-end">
                          <span>
                            ฿{(po.actualTotalAmount !== undefined && po.actualTotalAmount !== null && po.actualTotalAmount !== ''
                              ? Number(po.actualTotalAmount)
                              : (po.grandTotal || po.subtotal || 0)
                            ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          {po.settlementStatus === 'SETTLED' && (
                            <span className="text-[10px] text-emerald-700 font-sans font-bold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 mt-0.5">
                              {Number(po.savingsAmount) > 0 ? `ประหยัด ฿${Number(po.savingsAmount).toLocaleString()}` : 'ปิดยอดแล้ว'}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Col 6: สถานะ */}
                      <td className="w-[10%] min-w-[105px] px-3 py-3.5 text-center align-middle whitespace-nowrap">
                        <span className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border shadow-2xs ${statusConf.color}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80 shrink-0"></span>
                          <span className="truncate">{statusConf.label}</span>
                        </span>
                      </td>

                      {/* Col 7: จัดการ */}
                      <td className="w-[12%] min-w-[120px] pl-3 pr-6 py-3.5 text-right align-middle whitespace-nowrap">
                        <button 
                          type="button"
                          onClick={() => handleViewPODetails(po)}
                          className="inline-flex items-center justify-end gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg shadow-sm transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span>ดูรายละเอียด</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filteredPOs.length}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* PO DETAIL MODAL */}
      {selectedPO && (
        <PODetailsModal 
          selectedPO={selectedPO}
          currentRole={currentRole}
          onClose={() => setSelectedPO(null)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}
