import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { DoorClosed, X, Check, AlertCircle, Building2, Palette } from 'lucide-react';
import { apiService } from '../../services/apiService';
import { storageService } from '../../services/storageService';
import { modalService } from '../../services/modalService';
import { useAppContext } from '../../context/AppContext';
import { getUserDepartments } from '../../utils/permissions';

const COLOR_PRESETS = [
  { id: 'blue', label: 'ฟ้า', dot: 'bg-blue-500', color: 'bg-blue-50 text-blue-700 border-blue-200/80', badgeBg: 'bg-blue-100 text-blue-800' },
  { id: 'violet', label: 'ม่วง', dot: 'bg-violet-500', color: 'bg-violet-50 text-violet-700 border-violet-200/80', badgeBg: 'bg-violet-100 text-violet-800' },
  { id: 'emerald', label: 'เขียว', dot: 'bg-emerald-500', color: 'bg-emerald-50 text-emerald-700 border-emerald-200/80', badgeBg: 'bg-emerald-100 text-emerald-800' },
  { id: 'amber', label: 'ส้มอำพัน', dot: 'bg-amber-500', color: 'bg-amber-50 text-amber-700 border-amber-200/80', badgeBg: 'bg-amber-100 text-amber-800' },
  { id: 'cyan', label: 'ฟ้าคราม', dot: 'bg-cyan-500', color: 'bg-cyan-50 text-cyan-700 border-cyan-200/80', badgeBg: 'bg-cyan-100 text-cyan-800' },
  { id: 'teal', label: 'เขียวน้ำทะเล', dot: 'bg-teal-500', color: 'bg-teal-50 text-teal-700 border-teal-200/80', badgeBg: 'bg-teal-100 text-teal-800' },
  { id: 'fuchsia', label: 'ชมพู', dot: 'bg-fuchsia-500', color: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/80', badgeBg: 'bg-fuchsia-100 text-fuchsia-800' },
  { id: 'rose', label: 'กุหลาบ', dot: 'bg-rose-500', color: 'bg-rose-50 text-rose-700 border-rose-200/80', badgeBg: 'bg-rose-100 text-rose-800' },
  { id: 'slate', label: 'เทาสเลท', dot: 'bg-slate-500', color: 'bg-slate-100 text-slate-700 border-slate-200/80', badgeBg: 'bg-slate-200 text-slate-800' },
];

export default function UsageUnitCRUDModal({
  unit = null,
  usageUnits = [],
  departments: propDepartments,
  currentRole,
  currentUser,
  onClose,
  onSaved,
  onCreated
}) {
  const context = useAppContext();
  const rawDepartments = propDepartments || context?.departments;
  const deptList = useMemo(() => {
    const list = (rawDepartments && rawDepartments.length > 0) ? rawDepartments : (storageService.getDepartments?.() || []);
    return (list || []).filter(d => d.status === 'active' || d.isActive !== false);
  }, [rawDepartments]);

  const effectiveUser = currentUser || context?.currentUser;
  const userDepts = getUserDepartments(currentRole || effectiveUser);
  const canSelectAll = Boolean(
    currentRole?.canViewAllDepts ||
    currentRole?.id === 'ADMIN' ||
    currentRole?.roleId === 'ADMIN' ||
    currentRole?.role === 'admin' ||
    effectiveUser?.role === 'admin' ||
    effectiveUser?.roleId === 'ADMIN' ||
    effectiveUser?.isAdmin === true ||
    Number(currentRole?.level) >= 99 ||
    Number(effectiveUser?.level) >= 99 ||
    userDepts.includes('ALL') ||
    userDepts.includes('*')
  );

  const selectableDepts = useMemo(() => {
    if (canSelectAll) return deptList;
    if (userDepts.length > 0) {
      const filtered = deptList.filter(d => userDepts.some(ud => ud.toUpperCase() === d.code?.toUpperCase()));
      return filtered.length > 0 ? filtered : deptList;
    }
    return deptList;
  }, [deptList, canSelectAll, userDepts]);

  const isSingleLockedDept = !canSelectAll && selectableDepts.length === 1;

  const isEdit = Boolean(unit && unit.id);
  const defaultDeptCode = selectableDepts[0]?.code || 'PD';

  // Normalize legacy 'BOTH' to 'ALL'
  const initialDept = (() => {
    const raw = unit?.department;
    if (raw === 'BOTH') return 'ALL';
    if (raw) return raw;
    if (isSingleLockedDept) return selectableDepts[0]?.code;
    return canSelectAll ? defaultDeptCode : (selectableDepts[0]?.code || defaultDeptCode);
  })();

  const [name, setName] = useState(unit?.name || '');
  const [department, setDepartment] = useState(initialDept);
  const [selectedPreset, setSelectedPreset] = useState(() => {
    if (unit?.dot) {
      const match = COLOR_PRESETS.find(p => p.dot === unit.dot);
      if (match) return match;
    }
    const currentDeptObj = deptList.find(d => d.code === initialDept);
    if (currentDeptObj?.color) {
      const matchColor = COLOR_PRESETS.find(p => p.id === currentDeptObj.color || (currentDeptObj.color === 'purple' && p.id === 'violet'));
      if (matchColor) return matchColor;
    }
    return COLOR_PRESETS[0];
  });
  const [status, setStatus] = useState(unit?.status || 'ACTIVE');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  // Duplicate check within department
  const isNameDuplicate = Boolean(
    String(name || '').trim() &&
    usageUnits.some(
      u => String(u.id || '') !== String(unit?.id || '') &&
           u.department === department &&
           String(u.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()
    )
  );

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('กรุณาระบุชื่อหน่วยเบิกใช้งานหรือชื่อห้อง');
      return;
    }

    if (isNameDuplicate) {
      setError(`ชื่อ "${name.trim()}" มีอยู่ในแผนก ${department} แล้ว กรุณาใช้ชื่ออื่น`);
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        id: unit?.id || undefined,
        name: name.trim(),
        department: department === 'BOTH' ? 'ALL' : department,
        dot: selectedPreset.dot,
        color: selectedPreset.color,
        badgeBg: selectedPreset.badgeBg,
        status
      };

      const saved = await apiService.saveUsageUnit(payload, `${currentRole?.name || 'Admin'} (${currentRole?.title || 'Master Manager'})`);

      modalService.success(
        isEdit ? 'แก้ไขหน่วยเบิกใช้งานเรียบร้อย' : 'เพิ่มหน่วยเบิกใช้งานสำเร็จ',
        `บันทึก "${saved.name}" (${saved.department}) เรียบร้อยแล้ว`
      );

      if (onCreated && !isEdit) onCreated(saved);
      if (onSaved) onSaved(saved);
      onClose();
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
    } finally {
      setIsSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <DoorClosed className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">
                {isEdit ? 'แก้ไขหน่วยเบิกใช้งาน / ห้อง' : 'เพิ่มหน่วยเบิกใช้งานใหม่'}
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                กำหนดห้องหรือพื้นที่ใช้งานสำหรับตัดสต็อกตามแผนก
              </p>
            </div>
          </div>

          <button 
            type="button" 
            onClick={onClose} 
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-6 space-y-5">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2.5 text-xs text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Department Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-500" />
              <span>แผนกที่ใช้งาน (Department Scope)</span>
              <span className="text-rose-500">*</span>
            </label>
            {isSingleLockedDept ? (
              <div className="h-10 bg-slate-50 border border-slate-200 text-slate-700 rounded-xl px-3.5 text-xs font-semibold flex items-center justify-between shadow-2xs select-none">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                  <span>{selectableDepts[0]?.name} ({selectableDepts[0]?.code})</span>
                </div>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-indigo-50 text-indigo-700 border-indigo-200">
                  {selectableDepts[0]?.code}
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selectableDepts.map(d => {
                  const isSelected = department === d.code || department === d.id;
                  const dotColorClass = 
                    d.code === 'PD' ? 'bg-blue-500' :
                    d.code === 'QC' ? 'bg-amber-500' :
                    d.code === 'WH' ? 'bg-emerald-500' :
                    d.code === 'PUR' ? 'bg-purple-500' :
                    d.code === 'ENG' ? 'bg-cyan-500' :
                    (d.color === 'blue' ? 'bg-blue-500' :
                     d.color === 'amber' ? 'bg-amber-500' :
                     d.color === 'emerald' ? 'bg-emerald-500' :
                     d.color === 'purple' || d.color === 'violet' ? 'bg-violet-500' :
                     d.color === 'cyan' ? 'bg-cyan-500' : 'bg-slate-400');

                  return (
                    <button
                      key={d.code || d.id}
                      type="button"
                      onClick={() => {
                        const code = d.code || d.id;
                        setDepartment(code);
                        if (!isEdit) {
                          const matchedPreset = COLOR_PRESETS.find(p => p.id === d.color || (d.color === 'purple' && p.id === 'violet'));
                          if (matchedPreset) setSelectedPreset(matchedPreset);
                        }
                      }}
                      className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer ${
                        isSelected
                          ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-xs ring-2 ring-blue-500/20'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dotColorClass}`} />
                      <span>{d.name} ({d.code})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Name Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center justify-between">
              <span className="flex items-center gap-1">
                <span>ชื่อหน่วยเบิก / ห้องใช้งาน</span>
                <span className="text-rose-500">*</span>
              </span>
              {name.trim() && (
                <span className={`text-[10px] font-mono ${isNameDuplicate ? 'text-rose-500 font-bold' : 'text-slate-400'}`}>
                  {isNameDuplicate ? 'ชื่อนี้มีอยู่แล้ว' : 'ใช้ชื่อนี้ได้'}
                </span>
              )}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`เช่น ห้องใช้งาน หรือพื้นที่สำหรับแผนก ${deptList.find(d => d.code === department)?.name || department}...`}
              className={`w-full px-3.5 py-2.5 rounded-xl border text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 transition-all ${
                isNameDuplicate
                  ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-500/20 bg-rose-50/20'
                  : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20 bg-slate-50/50 focus:bg-white'
              }`}
            />
          </div>

          {/* Color Palette Picker */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5 text-slate-500" />
              <span>สีแท็กชิป (Tag Color)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map(preset => {
                const isSelected = selectedPreset.id === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setSelectedPreset(preset)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-2 transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900 shadow-xs ring-2 ring-indigo-500/20'
                        : `${preset.color} hover:shadow-2xs`
                    }`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${isSelected ? 'bg-white' : preset.dot}`} />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Status & Live Preview */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">สถานะการใช้งาน</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="ACTIVE">เปิดใช้งาน (ACTIVE)</option>
                <option value="INACTIVE">ปิดใช้งานชั่วคราว (INACTIVE)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">ตัวอย่างชิปแสดงผล</label>
              <div className="p-2 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-center">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold border ${selectedPreset.color}`}>
                  <span className={`w-2 h-2 rounded-full ${selectedPreset.dot}`} />
                  <span>{name.trim() || 'ตัวอย่างชื่อห้อง'}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSaving || isNameDuplicate || !name.trim()}
              className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-all flex items-center gap-1.5 shadow-sm cursor-pointer active:scale-95"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{isSaving ? 'กำลังบันทึก...' : isEdit ? 'บันทึกการแก้ไข' : 'เพิ่มหน่วยเบิก'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
