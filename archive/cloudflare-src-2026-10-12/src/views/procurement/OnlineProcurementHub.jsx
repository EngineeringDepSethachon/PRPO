import OnlineTaskView, { 
  hasUnresolvedClaim, 
  checkPOHasGRN,
  checkPOHasDispute,
  isOrderClosed,
  isOrderInClaim,
  OnlineOrderCard, 
  OnlineTaskCard 
} from '../OnlineTaskView';
import { calculateDisputeMetrics } from './OnlineOrderCard';
import { isPendingPurchaseOrder, isPendingClaimOrder } from '../../services/procurementService';

/**
 * ฟังก์ชันคัดแยกรายการคำสั่งซื้อออนไลน์ตามแท็บ (Tab Filtering Logic)
 * 🛡️ Lifecycle Guard: แยกสถานะอย่างเด็ดขาด ป้องกันของที่ยังไม่ถึงคลังหลุดไปแท็บเคลม
 */
export const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

export function formatThaiMonth(monthStr) {
  if (!monthStr || monthStr === 'ALL') return 'ทุกรอบบัญชี';
  if (monthStr === 'ALL_YEAR') return 'ตลอดปี 2569';
  const parts = String(monthStr).split('-');
  if (parts.length === 2) {
    const year = parseInt(parts[0], 10) + 543;
    const monthIdx = parseInt(parts[1], 10) - 1;
    return `${THAI_MONTHS[monthIdx] || ''} ${year}`;
  }
  return monthStr;
}

export function getPrevMonth(currentMonthStr) {
  if (!currentMonthStr || currentMonthStr === 'ALL' || currentMonthStr === 'ALL_YEAR') {
    return '2026-08';
  }
  const [y, m] = currentMonthStr.split('-').map(Number);
  let newY = y;
  let newM = m - 1;
  if (newM < 1) {
    newM = 12;
    newY -= 1;
  }
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

export function getNextMonth(currentMonthStr) {
  if (!currentMonthStr || currentMonthStr === 'ALL' || currentMonthStr === 'ALL_YEAR') {
    return '2026-10';
  }
  const [y, m] = currentMonthStr.split('-').map(Number);
  let newY = y;
  let newM = m + 1;
  if (newM > 12) {
    newM = 1;
    newY += 1;
  }
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

export const parseOrderYearMonth = (dateInput) => {
  if (!dateInput) return { year: null, month: null, ymKey: null };
  const str = String(dateInput).trim();
  if (!str) return { year: null, month: null, ymKey: null };
  
  // Case 1: DD/MM/YYYY or DD/MM/YYYY HH:mm:ss or DD/MM/YY
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dmyMatch) {
    let year = parseInt(dmyMatch[3], 10);
    if (year === 69 || year === 26) year = 2026;
    else if (year < 100) year = 2000 + year;
    else if (year > 2400) year -= 543; // Convert Thai Buddhist Era (e.g. 2569 -> 2026)
    const month = String(parseInt(dmyMatch[2], 10)).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  // Case 2: ISO YYYY-MM-DD or YYYY-MM or ISO timestamp
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})/);
  if (isoMatch) {
    let year = parseInt(isoMatch[1], 10);
    if (year > 2400) year -= 543;
    const month = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  // Fallback: Date object parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    let year = parsed.getFullYear();
    if (year > 2400) year -= 543;
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  return { year: null, month: null, ymKey: null };
};

export function calculateCompletedKPIs(completedOrders = []) {
  let totalActualSpent = 0;
  let totalRefunds = 0;

  (completedOrders || []).forEach(po => {
    let refund = 0;
    if (po.totalRefunded !== undefined && po.totalRefunded !== null) {
      refund = Number(po.totalRefunded);
    } else if (po.refundAmount !== undefined && po.refundAmount !== null) {
      refund = Number(po.refundAmount);
    } else if (po.storeClaims) {
      Object.values(po.storeClaims).forEach(sc => {
        if (sc?.isResolved && (sc.type === 'REFUND' || sc.resolutionType === 'REFUND' || sc.actionType === 'REFUND')) {
          refund += Number(sc.refundAmount || 0);
        }
      });
    }
    
    if (refund === 0 && Array.isArray(po.items) && po.refundAmount === undefined) {
      po.items.forEach(it => {
        if (it.refundAmount) {
          refund += Number(it.refundAmount);
        } else if (it.claimResolution === 'REFUND') {
          const qty = Number(it.damagedQty || it.shortageQty || 0);
          const price = Number(it.actualPrice || it.unitPrice || 0);
          refund += qty * price;
        }
      });
    }

    const gross = Number(po.grandTotal ?? po.totalAmount ?? po.estimatedAmount ?? 0);
    let spent = Number(po.actualTotal ?? po.actualAmount ?? (gross - refund));
    if (spent <= 0 || isNaN(spent)) {
      spent = gross;
    }
    refund = Math.max(0, gross - spent);
    if (refund === 0 && Number(po.refundAmount) > 0 && spent < gross) {
      refund = Number(po.refundAmount);
    }

    totalActualSpent += spent;
    totalRefunds += refund;
  });

  return {
    count: (completedOrders || []).length,
    totalActualSpent,
    totalRefunds
  };
}

/**
 * ฟังก์ชันคัดแยกรายการคำสั่งซื้อออนไลน์ตามแท็บ (Tab Filtering Logic)
 * 🛡️ Lifecycle Guard: แยกสถานะอย่างเด็ดขาด ป้องกันของที่ยังไม่ถึงคลังหลุดไปแท็บเคลม
 * รองรับการแบ่งส่วนข้อมูลตามรอบบัญชีรายเดือน (selectedMonth) สำหรับแท็บ CLOSED / COMPLETED
 */
export function filteredOrders(orders, activeTab, selectedMonth = null) {
  return (orders || []).filter(po => {
    const s = String(po.status || '').toLowerCase();
    const statusUpper = s.toUpperCase();
    const poHasClaim = hasUnresolvedClaim(po);

    // แท็บ "รอดำเนินการ" (PENDING)
    if (activeTab === 'PENDING') {
      return isPendingPurchaseOrder(po);
    }

    // แท็บ "สั่งซื้อแล้ว" (ORDERED)
    if (activeTab === 'ORDERED') {
      const isOrderedStatus = (
        po.status === 'ORDERED' ||
        po.status === 'IN_TRANSIT' ||
        po.status === 'PARTIALLY_RECEIVED' ||
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
      return isOrderedStatus && !isPendingClaimOrder(po) && !isOrderClosed(statusUpper);
    }

    // แท็บ "รอเคลม" (CLAIM)
    if (activeTab === 'CLAIM') {
      return isPendingClaimOrder(po);
    }

    // แท็บ "ปิดงานสำเร็จ" (CLOSED หรือ COMPLETED)
    if (activeTab === 'CLOSED' || activeTab === 'COMPLETED') {
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
        return year === 2026 || year === 2569;
      }
      return ymKey === selectedMonth;
    }

    return true;
  });
}

export const filterOrdersByTab = filteredOrders;

/**
 * ฟังก์ชันคำนวณตัวนับ Badge และยอดรวมของแต่ละแท็บ
 */
export function getTabMetrics(orders) {
  let pending = 0;
  let ordered = 0;
  let claim = 0;
  let closed = 0;
  let totalAmount = 0;

  (orders || []).forEach(po => {
    const s = String(po.status || '').toLowerCase();
    const statusUpper = s.toUpperCase();
    const amount = Number(po.totalAmount || po.grandTotal || po.estimatedAmount || 0);
    totalAmount += amount;

    const poHasClaim = hasUnresolvedClaim(po);

    const isPending = isPendingPurchaseOrder(po);

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

    const isClaim = isPendingClaimOrder(po);

    const isOrdered = !isPending && !isClaim && !isClosed && (
      (
        po.status === 'ORDERED' ||
        po.status === 'IN_TRANSIT' ||
        po.status === 'PARTIALLY_RECEIVED' ||
        statusUpper === 'ORDERED' ||
        statusUpper === 'ORDERED_PENDING_DELIVERY' ||
        statusUpper === 'IN_TRANSIT' ||
        statusUpper === 'IN_DELIVERY' ||
        statusUpper === 'PARTIALLY_RECEIVED' ||
        statusUpper === 'PARTIAL_RECEIVED' ||
        s.startsWith('waiting_delivery')
      ) && !po.isInClaim && po.status !== 'IN_CLAIM' && statusUpper !== 'IN_CLAIM'
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

  return { pending, ordered, claim, closed, total: (orders || []).length, totalAmount };
}

export default OnlineTaskView;
export const OnlineProcurementHub = OnlineTaskView;
export { 
  OnlineTaskView, 
  hasUnresolvedClaim, 
  checkPOHasGRN,
  checkPOHasDispute,
  isOrderClosed,
  isOrderInClaim,
  calculateDisputeMetrics,
  OnlineOrderCard, 
  OnlineTaskCard 
};
