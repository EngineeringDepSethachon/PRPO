import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, X, Check, AlertCircle, Palette, Wallet, UserCheck } from 'lucide-react';
import { modalService } from '../../services/modalService';

const DEPT_COLOR_PRESETS = [
  { id: 'blue', label: 'น้ำเงิน (Blue)', dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'amber', label: 'ส้มอำพัน (Amber)', dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'emerald', label: 'เขียวมรกต (Emerald)', dot: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'purple', label: 'ม่วง (Purple)', dot: 'bg-purple-50 text-purple-700 border-purple-200' },
  { id: 'cyan', label: 'ฟ้าคราม (Cyan)', dot: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  { id: 'rose', label: 'แดงกุหลาบ (Rose)', dot: 'bg-rose-50 text-rose-700 border-rose-200' },
  { id: 'slate', label: 'เทาเข้ม (Slate)', dot: 'bg-slate-500', badge: 'bg-slate-100 text-slate-700 border-slate-200' }
];

export default function DepartmentCRUDModal({
  department = null,
  departments = [],
  onClose,
  onSave
}) {
  const isEdit = Boolean(department && department.id);

  const [code, setCode] = useState(department?.code || '');
  const [name, setName] = useState(department?.name || '');
  const [nameEn, setNameEn] = useState(department?.nameEn || '');
  const [prefix, setPrefix] = useState(department?.prefix || department?.code || '');
  const [monthlyBudget, setMonthlyBudget] = useState(department?.monthlyBudget !== undefined ? department.monthlyBudget : 100000);
  const [managerName, setManagerName] = useState(department?.managerName || '');
  const [description, setDescription] = useState(department?.description || '');
  const [color, setColor] = useState(department?.color || 'blue');
  const [isActive, setIsActive] = useState(department?.isActive !== undefined ? department.isActive : true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const isCodeDuplicate = Boolean(
    String(code || '').trim() &&
    departments.some(
      d => String(d.id || '') !== String(department?.id || '') &&
           String(d.code || '').trim().toUpperCase() === String(code || '').trim().toUpperCase()
    )
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const cleanCode = code.trim().toUpperCase();
    const cleanName = name.trim();

    if (!cleanCode) {
      setError('กรุณาระบุรหัสย่อแผนก (เช่น WH, PUR, ENG)');
      return;
    }

    if (!cleanName) {
      setError('กรุณาระบุชื่อแผนกภาษาไทย');
      return;
    }

    if (isCodeDuplicate) {
      setError(`รหัสแผนก "${cleanCode}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น`);
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        id: department?.id || `DEPT-${cleanCode}`,
        code: cleanCode,
        name: cleanName,
        nameEn: nameEn.trim(),
        prefix: (prefix.trim() || cleanCode).toUpperCase(),
        monthlyBudget: Number(monthlyBudget) || 0,
        managerName: managerName.trim(),
        description: description.trim(),
        color,
        isActive,
        updatedAt: new Date().toISOString()
      };

      await onSave(payload);
      onClose();
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการบันทึกข้อมูลแผนก');
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPreset = DEPT_COLOR_PRESETS.find(p => p.id === color) || DEPT_COLOR_PRESETS[0];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-xl rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in my-6 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-xs">
              <Building2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base">
                {isEdit ? 'แก้ไขข้อมูลแผนก / ฝ่าย' : 'เพิ่มแผนก / ฝ่ายใหม่'}
              </h3>
              <p className="text-[11px] text-slate-500">
                ข้อมูล Master Data สำหรับระบุโครงสร้างองค์กร งบประมาณ และการกระจายสิทธิ์
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 text-rose-700 border border-rose-200/70 rounded-xl text-xs flex items-center gap-2 animate-shake">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Code */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                รหัสย่อแผนก (Code) <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={code}
                onChange={e => {
                  const val = e.target.value.toUpperCase();
                  setCode(val);
                  if (!isEdit && !prefix) setPrefix(val);
                }}
                placeholder="เช่น WH, PUR, ENG, IT"
                required
                maxLength={10}
                className={`w-full bg-slate-50 border rounded-xl px-3 py-2 text-xs font-mono font-bold tracking-wider uppercase text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 ${
                  isCodeDuplicate ? 'border-rose-300 ring-2 ring-rose-500/20' : 'border-slate-200'
                }`}
              />
              {isCodeDuplicate && (
                <p className="text-[10px] text-rose-500 mt-1 font-semibold">⚠️ รหัสนี้มีในระบบแล้ว</p>
              )}
            </div>

            {/* Prefix */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                คำนำหน้าเอกสาร (Prefix)
              </label>
              <input
                type="text"
                value={prefix}
                onChange={e => setPrefix(e.target.value.toUpperCase())}
                placeholder="เช่น PR-WH, PO-WH"
                maxLength={10}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono font-semibold uppercase text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            {/* Name TH */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                ชื่อแผนก (ภาษาไทย) <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="เช่น ฝ่ายคลังสินค้าและโลจิสติกส์"
                required
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            {/* Name EN */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                ชื่อแผนก (ภาษาอังกฤษ)
              </label>
              <input
                type="text"
                value={nameEn}
                onChange={e => setNameEn(e.target.value)}
                placeholder="เช่น Warehouse & Logistics"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            {/* Manager Name */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5 text-slate-400" />
                <span>ผู้จัดการ / หัวหน้าฝ่าย</span>
              </label>
              <input
                type="text"
                value={managerName}
                onChange={e => setManagerName(e.target.value)}
                placeholder="เช่น คุณสมคิด คลังทอง"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            {/* Monthly Budget */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <Wallet className="w-3.5 h-3.5 text-slate-400" />
                <span>งบประมาณต่อเดือน (บาท)</span>
              </label>
              <input
                type="number"
                min={0}
                step={1000}
                value={monthlyBudget}
                onChange={e => setMonthlyBudget(e.target.value)}
                placeholder="100000"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            {/* Status */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                สถานะการใช้งาน (Active Status)
              </label>
              <select
                value={isActive ? 'ACTIVE' : 'INACTIVE'}
                onChange={e => setIsActive(e.target.value === 'ACTIVE')}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
              >
                <option value="ACTIVE">✓ เปิดใช้งาน (Active)</option>
                <option value="INACTIVE">⚠️ ระงับการใช้งาน (Inactive)</option>
              </select>
            </div>

            {/* Color Preset */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                <Palette className="w-3.5 h-3.5 text-slate-400" />
                <span>ธีมสีแสดงผลป้ายกำกับ (Badge Theme)</span>
              </label>
              <div className="flex flex-wrap gap-2 pt-1">
                {DEPT_COLOR_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setColor(preset.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                      color === preset.id
                        ? 'border-indigo-600 bg-indigo-50/60 shadow-xs ring-2 ring-indigo-500/20'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${preset.dot}`} />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                ขอบเขตหน้าที่ความรับผิดชอบ (Description)
              </label>
              <textarea
                rows={2}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="ระบุหน้าที่ความรับผิดชอบของแผนก เช่น จัดการคลังวัตถุดิบและกระจายสินค้า..."
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
          </div>

          {/* Preview Badge */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
            <span className="text-xs text-slate-500">ตัวอย่างป้ายกำกับในระบบ:</span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${selectedPreset.badge}`}>
              {name || 'ชื่อแผนก'} ({code || 'CODE'})
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSaving || isCodeDuplicate}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-xs flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูลแผนก'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
