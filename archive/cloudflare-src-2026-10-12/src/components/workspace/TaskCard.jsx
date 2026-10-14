import React from 'react';
import { Building2, Store, AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';
import { PR_STATUS, PO_STATUS } from '../../config/constants.js';
import { useAppContext } from '../../context/AppContext';

const formatDateTime = (dateVal) => {
  if (!dateVal) return '-';
  try {
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    if (typeof dateVal === 'string' && !dateVal.includes('T') && !dateVal.includes(':')) {
      return `${day}/${month}/${year}`;
    }
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return String(dateVal);
  }
};

const getDepartmentLabel = (deptCode) => {
  if (!deptCode) return '';
  const code = String(deptCode).trim().toUpperCase();
  const map = {
    PD: 'ฝ่ายผลิต (PD)',
    QC: 'ฝ่ายควบคุมคุณภาพ (QC)',
    QA: 'ฝ่ายประกันคุณภาพ (QA)',
    WH: 'ฝ่ายคลังสินค้า (WH)',
    PUR: 'ฝ่ายจัดซื้อ (PUR)',
    PU: 'ฝ่ายจัดซื้อ (PU)',
    ENG: 'ฝ่ายวิศวกรรม (ENG)',
    MA: 'ฝ่ายซ่อมบำรุง (MA)',
    AC: 'ฝ่ายบัญชี (AC)',
    HR: 'ฝ่ายบุคคล (HR)',
    IT: 'ฝ่ายไอที (IT)'
  };
  return map[code] || `แผนก ${deptCode}`;
};

const sanitizeRequesterName = (name, department) => {
  if (!name) return department ? getDepartmentLabel(department) : 'ไม่ระบุผู้ขอซื้อ';
  
  let cleanName = String(name).trim();
  let extractedDept = department ? String(department).trim() : '';

  const match = cleanName.match(/^(.*?)\s*\(([^)]+)\)$/);
  if (match) {
    cleanName = match[1].trim();
    if (!extractedDept) {
      extractedDept = match[2].trim();
    }
  }

  const deptLabel = extractedDept ? getDepartmentLabel(extractedDept) : '';

  if (cleanName && deptLabel) {
    return `${cleanName} • ${deptLabel}`;
  }
  return cleanName || deptLabel || 'ไม่ระบุผู้ขอซื้อ';
};

/**
 * TaskCard Component
 * Modern Minimal Bento Card (Linear/Raycast style) for PR & PO documents
 */
export default function TaskCard({ task, activeTab, currentRole, onClick, onReorderShortage }) {
  const isPR = task.docType === 'PR' || (!task.docType && (task.prNo || String(task.id || '').startsWith('PR-')));
  const { handleEditPR } = useAppContext() || {};

  const isClaimInProcess = task.status === 'PARTIALLY_RECEIVED_IN_CLAIM';
  const isRefundCompleted = task.status === 'COMPLETED_WITH_REFUND';

  const handleReorder = (e) => {
    e.stopPropagation();
    // 1. Gather shortage & damaged items
    const shortageItems = [];
    (task.items || []).forEach(it => {
      const shortQty = Number(it.shortageQty || 0);
      const dmgQty = Number(it.damagedQty || 0);
      const neededQty = shortQty + dmgQty;
      if (neededQty > 0) {
        shortageItems.push({
          productId: it.productId || it.code,
          code: it.code,
          name: it.name,
          qty: neededQty,
          purchaseQty: neededQty,
          price: it.actualPrice ?? it.unitPrice ?? it.price ?? 0,
          unit: it.purchaseUnit || it.unit || 'ชิ้น',
          purchaseUnit: it.purchaseUnit || it.unit || 'ชิ้น',
          platform: it.storePlatform || it.platform || 'Shopee',
          storeName: it.actualStoreName || it.storeName || ''
        });
      }
    });

    const itemsToPrefill = shortageItems.length > 0 ? shortageItems : (task.items || []).map(it => ({
      productId: it.productId || it.code,
      code: it.code,
      name: it.name,
      qty: Number(it.purchaseQty ?? it.qty ?? 1),
      purchaseQty: Number(it.purchaseQty ?? it.qty ?? 1),
      price: it.actualPrice ?? it.unitPrice ?? it.price ?? 0,
      unit: it.purchaseUnit || it.unit || 'ชิ้น',
      purchaseUnit: it.purchaseUnit || it.unit || 'ชิ้น'
    }));

    const prefillDraft = {
      department: task.department,
      purchaseChannel: task.purchaseChannel || 'ONLINE',
      vendorId: task.vendorId,
      note: `ขอซื้อเฉพาะยอดที่ขาด (จาก PO: ${task.poNo || task.id} ที่ได้รับเงินคืนเรียบร้อยแล้ว)`,
      items: itemsToPrefill
    };

    if (onReorderShortage) {
      onReorderShortage(prefillDraft);
    } else if (handleEditPR) {
      handleEditPR(prefillDraft);
    }
  };
  
  const docNo = task.documentNo || task.docNo || task.prNo || task.poNo || task.id || (isPR ? 'PR-XXXX' : 'PO-XXXX');
  const dateVal = task.createdAt || task.requestedDate || task.date || task.issueDate;
  
  // Format Title / Item name
  let title = task.title || (task.items && task.items.length > 0 
    ? (task.items.length === 1 
        ? task.items[0].name 
        : `${task.items[0].name} (+${task.items.length - 1} รายการ)`)
    : (isPR ? 'ใบขอซื้อ' : 'ใบสั่งซื้อ'));

  const isClaimActionPending = !isPR && task.isClaim === true && (activeTab === 'todo' || activeTab === 'action');
  const isPartialPO = !isPR && ['PARTIAL', 'PARTIAL_RECEIVED', 'WAITING_DELIVERY_ROUND_2'].includes(task.status) && (activeTab === 'todo' || activeTab === 'action');
  if (isPartialPO) {
    if (task.status === 'WAITING_DELIVERY_ROUND_2') {
      title = `ตรวจรับพัสดุรอบที่ ${task.receiptRound || 2} (สินค้าทดแทน) - PO: ${docNo}`;
    } else {
      const remainingCount = (task.items || []).filter(it => {
         const q = Number(it.quantity || 0);
         const rq = Number(it.receivedQty || 0);
         const rem = it.remainingQty !== undefined ? Number(it.remainingQty) : (q - rq);
         return rem > 0;
      }).length;
      title = `ตรวจรับพัสดุรอบที่ ${task.receiptRound || 2} (ค้างรับ ${remainingCount} รายการ) - PO: ${docNo}`;
    }
  }

  const getVendorDisplayName = (vendorData) => {
    if (!vendorData) return 'ไม่ระบุผู้ขาย';
    if (typeof vendorData === 'string') return vendorData;
    if (typeof vendorData === 'object') {
      return vendorData.name || vendorData.companyName || vendorData.code || 'ไม่ระบุผู้ขาย';
    }
    return String(vendorData);
  };

  // Vendor / Requester Name
  const entityName = isPR 
    ? sanitizeRequesterName(task.requestedBy || task.applicantName1 || task.createdBy, task.department)
    : getVendorDisplayName(task.vendorName || task.vendor);

  // Purchase Channel / Tag
  const channelLabel = task.purchaseChannel === 'ONLINE' 
    ? 'จัดซื้อออนไลน์' 
    : (task.purchaseChannel === 'SELF' 
        ? 'สั่งซื้อเอง' 
        : (task.department && !isPR ? getDepartmentLabel(task.department) : 'สั่งซื้อเอง'));

  const amount = task.amount ?? task.grandTotal ?? task.totalAmount ?? 0;
  
  let statusInfo = isPR 
    ? (PR_STATUS[task.status] || { label: task.status, color: 'bg-slate-50 text-slate-700 border-slate-200' })
    : (PO_STATUS[task.status] || { label: task.status, color: 'bg-slate-50 text-slate-700 border-slate-200' });
    
  if (!isPR && task.status === 'CLOSED' && task.claimStatus === 'WRITE_OFF') {
    statusInfo = { label: 'ตัดจำหน่าย/ยกเว้นเคลม', color: 'bg-slate-100 text-slate-700 border-slate-300 font-bold' };
  }

  const canViewPrice = currentRole?.canViewBudget !== false;

  const actionText = (activeTab === 'todo' || activeTab === 'action')
    ? (isPR && currentRole?.level >= 2 ? 'ตรวจสอบ' : 'ดูรายละเอียด')
    : 'ดูรายละเอียด';

  return (
    <div 
      onClick={onClick}
      className="group bg-white border border-slate-200/80 hover:border-slate-300 rounded-2xl p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between cursor-pointer w-full h-full relative"
    >
      {/* ── 1. Two-Tier Card Header (Directive 1) ── */}
      <div>
        {/* บรรทัดที่ 1: เลขที่เอกสาร (ซ้าย) vs สถานะงาน (ขวา) */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="inline-flex items-center gap-1.5">
            <span className={`px-2 py-0.5 rounded-md border text-xs font-mono font-bold ${
              isPR 
                ? 'bg-indigo-50 border-indigo-100 text-indigo-700' 
                : 'bg-emerald-50 border-emerald-100 text-emerald-700'
            }`}>
              {task.type || (isPR ? 'PR' : 'PO')}: {docNo}
            </span>
          </div>
          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border shrink-0 ${
            statusInfo?.color || 'bg-amber-50 text-amber-700 border-amber-200'
          }`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80"></span>
            <span>{task.statusLabel || statusInfo?.label || task.status || 'รออนุมัติ'}</span>
          </span>
        </div>

        {/* บรรทัดที่ 2: วันที่และเวลาที่ฟอร์แมตเรียบร้อย */}
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 mb-2.5">
          <span>🕒</span>
          <span>{formatDateTime(dateVal)}</span>
        </div>

        {/* Special Claim / Refund Alerts (Directive 2) */}
        {isClaimInProcess && (
          <div className="mb-2.5 p-2 bg-amber-50 border border-amber-200/90 rounded-xl flex items-center gap-1.5 text-xs font-bold text-amber-800 animate-fade-in">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span>⚠️ ได้รับของบางส่วน (กำลังเคลมส่วนที่เหลือ)</span>
          </div>
        )}

        {isRefundCompleted && (
          <div className="mb-2.5 space-y-1.5 animate-fade-in">
            <div className="p-2 bg-emerald-50 border border-emerald-200/90 rounded-xl flex items-center gap-1.5 text-xs font-bold text-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>✓ ได้รับเงินคืน ฿{Number(task.refundAmount || task.claimResolution?.refundAmount || 0).toLocaleString()} เรียบร้อย</span>
            </div>
            <button
              type="button"
              onClick={handleReorder}
              className="w-full h-8 px-3 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-2xs hover:shadow-xs active:scale-98"
              title="สร้างใบขอซื้อใหม่เฉพาะสินค้าที่ขาดหรือชำรุด"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>🔄 ขอซื้อเฉพาะยอดที่ขาด</span>
            </button>
          </div>
        )}
      </div>

      {/* ── 2. Card Body: Item Name & Minimal Metadata Chip ── */}
      <div className="flex-1 mt-1">
        <h4 
          className="text-sm font-bold text-slate-900 line-clamp-1 leading-snug group-hover:text-indigo-600 transition-colors" 
          title={title}
        >
          {title}
        </h4>

        <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-xl bg-slate-50/80 border border-slate-100 text-xs text-slate-600">
          {isPR ? (
            <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          ) : (
            <Store className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <span className="truncate font-medium text-slate-700 flex-1" title={entityName}>
            {entityName}
          </span>
          <span className="text-slate-300">•</span>
          <span className="text-indigo-600 font-semibold text-[11px] shrink-0">
            {channelLabel}
          </span>
        </div>
      </div>

      {/* ── 3. Card Footer: Net Amount & Minimal Action Button on same baseline ── */}
      <div className="border-t border-slate-100 pt-3.5 mt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">มูลค่าสุทธิ</p>
          <p className="text-base font-black font-mono text-slate-900 leading-tight tabular-nums">
            {canViewPrice 
              ? `฿${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
              : '฿ ••••••'}
          </p>
        </div>

        {isClaimActionPending ? (
          <button
            type="button"
            className="h-8 px-3.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs hover:shadow-xs transition-all active:scale-95 whitespace-nowrap cursor-pointer shrink-0 max-w-[160px]"
          >
            <span className="truncate">จัดการเคลม / ติดต่อร้าน</span>
            <span className="text-xs shrink-0">➔</span>
          </button>
        ) : isPartialPO ? (
          <div className="flex items-center gap-2 shrink-0 max-w-[160px]">
            {task.purchaseChannel !== 'ONLINE' && task.status !== 'WAITING_DELIVERY_ROUND_2' && task.claimStatus !== 'PENDING' && task.claimStatus !== 'IN_CLAIM' && (
              <span className="text-[10px] font-medium text-amber-600 underline cursor-pointer hover:text-amber-800 whitespace-nowrap hidden sm:inline-block">
                ส่งเคลม
              </span>
            )}
            <button
              type="button"
              className="h-8 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center justify-between gap-1.5 shadow-2xs hover:shadow-xs transition-all active:scale-95 cursor-pointer w-full"
            >
              <span className="truncate">{task.status === 'WAITING_DELIVERY_ROUND_2' ? 'ตรวจรับรอบ 2' : 'ตรวจรับรอบ 2'}</span>
              <span className="text-xs shrink-0">➔</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="h-8 px-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs hover:shadow-xs transition-all active:scale-95 whitespace-nowrap cursor-pointer"
          >
            <span>{actionText}</span>
            <span className="text-xs">➔</span>
          </button>
        )}
      </div>
    </div>
  );
}
