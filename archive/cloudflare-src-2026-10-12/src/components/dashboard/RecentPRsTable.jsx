import React from 'react';
import { PR_STATUS } from '../../config/constants';
import { ShoppingCart, PlusCircle, ChevronRight, ArrowRight, FileText } from 'lucide-react';

export default function RecentPRsTable({ prs = [], onNavigate, onOpenPR }) {
  const recentPRs = prs.slice(0, 5);
  const recentPRTotal = recentPRs.reduce((sum, p) => sum + (p.totalAmount || 0), 0);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-2xs">
      {/* Header Bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 font-bold text-slate-800 text-sm">
          <span className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 text-base leading-none">📄</span>
          <span>ใบขอซื้อล่าสุด</span>
          <span className="text-xs font-normal text-slate-400 font-sans hidden sm:inline">(Recent PRs)</span>
          {recentPRs.length > 0 && (
            <span className="text-[11px] font-semibold text-indigo-700 bg-indigo-50/80 px-2 py-0.5 rounded-full border border-indigo-100/60 ml-1">
              {recentPRs.length} รายการ
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onNavigate && onNavigate('pr-list')}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 transition-colors flex items-center gap-1 cursor-pointer"
        >
          <span>ดูทั้งหมด</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content List */}
      {recentPRs.length === 0 ? (
        <div className="py-10 px-4 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50/80 border border-indigo-100 flex items-center justify-center text-indigo-500 mb-3 shadow-2xs">
            <FileText className="w-5 h-5" />
          </div>
          <h4 className="text-xs sm:text-sm font-bold text-slate-900 mb-1">ยังไม่มีใบขอซื้อในระบบ</h4>
          <p className="text-[11px] sm:text-xs text-slate-400 max-w-xs leading-relaxed mb-4">
            คุณสามารถสร้างใบขอซื้อใหม่เพื่อเริ่มกระบวนการจัดซื้อวัตถุดิบหรืออุปกรณ์
          </p>
          <button
            type="button"
            onClick={() => onNavigate && onNavigate('pr-create')}
            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-2xs flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <PlusCircle className="w-3.5 h-3.5 text-slate-300" />
            <span>สร้างใบ PR ใหม่</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {recentPRs.map((pr) => {
            const statusInfo = PR_STATUS[pr.status] || {
              label: pr.status,
              color: 'bg-slate-100 text-slate-700 border-slate-200'
            };
            const itemCount = pr.items?.length || 1;
            const firstItemName = pr.items?.[0]?.name || pr.note || 'ไม่มีรายการระบุ';

            return (
              <div
                key={pr.id}
                onClick={() => (onOpenPR ? onOpenPR(pr.id) : onNavigate && onNavigate('pr-list'))}
                className="p-3 rounded-xl bg-slate-50/50 hover:bg-slate-50 border border-slate-100/90 hover:border-indigo-200/80 transition-all cursor-pointer flex items-center justify-between gap-3 group"
                title="คลิกเพื่อดูรายละเอียดใบขอซื้อ"
              >
                {/* Left: PR Meta & Items Info */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-xs sm:text-sm text-slate-900 group-hover:text-indigo-600 transition-colors">
                      {pr.prNo}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                        pr.department === 'PD'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}
                    >
                      {pr.department}
                    </span>
                    {pr.purchaseChannel === 'ONLINE' && (
                      <span className="text-[10px] font-semibold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded-md flex items-center gap-1">
                        <ShoppingCart className="w-3 h-3 text-purple-600" />
                        <span>Online</span>
                      </span>
                    )}
                    <span className="text-[11px] text-slate-400 font-normal truncate">
                      • {pr.requestedBy}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 truncate max-w-md font-medium">
                    <span className="text-slate-400 font-mono text-[11px] font-normal">{itemCount} รายการ:</span>{' '}
                    {firstItemName}
                  </p>
                </div>

                {/* Right: Amount & Status Dot */}
                <div className="flex items-center gap-2 shrink-0 text-right">
                  <div>
                    <div className="font-mono font-bold text-xs sm:text-sm text-slate-900 tabular-nums">
                      ฿{(pr.totalAmount || 0).toLocaleString()}
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border mt-0.5 ${statusInfo.color}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80 animate-pulse"></span>
                      <span>{statusInfo.label}</span>
                    </span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer Total */}
      {recentPRs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
          <span>รวม {recentPRs.length} รายการล่าสุด</span>
          <span className="font-mono font-bold text-slate-900 tabular-nums">
            ยอดรวม ฿{recentPRTotal.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
