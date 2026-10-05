import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Database, Plus, Edit3, Trash2, Building2, Search, X, MapPin, Boxes, DoorClosed, UserCheck, RotateCcw, Shield } from 'lucide-react';
import ProductCRUDModal from '../components/admin/ProductCRUDModal';
import DeactivateItemModal from '../components/admin/DeactivateItemModal';
import VendorCRUDModal from '../components/admin/VendorCRUDModal';
import StorageLocationCRUDModal from '../components/admin/StorageLocationCRUDModal';
import DeleteLocationModal from '../components/admin/DeleteLocationModal';
import UsageUnitCRUDModal from '../components/admin/UsageUnitCRUDModal';
import DepartmentCRUDModal from '../components/admin/DepartmentCRUDModal';
import UserCRUDModal from '../components/admin/UserCRUDModal';
import UserMasterView from './admin/UserMasterView';
import MasterDataNav, { MASTER_DATA_TABS, normalizeTabId, isTabActive } from '../components/master/MasterDataNav';
import { storageService } from '../services/storageService';
import { apiService } from '../services/apiService';
import { modalService } from '../services/modalService';
import { useAppContext } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import Pagination from '../components/common/Pagination';
import { getUserDepartments, canAccessDepartmentData, isDepartmentMatch, matchDepartment } from '../utils/permissions';

export { MASTER_DATA_TABS, normalizeTabId, isTabActive, isDepartmentMatch, matchDepartment };

// ── Permanent Blacklist Guard against Test / Mock Artifacts ──
export const DUMMY_BLACKLIST = new Set(['P01', 'P02', 'PROD-01', 'PROD-02']);
export const isBlacklistedProduct = (item) => {
  if (!item) return false;
  const actual = item.product || item.item || item;
  const code = String(actual.code || actual.id || '').trim().toUpperCase();
  const id = String(actual.id || '').trim().toUpperCase();
  const name = String(actual.name || actual.itemName || actual.title || '').trim().toLowerCase();
  return DUMMY_BLACKLIST.has(code) || DUMMY_BLACKLIST.has(id) || name === 'item 1' || name === 'item 2';
};

// ฟังก์ชันตัดของซ้ำ (Deduplication Guard) พร้อม Blacklist Guard
export const deduplicateMasterData = (list = []) => {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach(item => {
    if (!item) return;
    const actual = item.product || item.item || item;
    if (isBlacklistedProduct(actual)) return;
    const dept = String(actual.department || actual.category || actual.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
    const code = String(actual.code || actual.sku || actual.vendorCode || '').trim().toUpperCase();
    const id = String(actual.id || '').trim().toUpperCase();
    const uniqueKey = id ? id : (code ? `${dept}_${code}` : Math.random());
    if (uniqueKey && !map.has(uniqueKey)) {
      map.set(uniqueKey, actual);
    }
  });
  return Array.from(map.values());
};

export default function MasterDataView(props) {
  return <MasterDataContent {...props} />;
}

function MasterDataContent({
  products: initialProductsList = [],
  vendors: initialVendorsList = [],
  storageLocations: initialLocations = [],
  usageUnits: initialUnits = [],
  departments: initialDepartments = [],
  users: initialUsers = [],
  prs: initialPRs = [],
  pos: initialPOs = [],
  currentRole,
  currentUser,
  onRefresh,
  onDeleteProduct,
  onSaveProduct,
  onDeleteVendor,
  onSaveVendor,
  _onSaveUsageUnit,
  onDeleteUsageUnit,
  onSaveDepartment,
  onDeleteDepartment,
  onSaveUser,
  onDeleteUser
}) {
  let context = null;
  try {
    context = useAppContext();
  } catch {
    context = null;
  }

  let auth = null;
  try {
    auth = useAuth();
  } catch {
    auth = null;
  }

  let searchParams, setSearchParams;
  try {
    [searchParams, setSearchParams] = useSearchParams();
  } catch {
    searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
    setSearchParams = () => {};
  }

  // Role and Admin evaluation defined right at top to eliminate Temporal Dead Zone (TDZ)
  const effectiveRole = currentRole || context?.currentRole || auth?.currentRole;
  const effectiveUser = currentUser || context?.currentUser || auth?.currentUser;
  const targetUserObj = effectiveUser || effectiveRole;
  const userDepts = getUserDepartments(targetUserObj);
  const isAdmin = Boolean(
    auth?.canonicalRole === 'ADMIN' ||
    (auth?.hasRole && auth.hasRole('ADMIN')) ||
    effectiveUser?.canonicalRole === 'ADMIN' ||
    effectiveRole?.canonicalRole === 'ADMIN' ||
    effectiveRole?.id === 'ADMIN' ||
    effectiveRole?.roleId === 'ADMIN' ||
    effectiveRole?.role === 'admin' ||
    effectiveUser?.role === 'admin' ||
    effectiveUser?.roleId === 'ADMIN' ||
    effectiveUser?.isAdmin === true ||
    Number(effectiveRole?.level) >= 99 ||
    Number(effectiveUser?.level) >= 99
  );
  const canSeeAll = Boolean(isAdmin || effectiveRole?.canViewAllDepts);
  const _myDept = effectiveRole?.department;
  const isReviewer = Boolean(
    auth?.canonicalRole === 'REVIEWER' ||
    effectiveRole?.canonicalRole === 'REVIEWER' ||
    effectiveUser?.canonicalRole === 'REVIEWER' ||
    effectiveRole?.roleId === 'ASST_MANAGER' ||
    effectiveRole?.roleId === 'REVIEWER' ||
    effectiveRole?.positionKey === 'REVIEWER'
  );
  const canDeleteMaster = Boolean(
    isAdmin ||
    isReviewer ||
    effectiveRole?.canDeleteMaster ||
    effectiveUser?.canDeleteMaster ||
    effectiveRole?.canManageMaster ||
    effectiveUser?.canManageMaster ||
    Number(effectiveRole?.level) >= 2 ||
    Number(effectiveUser?.level) >= 2
  );

  // Tab Resolution & Defensive Fallback
  const resolveTab = useCallback((targetTab, adminFlag) => {
    const norm = normalizeTabId(targetTab);
    const tabDef = MASTER_DATA_TABS.find(t => t.id === norm);
    if (tabDef?.adminOnly && !adminFlag) {
      return 'catalog';
    }
    return norm;
  }, []);

  const queryTab = searchParams?.get('tab') || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null);

  const [activeTab, setActiveTabState] = useState(() => {
    return resolveTab(queryTab || 'products', isAdmin);
  });

  const setActiveTab = useCallback((nextTab) => {
    const resolved = resolveTab(nextTab, isAdmin);
    setActiveTabState(resolved);
    try {
      if (setSearchParams) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('tab', resolved);
          return next;
        }, { replace: true });
      }
    } catch {}
  }, [isAdmin, resolveTab, setSearchParams]);

  // 1. Initial URL Sync & Role Validation
  useEffect(() => {
    const rawTab = searchParams?.get('tab') || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null);
    const initialTab = rawTab ? normalizeTabId(rawTab) : 'products';
    const resolved = resolveTab(initialTab, isAdmin);
    setActiveTabState(resolved);
    try {
      if (setSearchParams && resolved !== initialTab) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('tab', resolved);
          return next;
        }, { replace: true });
      }
    } catch {}
  }, [isAdmin, resolveTab, setSearchParams]);

  // Defensive Tab Fallback: if non-admin user lands on or attempts to navigate to users or departments
  useEffect(() => {
    const norm = normalizeTabId(activeTab);
    const resolved = resolveTab(norm, isAdmin);
    if (resolved !== norm) {
      setActiveTabState(resolved);
      try {
        if (setSearchParams) {
          setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('tab', resolved);
            return next;
          }, { replace: true });
        }
      } catch {}
    }
  }, [activeTab, isAdmin, resolveTab, setSearchParams]);

  // Defensive fallback if URL query param is tampered to ?tab=users or ?tab=departments by non-admin
  useEffect(() => {
    const currentQuery = searchParams?.get('tab') || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null);
    if (currentQuery) {
      const resolved = resolveTab(currentQuery, isAdmin);
      if (normalizeTabId(activeTab) !== resolved) {
        setActiveTabState(resolved);
      }
      if (currentQuery !== resolved) {
        try {
          if (setSearchParams) {
            setSearchParams(prev => {
              const next = new URLSearchParams(prev);
              next.set('tab', resolved);
              return next;
            }, { replace: true });
          }
        } catch {}
      }
    }
  }, [searchParams, isAdmin, resolveTab, activeTab, setSearchParams]);
  const [showProdModal, setShowProdModal] = useState(false);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [showUsageUnitModal, setShowUsageUnitModal] = useState(false);
  const [showDeptModal, setShowDeptModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editProd, setEditProd] = useState(null);
  const [editVendor, setEditVendor] = useState(null);
  const [editLocation, setEditLocation] = useState(null);
  const [editUsageUnit, setEditUsageUnit] = useState(null);
  const [editDept, setEditDept] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [deleteLocationItem, setDeleteLocationItem] = useState(null);
  const [deactivateItem, setDeactivateItem] = useState(null); // { product, reasons }
  const [isDeactivating, setIsDeactivating] = useState(false);

  // Dedicated React State for Products & Vendors to guarantee immediate UI mutation
  const [productsList, setProductsList] = useState(() => {
    const raw = (initialProductsList && initialProductsList.length > 0)
      ? initialProductsList
      : (storageService.getProducts?.() || []);
    return deduplicateMasterData(raw);
  });
  const [vendorsList, setVendorsList] = useState(() => {
    if (initialVendorsList && initialVendorsList.length > 0) return initialVendorsList;
    return storageService.getVendors?.() || [];
  });

  const [locsList, setLocsList] = useState(() => {
    if (initialLocations && initialLocations.length > 0) return initialLocations;
    return storageService.getStorageLocations?.() || [];
  });
  const [unitsList, setUnitsList] = useState(() => {
    if (initialUnits && initialUnits.length > 0) return initialUnits;
    return storageService.getUsageUnits?.() || [];
  });
  const [departmentsList, setDepartmentsList] = useState(() => {
    if (initialDepartments && initialDepartments.length > 0) return initialDepartments;
    return storageService.getDepartments?.() || [];
  });
  const [usersList, setUsersList] = useState(() => {
    if (initialUsers && initialUsers.length > 0) return initialUsers;
    return storageService.getUsers?.() || [];
  });

  // Keep state in sync with props while strictly deduplicating
  useEffect(() => {
    const raw = (initialProductsList && initialProductsList.length > 0)
      ? initialProductsList
      : (storageService.getProducts?.() || []);
    setProductsList(deduplicateMasterData(raw));
  }, [initialProductsList]);

  // Auto-Cleanup Migration on Mount: Detect duplicate or blacklisted items and auto-sanitize storage
  useEffect(() => {
    const stored = storageService.getProducts?.() || [];
    const dedupedStored = deduplicateMasterData(stored);

    const hasBlacklisted = stored.some(p => isBlacklistedProduct(p));
    const hasDuplicateProd01 = stored.filter(p => {
      const k = String(p?.code || p?.id || '').trim().toUpperCase();
      return k === 'PROD-01' || k === 'P01';
    }).length > 0;

    const hasDuplicateProd02 = stored.filter(p => {
      const k = String(p?.code || p?.id || '').trim().toUpperCase();
      return k === 'PROD-02' || k === 'P02';
    }).length > 0;

    const hasIssues = stored.length !== dedupedStored.length || hasBlacklisted || hasDuplicateProd01 || hasDuplicateProd02;

    if (hasIssues) {
      console.warn('[MasterDataView] Blacklisted/duplicate items detected. Running auto-cleanup migration...');
      storageService.saveProducts(dedupedStored);
      setProductsList(dedupedStored);
      try {
        fetch('/api/products/batch', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dedupedStored)
        }).catch(() => {});
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (initialVendorsList && initialVendorsList.length > 0) {
      setVendorsList(initialVendorsList);
    } else {
      setVendorsList(storageService.getVendors?.() || []);
    }
  }, [initialVendorsList]);

  useEffect(() => {
    if (initialUsers && initialUsers.length > 0) {
      setUsersList(initialUsers);
    } else {
      setUsersList(storageService.getUsers?.() || []);
    }
  }, [initialUsers]);

  useEffect(() => {
    if (initialUnits && initialUnits.length > 0) {
      setUnitsList(initialUnits);
    } else {
      setUnitsList(storageService.getUsageUnits?.() || []);
    }
  }, [initialUnits]);

  useEffect(() => {
    if (initialLocations && initialLocations.length > 0) {
      setLocsList(initialLocations);
    } else {
      setLocsList(storageService.getStorageLocations?.() || []);
    }
  }, [initialLocations, productsList]);

  useEffect(() => {
    if (initialDepartments && initialDepartments.length > 0) {
      setDepartmentsList(initialDepartments);
    } else {
      setDepartmentsList(storageService.getDepartments?.() || []);
    }
  }, [initialDepartments]);

  // Department Scoping:
  // Requesters and department-restricted users default and lock to their assigned department (e.g. 'PD')
  // Admin and unrestricted cross-dept roles retain full visibility ('ALL' / 'ทุกแผนก')
  const isDeptRestricted = !isAdmin && !canSeeAll && userDepts.length > 0 && !userDepts.includes('ALL') && !userDepts.includes('*');
  const userPrimaryDept = userDepts[0] || effectiveUser?.department || 'PD';
  const initialDeptFilter = isDeptRestricted ? userPrimaryDept : 'ALL';

  const [prodSearch, setProdSearch] = useState('');
  const [prodCategoryFilter, setProdCategoryFilter] = useState(initialDeptFilter);
  const [prodStatusFilter, setProdStatusFilter] = useState('ACTIVE'); // 'ACTIVE' | 'ALL' | 'INACTIVE'
  const [vendorSearch, setVendorSearch] = useState('');
  const [vendorDeptFilter, setVendorDeptFilter] = useState(initialDeptFilter);
  const [locSearch, setLocSearch] = useState('');
  const [locDeptFilter, setLocDeptFilter] = useState(initialDeptFilter);
  const [unitSearch, setUnitSearch] = useState('');
  const [unitDeptFilter, setUnitDeptFilter] = useState(initialDeptFilter);

  const prevUserIdRef = useRef(targetUserObj?.id);
  // Sync department filters ONLY when active user identity actually switches
  useEffect(() => {
    if (prevUserIdRef.current !== targetUserObj?.id) {
      prevUserIdRef.current = targetUserObj?.id;
      const nextDefault = isDeptRestricted ? userPrimaryDept : 'ALL';
      setProdCategoryFilter(nextDefault);
      setVendorDeptFilter(nextDefault);
      setLocDeptFilter(nextDefault);
      setUnitDeptFilter(nextDefault);
    }
  }, [targetUserObj?.id, isDeptRestricted, userPrimaryDept]);
  const [deptSearch, setDeptSearch] = useState('');
  const [deptStatusFilter, setDeptStatusFilter] = useState('ALL');
  const [userSearch, _setUserSearch] = useState('');
  const [userDeptFilter, _setUserDeptFilter] = useState('ALL');
  const [userRoleFilter, _setUserRoleFilter] = useState('ALL');

  // Pagination states
  const [prodPage, setProdPage] = useState(1);
  const [prodPageSize, setProdPageSize] = useState(10);
  const [vendorPage, setVendorPage] = useState(1);
  const [vendorPageSize, setVendorPageSize] = useState(10);
  const [locPage, setLocPage] = useState(1);
  const [locPageSize, _setLocPageSize] = useState(10);
  const [unitPage, setUnitPage] = useState(1);
  const [unitPageSize, _setUnitPageSize] = useState(10);
  const [deptPage, setDeptPage] = useState(1);
  const [deptPageSize, _setDeptPageSize] = useState(10);
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, _setUserPageSize] = useState(10);

  // Auto-resets on filter/search change
  useEffect(() => { setProdPage(1); }, [prodCategoryFilter, prodStatusFilter, prodSearch, prodPageSize]);
  useEffect(() => { setVendorPage(1); }, [vendorDeptFilter, vendorSearch, vendorPageSize]);
  useEffect(() => { setLocPage(1); }, [locDeptFilter, locSearch, locPageSize]);
  useEffect(() => { setUnitPage(1); }, [unitDeptFilter, unitSearch, unitPageSize]);
  useEffect(() => { setDeptPage(1); }, [deptStatusFilter, deptSearch, deptPageSize]);
  useEffect(() => { setUserPage(1); }, [userDeptFilter, userRoleFilter, userSearch, userPageSize]);

  // Safety fallback: if non-admin user lands on restricted tabs, redirect to 'products'
  useEffect(() => {
    if (!isAdmin && (activeTab === 'users' || activeTab === 'departments')) {
      setActiveTab('products');
    }
  }, [isAdmin, activeTab]);

  // Status counts for Toolbar badges
  const prodStatusCounts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    productsList.forEach(p => {
      const itemDept = p.department || p.category;
      const matchesDeptRole = canAccessDepartmentData(targetUserObj, itemDept);
      const matchesCategory = matchDepartment(itemDept, prodCategoryFilter);
      if (matchesDeptRole && matchesCategory) {
        const isItemInactive = p.isActive === false || String(p.isActive).toUpperCase() === 'FALSE' || String(p.status || '').toUpperCase() === 'INACTIVE';
        const isItemActive = (p.isActive === true || String(p.isActive).toUpperCase() === 'TRUE' || String(p.status || '').toUpperCase() === 'ACTIVE') && !isItemInactive;

        if (isItemInactive) {
          inactive++;
        } else if (isItemActive || p.isActive !== false) {
          active++;
        }
      }
    });
    return {
      active,
      inactive,
      total: active + inactive,
      activeCount: active,
      inactiveCount: inactive,
      totalCount: active + inactive
    };
  }, [productsList, targetUserObj, prodCategoryFilter]);

  // Filtered Products
  const filteredProducts = useMemo(() => {
    return productsList.filter(p => {
      const itemDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      const matchesDeptRole = canAccessDepartmentData(targetUserObj, itemDept);
      const matchesCategory = matchDepartment(itemDept, prodCategoryFilter);
      
      const isItemInactive = p.isActive === false || String(p.isActive).toUpperCase() === 'FALSE' || String(p.status || '').toUpperCase() === 'INACTIVE';
      const isItemActive = (p.isActive === true || String(p.isActive).toUpperCase() === 'TRUE' || String(p.status || '').toUpperCase() === 'ACTIVE') && !isItemInactive;
      const effectiveActive = isItemActive || (!isItemInactive && p.isActive !== false);

      const matchesStatus = prodStatusFilter === 'ALL' 
        ? true 
        : prodStatusFilter === 'ACTIVE' 
          ? effectiveActive 
          : isItemInactive;

      const q = prodSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        String(p.code ?? '').toLowerCase().includes(q) ||
        String(p.name ?? '').toLowerCase().includes(q) ||
        String(p.category || p.department || '').toLowerCase().includes(q) ||
        String(p.locationName ?? '').toLowerCase().includes(q)
      );
      return matchesDeptRole && matchesCategory && matchesStatus && matchesSearch;
    });
  }, [productsList, targetUserObj, prodCategoryFilter, prodStatusFilter, prodSearch]);

  // Filtered Vendors
  const filteredVendors = useMemo(() => {
    return vendorsList.filter(v => {
      const matchesDeptRole = canAccessDepartmentData(targetUserObj, v.department);
      const matchesDeptFilter = vendorDeptFilter === 'ALL' || 
        v.department === 'BOTH' || 
        v.department === 'ALL' || 
        isDepartmentMatch(v.department, vendorDeptFilter);
      const q = vendorSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        v.code?.toLowerCase().includes(q) ||
        v.name?.toLowerCase().includes(q) ||
        v.contactPerson?.toLowerCase().includes(q) ||
        v.phone?.toLowerCase().includes(q) ||
        v.taxId?.toLowerCase().includes(q)
      );
      return matchesDeptRole && matchesDeptFilter && matchesSearch;
    });
  }, [vendorsList, targetUserObj, vendorDeptFilter, vendorSearch]);

  // Filtered Storage Locations (Clean Simple by Name)
  const filteredLocations = useMemo(() => {
    return locsList.filter(l => {
      const matchesDeptRole = canAccessDepartmentData(targetUserObj, l.department);
      const matchesDeptFilter = locDeptFilter === 'ALL' || 
        l.department === 'ALL' || 
        l.department === 'BOTH' || 
        isDepartmentMatch(l.department, locDeptFilter);
      const q = locSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        l.name?.toLowerCase().includes(q)
      );
      return matchesDeptRole && matchesDeptFilter && matchesSearch;
    });
  }, [locsList, targetUserObj, locDeptFilter, locSearch]);

  // Paginated collections
  const prodTotalPages = Math.ceil(filteredProducts.length / prodPageSize) || 1;
  const paginatedProducts = useMemo(() => {
    const start = (prodPage - 1) * prodPageSize;
    return filteredProducts.slice(start, start + prodPageSize);
  }, [filteredProducts, prodPage, prodPageSize]);

  const vendorTotalPages = Math.ceil(filteredVendors.length / vendorPageSize) || 1;
  const paginatedVendors = useMemo(() => {
    const start = (vendorPage - 1) * vendorPageSize;
    return filteredVendors.slice(start, start + vendorPageSize);
  }, [filteredVendors, vendorPage, vendorPageSize]);

  const locTotalPages = Math.ceil(filteredLocations.length / locPageSize) || 1;
  const paginatedLocations = useMemo(() => {
    const start = (locPage - 1) * locPageSize;
    return filteredLocations.slice(start, start + locPageSize);
  }, [filteredLocations, locPage, locPageSize]);

  // Filtered Usage Units (Department-Scoped Rooms)
  const filteredUsageUnits = useMemo(() => {
    return unitsList.filter(u => {
      const matchesDeptRole = canAccessDepartmentData(targetUserObj, u.department);
      const matchesDeptFilter = unitDeptFilter === 'ALL' || 
        u.department === 'ALL' || 
        isDepartmentMatch(u.department, unitDeptFilter);
      const q = unitSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        u.name?.toLowerCase().includes(q) ||
        u.id?.toLowerCase().includes(q)
      );
      return matchesDeptRole && matchesDeptFilter && matchesSearch;
    });
  }, [unitsList, targetUserObj, unitDeptFilter, unitSearch]);

  const unitTotalPages = Math.ceil(filteredUsageUnits.length / unitPageSize) || 1;
  const paginatedUsageUnits = useMemo(() => {
    const start = (unitPage - 1) * unitPageSize;
    return filteredUsageUnits.slice(start, start + unitPageSize);
  }, [filteredUsageUnits, unitPage, unitPageSize]);

  // Filtered Users (Multi-department Access & RBAC)
  const filteredUsers = useMemo(() => {
    return usersList.filter(u => {
      // Dept filter: checks primaryDepartment or allowedDepartments
      const matchesDept = userDeptFilter === 'ALL' ||
        isDepartmentMatch(u.primaryDepartment, userDeptFilter) ||
        isDepartmentMatch(u.department, userDeptFilter) ||
        (Array.isArray(u.allowedDepartments) && (u.allowedDepartments.some(ud => isDepartmentMatch(ud, userDeptFilter)) || u.allowedDepartments.includes('*')));

      // Role filter
      const matchesRole = userRoleFilter === 'ALL' || u.roleId === userRoleFilter || u.positionKey === userRoleFilter;

      // Search
      const q = userSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        u.name?.toLowerCase().includes(q) ||
        u.employeeName?.toLowerCase().includes(q) ||
        u.username?.toLowerCase().includes(q) ||
        u.employeeId?.toLowerCase().includes(q) ||
        u.title?.toLowerCase().includes(q)
      );

      return matchesDept && matchesRole && matchesSearch;
    });
  }, [usersList, userDeptFilter, userRoleFilter, userSearch]);

  const _userTotalPages = Math.ceil(filteredUsers.length / userPageSize) || 1;
  const _paginatedUsers = useMemo(() => {
    const start = (userPage - 1) * userPageSize;
    return filteredUsers.slice(start, start + userPageSize);
  }, [filteredUsers, userPage, userPageSize]);

  // Dynamic Department Filter Options (Scoped to user's assigned departments if non-admin)
  const deptFilterOptions = useMemo(() => {
    const baseDepts = departmentsList.filter(d => d.isActive);
    const deptNameMap = {
      'PD': 'ฝ่ายผลิต',
      'QC': 'ฝ่ายควบคุมคุณภาพ',
      'WH': 'คลังสินค้า',
      'PUR': 'จัดซื้อ',
      'ENG': 'วิศวกรรม'
    };

    if (isAdmin || canSeeAll) {
      return [
        { code: 'ALL', id: 'ALL', label: 'ทุกแผนก' },
        ...baseDepts.map(d => {
          const rawCode = d.code || (d.id ? String(d.id).replace(/^DEPT-/, '') : '');
          const cleanCode = rawCode || d.id;
          const name = d.name || deptNameMap[cleanCode] || cleanCode;
          return {
            code: cleanCode,
            id: d.id,
            label: `${name} (${cleanCode})`
          };
        })
      ];
    }

    // For Department-Restricted Requesters/Users:
    // Omit 'ALL' / 'ทุกแผนก' entirely to ensure they manage only their own department's items
    const myDepts = baseDepts.filter(d => userDepts.some(ud => isDepartmentMatch(ud, d)));
    const resultDepts = myDepts.length > 0 ? myDepts : userDepts.map(code => ({ code, name: deptNameMap[code] || code }));

    return resultDepts.map(d => {
      const rawCode = d.code || (d.id ? String(d.id).replace(/^DEPT-/, '') : '');
      const cleanCode = rawCode || d.id;
      const name = d.name || deptNameMap[cleanCode] || cleanCode;
      return {
        code: cleanCode,
        id: d.id,
        label: `${name} (${cleanCode})`
      };
    });
  }, [departmentsList, isAdmin, canSeeAll, userDepts]);

  const showDeptFilterToolbar = deptFilterOptions.length > 0;

  // Filtered Departments
  const filteredDepartments = useMemo(() => {
    return departmentsList.filter(d => {
      const matchesStatus = deptStatusFilter === 'ALL' || 
        (deptStatusFilter === 'ACTIVE' ? d.isActive : !d.isActive);
      const q = deptSearch.trim().toLowerCase();
      const matchesSearch = !q || (
        d.code?.toLowerCase().includes(q) ||
        d.name?.toLowerCase().includes(q) ||
        d.nameEn?.toLowerCase().includes(q) ||
        d.managerName?.toLowerCase().includes(q) ||
        d.description?.toLowerCase().includes(q)
      );
      return matchesStatus && matchesSearch;
    });
  }, [departmentsList, deptStatusFilter, deptSearch]);

  const deptTotalPages = Math.ceil(filteredDepartments.length / deptPageSize) || 1;
  const paginatedDepartments = useMemo(() => {
    const start = (deptPage - 1) * deptPageSize;
    return filteredDepartments.slice(start, start + deptPageSize);
  }, [filteredDepartments, deptPage, deptPageSize]);

  const handleDeleteProduct = async (prod) => {
    const prodId = String(prod.id || prod.code || '').trim();
    const prodCode = String(prod.code || prod.id || '').trim();
    const prodName = prod.name || prodCode;
    const isDummyArtifact = isBlacklistedProduct(prod);

    // Guard: Non-admin users cannot delete products outside their department
    if (!isAdmin && !canAccessDepartmentData(targetUserObj, prod.department || prod.category)) {
      modalService.warning('ไม่มีสิทธิ์ดำเนินการ', 'คุณไม่มีสิทธิ์ลบข้อมูลสินค้าของแผนกอื่น');
      return;
    }

    // ─── Requirement 4: Referential Integrity Guard ───
    const stockQty = Number(prod.stockBalance ?? prod.currentStock ?? prod.stockRemaining ?? 0);
    const hasRemainingStock = stockQty > 0;

    // Check active PRs
    const allPRs = (initialPRs && initialPRs.length > 0) ? initialPRs : (context?.prs || storageService.getPRs?.() || []);
    const activePRs = allPRs.filter(pr => 
      !['CANCELLED', 'REJECTED'].includes(pr.status) &&
      Array.isArray(pr.items) &&
      pr.items.some(item => {
        const iId = String(item.productId || item.code || '').trim().toLowerCase();
        const iCode = String(item.code || '').trim().toLowerCase();
        const iName = String(item.name || '').trim().toLowerCase();
        return iId === prodId.toLowerCase() || iId === prodCode.toLowerCase() ||
               iCode === prodCode.toLowerCase() || iName === prodName.toLowerCase();
      })
    );

    // Check active POs
    const allPOs = (initialPOs && initialPOs.length > 0) ? initialPOs : (context?.pos || storageService.getPOs?.() || []);
    const activePOs = allPOs.filter(po => 
      !['CANCELLED', 'CLOSED'].includes(po.status) &&
      Array.isArray(po.items) &&
      po.items.some(item => {
        const iId = String(item.productId || item.code || '').trim().toLowerCase();
        const iCode = String(item.code || '').trim().toLowerCase();
        const iName = String(item.name || '').trim().toLowerCase();
        return iId === prodId.toLowerCase() || iId === prodCode.toLowerCase() ||
               iCode === prodCode.toLowerCase() || iName === prodName.toLowerCase();
      })
    );

    // If bound to active PRs or POs, guard against deletion unless it's a test/dummy artifact
    if (!isDummyArtifact && (activePRs.length > 0 || activePOs.length > 0)) {
      const reasons = [];
      if (activePRs.length > 0) reasons.push(`ผูกกับใบขอซื้อ PR ที่เปิดอยู่ ${activePRs.length} ฉบับ`);
      if (activePOs.length > 0) reasons.push(`ผูกกับใบสั่งซื้อ PO ที่ยังไม่ปิดรอบ ${activePOs.length} ฉบับ`);
      if (hasRemainingStock) reasons.push(`สต็อกคงเหลือ ${stockQty.toLocaleString()} ${prod.stockUnit || prod.unit || 'ชิ้น'}`);

      setDeactivateItem({ product: prod, reasons });
      return;
    }

    // Force Delete Guard for items with stock balance
    let forceDeleteStock = false;
    let confirmMessage = `คุณต้องการลบรายการสินค้า "${prodName}" (รหัส SKU: ${prodCode}) ออกจากระบบถาวรใช่หรือไม่?\nข้อมูลจะถูกลบออกจากฐานข้อมูลทันที`;

    if (hasRemainingStock) {
      if (!isAdmin && !isDummyArtifact) {
        setDeactivateItem({ product: prod, reasons: [`สต็อกคงเหลือ ${stockQty.toLocaleString()} ${prod.stockUnit || prod.unit || 'ชิ้น'}`] });
        return;
      }
      forceDeleteStock = true;
      confirmMessage = `⚠️ สินค้ารายการนี้มียอดสต็อกคงเหลือ ${stockQty.toLocaleString()} ${prod.stockUnit || prod.unit || 'ชิ้น'}\n\nคุณในฐานะผู้ดูแลระบบต้องการยืนยันการลบสินค้า "${prodName}" (SKU: ${prodCode}) แบบ Force Delete หรือไม่?\nระบบจะทำการตัดยอด Stock Card ออกและลบออกจากระบบถาวร`;
    }

    // ─── Unlinked / Test Item / Admin Force Delete Flow ───
    const confirmed = await modalService.confirm({
      title: forceDeleteStock ? '⚠️ ยืนยัน Force Delete สินค้าพร้อมตัดสต็อก' : 'ยืนยันการลบสินค้า',
      message: confirmMessage,
      type: 'error',
      confirmText: forceDeleteStock ? 'ยืนยัน Force Delete' : 'ยืนยันการลบ',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    // 1. Optimistically mutate React state immediately so the row disappears without reload
    const targetDept = String(prod.department || prod.category || prod.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
    setProductsList(prev => deduplicateMasterData(prev.filter(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      if (pId && prodId) return pId !== prodId.toLowerCase() && !isBlacklistedProduct(p);
      const pCode = String(p.code || '').trim().toLowerCase();
      const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      return !(pCode === prodCode.toLowerCase() && pDept === targetDept) && !isBlacklistedProduct(p);
    })));

    // 2. Local Storage Persistence: update localStorage and purge stock logs
    if (storageService.deleteProduct) {
      storageService.deleteProduct(prod.id || prod.code);
    } else {
      const localProds = storageService.getProducts();
      const updatedLocal = deduplicateMasterData(localProds.filter(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        if (pId && prodId) return pId !== prodId.toLowerCase() && !isBlacklistedProduct(p);
        const pCode = String(p.code || '').trim().toLowerCase();
        const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
        return !(pCode === prodCode.toLowerCase() && pDept === targetDept) && !isBlacklistedProduct(p);
      }));
      storageService.saveProducts(updatedLocal);
    }

    // 3. Delete from backend API (server products.json)
    try {
      if (onDeleteProduct) {
        await onDeleteProduct(prod.id || prod.code);
      } else {
        await apiService.deleteProduct(prod.id || prod.code, currentRole);
      }
    } catch (err) {
      console.warn('[MasterData] Backend deleteProduct fallback:', err);
    }

    modalService.success('ลบสินค้าสำเร็จ', `ลบรายการ "${prodName}" เรียบร้อยแล้ว`);
    if (onRefresh) onRefresh();
  };

  const handleConfirmDeactivate = async () => {
    if (!deactivateItem?.product) return;
    const prod = deactivateItem.product;
    const prodName = prod.name || prod.code;
    const prodId = String(prod.id || prod.code || '').trim();
    const prodCode = String(prod.code || prod.id || '').trim();

    setIsDeactivating(true);
    try {
      const updated = { ...prod, isActive: false, status: 'INACTIVE' };

      // 1. Optimistically mutate local state
      const targetDept = String(prod.department || prod.category || prod.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      setProductsList(prev => deduplicateMasterData(prev.map(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        if (pId && prodId) return pId === prodId.toLowerCase() ? updated : p;
        const pCode = String(p.code || '').trim().toLowerCase();
        const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
        return (pCode === prodCode.toLowerCase() && pDept === targetDept) ? updated : p;
      })));

      // 2. Persist to storageService / localStorage
      const localProds = storageService.getProducts();
      const updatedLocal = deduplicateMasterData(localProds.map(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        if (pId && prodId) return pId === prodId.toLowerCase() ? updated : p;
        const pCode = String(p.code || '').trim().toLowerCase();
        const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
        return (pCode === prodCode.toLowerCase() && pDept === targetDept) ? updated : p;
      }));
      storageService.saveProducts(updatedLocal);

      // 3. Persist to API
      try {
        if (onSaveProduct) {
          await onSaveProduct(updated);
        } else {
          await apiService.saveProduct(updated, currentRole);
        }
      } catch (err) {
        console.warn('[MasterData] Deactivate API fallback:', err);
      }

      setDeactivateItem(null);
      modalService.success('ปิดการใช้งานสำเร็จ', `ระงับการใช้งานสินค้า "${prodName}" เรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.warn('[MasterData] Deactivate error:', err);
      modalService.error('เกิดข้อผิดพลาดในการปิดใช้งาน', err.message);
    } finally {
      setIsDeactivating(false);
    }
  };

  const handleReactivateProduct = async (prod) => {
    const prodName = prod.name || prod.code;
    const prodId = String(prod.id || prod.code || '').trim();
    const prodCode = String(prod.code || prod.id || '').trim();

    const confirmed = await modalService.confirm({
      title: 'เปิดใช้งานสินค้าอีกครั้ง (Reactivate)',
      message: `คุณต้องการเปิดใช้งานรายการสินค้า "${prodName}" (${prodCode}) กลับเข้าสู่ระบบใช่หรือไม่?\nสินค้าจะกลับมาให้เลือกสร้างใบขอซื้อและทำรายการเบิกได้ตามปกติ`,
      type: 'info',
      confirmText: 'เปิดใช้งานใหม่',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    const updated = { ...prod, isActive: true, status: 'ACTIVE' };

    // 1. Optimistically mutate local state
    const targetDept = String(prod.department || prod.category || prod.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
    setProductsList(prev => deduplicateMasterData(prev.map(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      if (pId && prodId) return pId === prodId.toLowerCase() ? updated : p;
      const pCode = String(p.code || '').trim().toLowerCase();
      const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      return (pCode === prodCode.toLowerCase() && pDept === targetDept) ? updated : p;
    })));

    // 2. Persist to storageService / localStorage
    const localProds = storageService.getProducts();
    const updatedLocal = deduplicateMasterData(localProds.map(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      if (pId && prodId) return pId === prodId.toLowerCase() ? updated : p;
      const pCode = String(p.code || '').trim().toLowerCase();
      const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      return (pCode === prodCode.toLowerCase() && pDept === targetDept) ? updated : p;
    }));
    storageService.saveProducts(updatedLocal);

    // 3. Persist to API
    try {
      if (onSaveProduct) {
        await onSaveProduct(updated);
      } else {
        await apiService.saveProduct(updated, currentRole);
      }
    } catch (err) {
      console.warn('[MasterData] Reactivate API fallback:', err);
    }

    modalService.success('เปิดใช้งานสำเร็จ', `เปิดใช้งานสินค้า "${prodName}" เรียบร้อยแล้ว`);
    if (onRefresh) onRefresh();
  };

  const handleDeleteVendor = async (vendor) => {
    const vendorId = String(vendor.id || vendor.code || '').trim();
    const vendorCode = String(vendor.code || vendor.id || '').trim();
    const vendorName = vendor.name || vendorCode;

    // Guard: Non-admin users cannot delete vendors outside their department
    if (!isAdmin && !canAccessDepartmentData(targetUserObj, vendor.department)) {
      modalService.warning('ไม่มีสิทธิ์ดำเนินการ', 'คุณไม่มีสิทธิ์ลบข้อมูลผู้ขายของแผนกอื่น');
      return;
    }

    // Check active POs
    const allPOs = (initialPOs && initialPOs.length > 0) ? initialPOs : (context?.pos || storageService.getPOs?.() || []);
    const linkedPOs = allPOs.filter(po => 
      !['CANCELLED', 'CLOSED'].includes(po.status) &&
      (String(po.vendorId || '').trim().toLowerCase() === vendorId.toLowerCase() || 
       String(po.vendor || '').trim().toLowerCase() === vendorName.toLowerCase())
    );

    if (linkedPOs.length > 0) {
      modalService.warning(
        'ไม่สามารถลบผู้จัดจำหน่ายนี้ได้',
        `เนื่องจากผู้ขาย "${vendorName}" มีใบสั่งซื้อ (PO) ที่ยังดำเนินงานอยู่ ${linkedPOs.length} ฉบับ กรุณาจัดการปิดหรือยกเลิก PO ที่เกี่ยวข้องก่อน`
      );
      return;
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบผู้ขาย',
      message: `คุณต้องการลบข้อมูลผู้จัดจำหน่าย "${vendorName}" ออกจากระบบถาวรใช่หรือไม่?`,
      type: 'error',
      confirmText: 'ยืนยันการลบ',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    const targetDept = String(vendor.department || vendor.dept || vendor.category || '').replace(/^DEPT-/, '').trim().toUpperCase();

    // 1. Optimistic React state update
    setVendorsList(prev => prev.filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      if (vId && vendorId) return vId !== vendorId.toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      const vDept = String(v.department || v.dept || v.category || '').replace(/^DEPT-/, '').trim().toUpperCase();
      return !(vCode === vendorCode.toLowerCase() && (vDept === targetDept || vDept === 'ALL' || targetDept === 'ALL'));
    }));

    // 2. Local Storage Persistence
    const localVendors = storageService.getVendors().filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      if (vId && vendorId) return vId !== vendorId.toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      const vDept = String(v.department || v.dept || v.category || '').replace(/^DEPT-/, '').trim().toUpperCase();
      return !(vCode === vendorCode.toLowerCase() && (vDept === targetDept || vDept === 'ALL' || targetDept === 'ALL'));
    });
    storageService.saveVendors(localVendors);

    // 3. Backend API delete
    try {
      if (onDeleteVendor) {
        await onDeleteVendor(vendor.id || vendor.code);
      } else {
        await apiService.deleteVendor(vendor.id || vendor.code, currentRole);
      }
    } catch (err) {
      console.warn('[MasterData] Backend deleteVendor fallback:', err);
    }

    modalService.success('ลบผู้ขายสำเร็จ', `ลบ "${vendorName}" เรียบร้อยแล้ว`);
    if (onRefresh) onRefresh();
  };

  // ─── Requirement 1: Data Integrity Guardrail on Delete ───
  const _handleDeleteLocation = async (loc) => {
    // Check if any product is assigned to this storage location
    const allProds = storageService.getProducts();
    const assigned = allProds.filter(p => p.locationId === loc.id);
    
    if (assigned.length > 0) {
      return modalService.warning(
        'ไม่สามารถลบจุดเก็บนี้ได้',
        `เนื่องจากมีสินค้าผูกอยู่ ${assigned.length} รายการ กรุณาย้ายหรือเปลี่ยนจุดเก็บของสินค้าออกก่อน`
      );
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบจุดจัดเก็บ',
      message: `ต้องการลบจุดจัดเก็บสินค้า "${loc.name}" ออกจากระบบหรือไม่?`,
      type: 'error',
      confirmText: 'ลบจุดจัดเก็บ',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    try {
      await apiService.deleteStorageLocation(loc.id, currentRole?.name);
      modalService.success('ลบจุดจัดเก็บสำเร็จ', `ลบ "${loc.name}" เรียบร้อยแล้ว`);
      onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาด', err.message);
    }
  };

  const handleDeleteUsageUnit = async (unit) => {
    // Guard: Non-admin users cannot delete usage units outside their department
    if (!isAdmin && !canAccessDepartmentData(targetUserObj, unit.department)) {
      modalService.warning('ไม่มีสิทธิ์ดำเนินการ', 'คุณไม่มีสิทธิ์ลบหน่วยเบิกใช้งานของแผนกอื่น');
      return;
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบหน่วยเบิกใช้งาน',
      message: `ต้องการลบหน่วยเบิกใช้งาน "${unit.name}" (${unit.department}) ออกจากระบบหรือไม่?`,
      type: 'error',
      confirmText: 'ลบหน่วยเบิก',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;
    try {
      if (onDeleteUsageUnit) {
        await onDeleteUsageUnit(unit.id);
      } else {
        await apiService.deleteUsageUnit(unit.id, currentRole?.name);
      }
      setUnitsList(prev => prev.filter(u => u.id !== unit.id));
      modalService.success('ลบหน่วยเบิกสำเร็จ', `ลบ "${unit.name}" เรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาด', err.message);
    }
  };

  const _handleDeleteUser = async (targetUser) => {
    if (!canDeleteMaster) return;

    // Self-lockout guard: Prevent user from deleting own account
    const isSelf = currentRole?.id === targetUser.id || currentRole?.username === targetUser.username;
    if (isSelf) {
      modalService.warning(
        'ไม่สามารถลบบัญชีตนเองได้',
        'ระบบมีมาตรการป้องกัน Self-Lockout Guard ห้ามลบหรือปิดการใช้งานบัญชีที่คุณกำลังเข้าสู่ระบบอยู่'
      );
      return;
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบผู้ใช้งาน',
      message: `ต้องการลบผู้ใช้งาน "${targetUser.name}" (@${targetUser.username || targetUser.employeeId}) ออกจากระบบหรือไม่?`,
      type: 'error',
      confirmText: 'ลบผู้ใช้งาน',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    try {
      if (onDeleteUser) {
        await onDeleteUser(targetUser.id);
      } else {
        await apiService.deleteUser(targetUser.id, currentRole?.name);
      }
      setUsersList(prev => prev.filter(u => u.id !== targetUser.id));
      modalService.success('ลบผู้ใช้งานสำเร็จ', `ลบผู้ใช้งาน "${targetUser.name}" เรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการลบผู้ใช้งาน', err.message);
    }
  };

  const _roleBadge = (user) => {
    const rawRoleId = user?.roleId || user?.positionKey;
    // Normalize legacy department-coupled roleIds
    const roleId = (rawRoleId === 'REQUESTER_PD' || rawRoleId === 'REQUESTER_QC') ? 'REQUESTER' : rawRoleId;
    const colors = {
      ADMIN: 'bg-purple-50 text-purple-700 border-purple-200/80',
      PLANT_MANAGER: 'bg-rose-50 text-rose-700 border-rose-200/80',
      ASST_MANAGER: 'bg-violet-50 text-violet-700 border-violet-200/80',
      ONLINE_PURCHASER: 'bg-cyan-50 text-cyan-700 border-cyan-200/80',
      REQUESTER: 'bg-blue-50 text-blue-700 border-blue-200/80',
    };
    const title = user?.title || roleId || 'User';
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border ${colors[roleId] || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
        <Shield className="w-3.5 h-3.5" />
        <span>{title}</span>
      </span>
    );
  };

  const deptBadge = (deptCode) => {
    if (!deptCode) return null;
    if (deptCode === 'BOTH' || deptCode === 'ALL') {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200/80">
          ส่วนกลาง (ALL)
        </span>
      );
    }
    const found = departmentsList.find(d => isDepartmentMatch(d, deptCode));
    const color = found?.color;
    const badgeStyle = color === 'amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200/80'
      : color === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200/80'
      : color === 'purple'
      ? 'bg-purple-50 text-purple-700 border-purple-200/80'
      : color === 'cyan'
      ? 'bg-cyan-50 text-cyan-700 border-cyan-200/80'
      : 'bg-blue-50 text-blue-700 border-blue-200/80';

    const displayCode = found?.code || (found?.id ? String(found.id).replace(/^DEPT-/, '') : deptCode);
    return (
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeStyle}`}>
        {found ? `${found.name} (${displayCode})` : deptCode}
      </span>
    );
  };

  const handleSaveDepartment = async (deptData) => {
    try {
      if (onSaveDepartment) {
        await onSaveDepartment(deptData);
      } else {
        await apiService.saveDepartment(deptData, currentUser?.name || currentRole?.name);
      }
      setDepartmentsList(storageService.getDepartments());
      modalService.success(
        deptData.id ? 'แก้ไขข้อมูลแผนกสำเร็จ' : 'เพิ่มแผนกใหม่สำเร็จ',
        `บันทึกข้อมูลแผนก "${deptData.name}" (${deptData.code}) เรียบร้อยแล้ว`
      );
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึกแผนก', err.message);
    }
  };

  const handleToggleDeptStatus = async (dept) => {
    const updated = { ...dept, isActive: !dept.isActive };
    await handleSaveDepartment(updated);
  };

  const handleDeleteDepartment = async (dept) => {
    const allUsers = storageService.getUsers?.() || [];
    const assignedUsers = allUsers.filter(u => u.primaryDepartment === dept.code || u.department === dept.code);
    if (assignedUsers.length > 0) {
      return modalService.warning(
        'ไม่สามารถลบแผนกนี้ได้',
        `เนื่องจากมีผู้ใช้งานผูกอยู่กับแผนก ${dept.code} จำนวน ${assignedUsers.length} คน กรุณาย้ายแผนกของผู้ใช้ก่อน`
      );
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบแผนก',
      message: `ต้องการลบแผนก "${dept.name}" (${dept.code}) ออกจากระบบ Master Data หรือไม่?`,
      type: 'error',
      confirmText: 'ลบแผนก',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    try {
      if (onDeleteDepartment) {
        await onDeleteDepartment(dept.id);
      } else {
        await apiService.deleteDepartment(dept.id, currentUser?.name || currentRole?.name);
      }
      setDepartmentsList(prev => prev.filter(d => d.id !== dept.id && d.code !== dept.code));
      modalService.success('ลบแผนกสำเร็จ', `ลบแผนก "${dept.name}" เรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการลบแผนก', err.message);
    }
  };

  return (
    <div className="w-full space-y-6 animate-fade-in pb-10">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2.5 tracking-tight">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shadow-2xs">
                <Database className="w-5 h-5" />
              </div>
              <span>จัดการข้อมูลหลัก (Master Data)</span>
            </h2>
            {!canSeeAll && userDepts.length > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-bold">
                <Building2 className="w-4 h-4" />
                แผนก {userDepts.join(', ')}
              </span>
            )}
          </div>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 font-normal">
            {canSeeAll
              ? 'จัดการและค้นหารายการสินค้า ข้อมูลผู้ขาย (Vendor) และจุดจัดเก็บสินค้าในคลัง'
              : `สิทธิ์สำหรับแผนก: ${userDepts.join(', ')} — เพิ่ม/แก้ไขข้อมูลสินค้า จุดจัดเก็บ และ Vendor ของคุณ`}
          </p>
        </div>

        {/* Primary Action Button in Header */}
        <div className="flex items-center gap-2.5">
          {(activeTab === 'catalog' || activeTab === 'products') ? (
            <button
              onClick={() => { setEditProd(null); setShowProdModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-xs sm:text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>เพิ่มสินค้าใหม่</span>
            </button>
          ) : activeTab === 'vendors' ? (
            <button
              onClick={() => { setEditVendor(null); setShowVendorModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-xs sm:text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>เพิ่มผู้ขายใหม่</span>
            </button>
          ) : activeTab === 'locations' ? (
            <button
              onClick={() => { setEditLocation(null); setShowLocationModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-xs sm:text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>เพิ่มจุดจัดเก็บใหม่</span>
            </button>
          ) : (activeTab === 'rooms' || activeTab === 'usageUnits') ? (
            <button
              onClick={() => { setEditUsageUnit(null); setShowUsageUnitModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-xs sm:text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>เพิ่มหน่วยเบิกใหม่</span>
            </button>
          ) : activeTab === 'departments' && isAdmin ? (
            <button
              onClick={() => { setEditDept(null); setShowDeptModal(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-xs sm:text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>เพิ่มแผนกใหม่</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Tabs */}
      <MasterDataNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isAdmin={isAdmin}
        counts={{
          catalog: prodStatusCounts.total,
          products: prodStatusCounts.total,
          vendors: filteredVendors.length,
          locations: filteredLocations.length,
          rooms: filteredUsageUnits.length,
          usageUnits: filteredUsageUnits.length,
          users: filteredUsers.length,
          departments: departmentsList.length
        }}
      />

      {/* Tab 1: Products / Catalog */}
      {(activeTab === 'catalog' || activeTab === 'products') && (
        <div className="space-y-4">
          <div className="bg-white p-3 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {showDeptFilterToolbar && (
                <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0 flex-wrap">
                  {deptFilterOptions.map(cat => {
                    const isTabSelected = cat.code === 'ALL'
                      ? prodCategoryFilter === 'ALL'
                      : (prodCategoryFilter !== 'ALL' && matchDepartment(cat.code || cat.id, prodCategoryFilter));
                    return (
                      <button
                        key={cat.code || cat.id}
                        onClick={() => setProdCategoryFilter(cat.code || cat.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                          isTabSelected
                            ? 'bg-white text-slate-900 shadow-xs font-bold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {cat.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Status Filter Toggle: Active / All / Inactive */}
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0">
                <button
                  type="button"
                  onClick={() => setProdStatusFilter('ACTIVE')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    prodStatusFilter === 'ACTIVE'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title="แสดงเฉพาะสินค้าที่เปิดใช้งาน"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span>เปิดใช้งาน</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-100 text-slate-600 font-bold">
                    {prodStatusCounts.active}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setProdStatusFilter('ALL')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    prodStatusFilter === 'ALL'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title="แสดงรายการสินค้าทั้งหมดรวมที่ปิดใช้งาน"
                >
                  <span>ทั้งหมด</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-100 text-slate-600 font-bold">
                    {prodStatusCounts.total}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setProdStatusFilter('INACTIVE')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    prodStatusFilter === 'INACTIVE'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title="แสดงสินค้าที่ถูกระงับ/ปิดการใช้งาน"
                >
                  <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                  <span>ปิดใช้งาน</span>
                  {prodStatusCounts.inactive > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-200 text-slate-700 font-bold">
                      {prodStatusCounts.inactive}
                    </span>
                  )}
                </button>
              </div>
            </div>

            <div className="relative flex-1 sm:w-80 ml-auto">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="ค้นหารหัส, ชื่อสินค้า, จุดเก็บ หรือโซน..."
                value={prodSearch}
                onChange={e => setProdSearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 shadow-2xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
              {prodSearch && (
                <button onClick={() => setProdSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-0.5">✕</button>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200/70 rounded-2xl overflow-hidden shadow-2xs">
            <div className="overflow-x-auto max-h-[580px] custom-scrollbar">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-xs shadow-2xs border-b border-slate-200/80 text-slate-500 font-semibold text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pl-5">รหัสสินค้า</th>
                    <th className="py-3 px-4 w-1/3">ชื่อสินค้า / สเปก & จุดจัดเก็บ</th>
                    <th className="py-3 px-4">แผนก</th>
                    <th className="py-3 px-4 text-center">สถานะ</th>
                    <th className="py-3 px-4 text-right">ราคาต่อหน่วย</th>
                    <th className="py-3 px-4 text-right">สต็อกคงเหลือ</th>
                    <th className="py-3 px-4 text-right">จุดสั่งซื้อ (ROP)</th>
                    <th className="py-3 pr-5 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedProducts.map((p, index) => {
                    const isInactive = p.isActive === false || String(p.isActive).toUpperCase() === 'FALSE' || String(p.status || '').toUpperCase() === 'INACTIVE';
                    return (
                      <tr 
                        key={p.id ? `${p.id}-${index}` : `${p.code}-${index}`} 
                        className={`transition-colors ${
                          isInactive 
                            ? 'opacity-60 bg-slate-50/50 hover:bg-slate-100/60' 
                            : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3.5 pl-6 font-mono font-bold text-slate-800 text-xs">{p.code}</td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-900">{p.name}</div>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-50/80 text-indigo-700 border border-indigo-100">
                              <MapPin className="w-3 h-3 text-indigo-500 shrink-0" />
                              <span>{p.locationName || 'ไม่ระบุจุดจัดเก็บ'}</span>
                            </span>
                            {Number(p.conversionRate) > 1 && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                1 {p.purchaseUnit || p.unit} = {p.conversionRate} {p.stockUnit || p.unit}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">{deptBadge(p.category || p.department)}</td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          {isInactive ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                              ปิดใช้งาน
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                              เปิดใช้งาน
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-900 tabular-nums">
                          ฿{p.price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold text-indigo-700 tabular-nums">
                          {p.stockBalance || 0} <span className="text-xs text-slate-400 font-sans">{p.unit}</span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-600 tabular-nums">
                          {p.reorderPoint || 0} <span className="text-xs text-slate-400 font-sans">{p.unit}</span>
                        </td>
                        <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                          {(() => {
                            const canModifyProd = isAdmin || canAccessDepartmentData(targetUserObj, p.department || p.category);
                            return (
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={!canModifyProd}
                                  onClick={() => {
                                    if (!canModifyProd) return;
                                    setEditProd(p);
                                    setShowProdModal(true);
                                  }}
                                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                    canModifyProd
                                      ? 'hover:bg-slate-100 text-slate-600 hover:text-indigo-600'
                                      : 'opacity-30 cursor-not-allowed text-slate-300'
                                  }`}
                                  title={canModifyProd ? "แก้ไขสินค้า" : "ไม่มีสิทธิ์แก้ไขสินค้านอกแผนก"}
                                >
                                  <Edit3 className="w-4 h-4" />
                                </button>
                                {isInactive ? (
                                  <div className="flex items-center gap-1">
                                    {canModifyProd && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleReactivateProduct(p);
                                        }}
                                        className="p-1.5 hover:bg-emerald-50 text-emerald-600 hover:text-emerald-700 rounded-lg transition-colors cursor-pointer"
                                        title="เปิดใช้งานใหม่ (Reactivate / Restore)"
                                      >
                                        <RotateCcw className="w-4 h-4 pointer-events-none" />
                                      </button>
                                    )}
                                    {isAdmin && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteProduct(p);
                                        }}
                                        className="p-1.5 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-lg transition-colors cursor-pointer"
                                        title="ลบสินค้าถาวร (Delete Permanently)"
                                      >
                                        <Trash2 className="w-4 h-4 pointer-events-none" />
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={!canModifyProd}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!canModifyProd) return;
                                      handleDeleteProduct(p);
                                    }}
                                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                      canModifyProd
                                        ? 'hover:bg-rose-50 text-slate-400 hover:text-rose-600'
                                        : 'opacity-30 cursor-not-allowed text-slate-300'
                                    }`}
                                    title={canModifyProd ? "ลบ / ปิดการใช้งานสินค้า" : "ไม่มีสิทธิ์ลบสินค้านอกแผนก"}
                                  >
                                    <Trash2 className="w-4 h-4 pointer-events-none" />
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={prodPage}
              totalPages={prodTotalPages}
              totalItems={filteredProducts.length}
              pageSize={prodPageSize}
              onPageChange={setProdPage}
              onPageSizeChange={setProdPageSize}
            />
          </div>
        </div>
      )}

      {/* Tab 2: Vendors */}
      {activeTab === 'vendors' && (
        <div className="space-y-4">
          <div className="bg-white p-3 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {showDeptFilterToolbar && (
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0 flex-wrap">
                {deptFilterOptions.map(cat => {
                  const isTabSelected = cat.code === 'ALL'
                    ? vendorDeptFilter === 'ALL'
                    : (vendorDeptFilter !== 'ALL' && isDepartmentMatch(cat.code || cat.id, vendorDeptFilter));
                  return (
                    <button
                      key={cat.code || cat.id}
                      onClick={() => setVendorDeptFilter(cat.code || cat.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        isTabSelected
                          ? 'bg-white text-slate-900 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative flex-1 sm:w-80 ml-auto">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="ค้นหาชื่อผู้ขาย, เบอร์โทร, เลขภาษี..."
                value={vendorSearch}
                onChange={e => setVendorSearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 shadow-2xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
              {vendorSearch && (
                <button onClick={() => setVendorSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-0.5">✕</button>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200/70 rounded-2xl overflow-hidden shadow-2xs">
            <div className="overflow-x-auto max-h-[580px] custom-scrollbar">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-xs shadow-2xs border-b border-slate-200/80 text-slate-500 font-semibold text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pl-5">รหัสผู้ขาย</th>
                    <th className="py-3 px-4 w-1/3">ชื่อบริษัท / ร้านค้า</th>
                    <th className="py-3 px-4">ผู้ติดต่อ</th>
                    <th className="py-3 px-4">เบอร์โทรศัพท์</th>
                    <th className="py-3 px-4">แผนก</th>
                    <th className="py-3 pr-5 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedVendors.map(v => (
                    <tr key={v.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3.5 pl-6 font-mono font-bold text-slate-800 text-xs">{v.code}</td>
                      <td className="py-3.5 px-4 font-semibold text-slate-900">{v.name}</td>
                      <td className="py-3.5 px-4 text-slate-600">{v.contactPerson || '-'}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-600">{v.phone || '-'}</td>
                      <td className="py-3.5 px-4">{deptBadge(v.department)}</td>
                      <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                        {(() => {
                          const canModifyVendor = isAdmin || canAccessDepartmentData(targetUserObj, v.department);
                          return (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                disabled={!canModifyVendor}
                                onClick={() => {
                                  if (!canModifyVendor) return;
                                  setEditVendor(v);
                                  setShowVendorModal(true);
                                }}
                                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                  canModifyVendor
                                    ? 'hover:bg-slate-100 text-slate-600 hover:text-indigo-600'
                                    : 'opacity-30 cursor-not-allowed text-slate-300'
                                }`}
                                title={canModifyVendor ? "แก้ไขข้อมูลผู้ขาย" : "ไม่มีสิทธิ์แก้ไขผู้ขายนอกแผนก"}
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                disabled={!canModifyVendor}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!canModifyVendor) return;
                                  handleDeleteVendor(v);
                                }}
                                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                  canModifyVendor
                                    ? 'hover:bg-rose-50 text-slate-400 hover:text-rose-600'
                                    : 'opacity-30 cursor-not-allowed text-slate-300'
                                }`}
                                title={canModifyVendor ? "ลบผู้ขาย" : "ไม่มีสิทธิ์ลบผู้ขายนอกแผนก"}
                              >
                                <Trash2 className="w-4 h-4 pointer-events-none" />
                              </button>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={vendorPage}
              totalPages={vendorTotalPages}
              totalItems={filteredVendors.length}
              pageSize={vendorPageSize}
              onPageChange={setVendorPage}
              onPageSizeChange={setVendorPageSize}
            />
          </div>
        </div>
      )}

      {/* Tab 3: Storage Locations */}
      {activeTab === 'locations' && (
        <div className="space-y-4">
          <div className="bg-white p-3 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {showDeptFilterToolbar && (
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0 flex-wrap">
                {deptFilterOptions.map(cat => {
                  const isTabSelected = cat.code === 'ALL'
                    ? locDeptFilter === 'ALL'
                    : (locDeptFilter !== 'ALL' && isDepartmentMatch(cat.code || cat.id, locDeptFilter));
                  return (
                    <button
                      key={cat.code || cat.id}
                      onClick={() => setLocDeptFilter(cat.code || cat.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        isTabSelected
                          ? 'bg-white text-slate-900 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative flex-1 sm:w-80 ml-auto">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="ค้นหาชื่อจุดจัดเก็บสินค้า..."
                value={locSearch}
                onChange={e => setLocSearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 shadow-2xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
              {locSearch && (
                <button onClick={() => setLocSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-0.5">✕</button>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200/70 rounded-2xl overflow-hidden shadow-2xs">
            <div className="overflow-x-auto max-h-[580px] custom-scrollbar">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-xs shadow-2xs border-b border-slate-200/80 text-slate-500 font-semibold text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pl-5 w-16">ลำดับ</th>
                    <th className="py-3 px-4 w-1/2">ชื่อจุดจัดเก็บสินค้า</th>
                    <th className="py-3 px-4">แผนกที่ใช้งาน</th>
                    <th className="py-3 px-4 text-center">จำนวนสินค้าที่จัดเก็บ</th>
                    <th className="py-3 pr-5 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedLocations.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="p-8 text-center text-slate-400">
                        ไม่พบข้อมูลจุดจัดเก็บสินค้าตามเงื่อนไขที่เลือก
                      </td>
                    </tr>
                  ) : (
                    paginatedLocations.map((loc, idx) => {
                      const assignedProducts = (productsList || []).filter(item => item.locationId === loc.id || item.storageLocation === loc.name || item.locationName === loc.name);
                      return (
                        <tr key={loc.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3.5 pl-6 font-mono font-bold text-slate-400 text-xs whitespace-nowrap">
                            #{idx + 1}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shrink-0 shadow-2xs">
                                <MapPin className="w-4 h-4" />
                              </div>
                              <span className="font-bold text-slate-900 text-sm">{loc.name}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">{deptBadge(loc.department)}</td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold border tabular-nums ${
                              assignedProducts.length > 0
                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-2xs'
                                : 'bg-slate-50 text-slate-500 border-slate-200'
                            }`}>
                              <Boxes className="w-3.5 h-3.5" />
                              <span>{assignedProducts.length} รายการ</span>
                            </span>
                          </td>
                          <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                            {(() => {
                              const canModifyLoc = isAdmin || canAccessDepartmentData(targetUserObj, loc.department);
                              return (
                                <div className="flex items-center justify-center gap-1.5">
                                  <button
                                    disabled={!canModifyLoc}
                                    onClick={() => {
                                      if (!canModifyLoc) return;
                                      setEditLocation(loc);
                                      setShowLocationModal(true);
                                    }}
                                    className={`p-2 rounded-xl transition-colors cursor-pointer ${
                                      canModifyLoc
                                        ? 'hover:bg-slate-100 text-slate-600 hover:text-indigo-600'
                                        : 'opacity-30 cursor-not-allowed text-slate-300'
                                    }`}
                                    title={canModifyLoc ? "แก้ไขจุดจัดเก็บ" : "ไม่มีสิทธิ์แก้ไขจุดจัดเก็บนอกแผนก"}
                                  >
                                    <Edit3 className="w-4 h-4" />
                                  </button>
                                  <button
                                    disabled={!canModifyLoc}
                                    onClick={() => {
                                      if (!canModifyLoc) return;
                                      setDeleteLocationItem(loc);
                                    }}
                                    className={`p-2 rounded-xl transition-colors cursor-pointer ${
                                      canModifyLoc
                                        ? 'hover:bg-rose-50 text-slate-400 hover:text-rose-600'
                                        : 'opacity-30 cursor-not-allowed text-slate-300'
                                    }`}
                                    title={canModifyLoc ? "ลบจุดจัดเก็บ" : "ไม่มีสิทธิ์ลบจุดจัดเก็บนอกแผนก"}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={locPage}
              totalPages={locTotalPages}
              totalItems={filteredLocations.length}
              pageSize={locPageSize}
              onPageChange={setLocPage}
            />
          </div>
        </div>
      )}

      {/* Tab 4: Usage Units / Rooms (Department-Scoped Rooms) */}
      {(activeTab === 'rooms' || activeTab === 'usageUnits') && (
        <div className="space-y-4">
          <div className="bg-white p-3 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {showDeptFilterToolbar && (
              <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0 flex-wrap">
                {deptFilterOptions.map(cat => {
                  const isTabSelected = cat.code === 'ALL'
                    ? unitDeptFilter === 'ALL'
                    : (unitDeptFilter !== 'ALL' && isDepartmentMatch(cat.code || cat.id, unitDeptFilter));
                  return (
                    <button
                      key={cat.code || cat.id}
                      onClick={() => setUnitDeptFilter(cat.code || cat.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        isTabSelected
                          ? 'bg-white text-slate-900 shadow-2xs font-bold'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={unitSearch}
                onChange={e => setUnitSearch(e.target.value)}
                placeholder="ค้นหาชื่อหน่วยเบิก / ห้อง / รหัสหน่วย..."
                className="w-full bg-slate-50/70 hover:bg-slate-50 focus:bg-white text-slate-800 placeholder-slate-400 text-xs sm:text-sm pl-9 pr-8 py-2 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all"
              />
              {unitSearch && (
                <button
                  onClick={() => setUnitSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded-full"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Units Table */}
          <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    <th className="py-3.5 pl-6">ชื่อหน่วยเบิก / ห้อง</th>
                    <th className="py-3.5 px-4 text-center">แผนก</th>
                    <th className="py-3.5 px-4">รหัสระบบ</th>
                    <th className="py-3.5 px-4 text-center">รูปแบบสีแท็ก (Color Pill)</th>
                    <th className="py-3.5 px-4 text-center">สถานะ</th>
                    <th className="py-3.5 pr-6 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100/80">
                  {paginatedUsageUnits.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="py-12 text-center text-slate-400">
                        <DoorClosed className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                        <p className="font-semibold text-slate-600">ไม่พบรายการหน่วยเบิกใช้งาน</p>
                        <p className="text-xs text-slate-400 mt-1">ลองเปลี่ยนคำค้นหาหรือเพิ่มหน่วยเบิกใหม่</p>
                      </td>
                    </tr>
                  ) : (
                    paginatedUsageUnits.map(unit => {
                      const dot = unit.dot || 'bg-slate-500';
                      const color = unit.color || 'bg-slate-50 text-slate-700 border-slate-200/80';
                      return (
                        <tr key={unit.id} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-3.5 pl-6 font-semibold text-slate-900">
                            <div className="flex items-center gap-2.5">
                              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
                              <span className="text-sm font-bold text-slate-800">{unit.name}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            {deptBadge(unit.department)}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs text-slate-500">
                            {unit.id}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold border ${color}`}>
                              <span className={`w-2 h-2 rounded-full ${dot}`} />
                              <span>{unit.name}</span>
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              unit.status === 'INACTIVE'
                                ? 'bg-slate-100 text-slate-600 border-slate-200'
                                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            }`}>
                              {unit.status === 'INACTIVE' ? 'ปิดใช้งาน' : 'ใช้งานปกติ'}
                            </span>
                          </td>
                          <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                            {(() => {
                              const canModifyUnit = isAdmin || canAccessDepartmentData(targetUserObj, unit.department);
                              return (
                                <div className="flex items-center justify-center gap-1.5">
                                  <button
                                    disabled={!canModifyUnit}
                                    onClick={() => {
                                      if (!canModifyUnit) return;
                                      setEditUsageUnit(unit);
                                      setShowUsageUnitModal(true);
                                    }}
                                    className={`p-2 rounded-xl transition-colors cursor-pointer ${
                                      canModifyUnit
                                        ? 'hover:bg-slate-100 text-slate-600 hover:text-indigo-600'
                                        : 'opacity-30 cursor-not-allowed text-slate-300'
                                    }`}
                                    title={canModifyUnit ? "แก้ไขหน่วยเบิก" : "ไม่มีสิทธิ์แก้ไขหน่วยเบิกนอกแผนก"}
                                  >
                                    <Edit3 className="w-4 h-4" />
                                  </button>
                                  <button
                                    disabled={!canModifyUnit}
                                    onClick={() => {
                                      if (!canModifyUnit) return;
                                      handleDeleteUsageUnit(unit);
                                    }}
                                    className={`p-2 rounded-xl transition-colors cursor-pointer ${
                                      canModifyUnit
                                        ? 'hover:bg-rose-50 text-slate-400 hover:text-rose-600'
                                        : 'opacity-30 cursor-not-allowed text-slate-300'
                                    }`}
                                    title={canModifyUnit ? "ลบหน่วยเบิก" : "ไม่มีสิทธิ์ลบหน่วยเบิกนอกแผนก"}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={unitPage}
              totalPages={unitTotalPages}
              totalItems={filteredUsageUnits.length}
              pageSize={unitPageSize}
              onPageChange={setUnitPage}
            />
          </div>
        </div>
      )}

      {/* Tab 5: Users & E-Signature Management */}
      {activeTab === 'users' && isAdmin && (
        <UserMasterView 
          users={usersList} 
          departments={departmentsList}
          currentRole={currentRole} 
          currentUser={currentUser}
          onRefresh={async () => {
            setUsersList(storageService.getUsers() || []);
            if (onRefresh) await onRefresh();
            setUsersList(storageService.getUsers() || []);
          }} 
        />
      )}

      {/* Tab 6: Departments Master Data */}
      {activeTab === 'departments' && isAdmin && (
        <div className="space-y-4">
          <div className="bg-white p-3 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {/* Status Filter */}
            <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl shrink-0">
              {[
                { id: 'ALL', label: 'ทุกสถานะ' },
                { id: 'ACTIVE', label: '✓ เปิดใช้งาน' },
                { id: 'INACTIVE', label: '⚠️ ระงับการใช้งาน' }
              ].map(st => (
                <button
                  key={st.id}
                  onClick={() => setDeptStatusFilter(st.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    deptStatusFilter === st.id
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st.label}
                </button>
              ))}
            </div>

            <div className="relative flex-1 sm:w-80 ml-auto">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="ค้นหารหัสย่อ, ชื่อแผนก, ผู้จัดการ..."
                value={deptSearch}
                onChange={e => setDeptSearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 shadow-2xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
              {deptSearch && (
                <button onClick={() => setDeptSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold p-0.5">✕</button>
              )}
            </div>
          </div>

          {/* Departments Table Card */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-slate-50/80 border-b border-slate-200/70 text-slate-500 font-bold text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 pl-6">รหัสย่อ (Code)</th>
                    <th className="py-3.5 px-4">ชื่อแผนก / ฝ่าย (Department Name)</th>
                    <th className="py-3.5 px-4">คำนำหน้า (Prefix)</th>
                    <th className="py-3.5 px-4 text-right">งบประมาณ/เดือน</th>
                    <th className="py-3.5 px-4">ผู้จัดการ / หัวหน้าฝ่าย</th>
                    <th className="py-3.5 px-4 text-center">สถานะการใช้งาน</th>
                    <th className="py-3.5 pr-6 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedDepartments.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="py-12 text-center text-slate-400">
                        <Building2 className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                        <p className="font-semibold text-slate-600 text-sm">ไม่พบข้อมูลแผนก / ฝ่าย</p>
                        <p className="text-xs text-slate-400 mt-0.5">ลองปรับตัวกรองหรือเพิ่มแผนกใหม่เข้าสู่ระบบ</p>
                      </td>
                    </tr>
                  ) : (
                    paginatedDepartments.map(dept => {
                      return (
                        <tr key={dept.id} className="hover:bg-slate-50/60 transition-colors">
                          <td className="py-3.5 pl-6 font-mono font-bold text-xs">
                            <span className="px-2.5 py-1 rounded-xl bg-slate-100 text-slate-800 border border-slate-200 shadow-2xs">
                              {dept.code}
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            <div>
                              <span className="font-bold text-slate-900 text-sm">{dept.name}</span>
                              {dept.nameEn && (
                                <p className="text-[11px] text-slate-400 font-normal">{dept.nameEn}</p>
                              )}
                              {dept.description && (
                                <p className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">{dept.description}</p>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs font-semibold text-slate-600">
                            {dept.prefix || dept.code}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-800">
                            ฿{(Number(dept.monthlyBudget) || 0).toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4 text-slate-700 text-xs">
                            {dept.managerName ? (
                              <span className="inline-flex items-center gap-1.5 font-medium">
                                <UserCheck className="w-3.5 h-3.5 text-slate-400" />
                                <span>{dept.managerName}</span>
                              </span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <button
                              type="button"
                              onClick={() => handleToggleDeptStatus(dept)}
                              title="คลิกเพื่อสลับสถานะเปิด/ปิด"
                              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all cursor-pointer active:scale-95 ${
                                dept.isActive
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                              }`}
                            >
                              {dept.isActive ? '✓ เปิดใช้งาน' : '⚠️ ระงับการใช้งาน'}
                            </button>
                          </td>
                          <td className="py-3.5 pr-6 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => { setEditDept(dept); setShowDeptModal(true); }}
                                className="p-2 hover:bg-slate-100 text-slate-600 hover:text-indigo-600 rounded-xl transition-colors cursor-pointer"
                                title="แก้ไขแผนก"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteDepartment(dept)}
                                className="p-2 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-xl transition-colors cursor-pointer"
                                title="ลบแผนก"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={deptPage}
              totalPages={deptTotalPages}
              totalItems={filteredDepartments.length}
              pageSize={deptPageSize}
              onPageChange={setDeptPage}
            />
          </div>
        </div>
      )}

      {/* Modals */}
      {showProdModal && (
        <ProductCRUDModal
          editProd={editProd}
          product={editProd}
          products={productsList}
          vendors={vendorsList}
          departments={departmentsList}
          storageLocations={locsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          defaultCategory={prodCategoryFilter !== 'ALL' ? prodCategoryFilter : undefined}
          lockedCategory={isDeptRestricted ? userPrimaryDept : undefined}
          onClose={() => { setShowProdModal(false); setEditProd(null); }}
          onRefresh={onRefresh}
          onSaved={(saved) => {
            setProductsList(prev => prev.map(p => (p.id === saved.id || (saved.code && p.code === saved.code && matchDepartment(p.department || p.category, saved.department || saved.category))) ? saved : p));
            if (onSaveProduct) onSaveProduct(saved);
            if (onRefresh) onRefresh();
          }}
          onCreated={(created) => {
            setProductsList(prev => [created, ...prev.filter(p => !(p.id === created.id || (p.code === created.code && matchDepartment(p.department || p.category, created.department || created.category))))]);
            if (onSaveProduct) onSaveProduct(created);
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {showVendorModal && (
        <VendorCRUDModal
          editVendor={editVendor}
          vendor={editVendor}
          vendors={vendorsList}
          departments={departmentsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          onClose={() => { setShowVendorModal(false); setEditVendor(null); }}
          onRefresh={onRefresh}
          onSaved={(saved) => {
            setVendorsList(prev => prev.map(v => {
              const isSameScope = matchDepartment(v.department || 'ALL', saved.department || 'ALL');
              return (v.id === saved.id || (saved.code && v.code === saved.code && isSameScope)) ? saved : v;
            }));
            if (onSaveVendor) onSaveVendor(saved);
            if (onRefresh) onRefresh();
          }}
          onCreated={(created) => {
            setVendorsList(prev => [created, ...prev.filter(v => {
              const isSameScope = matchDepartment(v.department || 'ALL', created.department || 'ALL');
              return !(v.id === created.id || (v.code === created.code && isSameScope));
            })]);
            if (onSaveVendor) onSaveVendor(created);
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {showLocationModal && (
        <StorageLocationCRUDModal
          editLocation={editLocation}
          location={editLocation}
          storageLocations={locsList}
          departments={departmentsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          onClose={() => { setShowLocationModal(false); setEditLocation(null); }}
          onSaved={(saved) => {
            setLocsList(prev => prev.map(l => l.id === saved.id ? saved : l));
            if (onRefresh) onRefresh();
          }}
          onCreated={(created) => {
            setLocsList(prev => [created, ...prev.filter(l => l.id !== created.id)]);
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {deleteLocationItem && (
        <DeleteLocationModal
          location={deleteLocationItem}
          products={productsList}
          storageLocations={locsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          onClose={() => setDeleteLocationItem(null)}
          onDeleted={(deletedId) => {
            setLocsList(prev => prev.filter(l => l.id !== deletedId));
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {deactivateItem && (
        <DeactivateItemModal
          product={deactivateItem.product}
          reasons={deactivateItem.reasons}
          isProcessing={isDeactivating}
          onClose={() => setDeactivateItem(null)}
          onConfirm={handleConfirmDeactivate}
        />
      )}

      {showUsageUnitModal && (
        <UsageUnitCRUDModal
          unit={editUsageUnit}
          usageUnits={unitsList}
          departments={departmentsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          onClose={() => { setShowUsageUnitModal(false); setEditUsageUnit(null); }}
          onSaved={(saved) => {
            setUnitsList(prev => prev.map(u => u.id === saved.id ? saved : u));
            if (onRefresh) onRefresh();
          }}
          onCreated={(created) => {
            setUnitsList(prev => [created, ...prev.filter(u => u.id !== created.id)]);
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {showUserModal && (
        <UserCRUDModal
          user={editUser}
          users={usersList}
          departments={departmentsList}
          currentRole={effectiveRole}
          currentUser={effectiveUser}
          onClose={() => { setShowUserModal(false); setEditUser(null); }}
          onSaved={(saved) => {
            setUsersList(prev => prev.map(u => u.id === saved.id ? saved : u));
            if (onSaveUser) onSaveUser(saved);
            if (onRefresh) onRefresh();
          }}
          onCreated={(created) => {
            setUsersList(prev => [created, ...prev.filter(u => u.id !== created.id)]);
            if (onSaveUser) onSaveUser(created);
            if (onRefresh) onRefresh();
          }}
        />
      )}
      {showDeptModal && (
        <DepartmentCRUDModal
          department={editDept}
          departments={departmentsList}
          onClose={() => { setShowDeptModal(false); setEditDept(null); }}
          onSave={handleSaveDepartment}
        />
      )}
    </div>
  );
}
