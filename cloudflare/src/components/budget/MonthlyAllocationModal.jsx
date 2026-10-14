import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  Wallet, X, Plus, Building2, TrendingUp, 
  CheckCircle2, ShieldCheck, Sparkles, AlertCircle 
} from 'lucide-react';
import { modalService } from '../../services/modalService';
import { budgetService } from '../../services/budgetService';

export default function MonthlyAllocationModal({
  isOpen,
  onClose,
  targetPeriod, // Format: 'YYYY-MM' (e.g. '2026-10')
  currentUser,
  currentRole,
  onSuccess
}) {
  if (!isOpen) return null;

  return (
    <MonthlyAllocationModalContent
      onClose={onClose}
      targetPeriod={targetPeriod}
      currentUser={currentUser}
      currentRole={currentRole}
      onSuccess={onSuccess}
    />
  );
}

function MonthlyAllocationModalContent({
  onClose,
  targetPeriod,
  currentUser,
  currentRole,
  onSuccess
}) {
  // Parse targetPeriod YYYY-MM into Thai Month and B.E. year
  const periodDisplay = useMemo(() => {
    if (!targetPeriod || !/^\d{4}-\d{2}$/.test(targetPeriod)) {
      return { monthThai: 'ปัจจุบัน', yearBe: '2569', raw: targetPeriod || '2026-09' };
    }
    const [y, m] = targetPeriod.split('-').map(Number);
    const thaiMonths = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
    ];
    return {
      monthThai: thaiMonths[m - 1] || 'ไม่ระบุ',
      yearBe: y + 543,
      raw: targetPeriod
    };
  }, [targetPeriod]);

  // Initial Form values for primary departments
  const [pdAmount, setPdAmount] = useState('1000000');
  const [qcAmount, setQcAmount] = useState('150000');
  const [whAmount, setWhAmount] = useState('120000');
  const [purAmount, setPurAmount] = useState('100000');
  const [engAmount, setEngAmount] = useState('205000');
  const [reason, setReason] = useState('จัดสรรงบประมาณประจำเดือนตามแผนการดำเนินงาน');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Total allocated sum
  const totalAllocated = useMemo(() => {
    return (Number(pdAmount) || 0) +
      (Number(qcAmount) || 0) +
      (Number(whAmount) || 0) +
      (Number(purAmount) || 0) +
      (Number(engAmount) || 0);
  }, [pdAmount, qcAmount, whAmount, purAmount, engAmount]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (Number(pdAmount) <= 0 || Number(qcAmount) <= 0) {
      return modalService.warning('กรุณาระบุวงเงินให้ถูกต้อง', 'วงเงินงบประมาณฝ่ายผลิต (PD) และ QC ต้องมากกว่า 0 บาท');
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการจัดสรรงบประมาณประจำเดือน',
      message: `คุณต้องการบันทึกการจัดสรรงบประมาณรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} (${periodDisplay.raw}) ยอดรวมทั้งสิ้น ฿${totalAllocated.toLocaleString()} ใช่หรือไม่?`,
      confirmText: 'ยืนยันจัดสรรงบประมาณ',
      cancelText: 'ยกเลิก',
      type: 'info'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const actorName = currentUser?.name || currentUser?.displayName || currentRole?.name || 'Asst. Manager';
      const allocations = {
        PD: Number(pdAmount) || 0,
        QC: Number(qcAmount) || 0,
        WH: Number(whAmount) || 0,
        PUR: Number(purAmount) || 0,
        ENG: Number(engAmount) || 0
      };

      await budgetService.allocateMonthlyBudget({
        period: periodDisplay.raw, // Strictly 'YYYY-MM'
        allocations,
        actor: actorName,
        reason: reason.trim()
      });

      modalService.success('จัดสรรงบประมาณสำเร็จ', `บันทึกงบประมาณรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} เรียบร้อยแล้ว`);
      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาด', err.message || 'ไม่สามารถจัดสรรงบประมาณได้');
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in overflow-y-auto">
      <div 
        className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200/80 overflow-hidden flex flex-col max-h-[92vh] animate-zoom-in my-auto text-slate-800"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4.5 border-b border-slate-100 bg-gradient-to-r from-emerald-50/80 via-teal-50/50 to-white flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-900 text-base sm:text-lg tracking-tight truncate">
                  จัดสรรงบประมาณประจำเดือน (Monthly Allocation)
                </h3>
              </div>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                รอบเดือน: <span className="font-bold text-emerald-700">{periodDisplay.monthThai} {periodDisplay.yearBe}</span> ({periodDisplay.raw})
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-xl transition-colors cursor-pointer shrink-0"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto custom-scrollbar flex-1 space-y-5">
          {/* RBAC Notice */}
          <div className="p-3.5 bg-emerald-50/70 border border-emerald-200/80 rounded-2xl flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-xs text-emerald-900 leading-relaxed">
              <span className="font-bold">สิทธิ์การจัดสรรงบประมาณ:</span> เฉพาะตำแหน่ง <span className="font-bold underline">Asst. Manager</span> และ <span className="font-bold underline">System Admin</span> เท่านั้น ข้อมูลที่บันทึกจะถูกผูกกับรอบเดือน <span className="font-mono font-bold">"{periodDisplay.raw}"</span> และคงอยู่ในฐานข้อมูล SSOT
            </div>
          </div>

          {/* Department Budgets Inputs */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
                1. กำหนดวงเงินงบประมาณรายแผนก (บาท) <span className="text-rose-500">*</span>
              </label>
              <span className="text-[11px] text-slate-400">หน่วย: บาท (THB)</span>
            </div>

            {/* PD Input */}
            <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span>
                  <span className="text-xs font-bold text-slate-800">ฝ่ายผลิต (Production Department - PD)</span>
                </div>
                <span className="text-[11px] text-slate-500 font-mono font-bold">PD</span>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                  ฿
                </div>
                <input
                  type="number"
                  min="0"
                  step="10000"
                  value={pdAmount}
                  onChange={e => setPdAmount(e.target.value)}
                  placeholder="เช่น 1000000"
                  className="w-full pl-8 pr-4 py-2.5 bg-white rounded-xl border border-slate-300 font-mono font-bold text-slate-900 text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                  required
                />
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-slate-400">ปุ่มลัด:</span>
                {[500000, 1000000, 1500000].map(val => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setPdAmount(String(val))}
                    className="px-2 py-0.5 rounded-md bg-white border border-slate-200 text-slate-600 font-mono text-[10px] hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    ฿{val.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            {/* QC Input */}
            <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-600"></span>
                  <span className="text-xs font-bold text-slate-800">ฝ่ายควบคุมคุณภาพ (Quality Control - QC)</span>
                </div>
                <span className="text-[11px] text-slate-500 font-mono font-bold">QC</span>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                  ฿
                </div>
                <input
                  type="number"
                  min="0"
                  step="10000"
                  value={qcAmount}
                  onChange={e => setQcAmount(e.target.value)}
                  placeholder="เช่น 150000"
                  className="w-full pl-8 pr-4 py-2.5 bg-white rounded-xl border border-slate-300 font-mono font-bold text-slate-900 text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                  required
                />
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-slate-400">ปุ่มลัด:</span>
                {[100000, 150000, 200000].map(val => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setQcAmount(String(val))}
                    className="px-2 py-0.5 rounded-md bg-white border border-slate-200 text-slate-600 font-mono text-[10px] hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    ฿{val.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            {/* Secondary Departments Grid (WH, PUR, ENG) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-2xl border border-slate-200 bg-white space-y-1.5">
                <span className="text-xs font-bold text-slate-700 block">คลังสินค้า (WH)</span>
                <input
                  type="number"
                  min="0"
                  value={whAmount}
                  onChange={e => setWhAmount(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs font-bold text-slate-900"
                />
              </div>
              <div className="p-3 rounded-2xl border border-slate-200 bg-white space-y-1.5">
                <span className="text-xs font-bold text-slate-700 block">จัดซื้อ (PUR)</span>
                <input
                  type="number"
                  min="0"
                  value={purAmount}
                  onChange={e => setPurAmount(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs font-bold text-slate-900"
                />
              </div>
              <div className="p-3 rounded-2xl border border-slate-200 bg-white space-y-1.5">
                <span className="text-xs font-bold text-slate-700 block">วิศวกรรม (ENG)</span>
                <input
                  type="number"
                  min="0"
                  value={engAmount}
                  onChange={e => setEngAmount(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs font-bold text-slate-900"
                />
              </div>
            </div>
          </div>

          {/* Reason Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              2. เหตุผลและความจำเป็นประกอบการจัดสรรงบ <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows="2"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="ระบุเหตุผล เช่น จัดสรรงบประมาณตามรอบดำเนินงานประจำเดือน..."
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-xs text-slate-800 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none resize-none"
              required
            />
          </div>

          {/* Total Summary Strip */}
          <div className="p-4 bg-emerald-50/80 rounded-2xl border border-emerald-200 flex items-center justify-between">
            <div>
              <span className="text-[10px] text-emerald-800 font-bold uppercase tracking-wider block">
                ยอดจัดสรรงบประมาณรวมทั้งสิ้น
              </span>
              <span className="text-xs text-emerald-700 mt-0.5 block">
                รอบเดือน {periodDisplay.monthThai} {periodDisplay.yearBe}
              </span>
            </div>
            <span className="font-mono text-xl font-extrabold text-emerald-800 tabular-nums">
              ฿{totalAllocated.toLocaleString()}
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md shadow-emerald-600/25 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{isSubmitting ? 'กำลังบันทึก...' : 'ยืนยันจัดสรรงบประมาณ'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
