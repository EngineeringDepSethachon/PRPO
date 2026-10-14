import React, { useState, useMemo, useEffect } from 'react';
import { 
  Warehouse, AlertTriangle, PlusCircle, History, Search, PackagePlus, 
  BarChart3, TrendingUp, Edit3, X, SlidersHorizontal, MapPin, 
  FileText, ArrowUpRight, ArrowDownRight, Layers, Sparkles, Archive
} from 'lucide-react';
import StockMovementTable from '../components/stock/StockMovementTable';
import ManualStockInModal from '../components/stock/ManualStockInModal';
import StockAdjustmentModal from '../components/stock/StockAdjustmentModal';
import ProductRemarkDrawer from '../components/stock/ProductRemarkDrawer';
import EmptyState from '../components/common/EmptyState';
import { storageService } from '../services/storageService';
import { modalService } from '../services/modalService';
import Pagination from '../components/common/Pagination';
import { getUserDepartments, canAccessDepartmentData, matchDepartment } from '../utils/permissions';
import { safeStringCompare } from '../utils/formatters';

export default function StockCardView({ 
  products = [], 
  storageLocations = [], 
  stockLogs = [], 
  pos = [], 
  departments: propDepartments = [],
  currentRole, 
  onQuickPR, 
  onRefresh 
}) {
  // Dynamic Departments from Master Data
  const deptList = useMemo(() => {
    const list = (propDepartments && propDepartments.length > 0) ? propDepartments : (storageService.getDepartments?.() || []);
    return (list || []).filter(d => d.isActive !== false);
  }, [propDepartments]);

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

  const [selectedProduct, setSelectedProduct] = useState(null);
  const [remarkProduct, setRemarkProduct] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [selectedLocation, setSelectedLocation] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('stock-list');
  const [showManualIn, setShowManualIn] = useState(false);
  const [showAdjustStock, setShowAdjustStock] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [ropPage, setRopPage] = useState(1);
  const [ropPageSize, setRopPageSize] = useState(10);
  const [showDiscontinued, setShowDiscontinued] = useState(false);

  const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER';

  useEffect(() => {
    setCategoryFilter('ALL');
  }, [currentRole?.id, currentRole?.username, currentRole?.department]);

  // Auto-reset page on filter or search changes
  useEffect(() => {
    setCurrentPage(1);
    setRopPage(1);
  }, [categoryFilter, selectedLocation, searchQuery, activeTab, showDiscontinued]);

  // Available unique locations from Master Data & Products
  const availableLocations = useMemo(() => {
    const locs = (storageLocations && storageLocations.length > 0)
      ? storageLocations 
      : (storageService.getStorageLocations?.() || []);
    const locsFromMaster = (locs || []).map(l => l?.name).filter(Boolean);
    const locsFromProds = (products || []).map(p => p?.locationName).filter(Boolean);
    return Array.from(new Set([...locsFromMaster, ...locsFromProds]));
  }, [products, storageLocations]);

  const viewableProducts = useMemo(() => {
    return products.filter(p => {
      const pCat = p.category || p.department || 'PD';
      return canAccessDepartmentData(currentRole, pCat);
    });
  }, [products, currentRole]);

  // Count of discontinued products with zero stock
  const discontinuedCount = useMemo(() => {
    return viewableProducts.filter(p => {
      const isInactive = p.isActive === false || String(p.status || '').toUpperCase() === 'INACTIVE';
      return isInactive && Number(p.stockBalance || 0) <= 0;
    }).length;
  }, [viewableProducts]);

  // Filter & Priority Sort with Location Filter & Inactive Lifecycle Guard
  const sortedAndFilteredProducts = useMemo(() => {
    return viewableProducts
      .filter(p => {
        const pCat = p.category || p.department || 'PD';
        const matchesCat = categoryFilter === 'ALL' || pCat === categoryFilter;
        const matchesLocation = selectedLocation === 'ALL' || p.locationName === selectedLocation;

        const isInactive = p.isActive === false || String(p.status || '').toUpperCase() === 'INACTIVE';
        const stock = Number(p.stockBalance || 0);

        // Directive 1:
        // - Inactive with stock > 0: remain visible in stock table so user can issue them out
        // - Inactive with stock <= 0: hidden by default, shown only if showDiscontinued === true
        if (isInactive && stock <= 0 && !showDiscontinued) {
          return false;
        }

        const q = searchQuery.trim().toLowerCase();
        let matchesDoc = false;
        if (q && Array.isArray(stockLogs)) {
          let qPoStem = q;
          if (q.startsWith('grn-')) {
            const match = q.match(/grn-(po-[a-z0-9-]+?)(?:-\d{2})?$/i);
            if (match) qPoStem = match[1].toLowerCase();
          }
          matchesDoc = stockLogs.some(l => {
            const thisPId = String(p.id || '').trim();
            const thisPDept = String(p.department || p.category || '').trim();
            const thisPCode = String(p.code || p.sku || '').trim();

            if (l.department && thisPDept && !matchDepartment(l.department, thisPDept)) return false;

            let isProdMatch = false;
            if (thisPId && l.productId) {
              isProdMatch = String(l.productId).trim() === thisPId;
            } else {
              isProdMatch = matchDepartment(l.department, thisPDept) && String(l.productCode || l.code || '').trim() === thisPCode;
            }
            if (!isProdMatch) return false;

            const docNo = String(l.documentNo || l.docNo || l.grnNo || l.grNumber || '').toLowerCase();
            const poNo = String(l.poNo || l.poNumber || l.refPo || '').toLowerCase();
            return docNo.includes(q) || poNo.includes(q) || docNo.includes(qPoStem) || poNo.includes(qPoStem);
          });

        }
        const matchesSearch = !q || 
          (p.name && p.name.toLowerCase().includes(q)) || 
          (p.code && p.code.toLowerCase().includes(q)) ||
          (p.locationName && p.locationName.toLowerCase().includes(q)) ||
          (p.remark && p.remark.toLowerCase().includes(q)) ||
          matchesDoc;
        return matchesCat && matchesLocation && matchesSearch;
      })
      .sort((a, b) => {
        const aInactive = a.isActive === false || String(a.status || '').toUpperCase() === 'INACTIVE';
        const bInactive = b.isActive === false || String(b.status || '').toUpperCase() === 'INACTIVE';
        const aLow = !aInactive && a.stockBalance <= a.reorderPoint ? 1 : 0;
        const bLow = !bInactive && b.stockBalance <= b.reorderPoint ? 1 : 0;
        if (aLow !== bLow) return bLow - aLow;
        const aRatio = a.reorderPoint > 0 ? (a.stockBalance / a.reorderPoint) : 999;
        const bRatio = b.reorderPoint > 0 ? (b.stockBalance / b.reorderPoint) : 999;
        if (aRatio !== bRatio) return aRatio - bRatio;
        return safeStringCompare(a?.code, b?.code);
      });
  }, [viewableProducts, categoryFilter, selectedLocation, searchQuery, showDiscontinued]);

  // Pagination slicing
  const totalPages = Math.ceil(sortedAndFilteredProducts.length / pageSize) || 1;
  const paginatedProducts = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedAndFilteredProducts.slice(start, start + pageSize);
  }, [sortedAndFilteredProducts, currentPage, pageSize]);

  // Count of items requiring reorder (Directive 2: ONLY active products!)
  const lowStockCount = useMemo(() => {
    return viewableProducts.filter(p => {
      const isInactive = p.isActive === false || String(p.status || '').toUpperCase() === 'INACTIVE';
      if (isInactive) return false;
      return p.stockBalance <= p.reorderPoint;
    }).length;
  }, [viewableProducts]);

  // ROP Analytics Computation (Directive 2: Exclude inactive products!)
  const ropAnalytics = useMemo(() => {
    const activeViewable = viewableProducts.filter(p => p.isActive !== false && String(p.status || '').toUpperCase() !== 'INACTIVE');

    return activeViewable.map(prod => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const pId = String(prod.id || '').trim();
      const pDept = String(prod.department || prod.category || '').trim();
      const pCode = String(prod.code || prod.sku || '').trim();

      const recentOuts = stockLogs.filter(log => {
        if (log.type !== 'OUT') return false;
        if (log.department && pDept && !matchDepartment(log.department, pDept)) return false;
        if (pId && log.productId) {
          if (String(log.productId).trim() !== pId) return false;
        } else {
          if (!matchDepartment(log.department, pDept) || String(log.productCode || log.code || '').trim() !== pCode) return false;
        }
        const logD = log.date || log.timestamp;
        return logD && new Date(logD) >= thirtyDaysAgo;
      });


      const totalOutQty = recentOuts.reduce((sum, l) => sum + (l.qty || 0), 0);
      const avgDailyUsage = totalOutQty / 30;
      const leadTime = prod.leadTimeDays || 7;

      const safetyStock = Math.ceil(avgDailyUsage * leadTime * 1.5);
      const suggestedROP = Math.ceil(avgDailyUsage * leadTime) + safetyStock;
      const ropGap = suggestedROP - (prod.reorderPoint || 0);

      return {
        ...prod,
        avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
        totalOut30Days: totalOutQty,
        suggestedROP,
        safetyStock,
        ropGap,
        isRopUnderSuggested: prod.reorderPoint < suggestedROP && suggestedROP > 0,
      };
    });
  }, [products, stockLogs, currentRole]);

  // ROP Analytics Pagination Slicing
  const ropTotalPages = Math.ceil(ropAnalytics.length / ropPageSize) || 1;
  const paginatedRopAnalytics = useMemo(() => {
    const start = (ropPage - 1) * ropPageSize;
    return ropAnalytics.slice(start, start + ropPageSize);
  }, [ropAnalytics, ropPage, ropPageSize]);

  const handleApplyROP = async (product, suggestedROP) => {
    const confirmed = await modalService.confirm({
      title: 'ยืนยันปรับจุดสั่งซื้อ (ROP)',
      message: `ต้องการปรับจุดสั่งซื้อ (Reorder Point) ของ "${product.name}" เป็น ${suggestedROP} ${product.unit} หรือไม่?`,
      confirmText: 'ยืนยันการปรับ',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    const allProducts = storageService.getProducts();
    const idx = allProducts.findIndex(p => p.id === product.id);
    if (idx !== -1) {
      allProducts[idx].reorderPoint = suggestedROP;
      storageService.saveProducts(allProducts);
      modalService.success('ปรับ ROP เรียบร้อย', `ปรับ ROP ของ "${product.name}" เป็น ${suggestedROP} ${product.unit} สำเร็จ`);
      onRefresh();
    }
  };

  return (
    <div className="w-full space-y-4 animate-fade-in pb-12 font-sans">
      
      {/* ── 1. Modern Minimalist SaaS Header & Action Hub ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900">
              คลังสินค้า & สต็อก
            </h1>
            <span className="text-xs font-mono font-medium text-slate-500 bg-slate-100/80 px-2 py-0.5 rounded-md border border-slate-200/60">
              {products.length} SKUs
            </span>
          </div>
          <p className="text-xs sm:text-[13px] text-slate-600 mt-0.5 font-normal">
            ระบบบริหารสินค้าคงคลัง ตรวจสอบยอดคงเหลือ รับเข้า-เบิกจ่าย และจุดสั่งซื้อซ้ำ
          </p>
        </div>

        {/* High-aesthetic Action Hub */}
        {!isOnlinePurchaser && (currentRole?.canReceiveGoods || currentRole?.roleId === 'ASST_MANAGER' || currentRole?.id === 'ADMIN') && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Ghost Outline Secondary Button */}
            <button
              onClick={() => setShowAdjustStock(true)}
              className="group inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 active:scale-[0.98] text-slate-700 hover:text-slate-900 border border-slate-200 text-xs font-medium px-3.5 py-2 rounded-xl transition-all duration-150 cursor-pointer shadow-2xs"
              title="ปรับปรุงยอดสต็อก (+/-)"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 transition-colors" />
              <span>ปรับปรุงยอด</span>
            </button>

            {/* Solid Dark Minimal Primary Button */}
            <button
              onClick={() => setShowManualIn(true)}
              className="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 active:scale-[0.98] text-white text-xs font-medium px-4 py-2 rounded-xl transition-all duration-150 cursor-pointer shadow-xs hover:shadow-sm"
              title="บันทึกรับสินค้าเข้าคลัง"
            >
              <PackagePlus className="w-3.5 h-3.5 text-slate-200" />
              <span>รับเข้าคลัง</span>
            </button>
          </div>
        )}
      </div>

      {/* ── 2. Sleek ROP Alert Strip (Linear / Raycast notification style) ── */}
      {lowStockCount > 0 && (
        <div className="relative overflow-hidden bg-amber-50/70 border border-amber-200/80 rounded-2xl px-4 py-2.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs backdrop-blur-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Subtle Pulse Indicator */}
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
            </span>

            <div className="text-xs text-amber-950 font-normal truncate">
              <span className="font-semibold text-amber-900 mr-1.5">ตรวจพบสินค้าแตะจุด ROP</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-amber-200/70 text-amber-900 border border-amber-300/80 mr-2">
                {lowStockCount} รายการ
              </span>
              <span className="text-slate-600 hidden md:inline">
                ควรเปิดใบขอซื้อ (PR) เพิ่มเติมเพื่อความต่อเนื่องในการผลิต
              </span>
            </div>
          </div>

          {onQuickPR && !isOnlinePurchaser && (
            <button
              onClick={() => {
                const firstLow = sortedAndFilteredProducts.find(p => (p.isActive !== false && String(p.status || '').toUpperCase() !== 'INACTIVE') && p.stockBalance <= p.reorderPoint);
                if (firstLow) onQuickPR(firstLow);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-900/90 hover:bg-amber-950 active:scale-[0.98] text-amber-50 text-xs font-medium rounded-full transition-all cursor-pointer shrink-0 shadow-2xs self-end sm:self-auto"
            >
              <span>เปิด PR ด่วน</span>
              <ArrowUpRight className="w-3 h-3 text-amber-300" />
            </button>
          )}
        </div>
      )}

      {/* ── 3. Unified Filter & Search Toolbar (Linear / Vercel Segmented Bar) ── */}
      <div className="bg-white p-2 rounded-2xl border border-slate-200/70 shadow-2xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          
          {/* Left: Modern Capsule Segmented Tabs */}
          <div className="flex items-center p-1 bg-slate-100/70 rounded-xl shrink-0 overflow-x-auto custom-scrollbar border border-slate-200/50">
            <button
              onClick={() => setActiveTab('stock-list')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer whitespace-nowrap ${
                activeTab === 'stock-list' 
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold' 
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Warehouse className="w-3.5 h-3.5 text-slate-500" />
              <span>รายการสต็อก</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-md bg-slate-100 text-slate-600">
                {sortedAndFilteredProducts.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('rop-analysis')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer whitespace-nowrap ${
                activeTab === 'rop-analysis' 
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold' 
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5 text-slate-500" />
              <span>วิเคราะห์ ROP</span>
              {lowStockCount > 0 && (
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-md bg-amber-100 text-amber-800">
                  {lowStockCount}
                </span>
              )}
            </button>
          </div>

          {/* Right: Department, Location & Search */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1 lg:max-w-3xl justify-end flex-wrap">
            
            {/* Department Segmented Filter */}
            {hasMultipleDepts ? (
              <div className="flex items-center p-1 bg-slate-100/70 rounded-xl shrink-0 border border-slate-200/50">
                <button
                  type="button"
                  onClick={() => setCategoryFilter('ALL')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    categoryFilter === 'ALL' 
                      ? 'bg-white text-slate-900 shadow-2xs font-semibold' 
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {canSeeAll ? 'ทั้งหมด' : (visibleFilterDepts.length > 1 ? `ทั้งหมด (${visibleFilterDepts.map(d => d.code).join(', ')})` : 'ทั้งหมด')}
                </button>
                {visibleFilterDepts.map(d => (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => setCategoryFilter(d.code)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      categoryFilter === d.code 
                        ? 'bg-white text-indigo-700 shadow-2xs font-semibold' 
                        : 'text-slate-500 hover:text-indigo-700'
                    }`}
                  >
                    {d.name} ({d.code})
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-50 rounded-xl border border-slate-200/60 shrink-0 text-xs">
                <span className="text-slate-400 font-medium">แผนก:</span>
                <span className="font-mono font-semibold text-slate-800">
                  {visibleFilterDepts[0]?.name || currentRole?.department || 'PD'} ({visibleFilterDepts[0]?.code || currentRole?.department || 'PD'})
                </span>
              </div>
            )}

            {/* Storage Location Selector */}
            <div className="relative min-w-[140px] shrink-0">
              <select
                value={selectedLocation}
                onChange={e => setSelectedLocation(e.target.value)}
                className="w-full appearance-none bg-slate-50 hover:bg-slate-100/80 border border-slate-200/70 rounded-xl pl-3 pr-7 py-1.5 text-xs font-medium text-slate-700 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 transition-all cursor-pointer truncate shadow-2xs"
              >
                <option value="ALL">📍 ทุกจุดจัดเก็บ</option>
                {availableLocations.map(locName => (
                  <option key={locName} value={locName}>{locName}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-slate-400">
                <svg className="h-3.5 w-3.5 stroke-current" fill="none" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {/* Directive 1: Filter Toggle for Discontinued Items with zero stock */}
            <button
              type="button"
              onClick={() => setShowDiscontinued(prev => !prev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer shrink-0 ${
                showDiscontinued
                  ? 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                  : 'bg-slate-50 text-slate-600 border-slate-200/70 hover:bg-slate-100/80'
              }`}
              title="สลับการแสดงผลรายการสินค้าที่ปิดใช้งานแล้วและสต็อกหมด (0)"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>แสดงที่ปิดใช้งานแล้ว</span>
              {discontinuedCount > 0 && (
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                  showDiscontinued ? 'bg-slate-700 text-slate-200' : 'bg-slate-200 text-slate-600'
                }`}>
                  {discontinuedCount}
                </span>
              )}
            </button>

            {/* Search Input with ⌘K Badge style */}
            <div className="relative flex-1 sm:w-60 md:w-64 min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="ค้นหาสินค้า, รหัส, จุดจัดเก็บ..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 hover:bg-slate-100/60 focus:bg-white border border-slate-200/70 rounded-xl pl-8 pr-12 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 transition-all shadow-2xs font-normal"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {searchQuery ? (
                  <button 
                    onClick={() => setSearchQuery('')}
                    className="text-slate-400 hover:text-slate-700 p-0.5 text-xs cursor-pointer"
                  >
                    ✕
                  </button>
                ) : (
                  <kbd className="hidden sm:inline-block font-mono text-[9px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                    /
                  </kbd>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 4. Tab 1: Clean Minimalist Data Table ── */}
      {activeTab === 'stock-list' && (
        <div className="bg-white border border-slate-200/70 rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto max-h-[640px] custom-scrollbar relative">
            <table className="w-full text-left text-xs sm:text-sm min-w-[880px]">
              <thead className="sticky top-0 z-20 bg-slate-50/95 backdrop-blur-xs border-b border-slate-200/70 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-3 pl-5 whitespace-nowrap">รหัสสินค้า</th>
                  <th className="py-3 px-4 w-2/5">รายการสินค้า</th>
                  <th className="py-3 px-3 text-center whitespace-nowrap">แผนก</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">คงเหลือ</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">จุดเตือน (ROP)</th>
                  <th className="py-3 px-4 text-center whitespace-nowrap">สถานะ</th>
                  <th className="py-3 pr-5 text-center whitespace-nowrap">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100/90 bg-white">
                {sortedAndFilteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="p-0">
                      <EmptyState 
                        title="ไม่พบรายการสินค้า" 
                        description="ลองปรับเงื่อนไขการค้นหา หรือเปลี่ยนหมวดหมู่ตัวกรอง" 
                      />
                    </td>
                  </tr>
                ) : (
                  paginatedProducts.map(prod => {
                    const isInactive = prod.isActive === false || String(prod.status || '').toUpperCase() === 'INACTIVE';
                    const stock = Number(prod.stockBalance || 0);
                    const isLow = !isInactive && stock <= prod.reorderPoint;
                    const sUnit = prod.stockUnit || prod.unit || 'ชิ้น';
                    const pUnit = prod.purchaseUnit || prod.unit || sUnit;
                    const rate = Number(prod.conversionRate) > 0 ? Number(prod.conversionRate) : 1;
                    const purchaseEquiv = rate > 1 ? (stock / rate) : null;
                    const purchaseEquivStr = purchaseEquiv !== null
                      ? (purchaseEquiv % 1 === 0 ? purchaseEquiv.toLocaleString() : purchaseEquiv.toFixed(1).replace(/\.0$/, ''))
                      : null;
                    
                    const hasRemark = Boolean(prod.remark && prod.remark.trim());

                    return (
                      <tr 
                        key={prod.id} 
                        className={`transition-colors duration-100 ${
                          isInactive
                            ? (stock > 0 ? 'bg-amber-50/20 hover:bg-amber-50/30' : 'opacity-60 bg-slate-50/50 hover:bg-slate-100/60')
                            : (isLow ? 'bg-amber-50/15 hover:bg-slate-50/70' : 'hover:bg-slate-50/70')
                        }`}
                      >
                        {/* รหัสสินค้า (Developer Tag Style) */}
                        <td className="py-3 pl-5 whitespace-nowrap">
                          <span className={`font-mono text-xs px-2 py-0.5 rounded-md border ${
                            isInactive
                              ? 'text-slate-500 bg-slate-100 border-slate-200/60'
                              : 'text-slate-700 bg-slate-100/90 border-slate-200/50'
                          }`}>
                            {prod.code}
                          </span>
                        </td>

                        {/* ชื่อสินค้า & Location Breadcrumb & Remark Inline Chip */}
                        <td className="py-3 px-4 break-words max-w-md">
                          <div className="flex items-start gap-1.5 flex-wrap">
                            <span className="font-medium text-slate-900 text-xs sm:text-[13px] leading-snug">
                              {prod.name}
                            </span>

                            {/* Minimal Remark Pill */}
                            {hasRemark && (
                              <button
                                type="button"
                                onClick={() => setRemarkProduct(prod)}
                                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors cursor-pointer"
                                title={`คลิกเพื่อดูหมายเหตุ: ${prod.remark}`}
                              >
                                <FileText className="w-2.5 h-2.5 text-amber-600" />
                                <span>Note</span>
                              </button>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 mt-1 text-slate-400 text-[11px]">
                            <span className="inline-flex items-center gap-1 text-slate-500 font-normal">
                              <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                              <span>{prod.locationName || 'ไม่ระบุจุดเก็บ'}</span>
                            </span>
                            {rate > 1 && (
                              <span>• 1 {pUnit} = {rate} {sUnit}</span>
                            )}
                          </div>
                        </td>

                        {/* แผนก */}
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                            prod.category === 'PD' 
                              ? 'bg-blue-50 text-blue-700 border border-blue-100' 
                              : 'bg-amber-50 text-amber-700 border border-amber-100'
                          }`}>
                            {prod.category}
                          </span>
                        </td>

                        {/* คงเหลือปัจจุบัน (Right aligned, monospace numbers) */}
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className={`font-mono text-xs sm:text-sm font-semibold tabular-nums ${
                            isInactive 
                              ? 'text-slate-800' 
                              : (isLow ? 'text-amber-900' : 'text-slate-900')
                          }`}>
                            {stock.toLocaleString()}
                            <span className="font-sans font-normal text-slate-400 text-xs ml-1">
                              {sUnit}
                            </span>
                          </div>
                          {purchaseEquivStr && (
                            <div className="text-[10px] text-slate-400 font-mono">
                              ≈ {purchaseEquivStr} {pUnit}
                            </div>
                          )}
                        </td>

                        {/* จุดเตือน ROP */}
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <span className="font-mono text-xs text-slate-500 tabular-nums">
                            {Number(prod.reorderPoint || 0).toLocaleString()}
                          </span>
                          <span className="font-sans text-slate-400 text-xs ml-1">{sUnit}</span>
                        </td>

                        {/* สถานะ (Soft Dot Badge สไตล์ Minimal) */}
                        <td className="py-3 px-4 text-center whitespace-nowrap">
                          {isInactive ? (
                            stock > 0 ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-0.5 rounded-full" title="สินค้านี้ยกเลิกใช้งานแล้ว แต่ยังมีสต็อกคงเหลือ ให้เบิกใช้งานจนหมด">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                ยกเลิกใช้งาน / รอเคลียร์สต็อก
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200 px-2.5 py-0.5 rounded-full">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                ปิดใช้งานแล้ว
                              </span>
                            )
                          ) : isLow ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-medium bg-amber-50/80 px-2.5 py-0.5 rounded-full border border-amber-200/60">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                              ถึงจุด ROP
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700 font-medium bg-emerald-50/80 px-2.5 py-0.5 rounded-full border border-emerald-200/60">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              ปกติ
                            </span>
                          )}
                        </td>

                        {/* จัดการ (Actions Group) */}
                        <td className="py-3 pr-5 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1">
                            {/* Quick PR Order Button - NEVER shown for inactive/discontinued products */}
                            {!isInactive && isLow && onQuickPR && !isOnlinePurchaser && (
                              <button
                                type="button"
                                onClick={() => onQuickPR(prod)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200/80 transition-all cursor-pointer shadow-2xs"
                                title="เปิด PR สินค้านี้ทันที"
                              >
                                <PlusCircle className="w-3 h-3 text-amber-600" />
                                <span>สั่งซื้อ</span>
                              </button>
                            )}

                            {/* History Button */}
                            <button
                              type="button"
                              onClick={() => setSelectedProduct(prod)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-all cursor-pointer"
                              title="ดูประวัติการเคลื่อนไหวสต็อก (Stock Movement Log)"
                            >
                              <History className="w-3.5 h-3.5" />
                            </button>

                            {/* Product Remark Drawer Trigger */}
                            <button
                              type="button"
                              onClick={() => setRemarkProduct(prod)}
                              className={`p-1.5 rounded-lg transition-all cursor-pointer relative ${
                                hasRemark
                                  ? 'text-amber-700 hover:bg-amber-50'
                                  : 'text-slate-400 hover:text-slate-800 hover:bg-slate-100'
                              }`}
                              title={hasRemark ? `มีหมายเหตุ: ${prod.remark}` : 'บันทึกหมายเหตุสินค้า'}
                            >
                              <FileText className="w-3.5 h-3.5" />
                              {hasRemark && (
                                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Footer Pagination */}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={sortedAndFilteredProducts.length}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      {/* ── 5. Tab 2: ROP Analytics (Modern Tech Spec style) ── */}
      {activeTab === 'rop-analysis' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-4 py-3 bg-slate-50 border border-slate-200/70 rounded-2xl text-xs text-slate-600">
            <Sparkles className="w-4 h-4 text-indigo-500 shrink-0" />
            <span>
              <strong>สูตรคำนวณ:</strong> ROP แนะนำ = (ใช้เฉลี่ยต่อวัน × Lead Time) + Safety Stock (คำนวณจากประวัติการเบิกออก 30 วันล่าสุด)
            </span>
          </div>

          <div className="bg-white rounded-2xl overflow-hidden border border-slate-200/70 shadow-2xs">
            <div className="overflow-x-auto max-h-[580px] custom-scrollbar relative">
              <table className="w-full text-left text-xs sm:text-sm min-w-[800px]">
                <thead className="sticky top-0 z-20 bg-slate-50/95 backdrop-blur-xs border-b border-slate-200/70 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pl-5">รหัส & รายการสินค้า</th>
                    <th className="py-3 px-4 text-right">คงเหลือ</th>
                    <th className="py-3 px-4 text-right">เบิก 30 วัน</th>
                    <th className="py-3 px-4 text-right">ใช้เฉลี่ย/วัน</th>
                    <th className="py-3 px-4 text-right">Lead Time</th>
                    <th className="py-3 px-4 text-right">ROP ปัจจุบัน</th>
                    <th className="py-3 px-4 text-right">ROP แนะนำ</th>
                    <th className="py-3 px-4 text-center">สถานะ</th>
                    <th className="py-3 pr-5 text-center">ปรับ ROP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {paginatedRopAnalytics.map(item => (
                    <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 pl-5 whitespace-nowrap">
                        <div className="font-mono text-xs text-slate-500">{item.code}</div>
                        <div className="font-medium text-slate-900 text-xs sm:text-sm">{item.name}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums">
                        {item.stockBalance} <span className="font-sans font-normal text-slate-400 text-xs">{item.unit}</span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                        {item.totalOut30Days} <span className="font-sans font-normal text-slate-400 text-xs">{item.unit}</span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                        {item.avgDailyUsage}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                        {item.leadTimeDays || 7} วัน
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                        {item.reorderPoint}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-indigo-600 tabular-nums">
                        {item.suggestedROP}
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {item.isRopUnderSuggested ? (
                          <span className="inline-flex items-center text-[11px] font-medium text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
                            ต่ำกว่าเกณฑ์ (-{item.ropGap})
                          </span>
                        ) : (
                          <span className="inline-flex items-center text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                            เหมาะสม
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-5 text-center whitespace-nowrap">
                        {item.isRopUnderSuggested && !isOnlinePurchaser ? (
                          <button
                            onClick={() => handleApplyROP(item, item.suggestedROP)}
                            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-all cursor-pointer"
                          >
                            ใช้ค่า {item.suggestedROP}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ROP Table Footer Pagination */}
            <Pagination
              currentPage={ropPage}
              totalPages={ropTotalPages}
              totalItems={ropAnalytics.length}
              pageSize={ropPageSize}
              onPageChange={setRopPage}
              onPageSizeChange={setRopPageSize}
            />
          </div>
        </div>
      )}

      {/* ── 6. Modals & Drawers ── */}

      {/* Stock Movement Modal */}
      {selectedProduct && (
        <StockMovementTable
          product={selectedProduct}
          stockLogs={stockLogs}
          pos={pos}
          currentUser={currentRole}
          currentRole={currentRole}
          onClose={() => setSelectedProduct(null)}
          onRefresh={onRefresh}
        />

      )}

      {/* Product Remark Drawer */}
      <ProductRemarkDrawer
        isOpen={Boolean(remarkProduct)}
        product={remarkProduct}
        currentRole={currentRole}
        onClose={() => setRemarkProduct(null)}
        onRefresh={onRefresh}
      />

      {/* Manual Stock In Modal */}
      {showManualIn && (
        <ManualStockInModal
          products={products}
          currentRole={currentRole}
          onClose={() => setShowManualIn(false)}
          onRefresh={onRefresh}
        />
      )}

      {/* Stock Adjustment Modal */}
      {showAdjustStock && (
        <StockAdjustmentModal
          products={products}
          currentRole={currentRole}
          onClose={() => setShowAdjustStock(false)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}
