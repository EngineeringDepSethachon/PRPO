import React, { useState, useMemo } from 'react';
import KPICards from '../components/dashboard/KPICards';
import DashboardSkeleton from '../components/dashboard/DashboardSkeleton';
import { matchDepartment } from '../utils/permissions';

export default function DashboardView({
  prs = [],
  pos = [],
  products = [],
  budgetSummary,
  currentRole,
  currentUser,
  onNavigate,
  onQuickPR,
  onOpenPR,
  onOpenPO,
  isLoading = false,
  initialDeptFilter,
  deptFilter,
  onDeptFilterChange
}) {

  const effectiveUser = currentUser || currentRole;

  // 1. ตรวจสอบแผนกและสิทธิ์ของผู้ใช้งาน (Department Scoping & Multi-Dept Detection)
  const userDepts = useMemo(() => {
    const rawDepts = effectiveUser?.departments || effectiveUser?.assignedDepartments;
    if (Array.isArray(rawDepts) && rawDepts.length > 0) {
      return rawDepts;
    }
    return effectiveUser?.department ? [effectiveUser.department] : ['PD'];
  }, [effectiveUser]);

  const userRoleStr = String(effectiveUser?.role || effectiveUser?.roleId || '').toUpperCase();
  const isMultiDeptUser = useMemo(() => {
    return (
      userDepts.length > 1 ||
      ['ADMIN', 'ASST_MANAGER', 'PLANT_MANAGER', 'MANAGER'].includes(userRoleStr) ||
      userDepts.includes('ALL') ||
      userDepts.includes('BOTH') ||
      userDepts.includes('*') ||
      Boolean(effectiveUser?.canViewAllDepts)
    );
  }, [userDepts, userRoleStr, effectiveUser]);

  // กำหนดค่าเริ่มต้นตัวกรองแผนก (ผู้บริหาร/Multi-Dept เริ่มที่ 'ALL', ผู้ใช้แผนกเดียวเริ่มที่แผนกตนเอง)
  const defaultDept = initialDeptFilter || (isMultiDeptUser ? 'ALL' : (effectiveUser?.department || userDepts[0] || 'PD'));
  const [internalDeptFilter, setInternalDeptFilter] = useState(defaultDept);
  const dashboardDeptFilter = deptFilter !== undefined ? deptFilter : internalDeptFilter;
  const setDashboardDeptFilter = (newDept) => {
    setInternalDeptFilter(newDept);
    onDeptFilterChange?.(newDept);
  };

  // 2. Data Normalization & Master Lookup สำหรับ Low Stock Items
  const allNormalizedLowStock = useMemo(() => {
    // Flatten any nested arrays or wrapper structures
    const flatList = (products || [])
      .flatMap((p) => (Array.isArray(p) ? p : [p]))
      .filter((p) => p && typeof p === 'object');

    // สกัดค่าตาม Data Schema จริงและรองรับ Property ซ้อน (p.product, p.item, p.inventory)
    const normalized = flatList.map((p) => {
      const actualItem = p.product || p.item || p.inventory || p;
      if (!actualItem || typeof actualItem !== 'object') return null;

      // ค้นหา Master Data หากมี ID หรือ SKU ตรงกัน
      const master = flatList.find(
        (m) =>
          m &&
          m !== actualItem &&
          ((m.id && (m.id === actualItem.id || m.id === actualItem.itemId)) ||
            (m.sku && (m.sku === actualItem.sku || m.sku === actualItem.code)) ||
            (m.code && (m.code === actualItem.code || m.code === actualItem.sku)))
      );

      const resolvedName =
        actualItem.name || actualItem.itemName || actualItem.nameTh || actualItem.title || master?.name || master?.itemName;
      const resolvedSku =
        actualItem.sku || actualItem.code || actualItem.itemCode || master?.sku || master?.code || actualItem.id || '-';
      const currentStock = Number(
        actualItem.currentStock ??
          actualItem.stockBalance ??
          actualItem.stock ??
          actualItem.balance ??
          actualItem.qty ??
          master?.currentStock ??
          master?.stockBalance ??
          0
      );
      const rop = Number(
        actualItem.rop ??
          actualItem.reorderPoint ??
          actualItem.minStock ??
          master?.rop ??
          master?.reorderPoint ??
          0
      );
      const unit = actualItem.unit || actualItem.stockUnit || actualItem.purchaseUnit || master?.unit || 'ชิ้น';
      const rawDept = actualItem.department || actualItem.category || actualItem.dept || master?.department || master?.category || 'PD';
      const department = String(rawDept).replace(/^DEPT-/, '').trim().toUpperCase() || 'PD';
      const price = Number(actualItem.price ?? master?.price ?? 0);
      const isInactive =
        actualItem.isActive === false ||
        String(actualItem.isActive).toUpperCase() === 'FALSE' ||
        String(actualItem.status || '').toUpperCase() === 'INACTIVE';

      return {
        id: actualItem.id || master?.id || `prod-${Math.random()}`,
        name: resolvedName,
        sku: String(resolvedSku).trim(),
        code: String(resolvedSku).trim(),
        stock: currentStock,
        currentStock,
        rop,
        reorderPoint: rop,
        unit,
        department,
        category: department,
        price,
        isInactive
      };
    });

    return normalized.filter(
      (item) =>
        item &&
        !item.isInactive &&
        Boolean(item.name && item.name !== 'สินค้าไม่มีชื่อ') &&
        item.rop > 0 &&
        item.stock <= item.rop
    );
  }, [products]);

  // กรองรายการสินค้า ROP (Department Scoping & Multi-Dept Filter)
  const lowStockItems = useMemo(() => {
    return allNormalizedLowStock.filter((item) => {
      const pDept = item.department || item.category;

      if (isMultiDeptUser) {
        if (dashboardDeptFilter === 'ALL') {
          // If user has specific multiple departments (not universal admin), ensure product matches one of user's departments
          if (
            userDepts.includes('ALL') ||
            userDepts.includes('BOTH') ||
            userDepts.includes('*') ||
            ['ADMIN', 'PLANT_MANAGER'].includes(userRoleStr)
          ) {
            return true;
          }
          return userDepts.some((d) => matchDepartment(pDept, d));
        }
        return matchDepartment(pDept, dashboardDeptFilter);
      } else {
        // Single department user (e.g. PD Operator): strictly scoped to own department
        const primaryDept = effectiveUser?.department || userDepts[0] || 'PD';
        return matchDepartment(pDept, primaryDept);
      }
    });
  }, [allNormalizedLowStock, isMultiDeptUser, dashboardDeptFilter, userDepts, userRoleStr, effectiveUser]);

  // Department tabs definition
  const deptTabs = useMemo(() => [
    { id: 'ALL', label: 'ทั้งหมด' },
    { id: 'PD', label: 'ฝ่ายผลิต (PD)' },
    { id: 'QC', label: 'ฝ่ายควบคุมคุณภาพ (QC)' }
  ], []);

  // Interaction: เปิดหน้า Create PR พร้อมพรีฟิลเฉพาะสินค้ารายการนั้น และส่ง department ไปด้วย
  const handleSingleQuickPR = (item) => {
    const payload = {
      id: item.id,
      code: item.sku,
      sku: item.sku,
      name: item.name,
      department: item.department || 'PD',
      category: item.department || 'PD',
      reorderPoint: item.rop,
      rop: item.rop,
      currentStock: item.stock,
      stockBalance: item.stock,
      unit: item.unit,
      price: item.price || 0
    };
    if (onQuickPR) {
      onQuickPR(payload);
    } else if (onNavigate) {
      onNavigate('pr-create', { prefillProduct: payload, department: payload.department });
    }
  };

  // Interaction: เปิดหน้า Create PR พร้อมรวบสินค้าที่แตะ ROP ทั้งหมดใส่ลงในตารางคำขอซื้อให้ในทันที
  const handleBatchQuickPR = () => {
    if (!lowStockItems || lowStockItems.length === 0) return;
    const batchPayload = lowStockItems.map((item) => ({
      id: item.id,
      code: item.sku,
      sku: item.sku,
      name: item.name,
      department: item.department || 'PD',
      category: item.department || 'PD',
      reorderPoint: item.rop,
      rop: item.rop,
      currentStock: item.stock,
      stockBalance: item.stock,
      unit: item.unit,
      price: item.price || 0
    }));
    if (onQuickPR) {
      onQuickPR(batchPayload);
    } else if (onNavigate) {
      onNavigate('pr-create', { prefillProduct: batchPayload, department: batchPayload[0]?.department });
    }
  };

  // If loading and no products or documents loaded yet, show non-blocking skeleton immediately
  if (isLoading && products.length === 0 && prs.length === 0 && pos.length === 0) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5 animate-fade-in pb-12">
      {/* 1. TOP KPI RIBBON (4 คอลัมน์) */}
      <KPICards
        prs={prs}
        pos={pos}
        products={products}
        budgetSummary={budgetSummary}
        currentRole={effectiveUser}
        onNavigate={onNavigate}
        onQuickPR={onQuickPR}
        lowStockCount={lowStockItems.length}
        lowStockItems={lowStockItems}
        activeDept={dashboardDeptFilter}
      />

      {/* 2. MAIN BENTO WORKSPACE (Full Width Low Stock Alert) */}
      <div className="mt-5 bg-white rounded-2xl border border-rose-200/80 shadow-xs overflow-hidden">
        {/* Header Bar with Department Filter Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:p-5 border-b border-rose-100 bg-linear-to-r from-rose-50/50 to-white gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shadow-2xs border border-rose-200/60 shrink-0">
               <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse"></span>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm sm:text-base font-bold text-rose-900 tracking-tight">สินค้าใกล้หมด / แจ้งเตือน ROP</h3>
                {!isMultiDeptUser && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border ${
                    matchDepartment(effectiveUser?.department, 'QC')
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-blue-50 text-blue-700 border-blue-200'
                  }`}>
                    {matchDepartment(effectiveUser?.department, 'QC') ? 'ฝ่ายควบคุมคุณภาพ (QC)' : 'ฝ่ายผลิต (PD)'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">สินค้าที่ระดับสต็อกคงเหลือต่ำกว่าหรือเท่ากับจุดสั่งซื้อซ้ำ</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
            {/* Multi-Dept Switcher Tabs */}
            {isMultiDeptUser && (
              <div className="flex items-center gap-1 bg-slate-100/90 p-1 rounded-xl border border-slate-200/70 shrink-0 overflow-x-auto">
                {deptTabs.map(tab => {
                  const isSelected = dashboardDeptFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setDashboardDeptFilter(tab.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                        isSelected
                          ? tab.id === 'PD' 
                            ? 'bg-blue-600 text-white shadow-xs' 
                            : tab.id === 'QC' 
                              ? 'bg-amber-600 text-white shadow-xs' 
                              : 'bg-white text-slate-800 shadow-xs border border-slate-200/60'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            )}

            {lowStockItems.length > 0 && (
              <button
                type="button"
                onClick={handleBatchQuickPR}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white text-xs font-bold rounded-xl shadow-xs transition-all flex items-center gap-2 shrink-0 cursor-pointer"
              >
                <span>⚡ ขอซื้อทั้งหมด ({lowStockItems.length})</span>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        {lowStockItems.length === 0 ? (
          <div className="py-16 px-6 text-center text-slate-500 flex flex-col items-center justify-center gap-3 bg-slate-50/30">
            <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shadow-2xs">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800">
                {dashboardDeptFilter === 'PD'
                  ? 'ระดับสต็อกสินค้าฝ่ายผลิต (PD) ทุกรายการอยู่ในเกณฑ์ปกติ'
                  : dashboardDeptFilter === 'QC'
                    ? 'ระดับสต็อกสินค้าฝ่ายควบคุมคุณภาพ (QC) ทุกรายการอยู่ในเกณฑ์ปกติ'
                    : 'ระดับสต็อกสินค้าทุกรายการอยู่ในเกณฑ์ปกติ'}
              </p>
              <p className="text-xs text-slate-400 mt-1">ไม่มีสินค้าที่ต้องสั่งซื้อซ้ำในขณะนี้</p>
            </div>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[800px] text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200/80">
                  <th className="px-5 py-3.5 w-[42%]">รหัส / ชื่อสินค้า</th>
                  <th className="px-5 py-3.5 w-[18%] text-right">คงเหลือ</th>
                  <th className="px-5 py-3.5 w-[20%] text-right">จุดสั่งซื้อซ้ำ (ROP)</th>
                  <th className="px-5 py-3.5 w-[20%] text-center">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lowStockItems.map((item) => (
                  <tr key={item.sku || item.id} className="hover:bg-rose-50/30 transition-colors">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-800">{item.name || 'สินค้าไม่มีชื่อ'}</span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border ${
                          matchDepartment(item.department, 'PD')
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : matchDepartment(item.department, 'QC')
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}>
                          {matchDepartment(item.department, 'PD') ? 'ฝ่ายผลิต (PD)' : (matchDepartment(item.department, 'QC') ? 'ฝ่ายควบคุมคุณภาพ (QC)' : `ฝ่าย ${item.department}`)}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">{item.sku || item.code || '-'}</div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-rose-600 font-bold tabular-nums text-sm">
                        {Number(item.currentStock ?? item.stock ?? 0).toLocaleString()}
                      </span>
                      <span className="text-xs text-slate-500 ml-1.5">{item.unit || 'ชิ้น'}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="text-slate-700 font-bold tabular-nums text-sm">
                        {Number(item.rop ?? item.reorderPoint ?? 0).toLocaleString()}
                      </span>
                      <span className="text-xs text-slate-500 ml-1.5">{item.unit || 'ชิ้น'}</span>
                    </td>
                    <td className="px-5 py-4 text-center">
                      <button
                        type="button"
                        onClick={() => handleSingleQuickPR(item)}
                        className="inline-flex items-center justify-center px-4 py-2 bg-white hover:bg-rose-50 text-slate-700 hover:text-rose-700 border border-slate-200 hover:border-rose-200 text-xs font-bold rounded-xl shadow-2xs transition-all cursor-pointer"
                      >
                        + เปิดใบขอซื้อ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
