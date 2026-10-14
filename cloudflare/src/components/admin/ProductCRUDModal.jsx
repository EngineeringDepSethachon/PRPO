import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/apiService';
import { storageService } from '../../services/storageService';
import { modalService } from '../../services/modalService';
import { 
  Package, X, Building2, Tag, Hash, 
  Coins, Clock, AlertTriangle, Boxes, Sparkles, Check,
  ArrowRight, Repeat, Info, MapPin, Plus, Edit3, Trash2
} from 'lucide-react';
import SearchableSelect from '../common/SearchableSelect';
import StorageLocationCRUDModal from './StorageLocationCRUDModal';
import DeleteLocationModal from './DeleteLocationModal';
import { useAppContext } from '../../context/AppContext';
import { getUserDepartments, canAccessDepartmentData, isDepartmentMatch, matchDepartment } from '../../utils/permissions';
import { generateNextProductCode } from '../../utils/idGenerator';

const COMMON_PURCHASE_UNITS = ['ถัง (200L)', 'แกลลอน (20L)', 'ลัง', 'กล่อง', 'ถุง', 'ม้วน', 'ชุด', 'ชิ้น'];
const COMMON_STOCK_UNITS = ['ลิตร', 'มล.', 'กก.', 'กรัม', 'ชิ้น', 'คู่', 'แผ่น', 'ม้วน', 'ขวด', 'กระป๋อง'];

export default function ProductCRUDModal({
  editProd: propEditProd,
  product,
  products = [],
  vendors = [],
  departments: propDepartments,
  storageLocations = [],
  currentRole,
  currentUser,
  lockedCategory: propLockedCategory,
  defaultCategory,
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

  const editProd = propEditProd || product;
  const isEditMode = Boolean(editProd && (editProd.id || editProd.code));
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
      const filtered = deptList.filter(d => userDepts.some(ud => isDepartmentMatch(ud, d)));
      return filtered.length > 0 ? filtered : deptList;
    }
    return deptList;
  }, [deptList, canSelectAll, userDepts]);

  const hasMultipleAllowedDepts = !canSelectAll && selectableDepts.length > 1;
  const isSingleLockedDept = !canSelectAll && selectableDepts.length === 1;
  const lockedCategory = propLockedCategory || (isSingleLockedDept ? (selectableDepts[0]?.code || (selectableDepts[0]?.id ? String(selectableDepts[0].id).replace(/^DEPT-/, '') : 'PD')) : null);

  const skuInputRef = useRef(null);
  const [itemCode, setItemCode] = useState(() => {
    if (editProd?.code !== undefined && editProd?.code !== null) return String(editProd.code);
    if (editProd?.sku !== undefined && editProd?.sku !== null) return String(editProd.sku);
    if (editProd?.id !== undefined && editProd?.id !== null) return String(editProd.id);
    return '';
  });
  const [category, setCategory] = useState(() => {
    if (editProd?.category) return String(editProd.category).replace(/^DEPT-/, '').trim().toUpperCase();
    if (editProd?.department) return String(editProd.department).replace(/^DEPT-/, '').trim().toUpperCase();
    if (lockedCategory) return String(lockedCategory).replace(/^DEPT-/, '').trim().toUpperCase();
    if (defaultCategory) return String(defaultCategory).replace(/^DEPT-/, '').trim().toUpperCase();
    if (selectableDepts.length > 0) return String(selectableDepts[0].code || selectableDepts[0].id).replace(/^DEPT-/, '').trim().toUpperCase();
    return 'PD';
  });
  const [purchaseUnit, setPurchaseUnit] = useState(editProd?.purchaseUnit || editProd?.unit || 'ชิ้น');
  const [stockUnit, setStockUnit] = useState(editProd?.stockUnit || editProd?.unit || 'ชิ้น');
  const [conversionRate, setConversionRate] = useState(editProd?.conversionRate ?? 1);
  const [selectedSupplierId, setSelectedSupplierId] = useState(editProd?.supplierId || '');
  const [selectedLocationId, setSelectedLocationId] = useState(editProd?.locationId || '');
  const [locsList, setLocsList] = useState(() => (storageLocations && storageLocations.length > 0) ? storageLocations : (storageService.getStorageLocations?.() || []));
  const [showCreateLocModal, setShowCreateLocModal] = useState(false);
  const [editLocItem, setEditLocItem] = useState(null);
  const [deleteLocItem, setDeleteLocItem] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (storageLocations && storageLocations.length > 0) {
      setLocsList(storageLocations);
    } else {
      setLocsList(storageService.getStorageLocations?.() || []);
    }
  }, [storageLocations]);

  // Current working department for this modal session
  const currentDept = lockedCategory || category || editProd?.category || editProd?.department || defaultCategory || 'PD';

  // Combined master products from props, context, and storageService/localStorage for complete duplicate guard
  const allProducts = useMemo(() => {
    const fromProps = Array.isArray(products) ? products : [];
    const fromContext = Array.isArray(context?.products) ? context.products : [];
    const fromStorage = storageService.getProducts?.() || [];
    const map = new Map();
    [...fromStorage, ...fromContext, ...fromProps].forEach(p => {
      if (p) {
        const pDept = p.department || p.category || '';
        const key = p.id ? String(p.id) : `${pDept}_${p.code || p.sku || Math.random()}`;
        map.set(key, p);
      }
    });
    return Array.from(map.values());
  }, [products, context?.products]);

  // Real-time Frontend SKU Duplicate Validation (Scoped to Department)
  const isSkuDuplicate = useMemo(() => {
    const inputCode = String(itemCode || '').trim().toLowerCase();
    if (!inputCode) return false;

    return allProducts.some(p => {
      if (!p) return false;
      // 1. ข้ามรายการที่กำลังแก้ไขอยู่
      if (isEditMode) {
        const editProdId = String(editProd?.id || '').trim().toLowerCase();
        const pId = String(p.id || '').trim().toLowerCase();
        if (editProdId && pId === editProdId) return false;
      }

      // 2. ต้องเป็นแผนกเดียวกันก่อน ถึงจะนำมาเช็กรหัสซ้ำ
      const isSameDept = matchDepartment(p.department || p.category, currentDept);
      if (!isSameDept) return false;

      // 3. ตรวจสอบรหัสสินค้าว่าตรงกันหรือไม่
      const existingCode = String(p.code || p.sku || '').trim().toLowerCase();
      return existingCode === inputCode;
    });
  }, [itemCode, currentDept, isEditMode, allProducts, editProd]);

  const duplicateItem = useMemo(() => {
    if (!isSkuDuplicate) return null;
    const inputCode = String(itemCode || '').trim().toLowerCase();
    return allProducts.find(p => {
      if (!p) return false;
      if (isEditMode) {
        const editProdId = String(editProd?.id || '').trim().toLowerCase();
        const pId = String(p.id || '').trim().toLowerCase();
        if (editProdId && pId === editProdId) return false;
      }
      const isSameDept = matchDepartment(p.department || p.category, currentDept);
      if (!isSameDept) return false;
      const existingCode = String(p.code || p.sku || '').trim().toLowerCase();
      return existingCode === inputCode;
    }) || null;
  }, [isSkuDuplicate, itemCode, currentDept, isEditMode, allProducts, editProd]);

  const isCodeDuplicate = isSkuDuplicate;

  // Filter vendors visible to this user
  const visibleVendors = useMemo(() => {
    return vendors.filter(v => {
      return canAccessDepartmentData(currentRole || effectiveUser, v.department);
    });
  }, [vendors, currentRole, effectiveUser]);

  const supplierOptions = useMemo(() => {
    return [
      { value: '', label: '-- ไม่ระบุผู้ขายหลัก (จัดซื้อจะเลือกในใบขอซื้อ PR) --', subLabel: 'ปล่อยว่างไว้เพื่อให้ฝ่ายจัดซื้อเสนอราคา' },
      ...visibleVendors.map(v => ({
        value: v.id,
        label: v.name,
        code: v.code,
        subLabel: `ผู้ติดต่อ: ${v.contactPerson || '-'} • โทร: ${v.phone || '-'}`,
        badge: v.department === 'BOTH' ? 'ใช้ร่วมกัน' : `เฉพาะ ${v.department}`,
        keywords: `${v.code} ${v.name} ${v.contactPerson} ${v.phone}`
      }))
    ];
  }, [visibleVendors]);

  // Filter locations visible to product category
  const locationOptions = useMemo(() => {
    const activeCat = category || lockedCategory || deptList[0]?.code || 'PD';
    const filtered = locsList.filter(l => (l.department === activeCat || l.department === 'ALL'));
    return [
      { value: '', label: '-- ยังไม่ระบุจุดจัดเก็บสินค้า --', subLabel: 'สามารถเลือกหรือระบุภายหลังได้' },
      ...filtered.map(l => {
        const dObj = deptList.find(d => d.code === l.department || d.id === l.department);
        return {
          value: l.id,
          label: l.name,
          badge: l.department === 'ALL' ? 'ส่วนกลาง' : (dObj ? dObj.name : `แผนก ${l.department}`),
          keywords: `${l.name} ${l.department}`
        };
      })
    ];
  }, [locsList, lockedCategory, category, deptList]);

  const handleSaveProduct = async (e) => {
    e.preventDefault();
    const cleanSku = String(itemCode || '').trim().toUpperCase();
    if (!cleanSku) {
      modalService.error('กรุณาระบุรหัสสินค้า', 'กรุณาระบุรหัสสินค้า (SKU / Item Code)');
      skuInputRef.current?.focus();
      return;
    }

    if (isSkuDuplicate) {
      modalService.error(
        'รหัสสินค้านี้มีอยู่ในระบบแล้ว',
        duplicateItem 
          ? `รหัส "${cleanSku}" ซ้ำกับสินค้าในแผนก ${currentDept}: ${duplicateItem.name} กรุณาใช้รหัสอื่น`
          : `⚠️ รหัสสินค้านี้มีอยู่ในระบบแล้วในแผนก ${currentDept} กรุณาใช้รหัสอื่น`
      );
      skuInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    try {
      const formData = new FormData(e.target);
      const pUnit = String(formData.get('purchaseUnit') || purchaseUnit || 'ชิ้น').trim();
      const sUnit = String(formData.get('stockUnit') || stockUnit || 'ชิ้น').trim();
      const convRate = Number(formData.get('conversionRate')) || Number(conversionRate) || 1;
      const selectedLoc = locsList.find(l => l.id === selectedLocationId);

      const rawCategory = lockedCategory || category || formData.get('category') || 'PD';
      const cleanDeptCode = String(rawCategory).replace(/^DEPT-/, '').trim().toUpperCase() || 'PD';

      const prodObj = {
        id: editProd?.id ? String(editProd.id) : '',
        code: String(formData.get('code') || itemCode || '').trim().toUpperCase(),
        name: String(formData.get('name') || '').trim(),
        category: cleanDeptCode,
        department: cleanDeptCode,
        dept: cleanDeptCode,
        purchaseUnit: pUnit,
        stockUnit: sUnit,
        conversionRate: convRate > 0 ? convRate : 1,
        unit: sUnit, // Primary unit in stock for backward compatibility
        price: Number(formData.get('price')) || 0,
        stockBalance: editProd ? (editProd.stockBalance || 0) : (Number(formData.get('stockBalance')) || 0),
        reorderPoint: Number(formData.get('reorderPoint')) || 0,
        leadTimeDays: Number(formData.get('leadTimeDays')) || 7,
        supplierId: selectedSupplierId || null,
        locationId: selectedLocationId || null,
        locationName: selectedLoc ? selectedLoc.name : (selectedLocationId ? selectedLocationId : null),
        isActive: editProd?.isActive !== undefined ? (editProd.isActive === true || String(editProd.isActive).toUpperCase() === 'TRUE') : true,
        status: editProd?.status || ((editProd?.isActive === false || String(editProd?.isActive).toUpperCase() === 'FALSE') ? 'INACTIVE' : 'ACTIVE'),
        isEdit: isEditMode,
        _mode: isEditMode ? 'EDIT' : 'CREATE'
      };

      const saved = await apiService.saveProduct(prodObj);
      modalService.success('บันทึกสินค้าเรียบร้อย', `บันทึกข้อมูลสินค้า "${prodObj.name}" สำเร็จ`);
      if (editProd) {
        if (onSaved) onSaved(saved || prodObj);
      } else {
        if (onCreated) onCreated(saved || prodObj);
      }
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('รหัสสินค้านี้ถูกใช้งานแล้วในระบบ', err.message || 'รหัสสินค้านี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น');
    } finally {
      setIsSaving(false);
    }
  };

  const activeCategory = editProd?.category || category || lockedCategory || 'PD';
  const isQC = isDepartmentMatch(activeCategory, 'QC');
  const deptBadgeClass = isQC
    ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-blue-50 text-blue-700 border-blue-200';

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
        <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
          
          {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
          <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4 sticky top-0 z-20">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
                <Package className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-slate-900 text-lg tracking-tight">
                    {editProd ? 'แก้ไขข้อมูลสินค้า Master Data' : 'เพิ่มสินค้าใหม่ใน Master Data'}
                  </h3>
                  <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${deptBadgeClass}`}>
                    {isQC ? 'ฝ่ายควบคุมคุณภาพ (QC)' : 'ฝ่ายผลิต (PD)'}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {editProd ? (
                    <>
                      <span className="font-mono text-xs font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200/80">
                        {editProd.code}
                      </span>
                      <span className="text-xs text-slate-500 truncate max-w-md">
                        {editProd.name}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">
                      กำหนดข้อมูลสเปกสินค้า หน่วยนับ ราคา และจุดสั่งซื้อ ROP
                    </span>
                  )}
                </div>
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
          <div className="flex-1 overflow-y-auto max-h-[72vh] p-6 space-y-6 min-h-0 custom-scrollbar bg-slate-50/30">
            <form id="product-form" onSubmit={handleSaveProduct} className="space-y-6">
              
              {/* ── SECTION 1: ข้อมูลพื้นฐานสินค้า ── */}
              <div className="bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xs">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-600 uppercase tracking-wider pb-2 border-b border-slate-200/60">
                  <Tag className="w-4 h-4 text-indigo-600" />
                  <span>1. ข้อมูลพื้นฐานสินค้า (Basic Product Specs)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* SKU / Item Code */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                        <span>รหัสสินค้า (SKU / Item Code)</span>
                        <span className="text-rose-500">*</span>
                      </label>
                      <div className="flex items-center gap-2">
                        {!isEditMode && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = generateNextProductCode(allProducts, currentDept);
                              setItemCode(next);
                            }}
                            className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline flex items-center gap-1 cursor-pointer transition-colors"
                            title="รันรหัสสินค้าอัตโนมัติตามแผนก"
                          >
                            <Sparkles className="w-3 h-3 text-amber-500" />
                            <span>รันรหัสอัตโนมัติ ({generateNextProductCode(allProducts, currentDept)})</span>
                          </button>
                        )}
                        {isSkuDuplicate && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1 animate-pulse">
                            <AlertTriangle className="w-3 h-3 text-rose-500" /> รหัสซ้ำ!
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="relative flex rounded-xl shadow-2xs">
                      <span className={`inline-flex items-center px-3 rounded-l-xl border border-r-0 text-xs font-mono font-bold select-none transition-colors ${
                        isSkuDuplicate ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-100 text-slate-600'
                      }`}>
                        SKU
                      </span>
                      <input
                        ref={skuInputRef}
                        name="code"
                        value={itemCode}
                        onChange={e => setItemCode(String(e.target.value ?? ''))}
                        placeholder="เช่น 1 หรือ PD-OIL-068"
                        required
                        className={`w-full h-10 px-3.5 border rounded-r-xl text-xs sm:text-sm font-mono font-bold uppercase tracking-wide placeholder:font-normal placeholder:text-slate-400 focus:outline-none transition-all ${
                          isSkuDuplicate 
                            ? 'border-rose-500 focus:border-rose-500 focus:ring-2 focus:ring-rose-200 bg-rose-50/20 text-rose-900' 
                            : 'border-slate-200 text-slate-900 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-white'
                        }`}
                      />
                    </div>
                    {isSkuDuplicate && (
                      <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1 font-medium">
                        <span>⚠️ รหัสนี้ถูกใช้งานแล้วในแผนก {currentDept}</span>
                        {duplicateItem && <span className="text-[11px] text-rose-500 font-normal">({duplicateItem.name})</span>}
                      </p>
                    )}
                  </div>

                  {/* Department */}
                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      แผนกเจ้าของสต็อก (Department) <span className="text-rose-500">*</span>
                    </label>
                    {lockedCategory ? (
                      <div className="h-10 bg-slate-50 border border-slate-200 text-slate-700 rounded-xl px-3.5 text-xs font-semibold flex items-center justify-between shadow-2xs select-none">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                          <span>
                            {(() => {
                              const d = deptList.find(item => item.code === lockedCategory || item.id === lockedCategory);
                              return d ? `${d.name} (${d.code})` : lockedCategory;
                            })()}
                          </span>
                        </div>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-indigo-50 text-indigo-700 border-indigo-200">
                          {lockedCategory}
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {selectableDepts.map(d => {
                          const isSelected = category === d.code || category === d.id;
                          return (
                            <button
                              key={d.code || d.id}
                              type="button"
                              onClick={() => setCategory(d.code || d.id)}
                              className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                                isSelected
                                  ? (d.code === 'PD' ? 'bg-blue-50 border-blue-300 text-blue-700 shadow-2xs ring-1 ring-blue-500/20' :
                                     d.code === 'QC' ? 'bg-amber-50 border-amber-300 text-amber-700 shadow-2xs ring-1 ring-amber-500/20' :
                                     'bg-indigo-50 border-indigo-300 text-indigo-700 shadow-2xs ring-1 ring-indigo-500/20')
                                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                              }`}
                            >
                              <span className={`w-2 h-2 rounded-full shrink-0 ${
                                d.code === 'PD' ? 'bg-blue-500' :
                                d.code === 'QC' ? 'bg-amber-500' :
                                d.code === 'WH' ? 'bg-emerald-500' :
                                d.code === 'PUR' ? 'bg-purple-500' :
                                d.code === 'ENG' ? 'bg-cyan-500' : 'bg-slate-400'
                              }`} />
                              <span>{d.name} ({d.code})</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Product Name */}
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                    ชื่อสินค้า / สเปกแบบละเอียด <span className="text-rose-500">*</span>
                  </label>
                  <input
                    name="name"
                    defaultValue={editProd?.name}
                    placeholder="เช่น น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)"
                    required
                    className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm font-medium text-slate-900 placeholder:text-slate-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                  />
                </div>

                {/* Preferred Supplier */}
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                    ผู้ขายหลักที่แนะนำ (Preferred Supplier)
                  </label>
                  <SearchableSelect
                    options={supplierOptions}
                    value={selectedSupplierId}
                    onChange={val => setSelectedSupplierId(val)}
                    placeholder="-- ค้นหาหรือเลือกผู้ขายหลัก (ปล่อยว่างเพื่อให้จัดซื้อเลือก) --"
                    searchPlaceholder="พิมพ์ชื่อบริษัทผู้ขาย รหัส หรือเบอร์โทร เพื่อค้นหา..."
                    emptyMessage="ไม่พบข้อมูลผู้ขาย"
                    buttonClassName="h-10 text-xs sm:text-sm font-medium"
                  />
                </div>

                {/* Storage Location Selector */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-indigo-600" />
                      <span>จุดจัดเก็บสินค้า (Storage Location)</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowCreateLocModal(true)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-2 py-0.5 rounded-lg cursor-pointer transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>เพิ่มจุดเก็บใหม่</span>
                    </button>
                  </div>
                  <SearchableSelect
                    options={locationOptions}
                    value={selectedLocationId}
                    onChange={val => setSelectedLocationId(val)}
                    placeholder="-- ค้นหาหรือเลือกจุดจัดเก็บสินค้า --"
                    searchPlaceholder="พิมพ์ชื่อจุดจัดเก็บ..."
                    emptyMessage="ไม่พบข้อมูลจุดจัดเก็บ"
                    buttonClassName="h-10 text-xs sm:text-sm font-medium"
                    onAddOption={() => setShowCreateLocModal(true)}
                    addOptionLabel="เพิ่มจุดจัดเก็บใหม่"
                    onEditOption={(opt) => {
                      const l = locsList.find(loc => loc.id === opt.value);
                      if (l) setEditLocItem(l);
                    }}
                    onDeleteOption={(opt) => {
                      const l = locsList.find(loc => loc.id === opt.value);
                      if (l) setDeleteLocItem(l);
                    }}
                  />
                </div>
              </div>

              {/* ── SECTION 2: ระบบแปลงหน่วยนับ (Unit Conversion System) ── */}
              <div className="bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200/60">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-600 uppercase tracking-wider">
                    <Repeat className="w-4 h-4 text-indigo-600" />
                    <span>2. ระบบแปลงหน่วยนับ (Unit Conversion)</span>
                  </div>
                  <span className="text-[11px] text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-semibold border border-indigo-100">
                    รองรับหน่วยซื้อ & ตัดสต็อกย่อย
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Purchase Unit (หน่วยซื้อ) */}
                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      หน่วยใหญ่ที่จัดซื้อ (Purchase Unit) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      name="purchaseUnit"
                      value={purchaseUnit}
                      onChange={e => setPurchaseUnit(e.target.value)}
                      placeholder="เช่น ถัง (200L) หรือ กล่อง"
                      required
                      className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    />
                    <div className="flex flex-wrap gap-1 mt-2">
                      {COMMON_PURCHASE_UNITS.map(u => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setPurchaseUnit(u)}
                          className={`px-2 py-0.5 text-xs rounded-lg border transition-all cursor-pointer ${
                            purchaseUnit === u
                              ? 'bg-indigo-600 text-white font-bold border-indigo-600 shadow-2xs'
                              : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/50'
                          }`}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Stock Unit (หน่วยเบิกจ่าย) */}
                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      หน่วยย่อยในสต็อก (Stock Unit) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      name="stockUnit"
                      value={stockUnit}
                      onChange={e => setStockUnit(e.target.value)}
                      placeholder="เช่น ลิตร หรือ ชิ้น"
                      required
                      className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    />
                    <div className="flex flex-wrap gap-1 mt-2">
                      {COMMON_STOCK_UNITS.map(u => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setStockUnit(u)}
                          className={`px-2 py-0.5 text-xs rounded-lg border transition-all cursor-pointer ${
                            stockUnit === u
                              ? 'bg-indigo-600 text-white font-bold border-indigo-600 shadow-2xs'
                              : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/50'
                          }`}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Conversion Multiplier & Equation Capsule */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-1">
                  <div className="sm:col-span-1">
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      อัตราแปลงหน่วย (Conversion Rate) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      name="conversionRate"
                      min="0.0001"
                      step="any"
                      value={conversionRate}
                      onChange={e => setConversionRate(e.target.value)}
                      required
                      className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-xl text-sm font-mono font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    />
                  </div>

                  {/* Formula Capsule */}
                  <div className="sm:col-span-2">
                    <div className="bg-white border border-slate-200/80 rounded-xl py-2 px-4 text-center font-mono text-xs font-bold text-indigo-900 shadow-2xs flex items-center justify-center gap-2">
                      <span className="text-slate-500 font-sans font-medium text-xs">สูตรแปลง:</span>
                      <span>1 {purchaseUnit || 'หน่วยซื้อ'} = {conversionRate || 1} {stockUnit || 'หน่วยสต็อก'}</span>
                    </div>
                  </div>
                </div>

                {/* Live Preview Callout */}
                <div className="p-3 bg-white rounded-xl border border-indigo-100 shadow-2xs flex items-center gap-2 text-xs">
                  <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
                  <div className="text-slate-600">
                    สั่งซื้อ <span className="font-mono font-bold text-slate-900">1 {purchaseUnit || 'หน่วยซื้อ'}</span> ระบบจะรับเข้าสต็อก <span className="font-mono font-bold text-emerald-700">{conversionRate || 1} {stockUnit || 'หน่วยสต็อก'}</span> อัตโนมัติ
                  </div>
                </div>
              </div>

              {/* ── SECTION 3: ราคา & จุดสั่งซื้อ (Price & ROP) ── */}
              <div className="bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200/60">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-600 uppercase tracking-wider">
                    <Boxes className="w-4 h-4 text-indigo-600" />
                    <span>3. ราคาประเมิน & การควบคุมสต็อก (Pricing & ROP Control)</span>
                  </div>
                  {editProd && (
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200 font-mono">
                      คงเหลือในคลัง: {editProd.stockBalance} {editProd.stockUnit || editProd.unit}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      ราคาประเมิน/หน่วย (฿) <span className="text-rose-500">*</span>
                    </label>
                    <div className="relative flex rounded-xl shadow-2xs">
                      <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-slate-200 bg-slate-100 text-slate-500 text-xs font-mono font-bold select-none">
                        ฿
                      </span>
                      <input
                        type="number"
                        name="price"
                        min="0"
                        step="any"
                        defaultValue={editProd?.price ?? 100}
                        required
                        className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-r-xl text-xs sm:text-sm font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      ระยะเวลาส่งมอบ (Lead Time วัน)
                    </label>
                    <input
                      type="number"
                      name="leadTimeDays"
                      min="1"
                      defaultValue={editProd?.leadTimeDays ?? 7}
                      required
                      className="w-full h-10 px-3.5 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                      จุดสั่งซื้อ ROP (Reorder Point) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      name="reorderPoint"
                      min="0"
                      step="any"
                      defaultValue={editProd?.reorderPoint ?? 10}
                      required
                      className="w-full h-10 px-3.5 bg-amber-50/60 border border-amber-200 rounded-xl text-xs sm:text-sm font-mono font-bold text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all shadow-2xs"
                    />
                  </div>
                </div>

                {/* Initial Stock (Only on creation) */}
                {!editProd && (
                  <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                        จำนวนสต็อกเริ่มต้น (Opening Stock Balance)
                      </span>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        ระบุจำนวนคงเหลือในคลังจริงเริ่มต้น (หน่วย: {stockUnit || 'หน่วยสต็อก'})
                      </p>
                    </div>
                    <div className="w-full sm:w-36">
                      <input
                        type="number"
                        name="stockBalance"
                        min="0"
                        step="any"
                        defaultValue={0}
                        required
                        className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-mono font-bold text-center text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs"
                      />
                    </div>
                  </div>
                )}
              </div>

            </form>
          </div>

          {/* ── 3. Sticky Action Footer (Non-scrollable) ── */}
          <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-200/80 flex items-center justify-between sticky bottom-0 z-20">
            <span className="text-xs text-slate-400 font-medium">
              <span className="text-rose-500 font-bold">*</span> จำเป็นต้องระบุข้อมูล
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/60 rounded-xl transition-colors cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                form="product-form"
                disabled={isSaving || isSkuDuplicate || !String(itemCode || '').trim()}
                className="px-5 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 shadow-xs rounded-xl flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
                <span>{isSaving ? 'กำลังบันทึก...' : (isEditMode ? 'บันทึกการแก้ไข' : 'บันทึกสินค้าใหม่')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {showCreateLocModal && (
        <StorageLocationCRUDModal
          departments={deptList}
          storageLocations={locsList}
          currentRole={currentRole}
          onClose={() => setShowCreateLocModal(false)}
          onCreated={(newLoc) => {
            setLocsList(prev => [newLoc, ...prev.filter(l => l.id !== newLoc.id)]);
            setSelectedLocationId(newLoc.id);
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {editLocItem && (
        <StorageLocationCRUDModal
          departments={deptList}
          location={editLocItem}
          storageLocations={locsList}
          currentRole={currentRole}
          onClose={() => setEditLocItem(null)}
          onSaved={(updatedLoc) => {
            setLocsList(prev => prev.map(l => l.id === updatedLoc.id ? updatedLoc : l));
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {deleteLocItem && (
        <DeleteLocationModal
          location={deleteLocItem}
          products={allProducts}
          storageLocations={locsList}
          currentRole={currentRole}
          onClose={() => setDeleteLocItem(null)}
          onDeleted={(deletedId) => {
            setLocsList(prev => prev.filter(l => l.id !== deletedId));
            if (selectedLocationId === deletedId) {
              setSelectedLocationId('');
            }
            if (onRefresh) onRefresh();
          }}
        />
      )}
    </>,
    document.body
  );
}

export { generateNextProductCode };
