import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  Wallet, X, Plus, Building2, TrendingUp, 
  History, ArrowRight, Sparkles, CheckCircle2, ShieldCheck
} from 'lucide-react';
import { modalService } from '../../services/modalService';
import { storageService } from '../../services/storageService';

export default function BudgetManagementModal(props) {
  if (!props.isOpen) return null;
  return <BudgetManagementModalContent {...props} />;
}

function BudgetManagementModalContent({
  onClose,
  departments = [],
  currentRole,
  currentUser,
  budgetSummary,
  budgetTransactions = [],
  onAdjustBudget,
  onRefresh
}) {
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'adjust' | 'history'

  // Dynamic Departments list with storageService fallback
  const deptList = useMemo(() => {
    const list = (departments && departments.length > 0) ? departments : storageService.getDepartments();
    return (list || []).filter(d => d.isActive !== false);
  }, [departments]);

  // 1. User Permission Scoping: Check if current user is Super Admin or Approver (Universal Access)
  const isSuperAdminOrApprover = useMemo(() => {
    const u = currentUser || currentRole;
    if (!u) return false;
    const roleId = String(u.roleId || u.id || '').toUpperCase();
    const positionKey = String(u.positionKey || '').toUpperCase();
    const roleStr = String(u.role || '').toLowerCase();
    const level = Number(u.level || 0);

    if (roleId === 'ADMIN' || roleStr === 'admin' || level >= 99) return true;
    if (roleId === 'PLANT_MANAGER' || positionKey === 'APPROVER' || u.canFinalApprove || level >= 3) return true;

    const assigned = Array.isArray(u.assignedDepartments) ? u.assignedDepartments : [];
    const allowed = Array.isArray(u.allowedDepartments) ? u.allowedDepartments : [];
    if (assigned.includes('ALL') || assigned.includes('*') || allowed.includes('ALL') || allowed.includes('*')) return true;
    if (u.department === 'ALL' || u.primaryDepartment === 'ALL') return true;

    return false;
  }, [currentUser, currentRole]);

  // Scoped Departments List for the Modal
  const scopedDeptList = useMemo(() => {
    if (isSuperAdminOrApprover) return deptList;
    const u = currentUser || currentRole;
    if (!u) return deptList;

    const rawAssigned = Array.isArray(u.assignedDepartments) && u.assignedDepartments.length > 0
      ? u.assignedDepartments
      : (Array.isArray(u.allowedDepartments) && u.allowedDepartments.length > 0
          ? u.allowedDepartments
          : (Array.isArray(u.departments) && u.departments.length > 0
              ? u.departments
              : (u.department ? [u.department] : [])));

    const validCodes = deptList.map(d => d.code);
    const filtered = rawAssigned.filter(code => validCodes.includes(code));
    const finalCodes = filtered.length > 0 ? filtered : (u.department ? [u.department] : []);
    return deptList.filter(d => finalCodes.includes(d.code));
  }, [deptList, isSuperAdminOrApprover, currentUser, currentRole]);

  // Scoped Transaction Log for History Tab
  const scopedBudgetTransactions = useMemo(() => {
    const validCodes = scopedDeptList.map(d => d.code);
    return budgetTransactions.filter(tx => {
      const txDept = String(tx.dept || tx.department || '').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase();
      return validCodes.includes(txDept);
    });
  }, [budgetTransactions, scopedDeptList]);

  // Form State for Adjustment / Top-up
  const [selectedDept, setSelectedDept] = useState(scopedDeptList[0]?.code || 'PD');

  useEffect(() => {
    if (!scopedDeptList.some(d => d.code === selectedDept)) {
      if (scopedDeptList.length > 0) {
        setSelectedDept(scopedDeptList[0].code);
      }
    }
  }, [scopedDeptList, selectedDept]);

  const [actionType, setActionType] = useState('TOP_UP'); // 'TOP_UP' | 'SET_BUDGET'
  const [adjustAmount, setAdjustAmount] = useState('');
  const [reason, setReason] = useState('');
  const targetMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Department object
  const currentDeptObj = useMemo(() => {
    return scopedDeptList.find(d => d.code === selectedDept) || scopedDeptList[0] || {};
  }, [scopedDeptList, selectedDept]);

  // Current allocated budget for selected department
  const currentSummary = budgetSummary?.current || {};
  const currentAllocated = Number(currentSummary[selectedDept]?.baseAllocated ?? currentSummary[selectedDept]?.allocated) || (currentDeptObj?.monthlyBudget || 200000);

  // Compute Preview Amount
  const numInput = Math.max(0, Number(adjustAmount) || 0);
  const calculatedNewBudget = useMemo(() => {
    if (actionType === 'TOP_UP') {
      return currentAllocated + numInput;
    }
    return numInput > 0 ? numInput : currentAllocated;
  }, [actionType, currentAllocated, numInput]);

  const deltaAmount = calculatedNewBudget - currentAllocated;

  // Handle Quick Chips (+10,000, +50,000, etc.)
  const handleQuickAdd = (val) => {
    const current = Number(adjustAmount) || 0;
    setAdjustAmount(String(current + val));
  };

  // Submit Budget Adjustment
  const handleSubmitAdjustment = async (e) => {
    e.preventDefault();
    if (!scopedDeptList.some(d => d.code === selectedDept)) {
      return modalService.error('ปฏิเสธการเข้าถึง', 'คุณไม่มีสิทธิ์จัดการงบประมาณของแผนกนี้');
    }
    if (numInput <= 0 && actionType === 'TOP_UP') {
      return modalService.warning('กรุณาระบุจำนวนเงิน', 'ยอดเงินที่ต้องการเติมต้องมากกว่า 0 บาท');
    }
    if (numInput <= 0 && actionType === 'SET_BUDGET') {
      return modalService.warning('กรุณาระบุจำนวนเงิน', 'วงเงินงบประมาณต้องมากกว่า 0 บาท');
    }
    if (!reason.trim()) {
      return modalService.warning('กรุณาระบุเหตุผล', 'จำเป็นต้องระบุเหตุผลและความจำเป็นในการปรับยอดงบประมาณ');
    }

    const actionText = actionType === 'TOP_UP' 
      ? `เติมงบประมาณพิเศษ +฿${numInput.toLocaleString()}` 
      : `ปรับวงเงินงบประมาณใหม่เป็น ฿${calculatedNewBudget.toLocaleString()}`;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการปรับยอดงบประมาณ',
      message: `คุณต้องการดำเนินการ "${actionText}" สำหรับฝ่าย ${currentDeptObj.name || selectedDept} ใช่หรือไม่? ยอดจะถูกบันทึกลงระบบและสร้าง Log ประวัติทันที`,
      confirmText: 'ยืนยันบันทึก',
      cancelText: 'ยกเลิก',
      type: 'info'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const actorName = currentUser?.name || currentRole?.name || 'ผู้ดูแลระบบ';
      if (onAdjustBudget) {
        await onAdjustBudget({
          dept: selectedDept,
          action: actionType,
          newAmount: calculatedNewBudget,
          previousAmount: currentAllocated,
          delta: deltaAmount,
          reason: reason.trim(),
          actor: actorName,
          targetMonth
        });
      }
      modalService.success('บันทึกงบประมาณสำเร็จ', `ปรับปรุงงบประมาณฝ่าย ${currentDeptObj.name || selectedDept} เรียบร้อยแล้ว`);
      setAdjustAmount('');
      setReason('');
      if (onRefresh) onRefresh();
      setActiveTab('overview');
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาด', err.message || 'ไม่สามารถบันทึกงบประมาณได้');
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in overflow-y-auto">
      <div 
        className="w-full max-w-4xl bg-white rounded-3xl shadow-2xl border border-slate-200/80 overflow-hidden flex flex-col max-h-[92vh] animate-zoom-in my-auto text-slate-800"
        onClick={e => e.stopPropagation()}
      >
        
        {/* ── Modal Header ── */}
        <div className="px-6 py-4.5 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
              <Wallet className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-900 text-base sm:text-lg tracking-tight truncate">
                  จัดการงบประมาณแผนก (Department Budgets)
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 shrink-0">
                  {targetMonth}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                กำหนดวงเงินงบประมาณประจำเดือน เติมงบประมาณพิเศษ และตรวจสอบประวัติการปรับปรุง
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

        {/* ── Sub-tabs Navigation ── */}
        <div className="px-6 pt-3 pb-2 border-b border-slate-100 bg-white flex items-center gap-2 overflow-x-auto custom-scrollbar shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'overview'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Building2 className="w-4 h-4" />
            <span>{isSuperAdminOrApprover ? 'งบประมาณทุกแผนก' : 'งบประมาณแผนกที่ดูแล'} ({scopedDeptList.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('adjust')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'adjust'
                ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/20'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>เติม / ปรับยอดงบประมาณ (Adjust & Top-up)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/20'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <History className="w-4 h-4" />
            <span>ประวัติธุรกรรมงบ ({scopedBudgetTransactions.length})</span>
          </button>
        </div>

        {/* ── Modal Body Content ── */}
        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 space-y-6">

          {/* ══════════════════════════════════════════════════════════════
              TAB 1: ภาพรวมงบประมาณทุกแผนก (Overview)
              ══════════════════════════════════════════════════════════════ */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  {isSuperAdminOrApprover ? 'รายการงบประมาณจำแนกตามฝ่าย (Departments)' : 'รายการงบประมาณฝ่ายที่ได้รับมอบหมาย'}
                </span>
                <button
                  type="button"
                  onClick={() => setActiveTab('adjust')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-bold rounded-xl border border-emerald-200 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>เติม/ปรับยอดงบ</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {scopedDeptList.map(dept => {
                  const raw = currentSummary[dept.code] || {};
                  const allocated = Number(raw.baseAllocated ?? raw.allocated) || (dept.monthlyBudget || 200000);
                  const spent = Number(raw.actualSpent) || 0;
                  const committed = Number(raw.committed) || 0;
                  const totalUsed = spent + committed;
                  const remaining = allocated - totalUsed;
                  const percent = allocated > 0 ? Math.min(100, Math.round((totalUsed / allocated) * 100)) : 0;
                  const isCritical = percent >= 90 || remaining < 0;
                  const isWarning = percent >= 70 && percent < 90;

                  return (
                    <div 
                      key={dept.code}
                      className="p-5 rounded-2xl border border-slate-200/80 bg-white hover:border-slate-300 hover:shadow-sm transition-all flex flex-col justify-between space-y-3"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 shrink-0"></span>
                            <h4 className="font-bold text-slate-900 text-sm truncate">
                              {dept.name} ({dept.code})
                            </h4>
                          </div>
                          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200/60">
                            {dept.nameEn || dept.code}
                          </span>
                        </div>

                        {/* Financial Metrics Strip */}
                        <div className="grid grid-cols-3 gap-2 py-2 border-y border-slate-100 text-center">
                          <div>
                            <span className="text-[10px] text-slate-400 block">วงเงินจัดสรร</span>
                            <span className="text-xs font-bold font-mono text-slate-800 tabular-nums">
                              ฿{allocated.toLocaleString()}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 block">ใช้ไปแล้ว</span>
                            <span className="text-xs font-bold font-mono text-slate-600 tabular-nums">
                              ฿{totalUsed.toLocaleString()}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 block">คงเหลือ</span>
                            <span className={`text-xs font-bold font-mono tabular-nums ${
                              remaining < 0 ? 'text-rose-600' : isWarning ? 'text-amber-600' : 'text-emerald-600'
                            }`}>
                              ฿{remaining.toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="mt-3 space-y-1">
                          <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
                            <span>การใช้งบ ({percent}%)</span>
                            <span>{remaining >= 0 ? `เหลือ ฿${remaining.toLocaleString()}` : `เกินงบ ฿${Math.abs(remaining).toLocaleString()}`}</span>
                          </div>
                          <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full transition-all duration-500 ${
                                isCritical ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'
                              }`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Card Action Button */}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDept(dept.code);
                          setActionType('TOP_UP');
                          setActiveTab('adjust');
                        }}
                        className="w-full py-2 bg-slate-50 hover:bg-emerald-50 hover:text-emerald-700 text-slate-600 rounded-xl text-xs font-semibold border border-slate-200/80 hover:border-emerald-300 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>ปรับยอด / เติมงบฝ่ายนี้</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              TAB 2: เติม / ปรับยอดงบประมาณ (Adjust & Top-up Form)
              ══════════════════════════════════════════════════════════════ */}
          {activeTab === 'adjust' && (
            <form onSubmit={handleSubmitAdjustment} className="space-y-5">
              
              {/* Select Department Chips */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700 block">
                  1. เลือกแผนก/ฝ่ายที่ต้องการจัดการงบประมาณ <span className="text-rose-500">*</span>
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {scopedDeptList.map(dept => {
                    const isSelected = selectedDept === dept.code;
                    return (
                      <button
                        key={dept.code}
                        type="button"
                        onClick={() => setSelectedDept(dept.code)}
                        className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-emerald-50/80 border-emerald-500 ring-2 ring-emerald-500/20 text-emerald-950 font-bold shadow-xs'
                            : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700 font-medium'
                        }`}
                      >
                        <div className="font-mono text-xs font-bold">{dept.code}</div>
                        <div className="text-[11px] text-slate-500 truncate mt-0.5">{dept.name}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Action Type Selection */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700 block">
                  2. ประเภทการทำรายการ (Action Type) <span className="text-rose-500">*</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label 
                    className={`flex items-start gap-3 p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      actionType === 'TOP_UP'
                        ? 'bg-emerald-50/80 border-emerald-500 ring-2 ring-emerald-500/20'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input 
                      type="radio" 
                      name="actionType" 
                      value="TOP_UP" 
                      checked={actionType === 'TOP_UP'} 
                      onChange={() => setActionType('TOP_UP')}
                      className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                    />
                    <div>
                      <div className="font-bold text-slate-900 text-xs sm:text-sm flex items-center gap-1.5">
                        <span>⚡ เติมงบประมาณพิเศษ (Budget Top-up)</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        บวกเพิ่มยอดเงินงบประมาณเข้าไปในวงเงินปัจจุบันทันที (เหมาะกับกรณีมีงานด่วนหรือโครงการพิเศษ)
                      </p>
                    </div>
                  </label>

                  <label 
                    className={`flex items-start gap-3 p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      actionType === 'SET_BUDGET'
                        ? 'bg-indigo-50/80 border-indigo-500 ring-2 ring-indigo-500/20'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input 
                      type="radio" 
                      name="actionType" 
                      value="SET_BUDGET" 
                      checked={actionType === 'SET_BUDGET'} 
                      onChange={() => setActionType('SET_BUDGET')}
                      className="mt-0.5 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <div className="font-bold text-slate-900 text-xs sm:text-sm flex items-center gap-1.5">
                        <span>💼 กำหนดวงเงินประจำเดือนใหม่ (New Monthly Base)</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        เปลี่ยนตัวเลขวงเงินฐานประจำเดือนของแผนกใหม่ทั้งหมด (Re-allocate)
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Amount Input & Quick Chips */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-700 block">
                    3. จำนวนเงิน {actionType === 'TOP_UP' ? 'ที่ต้องการเติมเพิ่ม (บาท)' : 'วงเงินงบประมาณใหม่ (บาท)'} <span className="text-rose-500">*</span>
                  </label>
                  <span className="text-[11px] text-slate-400 font-mono">
                    วงเงินปัจจุบัน: ฿{currentAllocated.toLocaleString()}
                  </span>
                </div>

                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                    ฿
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={adjustAmount}
                    onChange={e => setAdjustAmount(e.target.value)}
                    placeholder={actionType === 'TOP_UP' ? 'ระบุยอดเงินที่ต้องการเติม เช่น 50000' : 'ระบุวงเงินใหม่ เช่น 300000'}
                    className="w-full pl-9 pr-4 py-3 rounded-2xl border border-slate-300 font-mono font-bold text-slate-900 text-base sm:text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    required
                  />
                </div>

                {/* Quick Helper Chips */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-[11px] text-slate-400 font-medium">ปุ่มลัด:</span>
                  {[10000, 25000, 50000, 100000].map(val => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => handleQuickAdd(val)}
                      className="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono text-xs font-semibold transition-colors cursor-pointer"
                    >
                      +{val.toLocaleString()}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setAdjustAmount('')}
                    className="px-2 py-1 rounded-xl text-slate-400 hover:text-slate-600 text-xs transition-colors cursor-pointer"
                  >
                    ล้างค่า
                  </button>
                </div>
              </div>

              {/* Calculated Delta Summary Box */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-600 shadow-2xs">
                    <TrendingUp className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block uppercase font-bold tracking-wider">
                      การคำนวณวงเงินใหม่
                    </span>
                    <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mt-0.5">
                      <span>฿{currentAllocated.toLocaleString()}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-bold text-slate-900 font-mono text-sm">
                        ฿{calculatedNewBudget.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block font-medium">ส่วนต่างวงเงิน (Delta)</span>
                  <span className={`text-sm font-mono font-bold ${
                    deltaAmount > 0 ? 'text-emerald-600' : deltaAmount < 0 ? 'text-rose-600' : 'text-slate-600'
                  }`}>
                    {deltaAmount > 0 ? `+฿${deltaAmount.toLocaleString()}` : `฿${deltaAmount.toLocaleString()}`}
                  </span>
                </div>
              </div>

              {/* Reason Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 block">
                  4. เหตุผลและความจำเป็นในการปรับปรุงงบประมาณ <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows="2"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="เช่น รองรับการผลิตออเดอร์พิเศษช่วงเทศกาล, ซ่อมบำรุงเครื่องจักรประจำปี, สั่งซื้อสารเคมีสำรอง..."
                  className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-300 text-xs sm:text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all resize-none"
                  required
                />
              </div>

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('overview')}
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
                  <span>{isSubmitting ? 'กำลังบันทึกลงระบบ...' : 'ยืนยันบันทึกงบประมาณ'}</span>
                </button>
              </div>
            </form>
          )}

          {/* ══════════════════════════════════════════════════════════════
              TAB 3: ประวัติธุรกรรมงบประมาณ (Audit Transactions Log)
              ══════════════════════════════════════════════════════════════ */}
          {activeTab === 'history' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  ประวัติการปรับปรุงวงเงิน & ธุรกรรมงบประมาณทั้งหมด ({scopedBudgetTransactions.length} รายการ)
                </span>
                <span className="text-[11px] text-slate-400 font-mono">
                  บันทึกลง data/budgetTransactions.json
                </span>
              </div>

              {scopedBudgetTransactions.length === 0 ? (
                <div className="p-10 text-center bg-slate-50/70 rounded-2xl border border-slate-200/60">
                  <History className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                  <p className="text-xs text-slate-500 font-medium">ยังไม่มีประวัติการปรับปรุงงบประมาณ</p>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200/80 overflow-hidden shadow-2xs">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-500 font-bold uppercase tracking-wider border-b border-slate-200 text-[11px]">
                        <tr>
                          <th className="py-3 px-4">วัน-เวลา</th>
                          <th className="py-3 px-3">แผนก</th>
                          <th className="py-3 px-3">ประเภทรายการ</th>
                          <th className="py-3 px-3 text-right">จำนวนที่ปรับ (+/-)</th>
                          <th className="py-3 px-3 text-right">วงเงินสุทธิ</th>
                          <th className="py-3 px-3">ผู้ทำรายการ</th>
                          <th className="py-3 px-4">เหตุผล / หมายเหตุ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-normal">
                        {scopedBudgetTransactions.map(tx => (
                          <tr key={tx.id || Math.random()} className="hover:bg-slate-50/70 transition-colors">
                            <td className="py-3 px-4 whitespace-nowrap text-slate-500 font-mono text-[11px]">
                              {tx.date || tx.createdAt?.slice(0, 19).replace('T', ' ')}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap font-bold text-slate-800">
                              {tx.dept}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                                tx.type === 'TOP_UP' 
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : tx.type === 'SET_BUDGET'
                                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                    : 'bg-slate-100 text-slate-700 border border-slate-200'
                              }`}>
                                {tx.typeLabel || tx.type}
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right whitespace-nowrap font-mono font-bold text-emerald-600">
                              {tx.amount > 0 ? `+฿${Number(tx.amount).toLocaleString()}` : `฿${Number(tx.amount || 0).toLocaleString()}`}
                            </td>
                            <td className="py-3 px-3 text-right whitespace-nowrap font-mono text-slate-900 font-semibold">
                              ฿{Number(tx.newAmount || tx.monthlyBudget || 0).toLocaleString()}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap text-slate-600 text-[11px]">
                              {tx.actor || 'System'}
                            </td>
                            <td className="py-3 px-4 text-slate-600 max-w-[200px] truncate" title={tx.note}>
                              {tx.note || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* ── Modal Footer ── */}
        <div className="px-6 py-3.5 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 shrink-0">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>ระบบงบประมาณเชื่อมโยงโดยตรงกับฐานข้อมูล SSOT ผ่าน REST API</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 font-medium hover:bg-slate-50 transition-colors cursor-pointer"
          >
            ปิดหน้าต่าง
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
