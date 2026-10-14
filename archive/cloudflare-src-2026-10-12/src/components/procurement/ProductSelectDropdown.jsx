import React, { useMemo } from 'react';
import SearchableSelect from '../common/SearchableSelect';
import { getUnifiedProductList } from '../../views/PRCreateView';
import { safeStringCompare } from '../../utils/formatters';
import { isDepartmentMatch } from '../../utils/permissions';

/**
 * ProductSelectDropdown - Modern Searchable Dropdown for Products in Procurement (PR/PO)
 * Incorporates getUnifiedProductList deduplication pipe and React key collision protection.
 */
export default function ProductSelectDropdown({
  products = [],
  inventory = [],
  department,
  value,
  onChange,
  placeholder = '-- ค้นหาหรือเลือกสินค้า --',
  searchPlaceholder = 'ค้นหารหัส หรือชื่อสินค้า...',
  emptyMessage = 'ไม่พบรายการสินค้า',
  className = 'w-full h-10',
  buttonClassName = '!h-10 !min-h-[40px] !px-3 !rounded-xl !bg-white hover:!border-slate-300 !border-slate-200 !text-xs sm:!text-sm !font-medium',
  required = false,
  deptMap = {},
  disabled = false,
  ...props
}) {
  // 1. Deduplicate & Merge Master Data and Inventory
  const unifiedProducts = useMemo(() => {
    const rawList = getUnifiedProductList(products, inventory);
    if (!department || department === 'ALL') return rawList;
    return rawList.filter(p => {
      const pDept = (p.department || p.category || '').toUpperCase();
      return !pDept || pDept === 'ALL' || isDepartmentMatch(pDept, department);
    }).sort((a, b) => safeStringCompare(a?.code, b?.code));
  }, [products, inventory, department]);

  // 2. Transform into options with unique collision-safe keys
  const options = useMemo(() => {
    return unifiedProducts.map((p, index) => {
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
  }, [unifiedProducts, deptMap]);

  return (
    <SearchableSelect
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      className={className}
      buttonClassName={buttonClassName}
      required={required}
      disabled={disabled}
      showCodeBadgeInTrigger={false}
      {...props}
    />
  );
}

export { getUnifiedProductList };
