import React from 'react';
import { PO_STATUS } from '../../config/constants';
import { ShoppingCart, Store, Building2, ChevronRight, ArrowRight, Eye } from 'lucide-react';

export default function RecentPOsTable({ pos = [], onNavigate, onOpenPO }) {
  const recentPOs = pos.slice(0, 5);
  const recentPOTotal = recentPOs.reduce((sum, p) => sum + (p.grandTotal || p.subtotal || 0), 0);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-2xs">
      {/* Header Bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 font-bold text-slate-800 text-sm">
          <span className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 text-base leading-none">🛒</span>
          <span>ใบสั่งซื้อล่าสุด</span>
          <span className="text-xs font-normal text-slate-400 font-sans hidden sm:inline">(Recent POs)</span>
          {recentPOs.length > 0 && (
            <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50/80 px-2 py-0.5 rounded-full border border-emerald-100/60 ml-1">
              {recentPOs.length} รายการ
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onNavigate && onNavigate('po-list')}
          className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 transition-colors flex items-center gap-1 cursor-pointer"
        >
          <span>ดูทั้งหมด</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content List */}
      {recentPOs.length === 0 ? (
        <div className="py-10 px-4 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50/80 border border-emerald-100 flex items-center justify-center text-emerald-500 mb-3 shadow-2xs">
            <ShoppingCart className="w-5 h-5" />
          </div>
          <h4 className="text-xs sm:text-sm font-bold text-slate-900 mb-1">ยังไม่มีใบสั่งซื้อในระบบ</h4>
          <p className="text-[11px] sm:text-xs text-slate-400 max-w-xs leading-relaxed mb-4">
            ใบสั่งซื้อ (PO) จะถูกสร้างอัตโนมัติเมื่อ PR ผ่านการอนุมัติขั้นสุดท้ายจาก Plant Manager
          </p>
          <button
            type="button"
            onClick={() => onNavigate && onNavigate('pr-list')}
            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-2xs flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5 text-slate-300" />
            <span>เปิดดูรายการ PR เพื่อติดตาม</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {recentPOs.map((po) => {
            const statusInfo = PO_STATUS[po.status] || {
              label: po.status,
              color: 'bg-slate-100 text-slate-700 border-slate-200'
            };
            const vendorDisplay =
              po.vendorName && po.vendorName !== 'Shopee / Lazada (ระบุร้านภายหลัง)'
                ? po.vendorName
                : po.purchaseChannel === 'ONLINE'
                ? 'สั่งซื้อออนไลน์ (Shopee/Lazada)'
                : 'ยังไม่ระบุผู้ขาย';

            return (
              <div
                key={po.id}
                onClick={() => (onOpenPO ? onOpenPO(po.id) : onNavigate && onNavigate('po-list'))}
                className="p-3 rounded-xl bg-slate-50/50 hover:bg-slate-50 border border-slate-100/90 hover:border-emerald-200/80 transition-all cursor-pointer flex items-center justify-between gap-3 group"
                title="คลิกเพื่อดูรายละเอียดใบสั่งซื้อ"
              >
                {/* Left: PO Meta & Vendor */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-xs sm:text-sm text-slate-900 group-hover:text-emerald-600 transition-colors">
                      {po.poNo}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                        po.department === 'PD'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}
                    >
                      {po.department}
                    </span>
                    {po.prNo && (
                      <span className="text-[11px] text-slate-400 font-mono">
                        (อ้างอิง {po.prNo})
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 truncate max-w-md font-medium flex items-center gap-1.5">
                    {po.purchaseChannel === 'ONLINE' ? (
                      <Store className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                    ) : (
                      <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                    <span className="truncate">{vendorDisplay}</span>
                  </p>
                </div>

                {/* Right: Amount & Status */}
                <div className="flex items-center gap-2 shrink-0 text-right">
                  <div>
                    <div className="font-mono font-bold text-xs sm:text-sm text-slate-900 tabular-nums">
                      ฿{(po.grandTotal || po.subtotal || 0).toLocaleString()}
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border mt-0.5 ${statusInfo.color}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80 animate-pulse"></span>
                      <span>{statusInfo.label}</span>
                    </span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-emerald-600 group-hover:translate-x-0.5 transition-all" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer Total */}
      {recentPOs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
          <span>รวม {recentPOs.length} รายการล่าสุด</span>
          <span className="font-mono font-bold text-slate-900 tabular-nums">
            ยอดรวม ฿{recentPOTotal.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
