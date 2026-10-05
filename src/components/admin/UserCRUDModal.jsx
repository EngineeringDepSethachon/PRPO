import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  Users, X, Check, AlertCircle, Building2, Shield, 
  Mail, User, Lock, Plus, Trash2, CheckCircle2, ShieldAlert
} from 'lucide-react';
import { apiService } from '../../services/apiService';
import { modalService } from '../../services/modalService';
import { storageService } from '../../services/storageService';

const ROLE_OPTIONS = [
  { id: 'REQUESTER', label: 'Requester - ผู้ขอซื้อ (ตามแผนกที่ได้รับมอบหมาย)', level: 1, defaultDept: null, title: 'Requester' },
  { id: 'ASST_MANAGER', label: 'Reviewer - ผู้ตรวจทาน (Asst. Manager)', level: 2, defaultDept: 'ALL', title: 'Assistant Manager' },
  { id: 'PLANT_MANAGER', label: 'Approver - ผู้อนุมัติ (Plant Manager)', level: 3, defaultDept: 'ALL', title: 'Plant Manager' },
  { id: 'ONLINE_PURCHASER', label: 'Purchaser - เจ้าหน้าที่จัดซื้อออนไลน์ (Online)', level: 2, defaultDept: 'ALL', title: 'Online Purchaser' },
  { id: 'ADMIN', label: 'Admin - ผู้ดูแลระบบสูงสุด (System Admin)', level: 99, defaultDept: 'ALL', title: 'System Administrator' },
];

function normalizeRoleId(rid) {
  if (!rid) return 'REQUESTER';
  if (rid === 'REQUESTER_PD' || rid === 'REQUESTER_QC') return 'REQUESTER';
  return rid;
}

export default function UserCRUDModal({
  user = null,
  users = [],
  departments = [],
  currentRole,
  onClose,
  onSaved,
  onCreated
}) {
  const isEdit = Boolean(user && user.id);
  const isSelf = isEdit && (currentRole?.id === user?.id || currentRole?.username === user?.username);

  const [name, setName] = useState(user?.name || user?.displayName || '');
  const [employeeName, setEmployeeName] = useState(user?.employeeName || user?.name || '');
  const [username, setUsername] = useState(user?.username || '');
  const [password, setPassword] = useState(user?.password || '');
  const [position, setPosition] = useState(user?.position || user?.title || '');
  const [selectedRoleId, setSelectedRoleId] = useState(normalizeRoleId(user?.roleId));
  const [primaryDept, setPrimaryDept] = useState(user?.primaryDepartment || user?.department || 'ALL');
  
  // Allowed departments multi-select
  const [allowedDepts, setAllowedDepts] = useState(() => {
    if (user?.allowedDepartments && Array.isArray(user.allowedDepartments)) {
      return [...user.allowedDepartments];
    }
    const fallback = user?.department || 'PD';
    return fallback === 'ALL' ? ['*'] : [fallback];
  });

  const [newCustomDept, setNewCustomDept] = useState('');
  const [showAddDeptInput, setShowAddDeptInput] = useState(false);
  const [status, setStatus] = useState(user?.status || 'ACTIVE');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  // Toggle department in allowedDepts
  const handleToggleDept = (dept) => {
    if (dept === '*') {
      if (allowedDepts.includes('*')) {
        const fallbackCode = deptList[0]?.code || 'PD';
        setAllowedDepts(primaryDept === 'ALL' ? [fallbackCode] : [primaryDept]);
      } else {
        setAllowedDepts(['*']);
      }
      return;
    }

    // If already wildcard '*', un-wildcard and select this one
    let next = allowedDepts.filter(d => d !== '*');
    if (next.includes(dept)) {
      next = next.filter(d => d !== dept);
      // Ensure at least primaryDept remains if all unselected
      if (next.length === 0) {
        next = [primaryDept];
      }
    } else {
      next.push(dept);
    }
    setAllowedDepts(next);
  };

  const handleAddCustomDept = () => {
    const code = newCustomDept.trim().toUpperCase();
    if (!code) return;
    if (!allowedDepts.includes(code)) {
      setAllowedDepts(prev => [...prev.filter(d => d !== '*'), code]);
    }
    setNewCustomDept('');
    setShowAddDeptInput(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('กรุณาระบุชื่อผู้ใช้งาน');
      return;
    }

    if (!username.trim()) {
      setError('กรุณาระบุชื่อผู้ใช้ / Username');
      return;
    }

    // Check duplicate username
    const isDuplicate = users.some(
      u => u.id !== user?.id && u.username?.trim().toLowerCase() === username.trim().toLowerCase()
    );
    if (isDuplicate) {
      setError(`Username "${username.trim()}" มีอยู่ในระบบแล้ว กรุณาระบุชื่ออื่น`);
      return;
    }

    // Self-lockout guard checks
    if (isSelf && status === 'INACTIVE') {
      setError('ไม่สามารถปิดการใช้งานบัญชีของตนเองได้ (Self-Lockout Protection)');
      return;
    }

    setIsSaving(true);
    try {
      const selectedRole = ROLE_OPTIONS.find(r => r.id === selectedRoleId) || ROLE_OPTIONS[0];
      const hasWildcard = allowedDepts.includes('*') || allowedDepts.includes('ALL');
      const isAllDepts = hasWildcard || (allowedDepts.length === 0 && selectedRole.defaultDept === 'ALL');
      const deptsToSave = allowedDepts.length > 0 ? allowedDepts : (isAllDepts ? ['*'] : [primaryDept]);
      const assignedDepartments = hasWildcard ? ['ALL'] : deptsToSave;

      const payload = {
        id: user?.id || undefined,
        employeeId: user?.employeeId || `EMP-${primaryDept !== 'ALL' ? primaryDept : 'SYS'}-${Date.now().toString().slice(-3)}`,
        username: username.trim().toLowerCase(),
        password: password || user?.password || '',
        name: name.trim(),
        employeeName: employeeName.trim() || name.trim(),
        displayName: name.trim(),
        position: position.trim(),
        primaryDepartment: primaryDept,
        department: primaryDept,
        assignedDepartments,
        allowedDepartments: deptsToSave,
        roleId: selectedRole.id,
        positionKey: selectedRole.id,
        title: position.trim() || selectedRole.title,
        level: selectedRole.level,
        status,
        description: user?.description || `${selectedRole.title} ประจำแผนก ${assignedDepartments.join(', ')}`
      };

      const saved = await apiService.saveUser(payload, `${currentRole?.name || 'Admin'}`);

      modalService.success(
        isEdit ? 'แก้ไขผู้ใช้งานสำเร็จ' : 'เพิ่มผู้ใช้งานสำเร็จ',
        `บันทึกข้อมูล "${saved.name}" (${saved.title}) เรียบร้อยแล้ว`
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

  // Dynamic Departments from master data
  const deptList = useMemo(() => {
    const list = (departments && departments.length > 0) ? departments : storageService.getDepartments();
    return (list || []).filter(d => d.isActive !== false);
  }, [departments]);

  // Compute all unique available departments to display as chips
  const allDeptChips = useMemo(() => {
    const codes = deptList.map(d => d.code);
    return Array.from(new Set([
      ...codes,
      primaryDept,
      ...allowedDepts.filter(d => d !== '*')
    ])).filter(Boolean);
  }, [deptList, primaryDept, allowedDepts]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden overflow-y-auto">
      <div className="w-full max-w-xl rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in my-8">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">
                {isEdit ? 'แก้ไขผู้ใช้งานและสิทธิ์เข้าถึง' : 'เพิ่มผู้ใช้งานใหม่ (Add User)'}
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                กำหนดบทบาท แผนกหลัก และขอบเขตแผนกที่ได้รับสิทธิ์ข้ามสายงาน
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
        <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto custom-scrollbar">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2.5 text-xs text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Self-Lockout Guard Banner */}
          {isSelf && (
            <div className="p-3.5 bg-amber-50 border border-amber-200/80 rounded-2xl flex items-start gap-3 text-xs text-amber-800">
              <ShieldAlert className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-bold block">ระบบป้องกัน Self-Lockout Guard กำลังทำงาน</span>
                <span className="text-amber-700">
                  คุณกำลังแก้ไขบัญชีของตนเอง ไม่อนุญาตให้ปิดการใช้งานหรือลดสิทธิ์ตนเองเพื่อป้องกันปัญหาไม่สามารถเข้าสู่ระบบได้
                </span>
              </div>
            </div>
          )}

          {/* Basic Fields: Name & Username */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-slate-400" />
                <span>ชื่อแสดงผล (Display Name)</span>
                <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="เช่น คุณวิชัย (PD)"
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white transition-all"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-slate-400" />
                <span>ชื่อผู้ใช้ / Username</span>
                <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="เช่น wichai.pd หรือ user@company.com"
                disabled={isSelf}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white disabled:opacity-60 transition-all font-mono"
              />
            </div>

            {/* Password Field */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                <Lock className="w-3.5 h-3.5 text-slate-400" />
                <span>รหัสผ่าน / Password</span>
                {!isEdit && <span className="text-rose-500">*</span>}
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={isEdit ? "เว้นว่างไว้หากไม่ต้องการเปลี่ยนรหัสผ่าน" : "รหัสผ่านเข้าใช้งาน"}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white transition-all font-mono"
              />
            </div>
          </div>

          {/* Position Field */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-indigo-600" />
              <span>ตำแหน่ง (Position)</span>
            </label>
            <input
              type="text"
              value={position}
              onChange={e => setPosition(e.target.value)}
              placeholder="เช่น วิศวกรฝ่ายผลิต หรือ เจ้าหน้าที่จัดซื้อ"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white transition-all"
            />
          </div>

          {/* Role & Position Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-indigo-600" />
              <span>บทบาทหน้าที่ (Role & Workflow Position)</span>
              <span className="text-rose-500">*</span>
            </label>
            <select
              value={selectedRoleId}
              onChange={e => {
                const rId = e.target.value;
                setSelectedRoleId(rId);
                const rObj = ROLE_OPTIONS.find(r => r.id === rId);
                if (rObj && rObj.defaultDept !== 'ALL') {
                  setPrimaryDept(rObj.defaultDept);
                  if (!allowedDepts.includes(rObj.defaultDept)) {
                    setAllowedDepts(prev => [...prev.filter(d => d !== '*'), rObj.defaultDept]);
                  }
                } else if (rObj && rObj.defaultDept === 'ALL') {
                  setPrimaryDept('ALL');
                  setAllowedDepts(['*']);
                }
              }}
              disabled={isSelf}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white disabled:opacity-60 transition-all"
            >
              {ROLE_OPTIONS.map(role => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>

          {/* Primary Department Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-500" />
              <span>แผนกหลัก (Primary Department)</span>
              <span className="text-rose-500">*</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {deptList.map(dept => (
                <button
                  key={dept.code}
                  type="button"
                  onClick={() => {
                    setPrimaryDept(dept.code);
                    if (!allowedDepts.includes(dept.code) && !allowedDepts.includes('*')) {
                      setAllowedDepts(prev => [...prev, dept.code]);
                    }
                  }}
                  className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    primaryDept === dept.code
                      ? 'bg-indigo-50 border-indigo-500 text-indigo-700 shadow-xs ring-2 ring-indigo-500/20'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  <span className="truncate">{dept.name} ({dept.code})</span>
                </button>
              ))}

              <button
                type="button"
                onClick={() => {
                  setPrimaryDept('ALL');
                  setAllowedDepts(['*']);
                }}
                className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  primaryDept === 'ALL'
                    ? 'bg-emerald-50 border-emerald-500 text-emerald-700 shadow-xs ring-2 ring-emerald-500/20'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span>ทุกแผนก (ALL)</span>
              </button>
            </div>
          </div>

          {/* Authorized Departments (Cross-Department Scope) */}
          <div className="space-y-2 pt-1 p-3.5 bg-slate-50/80 rounded-2xl border border-slate-200/80">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-indigo-600" />
                  <span>ขอบเขตแผนกที่ดูแล / มีสิทธิ์ (Authorized Departments)</span>
                </label>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  เลือกแผนกที่ผู้ใช้นี้ได้รับอนุญาตให้เห็นและจัดการงาน (เลือกได้หลายแผนกเพื่อดูแลงานข้ามสายงาน)
                </p>
              </div>
            </div>

            {/* Department Multi-select Pills */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {/* Wildcard Option */}
              <button
                type="button"
                onClick={() => handleToggleDept('*')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
                  allowedDepts.includes('*')
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs ring-2 ring-indigo-500/20'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>ทุกแผนก (*)</span>
                {allowedDepts.includes('*') && <Check className="w-3.5 h-3.5 text-emerald-400" />}
              </button>

              {/* Department Specific Chips */}
              {allDeptChips.map(dept => {
                const isSelected = allowedDepts.includes('*') || allowedDepts.includes(dept);
                const isPrimary = primaryDept === dept;
                return (
                  <button
                    key={dept}
                    type="button"
                    onClick={() => handleToggleDept(dept)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? dept === 'PD'
                          ? 'bg-blue-50 border-blue-300 text-blue-800 font-bold shadow-2xs'
                          : dept === 'QC'
                          ? 'bg-amber-50 border-amber-300 text-amber-800 font-bold shadow-2xs'
                          : 'bg-indigo-50 border-indigo-300 text-indigo-800 font-bold shadow-2xs'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${dept === 'PD' ? 'bg-blue-500' : dept === 'QC' ? 'bg-amber-500' : 'bg-indigo-500'}`} />
                    <span>แผนก {dept}</span>
                    {isPrimary && <span className="text-[10px] text-slate-400 font-normal">(หลัก)</span>}
                    {isSelected && <Check className="w-3 h-3 text-indigo-600 shrink-0" />}
                  </button>
                );
              })}

              {/* + Add New Department Chip (for future expansion) */}
              {!showAddDeptInput ? (
                <button
                  type="button"
                  onClick={() => setShowAddDeptInput(true)}
                  className="px-2.5 py-1.5 rounded-xl border border-dashed border-slate-300 hover:border-indigo-400 text-slate-500 hover:text-indigo-600 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1 bg-white hover:bg-indigo-50/50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>เพิ่มแผนกใหม่</span>
                </button>
              ) : (
                <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-indigo-300 shadow-2xs">
                  <input
                    type="text"
                    value={newCustomDept}
                    onChange={e => setNewCustomDept(e.target.value)}
                    placeholder="เช่น R&D, WH..."
                    className="w-24 px-2 py-0.5 text-xs font-bold uppercase focus:outline-none"
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomDept(); } }}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomDept}
                    className="p-1 text-indigo-600 hover:bg-indigo-50 rounded-lg"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddDeptInput(false); setNewCustomDept(''); }}
                    className="p-1 text-slate-400 hover:bg-slate-100 rounded-lg"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Account Status */}
          <div className="space-y-1.5 pt-1">
            <label className="text-xs font-semibold text-slate-700">สถานะการใช้งานบัญชี</label>
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              disabled={isSelf}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50/50 focus:bg-white disabled:opacity-60 transition-all"
            >
              <option value="ACTIVE">เปิดใช้งานปกติ (ACTIVE)</option>
              <option value="INACTIVE">ระงับการใช้งานชั่วคราว (INACTIVE)</option>
            </select>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSaving || !name.trim() || !username.trim()}
              className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-all flex items-center gap-1.5 shadow-sm cursor-pointer active:scale-95"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{isSaving ? 'กำลังบันทึก...' : isEdit ? 'บันทึกการแก้ไข' : 'สร้างผู้ใช้ใหม่'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
