import React, { useState, useEffect, useMemo } from 'react';
import { 
  ShieldCheck, Search, Filter, Download, RefreshCw, Clock, 
  Calendar, Eye, ArrowRight, ArrowUpRight, Copy, Check, 
  Trash2, FileText, CheckCircle2, XCircle, AlertCircle, 
  Layers, User, Tag, ChevronDown, X
} from 'lucide-react';
import { 
  getAuditLogs, 
  clearAuditLogs, 
  subscribeAuditLogs, 
  exportAuditLogsToCSV,
  seedInitialAuditLogs
} from '../../services/auditLogger';
import Pagination from '../../components/common/Pagination';
import { modalService } from '../../services/modalService';
import { clearMockTransactions, resetMockTransactions } from '../../utils/dataResetHelper';
import { formatLocalTimestamp } from '../../utils/timeUtils';

// Module configuration with localized labels and badge styles
const MODULE_CONFIG = {
  ALL: { label: 'ทั้งหมด', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  PURCHASE: { label: 'จัดซื้อ (PR/PO)', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  INVENTORY: { label: 'คลังสต็อก', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  MASTER: { label: 'ข้อมูลหลัก', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  RBAC: { label: 'ผู้ใช้/สิทธิ์', color: 'bg-rose-50 text-rose-700 border-rose-200' },
  BUDGET: { label: 'งบประมาณ', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  SYSTEM: { label: 'ระบบ', color: 'bg-slate-50 text-slate-600 border-slate-200' }
};

// Action badge styling according to exact design directives
const getActionBadgeClass = (action = '') => {
  const act = action.toUpperCase();
  if (act.includes('APPROVE') || act.includes('RECEIVE') || act.includes('FINAL')) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  }
  if (act.includes('REJECT') || act.includes('CANCEL') || act.includes('DELETE')) {
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }
  if (act.includes('UPDATE') || act.includes('EDIT') || act.includes('RESET')) {
    return 'bg-amber-50 text-amber-700 border-amber-200';
  }
  if (act.includes('CREATE') || act.includes('SUBMIT') || act.includes('NEW')) {
    return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  }
  return 'bg-slate-100 text-slate-700 border-slate-200';
};

const getActionIcon = (action = '') => {
  const act = action.toUpperCase();
  if (act.includes('APPROVE') || act.includes('RECEIVE')) return <CheckCircle2 className="w-3.5 h-3.5" />;
  if (act.includes('REJECT') || act.includes('CANCEL')) return <XCircle className="w-3.5 h-3.5" />;
  if (act.includes('UPDATE')) return <RefreshCw className="w-3.5 h-3.5" />;
  return <FileText className="w-3.5 h-3.5" />;
};

export default function AuditLogView({ currentRole, currentUser, onRefresh }) {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  // Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModule, setSelectedModule] = useState('ALL');
  const [selectedAction, setSelectedAction] = useState('ALL');
  const [timeRange, setTimeRange] = useState('ALL'); // ALL, TODAY, THIS_WEEK, THIS_MONTH, CUSTOM
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Visual Diff Modal State
  const [selectedDiffLog, setSelectedDiffLog] = useState(null);
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);

  // Load audit logs
  const loadLogs = () => {
    setIsLoading(true);
    try {
      const data = getAuditLogs();
      setLogs(data);
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Subscribe to real-time events
  useEffect(() => {
    loadLogs();
    const unsub = subscribeAuditLogs(() => {
      loadLogs();
    });
    return () => unsub();
  }, []);

  // Reset pagination on filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedModule, selectedAction, timeRange, customStartDate, customEndDate, pageSize]);

  // Date boundary calculation
  const dateBoundaries = useMemo(() => {
    const now = new Date();
    if (timeRange === 'TODAY') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { start, end: new Date() };
    }
    if (timeRange === 'THIS_WEEK') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
      const start = new Date(now.setDate(diff));
      start.setHours(0, 0, 0, 0);
      return { start, end: new Date() };
    }
    if (timeRange === 'THIS_MONTH') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end: new Date() };
    }
    if (timeRange === 'CUSTOM' && customStartDate) {
      const start = new Date(customStartDate);
      start.setHours(0, 0, 0, 0);
      const end = customEndDate ? new Date(customEndDate) : new Date();
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    return null;
  }, [timeRange, customStartDate, customEndDate]);

  // Filtered Logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. Module Filter
      if (selectedModule !== 'ALL' && log.module !== selectedModule) {
        return false;
      }

      // 2. Action Filter
      if (selectedAction !== 'ALL') {
        if (selectedAction === 'APPROVE' && !log.action.includes('APPROV')) return false;
        if (selectedAction === 'REJECT' && !log.action.includes('REJECT') && !log.action.includes('CANCEL')) return false;
        if (selectedAction === 'RECEIVE' && !log.action.includes('RECEIV') && !log.action.includes('ISSUE')) return false;
        if (selectedAction === 'UPDATE' && !log.action.includes('UPDATE') && !log.action.includes('EDIT')) return false;
        if (selectedAction === 'CREATE' && !log.action.includes('CREATE') && !log.action.includes('SUBMIT') && !log.action.includes('NEW')) return false;
      }

      // 3. Time Range Filter
      if (dateBoundaries) {
        const logDate = new Date(log.timestamp);
        if (logDate < dateBoundaries.start || logDate > dateBoundaries.end) {
          return false;
        }
      }

      // 4. Global Search Filter
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchRef = (log.targetRef || '').toLowerCase().includes(q);
        const matchActor = (log.actor?.name || '').toLowerCase().includes(q) || 
                           (log.actor?.id || '').toLowerCase().includes(q) ||
                           (log.actor?.role || '').toLowerCase().includes(q) ||
                           (log.actor?.department || '').toLowerCase().includes(q);
        const matchSummary = (log.summary || '').toLowerCase().includes(q);
        const matchAction = (log.action || '').toLowerCase().includes(q);
        const matchModule = (log.module || '').toLowerCase().includes(q);
        const matchTime = (formatLocalTimestamp(log.timestamp || log.createdAt || log.timeFormatted)).toLowerCase().includes(q);

        if (!matchRef && !matchActor && !matchSummary && !matchAction && !matchModule && !matchTime) {
          return false;
        }
      }

      return true;
    });
  }, [logs, selectedModule, selectedAction, dateBoundaries, searchQuery]);

  // Statistics KPI
  const stats = useMemo(() => {
    const total = logs.length;
    const purchaseCount = logs.filter(l => l.module === 'PURCHASE').length;
    const inventoryCount = logs.filter(l => l.module === 'INVENTORY').length;
    const masterRbacCount = logs.filter(l => l.module === 'MASTER' || l.module === 'RBAC').length;
    return { total, purchaseCount, inventoryCount, masterRbacCount };
  }, [logs]);

  // Pagination Calculations
  const totalPages = Math.ceil(filteredLogs.length / pageSize) || 1;
  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, pageSize]);

  // Open Diff Modal
  const handleOpenDiff = (log) => {
    setSelectedDiffLog(log);
    setIsDiffModalOpen(true);
  };

  // Copy JSON Diff to clipboard
  const handleCopyDiff = (log) => {
    try {
      const dataStr = JSON.stringify(log, null, 2);
      navigator.clipboard.writeText(dataStr);
      setCopiedId(log.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (e) {
      console.error('Failed to copy diff:', e);
    }
  };

  // Handle Export CSV
  const handleExport = () => {
    exportAuditLogsToCSV(filteredLogs);
  };

  // Handle Reset Mock Transactions
  const handleTriggerReset = async () => {
    const confirmed = await modalService.confirm({
      title: 'ล้างประวัติธุรกรรมจำลอง (Reset Mock Transactions)',
      message: 'คำเตือน: คุณต้องการล้างข้อมูล PR, PO, งานจัดซื้อออนไลน์ และประวัติสต็อกทั้งหมดใช่หรือไม่? (ข้อมูลสินค้าและผู้จำหน่ายหลักจะไม่ถูกลบ)',
      confirmText: 'ยืนยันล้างข้อมูล',
      cancelText: 'ยกเลิก'
    });

    if (confirmed) {
      modalService.success('ดำเนินการสำเร็จ', 'ล้างข้อมูลธุรกรรมจำลองเรียบร้อยแล้ว กำลังรีโหลดระบบ...');
      setTimeout(() => {
        resetMockTransactions({ reload: true });
      }, 500);
    }
  };

  // Reset all filters
  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedModule('ALL');
    setSelectedAction('ALL');
    setTimeRange('ALL');
    setCustomStartDate('');
    setCustomEndDate('');
  };

  return (
    <div className="w-full space-y-6 pb-12 animate-in fade-in duration-300">
      {/* ── Page Header & Stats Summary ── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shadow-inner shrink-0">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                บันทึกประวัติระบบ (Audit Logs)
              </h1>
              <span className="text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
                Security & Compliance
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              ศูนย์รวมบันทึกกิจกรรมความปลอดภัย ตรวจสอบย้อนหลังทุกการทำรายการ (PR/PO, คลังสินค้า, ข้อมูลหลัก, และบทบาทผู้ใช้งาน)
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleTriggerReset}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
            title="ล้างข้อมูลธุรกรรมทั้งหมด"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-500" />
            <span>ล้างประวัติธุรกรรมจำลอง (Reset Mock Transactions)</span>
          </button>

          <button
            type="button"
            onClick={loadLogs}
            disabled={isLoading}
            className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition-all cursor-pointer"
            title="รีเฟรชข้อมูล"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-indigo-600' : ''}`} />
            <span>รีเฟรช</span>
          </button>

          <button
            type="button"
            onClick={handleExport}
            className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm shadow-indigo-600/20 transition-all cursor-pointer"
            title="ดาวน์โหลด Audit Report (.CSV)"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* ── KPI Stat Summary Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">บันทึกทั้งหมด</span>
            <span className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
              <FileText className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono text-slate-900">{stats.total}</span>
            <span className="text-[11px] text-slate-400 font-medium">รายการ</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">จัดซื้อ (PR / PO)</span>
            <span className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
              <Layers className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono text-blue-600">{stats.purchaseCount}</span>
            <span className="text-[11px] text-slate-400 font-medium">กิจกรรม</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">คลังพัสดุ & เบิกจ่าย</span>
            <span className="w-7 h-7 rounded-lg bg-teal-50 flex items-center justify-center text-teal-600">
              <Clock className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono text-teal-600">{stats.inventoryCount}</span>
            <span className="text-[11px] text-slate-400 font-medium">กิจกรรม</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">Master & บทบาทสิทธิ์</span>
            <span className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center text-purple-600">
              <ShieldCheck className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono text-purple-600">{stats.masterRbacCount}</span>
            <span className="text-[11px] text-slate-400 font-medium">กิจกรรม</span>
          </div>
        </div>
      </div>

      {/* ── Modern Filter Bar ── */}
      <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-2xs space-y-4">
        {/* Row 1: Global Search & Quick Actions */}
        <div className="flex flex-col lg:flex-row gap-3">
          {/* Global Search Input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหาด้วยชื่อผู้ทำรายการ, รหัสเอกสาร (PR/PO), รหัส SKU, หรือรายละเอียด..."
              className="w-full pl-10 pr-9 py-2.5 bg-slate-50/70 hover:bg-slate-50 focus:bg-white border border-slate-200 rounded-2xl text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Action Filter Dropdown */}
          <div className="relative w-full lg:w-48 shrink-0">
            <select
              value={selectedAction}
              onChange={(e) => setSelectedAction(e.target.value)}
              className="w-full py-2.5 px-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer shadow-2xs appearance-none"
            >
              <option value="ALL">กิจกรรม: ทั้งหมด (All)</option>
              <option value="CREATE">CREATE (สร้างรายการ)</option>
              <option value="UPDATE">UPDATE (แก้ไขข้อมูล)</option>
              <option value="APPROVE">APPROVE (อนุมัติ)</option>
              <option value="REJECT">REJECT (ปฏิเสธ/ตีกลับ)</option>
              <option value="RECEIVE">RECEIVE (รับพัสดุ/เบิกจ่าย)</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Reset Filters */}
          {(searchQuery || selectedModule !== 'ALL' || selectedAction !== 'ALL' || timeRange !== 'ALL') && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="px-3.5 py-2.5 rounded-2xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              <span>ล้างตัวกรอง</span>
            </button>
          )}
        </div>

        {/* Row 2: Module Tabs & Time Range Buttons */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pt-2 border-t border-slate-100">
          {/* Module Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            <span className="text-[11px] font-semibold text-slate-400 mr-1 uppercase tracking-wider">หมวดหมู่:</span>
            {['ALL', 'PURCHASE', 'INVENTORY', 'MASTER', 'RBAC'].map((modKey) => {
              const active = selectedModule === modKey;
              return (
                <button
                  key={modKey}
                  type="button"
                  onClick={() => setSelectedModule(modKey)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                    active 
                      ? 'bg-slate-900 text-white shadow-xs' 
                      : 'bg-slate-100 hover:bg-slate-200/70 text-slate-600'
                  }`}
                >
                  {MODULE_CONFIG[modKey]?.label || modKey}
                </button>
              );
            })}
          </div>

          {/* Time Range Filter */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <span className="text-[11px] font-semibold text-slate-400 mr-1 uppercase tracking-wider">ช่วงเวลา:</span>
            {[
              { id: 'ALL', label: 'ทั้งหมด' },
              { id: 'TODAY', label: 'วันนี้' },
              { id: 'THIS_WEEK', label: 'สัปดาห์นี้' },
              { id: 'THIS_MONTH', label: 'เดือนนี้' },
              { id: 'CUSTOM', label: 'กำหนดเอง' }
            ].map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTimeRange(t.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  timeRange === t.id
                    ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
                    : 'bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200/60'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom Date Range Selectors */}
        {timeRange === 'CUSTOM' && (
          <div className="flex flex-wrap items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-200/70 animate-in fade-in duration-200">
            <span className="text-xs font-medium text-slate-600 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-indigo-500" />
              กำหนดช่วงวันที่:
            </span>
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
              className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <span className="text-xs text-slate-400">ถึง</span>
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
              className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        )}
      </div>

      {/* ── Modern Minimalist Audit Data Table ── */}
      <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 border-b border-slate-200/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                <th className="py-3.5 px-4 font-mono">เวลาบันทึก</th>
                <th className="py-3.5 px-4">ผู้ดำเนินการ</th>
                <th className="py-3.5 px-4">หมวดหมู่</th>
                <th className="py-3.5 px-4">กิจกรรม</th>
                <th className="py-3.5 px-4">เอกสารอ้างอิง</th>
                <th className="py-3.5 px-4">รายละเอียดสรุป</th>
                <th className="py-3.5 px-4 text-center">ความเปลี่ยนแปลง</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {paginatedLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <div className="flex flex-col items-center justify-center max-w-sm mx-auto">
                      <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
                        <Search className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-bold text-slate-800">ไม่พบรายการบันทึกประวัติ</p>
                      <p className="text-xs text-slate-400 mt-1">
                        ลองปรับเปลี่ยนคำค้นหา หรือรีเซ็ตตัวกรองเพื่อดูรายการทั้งหมด
                      </p>
                      <button
                        type="button"
                        onClick={handleResetFilters}
                        className="mt-4 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition-all shadow-xs cursor-pointer"
                      >
                        ล้างตัวกรองทั้งหมด
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedLogs.map((log) => {
                  const actionBadge = getActionBadgeClass(log.action);
                  const actionIcon = getActionIcon(log.action);
                  const moduleInfo = MODULE_CONFIG[log.module] || MODULE_CONFIG.SYSTEM;
                  const hasChanges = Array.isArray(log.changes) && log.changes.length > 0;

                  return (
                    <tr 
                      key={log.id} 
                      className="hover:bg-slate-50/70 transition-colors group cursor-default"
                    >
                      {/* 1. Timestamp */}
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>{formatLocalTimestamp(log.timestamp || log.createdAt || log.timeFormatted)}</span>
                        </div>
                      </td>

                      {/* 2. Actor */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 flex items-center justify-center font-bold text-xs shrink-0">
                            {(log.actor?.name || 'U').charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 truncate max-w-[150px]">
                              {log.actor?.name || 'System'}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[10px] text-slate-400 truncate max-w-[100px]">
                                {log.actor?.role || 'Staff'}
                              </span>
                              {log.actor?.department && (
                                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 border border-slate-200">
                                  {log.actor.department}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* 3. Module */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${moduleInfo.color}`}>
                          {moduleInfo.label}
                        </span>
                      </td>

                      {/* 4. Action */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border ${actionBadge}`}>
                          {actionIcon}
                          <span>{log.action}</span>
                        </span>
                      </td>

                      {/* 5. Target Ref */}
                      <td className="py-3 px-4 font-mono whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 font-semibold text-[11px] border border-slate-200/80">
                          {log.targetRef || '-'}
                        </span>
                      </td>

                      {/* 6. Summary */}
                      <td className="py-3 px-4 text-slate-700 min-w-[220px]">
                        <p className="line-clamp-2 leading-relaxed" title={log.summary}>
                          {log.summary || '-'}
                        </p>
                      </td>

                      {/* 7. Action / Diff Button */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {hasChanges ? (
                          <button
                            type="button"
                            onClick={() => handleOpenDiff(log)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold border border-indigo-200/70 transition-all cursor-pointer shadow-2xs group-hover:shadow-xs"
                          >
                            <span>ดู Diff</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleOpenDiff(log)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 text-[11px] font-medium border border-slate-200 transition-all cursor-pointer"
                          >
                            <Eye className="w-3 h-3" />
                            <span>ดูบันทึก</span>
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

        {/* ── Table Footer & Pagination ── */}
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filteredLogs.length}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={[15, 30, 50, 100]}
        />
      </div>

      {/* ── Visual Diff Drawer / Modal ── */}
      {isDiffModalOpen && selectedDiffLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-2xl w-full border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    รายละเอียดบันทึกการเปลี่ยนแปลง (Visual Diff)
                  </h3>
                  <p className="text-[11px] font-mono text-slate-400">
                    ID: {selectedDiffLog.id}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopyDiff(selectedDiffLog)}
                  className="px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-white text-slate-600 text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                  title="คัดลอก JSON"
                >
                  {copiedId === selectedDiffLog.id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700">คัดลอกแล้ว</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-slate-500" />
                      <span>คัดลอก</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsDiffModalOpen(false)}
                  className="w-8 h-8 rounded-xl hover:bg-slate-200 text-slate-400 hover:text-slate-600 flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-5">
              {/* Event Metadata Card */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80 text-xs">
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-400">วันและเวลา</span>
                  <p className="font-mono font-medium text-slate-700 mt-0.5">
                    {formatLocalTimestamp(selectedDiffLog.timestamp || selectedDiffLog.createdAt || selectedDiffLog.timeFormatted)}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-400">เอกสารอ้างอิง</span>
                  <p className="font-mono font-bold text-indigo-700 mt-0.5">
                    {selectedDiffLog.targetRef || '-'}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-400">กิจกรรม</span>
                  <div className="mt-0.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${getActionBadgeClass(selectedDiffLog.action)}`}>
                      {selectedDiffLog.action}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-400">ผู้ดำเนินการ</span>
                  <p className="font-semibold text-slate-800 mt-0.5 truncate">
                    {selectedDiffLog.actor?.name || 'System'}
                  </p>
                  <span className="text-[10px] text-slate-400">
                    {selectedDiffLog.actor?.role} ({selectedDiffLog.actor?.department || 'ALL'})
                  </span>
                </div>
              </div>

              {/* Summary description */}
              <div className="bg-indigo-50/50 border border-indigo-100 p-3.5 rounded-2xl text-xs text-indigo-950">
                <span className="font-bold block mb-0.5">รายละเอียดสรุป:</span>
                <p className="leading-relaxed">{selectedDiffLog.summary}</p>
              </div>

              {/* Visual Diff Table */}
              <div>
                <h4 className="text-xs font-bold text-slate-900 mb-2.5 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-slate-500" />
                  <span>การเปรียบเทียบค่าก่อนหน้าและค่าปัจจุบัน (Field Diffs)</span>
                </h4>

                {Array.isArray(selectedDiffLog.changes) && selectedDiffLog.changes.length > 0 ? (
                  <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
                    <table className="w-full text-xs text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-100/80 border-b border-slate-200 text-[11px] font-bold text-slate-600">
                          <th className="py-2.5 px-4 w-1/4">ข้อมูลที่มีการแก้ไข</th>
                          <th className="py-2.5 px-4 w-1/3 text-rose-700">ค่าเดิม (Before)</th>
                          <th className="py-2.5 px-2 text-center w-12 text-slate-400"></th>
                          <th className="py-2.5 px-4 w-1/3 text-emerald-700">ค่าใหม่ (After)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedDiffLog.changes.map((change, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/60">
                            {/* Field */}
                            <td className="py-3 px-4 font-semibold text-slate-800">
                              {change.field}
                            </td>

                            {/* Before Value (Red crossed out) */}
                            <td className="py-3 px-4">
                              <span className="inline-block px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 line-through border border-rose-200/80 font-mono text-[11px] break-all">
                                {change.before || '-'}
                              </span>
                            </td>

                            {/* Direction Arrow */}
                            <td className="py-3 px-2 text-center text-slate-400">
                              <ArrowRight className="w-4 h-4 mx-auto text-slate-400" />
                            </td>

                            {/* After Value (Green bold) */}
                            <td className="py-3 px-4">
                              <span className="inline-block px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 font-bold border border-emerald-200/80 font-mono text-[11px] break-all">
                                {change.after || '-'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-center text-slate-500 text-xs">
                    ไม่มีรายละเอียดค่าการเปลี่ยนแปลงแบบ Field-level บันทึกไว้สำหรับรายการนี้
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/70 flex items-center justify-end">
              <button
                type="button"
                onClick={() => setIsDiffModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-2xs transition-all cursor-pointer"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
