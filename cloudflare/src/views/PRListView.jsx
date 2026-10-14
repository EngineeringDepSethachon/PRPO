import React, { useState, useMemo, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { workflowEngine } from '../services/workflowEngine';
import PRDetailsModal from '../components/pr/PRDetailsModal';
import EmptyState from '../components/common/EmptyState';
import Pagination from '../components/common/Pagination';
import { 
  ClipboardList, Plus, Search, Clock, 
  CheckCircle2, Building2, Tag, Pencil, 
  Calendar, ChevronDown, Eye, WalletCards 
} from 'lucide-react';
import { getUserDepartments, canAccessDepartmentData } from '../utils/permissions';
import { storageService } from '../services/storageService';
import { sortByNewestFirst } from '../utils/sortUtils';
const PR_TABS = [
  { id: 'ALL', label: 'ทั้งหมด', filter: () => true },
  { id: 'PENDING_REVIEW', label: 'รอตรวจสอบ (Asst. Mgr)', filter: pr => ['SUBMITTED', 'REJECTED_TO_L2'].includes(pr.status) },
  { id: 'PENDING_APPROVE', label: 'รออนุมัติ (Plant Mgr)', filter: pr => pr.status === 'REVIEWED' },
  { id: 'APPROVED', label: 'อนุมัติแล้ว / ออก PO', filter: pr => ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED'].includes(pr.status) },
  { id: 'DRAFT_RETURNED', label: 'ร่าง / ส่งกลับแก้ไข', filter: pr => ['DRAFT', 'REJECTED_TO_DRAFT'].includes(pr.status) },
  { id: 'REJECTED', label: 'ไม่อนุมัติ / ยกเลิก', filter: pr => ['REJECTED', 'CANCELLED'].includes(pr.status) },
];

const PERIOD_OPTIONS = [
  { id: 'current_month', label: 'เดือนปัจจุบัน (Default)', shortLabel: 'เดือนนี้' },
  { id: 'last_month', label: 'เดือนที่แล้ว', shortLabel: 'เดือนที่แล้ว' },
  { id: 'current_fiscal_year', label: 'ปีงบประมาณปัจจุบัน (2026)', shortLabel: 'ปี 2026' },
  { id: 'all', label: 'ทั้งหมด (All Time)', shortLabel: 'ทั้งหมด' },
];

const parseDocDate = (doc) => {
  if (!doc) return null;
  const raw = doc.requestedDate || doc.issueDate || doc.issuedDate || doc.createdAt || doc.date || doc.updatedAt;
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
const getShortPRStatus = (status) => {
  switch (status) {
    case 'DRAFT':
      return { label: 'ฉบับร่าง', color: 'bg-slate-100 text-slate-700 border-slate-200' };
    case 'SUBMITTED':
      return { label: 'รอตรวจทาน', color: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'REVIEWED':
      return { label: 'รออนุมัติ', color: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'APPROVED':
      return { label: 'อนุมัติแล้ว', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'PO_ISSUED':
      return { label: 'ออก PO แล้ว', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
    case 'IN_PROGRESS_ONLINE':
      return { label: 'รอสั่ง Online', color: 'bg-violet-50 text-violet-700 border-violet-200' };
    case 'REJECTED_TO_DRAFT':
    case 'REJECTED_TO_L2':
      return { label: 'ส่งกลับแก้ไข', color: 'bg-orange-50 text-orange-700 border-orange-200' };
    case 'REJECTED':
      return { label: 'ไม่อนุมัติ', color: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'CANCELLED':
      return { label: 'ยกเลิก', color: 'bg-slate-100 text-slate-500 border-slate-200' };
    case 'CLOSED':
      return { label: 'เสร็จสิ้น', color: 'bg-teal-50 text-teal-700 border-teal-200' };
    default:
      return { label: status || 'ไม่ระบุ', color: 'bg-slate-100 text-slate-700 border-slate-200' };
  }
};

export default function PRListView({ 
  prs: propPrs, 
  departments: propDepartments,
  currentRole: propRole, 
  onRefresh: propRefresh, 
  onNavigate: propNavigate, 
  onEditPR: propEditPR 
} = {}) {
  const context = useAppContext();
  const prs = propPrs ?? context.prs ?? EMPTY_ARRAY;
  const rawDepartments = propDepartments ?? context.departments ?? EMPTY_ARRAY;
  const currentRole = propRole ?? context.currentRole;
  const onRefresh = propRefresh ?? context.refreshData;
  const onNavigate = propNavigate ?? context.onNavigate;
  const onEditPR = propEditPR ?? context.handleEditPR;

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

  const [selectedPR, setSelectedPR] = useState(null);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [selectedPeriod, setSelectedPeriod] = useState('current_month');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Sync department filter whenever user switches role via Fast Switcher
  useEffect(() => {
    setDeptFilter('ALL');
  }, [currentRole?.id, currentRole?.username, currentRole?.department]);

  // Auto-reset page when filter, period or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterStatus, deptFilter, selectedPeriod, searchQuery, pageSize]);

  // Non-blocking guard: Do NOT trigger full-blocking re-fetch if PRs already exist in state
  useEffect(() => {
    if (!prs || prs.length === 0) {
      if (typeof onRefresh === 'function') {
        onRefresh(true);
      }
    }
  }, []);

  // Department-based access check
  const accessiblePRs = useMemo(() => {
    return (prs || []).filter(pr => {
      return canAccessDepartmentData(currentRole, pr.department);
    });
  }, [prs, currentRole]);

  // Scoped PRs by Department and Period
  const scopedPRs = useMemo(() => {
    return accessiblePRs.filter(pr => {
      const matchesDept = deptFilter === 'ALL' || pr.department?.toUpperCase() === deptFilter.toUpperCase();
      const matchesTime = matchesPeriod(pr, selectedPeriod);
      return matchesDept && matchesTime;
    });
  }, [accessiblePRs, deptFilter, selectedPeriod]);

  // Combined Search & Filter Logic for Table
  const filteredPRs = useMemo(() => {
    const activeTab = PR_TABS.find(t => t.id === filterStatus) || PR_TABS[0];
    const filtered = scopedPRs.filter(pr => {
      // Status filter via active tab logic
      const matchesStatus = activeTab.filter(pr);

      // Search Query
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch = !q || (
        pr.prNo?.toLowerCase().includes(q) ||
        pr.requestedBy?.toLowerCase().includes(q) ||
        pr.department?.toLowerCase().includes(q) ||
        pr.note?.toLowerCase().includes(q) ||
        pr.items?.some(item => item.name?.toLowerCase().includes(q) || item.code?.toLowerCase().includes(q))
      );

      return matchesStatus && matchesSearch;
    });

    return filtered.sort(sortByNewestFirst);
  }, [scopedPRs, filterStatus, searchQuery]);

  // Tab Badge Counters (scoped to period & dept)
  const tabCounts = useMemo(() => {
    const counts = {};
    PR_TABS.forEach(tab => {
      counts[tab.id] = scopedPRs.filter(pr => tab.filter(pr)).length;
    });
    return counts;
  }, [scopedPRs]);

  // Calculated Metrics for Filtered Result Scoped to Period
  const metrics = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const baseDocs = q 
      ? scopedPRs.filter(pr => 
          pr.prNo?.toLowerCase().includes(q) ||
          pr.requestedBy?.toLowerCase().includes(q) ||
          pr.department?.toLowerCase().includes(q) ||
          pr.note?.toLowerCase().includes(q) ||
          pr.items?.some(item => item.name?.toLowerCase().includes(q) || item.code?.toLowerCase().includes(q))
        )
      : scopedPRs;

    const totalCount = baseDocs.length;
    const totalAmount = baseDocs.reduce((sum, pr) => sum + (pr.totalAmount || 0), 0);
    const pendingPRs = baseDocs.filter(pr => ['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2'].includes(pr.status));
    const pendingCount = pendingPRs.length;
    const pendingAmount = pendingPRs.reduce((sum, pr) => sum + (pr.totalAmount || 0), 0);
    const approvedCount = baseDocs.filter(pr => ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED'].includes(pr.status)).length;

    return { totalCount, totalAmount, pendingCount, pendingAmount, approvedCount };
  }, [scopedPRs, searchQuery]);

  const periodLabel = PERIOD_OPTIONS.find(p => p.id === selectedPeriod)?.shortLabel || 'เดือนนี้';

  // Pagination slicing
  const totalPages = Math.ceil(filteredPRs.length / pageSize) || 1;
  const paginatedPRs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredPRs.slice(start, start + pageSize);
  }, [filteredPRs, currentPage, pageSize]);

  return (
    <div className="w-full space-y-5 animate-fade-in pb-10">
      
      {/* ── 1. Header & Main Action ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shadow-2xs shrink-0">
            <ClipboardList className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight leading-tight">
              รายการใบขอซื้อ (Purchase Requisitions)
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 font-normal mt-0.5">
              จัดการ ติดตามสถานะ และอนุมัติใบขอซื้อวัตถุดิบและอุปกรณ์
            </p>
          </div>
        </div>

        {currentRole?.canCreatePR && (
          <button 
            onClick={() => onNavigate('pr-create')}
            className="h-10 px-4 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-sm font-semibold rounded-xl shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer shrink-0"
          >
            <Plus className="w-4 h-4" strokeWidth={2} />
            <span>สร้างใบ PR ใหม่</span>
          </button>
        )}
      </div>

      {/* ── 2. Unified 3-Card KPI Metrics Strip (~84px) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Total Amount */}
        <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block truncate">
              ยอดรวม PR ({periodLabel})
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
              {metrics.totalCount} ใบ
            </span>
          </div>
        </div>

        {/* Card 2: Pending Approval */}
        <div className="p-4 rounded-2xl bg-white border border-amber-200/80 bg-linear-to-br from-white to-amber-50/30 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-amber-700 uppercase tracking-wider block truncate">
              รออนุมัติ ({periodLabel})
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
              <Clock className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <span className="text-xs font-mono font-bold text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded-md border border-amber-200/60">
              ฿{metrics.pendingAmount.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Card 3: Approved */}
        <div className="p-4 rounded-2xl bg-white border border-emerald-200/80 bg-linear-to-br from-white to-emerald-50/30 shadow-xs flex items-center justify-between min-h-[84px]">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-emerald-700 uppercase tracking-wider block truncate">
              อนุมัติแล้ว / ออก PO ({periodLabel})
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-black font-mono text-emerald-600 tracking-tight tabular-nums">
                {metrics.approvedCount}
              </span>
              <span className="text-xs font-semibold text-emerald-700/80">รายการ</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0 ml-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200/70 flex items-center justify-center shadow-2xs">
              <CheckCircle2 className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <span className="text-xs font-bold text-emerald-700 bg-emerald-100/70 px-2.5 py-0.5 rounded-md border border-emerald-200/60">
              ผ่านอนุมัติ
            </span>
          </div>
        </div>
      </div>

      {/* ── 3. Synchronized Controls Toolbar (2 Rows) ── */}
      <div className="space-y-3">
        {/* แถวบน (Filter Tabs) */}
        <div className="w-full overflow-x-auto custom-scrollbar pb-0.5">
          <div className="inline-flex items-center gap-1 bg-slate-100/90 p-1 rounded-2xl max-w-full shrink-0">
            {PR_TABS.map(tab => {
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
              placeholder="ค้นหาเลข PR, ผู้ขอ, แผนก, สินค้า..."
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
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-indigo-600">
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

      {/* ── 4. Comfortable PR Table Card ── */}
      <div className="w-full bg-white rounded-2xl border border-slate-200/80 shadow-xs flex flex-col justify-between min-h-[480px] overflow-hidden">
        {/* 1. ส่วนเนื้อหาตาราง (ขยายเต็มพื้นที่ด้านบน) */}
        <div className="flex-1 overflow-x-auto">
          <table className="w-full min-w-[880px] text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200/80">
                <th className="w-36 px-4 py-3">เลขที่เอกสาร</th>
                <th className="w-44 px-4 py-3">ผู้ขอ / หน่วยงาน</th>
                <th className="min-w-[220px] px-4 py-3">รายการสินค้า</th>
                <th className="w-28 px-2 py-3 text-center">ช่องทาง</th>
                <th className="w-36 px-3 py-3 text-right">ยอดรวมสุทธิ</th>
                <th className="w-32 px-2 py-3 text-center">สถานะ</th>
                <th className="w-32 min-w-[120px] px-4 py-3.5 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredPRs.length === 0 ? (
                <tr>
                  <td colSpan="7" className="p-0">
                    <EmptyState 
                      title="ไม่พบข้อมูลใบ PR" 
                      description="ลองเปลี่ยนตัวกรอง ค้นหาด้วยคำอื่น หรือกดล้างการค้นหา"
                    />
                  </td>
                </tr>
              ) : (
                paginatedPRs.map(pr => {
                  const canAction = workflowEngine.canAction(currentRole, pr);
                  const statusConf = getShortPRStatus(pr.status);
                  const itemsList = pr.items || [];
                  const isEditable = (pr.status === 'DRAFT' || pr.status === 'REJECTED_TO_DRAFT') && 
                    (currentRole?.id === 'ADMIN' || currentRole?.canCreatePR || workflowEngine.canAction(currentRole, pr));
                  const firstItemName = itemsList[0]?.name || itemsList[0]?.itemName || '-';
                  
                  return (
                    <tr key={pr.id} className="group hover:bg-slate-50/70 transition-colors">
                      {/* เลขที่เอกสาร: w-36 font-mono font-bold text-slate-900 */}
                      <td className="w-36 px-4 py-3.5 align-middle">
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="text-sm font-bold font-mono text-slate-900 tracking-tight">{pr.prNo}</span>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                            <span className="text-xs text-slate-400 font-mono">{pr.requestedDate}</span>
                            {pr.memo && (
                              <span className="inline-flex items-center gap-0.5 bg-amber-50 text-amber-700 border border-amber-200/80 text-[10px] font-bold px-1.5 py-0.2 rounded-full whitespace-nowrap" title="มี MEMO แนบ">
                                <Tag size={10} /> MEMO
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* ผู้ขอ / หน่วยงาน: w-44 */}
                      <td className="w-44 px-4 py-3.5 align-middle">
                        <div className="text-sm font-semibold text-slate-800 truncate" title={pr.requestedBy}>
                          {pr.requestedBy}
                        </div>
                        <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5 truncate">
                          <Building2 size={12} className="text-slate-400 shrink-0" />
                          <span className="truncate">ฝ่าย {pr.department}</span>
                        </div>
                      </td>

                      {/* รายการสินค้า: flex-1 / min-w-[220px] */}
                      <td className="min-w-[220px] px-4 py-3.5 align-middle">
                        <div className="min-w-0 max-w-full">
                          <div className="text-sm text-slate-700 font-medium truncate block max-w-full" title={itemsList.map(i => i?.name || '').filter(Boolean).join(', ')}>
                            {firstItemName}
                          </div>
                          <div className="text-xs text-slate-400 font-mono mt-0.5">
                            ({itemsList.length} รายการ)
                          </div>
                        </div>
                      </td>

                      {/* ช่องทาง: w-28 text-center */}
                      <td className="w-28 px-2 py-3.5 text-center align-middle whitespace-nowrap">
                        {(pr.purchaseChannel === 'ONLINE' || pr.purchaseChannel === 'ONLINE_PURCHASE' || (Array.isArray(pr.items) && pr.items.some(item => !!(item.productUrl || item.onlineUrl || item.url)))) ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200/60 whitespace-nowrap">
                            🛒 ออนไลน์
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200/60 whitespace-nowrap">
                            🏢 ภายใน
                          </span>
                        )}
                      </td>

                      {/* ยอดรวมสุทธิ: w-36 text-right font-mono font-bold text-slate-900 */}
                      <td className="w-36 px-3 py-3.5 text-right align-middle whitespace-nowrap font-mono font-bold text-slate-900 text-sm sm:text-base tabular-nums">
                        ฿{(pr.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* สถานะ: w-32 text-center */}
                      <td className="w-32 px-2 py-3.5 text-center align-middle whitespace-nowrap">
                        <span className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border shadow-2xs ${statusConf.color}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80 shrink-0"></span>
                          <span className="truncate">{statusConf.label}</span>
                        </span>
                      </td>

                      {/* จัดการ: w-32 min-w-[120px] text-center px-4 py-3.5 */}
                      <td className="w-32 min-w-[120px] px-4 py-3.5 text-center align-middle whitespace-nowrap">
                        {isEditable && onEditPR ? (
                          <button
                            type="button"
                            onClick={() => onEditPR(pr)}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-700 text-xs font-semibold shadow-2xs transition-all whitespace-nowrap cursor-pointer"
                            title="แก้ไขใบ PR"
                          >
                            <Pencil className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span>แก้ไข</span>
                          </button>
                        ) : (
                          <button 
                            type="button"
                            onClick={() => setSelectedPR(pr)}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-700 text-xs font-semibold shadow-2xs transition-all whitespace-nowrap cursor-pointer"
                            title={canAction ? 'ดำเนินการอนุมัติ / ตรวจสอบ' : 'ดูรายละเอียดใบ PR'}
                          >
                            <Eye className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span>ดูข้อมูล</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 2. แถบ Pagination ตรึงไว้ด้านล่างสุดเสมอ */}
        <div className="border-t border-slate-100 bg-slate-50/60 px-6 py-3.5 flex items-center justify-between mt-auto">
          <div className="w-full">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filteredPRs.length}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        </div>
      </div>

      {/* PR DETAIL MODAL */}
      {selectedPR && (
        <PRDetailsModal 
          selectedPR={selectedPR}
          currentRole={currentRole}
          onClose={() => setSelectedPR(null)}
          onRefresh={onRefresh}
          onEditPR={onEditPR}
        />
      )}
    </div>
  );
}
