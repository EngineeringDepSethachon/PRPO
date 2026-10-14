import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Building2, X, Check, ArrowRight, ShieldCheck, 
  Sparkles, AlertCircle, TrendingUp, DollarSign, Calendar
} from 'lucide-react';
import { modalService } from '../../services/modalService';
import { budgetService } from '../../services/budgetService';

/**
 * Compact Single-Department Budget Allocation Modal
 * Specially designed for Assistant Manager & Admin to allocate or update
 * budget for a specific department (PD or QC) in a specific period (YYYY-MM).
 */
export default function DepartmentAllocationModal({
  isOpen,
  onClose,
  department,       // 'PD' or 'QC'
  departmentName,   // e.g. 'ฝ่ายผลิต'
  targetPeriod,     // 'YYYY-MM' e.g. '2026-09'
  currentAmount = 0,
  currentUser,
  currentRole,
  onSuccess
}) {
  if (!isOpen || !department) return null;

  return createPortal(
    <DepartmentAllocationModalContent
      onClose={onClose}
      department={department}
      departmentName={departmentName || department}
      targetPeriod={targetPeriod}
      currentAmount={currentAmount}
      currentUser={currentUser}
      currentRole={currentRole}
      onSuccess={onSuccess}
    />,
    document.body
  );
}

function DepartmentAllocationModalContent({
  onClose,
  department,
  departmentName,
  targetPeriod,
  currentAmount,
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

  // Form State
  const [amountStr, setAmountStr] = useState(String(currentAmount || ''));
  const [reason, setReason] = useState(
    currentAmount > 0 
      ? `ปรับปรุงวงเงินงบประมาณรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
      : `จัดสรรงบประมาณประจำเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setAmountStr(String(currentAmount || ''));
    setReason(
      currentAmount > 0 
        ? `ปรับปรุงวงเงินงบประมาณรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
        : `จัดสรรงบประมาณประจำเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
    );
  }, [currentAmount, department, periodDisplay]);

  const numericAmount = Math.max(0, Number(amountStr) || 0);
  const delta = numericAmount - (Number(currentAmount) || 0);

  // Department metadata
  const isPD = department === 'PD';
  const deptLabel = departmentName ? `${departmentName} (${department})` : (isPD ? 'ฝ่ายผลิต (PD)' : (department === 'QC' ? 'ฝ่ายควบคุมคุณภาพ (QC)' : department));
  const themeGradient = isPD 
    ? 'from-indigo-600 to-violet-600' 
    : (department === 'QC' ? 'from-cyan-600 to-blue-600' : 'from-slate-700 to-slate-900');
  const themeBadge = isPD 
    ? 'bg-indigo-50 text-indigo-700 border-indigo-200' 
    : (department === 'QC' ? 'bg-cyan-50 text-cyan-700 border-cyan-200' : 'bg-slate-100 text-slate-700 border-slate-200');

  const handleQuickAdd = (inc) => {
    setAmountStr(prev => String((Number(prev) || 0) + inc));
  };

  const handleQuickSet = (val) => {
    setAmountStr(String(val));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (numericAmount <= 0) {
      return modalService.warning('กรุณาระบุวงเงิน', 'วงเงินงบประมาณต้องมากกว่า 0 บาท');
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการบันทึกงบประมาณ',
      message: `คุณต้องการบันทึกงบประมาณของ ${deptLabel} สำหรับรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} (${periodDisplay.raw}) เป็นจำนวนเงิน ฿${numericAmount.toLocaleString()} ใช่หรือไม่?`,
      confirmText: 'บันทึกงบประมาณ',
      cancelText: 'ยกเลิก',
      type: 'info'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const actorName = currentUser?.name || currentUser?.displayName || currentRole?.name || 'Asst. Manager';
      
      // 1. Allocate via budgetService for target period (Single source of truth)
      await budgetService.allocateMonthlyBudget({
        period: targetPeriod,
        allocations: {
          [department]: numericAmount
        },
        actor: actorName,
        reason: reason.trim() || `จัดสรรงบประมาณ ${department} ประจำเดือน ${targetPeriod}`
      });

      modalService.success(
        'บันทึกงบประมาณสำเร็จ', 
        `จัดสรรงบประมาณ ${deptLabel} รอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} เป็น ฿${numericAmount.toLocaleString()} เรียบร้อยแล้ว`
      );

      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      console.error('[DepartmentAllocationModal] Submit error:', err);
      modalService.error('เกิดข้อผิดพลาด', 'ไม่สามารถจัดสรรงบประมาณได้: ' + (err.message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" 
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden z-10 animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className={`p-5 sm:p-6 bg-gradient-to-r ${themeGradient} text-white relative`}>
          <button 
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-md flex items-center justify-center border border-white/20 shadow-inner">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  จัดสรรงบประมาณ: {departmentName || department}
                </h3>
                <span className="px-2 py-0.5 rounded-md bg-white/20 text-white font-mono text-xs font-bold border border-white/25">
                  {department}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-white/85 mt-0.5">
                <Calendar className="w-3.5 h-3.5" />
                <span>รอบเดือน: <strong>{periodDisplay.monthThai} {periodDisplay.yearBe}</strong> ({periodDisplay.raw})</span>
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5">
          {/* Status & Current Budget Comparison Strip */}
          <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200/70">
            <div>
              <span className="text-[11px] font-medium text-slate-500 block">งบประมาณเดิม</span>
              <span className="font-mono text-base font-bold text-slate-700 block mt-0.5">
                {currentAmount > 0 ? `฿${Number(currentAmount).toLocaleString()}` : '฿0 (ยังไม่จัดสรร)'}
              </span>
            </div>
            <div>
              <span className="text-[11px] font-medium text-slate-500 block">ผลต่าง (Delta)</span>
              <span className={`font-mono text-base font-bold block mt-0.5 ${
                delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-slate-500'
              }`}>
                {delta > 0 ? `+฿${delta.toLocaleString()}` : delta < 0 ? `-฿${Math.abs(delta).toLocaleString()}` : '฿0'}
              </span>
            </div>
          </div>

          {/* New Budget Input */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
              <span>วงเงินงบประมาณใหม่ประจำเดือน (฿) *</span>
              {numericAmount > 0 && (
                <span className="font-mono text-indigo-600 font-bold text-xs">
                  ฿{numericAmount.toLocaleString()}
                </span>
              )}
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">
                ฿
              </span>
              <input
                type="number"
                min="0"
                step="1000"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="ระบุจำนวนเงินงบประมาณ เช่น 1000000"
                required
                autoFocus
                className="w-full pl-8 pr-4 py-2.5 bg-slate-50 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-900 font-mono font-bold text-base focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none"
              />
            </div>

            {/* Quick Set Presets */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[10px] text-slate-400 font-semibold mr-1">กำหนดเร็ว:</span>
              <button
                type="button"
                onClick={() => handleQuickSet(isPD ? 1000000 : 150000)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-600 border border-slate-200 transition-all cursor-pointer"
              >
                {isPD ? '1,000,000 (ค่ามาตรฐาน)' : '150,000 (ค่ามาตรฐาน)'}
              </button>
              <button
                type="button"
                onClick={() => handleQuickSet(isPD ? 1500000 : 250000)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-600 border border-slate-200 transition-all cursor-pointer"
              >
                {isPD ? '1,500,000' : '250,000'}
              </button>
              <button
                type="button"
                onClick={() => handleQuickAdd(100000)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-emerald-50 hover:text-emerald-700 text-slate-600 border border-slate-200 transition-all cursor-pointer"
              >
                +100,000
              </button>
              <button
                type="button"
                onClick={() => handleQuickAdd(500000)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-emerald-50 hover:text-emerald-700 text-slate-600 border border-slate-200 transition-all cursor-pointer"
              >
                +500,000
              </button>
            </div>
          </div>

          {/* Reason / Note Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              หมายเหตุ / เหตุผลการจัดสรร
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ระบุเหตุผลหรือบันทึกประกอบ เช่น จัดสรรงบประจำเดือน, ปรับเพิ่มงบรองรับคำสั่งผลิตพิเศษ"
              className="w-full px-3 py-2 bg-slate-50 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none resize-none"
            />
          </div>

          {/* RBAC notice */}
          <div className="flex items-center gap-2 p-2.5 bg-amber-50/70 border border-amber-200/60 rounded-xl text-[11px] text-amber-800">
            <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
            <span>สิทธิ์เฉพาะ Asst. Manager และ Admin เท่านั้น ข้อมูลจะผูกกับรอบเดือน {periodDisplay.raw}</span>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer disabled:opacity-50"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSubmitting || numericAmount <= 0}
              className={`px-5 py-2.5 bg-gradient-to-r ${themeGradient} text-white font-bold text-xs sm:text-sm rounded-xl shadow-md hover:shadow-lg hover:brightness-105 active:scale-98 transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:pointer-events-none`}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>กำลังบันทึก...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 stroke-[2.5]" />
                  <span>บันทึกงบประมาณ</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
