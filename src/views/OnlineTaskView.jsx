import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { apiService } from '../services/apiService';
import { storageService } from '../services/storageService';
import { useAppContext } from '../context/AppContext';
import { 
  ShoppingCart, CheckCircle2,
  Search, Clock,
  ChevronRight, ChevronLeft, Truck, Calendar, AlertTriangle, X
} from 'lucide-react';
import EmptyState from '../components/common/EmptyState';
import AttachmentViewerModal from '../components/common/AttachmentViewerModal';
import PODetailsModal from '../components/po/PODetailsModal';
import { modalService } from '../services/modalService';
import OnlineOrderCard, { getStoreGroupKey, isStoreClaimResolved } from './procurement/OnlineOrderCard';
import { 
  formatThaiMonth, 
  getPrevMonth, 
  getNextMonth, 
  calculateCompletedKPIs, 
  parseOrderYearMonth
} from './procurement/OnlineProcurementHub';
import { formatCurrency } from '../utils/formatters.js';
import { isPendingPurchaseOrder, isPendingClaimOrder } from '../services/procurementService';

const formatMoney = (n) => formatCurrency(n);

// 🛡️ Helper: Check if PO has Goods Receipt Note (GRN) from warehouse inspection
export function checkPOHasGRN(po) {
  if (!po) return false;
  return Boolean(
    po.hasGRN ||
    po.grNumber ||
    po.grId ||
    po.grnNumber ||
    (Array.isArray(po.grnHistory) && po.grnHistory.length > 0) ||
    (Array.isArray(po.grAttachments) && po.grAttachments.length > 0) ||
    po.receivedAt ||
    (Array.isArray(po.items) && po.items.some(it => it.receivedQty !== undefined && it.receivedQty !== null && it.receivedQty > 0))
  );
}

export function isOrderClosed(status) {
  const s = String(status || '').toUpperCase();
  return s === 'COMPLETED' || s === 'CLOSED' || s === 'RESOLVED' || s === 'CANCELLED' || s === 'COMPLETED_WITH_REFUND' || s === 'RECEIVED' || s === 'FULLY_RECEIVED' || s.startsWith('COMPLETED') || s.startsWith('CLOSED');
}

export function isOrderInClaim(status) {
  const s = String(status || '').toUpperCase();
  return s === 'CLAIM_PENDING' || s === 'IN_CLAIM' || s === 'PARTIALLY_RECEIVED_IN_CLAIM' || s.includes('CLAIM') || s.includes('DISPUTE');
}

// 🛡️ Helper: Check if PO has shortage or damage from warehouse inspection
export function checkPOHasDispute(po) {
  if (!po) return false;
  const statusUpper = String(po.status || '').toUpperCase();
  if (statusUpper === 'IN_CLAIM' || statusUpper === 'PARTIALLY_RECEIVED_IN_CLAIM' || Boolean(po.isInClaim)) return true;
  if (!Array.isArray(po.items) || po.items.length === 0) return false;
  return po.items.some(it => {
    const isDamaged = (Number(it.damagedQty || 0) > 0) || Boolean(it.isDamaged);
    const isWaitNextRound = it.shortageAction === 'WAIT_NEXT_ROUND' || it.disputeAction === 'WAIT_NEXT_ROUND' || it.shortageReason === 'SPLIT_SHIPMENT';
    const isShortageClaim = Number(it.shortageQty || 0) > 0 && (it.shortageAction === 'CLAIM_SHORTAGE' || (!isWaitNextRound && it.disputeAction === 'CLAIM'));
    return (isDamaged || isShortageClaim || it.hasDispute) && it.claimStatus !== 'RESOLVED';
  });
}

// Helper: check if PO has genuine unresolved claim (with Lifecycle Guard)
export function hasUnresolvedClaim(po) {
  if (!po) return false;
  const s = String(po.status || '').toLowerCase();
  const statusUpper = s.toUpperCase();

  const isExplicitClaimStatus = s === 'claim_pending' || s === 'in_claim' || s === 'partially_received_in_claim' || Boolean(po.isInClaim) || po.claimStatus === 'PENDING_CLAIM' || po.claimStatus === 'IN_CLAIM' || Boolean(po.hasUnresolvedClaim);

  // If PO is already closed/completed/cancelled/resolved, it must NEVER be in CLAIM unless explicitly in claim
  if (!isExplicitClaimStatus && (isOrderClosed(statusUpper) || po.claimStatus === 'RESOLVED' || po.claimStatus === 'REFUNDED')) {
    return false;
  }

  // If dispute flags are cleared, PO is no longer in claim
  if (po.hasDispute === false && !po.isInClaim && !isExplicitClaimStatus && !s.includes('claim')) {
    return false;
  }

  const poHasGRN = checkPOHasGRN(po);
  const isPreInspectionStatus = [
    'pending_order', 'pending', 'waiting_order', 'waiting', 'in_progress_online',
    'ordered_pending_delivery', 'ordered', 'in_transit', 'in_delivery', 'waiting_delivery', 'waiting_delivery_round_2', 'issued',
    'รอดำเนินการ', 'รอดำเนินการสั่งซื้อ'
  ].includes(s);

  // 🛡️ LIFECYCLE GUARD:
  // ถ้ายังไม่ตรวจรับจริง (ไม่มี GRN) และสถานะไม่ได้ระบุชัดว่าเป็นเคลม ห้ามมองว่ามีเคลมเด็ดขาด!
  if (isPreInspectionStatus && !poHasGRN && !s.includes('claim') && !s.includes('dispute') && !po.isInClaim) {
    return false;
  }

  // Identify genuine claim items (excluding WAIT_NEXT_ROUND and received in full)
  const items = Array.isArray(po.items) ? po.items : [];
  const realClaimItems = items.filter(i => {
    // Only permanently settled items (REFUND/WRITE_OFF) are excluded from claims
    // Items with REPLACEMENT that still have damagedQty > 0 or active disputes must NOT be ignored
    const isPermanentSettled = i.claimResolution === 'REFUND' || i.claimResolution === 'WRITE_OFF';
    if (isPermanentSettled) return false;

    const damaged = Number(i.damagedQty ?? i.defectQty ?? i.claimedQty ?? 0);
    const shortage = Number(i.shortageQty ?? 0);
    const isWaitNext = i.shortageAction === 'WAIT_NEXT_ROUND' || 
                       i.disputeAction === 'WAIT_NEXT_ROUND' || 
                       i.shortageReason === 'SPLIT_SHIPMENT';

    if (damaged > 0) return true;
    if (shortage > 0 && !isWaitNext) {
      return true;
    }
    if (i.hasDispute && !isWaitNext) return true;
    return false;
  });

  const hasLegacyDisputeFlag = Boolean(po.hasDispute || po.isInClaim || po.disputeDetails);
  if (!isExplicitClaimStatus && realClaimItems.length === 0 && !(hasLegacyDisputeFlag && poHasGRN)) {
    return false;
  }

  const storeClaims = po.storeClaims || {};

  // Group real claim items by store
  const storeGroups = {};
  realClaimItems.forEach((it, idx) => {
    const key = getStoreGroupKey(it, idx);
    if (!storeGroups[key]) {
      storeGroups[key] = {
        storeKey: key,
        storeName: (it.actualStoreName || it.storeName || '').trim(),
        items: []
      };
    }
    if (!Array.isArray(storeGroups[key].items)) {
      storeGroups[key].items = [];
    }
    storeGroups[key].items.push(it);
  });

  const storeKeys = Object.keys(storeGroups);
  if (storeKeys.length === 0) {
    const claimValues = Object.values(storeClaims);
    if (claimValues.length > 0 && claimValues.every(c => c.isResolved || c.status === 'RESOLVED' || c.status === 'COMPLETED')) {
      return false;
    }
    return (isExplicitClaimStatus || (hasLegacyDisputeFlag && poHasGRN)) && Object.keys(storeClaims).length === 0;
  }

  // Check if at least ONE disputed store is NOT resolved
  for (const group of Object.values(storeGroups)) {
    if (!isStoreClaimResolved(group, storeClaims)) {
      return true;
    }
  }

  return false;
}

export default function OnlineTaskView({ currentRole, onRefresh }) {
  const { updatePO } = useAppContext();
  const [pos, setPOs] = useState(() => {
    try {
      const cached = storageService.getPOs();
      return (cached || []).filter(p => p.purchaseChannel === 'ONLINE');
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('PENDING'); // PENDING | ORDERED | CLAIM | CLOSED | ALL
  const [selectedMonth, setSelectedMonth] = useState('2026-09');
  const [completedPage, setCompletedPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [viewingAttachment, setViewingAttachment] = useState(null);
  const [selectedPO, setSelectedPO] = useState(null);

  const isCompletedTab = activeTab === 'CLOSED' || activeTab === 'COMPLETED';
  const formatMoney = (n) => formatCurrency(n);

  useEffect(() => {
    fetchPOs();
  }, []);

  // Reset pagination when activeTab, month, search, or deptFilter changes
  useEffect(() => {
    setCompletedPage(1);
  }, [activeTab, selectedMonth, searchQuery, deptFilter]);

  const fetchPOs = async () => {
    setLoading(true);
    try {
      const data = await apiService.getPOs();
      // Filter only ONLINE channel purchase orders
      const onlinePOs = (data || []).filter(p => p.purchaseChannel === 'ONLINE');
      setPOs(onlinePOs);
    } catch (err) {
      console.error('Failed to fetch online tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePO = useCallback((updatedPO) => {
    setPOs(prev => prev.map(p => p.id === updatedPO.id ? updatedPO : p));
    if (updatePO) updatePO(updatedPO);
    if (onRefresh) onRefresh();

    // 🚀 Auto-switch to ORDERED tab immediately when an order is confirmed
    const s = String(updatedPO?.status || '').toUpperCase();
    if ((s === 'ORDERED' || s === 'ORDERED_PENDING_DELIVERY') && activeTab === 'PENDING') {
      setActiveTab('ORDERED');
    }
  }, [updatePO, onRefresh, activeTab]);

  // Real-time stage pipeline counts & total amount
  const metrics = useMemo(() => {
    let pending = 0;
    let ordered = 0;
    let claim = 0;
    let closed = 0;
    let totalAmount = 0;

    pos.forEach(po => {
      const s = String(po.status || '').toLowerCase();
      const statusUpper = s.toUpperCase();
      const amount = Number(po.totalAmount || po.grandTotal || po.estimatedAmount || 0);
      totalAmount += amount;

      const poHasClaim = hasUnresolvedClaim(po);

      // แท็บ "รอดำเนินการ" (PENDING)
      const isPending = isPendingPurchaseOrder(po);

      // แท็บ "ปิดงานสำเร็จ" (CLOSED)
      const ws = String(po.workflowStatus || '').toLowerCase();
      const isClosed = !isPending && !poHasClaim && (
        s === 'completed' ||
        s === 'closed' ||
        ws === 'completed' ||
        ws === 'closed' ||
        statusUpper === 'COMPLETED' ||
        statusUpper === 'CLOSED' ||
        isOrderClosed(statusUpper) ||
        Boolean(po.isClosed)
      );

      // แท็บ "รอเคลม" (CLAIM)
      const isClaim = isPendingClaimOrder(po);

      // แท็บ "สั่งซื้อแล้ว" (ORDERED)
      const isOrdered = !isPending && !isClaim && !isClosed && (
        (
          statusUpper === 'ORDERED' || 
          statusUpper === 'ORDERED_PENDING_DELIVERY' || 
          statusUpper === 'IN_TRANSIT' || 
          statusUpper === 'IN_DELIVERY' || 
          statusUpper === 'PARTIALLY_RECEIVED' || 
          statusUpper === 'PARTIAL_RECEIVED' || 
          statusUpper === 'PARTIALLY_RECEIVED_WAITING_DELIVERY' ||
          statusUpper === 'PARTIALLY_RECEIVED_IN_CLAIM' ||
          s.startsWith('waiting_delivery')
        ) && !poHasClaim
      );

      if (isPending) {
        pending++;
      } else if (isClaim) {
        claim++;
      } else if (isClosed) {
        closed++;
      } else if (isOrdered) {
        ordered++;
      }
    });

    return { pending, ordered, claim, closed, total: pos.length, totalAmount };
  }, [pos]);

  // Completed Orders filtered by selectedMonth for KPI Executive banner
  const completedOrders = useMemo(() => {
    return pos.filter(po => {
      const s = String(po.status || '').toLowerCase();
      const ws = String(po.workflowStatus || '').toLowerCase();
      const statusUpper = s.toUpperCase();
      const poHasClaim = hasUnresolvedClaim(po);
      const isClosed = !poHasClaim && (
        s === 'completed' ||
        s === 'closed' ||
        ws === 'completed' ||
        ws === 'closed' ||
        statusUpper === 'COMPLETED' ||
        statusUpper === 'CLOSED' ||
        isOrderClosed(statusUpper) ||
        Boolean(po.isClosed)
      );
      if (!isClosed) return false;

      const orderDateStr = 
        po.completedAt || 
        po.receivedAt || 
        po.receivingInfo?.receivedAt || 
        po.orderDate || 
        po.issueDate || 
        po.orderedAt || 
        po.date || 
        po.createdAt || 
        po.updatedAt || 
        (Array.isArray(po.grnHistory) && po.grnHistory[0]?.date) ||
        (Array.isArray(po.timeline) && po.timeline[po.timeline.length - 1]?.timestamp) || 
        '';
      const parsed = parseOrderYearMonth(orderDateStr);
      const year = parsed.year || 2026;
      const ymKey = parsed.ymKey || '2026-09';

      if (!selectedMonth || selectedMonth === 'ALL_YEAR' || selectedMonth === 'ALL' || selectedMonth === '2569' || selectedMonth === '2026') {
        return year === 2026 || year === 2569;
      }
      return ymKey === selectedMonth;
    });
  }, [pos, selectedMonth]);

  // Executive KPI summary metrics for selected month
  const completedKPIs = useMemo(() => {
    return calculateCompletedKPIs(completedOrders);
  }, [completedOrders]);

  // Filter tasks based on activeTab, deptFilter, searchQuery, and monthly partitioning
  const filteredTasks = useMemo(() => {
    return pos.filter(po => {
      const s = String(po.status || '').toLowerCase();
      const statusUpper = s.toUpperCase();
      const poHasClaim = hasUnresolvedClaim(po);

      // Tab filter (Strict separation - Directive 2)
      let matchTab = true;
      if (activeTab === 'PENDING') {
        matchTab = isPendingPurchaseOrder(po);
      } else if (activeTab === 'ORDERED') {
        const isOrderedStatus = (
          statusUpper === 'ORDERED' || 
          statusUpper === 'ORDERED_PENDING_DELIVERY' || 
          statusUpper === 'IN_TRANSIT' || 
          statusUpper === 'IN_DELIVERY' || 
          statusUpper === 'PARTIALLY_RECEIVED' || 
          statusUpper === 'PARTIAL_RECEIVED' || 
          statusUpper === 'PARTIALLY_RECEIVED_WAITING_DELIVERY' ||
          statusUpper === 'PARTIALLY_RECEIVED_IN_CLAIM' ||
          s.startsWith('waiting_delivery')
        );
        matchTab = isOrderedStatus && !isPendingClaimOrder(po) && !isOrderClosed(statusUpper);
      } else if (activeTab === 'CLAIM') {
        matchTab = isPendingClaimOrder(po);
      } else if (activeTab === 'CLOSED' || activeTab === 'COMPLETED') {
        const ws = String(po.workflowStatus || '').toLowerCase();
        const isClosed = !poHasClaim && (
          s === 'completed' ||
          s === 'closed' ||
          ws === 'completed' ||
          ws === 'closed' ||
          statusUpper === 'COMPLETED' ||
          statusUpper === 'CLOSED' ||
          isOrderClosed(statusUpper) ||
          Boolean(po.isClosed)
        );
        if (!isClosed) return false;

        const orderDateStr = 
          po.completedAt || 
          po.receivedAt || 
          po.receivingInfo?.receivedAt || 
          po.orderDate || 
          po.issueDate || 
          po.orderedAt || 
          po.date || 
          po.createdAt || 
          po.updatedAt || 
          (Array.isArray(po.grnHistory) && po.grnHistory[0]?.date) ||
          (Array.isArray(po.timeline) && po.timeline[po.timeline.length - 1]?.timestamp) || 
          '';
        const parsed = parseOrderYearMonth(orderDateStr);
        const year = parsed.year || 2026;
        const ymKey = parsed.ymKey || '2026-09';

        if (!selectedMonth || selectedMonth === 'ALL_YEAR' || selectedMonth === 'ALL' || selectedMonth === '2569' || selectedMonth === '2026') {
          if (year !== 2026 && year !== 2569) return false;
        } else {
          if (ymKey !== selectedMonth) return false;
        }
        matchTab = true;
      }

      // Dept filter
      const matchDept = deptFilter === 'ALL' || po.department === deptFilter;

      // Search query
      const q = searchQuery.trim().toLowerCase();
      const matchSearch = !q || (
        po.poNo?.toLowerCase().includes(q) ||
        po.prNo?.toLowerCase().includes(q) ||
        po.vendorName?.toLowerCase().includes(q) ||
        po.onlineUrl?.toLowerCase().includes(q) ||
        po.items?.some(it => it.name?.toLowerCase().includes(q) || it.code?.toLowerCase().includes(q))
      );

      return matchTab && matchDept && matchSearch;
    });
  }, [pos, activeTab, deptFilter, searchQuery, selectedMonth]);

  // Pagination parameters: 15 items per page for Completed Orders
  const PAGE_SIZE = 15;
  const totalPages = isCompletedTab ? Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE)) : 1;
  const paginatedTasks = useMemo(() => {
    if (!isCompletedTab) return filteredTasks;
    const startIdx = (completedPage - 1) * PAGE_SIZE;
    return filteredTasks.slice(startIdx, startIdx + PAGE_SIZE);
  }, [filteredTasks, isCompletedTab, completedPage]);

  return (
    <div className="w-full space-y-4 animate-fade-in pb-10 font-sans">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2.5 tracking-tight">
            <div className="w-9 h-9 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-2xs">
              <ShoppingCart className="w-4 h-4" />
            </div>
            <span>งานจัดซื้อออนไลน์ (Online Procurement Hub)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1 font-normal">
            ศูนย์จัดการคำสั่งซื้อผ่าน Shopee / Lazada / ร้านค้าออนไลน์ — บันทึกราคาจริงและตรวจสอบสถานะคำสั่งซื้อ
          </p>
        </div>

        {/* Total Value Capsule */}
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
          <div className="flex items-center gap-3 px-3 py-1.5 bg-white rounded-xl border border-slate-200/80 shadow-2xs">
            <div className="text-right">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">มูลค่าคำขอในมือ</span>
              <span className="font-mono font-bold text-slate-800 text-sm">
                ฿{metrics.totalAmount.toLocaleString()}
              </span>
            </div>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center font-mono text-xs font-bold">
              {metrics.total}
            </div>
          </div>
        </div>
      </div>

      {/* 1. Unified Compact Segmented Filter Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-white p-2 sm:p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
        {/* Left: Segmented Status Tabs */}
        <div className="bg-slate-100/80 p-1 rounded-xl flex items-center gap-1 border border-slate-200/60 max-w-full overflow-x-auto custom-scrollbar">
          {/* Step 1: Pending */}
          <button
            type="button"
            onClick={() => setActiveTab('PENDING')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'PENDING'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium'
            }`}
          >
            <Clock className={`w-3.5 h-3.5 ${activeTab === 'PENDING' || metrics.pending > 0 ? 'text-indigo-600' : 'text-slate-400'}`} />
            <span>รอดำเนินการ</span>
            <span className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] font-bold ${
              metrics.pending > 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200/60 text-slate-400'
            }`}>
              {metrics.pending}
            </span>
          </button>

          {/* Step 2: Ordered */}
          <button
            type="button"
            onClick={() => setActiveTab('ORDERED')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'ORDERED'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium'
            }`}
          >
            <Truck className={`w-3.5 h-3.5 ${activeTab === 'ORDERED' ? 'text-indigo-600' : 'text-slate-400'}`} />
            <span>สั่งซื้อแล้ว</span>
            <span className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] font-bold ${
              metrics.ordered > 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200/60 text-slate-400'
            }`}>
              {metrics.ordered}
            </span>
          </button>

          {/* Step 3: Claim (Urgent SLA Pulse Indicator) */}
          <button
            type="button"
            onClick={() => setActiveTab('CLAIM')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'CLAIM'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium'
            }`}
          >
            <AlertTriangle className={`w-3.5 h-3.5 ${activeTab === 'CLAIM' || metrics.claim > 0 ? 'text-rose-600' : 'text-slate-400'}`} />
            <span>รอเคลม</span>
            {metrics.claim > 0 && (
              <span className="inline-flex items-center bg-rose-500 text-white font-bold px-2 py-0.5 rounded-full text-xs animate-pulse">
                <span className="relative flex h-2 w-2 mr-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                </span>
                <span className="font-mono">{metrics.claim}</span>
              </span>
            )}
          </button>

          {/* Step 4: Closed */}
          <button
            type="button"
            onClick={() => setActiveTab('CLOSED')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'CLOSED'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium'
            }`}
          >
            <CheckCircle2 className={`w-3.5 h-3.5 ${activeTab === 'CLOSED' ? 'text-emerald-600' : 'text-slate-400'}`} />
            <span>ปิดงานสำเร็จ</span>
            <span className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] font-bold ${
              metrics.closed > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200/60 text-slate-400'
            }`}>
              {metrics.closed}
            </span>
          </button>

          {/* All View */}
          <button
            type="button"
            onClick={() => setActiveTab('ALL')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'ALL'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-500 hover:text-slate-800 hover:bg-white/60 font-medium'
            }`}
          >
            <span>ทั้งหมด</span>
            <span className="font-mono text-[10px] text-slate-400 font-semibold">({metrics.total})</span>
          </button>
        </div>

        {/* Right: Search & Department Filter */}
        <div className="flex items-center gap-2 flex-1 md:max-w-md justify-end">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="ค้นหา PO, PR, สินค้า, ร้านค้า..."
              className="w-full bg-slate-50 hover:bg-slate-100/70 focus:bg-white border border-slate-200/90 rounded-xl pl-9 pr-8 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 shadow-2xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 rounded-full cursor-pointer"
                title="ล้างคำค้นหา"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
            className="bg-slate-50 hover:bg-slate-100/70 focus:bg-white border border-slate-200/90 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-800 shadow-2xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer shrink-0"
          >
            <option value="ALL">ทุกแผนก (ALL)</option>
            <option value="PD">ฝ่ายผลิต (PD)</option>
            <option value="QC">ฝ่าย QC</option>
          </select>
        </div>
      </div>

      {/* Monthly Partitioning & Filter Controls for Completed Tab */}
      {isCompletedTab && (
        <div className="space-y-3">
          {/* Month Selector Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Month Navigation Pill: [ < ] [ 📅 กันยายน 2569 ▾ ] [ > ] */}
              <div className="flex items-center bg-slate-100/90 border border-slate-200/80 rounded-xl p-0.5 shadow-2xs">
                <button
                  type="button"
                  onClick={() => setSelectedMonth(getPrevMonth(selectedMonth))}
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-white rounded-lg transition-colors cursor-pointer"
                  title="เดือนก่อนหน้า"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="relative flex items-center px-2.5 py-1 gap-1.5 font-medium text-xs text-slate-800 cursor-pointer">
                  <span>📅 {formatThaiMonth(selectedMonth)} ▾</span>
                  <select
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    title="เลือกรอบบัญชี"
                  >
                    <option value="2026-09">กันยายน 2569</option>
                    <option value="2026-08">สิงหาคม 2569</option>
                    <option value="2026-07">กรกฎาคม 2569</option>
                    <option value="2026-06">มิถุนายน 2569</option>
                    <option value="2026-05">พฤษภาคม 2569</option>
                    <option value="2026-04">เมษายน 2569</option>
                    <option value="2026-03">มีนาคม 2569</option>
                    <option value="2026-02">กุมภาพันธ์ 2569</option>
                    <option value="2026-01">มกราคม 2569</option>
                    <option value="ALL_YEAR">ทั้งหมดในปี 2569</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedMonth(getNextMonth(selectedMonth))}
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-white rounded-lg transition-colors cursor-pointer"
                  title="เดือนถัดไป"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Quick Chips: [ เดือนนี้ ] [ เดือนก่อนหน้า ] [ ทั้งหมดในปีนี้ ] */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedMonth('2026-09')}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-all cursor-pointer ${
                    selectedMonth === '2026-09'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-bold shadow-2xs'
                      : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  เดือนนี้
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMonth('2026-08')}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-all cursor-pointer ${
                    selectedMonth === '2026-08'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-bold shadow-2xs'
                      : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  เดือนก่อนหน้า
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMonth('ALL_YEAR')}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-all cursor-pointer ${
                    selectedMonth === 'ALL_YEAR'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-bold shadow-2xs'
                      : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  ทั้งหมดในปีนี้
                </button>
              </div>
            </div>

            <div className="text-[11px] text-slate-400">รอบบัญชี: {formatThaiMonth(selectedMonth)}</div>
          </div>

          {/* Monthly Procurement KPI Summary Chip */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-3 bg-slate-50 border border-slate-200/80 rounded-xl mb-3 text-xs">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-slate-500">
                คำสั่งซื้อที่ปิดงาน: <strong className="text-slate-800 font-mono text-sm">{completedOrders.length}</strong> ฉบับ
              </span>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500">
                ยอดจัดซื้อจริง: <strong className="text-slate-800 font-mono text-sm">฿{formatMoney(completedKPIs.totalActualSpent)}</strong>
              </span>
              {completedKPIs.totalRefunds > 0 && (
                <>
                  <span className="text-slate-300">|</span>
                  <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-semibold">
                    💰 ได้รับเงินคืนเข้าแผนก: +฿{formatMoney(completedKPIs.totalRefunds)}
                  </span>
                </>
              )}
            </div>
            <div className="text-[11px] text-slate-400">รอบบัญชี: {formatThaiMonth(selectedMonth)}</div>
          </div>
        </div>
      )}

      {/* Task Cards List */}
      {loading ? (
        <div className="text-center p-12 text-slate-500 font-medium animate-pulse">กำลังโหลดข้อมูลรายการจัดซื้อ...</div>
      ) : filteredTasks.length === 0 ? (
        <EmptyState 
          icon={ShoppingCart}
          title={
            searchQuery || deptFilter !== 'ALL'
              ? 'ไม่พบรายการที่ตรงกับการค้นหา'
              : activeTab === 'PENDING'
              ? 'ไม่มีงานค้างรอสั่งซื้อ (ดำเนินการครบถ้วนแล้ว)'
              : activeTab === 'ORDERED'
              ? 'ไม่มีรายการที่อยู่ระหว่างจัดส่ง'
              : activeTab === 'CLOSED' || activeTab === 'COMPLETED'
              ? 'ยังไม่มีรายการที่ปิดงานตรวจรับในรอบบัญชีนี้'
              : 'ไม่พบรายการสั่งซื้อออนไลน์'
          } 
          description={
            searchQuery || deptFilter !== 'ALL'
              ? 'ลองปรับเปลี่ยนคำค้นหาหรือเปลี่ยนตัวกรองแผนกเพื่อดูรายการอื่น'
              : activeTab === 'PENDING'
              ? 'คำสั่งซื้อออนไลน์ทั้งหมดได้รับการจัดการเรียบร้อยแล้ว เมื่อมี PR ออนไลน์ใหม่ที่ผ่านการอนุมัติ จะมาปรากฏที่นี่โดยอัตโนมัติ'
              : activeTab === 'ORDERED'
              ? 'เมื่อท่านกดยืนยันการสั่งซื้อแล้ว เอกสารจะย้ายมารอจัดส่งและส่งต่อให้แผนกตรวจรับที่นี่'
              : activeTab === 'CLOSED' || activeTab === 'COMPLETED'
              ? 'ลองเลือกดูรอบบัญชีอื่น หรือกด "ทั้งหมดในปีนี้" เพื่อดูประวัติคำสั่งซื้อที่ปิดงานสำเร็จ'
              : 'ยังไม่มีประวัติรายการจัดซื้อออนไลน์ในสถานะนี้'
          }
          actionButton={
            (isCompletedTab && selectedMonth !== 'ALL_YEAR') ? (
              <button
                type="button"
                onClick={() => setSelectedMonth('ALL_YEAR')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold text-xs rounded-xl border border-indigo-200 transition-colors shadow-2xs cursor-pointer"
              >
                <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                <span>ดูคำสั่งซื้อทั้งหมดในปี 2569</span>
              </button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-2.5">
          {paginatedTasks.map(po => (
            <OnlineOrderCard 
              key={po.id} 
              po={po} 
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              currentRole={currentRole}
              onViewAttachment={setViewingAttachment}
              onShowDetails={setSelectedPO}
              onUpdate={handleUpdatePO} 
            />
          ))}
        </div>
      )}

      {/* Pagination Controls for Completed Orders */}
      {isCompletedTab && filteredTasks.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-slate-200/80 rounded-xl mt-3 text-xs shadow-2xs">
          <div className="text-slate-500">
            แสดง {Math.min((completedPage - 1) * PAGE_SIZE + 1, filteredTasks.length)} - {Math.min(completedPage * PAGE_SIZE, filteredTasks.length)} จากทั้งหมด {filteredTasks.length} รายการ
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={completedPage <= 1}
              onClick={() => setCompletedPage(prev => Math.max(1, prev - 1))}
              className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors font-medium flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>ก่อนหน้า</span>
            </button>
            <span className="text-slate-600 font-medium px-2">
              หน้า <strong className="font-mono text-slate-800">{completedPage}</strong> จาก <strong className="font-mono text-slate-800">{totalPages}</strong>
            </span>
            <button
              type="button"
              disabled={completedPage >= totalPages}
              onClick={() => setCompletedPage(prev => Math.min(totalPages, prev + 1))}
              className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors font-medium flex items-center gap-1"
            >
              <span>ถัดไป</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* AttachmentViewerModal */}
      {viewingAttachment && (
        <AttachmentViewerModal
          file={viewingAttachment}
          onClose={() => setViewingAttachment(null)}
        />
      )}

      {/* PO Detail Modal */}
      {selectedPO && (
        <PODetailsModal
          selectedPO={selectedPO}
          currentRole={currentRole}
          onClose={() => setSelectedPO(null)}
          onRefresh={handleUpdatePO}
        />
      )}
    </div>
  );
}

export const OnlineTaskCard = OnlineOrderCard;
export { OnlineOrderCard };
