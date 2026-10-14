import React, { useMemo } from 'react';
import { AlertTriangle, Zap, CheckCircle2 } from 'lucide-react';

export default function LowStockTable({ products = [], onQuickPR }) {
  const resolvedLowStockItems = useMemo(() => {
    const flatList = (products || [])
      .flatMap((p) => (Array.isArray(p) ? p : [p]))
      .filter((p) => p && typeof p === 'object');

    // 1. กรองสินค้าจากคลังหลัก (ต้องมี rop > 0 และ stock <= rop)
    let items = flatList
      .map((p) => {
        const actualItem = p.product || p.item || p.inventory || p;
        if (!actualItem || typeof actualItem !== 'object') return null;

        const master = flatList.find(
          (m) =>
            m &&
            m !== actualItem &&
            ((m.id && (m.id === actualItem.id || m.id === actualItem.itemId)) ||
              (m.sku && (m.sku === actualItem.sku || m.sku === actualItem.code)) ||
              (m.code && (m.code === actualItem.code || m.code === actualItem.sku)))
        );

        const isInactive =
          actualItem.isActive === false || String(actualItem.status || '').toUpperCase() === 'INACTIVE';
        const name =
          actualItem.name || actualItem.itemName || actualItem.nameTh || actualItem.title || master?.name;
        const sku =
          actualItem.sku || actualItem.code || actualItem.itemCode || master?.sku || master?.code || '-';
        const currentStock = Number(
          actualItem.currentStock ??
            actualItem.stockBalance ??
            actualItem.stock ??
            actualItem.balance ??
            0
        );
        const rop = Number(
          actualItem.rop ?? actualItem.reorderPoint ?? actualItem.minStock ?? 0
        );
        const unit = actualItem.unit || actualItem.stockUnit || 'ชิ้น';
        const department = actualItem.department || actualItem.category || 'PD';

        return {
          id: actualItem.id || master?.id || `item-${Math.random()}`,
          department,
          sku: String(sku).trim(),
          name,
          currentStock,
          stock: currentStock,
          rop,
          reorderPoint: rop,
          unit,
          isInactive
        };
      })
      .filter(
        (item) =>
          item &&
          !item.isInactive &&
          Boolean(item.name && item.name !== 'สินค้าไม่มีชื่อ') &&
          item.rop > 0 &&
          item.currentStock <= item.rop
      );

    return items || [];
  }, [products]);

  return (
    <div className="bg-white border border-slate-200/70 rounded-3xl overflow-hidden shadow-sm">
      {/* Header Zone */}
      <div className="p-5 sm:px-6 bg-white border-b border-slate-100 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-rose-50 text-rose-600 rounded-2xl border border-rose-100 flex items-center justify-center shrink-0 shadow-2xs">
            <AlertTriangle className="w-5 h-5 text-rose-500" />
          </div>
          <div>
            <h3 className="font-bold text-sm sm:text-base text-slate-900 tracking-tight flex items-center gap-2">
              <span>สินค้าแตะจุดสั่งซื้อซ้ำ</span>
              <span className="text-xs font-normal text-slate-400 font-sans hidden sm:inline">(Low Stock Alert)</span>
            </h3>
            <p className="text-xs text-slate-500 font-normal mt-0.5">
              รายการที่ยอดคงเหลือในคลังแตะหรือต่ำกว่าจุดสั่งซื้อซ้ำ (ROP)
            </p>
          </div>
        </div>

        {resolvedLowStockItems.length > 0 && (
          <span className="text-xs bg-rose-50 text-rose-700 font-semibold px-3 py-1 rounded-full border border-rose-200/80 shadow-2xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
            <span>{resolvedLowStockItems.length} รายการเร่งด่วน</span>
          </span>
        )}
      </div>

      {/* Content Feed */}
      {resolvedLowStockItems.length === 0 ? (
        <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center gap-2">
          <div className="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shadow-2xs border border-emerald-100">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-xs sm:text-sm font-semibold text-slate-800">ไม่มีสินค้าคงเหลือต่ำกว่าจุด Reorder Point ในขณะนี้</p>
          <p className="text-xs text-slate-400">ระดับสต็อกสินค้าทุกรายการอยู่ในเกณฑ์ปกติ</p>
        </div>
      ) : (
        <div className="p-4 sm:p-5 space-y-2.5 max-h-[420px] overflow-y-auto custom-scrollbar">
          {resolvedLowStockItems.map(item => {
            return (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-rose-50/60 border border-rose-200/80 hover:bg-rose-50 transition-colors mb-2"
              >
                {/* ฝั่งซ้าย: ข้อมูลสินค้าและรหัส */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[11px] font-bold shrink-0">
                    {item.department}
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-white border border-rose-200 text-slate-700 font-mono text-xs font-semibold shrink-0">
                    {item.sku !== '-' ? item.sku : 'ระบุรหัสสินค้า'}
                  </span>
                  <span className="text-xs font-bold text-slate-800 truncate" title={item.name}>
                    {item.name}
                  </span>
                </div>

                {/* ฝั่งขวา: ระดับสต็อก vs ROP และปุ่ม Action */}
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <div className="text-xs font-mono font-bold text-rose-600 tabular-nums">
                      คงเหลือ: {item.currentStock.toLocaleString()} {item.unit}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      จุดสั่งซื้อซ้ำ (ROP): {item.rop.toLocaleString()} {item.unit}
                    </div>
                  </div>

                  {/* ปุ่มเปิด PR ขอซื้อทันที */}
                  <button
                    type="button"
                    onClick={() => onQuickPR && onQuickPR({
                      ...item,
                      code: item.sku,
                      name: item.name,
                      department: item.department,
                      unit: item.unit,
                    })}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
                    title={`เปิด PR ด่วนสำหรับ ${item.name}`}
                  >
                    <span>+</span>
                    <span>ขอซื้อด่วน</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
