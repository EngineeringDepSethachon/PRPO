import React from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, X, AlertTriangle, Package, CheckCircle2, RotateCcw } from 'lucide-react';

export default function DeactivateItemModal({
  product,
  reasons = [],
  onConfirm,
  onClose,
  isProcessing = false
}) {
  if (!product) return null;

  const stockQty = Number(product.stockBalance || 0);
  const sUnit = product.stockUnit || product.unit || 'ชิ้น';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-amber-100 bg-amber-50/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shadow-xs">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base">ไม่สามารถลบสินค้านี้ได้</h3>
              <p className="text-xs text-amber-800 font-medium">Referential Integrity Guardrail</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Target Item Card */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">
                  {product.code || 'SKU N/A'}
                </span>
                <h4 className="font-bold text-slate-900 text-sm mt-1">{product.name}</h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  แผนก: {product.category || product.department || 'PD'} • จุดจัดเก็บ: {product.locationName || 'ไม่ระบุ'}
                </p>
              </div>
              <div className="text-right shrink-0">
                <span className="text-[11px] text-slate-400 block">สต็อกคงเหลือ</span>
                <span className="font-mono font-bold text-sm text-slate-800 tabular-nums">
                  {stockQty.toLocaleString()} {sUnit}
                </span>
              </div>
            </div>
          </div>

          {/* Conflict Reasons */}
          <div className="p-4 rounded-2xl bg-amber-50/60 border border-amber-200/80 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>ตรวจพบประวัติและธุรกรรมที่ยังคงค้างในระบบ:</span>
            </div>
            <ul className="text-xs text-amber-800 space-y-1.5 pl-6 list-disc">
              {reasons.map((r, i) => (
                <li key={i} className="leading-relaxed font-medium">{r}</li>
              ))}
            </ul>
          </div>

          {/* System Recommendation */}
          <div className="rounded-2xl border border-slate-200/80 p-4 bg-slate-50/60 space-y-2">
            <h5 className="text-xs font-bold text-slate-700">ผลของการเลือก "ปิดการใช้งาน (Deactivate / Soft Delete)":</h5>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>ซ่อนจาก Dropdown สร้างใบขอซื้อ (Create PR) ทันที</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>ซ่อนจากรายการค้นหาเพื่อขอเบิกใช้งานใหม่</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>คงรักษาประวัติย้อนหลังและข้อมูลสต็อกเดิมไว้เพื่อการตรวจสอบทางบัญชี</span>
              </div>
              <div className="flex items-center gap-2">
                <RotateCcw className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>สามารถกด "เปิดใช้งานใหม่ (Reactivate)" ได้ตลอดเวลาจากแถบตัวกรอง</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-6 py-4 bg-slate-50 border-t border-slate-200/80">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isProcessing}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white shadow-sm hover:shadow transition-all cursor-pointer disabled:opacity-50"
          >
            {isProcessing ? (
              <span>กำลังบันทึก...</span>
            ) : (
              <>
                <ShieldAlert className="w-4 h-4" />
                <span>ยืนยันปิดการใช้งาน (Deactivate)</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
