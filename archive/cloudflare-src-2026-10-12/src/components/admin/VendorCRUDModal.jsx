import React, { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/apiService';
import { storageService } from '../../services/storageService';
import { modalService } from '../../services/modalService';
import { useAppContext } from '../../context/AppContext';
import { 
  Store, X, Building2, Phone, User, FileText, 
  MapPin, Hash, Check, Sparkles, AlertTriangle 
} from 'lucide-react';
import { getUserDepartments, matchDepartment } from '../../utils/permissions';
import { generateNextVendorCode } from '../../utils/idGenerator';

export default function VendorCRUDModal({ 
  vendor, 
  editVendor: propEditVendor, 
  vendors = [], 
  departments: propDepartments, 
  currentRole, 
  currentUser,
  onClose, 
  onRefresh,
  onSaved,
  onCreated 
}) {
  const context = useAppContext();
  const rawDepartments = propDepartments || context?.departments;
  const deptList = useMemo(() => {
    const list = (rawDepartments && rawDepartments.length > 0) ? rawDepartments : (storageService.getDepartments?.() || []);
    return (list || []).filter(d => d.status === 'active' || d.isActive !== false);
  }, [rawDepartments]);

  const editVendor = propEditVendor || vendor;
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
  const lockedDept = isSingleLockedDept ? selectableDepts[0]?.code : null;

  const [selectedDept, setSelectedDept] = useState(() => {
    const rawCurrentDept = editVendor?.department || lockedDept || (canSelectAll ? 'ALL' : (selectableDepts[0]?.code || 'ALL'));
    return (rawCurrentDept === 'BOTH' || !rawCurrentDept) ? 'ALL' : rawCurrentDept;
  });
  const currentDeptScope = lockedDept || selectedDept || 'ALL';

  const vendorCodeInputRef = useRef(null);
  const [vendorCode, setVendorCode] = useState(() => {
    if (editVendor?.code !== undefined && editVendor?.code !== null) return String(editVendor.code);
    if (editVendor?.vendorCode !== undefined && editVendor?.vendorCode !== null) return String(editVendor.vendorCode);
    if (editVendor?.id !== undefined && editVendor?.id !== null) return String(editVendor.id);
    return '';
  });
  const [isSaving, setIsSaving] = useState(false);

  // Combined master vendors from props, context, and storageService/localStorage for complete duplicate guard
  const allVendors = useMemo(() => {
    const fromProps = Array.isArray(vendors) ? vendors : [];
    const fromContext = Array.isArray(context?.vendors) ? context.vendors : [];
    const fromStorage = storageService.getVendors?.() || [];
    const map = new Map();
    [...fromStorage, ...fromContext, ...fromProps].forEach(v => {
      if (v) {
        const vDept = v.department || 'ALL';
        const key = v.id ? String(v.id) : `${vDept}_${v.code || v.vendorCode || Math.random()}`;
        map.set(key, v);
      }
    });
    return Array.from(map.values());
  }, [vendors, context?.vendors]);

  // Duplicate Vendor Code Check scoped by department
  const duplicateVendor = useMemo(() => {
    const cleanVendorCode = String(vendorCode || '').trim().toUpperCase();
    if (!cleanVendorCode) return null;
    return allVendors.find(v => {
      if (!v) return false;
      const vId = String(v.id || '').trim();
      const vCode = String(v.code || '').trim().toUpperCase();
      const editVendorId = editVendor ? String(editVendor.id || '').trim() : '';
      const editVendorCode = editVendor ? String(editVendor.code || editVendor.vendorCode || '').trim().toUpperCase() : '';

      if (editVendor && ((editVendorId && vId === editVendorId) || (editVendorCode && vCode === editVendorCode))) {
        return false;
      }

      // Check department scope:
      // If current is 'ALL' or existing is 'ALL', or both belong to same department
      const vDept = String(v.department || 'ALL').trim().toUpperCase();
      const isSameDeptScope = (currentDeptScope === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, currentDeptScope));
      if (!isSameDeptScope) return false;

      const existingCode = String(v.code || v.vendorCode || v.id || '').trim().toUpperCase();
      return existingCode === cleanVendorCode;
    }) || null;
  }, [vendorCode, allVendors, editVendor, currentDeptScope]);

  const isVendorCodeDuplicate = Boolean(duplicateVendor);
  const isCodeDuplicate = isVendorCodeDuplicate;

  const handleSaveVendor = async (e) => {
    e.preventDefault();
    const cleanVendorCode = String(vendorCode || '').trim().toUpperCase();
    if (!cleanVendorCode) {
      modalService.error('กรุณาระบุรหัสผู้ขาย', 'กรุณาระบุรหัสผู้ขาย (Vendor Code)');
      vendorCodeInputRef.current?.focus();
      return;
    }

    if (isVendorCodeDuplicate) {
      modalService.error(
        'รหัสผู้ขายนี้ถูกใช้งานแล้วในระบบ',
        duplicateVendor
          ? `รหัส "${cleanVendorCode}" ซ้ำกับผู้ขาย: ${duplicateVendor.name} (แผนก: ${duplicateVendor.department || 'ALL'})`
          : `กรุณาระบุรหัสผู้ขายใหม่ที่ไม่ซ้ำในแผนก ${currentDeptScope}`
      );
      vendorCodeInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    try {
      const formData = new FormData(e.target);
      const formDept = formData.get('department');
      const rawDept = lockedDept || formDept || 'ALL';
      const department = (rawDept === 'BOTH' || !rawDept) ? 'ALL' : rawDept;

      const vendorObj = {
        id: editVendor?.id || '',
        code: (formData.get('code') || vendorCode)?.trim().toUpperCase(),
        name: formData.get('name')?.trim(),
        contactPerson: formData.get('contactPerson')?.trim(),
        phone: formData.get('phone')?.trim(),
        taxId: formData.get('taxId')?.trim(),
        department,
        address: formData.get('address')?.trim()
      };

      const saved = await apiService.saveVendor(vendorObj);
      modalService.success('บันทึกผู้ขายเรียบร้อย', `บันทึกข้อมูลผู้ขาย "${vendorObj.name}" สำเร็จ`);
      if (editVendor) {
        if (onSaved) onSaved(saved || vendorObj);
      } else {
        if (onCreated) onCreated(saved || vendorObj);
      }
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึกข้อมูล', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const rawCurrentDept = editVendor?.department || lockedDept || 'ALL';
  const dept = (rawCurrentDept === 'BOTH' || !rawCurrentDept) ? 'ALL' : rawCurrentDept;
  const deptObj = deptList.find(d => d.code === dept || d.id === dept);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <Store className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-slate-900 text-base tracking-tight">
                  {editVendor ? 'แก้ไขข้อมูลผู้จัดจำหน่าย / คู่ค้า' : 'เพิ่มผู้จัดจำหน่ายใหม่'}
                </h3>
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  {dept === 'ALL' ? 'ใช้ร่วมกันทุกแผนก (ALL)' : (deptObj ? `${deptObj.name} (${deptObj.code})` : `แผนก ${dept}`)}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                {editVendor ? `รหัสคู่ค้า: ${editVendor.code} • ${editVendor.name}` : 'กำหนดข้อมูลรายละเอียดคู่ค้า ผู้ติดต่อ และที่อยู่สำหรับออก PO'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── 2. Scrollable Content Body (Flex-1 / Dynamic Height) ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0 custom-scrollbar bg-slate-50/30">
          <form id="vendor-form" onSubmit={handleSaveVendor} className="space-y-5">
            
            {/* Section 1: ข้อมูลบริษัท & รหัสคู่ค้า */}
            <div className="bg-slate-50/70 border border-slate-200/60 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800 uppercase tracking-wider pb-2 border-b border-slate-200/60">
                <Building2 className="w-4 h-4 text-indigo-600" />
                <span>1. ข้อมูลบริษัทคู่ค้า (Company Details)</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-700">
                      รหัสผู้ขาย (Vendor Code) <span className="text-rose-500">*</span>
                    </label>
                    <div className="flex items-center gap-2">
                      {!editVendor && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = generateNextVendorCode(allVendors, currentDeptScope);
                            setVendorCode(next);
                          }}
                          className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline flex items-center gap-1 cursor-pointer transition-colors"
                          title="รันรหัสผู้ขายอัตโนมัติตามแผนก"
                        >
                          <Sparkles className="w-3 h-3 text-amber-500" />
                          <span>รันรหัสอัตโนมัติ ({generateNextVendorCode(allVendors, currentDeptScope)})</span>
                        </button>
                      )}
                      {isVendorCodeDuplicate && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="w-3 h-3 text-rose-500" /> รหัสซ้ำ!
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="relative">
                    <div className={`absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none ${
                      isVendorCodeDuplicate ? 'text-rose-500' : 'text-slate-400'
                    }`}>
                      <Hash className="w-4 h-4" />
                    </div>
                    <input
                      ref={vendorCodeInputRef}
                      name="code"
                      value={vendorCode}
                      onChange={e => setVendorCode(String(e.target.value ?? ''))}
                      placeholder="เช่น VND-01 หรือ VND-TH-001"
                      required
                      className={`w-full h-11 pl-10 pr-3 border rounded-xl text-xs font-mono font-bold uppercase tracking-wide placeholder:font-normal placeholder:text-slate-400 focus:outline-none transition-all ${
                        isVendorCodeDuplicate 
                          ? 'border-rose-500 focus:border-rose-500 focus:ring-2 focus:ring-rose-200 bg-rose-50/20 text-rose-900' 
                          : 'border-slate-200 text-slate-900 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-white'
                      }`}
                    />
                  </div>
                  {isVendorCodeDuplicate && (
                    <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1 font-medium">
                      <span>⚠️</span> รหัสนี้ถูกใช้งานแล้วในแผนก {currentDeptScope} {duplicateVendor ? `(${duplicateVendor.name})` : ''}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                    ขอบเขตแผนกที่ใช้ร่วม (Department Scope) <span className="text-rose-500">*</span>
                  </label>
                  {lockedDept ? (
                    <div className="h-11 border border-indigo-200 bg-indigo-50/80 text-indigo-800 rounded-xl px-3.5 text-xs font-bold flex items-center gap-2">
                      <Building2 className="w-4 h-4 shrink-0" />
                      <span>{deptObj ? `เฉพาะ${deptObj.name} (${deptObj.code})` : `เฉพาะแผนก ${lockedDept}`}</span>
                    </div>
                  ) : (
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                        <Building2 className="w-4 h-4" />
                      </div>
                      <select
                        name="department"
                        value={selectedDept}
                        onChange={e => setSelectedDept(e.target.value)}
                        className="w-full h-11 pl-10 pr-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      >
                        {canSelectAll && <option value="ALL">ใช้ร่วมกันทุกแผนก (ALL)</option>}
                        {selectableDepts.map(d => (
                          <option key={d.code} value={d.code}>
                            เฉพาะ{d.name} ({d.code})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Vendor Company Name */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  ชื่อบริษัท / ร้านค้าผู้จำหน่าย <span className="text-rose-500">*</span>
                </label>
                <input
                  name="name"
                  defaultValue={editVendor?.name}
                  placeholder="เช่น บริษัท วัสดุอุตสาหกรรมไทย จำกัด"
                  required
                  className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                />
              </div>

              {/* Tax ID */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  เลขประจำตัวผู้เสียภาษี (Tax ID)
                </label>
                <input
                  name="taxId"
                  defaultValue={editVendor?.taxId}
                  placeholder="เช่น 0105562012345 (ถ้ามี)"
                  className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-xs font-mono font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                />
              </div>
            </div>

            {/* Section 2: ผู้ติดต่อ & ที่อยู่ */}
            <div className="bg-slate-50/70 border border-slate-200/60 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800 uppercase tracking-wider pb-2 border-b border-slate-200/60">
                <User className="w-4 h-4 text-indigo-600" />
                <span>2. ข้อมูลการติดต่อ & ที่อยู่ (Contact & Billing Address)</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                    ชื่อผู้ติดต่อหลัก (Contact Person)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <User className="w-4 h-4" />
                    </div>
                    <input
                      name="contactPerson"
                      defaultValue={editVendor?.contactPerson}
                      placeholder="เช่น คุณสมศักดิ์ (ฝ่ายขาย)"
                      className="w-full h-11 pl-10 pr-3 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                    เบอร์โทรศัพท์ (Phone Number)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Phone className="w-4 h-4" />
                    </div>
                    <input
                      name="phone"
                      defaultValue={editVendor?.phone}
                      placeholder="เช่น 02-123-4567 หรือ 081-999-8888"
                      className="w-full h-11 pl-10 pr-3 bg-white border border-slate-200 rounded-xl text-xs font-mono font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                    />
                  </div>
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  ที่อยู่สำหรับออกเอกสารสั่งซื้อ & ส่งสินค้า
                </label>
                <textarea
                  name="address"
                  rows="3"
                  defaultValue={editVendor?.address}
                  placeholder="เลขที่ อาคาร ถนน ตำบล/แขวง อำเภอ/เขต จังหวัด รหัสไปรษณีย์"
                  className="w-full p-3 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none"
                />
              </div>
            </div>

          </form>
        </div>

        {/* ── 3. Sticky Action Footer (Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-3 sticky bottom-0 z-20">
          <span className="text-xs text-slate-500 font-medium">
            <span className="text-rose-500 font-bold">*</span> จำเป็นต้องระบุข้อมูล
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              form="vendor-form"
              disabled={isSaving || isVendorCodeDuplicate || !String(vendorCode || '').trim()}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              <span>{isSaving ? 'กำลังบันทึก...' : (editVendor ? 'บันทึกการแก้ไข' : 'เพิ่มผู้ขายใหม่')}</span>
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}

export { generateNextVendorCode };
