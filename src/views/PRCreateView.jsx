
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { apiService } from '../services/apiService';
import { storageService } from '../services/storageService';
import { useAppContext } from '../context/AppContext';
import { 
  ArrowLeft, AlertTriangle, Plus, Trash2, Building2, 
  Sparkles, CheckCircle2, ShoppingCart, 
  Building, Receipt, Loader2, Wallet, Link as LinkIcon, FileText
} from 'lucide-react';
import { MEMO_THRESHOLD, DEPARTMENTS } from '../config/constants';
import FileUploader from '../components/common/FileUploader';
import SearchableSelect from '../components/common/SearchableSelect';
import { modalService } from '../services/modalService';
import { budgetService } from '../services/budgetService';
import { sanitizeExternalUrl, getProductUrl } from '../utils/urlHelper';
import { getNextPRNumber } from '../utils/idGenerator';
import { safeStringCompare } from '../utils/formatters';
import { resolveDriveImageUrl, handleDriveImageError, getDriveFileViewUrl } from '../utils/driveHelper';
import { compressImage, compressImageFile, getBase64SizeBytes, MAX_IMAGE_SIZE_BYTES } from '../utils/fileUtils';
import { isDepartmentMatch } from '../utils/permissions';

/**
 * Deduplicate Master Data & Inventory list for product dropdowns/comboboxes
 * Prevents 1:1 duplication and merges inventory stock/ROP without creating duplicate items.
 */
export const getUnifiedProductList = (products = [], inventory = []) => {
  const productMap = new Map();

  // 1. นำ Master Data สินค้าตั้งต้นใส่ Map โดยใช้ item.id เป็น Unique Key หลักเสมอ
  (Array.isArray(products) ? products : []).forEach(p => {
    if (!p) return;
    const raw = p.product || p.item || p;

    // ข้ามสินค้าที่ปิดใช้งาน หรืออยู่ใน Blacklist ขยะ
    const isInactive = raw.isActive === false || String(raw.isActive).toUpperCase() === 'FALSE' || String(raw.status || '').toUpperCase() === 'INACTIVE';
    if (isInactive) return;

    // Safe fallback for Department (checks department, category, dept, or PROD-[DEPT]- prefix in id)
    const rawDept = String(raw.department || raw.category || raw.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
    const idMatch = String(raw.id || '').match(/^PROD-([A-Za-z]+)-/i);
    const dept = rawDept || (idMatch ? idMatch[1].toUpperCase() : 'PD');
    const rawId = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : '';
    const rawCode = raw.code !== undefined && raw.code !== null ? String(raw.code).trim() : '';

    // Composite key scoped by department ensures PD 1 and QC 1 never collide,
    // while duplicate codes within the same department are cleanly unified for dropdowns.
    const key = rawCode ? `${dept}_${rawCode.toUpperCase()}` : (rawId ? rawId.toUpperCase() : '');
    if (!key) return;

    const upperCode = rawCode.toUpperCase();
    const upperId = rawId.toUpperCase();
    if (['P01', 'P02', 'PROD-01', 'PROD-02'].includes(upperCode) || ['P01', 'P02', 'PROD-01', 'PROD-02'].includes(upperId) || ['P01', 'P02', 'PROD-01', 'PROD-02'].includes(key)) return;

    const itemObj = { ...raw };
    if (itemObj.id !== undefined && itemObj.id !== null) itemObj.id = String(itemObj.id).trim();
    if (itemObj.code !== undefined && itemObj.code !== null) itemObj.code = String(itemObj.code).trim();
    if (itemObj.name !== undefined && itemObj.name !== null) itemObj.name = String(itemObj.name).trim();
    if (dept && !itemObj.department) itemObj.department = dept;
    if (dept && !itemObj.category) itemObj.category = dept;

    if (!productMap.has(key)) {
      productMap.set(key, itemObj);
    }
  });

  // 2. ดึงข้อมูลสต็อกคงเหลือและ ROP จาก Inventory มาประกบ (Enrich Data) โดยไม่สร้างรายการใหม่
  (Array.isArray(inventory) ? inventory : []).forEach(inv => {
    if (!inv) return;
    const invDept = String(inv.department || inv.category || inv.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
    const invId = (inv.productId || inv.id) ? String(inv.productId || inv.id).trim().toUpperCase() : '';
    const invCode = inv.code ? String(inv.code).trim().toUpperCase() : '';

    // Match by ID first, then by dept_code
    let matchKey = null;
    if (invId && productMap.has(invId)) {
      matchKey = invId;
    } else if (invCode) {
      const composite = `${invDept}_${invCode}`;
      if (productMap.has(composite)) {
        matchKey = composite;
      }
    }

    if (matchKey && productMap.has(matchKey)) {
      const existing = productMap.get(matchKey);
      productMap.set(matchKey, {
        ...existing,
        stock: inv.stock ?? inv.remainingQty ?? inv.quantity ?? existing.stock ?? 0,
        rop: inv.rop ?? inv.minStock ?? inv.reorderPoint ?? existing.rop ?? 0,
        unit: existing.unit || inv.unit || 'ชิ้น',
        department: existing.department || inv.department || 'ส่วนกลาง'
      });
    }
  });

  return Array.from(productMap.values());
};

export default function PRCreateView({ 
  products = [], 
  inventory = [],
  departments = [],
  vendors = [],
  currentRole, 
  onNavigate, 
  onRefresh, 
  preselectedProduct, 
  clearPreselectedProduct,
  editingPR,
  clearEditingPR,
  createPR,
  handleSavePR,
  updatePR,
  initialPRNo
}) {
  // Submission Guard to prevent duplicate submissions
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successModalInfo, setSuccessModalInfo] = useState({ title: '', message: '' });

  const handleCloseSuccessModal = () => {
    setShowSuccessModal(false);
    // สลับหน้าไปยังหน้ารายการทันที ห้ามมี await ขวาง
    if (typeof onNavigate === 'function') {
      onNavigate('pr-list');
    } else if (typeof context?.setCurrentView === 'function') {
      context.setCurrentView('pr-list');
    } else if (typeof context?.onNavigate === 'function') {
      context.onNavigate('pr-list');
    }
  };

  const memoSectionRef = useRef(null);
  const memoSubjectInputRef = useRef(null);
  const context = useAppContext() || {};

  // Existing PRs from Context or LocalStorage (Dynamic Max-ID Scanner)
  const existingPRs = useMemo(() => {
    if (Array.isArray(context?.prs) && context.prs.length > 0) return context.prs;
    return storageService.getPRs?.() || [];
  }, [context?.prs]);

  // Dynamic Departments from context / master data
  const deptList = useMemo(() => {
    return (departments && departments.length > 0) ? departments : (DEPARTMENTS ? Object.values(DEPARTMENTS) : []);
  }, [departments]);

  const activeDepartments = useMemo(() => {
    return deptList.filter(d => d.isActive !== false);
  }, [deptList]);

  const deptMap = useMemo(() => {
    return deptList.reduce((acc, d) => {
      acc[d.code] = d;
      return acc;
    }, {});
  }, [deptList]);

  // Determine effective department (locked for dept-specific users, selectable for ALL)
  const defaultCode = activeDepartments[0]?.code || 'PD';
  const preselectedDept = Array.isArray(preselectedProduct) 
    ? (preselectedProduct[0]?.category || preselectedProduct[0]?.department) 
    : (preselectedProduct?.category || preselectedProduct?.department);
  const initialDept = editingPR 
    ? editingPR.department 
    : (currentRole?.department === 'ALL' 
        ? (preselectedDept || defaultCode) 
        : (currentRole?.department || defaultCode));

  const [department, setDepartment] = useState(initialDept);

  // Default usage location based on department (PD/QC -> FACTORY, OFFICE -> OFFICE)
  const getDefaultUsageLocation = useCallback((dept) => {
    return dept === 'OFFICE' ? 'OFFICE' : 'FACTORY';
  }, []);

  // Initial PR Number state calculated from real documents (Directive 2: No hardcoding, no useState(1))
  const [nextPRNumber, setNextPRNumber] = useState(() => {
    if (editingPR?.prNo) return editingPR.prNo;
    if (initialPRNo) return initialPRNo;
    const prs = (Array.isArray(context?.prs) && context.prs.length > 0) ? context.prs : (storageService.getPRs?.() || []);
    return getNextPRNumber(prs, initialDept);
  });

  // Keep nextPRNumber in sync when department changes or existingPRs update
  useEffect(() => {
    if (!editingPR) {
      setNextPRNumber(getNextPRNumber(existingPRs, department));
    }
  }, [department, existingPRs, editingPR]);

  // Master Vendors integration (Directive 1)
  const allMasterVendors = useMemo(() => {
    if (Array.isArray(vendors) && vendors.length > 0) return vendors;
    if (Array.isArray(context?.vendors) && context.vendors.length > 0) return context.vendors;
    return storageService.getVendors?.() || [];
  }, [vendors, context?.vendors]);

  const masterVendors = useMemo(() => {
    if (!department) return allMasterVendors;
    const currentDept = String(department).toUpperCase();
    return allMasterVendors.filter(v => {
      const vDept = String(v.department || v.scope || 'ALL').toUpperCase();
      return currentDept === 'ALL' || vDept === 'ALL' || vDept === currentDept || currentDept.includes(vDept) || vDept.includes(currentDept);
    });
  }, [allMasterVendors, department]);

  const vendorOptions = useMemo(() => {
    return masterVendors.map(v => ({
      value: v.id,
      label: v.name,
      code: v.code,
      subLabel: `${v.code} • โทร: ${v.phone || '-'} • เลขผู้เสียภาษี: ${v.taxId || '-'}`,
      keywords: `${v.code} ${v.name} ${v.taxId || ''} ${v.phone || ''} ${v.contactPerson || ''}`
    }));
  }, [masterVendors]);

  // Helper to find default vendor from product preferredSupplier / supplierId
  const getDefaultVendorId = useCallback((prod) => {
    if (!prod) return masterVendors[0]?.id || '';
    const match = masterVendors.find(v => 
      v.id === prod.supplierId || 
      v.id === prod.preferredSupplier ||
      v.code === prod.supplierId || 
      v.code === prod.preferredSupplier ||
      v.name === prod.preferredSupplier
    );
    return match?.id || prod.supplierId || prod.preferredSupplier || masterVendors[0]?.id || '';
  }, [masterVendors]);



  const [purchaseChannel, setPurchaseChannel] = useState(editingPR?.purchaseChannel || 'SELF');
  
  // 1 PR = 1 Vendor at Form Header for Internal Purchase (Directive 1)
  const [selectedVendorId, setSelectedVendorId] = useState(() => {
    if (editingPR?.vendorId) return editingPR.vendorId;
    if (editingPR?.vendor?.id) return editingPR.vendor.id;
    if (editingPR?.supplierId) return editingPR.supplierId;
    if (editingPR?.items?.[0]?.vendorId) return editingPR.items[0].vendorId;
    const primaryPreselected = Array.isArray(preselectedProduct) ? preselectedProduct[0] : preselectedProduct;
    if (primaryPreselected) return getDefaultVendorId(primaryPreselected);
    return masterVendors[0]?.id || '';
  });

  // Ensure default vendor selection when masterVendors load or department changes
  useEffect(() => {
    if (!editingPR) {
      const isValidVendor = masterVendors.some(v => v.id === selectedVendorId);
      if (!selectedVendorId || (!isValidVendor && masterVendors.length > 0)) {
        const primaryPreselected = Array.isArray(preselectedProduct) ? preselectedProduct[0] : preselectedProduct;
        setSelectedVendorId(primaryPreselected ? getDefaultVendorId(primaryPreselected) : (masterVendors[0]?.id || ''));
      }
    }
  }, [masterVendors, selectedVendorId, editingPR, preselectedProduct, getDefaultVendorId]);

  const selectedVendor = useMemo(() => {
    return masterVendors.find(v => v.id === selectedVendorId) || null;
  }, [masterVendors, selectedVendorId]);

  // File attachments
  const [quotationFiles, setQuotationFiles] = useState(() => {
    return (editingPR?.attachments || []).filter(a => a.category === 'QUOTATION');
  });
  const [imageFiles, setImageFiles] = useState(() => {
    return (editingPR?.attachments || []).filter(a => a.category === 'IMAGE' || a.category === 'GENERAL' || a.type?.startsWith('image/'));
  });
  const [previewImage, setPreviewImage] = useState(null);
  
  const [note, setNote] = useState(editingPR?.note || '');

  // Financial State for Order Adjustments
  const [combinedDiscountType, setCombinedDiscountType] = useState(editingPR?.financials?.combinedDiscountType || 'percent'); // 'percent' | 'fixed'
  const [combinedDiscountValue, setCombinedDiscountValue] = useState(editingPR?.financials?.combinedDiscountValue ?? 0);
  const [roundingAdj, setRoundingAdj] = useState(editingPR?.financials?.roundingAdj ?? 0);
  const [shippingCost, setShippingCost] = useState(editingPR?.financials?.shippingCost ?? 0);

  // VAT Toggle State: true = 7%, false = 0% (Directive 1)
  const [hasVat, setHasVat] = useState(() => {
    if (editingPR?.financials?.hasVat !== undefined) return Boolean(editingPR.financials.hasVat);
    if (editingPR?.financials?.vatMode === 'NONE') return false;
    return true;
  });

  // Toggle state for extra costs & adjustments (Directive 2: Hide shipping & rounding inputs by default)
  const [showExtraAdjustments, setShowExtraAdjustments] = useState(() => {
    return Boolean(
      (parseFloat(editingPR?.financials?.shippingCost) || 0) > 0 ||
      (parseFloat(editingPR?.financials?.roundingAdj) || 0) !== 0 ||
      (parseFloat(editingPR?.financials?.combinedDiscountValue) || 0) > 0
    );
  });

  // Find return/reject reason if this PR was returned
  const returnReason = useMemo(() => {
    if (!editingPR || !editingPR.activityLog) return null;
    const lastReject = [...editingPR.activityLog].reverse().find(l => 
      l.action?.includes('ส่งกลับ') || l.action?.includes('Reject') || l.action?.includes('ปฏิเสธ')
    );
    return lastReject?.note || null;
  }, [editingPR]);

  // Filter products by the active department (Exclude Deactivated/Inactive products)
  const availableProducts = useMemo(() => {
    const rawList = getUnifiedProductList(products, inventory);
    
    // กรองตามแผนกของผู้ขอซื้อ (ถ้ามีการล็อกแผนก เช่น แผนก PD)
    const userDepartment = department || currentRole?.department;
    if (!userDepartment || userDepartment === 'ALL') return rawList;
    return rawList.filter(p => {
      const pDept = (p.department || p.category || '').toUpperCase();
      return !pDept || pDept === 'ALL' || pDept === userDepartment.toUpperCase();
    }).sort((a, b) => safeStringCompare(a?.code, b?.code));
  }, [products, inventory, department, currentRole?.department]);

  // Transform available products into searchable options
  const productOptions = useMemo(() => {
    return availableProducts.map((p, index) => {
      const pUnit = p.purchaseUnit || p.unit || 'ชิ้น';
      const sUnit = p.stockUnit || p.unit || 'ชิ้น';
      const pCat = p.category || p.department || 'PD';
      return {
        id: p.id,
        code: p.code,
        key: `${p.code || p.id || 'PROD'}-${index}`,
        value: p.id,
        label: p.name,
        subLabel: `฿${Number(p.price || 0).toLocaleString()} / ${pUnit} • คงเหลือ: ${Number(p.stockBalance ?? p.stock ?? 0).toLocaleString()} ${sUnit} • ROP: ${Number(p.reorderPoint ?? p.rop ?? 0).toLocaleString()} ${sUnit}`,
        badge: deptMap[pCat]?.name || pCat,
        keywords: `${p.code} ${p.name} ${pUnit} ${sUnit} ${pCat}`
      };
    });
  }, [availableProducts, deptMap]);

  // Initial PR Items state
  const [prItems, setPrItems] = useState(() => {
    if (editingPR && editingPR.items && editingPR.items.length > 0) {
      return editingPR.items.map(it => {
        const location = it.usageLocation || (it.source === 'OFFICE' ? 'OFFICE' : getDefaultUsageLocation(initialDept));
        return {
          productId: it.productId || it.code,
          qty: Number(it.purchaseQty ?? it.qty) || 1,
          price: parseFloat(it.price) || 0,
          discountPercent: parseFloat(it.discountPercent) || 0,
          discountAmount: parseFloat(it.discountAmount) || 0,
          vendorId: it.vendorId || it.supplierId || '',
          platform: it.platform || it.storePlatform || 'Shopee',
          storePlatform: it.storePlatform || it.platform || 'Shopee',
          storeName: it.storeName || it.actualStoreName || '',
          actualStoreName: it.actualStoreName || it.storeName || '',
          onlineUrl: getProductUrl(it) || '',
          productUrl: getProductUrl(it) || '',
          usageLocation: location,
          source: location,
          isCustom: Boolean(it.isCustom),
          customName: it.name,
          customCode: it.code,
          customUnit: it.purchaseUnit || it.unit || 'ชิ้น',
          overrideUnit: Boolean(it.isUnitOverridden),
          customPurchaseUnit: it.purchaseUnit,
          customStockUnit: it.stockUnit,
          images: it.images || it.attachments || [],
          attachments: it.attachments || it.images || []
        };
      });
    }
    const defaultLocation = getDefaultUsageLocation(initialDept);
    if (preselectedProduct) {
      const prods = Array.isArray(preselectedProduct) ? preselectedProduct : [preselectedProduct];
      const validProds = prods.filter(p => {
        const itemDept = p.category || p.department;
        return !itemDept || itemDept === initialDept;
      });
      const targetProds = validProds.length > 0 ? validProds : prods;
      if (targetProds.length > 0) {
        return targetProds.map(prod => ({
          productId: prod.id || '',
          qty: Math.max(1, (prod.reorderPoint || prod.rop || 5) * 2),
          price: parseFloat(prod.price) || 0,
          discountPercent: 0,
          discountAmount: 0,
          vendorId: getDefaultVendorId(prod),
          platform: 'Shopee',
          storeName: '',
          onlineUrl: '',
          productUrl: '',
          usageLocation: defaultLocation,
          source: defaultLocation,
          images: []
        }));
      }
    }
    const unifiedInitial = getUnifiedProductList(products, inventory);
    const initialList = unifiedInitial.filter(p => {
      const isInactive = p.isActive === false || String(p.isActive).toUpperCase() === 'FALSE' || String(p.status || '').toUpperCase() === 'INACTIVE';
      return !isInactive && isDepartmentMatch(p.category || p.department, initialDept);
    });
    return [{ 
      productId: initialList[0]?.id || '', 
      qty: 1, 
      price: parseFloat(initialList[0]?.price) || 0,
      discountPercent: 0,
      discountAmount: 0,
      vendorId: getDefaultVendorId(initialList[0]),
      platform: 'Shopee',
      storeName: '',
      onlineUrl: '',
      productUrl: '',
      usageLocation: defaultLocation,
      source: defaultLocation,
      images: []
    }];
  });

  // When department changes, sync prItems so all items belong to new department (only for non-editing mode)
  useEffect(() => {
    if (!editingPR && availableProducts.length > 0) {
      setPrItems(prevItems => {
        const needsReset = prevItems.some(item => !item.isCustom && !availableProducts.some(p => p.id === item.productId));
        if (needsReset) {
          const defaultLocation = getDefaultUsageLocation(department);
          return [{
            productId: availableProducts[0].id,
            qty: 1,
            price: parseFloat(availableProducts[0].price) || 0,
            discountPercent: 0,
            discountAmount: 0,
            vendorId: getDefaultVendorId(availableProducts[0]),
            platform: 'Shopee',
            storeName: '',
            onlineUrl: '',
            productUrl: '',
            usageLocation: defaultLocation,
            source: defaultLocation,
            images: []
          }];
        }
        return prevItems;
      });
    }
  }, [department, availableProducts, editingPR, getDefaultVendorId, getDefaultUsageLocation]);

  // Memo Fields
  const [memoData, setMemoData] = useState(() => {
    if (editingPR?.memo) {
      return {
        subject: editingPR.memo.subject || '',
        purpose: editingPR.memo.purpose || '',
        background: editingPR.memo.background || '',
        paymentTerm: editingPR.memo.paymentTerm || 'เครดิต 30 วัน',
        classification: editingPR.memo.classification || 'EXPENSE',
        remarkAttachedFile: editingPR.memo.remarkAttachedFile || ''
      };
    }
    return {
      subject: '',
      purpose: '',
      background: '',
      paymentTerm: 'เครดิต 30 วัน',
      classification: 'EXPENSE',
      remarkAttachedFile: ''
    };
  });

  // ── Financial Calculations (Smart Standard VAT: (Subtotal - Discount) * 0.07) ──
  const isOnline = purchaseChannel === 'ONLINE';

  const isMissingVendor = useMemo(() => {
    if (purchaseChannel !== 'SELF') return false;
    return !selectedVendorId;
  }, [purchaseChannel, selectedVendorId]);

  const subtotal = useMemo(() => {
    return prItems.reduce((sum, item) => sum + ((parseFloat(item.qty) || 0) * (parseFloat(item.price) || 0)), 0);
  }, [prItems]);

  const itemDiscountTotal = useMemo(() => {
    return prItems.reduce((sum, item) => sum + (parseFloat(item.discountAmount) || 0), 0);
  }, [prItems]);

  const netAfterItemDiscount = useMemo(() => {
    return Math.max(0, subtotal - itemDiscountTotal);
  }, [subtotal, itemDiscountTotal]);

  const combinedDiscountAmount = useMemo(() => {
    const val = parseFloat(combinedDiscountValue) || 0;
    if (combinedDiscountType === 'percent') {
      return parseFloat((netAfterItemDiscount * (val / 100)).toFixed(2));
    }
    return val;
  }, [netAfterItemDiscount, combinedDiscountType, combinedDiscountValue]);

  const totalDiscount = useMemo(() => {
    return itemDiscountTotal + combinedDiscountAmount;
  }, [itemDiscountTotal, combinedDiscountAmount]);

  const netAfterAllDiscount = useMemo(() => {
    return Math.max(0, subtotal - totalDiscount);
  }, [subtotal, totalDiscount]);

  // Standard Automatic 7% VAT or 0% based on hasVat (Directive 1)
  const vatAmount = useMemo(() => {
    if (purchaseChannel !== 'SELF' || !hasVat) return 0;
    return parseFloat((netAfterAllDiscount * 0.07).toFixed(2));
  }, [purchaseChannel, hasVat, netAfterAllDiscount]);

  const grandTotal = useMemo(() => {
    if (purchaseChannel !== 'SELF') {
      return subtotal;
    }
    const safeRounding = parseFloat(roundingAdj) || 0;
    const safeShipping = parseFloat(shippingCost) || 0;
    return parseFloat((netAfterAllDiscount + vatAmount + safeRounding + safeShipping).toFixed(2));
  }, [purchaseChannel, subtotal, netAfterAllDiscount, vatAmount, roundingAdj, shippingCost]);

  // Dynamic Memo Requirement Directive 3: const requiresMemo = grandTotal >= 20000;
  const requiresMemo = grandTotal >= (MEMO_THRESHOLD || 20000);

  // Department Budget Usage Bar (Directive 1)
  const budgetInfo = useMemo(() => {
    try {
      const summary = apiService.calculateBudgetSummary();
      const deptData = summary?.current?.[department];
      if (!deptData) return null;
      const allocated = Number(deptData.baseAllocated ?? deptData.allocated) || 0;
      const actualSpent = Number(deptData.actualSpent ?? 0);
      const committed = Number(deptData.committed ?? 0);
      const spent = actualSpent + committed;
      const prAmount = grandTotal || 0;
      const projectedSpent = spent + prAmount;
      const currentPercent = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
      const projectedPercent = allocated > 0 ? Math.min(100, Math.round((projectedSpent / allocated) * 100)) : 0;
      const remaining = allocated - projectedSpent;
      const isOverBudget = projectedSpent > allocated;
      return {
        allocated,
        spent,
        prAmount,
        projectedSpent,
        currentPercent,
        projectedPercent,
        remaining,
        isOverBudget
      };
    } catch {
      return null;
    }
  }, [department, grandTotal]);

  const handleAddItemRow = () => {
    const defaultProd = availableProducts[0];
    const defaultLocation = getDefaultUsageLocation(department);
    const newId = `PRITEM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    setPrItems(prev => [
      ...prev, 
      { 
        id: newId,
        productId: defaultProd?.id || '', 
        qty: 1, 
        price: parseFloat(defaultProd?.price) || 0, 
        discountPercent: 0, 
        discountAmount: 0, 
        vendorId: getDefaultVendorId(defaultProd),
        platform: 'Shopee',
        storeName: '',
        onlineUrl: '',
        productUrl: '',
        usageLocation: defaultLocation,
        source: defaultLocation,
        isCustom: false,
        images: []
      }
    ]);
  };

  const handleRemoveItemRow = (index) => {
    if (prItems.length <= 1) return;
    setPrItems(prItems.filter((_, i) => i !== index));
  };

  const handleToggleCustomItem = (index) => {
    const updated = [...prItems];
    const current = updated[index];
    const isNowCustom = !current.isCustom;
    const defaultLocation = current.usageLocation || current.source || getDefaultUsageLocation(department);
    
    if (isNowCustom) {
      const tempId = `TEMP-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      updated[index] = {
        ...current,
        isCustom: true,
        customCode: tempId,
        customName: '',
        customUnit: 'ชิ้น',
        productId: tempId,
        price: parseFloat(current.price) || 0,
        qty: parseFloat(current.qty) || 1,
        discountPercent: 0,
        discountAmount: 0,
        vendorId: current.vendorId || masterVendors[0]?.id || '',
        platform: current.platform || 'Shopee',
        storeName: current.storeName || '',
        onlineUrl: current.onlineUrl || '',
        productUrl: current.productUrl || current.onlineUrl || '',
        usageLocation: defaultLocation,
        source: defaultLocation
      };
    } else {
      const defaultProd = availableProducts[0];
      updated[index] = {
        ...current,
        isCustom: false,
        customCode: '',
        customName: '',
        customUnit: '',
        productId: defaultProd?.id || '',
        price: parseFloat(defaultProd?.price) || 0,
        qty: parseFloat(current.qty) || 1,
        discountPercent: 0,
        discountAmount: 0,
        vendorId: current.vendorId || getDefaultVendorId(defaultProd),
        platform: current.platform || 'Shopee',
        storeName: current.storeName || '',
        onlineUrl: current.onlineUrl || '',
        productUrl: current.productUrl || current.onlineUrl || '',
        usageLocation: defaultLocation,
        source: defaultLocation
      };
    }
    setPrItems(updated);
  };

  // Smart Item Link URL handler with auto-detect platform logic (Directive 2)
  const handleUrlChange = (index, value) => {
    const updated = [...prItems];
    const url = value || '';
    updated[index].onlineUrl = url;
    updated[index].productUrl = url;

    // Auto-detect platform logic: 'shopee' -> 'Shopee', 'lazada' -> 'Lazada'
    const lower = url.toLowerCase();
    if (lower.includes('shopee')) {
      updated[index].platform = 'Shopee';
    } else if (lower.includes('lazada')) {
      updated[index].platform = 'Lazada';
    }
    setPrItems(updated);
  };

  const handleItemChange = (index, field, value) => {
    const updated = [...prItems];
    updated[index][field] = value;

    // Keep usageLocation and source synchronized
    if (field === 'usageLocation') {
      updated[index].usageLocation = value;
      updated[index].source = value;
    } else if (field === 'source') {
      updated[index].source = value;
      updated[index].usageLocation = value;
    }

    // Keep productUrl and onlineUrl synchronized with platform auto-detection
    if (field === 'onlineUrl' || field === 'productUrl') {
      updated[index].onlineUrl = value;
      updated[index].productUrl = value;
      const lower = (value || '').toLowerCase();
      if (lower.includes('shopee')) {
        updated[index].platform = 'Shopee';
      } else if (lower.includes('lazada')) {
        updated[index].platform = 'Lazada';
      }
    }
    
    // Auto-update price and preferred vendor when product changes
    if (field === 'productId') {
      const prod = availableProducts.find(p => p.id === value);
      if (prod) {
        updated[index].price = parseFloat(prod.price) || 0;
        if (purchaseChannel === 'SELF' && !selectedVendorId) {
          setSelectedVendorId(getDefaultVendorId(prod));
        }
      }
    }

    // Sync discounts
    if (field === 'discountPercent') {
      const p = parseFloat(value) || 0;
      const itemQty = parseFloat(updated[index].qty) || 1;
      const itemPrice = parseFloat(updated[index].price) || 0;
      updated[index].discountAmount = p > 0 ? parseFloat(((itemQty * itemPrice) * (p / 100)).toFixed(2)) : 0;
    } else if (field === 'discountAmount') {
      const amt = parseFloat(value) || 0;
      const itemQty = parseFloat(updated[index].qty) || 1;
      const itemPrice = parseFloat(updated[index].price) || 0;
      const rowBase = itemQty * itemPrice;
      updated[index].discountPercent = (rowBase > 0 && amt > 0) ? parseFloat(((amt / rowBase) * 100).toFixed(2)) : 0;
    } else if (field === 'price' || field === 'qty') {
      const p = parseFloat(updated[index].discountPercent) || 0;
      const itemQty = parseFloat(field === 'qty' ? value : updated[index].qty) || 0;
      const itemPrice = parseFloat(field === 'price' ? value : updated[index].price) || 0;
      if (p > 0) {
        updated[index].discountAmount = parseFloat(((itemQty * itemPrice) * (p / 100)).toFixed(2));
      }
    }
    
    setPrItems(updated);
  };

  // Quantity Stepper Handlers (Directive 4: [ - ] [ 1 ] [ + ])
  const handleDecrementQty = (index) => {
    const currentQty = parseFloat(prItems[index].qty) || 1;
    const nextQty = Math.max(1, currentQty - 1);
    handleItemChange(index, 'qty', nextQty);
  };

  const handleIncrementQty = (index) => {
    const currentQty = parseFloat(prItems[index].qty) || 0;
    handleItemChange(index, 'qty', currentQty + 1);
  };

  // Item-Level Multi-Image Upload & Drag-and-Drop (Gen-Z Media Strip)
  const fileInputRefs = useRef({});

  const triggerUpload = (itemId) => {
    if (fileInputRefs.current[itemId]) {
      fileInputRefs.current[itemId].click();
    }
  };

  const processItemImageFiles = async (index, files) => {
    const validFiles = Array.from(files || []).filter(file => file.type?.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)$/i.test(file.name));
    if (!validFiles.length) return;

    try {
      const filePromises = validFiles.map(async (file) => {
        try {
          // Automatic Client-Side Image Compression: Max 1280px, quality 0.7-0.75, < 150 KB
          const comp = await compressImageFile(file, {
            maxWidth: 1280,
            maxHeight: 1280,
            quality: 0.75,
            maxSizeBytes: MAX_IMAGE_SIZE_BYTES
          });
          return {
            name: file.name,
            size: comp.size,
            type: comp.type || 'image/jpeg',
            previewUrl: comp.previewUrl,
            url: comp.url
          };
        } catch (compErr) {
          console.warn('[PRCreateView] Image compression fallback to FileReader:', compErr);
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
              resolve({
                name: file.name,
                size: file.size,
                type: file.type || 'image/jpeg',
                previewUrl: e.target.result,
                url: e.target.result
              });
            };
            reader.readAsDataURL(file);
          });
        }
      });

      const newImages = await Promise.all(filePromises);
      setPrItems(prev => {
        const updated = [...prev];
        const current = updated[index];
        const existingImages = current?.images || current?.attachments || [];
        updated[index] = {
          ...current,
          images: [...existingImages, ...newImages],
          attachments: [...existingImages, ...newImages]
        };
        return updated;
      });
    } catch (err) {
      console.error('[PRCreateView] Error processing item images:', err);
    }
  };

  const handleItemImageUpload = (index, event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      processItemImageFiles(index, files);
    }
    event.target.value = '';
  };

  const handleItemImageDrop = (index, event) => {
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      processItemImageFiles(index, files);
    }
  };

  const handleRemoveItemImage = (itemIdx, imgIdx) => {
    setPrItems(prev => {
      const updated = [...prev];
      const current = updated[itemIdx];
      const existingImages = current?.images || current?.attachments || [];
      const filtered = existingImages.filter((_, i) => i !== imgIdx);
      updated[itemIdx] = {
        ...current,
        images: filtered,
        attachments: filtered
      };
      return updated;
    });
  };

  const handlePreviewImage = (img) => {
    setPreviewImage(typeof img === 'string' ? { url: img, previewUrl: img } : img);
  };

  const handleCreateSubmit = async (e, isDraft) => {
    if (e && e.preventDefault) e.preventDefault();
    if (isSubmitting) return;

    // Auto-detect Guard: Force ONLINE if any item has a shop link
    const hasAnyLink = prItems.some(item => !!(item.productUrl || item.onlineUrl || '').trim());
    const currentChannel = hasAnyLink ? 'ONLINE' : purchaseChannel;
    const isOnline = currentChannel === 'ONLINE';

    // Validations
    if (!isDraft) {
      // PR Guardrail: Check if department has allocated budget for the current month
      const today = new Date();
      const currentPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const periodSummary = budgetService.calculatePeriodBudgetSummary(currentPeriod);
      const targetDeptBudget = periodSummary?.current?.[department];

      if (targetDeptBudget && targetDeptBudget.isAllocated === false) {
        return modalService.warning(
          'ไม่สามารถส่งขอซื้อได้',
          'ไม่สามารถส่งขอซื้อได้ เนื่องจากแผนกยังไม่ได้รับการจัดสรรงบประมาณประจำเดือน'
        );
      }

      if (prItems.some(item => {
        if (item.isCustom) {
          return !item.customName?.trim() || Number(item.qty) <= 0;
        }
        return !item.productId || Number(item.qty) <= 0;
      })) {
        return modalService.warning('กรุณาระบุข้อมูลรายการสินค้าและจำนวนที่ถูกต้อง');
      }

      if (currentChannel === 'SELF' && !selectedVendorId) {
        return modalService.warning('กรุณาระบุผู้จัดจำหน่าย (Vendor) ที่หัวเอกสารสำหรับการขอซื้อภายใน');
      }

      if (isOnline) {
        if (!requiresMemo) {
          const hasLink = prItems.some(item => !!(item.productUrl || item.onlineUrl || '').trim());
          if (!hasLink) {
            return modalService.warning('กรุณาระบุลิงก์สินค้า (Shopee/Lazada/เว็บไซต์) สำหรับการสั่งซื้อออนไลน์อย่างน้อย 1 รายการ');
          }
        }

        // Directive 1: Mandatory Image Enforcement for Online Procurement
        const missingImageIndex = prItems.findIndex(item => {
          const imgs = item.images || item.attachments || [];
          return !imgs || imgs.length === 0;
        });

        if (missingImageIndex !== -1) {
          const missingItem = prItems[missingImageIndex];
          const targetId = `pr-item-${missingItem.id || missingImageIndex}`;
          const el = document.getElementById(targetId);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('ring-2', 'ring-rose-400');
            setTimeout(() => {
              el.classList.remove('ring-2', 'ring-rose-400');
            }, 3000);
          }
          return modalService.warning('กรุณาแนบรูปภาพสินค้าให้ครบทุกรายการสำหรับงานจัดซื้อออนไลน์');
        }
      }
      
      if (requiresMemo) {
        if (!memoData.subject?.trim() || !memoData.purpose?.trim()) {
          memoSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => {
            memoSubjectInputRef.current?.focus();
          }, 350);
          return modalService.warning('กรุณากรอกบันทึกข้อความแนบ (Memo) ให้ครบถ้วนก่อนส่งขออนุมัติ');
        }

        if (quotationFiles.length === 0) return modalService.warning('กรุณาแนบไฟล์ Quotation เนื่องจากยอดรวมเกิน 20,000 บาท');
        if (imageFiles.length === 0) return modalService.warning('กรุณาแนบรูปภาพสินค้า เนื่องจากยอดรวมเกิน 20,000 บาท');
      }
    }

    setIsSubmitting(true);
    try {
      const matchedHeaderVendor = currentChannel === 'SELF' ? (masterVendors.find(v => v.id === selectedVendorId) || null) : null;
      const vId = currentChannel === 'SELF' ? (matchedHeaderVendor?.id || selectedVendorId || null) : null;
      const vName = currentChannel === 'SELF' ? (matchedHeaderVendor?.name || null) : null;

      const itemsFormatted = prItems.map(item => {
        const prod = availableProducts.find(p => p.id === item.productId) || products.find(p => p.id === item.productId);
        const itemLocation = item.usageLocation === 'OFFICE' || item.source === 'OFFICE' ? 'OFFICE' : 'FACTORY';
        const pQty = parseFloat(item.qty) || 1;
        const discP = parseFloat(item.discountPercent) || 0;
        const discA = parseFloat(item.discountAmount) || 0;
        const rate = (item.overrideUnit && Number(item.customRate) > 0)
          ? Number(item.customRate)
          : (Number(prod?.conversionRate) > 0 ? Number(prod?.conversionRate) : 1);
        const sQty = pQty * rate;
        const pUnit = (item.overrideUnit && item.customPurchaseUnit?.trim())
          ? item.customPurchaseUnit.trim()
          : (prod?.purchaseUnit || prod?.unit || 'ชิ้น');
        const sUnit = (item.overrideUnit && item.customStockUnit?.trim())
          ? item.customStockUnit.trim()
          : (prod?.stockUnit || prod?.unit || 'ชิ้น');
        const price = parseFloat(item.price) || 0;
        const rowTotal = Math.max(0, (price * pQty) - discA);

        return {
          productId: prod?.id || item.productId,
          code: prod?.code || item.customCode || 'N/A',
          name: prod?.name || item.customName || 'N/A',
          purchaseUnit: pUnit,
          stockUnit: sUnit,
          conversionRate: rate,
          purchaseQty: pQty,
          stockQty: sQty,
          qty: pQty,
          unit: pUnit,
          price: price,
          discountPercent: discP,
          discountAmount: discA,
          vendorId: vId,
          vendorName: vName,
          supplierId: vId,
          supplierName: vName,
          onlineUrl: sanitizeExternalUrl(item.productUrl || item.onlineUrl || ''),
          productUrl: sanitizeExternalUrl(item.productUrl || item.onlineUrl || ''),
          platform: item.platform || item.storePlatform || 'Shopee',
          storePlatform: item.storePlatform || item.platform || 'Shopee',
          storeName: (item.storeName || item.actualStoreName || '').trim(),
          actualStoreName: (item.actualStoreName || item.storeName || '').trim(),
          total: rowTotal,
          usageLocation: itemLocation,
          source: itemLocation,
          isCustom: Boolean(item.isCustom),
          isUnitOverridden: Boolean(item.overrideUnit && Number(item.customRate) > 0),
          images: (item.images || item.attachments || []).map((img, i) => {
            if (typeof img === 'string') {
              return { url: img, previewUrl: img, name: item.name || `item-image-${i + 1}` };
            }
            const dataUrl = img?.previewUrl || img?.url || img?.dataUrl || '';
            return {
              ...img,
              url: dataUrl,
              previewUrl: dataUrl,
              name: img?.name || item.name || `item-image-${i + 1}`
            };
          }).filter(img => Boolean(img.url)),
          attachments: (item.images || item.attachments || []).map((img, i) => {
            if (typeof img === 'string') {
              return { url: img, previewUrl: img, name: item.name || `item-image-${i + 1}` };
            }
            const dataUrl = img?.previewUrl || img?.url || img?.dataUrl || '';
            return {
              ...img,
              url: dataUrl,
              previewUrl: dataUrl,
              name: img?.name || item.name || `item-image-${i + 1}`
            };
          }).filter(img => Boolean(img.url))
        };
      });

      // Construct Memo if required
      let finalMemo = null;
      if (requiresMemo) {
        finalMemo = {
          applicantDept: department,
          applicantName1: editingPR?.requestedBy || currentRole?.name || 'Staff',
          applicantName2: '-',
          date: new Date().toISOString().split('T')[0],
          approverManager: '-',
          approverConsultant: '-',
          approverGM: 'คุณประเสริฐ',
          approverCFO: '-',
          approverBoD: '-',
          subject: memoData.subject,
          purpose: memoData.purpose,
          background: memoData.background || memoData.purpose,
          estimatedCost: grandTotal,
          paymentTerm: memoData.paymentTerm,
          classification: memoData.classification,
          remarkAttachedFile: memoData.remarkAttachedFile || 'มีเอกสารแนบ',
          conclusion: 'APPROVED',
          conclusionReason: ''
        };
      }

      const financialsPayload = currentChannel === 'SELF' ? {
        subtotal,
        itemDiscountTotal,
        combinedDiscountType,
        combinedDiscountValue: parseFloat(combinedDiscountValue) || 0,
        combinedDiscountAmount,
        totalDiscount,
        hasVat,
        vatMode: hasVat ? 'AFTER_DISCOUNT' : 'NONE',
        vatAmount,
        roundingAdj: parseFloat(roundingAdj) || 0,
        shippingCost: parseFloat(shippingCost) || 0,
        grandTotal
      } : {
        subtotal,
        itemDiscountTotal: 0,
        combinedDiscountType: 'fixed',
        combinedDiscountValue: 0,
        combinedDiscountAmount: 0,
        totalDiscount: 0,
        hasVat: false,
        vatMode: 'NONE',
        vatAmount: 0,
        roundingAdj: 0,
        shippingCost: 0,
        grandTotal: subtotal
      };

      const vendorObj = matchedHeaderVendor ? {
        id: matchedHeaderVendor.id,
        code: matchedHeaderVendor.code || '',
        name: matchedHeaderVendor.name || '',
        taxId: matchedHeaderVendor.taxId || '',
        address: matchedHeaderVendor.address || '',
        phone: matchedHeaderVendor.phone || '',
        email: matchedHeaderVendor.email || '',
        contactPerson: matchedHeaderVendor.contactPerson || ''
      } : null;

      // Ensure all images are compressed to < 150 KB and <= 1280px before entering PR payload
      const processedItems = await Promise.all(itemsFormatted.map(async (item) => {
        if (!item.images || !item.images.length) return item;
        const compressedImgs = await Promise.all(item.images.map(async (img) => {
          const rawUrl = img.previewUrl || img.url || '';
          if (rawUrl.startsWith('data:image/') && getBase64SizeBytes(rawUrl) > MAX_IMAGE_SIZE_BYTES) {
            try {
              const res = await compressImage(rawUrl, {
                maxWidth: 1280,
                maxHeight: 1280,
                quality: 0.75,
                maxSizeBytes: MAX_IMAGE_SIZE_BYTES
              });
              return {
                ...img,
                url: res.dataUrl,
                previewUrl: res.dataUrl,
                size: res.size
              };
            } catch (err) {
              console.warn('[PRCreateView] Item image compression guard error:', err);
            }
          }
          return img;
        }));
        return {
          ...item,
          images: compressedImgs,
          attachments: compressedImgs
        };
      }));

      const processedImageFiles = await Promise.all(imageFiles.map(async (f) => {
        const rawUrl = f.previewUrl || f.url || '';
        if (rawUrl.startsWith('data:image/') && getBase64SizeBytes(rawUrl) > MAX_IMAGE_SIZE_BYTES) {
          try {
            const res = await compressImage(rawUrl, {
              maxWidth: 1280,
              maxHeight: 1280,
              quality: 0.75,
              maxSizeBytes: MAX_IMAGE_SIZE_BYTES
            });
            return {
              ...f,
              previewUrl: res.dataUrl,
              url: res.dataUrl,
              size: res.size
            };
          } catch (err) {
            console.warn('[PRCreateView] Attachment image compression guard error:', err);
          }
        }
        return f;
      }));

      const nowIso = new Date().toISOString();
      // Helper: Extracts only serializable plain-text fields from an attachment object.
      // Prevents "Failed due to illegal value in property: file" on google.script.run by
      // stripping any Browser File / Blob instances that may have been captured via spread {...f}.
      const sanitizeAttachment = (f, overrides = {}) => ({
        id: f.id || f.fileId || '',
        fileName: f.fileName || f.name || 'เอกสารแนบ',
        name: f.fileName || f.name || 'เอกสารแนบ',
        fileSize: typeof f.fileSize === 'number' ? f.fileSize : (typeof f.size === 'number' ? f.size : 0),
        size: typeof f.size === 'number' ? f.size : 0,
        mimeType: f.mimeType || f.type || 'application/octet-stream',
        type: f.mimeType || f.type || 'application/octet-stream',
        url: f.url || f.previewUrl || f.viewUrl || f.directUrl || '',
        previewUrl: f.previewUrl || f.url || f.viewUrl || f.directUrl || '',
        viewUrl: f.viewUrl || f.url || '',
        directUrl: f.directUrl || '',
        lh3Url: f.lh3Url || '',
        fileId: f.fileId || f.id || '',
        driveUrl: f.driveUrl || f.viewUrl || '',
        folderPath: f.folderPath || '',
        category: f.category || overrides.category || '01_PR_Attachments',
        uploadedBy: typeof f.uploadedBy === 'string' ? f.uploadedBy : '',
        uploadedAt: typeof f.uploadedAt === 'string' ? f.uploadedAt : '',
        ...overrides
      });

      const prPayload = {
        prNo: editingPR ? editingPR.prNo : nextPRNumber,
        department,
        purchaseChannel: currentChannel,
        channel: currentChannel,
        enforceImageValidation: true,
        vendorId: vId,
        vendorName: vName,
        vendor: vendorObj,
        supplierId: vId,
        supplierName: vName,
        hasVat: currentChannel === 'SELF' ? hasVat : false,
        specUrl: quotationFiles[0] ? (quotationFiles[0].fileName || quotationFiles[0].name || '') : '',
        quotationFiles: quotationFiles.map(f => sanitizeAttachment(f, { category: 'QUOTATION', type: f.mimeType || f.type || 'application/pdf' })),
        generalAttachments: processedImageFiles.map(f => sanitizeAttachment(f, { category: 'GENERAL', type: f.mimeType || f.type || 'image/jpeg' })),
        images: processedImageFiles.map(f => sanitizeAttachment(f, { category: 'IMAGE', type: f.mimeType || f.type || 'image/jpeg' })),
        attachments: [
          ...quotationFiles.map(f => sanitizeAttachment(f, { category: 'QUOTATION', type: f.mimeType || f.type || 'application/pdf' })),
          ...processedImageFiles.map(f => sanitizeAttachment(f, { category: 'GENERAL', type: f.mimeType || f.type || 'image/jpeg' }))
        ],
        note,
        items: processedItems.map(item => ({
          ...item,
          // Strip any File/Blob from images/attachments in items as well
          images: Array.isArray(item.images)
            ? item.images.map(img => typeof img === 'string'
                ? { url: img, previewUrl: img }
                : { url: img?.url || img?.previewUrl || '', previewUrl: img?.previewUrl || img?.url || '', name: img?.name || '', fileId: img?.fileId || '', driveUrl: img?.driveUrl || '', lh3Url: img?.lh3Url || '' }
              ).filter(img => Boolean(img.url))
            : [],
          attachments: Array.isArray(item.attachments)
            ? item.attachments.map(att => typeof att === 'string'
                ? { url: att, previewUrl: att }
                : { url: att?.url || att?.previewUrl || '', previewUrl: att?.previewUrl || att?.url || '', name: att?.name || '', fileId: att?.fileId || '', driveUrl: att?.driveUrl || '', lh3Url: att?.lh3Url || '' }
              ).filter(att => Boolean(att.url))
            : []
        })),
        financials: financialsPayload,
        totalAmount: grandTotal,
        memo: finalMemo,
        createdAt: editingPR?.createdAt || nowIso,
        submittedAt: isDraft ? (editingPR?.submittedAt || null) : (editingPR?.submittedAt || nowIso)
      };

      let newPR;
      if (editingPR) {
        if (updatePR) {
          newPR = await updatePR(editingPR.id, prPayload, isDraft);
        } else {
          newPR = await apiService.updatePR(editingPR.id, prPayload, currentRole, isDraft);
        }
        if (clearEditingPR) clearEditingPR();
      } else {
        if (handleSavePR) {
          newPR = await handleSavePR(prPayload, isDraft);
        } else if (createPR) {
          newPR = await createPR(prPayload, isDraft);
        } else {
          newPR = await apiService.createPR(prPayload, currentRole, isDraft);
        }
        if (clearPreselectedProduct) clearPreselectedProduct();
      }

      // Optimistic Local Update
      if (newPR && context?.setPRs) {
        context.setPRs(prev => {
          if (!Array.isArray(prev)) return [newPR];
          const exists = prev.some(p => p.id === newPR.id || (newPR.prNo && p.prNo === newPR.prNo));
          if (exists) return prev.map(p => (p.id === newPR.id || (newPR.prNo && p.prNo === newPR.prNo)) ? newPR : p);
          return [newPR, ...prev];
        });
      }

      const msg = editingPR 
        ? (isDraft ? 'บันทึกแบบร่างเรียบร้อย' : 'แก้ไขและยื่นส่งใบขอซื้อ (PR) สำเร็จ')
        : (isDraft ? 'บันทึกแบบร่างสำเร็จ' : 'สร้างและยื่นส่งใบขอซื้อ (PR) สำเร็จ');
      
      setIsSubmitting(false); // Enable UI immediately
      
      setSuccessModalInfo({
        title: 'ดำเนินการสำเร็จ',
        message: msg
      });
      setShowSuccessModal(true);
      
      // Start background sync WITHOUT blocking the UI
      setTimeout(() => {
        if (context?.fetchBootstrapData) {
          context.fetchBootstrapData(true).catch(err => console.warn('Background sync error:', err));
        } else if (context?.refreshData) {
          context.refreshData(true).catch(err => console.warn('Background sync error:', err));
        } else if (onRefresh) {
          const p = onRefresh();
          if (p && p.catch) p.catch(err => console.warn('Background sync error:', err));
        }
      }, 500);
      
      return;
    } catch (err) {
      modalService.error(editingPR ? 'เกิดข้อผิดพลาดในการแก้ไข PR' : 'เกิดข้อผิดพลาดในการสร้าง PR', err.message);
      setIsSubmitting(false);
    }
  };

  const handleCancelAndBack = () => {
    if (clearPreselectedProduct) clearPreselectedProduct();
    if (clearEditingPR) clearEditingPR();
    onNavigate('pr-list');
  };

  return (
    <div className="w-full max-w-7xl mx-auto space-y-6 animate-fade-in pb-24 lg:pb-32">
      
      {/* ── Top Header & Navigation ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <button 
            type="button"
            onClick={handleCancelAndBack}
            className="w-10 h-10 flex items-center justify-center bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 border border-slate-200/80 rounded-full transition-all shadow-sm hover:shadow cursor-pointer shrink-0"
            title="ย้อนกลับไปรายการ PR"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2 flex-wrap">
                <span>{editingPR ? `แก้ไขใบขอซื้อ (${editingPR.prNo})` : 'สร้างใบขอซื้อใหม่ (New PR)'}</span>
                {!editingPR && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    เลขที่: {nextPRNumber}
                  </span>
                )}
              </h2>
              {editingPR?.status && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                  {editingPR.status}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5 font-normal">
              {editingPR ? (
                <>แก้ไขข้อมูลรายการสินค้าและเอกสารแนบเพื่อยื่นส่งใหม่อีกครั้ง</>
              ) : (
                <>กรอกรายละเอียดคำขอซื้อวัตถุดิบและอุปกรณ์สำหรับฝ่าย <span className="font-semibold text-slate-800 font-mono">[{department}]</span></>
              )}
            </p>
          </div>
        </div>

        {/* Scope Pill Badge */}
        <div className="flex items-center gap-2 px-3.5 py-2 bg-white rounded-2xl border border-slate-200/80 shadow-sm w-fit self-start sm:self-auto">
          <Building2 className="w-4 h-4 text-slate-400" />
          <span className="text-xs text-slate-500 font-medium">สังกัดฝ่าย:</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200/80">
            {deptMap[department]?.name ? `${deptMap[department].name} (${department})` : department}
          </span>
        </div>
      </div>

      {/* ── Return Reason Notice Banner (if editing returned PR) ── */}
      {returnReason && (
        <div className="bg-amber-50/80 border border-amber-200 rounded-2xl p-4 sm:p-5 shadow-sm flex items-start gap-3.5 animate-fade-in">
          <div className="p-2 bg-amber-100 text-amber-800 rounded-xl shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="space-y-1 min-w-0">
            <h4 className="font-bold text-amber-900 text-sm sm:text-base">
              ใบขอซื้อนี้ถูกส่งกลับให้แก้ไข (Returned for Correction)
            </h4>
            <p className="text-xs sm:text-sm text-amber-800 leading-relaxed font-medium">
              {returnReason}
            </p>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
         2-COLUMN GRID ARCHITECTURE (Directive 1)
         Left Column: lg:col-span-8 (Channel, Items, Compact Attachments, Conditional Memo)
         Right Column: lg:col-span-4 (Payment Summary, Budget Usage Bar, Sticky Actions)
         ───────────────────────────────────────────────────────────── */}
      <form onSubmit={e => e.preventDefault()} className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* ══════════════════════════════════════════════════════════════
           LEFT COLUMN: Main Work Area (lg:col-span-8)
           ══════════════════════════════════════════════════════════════ */}
        <div className="lg:col-span-8 space-y-6">
          
          {/* Card 1: Channel & Department Info */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 sm:p-6 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              
              {/* Department Selector */}
              <div className="space-y-1.5 flex-1 max-w-xs">
                <label className="text-xs font-bold text-slate-700 block">
                  ฝ่ายผู้ขอซื้อ (Department) <span className="text-rose-500">*</span>
                </label>
                {currentRole?.department !== 'ALL' ? (
                  <div className="w-full border border-slate-200/80 bg-slate-50/60 rounded-xl px-3.5 py-2 text-xs font-semibold flex items-center justify-between gap-2 text-slate-800">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-3.5 h-3.5 text-slate-500" />
                      <span>{deptMap[department]?.name ? `${deptMap[department].name} (${department})` : department}</span>
                    </div>
                    <span className="text-[10px] font-normal text-slate-400">(ตามสิทธิ์)</span>
                  </div>
                ) : (
                  <select
                    value={department}
                    onChange={e => setDepartment(e.target.value)}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                  >
                    {activeDepartments.map(d => (
                      <option key={d.code} value={d.code}>
                        {d.name} ({d.code})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Purchase Channel: Modern Segmented Pill Switcher (Directive 2) */}
              <div>
                <label className="text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                  <span>ช่องทางจัดซื้อ (Purchase Channel)</span>
                  <span className="text-rose-500">*</span>
                </label>
                <div className="inline-flex p-1 rounded-xl bg-slate-100 border border-slate-200/80 gap-1 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => setPurchaseChannel('SELF')}
                    className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                      purchaseChannel === 'SELF'
                        ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                        : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50 font-medium'
                    }`}
                  >
                    <Building2 className={`w-4 h-4 ${purchaseChannel === 'SELF' ? 'text-indigo-600' : 'text-slate-400'}`} />
                    <span>สั่งซื้อภายใน</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurchaseChannel('ONLINE')}
                    className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                      purchaseChannel === 'ONLINE'
                        ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                        : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50 font-medium'
                    }`}
                  >
                    <ShoppingCart className={`w-4 h-4 ${purchaseChannel === 'ONLINE' ? 'text-indigo-600' : 'text-slate-400'}`} />
                    <span>จัดซื้อออนไลน์</span>
                  </button>
                </div>
              </div>

            </div>

            {/* Form Header Vendor Selector (Rule 1 PR = 1 Vendor for Internal Purchase) */}
            {purchaseChannel === 'SELF' && (
              <div className="pt-3 border-t border-slate-100 space-y-2 animate-fade-in">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                  <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Building className="w-4 h-4 text-indigo-600 shrink-0" />
                    <span>ผู้จัดจำหน่าย (Vendor)</span>
                    <span className="text-rose-500">*</span>
                    <span className="text-[11px] font-normal text-slate-400 hidden sm:inline">(1 PR = 1 ผู้จัดจำหน่าย)</span>
                  </label>
                  {selectedVendor && (
                    <span className="text-[11px] font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100 self-start sm:self-auto">
                      {selectedVendor.code}
                    </span>
                  )}
                </div>
                
                <SearchableSelect
                  options={vendorOptions}
                  value={selectedVendorId}
                  onChange={val => setSelectedVendorId(val)}
                  placeholder="-- ค้นหาหรือเลือกผู้จัดจำหน่าย (Vendor) --"
                  searchPlaceholder="พิมพ์ชื่อ, รหัส หรือเลขประจำตัวผู้เสียภาษีของผู้ขาย..."
                  emptyMessage="ไม่พบข้อมูลผู้จัดจำหน่ายในระบบ"
                  className="text-xs"
                />

                {selectedVendor && (
                  <div className="p-3 bg-slate-50/90 rounded-xl border border-slate-200/80 text-xs text-slate-600 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span><strong>เลขผู้เสียภาษี:</strong> {selectedVendor.taxId || '-'}</span>
                      <span><strong>ผู้ติดต่อ:</strong> {selectedVendor.contactPerson || '-'}</span>
                      <span><strong>โทร:</strong> {selectedVendor.phone || '-'}</span>
                    </div>
                    {selectedVendor.address && (
                      <p className="text-slate-500 text-[11px] leading-relaxed truncate" title={selectedVendor.address}>
                        <strong>ที่อยู่:</strong> {selectedVendor.address}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Card 2: Minimalist Items Selection List (Directive 4) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 px-1">
              <h3 className="text-sm font-bold text-slate-800">
                รายการสินค้าที่ขอซื้อ
              </h3>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-100 font-mono">
                {prItems.length} รายการ
              </span>
            </div>

            {/* List of Minimalist Card Items */}
            <div className="space-y-3">
              {prItems.map((item, idx) => {
                const selProd = !item.isCustom ? (availableProducts.find(p => p.id === item.productId) || products.find(p => p.id === item.productId)) : null;
                const itemGross = (parseFloat(item.price) || 0) * (parseFloat(item.qty) || 0);
                const _itemRowNet = Math.max(0, itemGross - (parseFloat(item.discountAmount) || 0));
                const itemImages = item.images || item.attachments || [];
                const hasImages = itemImages.length > 0;
                const isMissingRequiredImage = isOnline && !hasImages;

                return (
                  <div
                    key={item.id || idx}
                    id={`pr-item-${item.id || idx}`}
                    className={`bg-white border rounded-2xl p-4 sm:p-5 shadow-sm transition-all space-y-3.5 ${
                      isMissingRequiredImage
                        ? 'border-rose-300 ring-1 ring-rose-200 bg-rose-50/10'
                        : 'border-slate-200/80 hover:border-slate-300'
                    }`}
                  >
                    {/* Primary Row: Standardized h-10 (40px) Elements along exact Baseline */}
                    <div className="flex items-center gap-2 sm:gap-2.5 w-full flex-wrap sm:flex-nowrap">
                      
                      {/* Index Badge [ 1 ] */}
                      <span className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200">
                        {idx + 1}
                      </span>

                      {/* Product Select Box */}
                      {item.isCustom ? (
                        <div className="flex-1 min-w-[200px] max-w-xl h-10 flex items-center gap-2">
                          <span className="h-full px-3 bg-purple-50 text-purple-700 text-xs sm:text-sm font-mono font-bold rounded-xl border border-purple-200 flex items-center shrink-0">
                            {item.customCode || 'NON-CAT'}
                          </span>
                          <input
                            type="text"
                            value={item.customName || ''}
                            onChange={e => handleItemChange(idx, 'customName', e.target.value)}
                            placeholder="พิมพ์ชื่อสินค้า/สเปกที่ต้องการขอซื้อ (Non-Catalog)..."
                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-xs sm:text-sm font-medium text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all truncate"
                            required
                            title={item.customName || ''}
                          />
                        </div>
                      ) : (
                        <div className="flex-1 min-w-[200px] max-w-xl h-10">
                          <SearchableSelect
                            options={productOptions}
                            value={item.productId}
                            onChange={val => handleItemChange(idx, 'productId', val)}
                            placeholder="-- ค้นหาหรือเลือกสินค้า --"
                            searchPlaceholder={`ค้นหารหัส ชื่อสินค้า ในแผนก ${department}...`}
                            emptyMessage={`ไม่พบสินค้าของแผนก ${department}`}
                            className="w-full h-10"
                            buttonClassName="!h-10 !min-h-[40px] !px-3 !rounded-xl !bg-white hover:!border-slate-300 !border-slate-200 !text-xs sm:!text-sm !font-medium"
                            required
                            showCodeBadgeInTrigger={false}
                          />
                        </div>
                      )}

                      {/* Compact Financial Cluster (Price, Qty Stepper, Unit, Total, Remove) */}
                      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
                        {/* ช่องราคาต่อหน่วย: รองรับทศนิยม ไม่โดนตัดขอบ พร้อมปิด spinner */}
                        <div className="relative w-28 sm:w-30 h-10 shrink-0">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs select-none pointer-events-none">฿</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.price}
                            onChange={e => handleItemChange(idx, 'price', e.target.value)}
                            placeholder="0.00"
                            className="w-full h-10 pl-5 pr-2 text-right font-mono text-sm tracking-tight text-slate-800 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:outline-none transition-all tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            title="ราคาต่อหน่วย"
                          />
                        </div>

                        {/* ชุดนับจำนวน: Unified h-10 */}
                        <div className="h-10 w-22 sm:w-24 p-1 flex items-center justify-between border border-slate-200 rounded-xl bg-slate-50 shrink-0">
                          <button 
                            type="button" 
                            onClick={() => handleDecrementQty(idx)}
                            disabled={Number(item.qty) <= 1}
                            className="w-8 h-8 rounded-lg bg-white border border-slate-200/80 shadow-2xs flex items-center justify-center text-slate-600 hover:bg-slate-100 active:scale-95 text-xs font-bold transition-all disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                            title="ลดจำนวน"
                          >
                            -
                          </button>
                          <span className="font-mono text-xs sm:text-sm font-semibold text-slate-800 text-center flex-1 leading-none tabular-nums">
                            {item.qty}
                          </span>
                          <button 
                            type="button" 
                            onClick={() => handleIncrementQty(idx)}
                            className="w-8 h-8 rounded-lg bg-white border border-slate-200/80 shadow-2xs flex items-center justify-center text-slate-600 hover:bg-slate-100 active:scale-95 text-xs font-bold transition-all cursor-pointer"
                            title="เพิ่มจำนวน"
                          >
                            +
                          </button>
                        </div>

                        {/* หน่วยนับ: ขยายพื้นที่รองรับหน่วยข้อความยาว พร้อม Tooltip */}
                        {item.isCustom ? (
                          <input
                            type="text"
                            value={item.customUnit || 'ชิ้น'}
                            onChange={e => handleItemChange(idx, 'customUnit', e.target.value)}
                            className="min-w-[40px] max-w-[85px] text-xs text-slate-500 font-medium text-center truncate shrink-0 px-1 bg-transparent border-b border-dashed border-slate-300 focus:border-indigo-500 focus:outline-none py-0.5"
                            placeholder="หน่วย"
                            title={item.customUnit || 'หน่วยนับ'}
                          />
                        ) : (
                          <span 
                            className="min-w-[40px] max-w-[85px] text-xs text-slate-500 font-medium text-center truncate shrink-0 px-1"
                            title={selProd?.purchaseUnit || selProd?.unit || 'ชิ้น'}
                          >
                            {selProd?.purchaseUnit || selProd?.unit || 'ชิ้น'}
                          </span>
                        )}

                        {/* ยอดเงินรวมรายบรรทัด */}
                        <span className="font-mono font-bold text-slate-900 text-xs sm:text-sm text-right min-w-[85px] sm:min-w-[90px] tabular-nums shrink-0">
                          ฿{(item.qty * item.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>

                        {/* ปุ่มลบรายการ */}
                        {prItems.length > 1 ? (
                          <button 
                            type="button"
                            onClick={() => handleRemoveItemRow(idx)}
                            className="w-8 h-8 shrink-0 flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                            title="ลบรายการนี้"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : (
                          <span className="w-8 shrink-0"></span>
                        )}
                      </div>

                    </div>

                    {/* Sub-row: Location Switch, Stock Info & Ghost Action Links (Directives 2 & 3) */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-slate-100 text-xs">
                      {/* Left: Location Segmented Switch + Stock Info + Conversion Rate */}
                      <div className="flex flex-wrap items-center gap-2.5">
                        {/* Segmented Location Switch (Directive 2) */}
                        <div className="inline-flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] font-medium text-slate-500 flex items-center gap-1">
                            📍 ใช้งานที่:
                          </span>
                          <div className="inline-flex p-0.5 rounded-lg bg-slate-100 border border-slate-200 text-xs">
                            <button
                              type="button"
                              onClick={() => handleItemChange(idx, 'usageLocation', 'FACTORY')}
                              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                                (item.usageLocation || item.source || 'FACTORY') === 'FACTORY'
                                  ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                                  : 'text-slate-500 hover:text-slate-800'
                              }`}
                            >
                              🏭 โรงงาน
                            </button>
                            <button
                              type="button"
                              onClick={() => handleItemChange(idx, 'usageLocation', 'OFFICE')}
                              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                                (item.usageLocation || item.source) === 'OFFICE'
                                  ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                                  : 'text-slate-500 hover:text-slate-800'
                              }`}
                            >
                              🏢 ออฟฟิศ
                            </button>
                          </div>
                        </div>

                        {/* Stock Info (Directive 3) */}
                        {selProd && (
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                            <span>•</span>
                            <span>
                              คงเหลือในระบบ: <strong className="font-semibold text-slate-700">{selProd.stockBalance ?? 0} {selProd.stockUnit || selProd.unit || 'ชิ้น'}</strong>
                              {' '}(จุดสั่งซื้อ ROP: <span className={Number(selProd.stockBalance) <= Number(selProd.reorderPoint) ? 'text-amber-600 font-semibold' : 'text-slate-600 font-semibold'}>{selProd.reorderPoint ?? 0} {selProd.stockUnit || selProd.unit || 'ชิ้น'}</span>)
                            </span>
                          </div>
                        )}

                        {/* Conversion Rate Badge (if applicable) */}
                        {selProd && (() => {
                          const effectiveRate = (item.overrideUnit && Number(item.customRate) > 0)
                            ? Number(item.customRate)
                            : (Number(selProd.conversionRate) > 0 ? Number(selProd.conversionRate) : 1);
                          const effectiveStockUnit = (item.overrideUnit && item.customStockUnit?.trim())
                            ? item.customStockUnit.trim()
                            : (selProd.stockUnit || selProd.unit || 'ชิ้น');

                          if (effectiveRate > 1 || item.overrideUnit) {
                            return (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-medium border border-indigo-200/70">
                                <Sparkles className="w-3 h-3 text-indigo-500" />
                                <span>เข้าคลัง: {(Number(item.qty || 0) * effectiveRate).toLocaleString()} {effectiveStockUnit}</span>
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* Right: Ghost Action Text (Directive 3) & Item-Level Image Input */}
                      <div className="flex items-center gap-3 ml-auto">
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          ref={el => { fileInputRefs.current[item.id || idx] = el; }}
                          onChange={(e) => handleItemImageUpload(idx, e)}
                          className="hidden"
                        />

                        {selProd && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = !item.overrideUnit;
                              handleItemChange(idx, 'overrideUnit', next);
                              if (next && !item.customRate) {
                                handleItemChange(idx, 'customRate', selProd.conversionRate || 1);
                                handleItemChange(idx, 'customPurchaseUnit', selProd.purchaseUnit || selProd.unit);
                                handleItemChange(idx, 'customStockUnit', selProd.stockUnit || selProd.unit);
                              }
                            }}
                            className={`text-[11px] font-medium transition-colors cursor-pointer ${
                              item.overrideUnit ? 'text-indigo-600 font-semibold' : 'text-slate-400 hover:text-slate-700'
                            }`}
                          >
                            {item.overrideUnit ? 'สเปกเฉพาะ (เปิดอยู่)' : '+ สเปกเฉพาะ'}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleToggleCustomItem(idx)}
                          className="text-[11px] font-medium text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                        >
                          {item.isCustom ? '← เลือกจากระบบ' : '+ นอกแคตาล็อก'}
                        </button>
                      </div>
                    </div>

                    {/* Collapsible Unit Mapping Override Panel */}
                    {selProd && item.overrideUnit && (
                      <div className="p-3 bg-slate-50/80 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-end gap-3 animate-fade-in">
                        <div className="flex-1">
                          <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">หน่วยขอซื้อ</label>
                          <input
                            type="text"
                            value={item.customPurchaseUnit || selProd.purchaseUnit || selProd.unit || ''}
                            onChange={e => handleItemChange(idx, 'customPurchaseUnit', e.target.value)}
                            placeholder="เช่น ถัง (50L)"
                            className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">อัตราแปลงเป็นสต็อก</label>
                          <input
                            type="number"
                            min="0.001"
                            step="any"
                            value={item.customRate ?? selProd.conversionRate ?? 1}
                            onChange={e => handleItemChange(idx, 'customRate', e.target.value)}
                            placeholder="เช่น 50"
                            className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-indigo-700 text-center outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">หน่วยเข้าคลัง</label>
                          <input
                            type="text"
                            value={item.customStockUnit || selProd.stockUnit || selProd.unit || ''}
                            onChange={e => handleItemChange(idx, 'customStockUnit', e.target.value)}
                            placeholder="เช่น ลิตร"
                            className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>
                    )}

                    {/* Smart Item Link for Online Procurement (Directive 2) */}
                    {/* Smart Item Link & Gen-Z Media Strip for Online Procurement (Directives 1 & 2) */}
                    {purchaseChannel === 'ONLINE' && (
                      <div className="space-y-2.5 animate-fade-in">
                        <div className="mt-2.5 pt-2 border-t border-slate-150/60 flex items-center gap-2">
                          {/* Dropdown / Chip เลือกแพลตฟอร์ม */}
                          <select 
                            value={item.platform || 'Shopee'} 
                            onChange={(e) => handleItemChange(idx, 'platform', e.target.value)}
                            className="h-8 px-2.5 text-xs font-semibold rounded-lg bg-slate-100 border border-slate-200 text-slate-700 outline-none focus:border-indigo-500 cursor-pointer shrink-0"
                          >
                            <option value="Shopee">Shopee</option>
                            <option value="Lazada">Lazada</option>
                            <option value="Official">เว็บไซต์ทางการ</option>
                            <option value="Other">ร้านค้าภายนอก</option>
                          </select>

                          {/* ช่องกรอก URL สินค้า พร้อมระบบ Auto-detect แพลตฟอร์ม */}
                          <div className="relative flex-1">
                            <input
                              type="url"
                              placeholder="วางลิงก์หน้าสินค้า (Product URL)..."
                              value={item.productUrl || item.onlineUrl || ''}
                              onChange={(e) => handleUrlChange(idx, e.target.value)}
                              className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-slate-50/70 border border-slate-200 focus:bg-white focus:border-indigo-500 font-sans outline-none transition-all"
                            />
                            <LinkIcon className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5"/>
                          </div>

                          {/* ช่องระบุชื่อร้านค้าแนะนำ (Optional) */}
                          <input
                            type="text"
                            placeholder="ชื่อร้านค้า (ถ้าทราบ)"
                            value={item.storeName || ''}
                            onChange={(e) => handleItemChange(idx, 'storeName', e.target.value)}
                            className="w-44 h-8 px-3 text-xs rounded-lg bg-slate-50/70 border border-slate-200 focus:bg-white focus:border-indigo-500 text-slate-700 outline-none transition-all shrink-0"
                          />
                        </div>

                        {/* Gen-Z SaaS Media Strip & Gallery (Directive 2) */}
                        {!hasImages ? (
                          /* State A: ยังไม่แนบรูป (Empty State) */
                          <div className="space-y-1">
                            <div 
                              onClick={() => triggerUpload(item.id || idx)}
                              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
                              onDrop={(e) => handleItemImageDrop(idx, e)}
                              className="mt-2.5 flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-dashed border-rose-300 bg-rose-50/50 hover:bg-rose-50 text-rose-700 cursor-pointer transition-all group"
                            >
                              <div className="w-7 h-7 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center font-bold text-sm group-hover:scale-110 transition-transform">
                                📷
                              </div>
                              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                                <span className="text-xs font-bold">แนบรูปภาพสินค้าจริง *</span>
                                <span className="text-[11px] text-rose-500 font-medium">(จำเป็นสำหรับจัดซื้อออนไลน์ — คลิกหรือลากวางรูปภาพที่นี่)</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 pl-1 text-[11px] font-semibold text-rose-600">
                              <span>* กรุณาแนบรูปสินค้าจริงสำหรับจัดซื้อออนไลน์</span>
                            </div>
                          </div>
                        ) : (
                          /* State B: แนบรูปแล้ว (Filled Modern Gallery) */
                          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md flex items-center gap-1 shrink-0">
                              ✓ แนบแล้ว ({itemImages.length})
                            </span>

                            {/* Thumbnail Cards 48x48px */}
                            {itemImages.map((img, imgIdx) => {
                              const imgSrc = resolveDriveImageUrl(img, 'w400');
                              return (
                                <div key={imgIdx} className="relative group w-12 h-12 rounded-xl overflow-hidden border-2 border-white ring-1 ring-slate-200 shadow-2xs">
                                  <img 
                                    src={imgSrc} 
                                    alt={img.name || `preview-${imgIdx}`} 
                                    className="w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer"
                                    onClick={() => handlePreviewImage(img)}
                                    onError={(e) => handleDriveImageError(e, img)}
                                  />
                                  {/* Hover Action Overlay */}
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                                    <button 
                                      type="button" 
                                      onClick={(e) => { e.stopPropagation(); handleRemoveItemImage(idx, imgIdx); }}
                                      className="w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center text-[10px] hover:bg-rose-700 cursor-pointer"
                                      title="ลบรูปนี้"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              );
                            })}

                            {/* ปุ่ม + เพิ่มรูปอีก */}
                            <button
                              type="button"
                              onClick={() => triggerUpload(item.id || idx)}
                              className="w-12 h-12 rounded-xl border-2 border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/50 text-slate-400 hover:text-indigo-600 flex flex-col items-center justify-center transition-all cursor-pointer"
                              title="เพิ่มรูปภาพอีก"
                            >
                              <span className="text-base font-bold leading-none">+</span>
                              <span className="text-[8px] font-medium mt-0.5">เพิ่ม</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Gallery for Non-Online (Offline / SELF) mode */}
                    {purchaseChannel !== 'ONLINE' && (
                      <div className="mt-2.5 pt-2 border-t border-slate-100">
                        {hasImages ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md flex items-center gap-1 shrink-0">
                              📷 รูปแนบ ({itemImages.length})
                            </span>
                            {itemImages.map((img, imgIdx) => {
                              const imgSrc = resolveDriveImageUrl(img, 'w400');
                              return (
                                <div key={imgIdx} className="relative group w-12 h-12 rounded-xl overflow-hidden border-2 border-white ring-1 ring-slate-200 shadow-2xs">
                                  <img 
                                    src={imgSrc} 
                                    alt={img.name || `preview-${imgIdx}`} 
                                    className="w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer"
                                    onClick={() => handlePreviewImage(img)}
                                    onError={(e) => handleDriveImageError(e, img)}
                                  />
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                                    <button 
                                      type="button" 
                                      onClick={(e) => { e.stopPropagation(); handleRemoveItemImage(idx, imgIdx); }}
                                      className="w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center text-[10px] hover:bg-rose-700 cursor-pointer"
                                      title="ลบรูปนี้"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() => triggerUpload(item.id || idx)}
                              className="w-12 h-12 rounded-xl border-2 border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/50 text-slate-400 hover:text-indigo-600 flex flex-col items-center justify-center transition-all cursor-pointer"
                              title="เพิ่มรูปภาพอีก"
                            >
                              <span className="text-base font-bold leading-none">+</span>
                              <span className="text-[8px] font-medium mt-0.5">เพิ่ม</span>
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => triggerUpload(item.id || idx)}
                            className="text-[11px] font-medium text-slate-400 hover:text-indigo-600 flex items-center gap-1 transition-colors cursor-pointer"
                            title="แนบรูปภาพสำหรับสินค้ารายการนี้ (ทางเลือก)"
                          >
                            <span>📷 แนบรูปสินค้า (ทางเลือก)</span>
                          </button>
                        )}
                      </div>
                    )}

                  </div>
                );
              })}
            </div>

            {/* Dashed Button for Adding Items (Full width, clean - Directive 4) */}
            <button
              type="button"
              onClick={handleAddItemRow}
              className="w-full py-3 border border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/40 text-slate-600 hover:text-indigo-600 rounded-2xl text-xs font-semibold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-2xs group"
            >
              <Plus className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors" />
              <span>+ เพิ่มรายการสินค้า</span>
            </button>
          </div>

          {/* Card 3: Compact Attachments & PR Note (Directive 2: max height <= 70px) */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 sm:p-6 shadow-sm space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                เอกสารประกอบและหมายเหตุ (Attachments & Note)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                แนบใบเสนอราคาหรือเอกสารประกอบรวมของการขอซื้อ
              </p>
            </div>

            {/* Compact File Uploaders (height <= 70px) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FileUploader
                label="ใบเสนอราคา (Quotation)"
                required={requiresMemo}
                accept="application/pdf,image/*"
                multiple={false}
                files={quotationFiles}
                setFiles={setQuotationFiles}
                compact={true}
                helperText="คลิกหรือลากไฟล์ PDF/รูปภาพ"
              />

              <FileUploader
                label="เอกสาร/รูปภาพประกอบรวม (General Attachments)"
                required={requiresMemo}
                accept="image/*,application/pdf"
                multiple={true}
                files={imageFiles}
                setFiles={setImageFiles}
                compact={true}
                helperText="แนบเอกสารหรือรูปภาพประกอบรวม"
              />
            </div>

            {/* PR Note Textarea */}
            <div className="space-y-1 pt-1">
              <label className="text-xs font-semibold text-slate-700 block">
                หมายเหตุการขอซื้อ (PR Note)
              </label>
              <textarea
                rows="2"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="ระบุเหตุผลในการขอซื้อเพิ่มเติม วัตถุประสงค์ หรือความเร่งด่วน..."
                className="w-full bg-slate-50/50 hover:bg-white focus:bg-white border border-slate-200 focus:border-indigo-500 rounded-xl p-3 text-xs sm:text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all resize-none"
              />
            </div>
          </div>

          {/* Card 4: Conditional Memo Section (Rule: grandTotal >= 20,000) (Directive 3) */}
          {requiresMemo && (
            <div 
              ref={memoSectionRef}
              className="bg-white border border-amber-200/90 rounded-2xl p-5 sm:p-6 shadow-sm space-y-4 animate-fade-in relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-1.5 h-full bg-amber-500 rounded-l-2xl"></div>

              {/* Card Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-200/80 flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      บันทึกข้อความเสนอขออนุมัติ (Memo ถึง ผจก.โรงงาน)
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      กรอกรายละเอียดและเหตุผลความจำเป็นเพื่อส่งเสนอผู้จัดการโรงงานพิจารณาอนุมัติ
                    </p>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0 self-start sm:self-auto">
                  เกณฑ์ยอดจัดซื้อ ≥ ฿20,000
                </span>
              </div>

              {/* Grid Layout จัดระเบียบช่องกรอก (Directive 3) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                {/* แถวที่ 1: หัวข้อ/โครงการ (กว้าง 100% หรือ col-span-12) */}
                <div className="md:col-span-2 space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 block">
                    หัวข้อ / โครงการ (Subject) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    ref={memoSubjectInputRef}
                    type="text"
                    value={memoData.subject}
                    onChange={e => setMemoData({ ...memoData, subject: e.target.value })}
                    placeholder="เช่น ขออนุมัติติดตั้งระบบหล่อลื่นและเปลี่ยนถ่ายน้ำมันไฮดรอลิก..."
                    className="w-full bg-slate-50/60 focus:bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-all"
                  />
                </div>

                {/* แถวที่ 2: Grid 2 คอลัมน์ (ประเภทงบประมาณ & เงื่อนไขการชำระเงิน) */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 block">
                    ประเภทงบประมาณ (Budget Type)
                  </label>
                  <select
                    value={memoData.classification}
                    onChange={e => setMemoData({ ...memoData, classification: e.target.value })}
                    className="w-full bg-slate-50/60 focus:bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-all cursor-pointer"
                  >
                    <option value="EXPENSE">Expense (ค่าใช้จ่ายดำเนินงาน)</option>
                    <option value="ASSET">Capex / Asset (ทรัพย์สินถาวร / ลงทุน)</option>
                    <option value="OTHER">Other (อื่นๆ)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 block">
                    เงื่อนไขการชำระเงิน (Payment Terms)
                  </label>
                  <input
                    type="text"
                    value={memoData.paymentTerm}
                    onChange={e => setMemoData({ ...memoData, paymentTerm: e.target.value })}
                    placeholder="เช่น เครดิต 30 วัน, เงินสด"
                    className="w-full bg-slate-50/60 focus:bg-white border border-slate-200 focus:border-amber-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-all"
                  />
                </div>

                {/* แถวที่ 3: วัตถุประสงค์และความจำเป็น (Textarea rows={3} text-xs) */}
                <div className="md:col-span-2 space-y-1.5">
                  <label className="text-xs font-bold text-slate-700 block">
                    วัตถุประสงค์และความจำเป็น (Purpose & Necessity) <span className="text-rose-500">*</span>
                  </label>
                  <textarea
                    rows={3}
                    value={memoData.purpose}
                    onChange={e => setMemoData({ ...memoData, purpose: e.target.value })}
                    placeholder="ระบุวัตถุประสงค์ ความจำเป็น และผลประโยชน์ที่จะได้รับจากการจัดซื้อครั้งนี้..."
                    className="w-full bg-slate-50/60 focus:bg-white border border-slate-200 focus:border-amber-500 rounded-xl p-3 text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 transition-all resize-none"
                  />
                </div>
              </div>

            </div>
          )}

        </div>

        {/* ══════════════════════════════════════════════════════════════
           RIGHT COLUMN: Sticky Sidebar (lg:col-span-4)
           Contains: Payment Summary, Department Budget Usage Bar, Actions
           ══════════════════════════════════════════════════════════════ */}
        <div className="lg:col-span-4 lg:sticky lg:top-6 space-y-5 pb-8 lg:pb-16">
          
          {/* Box 1: Payment Summary Card (Directive 1 & 2) */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2 text-slate-900">
                <Receipt className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold">สรุปรายการชำระเงิน</h3>
              </div>
              {purchaseChannel === 'SELF' ? (
                <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                  <button
                    type="button"
                    onClick={() => setHasVat(true)}
                    className={`px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
                      hasVat ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    มี VAT 7%
                  </button>
                  <button
                    type="button"
                    onClick={() => setHasVat(false)}
                    className={`px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
                      !hasVat ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    ไม่มี VAT (0%)
                  </button>
                </div>
              ) : (
                <span className="text-[10px] font-semibold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-mono">
                  จัดซื้อออนไลน์
                </span>
              )}
            </div>

            {/* Financial Breakdown Items */}
            <div className="space-y-2 text-xs">
              <div className="flex justify-between items-center text-slate-600">
                <span>ยอดรวมสินค้า (Subtotal)</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  ฿{subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              {itemDiscountTotal > 0 && (
                <div className="flex justify-between items-center text-rose-600">
                  <span>ส่วนลดรายชิ้น</span>
                  <span className="font-mono font-semibold tabular-nums">
                    -฿{itemDiscountTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}

              {combinedDiscountAmount > 0 && (
                <div className="flex justify-between items-center text-rose-600">
                  <span>ส่วนลดท้ายบิล</span>
                  <span className="font-mono font-semibold tabular-nums">
                    -฿{combinedDiscountAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}

              {/* VAT Row (Directive 3) */}
              {purchaseChannel === 'SELF' && (
                <div className={`flex justify-between items-center pt-1 border-t border-slate-100 ${
                  hasVat ? 'text-indigo-700' : 'text-slate-400'
                }`}>
                  <span className="font-medium">
                    ภาษีมูลค่าเพิ่ม {hasVat ? '(VAT 7%)' : '(0%)'}
                  </span>
                  <span className="font-mono font-bold tabular-nums">
                    {hasVat 
                      ? `+฿${vatAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                      : '฿0.00'}
                  </span>
                </div>
              )}

              {/* Extra Costs: Shipping & Rounding (if set) */}
              {parseFloat(shippingCost) > 0 && (
                <div className="flex justify-between items-center text-slate-700">
                  <span>ค่าจัดส่ง</span>
                  <span className="font-mono font-semibold tabular-nums">
                    +฿{parseFloat(shippingCost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}

              {parseFloat(roundingAdj) !== 0 && (
                <div className="flex justify-between items-center text-amber-700">
                  <span>ปรับเศษทศนิยม</span>
                  <span className="font-mono font-semibold tabular-nums">
                    {parseFloat(roundingAdj) > 0 ? `+฿${parseFloat(roundingAdj).toFixed(2)}` : `-฿${Math.abs(parseFloat(roundingAdj)).toFixed(2)}`}
                  </span>
                </div>
              )}
            </div>

            {/* Clutter-Free Toggler for Shipping & Rounding & Order Discount (Directive 2) */}
            {purchaseChannel === 'SELF' && (
              <div className="pt-2 border-t border-slate-100">
                {!showExtraAdjustments ? (
                  <button
                    type="button"
                    onClick={() => setShowExtraAdjustments(true)}
                    className="w-full py-2 text-xs font-semibold text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/50 rounded-xl border border-dashed border-slate-200 hover:border-indigo-300 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>+ เพิ่มค่าส่ง / ส่วนลดท้ายบิล</span>
                  </button>
                ) : (
                  <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-200/80 space-y-2.5 animate-fade-in">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                        ส่วนลดท้ายบิล & ค่าจัดส่ง
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowExtraAdjustments(false)}
                        className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors"
                      >
                        ซ่อน
                      </button>
                    </div>

                    {/* Order Discount Input */}
                    <div className="flex items-center gap-1.5">
                      <div className="inline-flex p-0.5 bg-slate-200 rounded-lg text-[10px] shrink-0 font-semibold">
                        <button
                          type="button"
                          onClick={() => setCombinedDiscountType('percent')}
                          className={`px-1.5 py-0.5 rounded ${combinedDiscountType === 'percent' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600'}`}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          onClick={() => setCombinedDiscountType('fixed')}
                          className={`px-1.5 py-0.5 rounded ${combinedDiscountType === 'fixed' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600'}`}
                        >
                          ฿
                        </button>
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={combinedDiscountValue || ''}
                        onChange={e => setCombinedDiscountValue(e.target.value)}
                        placeholder="ส่วนลดท้ายบิล"
                        className="w-full h-8 bg-white border border-slate-300 rounded-lg px-2.5 text-right font-mono text-xs font-semibold text-slate-900 outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>

                    {/* Shipping Cost Input */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">ค่าจัดส่ง (฿)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={shippingCost || ''}
                        onChange={e => setShippingCost(e.target.value)}
                        placeholder="0.00"
                        className="w-24 h-8 bg-white border border-slate-300 rounded-lg px-2 text-right font-mono text-xs font-semibold text-slate-900 outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>

                    {/* Rounding Adjustment Input */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">ปรับเศษสตางค์ (฿)</span>
                      <input
                        type="number"
                        step="0.01"
                        value={roundingAdj || ''}
                        onChange={e => setRoundingAdj(e.target.value)}
                        placeholder="+/-0.00"
                        className="w-24 h-8 bg-white border border-slate-300 rounded-lg px-2 text-right font-mono text-xs font-semibold text-slate-900 outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Grand Total Display Box */}
            <div className="p-4 bg-slate-50 border border-slate-200/90 rounded-xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">ยอดรวมสุทธิ (Grand Total)</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                  purchaseChannel === 'SELF'
                    ? (hasVat 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                        : 'bg-slate-100 text-slate-600 border-slate-200')
                    : 'bg-purple-50 text-purple-700 border-purple-200'
                }`}>
                  {purchaseChannel === 'SELF'
                    ? (hasVat ? 'รวม VAT 7% แล้ว' : 'ไม่มี VAT')
                    : 'สุทธิ (ออนไลน์)'}
                </span>
              </div>
              <div className="text-right">
                <span className="text-2xl font-black font-mono text-indigo-600 tracking-tight tabular-nums">
                  ฿{grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Directive 1: Sidebar Grand Total Callout when requiresMemo */}
            {requiresMemo && (
              <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200/90 animate-fade-in">
                <div className="flex items-start gap-2.5">
                  <span className="text-base">📋</span>
                  <div className="flex-1">
                    <div className="text-xs font-bold text-amber-900 leading-tight">
                      ต้องแนบ Memo ผจก.โรงงาน
                    </div>
                    <p className="text-[11px] text-amber-700 mt-0.5 leading-snug">
                      ยอดคำนวณสุทธิแตะเกณฑ์ ฿20,000 ขึ้นไป
                    </p>
                    <button
                      type="button"
                      onClick={() => memoSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
                      className="mt-2 text-xs font-bold text-amber-900 bg-amber-200/60 hover:bg-amber-200 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <span>กรอกข้อมูล Memo</span>
                      <span>↓</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Box 2: Department Budget Usage Bar (Directive 1) */}
          {budgetInfo && (
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-slate-500" />
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    งบประมาณแผนก ({department})
                  </h4>
                </div>
                <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded-full ${
                  budgetInfo.isOverBudget 
                    ? 'bg-rose-50 text-rose-700 border border-rose-200' 
                    : 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                }`}>
                  {budgetInfo.projectedPercent}%
                </span>
              </div>

              {/* Multi-tier Progress Bar */}
              <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden flex">
                <div 
                  className="bg-slate-400 transition-all duration-500"
                  style={{ width: `${budgetInfo.currentPercent}%` }}
                  title={`ใช้ไปแล้ว: ฿${budgetInfo.spent.toLocaleString()}`}
                />
                <div 
                  className={`transition-all duration-500 ${budgetInfo.isOverBudget ? 'bg-rose-500' : 'bg-indigo-600'}`}
                  style={{ width: `${Math.max(0, budgetInfo.projectedPercent - budgetInfo.currentPercent)}%` }}
                  title={`PR ใบนี้: +฿${budgetInfo.prAmount.toLocaleString()}`}
                />
              </div>

              {/* Budget Metrics Breakdown */}
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between items-center text-slate-500">
                  <span>งบที่ได้รับจัดสรร</span>
                  <span className="font-mono font-medium text-slate-800">
                    ฿{budgetInfo.allocated.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between items-center text-slate-500">
                  <span>ใช้ไปแล้ว (Actual + Commit)</span>
                  <span className="font-mono font-medium text-slate-800">
                    ฿{budgetInfo.spent.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between items-center text-indigo-600 font-semibold">
                  <span>ใบนี้เพิ่ม (This PR)</span>
                  <span className="font-mono tabular-nums">
                    +฿{budgetInfo.prAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between items-center pt-1.5 border-t border-slate-100">
                  <span className={`font-semibold ${budgetInfo.isOverBudget ? 'text-rose-600' : 'text-slate-700'}`}>
                    {budgetInfo.isOverBudget ? 'เกินงบประมาณ' : 'งบประมาณคงเหลือ'}
                  </span>
                  <span className={`font-mono font-bold tabular-nums ${budgetInfo.isOverBudget ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {budgetInfo.isOverBudget ? '-' : ''}฿{Math.abs(budgetInfo.remaining).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Box 3: Main Action Buttons (Directive 4) */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-3">
            {/* Vendor validation warning */}
            {isMissingVendor && (
              <div className="p-2.5 bg-rose-50 border border-rose-200/80 rounded-xl text-center">
                <p className="text-[11px] text-rose-600 font-semibold flex items-center justify-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>* กรุณาระบุผู้จัดจำหน่าย (Vendor) ที่หัวเอกสาร</span>
                </p>
              </div>
            )}

            {/* Primary Submit Button (Directive 4) */}
            <button
              type="button"
              disabled={isSubmitting || isMissingVendor}
              onClick={(e) => handleCreateSubmit(e, false)}
              className={`h-11 w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs hover:shadow-sm active:scale-98 transition-all flex items-center justify-center gap-2 cursor-pointer ${
                isSubmitting || isMissingVendor ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
              }`}
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>
                {isSubmitting 
                  ? 'กำลังประมวลผล...' 
                  : (editingPR ? 'บันทึกและส่งใบ PR ใหม่ (Resubmit)' : 'ส่งใบ PR เข้าสู่ระบบ')}
              </span>
            </button>

            {/* Save Draft Button */}
            <button
              type="button"
              disabled={isSubmitting}
              onClick={(e) => handleCreateSubmit(e, true)}
              className={`h-10 w-full rounded-xl font-semibold text-xs text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 shadow-2xs hover:shadow-xs transition-all cursor-pointer ${
                isSubmitting ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
              }`}
            >
              {editingPR ? 'บันทึกแบบร่าง (Save Draft)' : 'บันทึกแบบร่าง (Draft)'}
            </button>

            {/* Cancel / Back Link (Directive 4: comfortable bottom spacing) */}
            <div className="pt-1.5 pb-0.5">
              <button
                type="button"
                onClick={handleCancelAndBack}
                className="w-full py-2 text-xs text-slate-400 hover:text-slate-600 transition-colors text-center cursor-pointer font-medium"
              >
                ยกเลิกและย้อนกลับ
              </button>
            </div>
          </div>

        </div>

      </form>

      {/* Gen-Z SaaS Lightbox Image Preview Modal */}
      {previewImage && (
        <div 
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setPreviewImage(null)}
        >
          <div 
            className="relative max-w-2xl max-h-[85vh] bg-white rounded-2xl overflow-hidden shadow-2xl p-3 border border-white/20 animate-scale-up"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 mb-2 px-1">
              {getDriveFileViewUrl(previewImage) ? (
                <a
                  href={getDriveFileViewUrl(previewImage)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span>เปิดดูใน Google Drive</span>
                </a>
              ) : <div />}
              <button 
                type="button"
                onClick={() => setPreviewImage(null)}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center font-bold text-sm shadow-xs transition-colors cursor-pointer"
                title="ปิดหน้าต่าง"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center justify-center overflow-auto max-h-[75vh] rounded-xl bg-slate-100">
              <img 
                src={resolveDriveImageUrl(previewImage, 'w1600')} 
                alt="Product preview" 
                className="max-w-full max-h-[73vh] object-contain rounded-lg"
                onError={(e) => handleDriveImageError(e, previewImage)}
              />
            </div>
            {previewImage.name && (
              <p className="text-center text-xs font-semibold text-slate-600 mt-2 px-4 py-1 truncate">
                {previewImage.name}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Success Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
          <div className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-emerald-100 p-6 sm:p-7 text-center space-y-4 animate-scale-in">
            <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-200 flex items-center justify-center mx-auto shadow-sm">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                {successModalInfo.title || 'ดำเนินการสำเร็จ'}
              </h3>
              <p className="text-xs sm:text-sm text-slate-500 mt-1">
                {successModalInfo.message || 'สร้างและยื่นส่งใบขอซื้อ (PR) สำเร็จ'}
              </p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                id="pr-create-success-modal-btn"
                onClick={handleCloseSuccessModal}
                className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm rounded-xl shadow transition-all cursor-pointer active:scale-98"
              >
                ตกลง
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
