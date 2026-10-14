import React from 'react';
import { FileText } from 'lucide-react';
import { MEMO_CLASSIFICATION } from '../../config/constants';

export default function MEMODetailsSection({ memo }) {
  if (!memo) return null;

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl overflow-hidden mt-4 shadow-xs">
      <div className="bg-slate-50/80 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-amber-600" />
          <h4 className="font-bold text-xs sm:text-sm text-slate-800 tracking-wide uppercase">
            รายละเอียด MEMO (Request For Approval)
          </h4>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
          ≥ ฿20,000
        </span>
      </div>

      <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        
        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">วันที่ขออนุมัติ (Date)</p>
          <p className="text-sm font-semibold text-slate-900 font-mono">{memo.date || '-'}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">ประเภทค่าใช้จ่าย (Classification)</p>
          <p className="text-sm font-semibold text-slate-900">
            {MEMO_CLASSIFICATION[memo.classification]?.label || memo.classification || 'Expense'}
          </p>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">หัวข้อ / โครงการ (Subject)</p>
          <p className="text-sm sm:text-base font-bold text-slate-900">{memo.subject || '-'}</p>
        </div>

        <div className="space-y-1 sm:col-span-2 bg-slate-50/70 p-3.5 rounded-xl border border-slate-200/60">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">วัตถุประสงค์และความจำเป็น (Purpose of Request)</p>
          <p className="text-xs sm:text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{memo.purpose || '-'}</p>
        </div>

        {memo.background && memo.background.trim() !== '' && memo.background !== memo.purpose && (
          <div className="space-y-1 sm:col-span-2 bg-slate-50/70 p-3.5 rounded-xl border border-slate-200/60">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">รายละเอียด / พื้นเพ (Background / Details)</p>
            <p className="text-xs sm:text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{memo.background}</p>
          </div>
        )}

        {/* 2 Balanced Columns: Estimated Cost & Payment Term (Directive 2) */}
        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">ราคาประมาณการ (Estimated Cost)</p>
          <p className="text-base font-black font-mono text-rose-600 tabular-nums">
            ฿{memo.estimatedCost?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">เงื่อนไขการชำระเงิน (Payment Term)</p>
          <p className="text-sm sm:text-base font-semibold text-slate-900">{memo.paymentTerm || '-'}</p>
        </div>

      </div>
    </div>
  );
}
