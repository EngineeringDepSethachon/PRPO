import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Building2, X, Check, ArrowRight, ShieldCheck, 
  Sparkles, AlertCircle, TrendingUp, TrendingDown, DollarSign, Calendar,
  Calculator, Plus, Minus, Equal, Delete, RotateCcw
} from 'lucide-react';
import { modalService } from '../../services/modalService';
import { budgetService } from '../../services/budgetService';

/**
 * Direct Calculator-Powered Single-Department Budget Allocation Modal
 * Specially designed for Assistant Manager & Admin to allocate, top-up, reduce,
 * or calculate budget for a specific department (PD or QC) in a specific period (YYYY-MM).
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

  const content = (
    <DepartmentAllocationModalContent
      onClose={onClose}
      department={department}
      departmentName={departmentName || department}
      targetPeriod={targetPeriod}
      currentAmount={currentAmount}
      currentUser={currentUser}
      currentRole={currentRole}
      onSuccess={onSuccess}
    />
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(content, document.body)
    : content;
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

  const baseBudget = Number(currentAmount) || 0;

  // Calculator Modes:
  // 'SET': กำหนดวงเงินตรง (= Direct Target Budget)
  // 'ADD': เติม / ปรับเพิ่ม (+ Top-up from current)
  // 'SUBTRACT': ปรับลดงบประมาณ (- Reduce from current)
  const [calcMode, setCalcMode] = useState('SET');
  const [inputValue, setInputValue] = useState(String(baseBudget > 0 ? baseBudget : ''));
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showKeypad, setShowKeypad] = useState(true);

  // Sync initial state on open
  useEffect(() => {
    setCalcMode('SET');
    setInputValue(String(baseBudget > 0 ? baseBudget : ''));
    setReason(
      baseBudget > 0 
        ? `ปรับปรุงวงเงินงบประมาณรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
        : `จัดสรรงบประมาณประจำเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`
    );
  }, [currentAmount, department, periodDisplay]);

  // Compute resulting final budget based on calculator mode & input
  const numInput = Math.max(0, Number(inputValue) || 0);

  const resultingAmount = useMemo(() => {
    if (calcMode === 'ADD') {
      return baseBudget + numInput;
    }
    if (calcMode === 'SUBTRACT') {
      return Math.max(0, baseBudget - numInput);
    }
    // 'SET' mode
    return numInput;
  }, [calcMode, baseBudget, numInput]);

  const delta = resultingAmount - baseBudget;

  // Auto-sync reason text when delta changes if reason matches default pattern
  useEffect(() => {
    if (baseBudget > 0) {
      if (delta > 0) {
        setReason(`ปรับเพิ่มงบประมาณจาก ฿${baseBudget.toLocaleString()} เป็น ฿${resultingAmount.toLocaleString()} (+฿${Math.abs(delta).toLocaleString()})`);
      } else if (delta < 0) {
        setReason(`ปรับลดงบประมาณจาก ฿${baseBudget.toLocaleString()} เป็น ฿${resultingAmount.toLocaleString()} (-฿${Math.abs(delta).toLocaleString()})`);
      } else {
        setReason(`คงวงเงินงบประมาณเดิม ฿${baseBudget.toLocaleString()} รอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe}`);
      }
    } else {
      setReason(`จัดสรรงบประมาณประจำเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} เป็น ฿${resultingAmount.toLocaleString()}`);
    }
  }, [resultingAmount, baseBudget, delta, periodDisplay]);

  // Department styling & metadata
  const isPD = department === 'PD';
  const deptLabel = departmentName ? `${departmentName} (${department})` : (isPD ? 'ฝ่ายผลิต (PD)' : (department === 'QC' ? 'ฝ่ายควบคุมคุณภาพ (QC)' : department));
  const themeGradient = isPD 
    ? 'from-indigo-600 via-indigo-700 to-violet-800' 
    : (department === 'QC' ? 'from-cyan-600 via-sky-700 to-blue-800' : 'from-slate-700 via-slate-800 to-slate-900');

  // Calculator Keypad Actions
  const handleDigitPress = (digit) => {
    setInputValue(prev => {
      const clean = String(prev ?? '');
      if (digit === '.') {
        if (clean.includes('.')) return clean;
        return clean === '' ? '0.' : clean + '.';
      }
      if (clean === '0' && digit !== '.') {
        return String(digit);
      }
      return clean + String(digit);
    });
  };

  const handleBackspace = () => {
    setInputValue(prev => {
      const s = String(prev ?? '');
      if (s.length <= 1) return '';
      return s.slice(0, -1);
    });
  };

  const handleClear = () => {
    setInputValue('');
  };

  const handleReset = () => {
    setCalcMode('SET');
    setInputValue(String(baseBudget > 0 ? baseBudget : ''));
  };

  // Quick unit denomination adjustment (supports units: 1, 10, 100, 1,000, 10,000, etc.)
  const handleDeltaStep = (step) => {
    if (calcMode === 'SET') {
      const next = Math.max(0, (Number(inputValue) || 0) + step);
      setInputValue(String(next));
    } else {
      const next = Math.max(0, (Number(inputValue) || 0) + step);
      setInputValue(String(next));
    }
  };

  // Quick baseline preset set
  const handlePresetSet = (val) => {
    setCalcMode('SET');
    setInputValue(String(val));
  };

  // Submit Handler
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (resultingAmount < 0) {
      return modalService.warning('กรุณาระบุวงเงิน', 'วงเงินงบประมาณต้องไม่ต่ำกว่า 0 บาท');
    }

    const actionDescription = delta > 0 
      ? `ปรับเพิ่มงบประมาณ (+฿${Math.abs(delta).toLocaleString()})`
      : delta < 0 
        ? `ปรับลดงบประมาณ (-฿${Math.abs(delta).toLocaleString()})`
        : `บันทึกวงเงินงบประมาณ`;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการบันทึกงบประมาณ',
      message: `คุณต้องการ${actionDescription} ของ ${deptLabel} สำหรับรอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} (${periodDisplay.raw}) เป็นยอดสุทธิ ฿${resultingAmount.toLocaleString()} ใช่หรือไม่?`,
      confirmText: 'ยืนยันบันทึก',
      cancelText: 'ยกเลิก',
      type: delta < 0 ? 'warning' : 'info'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const actorName = currentUser?.name || currentUser?.displayName || currentRole?.name || 'Asst. Manager';
      
      // Allocate via budgetService (single source of truth with deduplicated transactions)
      await budgetService.allocateMonthlyBudget({
        period: targetPeriod,
        allocations: {
          [department]: resultingAmount
        },
        previousAmounts: {
          [department]: baseBudget
        },
        actor: actorName,
        reason: reason.trim() || `ปรับปรุงงบประมาณ ${department} ประจำเดือน ${targetPeriod}`
      });

      modalService.success(
        'บันทึกงบประมาณสำเร็จ', 
        `ปรับปรุงงบประมาณ ${deptLabel} รอบเดือน ${periodDisplay.monthThai} ${periodDisplay.yearBe} เป็น ฿${resultingAmount.toLocaleString()} เรียบร้อยแล้ว`
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200" 
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-xl bg-white rounded-3xl shadow-2xl border border-slate-200/80 overflow-hidden z-10 animate-in zoom-in-95 duration-200 my-auto text-slate-800">
        
        {/* ── Modal Header ── */}
        <div className={`px-6 py-4.5 bg-gradient-to-r ${themeGradient} text-white relative flex items-center justify-between`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-white/15 backdrop-blur-md flex items-center justify-center border border-white/20 shadow-inner shrink-0">
              <Calculator className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-white tracking-tight truncate">
                  คำนวณงบประมาณ: {departmentName || department}
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-white/20 text-white font-mono text-xs font-bold border border-white/25 shrink-0">
                  {department}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-white/85 mt-0.5">
                <Calendar className="w-3.5 h-3.5" />
                <span>รอบเดือน: <strong>{periodDisplay.monthThai} {periodDisplay.yearBe}</strong> ({periodDisplay.raw})</span>
              </div>
            </div>
          </div>

          <button 
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-colors cursor-pointer shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Modal Body ── */}
        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-4 max-h-[82vh] overflow-y-auto custom-scrollbar">

          {/* 1. Calculator Tape / Formula Display */}
          <div className="bg-slate-900 text-white p-4 rounded-2xl shadow-inner border border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="flex items-center gap-1.5 font-medium">
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
                งบประมาณเดิม: <strong className="text-slate-200 font-mono">฿{baseBudget.toLocaleString()}</strong>
              </span>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold font-mono ${
                delta > 0 
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                  : delta < 0 
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' 
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}>
                {delta > 0 ? `+฿${delta.toLocaleString()}` : delta < 0 ? `-฿${Math.abs(delta).toLocaleString()}` : '฿0 (ไม่เปลี่ยนแปลง)'}
              </span>
            </div>

            {/* Formula Row */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
              <div className="text-xs sm:text-sm text-slate-300 font-mono flex items-center gap-2 flex-wrap">
                {calcMode === 'SET' && (
                  <>
                    <span className="text-slate-400">กำหนดวงเงินตรง =</span>
                    <span className="font-bold text-amber-300">฿{(numInput || 0).toLocaleString()}</span>
                  </>
                )}
                {calcMode === 'ADD' && (
                  <>
                    <span>฿{baseBudget.toLocaleString()}</span>
                    <span className="text-emerald-400 font-bold">+</span>
                    <span className="font-bold text-emerald-300">฿{(numInput || 0).toLocaleString()}</span>
                  </>
                )}
                {calcMode === 'SUBTRACT' && (
                  <>
                    <span>฿{baseBudget.toLocaleString()}</span>
                    <span className="text-rose-400 font-bold">-</span>
                    <span className="font-bold text-rose-300">฿{(numInput || 0).toLocaleString()}</span>
                  </>
                )}
              </div>

              {/* Result Pill */}
              <div className="text-right">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-semibold">
                  งบประมาณใหม่สุทธิ
                </span>
                <span className="text-lg sm:text-2xl font-black font-mono tracking-tight text-white">
                  ฿{resultingAmount.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* 2. Calculator Mode Selector (เครื่องคิดเลข: +, -, =) */}
          <div className="grid grid-cols-3 gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
            <button
              type="button"
              onClick={() => {
                setCalcMode('SET');
                if (calcMode !== 'SET') setInputValue(String(resultingAmount || baseBudget || ''));
              }}
              className={`py-2 px-3 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                calcMode === 'SET'
                  ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <Equal className="w-4 h-4 stroke-[2.5]" />
              <span>กำหนดวงเงินตรง (=)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCalcMode('ADD');
                if (calcMode !== 'ADD') setInputValue('');
              }}
              className={`py-2 px-3 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                calcMode === 'ADD'
                  ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/20'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>เติมงบเพิ่ม (+)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCalcMode('SUBTRACT');
                if (calcMode !== 'SUBTRACT') setInputValue('');
              }}
              className={`py-2 px-3 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                calcMode === 'SUBTRACT'
                  ? 'bg-rose-600 text-white shadow-sm shadow-rose-600/20'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <Minus className="w-4 h-4 stroke-[2.5]" />
              <span>ปรับลดงบ (-)</span>
            </button>
          </div>

          {/* 3. Direct Input Field (supports single digits 1, 2, 5, etc. via step="any") */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1">
                <span>
                  {calcMode === 'SET' && 'ระบุวงเงินงบประมาณใหม่ (บาท)'}
                  {calcMode === 'ADD' && 'ระบุยอดเงินที่ต้องการเติมเพิ่ม (บาท)'}
                  {calcMode === 'SUBTRACT' && 'ระบุยอดเงินที่ต้องการปรับลด (บาท)'}
                </span>
                <span className="text-rose-500">*</span>
              </label>

              <button
                type="button"
                onClick={() => setShowKeypad(!showKeypad)}
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
              >
                <Calculator className="w-3.5 h-3.5" />
                <span>{showKeypad ? 'ซ่อนแป้นเครื่องคิดเลข' : 'แสดงแป้นเครื่องคิดเลข'}</span>
              </button>
            </div>

            <div className="relative">
              <span className={`absolute left-4 top-1/2 -translate-y-1/2 font-bold text-base ${
                calcMode === 'ADD' ? 'text-emerald-500' : calcMode === 'SUBTRACT' ? 'text-rose-500' : 'text-slate-400'
              }`}>
                {calcMode === 'ADD' ? '+' : calcMode === 'SUBTRACT' ? '-' : '฿'}
              </span>
              <input
                type="number"
                min="0"
                step="any"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={
                  calcMode === 'SET' 
                    ? 'ระบุวงเงิน เช่น 1000000 หรือพิมพ์หลักหน่วยได้เลย' 
                    : calcMode === 'ADD' 
                      ? 'ระบุจำนวนที่ต้องการเพิ่ม เช่น 50000 หรือ 1' 
                      : 'ระบุจำนวนที่ต้องการลด เช่น 25000 หรือ 1'
                }
                autoFocus
                className="w-full pl-9 pr-24 py-3 bg-slate-50 hover:bg-white focus:bg-white border border-slate-300 rounded-2xl text-slate-900 font-mono font-bold text-lg sm:text-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {inputValue !== '' && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="px-2 py-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 text-xs font-semibold cursor-pointer"
                    title="ล้างค่า"
                  >
                    ล้าง
                  </button>
                )}
                <span className="text-xs font-bold text-slate-400 font-mono">THB</span>
              </div>
            </div>
          </div>

          {/* 4. Single-Unit & Denomination Adjustment Chips (หลักหน่วย 1, 10, 100, 1000, ...) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
              <span>ปุ่มลัดปรับค่า (รองรับหลักหน่วย 1 ถึง 100,000):</span>
              <button
                type="button"
                onClick={handleReset}
                className="text-slate-400 hover:text-indigo-600 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                <span>รีเซ็ตตามเดิม</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {[1, 10, 100, 1000, 10000, 50000, 100000].map(val => (
                <button
                  key={`step-plus-${val}`}
                  type="button"
                  onClick={() => handleDeltaStep(val)}
                  className="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-emerald-50 hover:text-emerald-700 text-slate-700 font-mono text-xs font-bold border border-slate-200 transition-all cursor-pointer active:scale-95"
                >
                  +{val.toLocaleString()}
                </button>
              ))}

              {calcMode === 'SET' && [1, 10, 100, 1000, 10000, 50000].map(val => (
                <button
                  key={`step-minus-${val}`}
                  type="button"
                  onClick={() => handleDeltaStep(-val)}
                  className="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-rose-50 hover:text-rose-700 text-slate-700 font-mono text-xs font-bold border border-slate-200 transition-all cursor-pointer active:scale-95"
                >
                  -{val.toLocaleString()}
                </button>
              ))}

              {/* Standard presets for departments */}
              <button
                type="button"
                onClick={() => handlePresetSet(isPD ? 1000000 : 150000)}
                className="px-2.5 py-1 rounded-xl bg-indigo-50 text-indigo-700 font-mono text-xs font-bold border border-indigo-200 hover:bg-indigo-100 transition-all cursor-pointer"
              >
                {isPD ? '1,000,000 (มาตรฐาน PD)' : '150,000 (มาตรฐาน QC)'}
              </button>
            </div>
          </div>

          {/* 5. Interactive Calculator Keypad (ระบบเครื่องคิดเลขแบบตรงๆ) */}
          {showKeypad && (
            <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/90 shadow-2xs space-y-2">
              <div className="grid grid-cols-4 gap-2">
                {/* Row 1 */}
                <button
                  type="button"
                  onClick={handleClear}
                  className="py-2.5 rounded-xl bg-rose-100 text-rose-700 hover:bg-rose-200 font-mono font-bold text-sm transition-all cursor-pointer active:scale-95"
                >
                  C
                </button>
                <button
                  type="button"
                  onClick={handleBackspace}
                  className="py-2.5 rounded-xl bg-slate-200/80 text-slate-700 hover:bg-slate-300 font-mono font-bold text-sm flex items-center justify-center transition-all cursor-pointer active:scale-95"
                  title="ลบตัวเลขตัวหลัง"
                >
                  <Delete className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDigitPress('00')}
                  className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-sm border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                >
                  00
                </button>
                <button
                  type="button"
                  onClick={() => setCalcMode('ADD')}
                  className={`py-2.5 rounded-xl font-mono font-bold text-sm flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                    calcMode === 'ADD' ? 'bg-emerald-600 text-white' : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                  }`}
                >
                  +
                </button>

                {/* Row 2 */}
                {[7, 8, 9].map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => handleDigitPress(d)}
                    className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-base border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                  >
                    {d}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCalcMode('SUBTRACT')}
                  className={`py-2.5 rounded-xl font-mono font-bold text-sm flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                    calcMode === 'SUBTRACT' ? 'bg-rose-600 text-white' : 'bg-rose-100 text-rose-800 hover:bg-rose-200'
                  }`}
                >
                  -
                </button>

                {/* Row 3 */}
                {[4, 5, 6].map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => handleDigitPress(d)}
                    className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-base border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                  >
                    {d}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCalcMode('SET')}
                  className={`py-2.5 rounded-xl font-mono font-bold text-sm flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                    calcMode === 'SET' ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-800 hover:bg-indigo-200'
                  }`}
                >
                  =
                </button>

                {/* Row 4 */}
                {[1, 2, 3].map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => handleDigitPress(d)}
                    className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-base border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                  >
                    {d}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => handleDigitPress('000')}
                  className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-xs border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                >
                  000
                </button>

                {/* Row 5 */}
                <button
                  type="button"
                  onClick={() => handleDigitPress(0)}
                  className="col-span-2 py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-base border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={() => handleDigitPress('.')}
                  className="py-2.5 rounded-xl bg-white text-slate-800 hover:bg-slate-100 font-mono font-bold text-base border border-slate-200 shadow-2xs transition-all cursor-pointer active:scale-95"
                >
                  .
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="py-2.5 rounded-xl bg-slate-200/80 text-slate-600 hover:bg-slate-300 font-mono font-bold text-xs flex items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                  title="คืนค่างบเดิม"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>เดิม</span>
                </button>
              </div>
            </div>
          )}

          {/* 6. Reason / Note Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              เหตุผลหรือบันทึกประกอบการปรับงบประมาณ <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ระบุเหตุผล เช่น ปรับเพิ่มรองรับคำสั่งผลิต, ปรับลดงบประมาณตามแผนชะลอการสั่งซื้อ..."
              required
              className="w-full px-3.5 py-2.5 bg-slate-50 hover:bg-white focus:bg-white border border-slate-300 rounded-2xl text-slate-800 text-xs sm:text-sm font-medium focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none resize-none"
            />
          </div>

          {/* RBAC notice */}
          <div className="flex items-center gap-2 p-2.5 bg-amber-50/70 border border-amber-200/60 rounded-xl text-[11px] text-amber-800">
            <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
            <span>สิทธิ์เฉพาะ Asst. Manager และ Admin เท่านั้น ยอดปรับจะบันทึกพร้อม Log ประวัติ 1 รายการ</span>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
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
              disabled={isSubmitting || resultingAmount < 0}
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
                  <span>
                    {delta > 0 ? `ยืนยันปรับเพิ่มงบ (+฿${Math.abs(delta).toLocaleString()})` : delta < 0 ? `ยืนยันปรับลดงบ (-฿${Math.abs(delta).toLocaleString()})` : 'บันทึกงบประมาณ'}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
