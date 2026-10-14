import React from 'react';
import { CheckCircle2 } from 'lucide-react';

export default function LowStockAlertCard({
  lowStockItems = [],
  onSingleQuickPR,
  onBatchQuickPR
}) {
  return (
    <div className="bg-gradient-to-b from-rose-50/50 via-white to-white rounded-2xl border border-rose-200/80 p-5 shadow-2xs">
      {/* Header Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-rose-100 mb-3 gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-bold text-rose-900">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse shrink-0"></span>
            <span className="truncate">สินค้าใกล้หมด ({lowStockItems.length} รายการ)</span>
          </div>
          <p className="text-[11px] text-slate-500 truncate">คงเหลือต่ำกว่าจุดสั่งซื้อซ้ำ (ROP)</p>
        </div>

        {/* ปุ่มพระเอก: ขอซื้อทั้งหมดในคลิกเดียว */}
        {lowStockItems.length > 0 && (
          <button
            type="button"
            onClick={onBatchQuickPR}
            className="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-2xs transition-all flex items-center gap-1 shrink-0 cursor-pointer"
            title="สร้างใบขอซื้อ (PR) รวมสินค้าที่ต้องสั่งซื้อซ้ำทั้งหมดในทันที"
          >
            <span>⚡</span>
            <span>ขอซื้อทั้งหมด</span>
          </button>
        )}
      </div>

      {/* Content List */}
      {lowStockItems.length === 0 ? (
        <div className="py-8 px-3 text-center text-slate-500 flex flex-col items-center justify-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shadow-2xs">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-xs font-semibold text-slate-800">ไม่มีสินค้าแตะจุดสั่งซื้อซ้ำในขณะนี้</p>
          <p className="text-[11px] text-slate-400">ระดับสต็อกสินค้าทุกรายการอยู่ในเกณฑ์ปกติ</p>
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[460px] overflow-y-auto custom-scrollbar pr-0.5">
          {lowStockItems.map((item) => (
            <div
              key={item.sku || item.id}
              className="p-2.5 rounded-xl bg-white border border-rose-100 hover:border-rose-300 hover:shadow-xs transition-all flex items-center justify-between gap-2 shadow-2xs group"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="font-bold text-xs text-slate-800 truncate group-hover:text-rose-700 transition-colors"
                  title={item.name || 'สินค้าไม่มีชื่อ'}
                >
                  {item.name || 'สินค้าไม่มีชื่อ'}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono">
                  <span className="text-slate-400 font-normal">{item.sku || item.code || '-'}</span>
                  <span className="text-rose-600 font-semibold font-sans">
                    เหลือ {Number(item.currentStock ?? item.stock ?? 0).toLocaleString()} / ROP: {Number(item.rop ?? item.reorderPoint ?? 0).toLocaleString()} {item.unit || 'ชิ้น'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSingleQuickPR && onSingleQuickPR(item)}
                className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-rose-50 text-slate-700 hover:text-rose-700 border border-slate-200 hover:border-rose-200 text-xs font-bold transition-all shrink-0 cursor-pointer"
                title={`เปิด PR ด่วนสำหรับ ${item.name}`}
              >
                + ขอซื้อ
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
