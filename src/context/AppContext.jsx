import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { storageService, isGAS, callGAS } from '../services/storageService';
import { apiService } from '../services/apiService';
import { notificationService } from '../services/notificationService';
import { workflowEngine } from '../services/workflowEngine';
import { authService, DEFAULT_EMPLOYEE_ACCOUNTS } from '../services/authService';
import { resolveUserPermissions } from '../config/constants';
import { modalService } from '../services/modalService';
import { getUserDepartments, matchDepartment } from '../utils/permissions';
import { getUnifiedProductList } from '../views/PRCreateView';
import { normalizeRole, useAuth } from './AuthContext';
import { isToDoTask } from '../services/workspaceService';

export const AppContext = createContext(null);

// Route mapping table for legacy view ID translations
export const VIEW_PATH_MAP = {
  'dashboard': '/dashboard',
  'my-workspace': '/my-workspace',
  'my-work': '/my-workspace',
  'pr-list': '/prs',
  'prs': '/prs',
  'pr-create': '/prs/create',
  'po-list': '/pos',
  'pos': '/pos',
  'stock-card': '/inventory/stock-card',
  'warehouse': '/inventory/stock-card',
  'quick-issue': '/inventory/quick-issue',
  'budget': '/budget',
  'master-data': '/master-data',
  'online-tasks': '/online-tasks',
};

// Default fallback user (คุณวิชัย - Requester PD)
export const DEFAULT_USER = DEFAULT_EMPLOYEE_ACCOUNTS[0];

// Helper to get initial user with permissions enriched
const getInitialUserSession = () => {
  const existing = authService.getCurrentSession();
  if (existing) {
    const permissions = typeof existing.role === 'object' ? existing.role : resolveUserPermissions(existing);
    const isAdmin = existing.roleId === 'ADMIN' || existing.level >= 99 || existing.username === 'admin' || existing.role === 'admin';
    const cleanUserDepts = getUserDepartments(existing);
    const userDepts = cleanUserDepts.length > 0 ? cleanUserDepts : (existing.department ? [existing.department] : ['PD']);
    return {
      ...existing,
      canonicalRole: normalizeRole(existing),
      departments: userDepts,
      assignedDepartments: existing.assignedDepartments || userDepts,
      allowedDepartments: existing.allowedDepartments || userDepts,
      primaryDepartment: existing.primaryDepartment || userDepts[0] || 'PD',
      department: existing.department || userDepts[0] || 'PD',
      role: isAdmin ? 'admin' : (typeof existing.role === 'string' ? existing.role : (existing.roleId || 'user').toLowerCase()),
      rolePermissions: permissions
    };
  }
  // Auto-Login fallback: Default User enriched with permissions
  const permissions = resolveUserPermissions(DEFAULT_USER);
  const isAdmin = DEFAULT_USER.roleId === 'ADMIN' || DEFAULT_USER.level >= 99 || DEFAULT_USER.username === 'admin';
  return {
    ...DEFAULT_USER,
    ...permissions,
    canonicalRole: normalizeRole(DEFAULT_USER),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    role: isAdmin ? 'admin' : (DEFAULT_USER.roleId || 'user').toLowerCase(),
    rolePermissions: permissions
  };
};

export function AppProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  // 1. Session & Auth State: Synchronized with AuthContext
  const [currentUser, setCurrentUser] = useState(() => {
    if (auth && auth.currentUser !== undefined) {
      return auth.currentUser;
    }
    return getInitialUserSession();
  });
  const [currentRole, setCurrentRole] = useState(() => currentUser);

  // Sync with AuthContext when auth.currentUser changes (e.g. login/logout)
  useEffect(() => {
    if (auth && auth.currentUser !== undefined) {
      setCurrentUser(auth.currentUser);
      setCurrentRole(auth.currentUser ? { ...auth.currentUser, canonicalRole: auth.canonicalRole } : null);
    }
  }, [auth?.currentUser, auth?.canonicalRole]);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Available registered users for Fast Account Switcher
  const [users, setUsers] = useState([]);
  const availableUsers = useMemo(() => {
    if (users.length > 0) return users;
    const registered = authService.getRegisteredUsers() || [];
    return registered.length > 0 ? registered : DEFAULT_EMPLOYEE_ACCOUNTS;
  }, [users]);

  // 2. Operational Data States
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [storageLocations, setStorageLocations] = useState([]);
  const [usageUnits, setUsageUnits] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [prs, setPRs] = useState([]);
  const [pos, setPOs] = useState([]);
  const [stockLogs, setStockLogs] = useState([]);
  const [budgetSummary, setBudgetSummary] = useState(null);
  const [budgetTransactions, setBudgetTransactions] = useState([]);

  // 3. Selection, Modal & Draft States
  const [preselectedProduct, setPreselectedProduct] = useState(null);
  const [editingPR, setEditingPR] = useState(null);
  const [selectedPRForModal, setSelectedPRForModal] = useState(null);
  const [selectedPOForModal, setSelectedPOForModal] = useState(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // ── Full Data Hydration on Mount & Refresh (Full-Stack Speed Optimization) ──
  const loadAllData = useCallback(async (silent = false) => {
    // 1. อ่านข้อมูลล่าสุดจาก localStorage มาเรนเดอร์ขึ้นหน้าจอทันที เพื่อไม่ให้หน้าจอขาวค้าง (0ms Instant Render)
    try {
      storageService.hydrateFromClientStorage?.();
      const cachedProds = storageService.getProducts() || [];
      const cachedVendors = storageService.getVendors() || [];
      const cachedLocs = storageService.getStorageLocations() || [];
      const cachedUnits = storageService.getUsageUnits() || [];
      const cachedDepts = storageService.getDepartments() || [];
      const cachedUsers = storageService.getUsers() || [];
      const cachedPRs = storageService.getPRs() || [];
      const cachedPOs = storageService.getPOs() || [];
      const cachedLogs = storageService.getStockLogs() || [];
      const cachedTxs = storageService.getBudgetTransactions() || [];

      if (cachedProds.length > 0) setProducts(getUnifiedProductList(cachedProds));
      if (cachedVendors.length > 0) setVendors(cachedVendors);
      if (cachedLocs.length > 0) setStorageLocations(cachedLocs);
      if (cachedUnits.length > 0) setUsageUnits(cachedUnits);
      if (cachedDepts.length > 0) setDepartments(cachedDepts);
      if (cachedUsers.length > 0) setUsers(cachedUsers);
      if (cachedPRs.length > 0) setPRs(cachedPRs);
      if (cachedPOs.length > 0) setPOs(cachedPOs);
      if (cachedLogs.length > 0) setStockLogs(cachedLogs);
      if (cachedTxs.length > 0) setBudgetTransactions(cachedTxs);
      
      const cachedSummary = workflowEngine.calculateBudgetSummary();
      if (cachedSummary) setBudgetSummary(cachedSummary);

      // Unblock UI immediately: render cached data so screen never freezes or whites out
      setIsLoading(false);
    } catch (e) {
      console.warn('[AppContext] Instant cache hydration warning:', e);
      setIsLoading(false);
    }

    // 2. ยุบฟังก์ชันตอนเริ่มต้นระบบ ให้เรียก apiGetBootstrapData() เพียงคำขอเดียวแทนการยิงแยกย่อย
    try {
      if (!silent) setIsDataLoading(true);
      const bootstrapData = await apiService.getBootstrapData();
      
      if (bootstrapData && typeof bootstrapData === 'object') {
        const {
          prs: prsData,
          pos: posData,
          inventory: invData,
          products: prodsData,
          stockLogs: logsData,
          users: usersData,
          departments: deptsData,
          vendors: vendorsData,
          storageLocations: locsData,
          usageUnits: unitsData,
          budgetTransactions: txsData
        } = bootstrapData;

        // Prioritize master products list (prodsData), enrich with inventory stock (invData)
        const prodsList = Array.isArray(prodsData) && prodsData.length > 0
          ? prodsData
          : (Array.isArray(invData) ? invData : []);
        const invList = Array.isArray(invData) ? invData : [];
        if (prodsList.length > 0) {
          const unified = getUnifiedProductList(prodsList, invList);
          setProducts(unified);
          storageService.saveProducts(unified);
        }
        if (Array.isArray(vendorsData)) {
          setVendors(vendorsData);
        }
        if (Array.isArray(locsData)) {
          setStorageLocations(locsData);
        }
        if (Array.isArray(unitsData)) {
          setUsageUnits(unitsData);
        }
        if (Array.isArray(deptsData)) {
          setDepartments(deptsData);
        }
        if (Array.isArray(prsData)) {
          const seenPRKeys = new Set();
          const uniquePRs = prsData.filter(item => {
            const idKey = item.id;
            const noKey = item.prNo || item.prNumber;
            if ((idKey && seenPRKeys.has(idKey)) || (noKey && seenPRKeys.has(noKey))) return false;
            if (idKey) seenPRKeys.add(idKey);
            if (noKey) seenPRKeys.add(noKey);
            return true;
          });
          setPRs(uniquePRs);
        }
        if (Array.isArray(posData)) {
          const seenPOKeys = new Set();
          const uniquePOs = posData.filter(item => {
            const idKey = item.id;
            const noKey = item.poNo || item.poNumber;
            if ((idKey && seenPOKeys.has(idKey)) || (noKey && seenPOKeys.has(noKey))) return false;
            if (idKey) seenPOKeys.add(idKey);
            if (noKey) seenPOKeys.add(noKey);
            return true;
          }).map(po => {
            return {
              ...po,
              items: typeof po.items === 'string' ? JSON.parse(po.items || '[]') : (po.items || [])
            };
          });
          setPOs(uniquePOs);
        }
        if (Array.isArray(logsData)) {
          setStockLogs(logsData);
        }
        if (Array.isArray(txsData)) {
          setBudgetTransactions(txsData);
        }
        if (Array.isArray(usersData) && usersData.length > 0) {
          setUsers(usersData);
          setCurrentUser(prevUser => {
            if (!prevUser) return prevUser;
            const fresh = usersData.find(u => u.id === prevUser.id || u.username === prevUser.username);
            if (fresh) {
              const permissions = resolveUserPermissions(fresh);
              const isAdmin = fresh.roleId === 'ADMIN' || fresh.level >= 99 || fresh.username === 'admin';
              const cleanDepts = getUserDepartments(fresh);
              const userDepts = cleanDepts.length > 0 ? cleanDepts : (fresh.department ? [fresh.department] : ['PD']);
              const updatedSession = { 
                ...prevUser, 
                ...fresh, 
                ...permissions, 
                departments: userDepts,
                assignedDepartments: fresh.assignedDepartments || userDepts,
                allowedDepartments: fresh.allowedDepartments || userDepts,
                primaryDepartment: fresh.primaryDepartment || userDepts[0] || 'PD',
                department: fresh.department || userDepts[0] || 'PD',
                role: isAdmin ? 'admin' : (fresh.roleId || 'user').toLowerCase(),
                rolePermissions: permissions 
              };
              setCurrentRole(updatedSession);
              try { localStorage.setItem('prpo_auth_session', JSON.stringify(updatedSession)); } catch {}
              return updatedSession;
            }
            return prevUser;
          });
        }
        if (Array.isArray(notisData) && notisData.length > 0) {
          const userName = currentUser?.name || currentUser?.username || currentRole?.name || currentRole?.username;
          const readIds = notificationService.getReadNotificationIds(userName);
          const localNotifs = notificationService.getAll();
          const localReadMap = new Map();
          readIds.forEach(id => localReadMap.set(id, true));
          localNotifs.forEach(n => {
            if (n.isRead === true || n.read === true || n.status === 'read') {
              localReadMap.set(n.id || n._id, true);
            }
          });
          const merged = notisData.map(n => {
            if (localReadMap.has(n.id || n._id)) {
              return { ...n, isRead: true, read: true, status: 'read' };
            }
            return n;
          });
          setNotifications(merged);
          notificationService.saveAll(merged);
        } else {
          setNotifications(notificationService.getAll());
        }

        const bSummary = workflowEngine.calculateBudgetSummary();
        setBudgetSummary(bSummary || null);
      }
    } catch (err) {
      console.error('[AppContext] Error loading bootstrap data:', err);
    } finally {
      if (!silent) setIsDataLoading(false);
      setIsLoading(false);
    }
  }, []);

  // Backward compatible alias
  const refreshData = loadAllData;
  const initAppData = loadAllData;

  // Standalone fetchers ensuring clean overwrite without duplicate accumulation
  const fetchPRs = useCallback(async () => {
    try {
      const prData = await apiService.getPRs();
      const seenPRKeys = new Set();
      const uniquePRs = (prData || []).filter(item => {
        const idKey = item.id;
        const noKey = item.prNo || item.prNumber;
        if ((idKey && seenPRKeys.has(idKey)) || (noKey && seenPRKeys.has(noKey))) {
          return false;
        }
        if (idKey) seenPRKeys.add(idKey);
        if (noKey) seenPRKeys.add(noKey);
        return true;
      });
      setPRs(uniquePRs);
      return uniquePRs;
    } catch (err) {
      console.error('[AppContext] Error fetching PRs:', err);
      return [];
    }
  }, []);

  const fetchPOs = useCallback(async () => {
    try {
      const poData = await apiService.getPOs();
      const seenPOKeys = new Set();
      const uniquePOs = (poData || []).filter(item => {
        const idKey = item.id;
        const noKey = item.poNo || item.poNumber;
        if ((idKey && seenPOKeys.has(idKey)) || (noKey && seenPOKeys.has(noKey))) {
          return false;
        }
        if (idKey) seenPOKeys.add(idKey);
        if (noKey) seenPOKeys.add(noKey);
        return true;
      });
      setPOs(uniquePOs);
      return uniquePOs;
    } catch (err) {
      console.error('[AppContext] Error fetching POs:', err);
      return [];
    }
  }, []);

  // Initial Data Hydration on Component Mount (Strictly runs once on mount)
  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // Subscribe to background revalidation (Stale-While-Revalidate)
  useEffect(() => {
    const unsub = storageService.subscribe?.((event, payload) => {
      if (event === 'revalidate' && payload && typeof payload === 'object') {
        if (Array.isArray(payload.products)) setProducts(getUnifiedProductList(payload.products, payload.inventory || []));
        if (Array.isArray(payload.vendors)) setVendors(payload.vendors);
        if (Array.isArray(payload.storageLocations)) setStorageLocations(payload.storageLocations);
        if (Array.isArray(payload.usageUnits)) setUsageUnits(payload.usageUnits);
        if (Array.isArray(payload.departments)) setDepartments(payload.departments);
        if (Array.isArray(payload.users) && payload.users.length > 0) {
          setUsers(payload.users);
          setCurrentUser(prevUser => {
            if (!prevUser) return prevUser;
            const fresh = payload.users.find(u => u.id === prevUser.id || u.username === prevUser.username);
            if (fresh) {
              const permissions = resolveUserPermissions(fresh);
              const isAdmin = fresh.roleId === 'ADMIN' || fresh.level >= 99 || fresh.username === 'admin';
              const cleanDepts = getUserDepartments(fresh);
              const userDepts = cleanDepts.length > 0 ? cleanDepts : (fresh.department ? [fresh.department] : ['PD']);
              const updatedSession = { 
                ...prevUser, 
                ...fresh, 
                ...permissions, 
                departments: userDepts,
                assignedDepartments: fresh.assignedDepartments || userDepts,
                allowedDepartments: fresh.allowedDepartments || userDepts,
                primaryDepartment: fresh.primaryDepartment || userDepts[0] || 'PD',
                department: fresh.department || userDepts[0] || 'PD',
                role: isAdmin ? 'admin' : (fresh.roleId || 'user').toLowerCase(),
                rolePermissions: permissions 
              };
              setCurrentRole(updatedSession);
              try { localStorage.setItem('prpo_auth_session', JSON.stringify(updatedSession)); } catch {}
              return updatedSession;
            }
            return prevUser;
          });
        }
        if (Array.isArray(payload.prs)) {
          const seenPRKeys = new Set();
          const uniquePRs = payload.prs.filter(item => {
            const idKey = item.id;
            const noKey = item.prNo || item.prNumber;
            if ((idKey && seenPRKeys.has(idKey)) || (noKey && seenPRKeys.has(noKey))) return false;
            if (idKey) seenPRKeys.add(idKey);
            if (noKey) seenPRKeys.add(noKey);
            return true;
          });
          setPRs(uniquePRs);
        }
        if (Array.isArray(payload.pos)) {
          const seenPOKeys = new Set();
          const uniquePOs = payload.pos.filter(item => {
            const idKey = item.id;
            const noKey = item.poNo || item.poNumber;
            if ((idKey && seenPOKeys.has(idKey)) || (noKey && seenPOKeys.has(noKey))) return false;
            if (idKey) seenPOKeys.add(idKey);
            if (noKey) seenPOKeys.add(noKey);
            return true;
          });
          setPOs(uniquePOs);
        }
        if (Array.isArray(payload.stockLogs)) setStockLogs(payload.stockLogs);
        if (Array.isArray(payload.budgetTransactions)) setBudgetTransactions(payload.budgetTransactions);
        if (Array.isArray(payload.notifications)) {
          setNotifications(payload.notifications);
        }
        const bSummary = workflowEngine.calculateBudgetSummary();
        if (bSummary) setBudgetSummary(bSummary);
        setIsDataLoading(false);
      }
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Synchronize current role to storageService without triggering circular data fetch
  useEffect(() => {
    if (currentUser) {
      storageService.setCurrentRole(currentUser);
    }
  }, [currentUser]);

  /**
   * Fast Account Switcher:
   * Swaps user instantly, synchronizes localStorage, checks page permissions,
   * and auto-redirects to safe page if target user lacks access to current route.
   */
  const handleSwitchUser = useCallback((targetUserIdOrObject) => {
    let targetUser = null;

    if (typeof targetUserIdOrObject === 'string') {
      targetUser = availableUsers.find(u => 
        u.id === targetUserIdOrObject || 
        u.username === targetUserIdOrObject ||
        u.roleId === targetUserIdOrObject ||
        u.positionKey === targetUserIdOrObject
      );
    } else if (targetUserIdOrObject && typeof targetUserIdOrObject === 'object') {
      targetUser = targetUserIdOrObject;
    }

    if (!targetUser) {
      modalService.error('ไม่พบบัญชีผู้ใช้งานที่ต้องการสลับ');
      return;
    }

    const permissions = resolveUserPermissions(targetUser);
    const isAdmin = targetUser.roleId === 'ADMIN' || targetUser.level >= 99 || targetUser.username === 'admin';
    const cleanUserDepts = getUserDepartments(targetUser);
    const userDepts = cleanUserDepts.length > 0 ? cleanUserDepts : (targetUser.department ? [targetUser.department] : ['PD']);
    const newSession = {
      ...targetUser,
      ...permissions,
      canonicalRole: normalizeRole(targetUser),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      departments: userDepts,
      assignedDepartments: targetUser.assignedDepartments || userDepts,
      allowedDepartments: targetUser.allowedDepartments || userDepts,
      primaryDepartment: targetUser.primaryDepartment || userDepts[0] || 'PD',
      department: targetUser.department || userDepts[0] || 'PD',
      role: isAdmin ? 'admin' : (targetUser.roleId || 'user').toLowerCase(),
      rolePermissions: permissions
    };

    // 1. Update global state
    setCurrentUser(newSession);
    setCurrentRole(newSession);

    // 2. Persist to storage
    localStorage.setItem('prpo_auth_session', JSON.stringify(newSession));
    storageService.setCurrentRole(newSession);

    modalService.success('สลับผู้ใช้งานสำเร็จ', `ยินดีต้อนรับ ${newSession.name} (${newSession.title})`);

    // 3. Dynamic Route Safety & Permission check on current path
    const currentPath = location.pathname;
    const isTargetOnlinePurchaser = newSession.roleId === 'ONLINE_PURCHASER' || newSession.id === 'ONLINE_PURCHASER';

    // Disallowed routes for online purchaser
    if (isTargetOnlinePurchaser && (
      currentPath.includes('/my-workspace') ||
      currentPath.includes('/my-work') ||
      currentPath.includes('/master-data') || 
      currentPath.includes('/prs/create') ||
      currentPath.includes('/quick-issue') ||
      currentPath.includes('/inventory/quick-issue') ||
      currentPath.includes('/audit-logs')
    )) {
      navigate('/dashboard', { replace: true });
      return;
    }

    // Disallowed routes for non-online users trying to access online-tasks
    if (!newSession.canOnlinePurchase && currentPath.includes('/online-tasks')) {
      navigate('/dashboard', { replace: true });
      return;
    }

    // Disallowed routes for users without budget permissions (allow ONLINE_PURCHASER)
    if (!newSession.canViewBudget && !isTargetOnlinePurchaser && currentPath.includes('/budget')) {
      navigate('/dashboard', { replace: true });
      return;
    }

    // Disallowed routes for users without master data permissions
    if (!newSession.canManageMaster && currentPath.includes('/master-data')) {
      navigate('/dashboard', { replace: true });
      return;
    }
  }, [availableUsers, location.pathname, navigate]);

  // Clear session and navigate to /login
  const handleLogout = useCallback(() => {
    try {
      localStorage.removeItem('prpo_auth_session');
      localStorage.removeItem('prpo_current_user');
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.clear();
      }
    } catch (e) {
      console.warn('[AppContext] Error clearing session:', e);
    }

    setCurrentUser(null);
    setCurrentRole(null);

    if (auth?.logout) {
      auth.logout();
    }

    navigate('/login', { replace: true });
  }, [auth, navigate]);

  // Unified onNavigate adapter: translates legacy view IDs or accepts direct paths
  const onNavigate = useCallback((target) => {
    if (!target) return;
    const resolvedPath = VIEW_PATH_MAP[target] || (target.startsWith('/') ? target : `/${target}`);
    
    // Reset temporary draft state when leaving create page
    if (!resolvedPath.includes('/prs/create') && target !== 'pr-create') {
      setEditingPR(null);
      setPreselectedProduct(null);
    }

    navigate(resolvedPath);
  }, [navigate]);

  // Action: Open Quick PR with preselected product
  const handleQuickPR = useCallback((product) => {
    setEditingPR(null);
    setPreselectedProduct(product);
    navigate('/prs/create');
  }, [navigate]);

  // Action: Edit existing PR
  const handleEditPR = useCallback((pr) => {
    setSelectedPRForModal(null);
    setPreselectedProduct(null);
    setEditingPR(pr);
    navigate('/prs/create');
  }, [navigate]);

  // Action: Deep-link PR Details Modal from notifications
  const handleOpenPRById = useCallback((prId) => {
    const found = prs.find(p => p.id === prId);
    if (found) {
      setSelectedPRForModal(found);
    } else {
      navigate('/prs');
    }
  }, [prs, navigate]);

  // Action: Deep-link PO Details Modal from notifications
  const handleOpenPOById = useCallback((poId) => {
    const found = pos.find(p => p.id === poId);
    if (found) {
      setSelectedPOForModal(found);
    } else {
      navigate('/pos');
    }
  }, [pos, navigate]);

  // ── Operational & Workflow Mutations (Non-blocking High Performance) ──
  const handleCreatePR = useCallback(async (prPayload, isDraft = false) => {
    const newPR = await apiService.createPR(prPayload, currentRole, isDraft);
    if (newPR) {
      // Directive 3: Prevent Overwrite during save - Check if newPR.id already exists
      setPRs(prev => {
        const idx = prev.findIndex(p => p.id === newPR.id || (newPR.prNo && p.prNo === newPR.prNo));
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = newPR;
          return updated;
        }
        // Create Mode: STRICTLY Prepend as new row, never overwrite existing index
        return [newPR, ...prev];
      });
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return newPR;
  }, [currentRole, loadAllData]);

  const handleUpdatePR = useCallback(async (prId, prPayload, isDraft = false) => {
    const updated = await apiService.updatePR(prId, prPayload, currentRole, isDraft);
    if (updated) {
      setPRs(prev => prev.map(p => 
        (p.id === prId || p.prNo === prId || (updated.id && p.id === updated.id) || (updated.prNo && p.prNo === updated.prNo))
          ? { ...p, ...updated }
          : p
      ));
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return updated;
  }, [currentRole, loadAllData]);

  const handleRejectPR = useCallback(async (prId, reason) => {
    const result = await apiService.rejectPR(prId, currentRole, reason);
    if (result) {
      setPRs(prev => prev.map(p => 
        (p.id === prId || p.prNo === prId || (result.id && p.id === result.id) || (result.prNo && p.prNo === result.prNo))
          ? { ...p, ...result }
          : p
      ));
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return result;
  }, [currentRole, loadAllData]);

  const handleReviewPR = useCallback(async (prId, note = '') => {
    const result = await apiService.updatePRStatus(prId, 'REVIEWED', currentRole, note);
    if (result?.pr) {
      setPRs(prev => prev.map(p => 
        (p.id === prId || p.prNo === prId || (result.pr.id && p.id === result.pr.id) || (result.pr.prNo && p.prNo === result.pr.prNo))
          ? { ...p, ...result.pr }
          : p
      ));
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return result;
  }, [currentRole, loadAllData]);

  const handleApprovePR = useCallback(async (prId, note = '') => {
    const result = await apiService.updatePRStatus(prId, 'APPROVED', currentRole, note);
    if (result?.pr) {
      setPRs(prev => prev.map(p => 
        (p.id === prId || p.prNo === prId || (result.pr.id && p.prNo === result.pr.prNo))
          ? { ...p, ...result.pr }
          : p
      ));
    }
    if (result?.po) {
      const poList = Array.isArray(result.po) ? result.po : [result.po];
      setPOs(prev => [...poList, ...prev]);
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return result;
  }, [currentRole, loadAllData]);

  const handleCancelPR = useCallback(async (prId, reason) => {
    const result = await apiService.cancelPR(prId, currentRole, reason);
    if (result) {
      setPRs(prev => prev.map(p => 
        (p.id === prId || p.prNo === prId || (result.id && p.id === result.id) || (result.prNo && p.prNo === result.prNo))
          ? { ...p, ...result }
          : p
      ));
    }
    setTimeout(() => { loadAllData(true); }, 1000);
    return result;
  }, [currentRole, loadAllData]);

  // Immutable PO updater in state with storage persistence
  const updatePO = useCallback((poId, updates) => {
    setPOs(prev => prev.map(item => 
      (item.id === poId || item.poNo === poId || item.poNumber === poId) 
        ? { ...item, ...updates } 
        : item
    ));
    const allPos = storageService.getPOs() || [];
    const idx = allPos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    if (idx !== -1) {
      allPos[idx] = { ...allPos[idx], ...updates };
      storageService.savePOs(allPos);
    }
  }, []);

  // Immutable PR updater in state with cascading support
  const updatePR = useCallback((prId, updates, isDraft = false) => {
    setPRs(prev => prev.map(item => 
      (item.id === prId || item.prNo === prId || item.prNumber === prId) 
        ? { ...item, ...(typeof updates === 'object' ? updates : {}) } 
        : item
    ));
    if (typeof updates === 'object') {
      if (updates.items) {
        return apiService.updatePR(prId, updates, currentRole, isDraft)
          .then(res => {
            if (res) {
              setPRs(prev => prev.map(p => (p.id === prId || p.prNo === prId) ? { ...p, ...res } : p));
            }
            setTimeout(() => loadAllData(true), 1000);
          })
          .catch(e => console.warn(e));
      } else if (updates.status) {
        return apiService.updatePRStatus(prId, updates.status, currentRole)
          .then(res => {
            if (res?.pr) {
              setPRs(prev => prev.map(p => (p.id === prId || p.prNo === prId) ? { ...p, ...res.pr } : p));
            }
            setTimeout(() => loadAllData(true), 1000);
          })
          .catch(e => console.warn(e));
      }
    }
  }, [currentRole, loadAllData]);

  const handleReceiveGoods = useCallback(async (poId, receivingItems, note = '', options = {}) => {
    const grNumber = options?.grNumber || options?.grId || `GR-${poId}-${Date.now()}`;
    const enrichedOptions = { ...options, grNumber, grId: grNumber };

    const result = await apiService.receiveGoods(poId, receivingItems, currentRole, note, enrichedOptions);
    const freshPOs = storageService.getPOs();
    if (freshPOs) setPOs([...freshPOs]);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentRole, loadAllData]);

  const handleRecordGoodsReceipt = useCallback(async (poId, grnPayload) => {
    const currentPOs = storageService.getPOs() || [];
    const targetIdx = currentPOs.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    if (targetIdx === -1) {
      throw new Error(`ไม่พบเอกสาร PO รหัส ${poId} ในระบบ`);
    }

    const currentPO = { ...currentPOs[targetIdx] };
    const currentItems = Array.isArray(currentPO.items) ? [...currentPO.items] : [];
    const incomingItems = grnPayload.receivingItems || grnPayload.items || [];

    const receiptMap = new Map();
    incomingItems.forEach((inc, idx) => {
      const key = inc.productId || inc.id || inc.code || String(idx);
      receiptMap.set(key, inc);
    });

    let hasAnyShortage = false;
    let hasAnyClaim = false;
    let allReceived = true;
    const roundSummary = [];

    const updatedItems = currentItems.map((item, idx) => {
      const matchKey = item.productId || item.id || item.code || String(idx);
      const inc = receiptMap.get(matchKey) || receiptMap.get(item.productId) || {};

      const itemStore = (item.actualStoreName || item.storeName || '').trim();
      const storeClaims = currentPO?.storeClaims || {};
      let storeClaim = (item.storeKey && storeClaims[item.storeKey]) || 
        (itemStore && storeClaims[itemStore]) || 
        (item.storePlatform && itemStore && storeClaims[`${item.storePlatform}_${itemStore}`]);

      if (!storeClaim && itemStore) {
        const normStore = itemStore.toLowerCase();
        for (const [k, c] of Object.entries(storeClaims)) {
          if (k.toLowerCase() === normStore || k.toLowerCase().includes(normStore) || normStore.includes(k.toLowerCase())) {
            storeClaim = c;
            break;
          }
        }
      }

      const isStoreRefunded = Boolean(
        storeClaim?.isResolved && 
        (storeClaim?.type === 'REFUND' || storeClaim?.actionType === 'REFUND' || storeClaim?.resolutionType === 'REFUND' || storeClaim?.type === 'CLOSE_WITH_REFUND' || String(storeClaim?.note || '').includes('คืนเงิน'))
      );

      const orderedQty = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
      const prevReceived = Number(item.accumulatedReceived ?? item.receivedQty) || 0;
      const prevDamaged = Number(item.damagedQty ?? item.claimedQty ?? item.ngQty) || 0;

      let refundedQty = Number(item.refundedQty || 0);
      if (refundedQty === 0 && (item.claimResolution === 'REFUND' || isStoreRefunded)) {
        refundedQty = Number(item.damagedQty || item.shortageQty || Math.max(0, orderedQty - prevReceived));
      }

      const unitPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? 0);
      const refundAmount = Number(item.refundAmount || storeClaim?.refundAmount || (refundedQty * unitPrice));
      const isItemRefunded = refundedQty > 0 || isStoreRefunded || item.claimResolution === 'REFUND';

      const allowedReceiveQty = Math.max(0, orderedQty - prevReceived - refundedQty);

      let thisReceived = inc.goodQty !== undefined 
        ? Number(inc.goodQty) 
        : (inc.acceptedQty !== undefined 
            ? Number(inc.acceptedQty) 
            : Number(inc.receivedThisTime ?? inc.receivedQty ?? inc.qty ?? 0));
      let thisDamaged = Number(inc.damagedQty ?? inc.claimedQty ?? inc.ngQty) || 0;

      if (allowedReceiveQty === 0) {
        thisReceived = 0;
        thisDamaged = 0;
      } else {
        thisReceived = Math.max(0, Math.min(thisReceived, allowedReceiveQty));
        thisDamaged = Math.max(0, Math.min(thisDamaged, allowedReceiveQty - thisReceived));
      }

      const newReceived = prevReceived + thisReceived;
      const newDamaged = prevDamaged + thisDamaged;
      const shortageQty = Math.max(0, orderedQty - newReceived - refundedQty - newDamaged);

      const isDamaged = newDamaged > 0;
      const disputeAction = inc.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (inc.disputeAction || ((isDamaged || (shortageQty > 0 && inc.shortageReason !== 'SPLIT_SHIPMENT')) ? 'CLAIM' : 'NONE'));
      const hasDispute = isDamaged || (shortageQty > 0 && disputeAction !== 'WAIT_NEXT_ROUND');

      if (hasDispute) hasAnyClaim = true;
      if (shortageQty > 0 || hasDispute || thisDamaged > 0 || newDamaged > 0 || (newReceived + refundedQty < orderedQty)) {
        allReceived = false;
      }
      if (shortageQty > 0) {
        hasAnyShortage = true;
      }

      roundSummary.push({
        productId: item.productId,
        name: item.name,
        code: item.code,
        orderedQty,
        receivedThisRound: thisReceived,
        damagedThisRound: thisDamaged,
        accumulatedReceived: newReceived,
        accumulatedDamaged: newDamaged,
        shortageQty,
        condition: inc.condition || (thisDamaged > 0 ? 'DAMAGED' : shortageQty > 0 ? 'SHORTAGE' : 'GOOD'),
        defectReason: inc.defectReason || inc.note || ''
      });

      const hasItemDispute = thisDamaged > 0 || (shortageQty > 0 && disputeAction !== 'WAIT_NEXT_ROUND');

      return {
        ...item,
        orderedQty,
        receivedQty: newReceived,
        goodQty: newReceived,
        acceptedQty: newReceived,
        accumulatedReceived: newReceived,
        damagedQty: newDamaged,
        shortageQty,
        remainingQty: shortageQty,
        refundedQty,
        refundAmount: refundAmount || item.refundAmount,
        isSettled: isItemRefunded ? true : (hasItemDispute ? false : item.isSettled),
        claimResolution: isItemRefunded ? 'REFUND' : (hasItemDispute ? null : item.claimResolution),
        replacementPendingQty: hasItemDispute ? 0 : item.replacementPendingQty,
        isDamaged,
        hasDispute,
        disputeAction,
        shortageReason: inc.shortageReason || item.shortageReason || '',
        defectReason: inc.defectReason || item.defectReason || '',
        conversionRate: Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1
      };
    });

    let nextStatus = currentPO.status;
    if (grnPayload.statusOverride) {
      nextStatus = grnPayload.statusOverride;
    } else if (hasAnyClaim) {
      nextStatus = 'PARTIALLY_RECEIVED_IN_CLAIM';
    } else if (hasAnyShortage) {
      // กฎเหล็ก: waitingRound2 flag ใน GRN payload ห้ามบังคับสถานะไป WAITING_DELIVERY_ROUND_2
      // WAITING_DELIVERY_ROUND_2 เกิดได้เฟ้นแฟลละงที่เดียว: Online Purchaser กด "ส่งสินค้าทดแทน" ใน Online Hub
      nextStatus = 'PARTIAL';
    } else if (allReceived) {
      nextStatus = 'COMPLETED';
    }

    const isCompletedReceipt = !hasAnyClaim && grnPayload.statusOverride !== 'CLAIM_PENDING' && (allReceived || nextStatus === 'CLOSED' || nextStatus === 'COMPLETED');
    if (isCompletedReceipt) {
      nextStatus = 'COMPLETED';
    }

    const receiptRound = grnPayload.round || (currentPO.grnHistory?.length || 0) + 1;
    const grnNumber = grnPayload.grnNumber || grnPayload.grNumber || grnPayload.grId || generateGRNNumber(currentPO.poNo || currentPO.id, receiptRound);
    const timestamp = grnPayload.receivedDate || grnPayload.date || new Date().toLocaleString('th-TH');
    const receivedAtIso = grnPayload.receivingInfo?.receivedAt || new Date().toISOString();

    const receiverName = grnPayload.receivingInfo?.receiverName || 
      (typeof grnPayload.receivedBy === 'string' ? grnPayload.receivedBy.split(' (')[0] : (grnPayload.receivedBy?.name || currentRole?.name || 'คุณวิชัย สุขใจ'));
    const receiverSig = grnPayload.receivingInfo?.receiverSignature || 
      grnPayload.receiverSignature || 
      storageService.getSignatureByRole?.(currentRole?.roleId || 'REQUESTER_PD')?.signatureUrl || 
      storageService.getSignatures?.()?.[currentRole?.roleId || 'REQUESTER_PD']?.signatureUrl || 
      '/signatures/receiver-default.png';

    const grnEntry = {
      grnNumber,
      round: grnPayload.round || (currentPO.grnHistory?.length || 0) + 1,
      date: timestamp,
      receivedBy: grnPayload.receivedBy || currentRole?.name || 'Staff',
      items: roundSummary,
      note: grnPayload.note || '',
      attachments: grnPayload.attachments || [],
      statusAfterRound: nextStatus
    };

    const updatedStoreClaims = { ...(currentPO.storeClaims || {}) };
    if (hasAnyClaim || grnPayload.statusOverride === 'CLAIM_PENDING') {
      currentItems.forEach((item, idx) => {
        const matchKey = item.productId || item.id || item.code || String(idx);
        const inc = receiptMap.get(matchKey) || receiptMap.get(item.productId) || {};
        const dam = Number(inc.damagedQty ?? inc.claimedQty ?? inc.ngQty) || 0;
        const sho = Number(inc.shortageQty) || 0;
        const sAct = inc.shortageAction || '';
        const isDisputed = dam > 0 || (sho > 0 && sAct === 'CLAIM_SHORTAGE');
        if (isDisputed) {
          const sName = (item.actualStoreName || item.storeName || currentPO.actualStoreName || currentPO.storeName || currentPO.shopName || currentPO.vendorName || '').trim();
          const plat = (item.storePlatform || item.platform || currentPO.storePlatform || currentPO.platform || 'Shopee').trim();
          const sKey = sName ? `${plat}_${sName.toLowerCase()}` : (item.storeKey || `Shopee_item_${idx}`);
          const resetEntry = {
            isResolved: false,
            status: 'PENDING_CLAIM',
            claimStatus: 'PENDING_CLAIM',
            type: null,
            actionType: null,
            reason: dam > 0 ? 'สินค้าชำรุด / แตกหักเสียหาย' : 'ร้านส่งของไม่ครบตามกล่อง (ขาดส่ง)',
            description: inc.defectReason || inc.note || '',
            defectNote: inc.defectReason || inc.note || ''
          };
          if (sKey) updatedStoreClaims[sKey] = resetEntry;
          if (sName && sName !== sKey) updatedStoreClaims[sName] = resetEntry;
        }
      });
    }

    const updatedPO = {
      ...currentPO,
      items: updatedItems,
      status: nextStatus,
      storeClaims: updatedStoreClaims,
      grnHistory: [...(currentPO.grnHistory || []), grnEntry],
      ...(hasAnyClaim || grnPayload.statusOverride === 'CLAIM_PENDING' ? {
        claimStatus: 'PENDING_CLAIM',
        hasDispute: true,
        isInClaim: true,
        hasUnresolvedClaim: true,
        isCompleted: false,
        isClosed: false
      } : {}),
      ...(grnPayload.claimEvidence ? {
        claimEvidence: grnPayload.claimEvidence,
        disputeInfo: grnPayload.claimEvidence,
        claimData: grnPayload.claimEvidence
      } : {}),
      ...(isCompletedReceipt ? {
        receivingInfo: {
          receiverName,
          receiverSignature: receiverSig,
          receivedAt: receivedAtIso
        },
        receivedBy: receiverName,
        receiverName: receiverName,
        receiverSignature: receiverSig,
        receivedAt: receivedAtIso
      } : {}),
      activityLog: [
        ...(currentPO.activityLog || []),
        {
          action: `ตรวจรับสินค้าแยกรอบ (GRN: ${grnNumber})`,
          user: typeof grnPayload.receivedBy === 'string' ? grnPayload.receivedBy : (grnPayload.receivedBy?.name || currentRole?.name || 'Staff'),
          timestamp,
          note: grnPayload.note || `บันทึกการตรวจรับรอบที่ ${grnEntry.round} สถานะเอกสาร: ${nextStatus}`
        }
      ]
    };

    currentPOs[targetIdx] = updatedPO;
    storageService.savePOs(currentPOs);
    setPOs([...currentPOs]);

    // STRICT SSOT: We no longer call apiReceivePO or apiService.receiveGoods here.
    // Stock is handled exclusively by storageService.logStockMovements.
    // PO saving is handled by the caller (e.g. ReceivingModal) via apiService.updatePO/callGAS('apiReceivePO').

    setTimeout(() => { loadAllData(true); }, 1500);
    return { success: true, po: updatedPO, grn: grnEntry };
  }, [currentRole, loadAllData]);

  const handleSaveProduct = useCallback(async (product) => {
    const rawCat = product.category || product.department || 'PD';
    const cleanDept = String(rawCat).replace(/^DEPT-/, '').trim().toUpperCase() || 'PD';
    const normalizedProduct = {
      ...product,
      category: cleanDept,
      department: cleanDept,
      dept: cleanDept
    };

    const targetId = String(normalizedProduct.id || '').trim().toLowerCase();
    const targetCode = String(normalizedProduct.code || '').trim().toLowerCase();
    const targetDept = cleanDept;

    setProducts(prev => {
      const idx = prev.findIndex(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        // Priority 1: Match by item.id
        if (targetId && pId) return pId === targetId;
        // Priority 2: Match by item.code strictly within the same department
        const pCode = String(p.code || '').trim().toLowerCase();
        const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
        return targetCode && pCode === targetCode && (!targetDept || !pDept || pDept === targetDept);
      });
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...normalizedProduct };
        return next;
      }
      return [normalizedProduct, ...prev];
    });
    const saved = await apiService.saveProduct(normalizedProduct, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentRole, loadAllData]);

  const handleDeleteProduct = useCallback(async (productId, productDept = null) => {
    const targetStr = String(productId || '').trim().toLowerCase();
    const cleanDept = productDept ? String(productDept).replace(/^DEPT-/, '').trim().toUpperCase() : null;
    setProducts(prev => prev.filter(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      // Primary matching by item.id ALWAYS:
      if (pId) return pId !== targetStr;
      const pCode = String(p.code || '').trim().toLowerCase();
      const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      if (cleanDept && pDept && pDept !== cleanDept) return true;
      return pCode !== targetStr;
    }));
    const result = await apiService.deleteProduct(productId, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentRole, loadAllData]);

  const handleSaveVendor = useCallback(async (vendor) => {
    const targetId = String(vendor.id || '').trim().toLowerCase();
    const targetCode = String(vendor.code || '').trim().toLowerCase();
    const targetDept = String(vendor.department || vendor.dept || vendor.category || '').replace(/^DEPT-/, '').trim().toUpperCase();

    setVendors(prev => {
      const idx = prev.findIndex(v => {
        const vId = String(v.id || '').trim().toLowerCase();
        // Priority 1: Match by vendor.id
        if (targetId && vId) return vId === targetId;
        // Priority 2: Match by vendor.code within same department scope
        const vCode = String(v.code || '').trim().toLowerCase();
        const vDept = String(v.department || v.dept || v.category || '').replace(/^DEPT-/, '').trim().toUpperCase();
        return targetCode && vCode === targetCode && (!targetDept || !vDept || vDept === targetDept || vDept === 'ALL' || targetDept === 'ALL');
      });
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...vendor };
        return next;
      }
      return [vendor, ...prev];
    });
    const saved = await apiService.saveVendor(vendor, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentRole, loadAllData]);

  const handleDeleteVendor = useCallback(async (vendorId) => {
    const targetStr = String(vendorId || '').trim().toLowerCase();
    setVendors(prev => prev.filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      return vId !== targetStr && vCode !== targetStr;
    }));
    const result = await apiService.deleteVendor(vendorId, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentRole, loadAllData]);

  const handleSaveStorageLocation = useCallback(async (location) => {
    const saved = await apiService.saveStorageLocation(location, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentRole, loadAllData]);

  const handleDeleteStorageLocation = useCallback(async (locationId, options) => {
    const result = await apiService.deleteStorageLocation(locationId, options, currentRole);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentRole, loadAllData]);

  const getUsageUnits = useCallback((department) => {
    if (!department || department === 'ALL') return usageUnits;
    return usageUnits.filter(u => u.department === department);
  }, [usageUnits]);

  const handleSaveUsageUnit = useCallback(async (unit) => {
    const saved = await apiService.saveUsageUnit(unit, currentRole?.name || currentUser?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentRole, currentUser, loadAllData]);

  const handleDeleteUsageUnit = useCallback(async (unitId) => {
    const result = await apiService.deleteUsageUnit(unitId, currentRole?.name || currentUser?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentRole, currentUser, loadAllData]);

  const handleSaveDepartment = useCallback(async (deptPayload) => {
    const saved = await apiService.saveDepartment(deptPayload, currentUser?.name || currentRole?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentUser, currentRole, loadAllData]);

  const handleDeleteDepartment = useCallback(async (deptId) => {
    const result = await apiService.deleteDepartment(deptId, currentUser?.name || currentRole?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentUser, currentRole, loadAllData]);

  const handleSaveUser = useCallback(async (userPayload) => {
    const saved = await apiService.saveUser(userPayload, currentUser?.name || currentRole?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return saved;
  }, [currentUser, currentRole, loadAllData]);

  const handleDeleteUser = useCallback(async (userId) => {
    const result = await apiService.deleteUser(userId, currentUser?.name || currentRole?.name);
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentUser, currentRole, loadAllData]);

  const handleUpdateBudget = useCallback(async (department, newAmount, targetMonth) => {
    const updated = await apiService.updateBudget(department, newAmount, targetMonth);
    setTimeout(() => { loadAllData(true); }, 1500);
    return updated;
  }, [loadAllData]);

  const handleAdjustBudget = useCallback(async (params) => {
    const actor = currentUser?.name || currentRole?.name || 'ผู้ดูแลระบบ';
    const result = await apiService.adjustBudget({ ...params, actor });
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentUser, currentRole, loadAllData]);

  const handleRefundBudget = useCallback(async (department, amount, reason = 'เงินคืนจากการเคลมสินค้า') => {
    if (!department || !amount || Number(amount) <= 0) return;
    const actor = currentUser?.name || currentRole?.name || 'Online Purchaser';
    const deptBudgets = storageService.getBudgets();
    const prev = Number(deptBudgets[department]?.monthlyBudget || 0);
    const result = await apiService.adjustBudget({
      dept: department,
      action: 'TOP_UP',
      delta: Number(amount),
      previousAmount: prev,
      reason,
      actor
    });
    setTimeout(() => { loadAllData(true); }, 1500);
    return result;
  }, [currentUser, currentRole, loadAllData]);

  const handleRollbackBudget = useCallback(async (department, refundAmount, reason = 'คืนงบประมาณจากการตรวจรับ/เคลมสินค้า', options = {}) => {
    const dept = (department || 'PD').toUpperCase();
    const amount = Number(refundAmount);
    if (!amount || amount <= 0) {
      throw new Error('ยอดเงินคืนงบประมาณต้องมากกว่า 0 บาท');
    }

    const budgets = storageService.getBudgets();
    if (!budgets[dept]) {
      budgets[dept] = { monthlyBudget: 0, spent: 0, actualExpense: 0, pending: 0, variance: 0, history: {}, historicalSpent: {}, refundCredits: {} };
    }

    const currentSpent = Number(budgets[dept].spent ?? budgets[dept].actualExpense ?? 0);
    const newSpent = Math.max(0, currentSpent - amount);

    budgets[dept].spent = newSpent;
    budgets[dept].actualExpense = newSpent;

    const monthly = Number(budgets[dept].monthlyBudget || 0);
    const prevVariance = budgets[dept].variance !== undefined ? Number(budgets[dept].variance) : (monthly - currentSpent);
    const newVariance = prevVariance + amount;

    budgets[dept].variance = newVariance;
    budgets[dept].remainingBudget = newVariance;

    const today = new Date();
    const targetMonth = options.targetMonth || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    if (!budgets[dept].refundCredits) budgets[dept].refundCredits = {};
    budgets[dept].refundCredits[targetMonth] = (Number(budgets[dept].refundCredits[targetMonth]) || 0) + amount;

    storageService.saveBudgets(budgets);

    const tx = {
      id: `BTX-ROLLBACK-${Date.now()}`,
      date: today.toISOString().replace('T', ' ').slice(0, 19),
      createdAt: today.toISOString(),
      dept,
      type: 'BUDGET_ROLLBACK',
      typeLabel: 'คืนงบประมาณ (Budget Reversal)',
      previousAmount: currentSpent,
      newAmount: newSpent,
      amount,
      delta: amount,
      actor: options.actor || currentRole?.name || currentUser?.name || 'Budget Specialist',
      refDocNo: options.refDocNo || options.docNo || '',
      note: reason || 'คืนงบประมาณจากการตรวจรับสินค้า / สินค้าชำรุดเสียหาย',
      targetMonth
    };

    storageService.appendBudgetTransaction(tx);

    try {
      await apiService.adjustBudget({
        dept,
        action: 'BUDGET_ROLLBACK',
        previousAmount: currentSpent,
        newAmount: newSpent,
        delta: amount,
        reason,
        actor: tx.actor,
        targetMonth
      });
    } catch {}

    setTimeout(() => { loadAllData(true); }, 1500);
    return {
      success: true,
      department: dept,
      refundAmount: amount,
      actualExpense: newSpent,
      remainingBudget: newVariance,
      transaction: tx
    };
  }, [currentRole, currentUser, loadAllData]);

  const handleReceiveToStock = useCallback(async (items, options = {}) => {
    const incoming = Array.isArray(items) ? items : [items];
    const prods = storageService.getProducts() || [];
    const logs = storageService.getStockLogs() || [];
    const timestamp = options.date || new Date().toLocaleString('th-TH');
    const isoTimestamp = new Date().toISOString();

    const processedItems = [];

    incoming.forEach((item, idx) => {
      const orderedQty = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
      const receivedQty = Number(item.receivedThisTime ?? item.receivedQty ?? item.qty) || 0;
      const damagedQty = Number(item.damagedQty ?? item.claimedQty ?? item.ngQty) || 0;

      const goodQty = Math.max(0, receivedQty - damagedQty);
      if (goodQty <= 0) return;

      const tId = String(item.productId || item.id || '').trim().toLowerCase();
      const tCode = String(item.code || item.productCode || '').trim().toLowerCase();
      const tDept = String(item.department || item.category || item.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      const tName = String(item.name || '').trim().toLowerCase();

      const prodIdx = prods.findIndex(p => {
        if (!p) return false;
        const pId = String(p.id || '').trim().toLowerCase();
        // Priority 1: Match by ID
        if (tId && pId && pId === tId) return true;

        const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
        const isSameDept = !tDept || !pDept || pDept === tDept;

        // Priority 2: Match by Code (scoped to department)
        const pCode = String(p.code || '').trim().toLowerCase();
        if (tCode && pCode && pCode === tCode && isSameDept) return true;

        // Priority 3: Match by Name (scoped to department)
        const pName = String(p.name || '').trim().toLowerCase();
        if (tName && pName && pName === tName && isSameDept) return true;

        return false;
      });

      if (prodIdx !== -1) {
        const prod = { ...prods[prodIdx] };
        const rate = Number(item.conversionRate || prod.conversionRate) > 0 ? Number(item.conversionRate || prod.conversionRate) : 1;
        const stockQtyToAdd = goodQty * rate;
        const currentBal = Number(prod.stockBalance) || 0;
        const newBal = currentBal + stockQtyToAdd;

        prod.stockBalance = newBal;
        prods[prodIdx] = prod;

        const sUnit = prod.stockUnit || prod.unit || 'ชิ้น';
        const pUnit = prod.purchaseUnit || prod.unit || sUnit;
        const grNumber = options.grNumber || item.grNumber || options.grnNumber || `GRN-${Date.now()}`;
        const docNo = options.docNo || item.docNo || item.poNo || grNumber;
        const poNumber = options.poNo || options.poNumber || item.poNo || item.poNumber || (String(docNo).startsWith('PO-') ? docNo : '');
        const actualPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? prod.price) || 0;
        const stockUnitPrice = actualPrice > 0 && rate > 0 ? (actualPrice / rate) : (Number(prod.price) || 0);

        const logNote = rate > 1
          ? `รับสินค้าเข้าคลังเฉพาะยอดสมบูรณ์ ${goodQty} ${pUnit} (= +${stockQtyToAdd} ${sUnit}) จากเอกสาร ${docNo}`
          : `รับสินค้าเข้าคลังเฉพาะยอดสมบูรณ์ +${stockQtyToAdd} ${sUnit} จากเอกสาร ${docNo}`;

        const logEntry = {
          id: `LOG-IN-${Date.now()}-${idx}-${Math.floor(Math.random() * 1000)}`,
          date: isoTimestamp,
          displayDate: timestamp,
          productId: prod.id,
          productCode: prod.code,
          name: prod.name,
          department: prod.department || prod.category || tDept || 'PD',
          type: 'IN',
          documentNo: grNumber,
          docNo: docNo,
          poNo: poNumber,
          poNumber: poNumber,
          qty: stockQtyToAdd,
          receivedQty: goodQty,
          unit: sUnit,
          balance: newBal,
          unitPrice: stockUnitPrice,
          totalPrice: stockUnitPrice * stockQtyToAdd,
          actualPrice: actualPrice,
          user: typeof options.user === 'object' ? `${options.user.name} (${options.user.title || ''})` : (options.user || currentRole?.name || 'Warehouse Staff'),
          locationId: prod.locationId || '',
          locationName: prod.locationName || '',
          note: options.note || logNote
        };

        logs.unshift(logEntry);

        processedItems.push({
          productId: prod.id,
          code: prod.code,
          name: prod.name,
          goodQty,
          stockQtyAdded: stockQtyToAdd,
          previousBalance: currentBal,
          newBalance: newBal,
          log: logEntry
        });
      }
    });

    if (processedItems.length > 0) {
      storageService.saveProducts(prods);
      storageService.saveStockLogs(logs);
      setProducts(prods);
      setStockLogs(logs);

      try {
        await Promise.all([
          fetch('/api/products/batch', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prods)
          }),
          fetch('/api/stock-logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logs)
          })
        ]);
      } catch {}
    }

    setTimeout(() => { loadAllData(true); }, 1500);
    return {
      success: true,
      processedCount: processedItems.length,
      processedItems,
      products: prods,
      stockLogs: logs
    };
  }, [currentRole, loadAllData]);

  // ── Stock Issue Mutation (Optimistic Update + Storage Sync + Backend RPC) ──
  const handleIssueStock = useCallback(async (payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('ข้อมูลการเบิกจ่ายไม่ถูกต้อง');
    }

    const productId = payload.productId || payload.id;
    const rawQty = payload.quantity !== undefined ? payload.quantity : (payload.qty !== undefined ? payload.qty : payload.issueQty);
    const issueQty = Math.abs(Number(rawQty));
    if (isNaN(issueQty) || issueQty <= 0) {
      throw new Error('จำนวนที่ต้องการเบิกต้องมากกว่า 0');
    }

    const productCode = payload.productCode || payload.code || payload.sku;
    const department = payload.department || payload.category;
    const issuedTo = payload.issuedTo || payload.issueUnit || payload.unitName || '';
    const location = payload.location || payload.targetUnit || payload.unit || issuedTo || '';
    const reason = payload.reason || payload.note || 'เบิกจ่ายด่วน';
    const requester = payload.user || currentUser || currentRole;

    // 1. ค้นหาสินค้าใน State products ปัจจุบัน
    const currentProds = storageService.getProducts();
    let targetIndex = currentProds.findIndex(p => p.id === productId);
    if (targetIndex === -1 && productCode) {
      targetIndex = currentProds.findIndex(p =>
        String(p.code).trim() === String(productCode).trim() &&
        (!department || matchDepartment(p.department || p.category, department))
      );
    }
    if (targetIndex === -1) {
      throw new Error('ไม่พบสินค้านี้ในระบบเพื่อตัดสต็อก');
    }

    const currentProd = currentProds[targetIndex];
    const currentBalance = Number(currentProd.stockBalance || 0);
    const sUnit = currentProd.stockUnit || currentProd.unit || 'ชิ้น';

    if (currentBalance < issueQty) {
      throw new Error(`จำนวนคงเหลือไม่พอเบิก (มี ${currentBalance} ${sUnit}, ต้องการเบิก ${issueQty} ${sUnit})`);
    }

    const newBalance = Math.round((currentBalance - issueQty) * 10000) / 10000;
    const nowIso = new Date().toISOString();
    const updatedProd = {
      ...currentProd,
      stockBalance: newBalance,
      currentStock: newBalance,
      updatedAt: nowIso
    };

    const currentAvg = Number(updatedProd.avgCost || updatedProd.costPrice || updatedProd.price || 0);
    const totalCost = Math.round(issueQty * currentAvg * 100) / 100;

    const logId = `LOG-${department || updatedProd.department || 'PD'}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const logEntry = {
      id: logId,
      timestamp: nowIso,
      date: nowIso,
      type: 'OUT',
      productId: updatedProd.id,
      productCode: updatedProd.code,
      productName: updatedProd.name,
      name: updatedProd.name,
      department: department || updatedProd.department || 'PD',
      location: location || '',       // ห้อง/หน่วยที่เบิก เช่น 'ห้อง K1'
      changeQty: -issueQty,
      qty: issueQty,
      unit: sUnit,
      balanceAfter: newBalance,
      balance: newBalance,
      unitCost: currentAvg,
      totalCost: totalCost,
      issuedTo: issuedTo || location || '',
      issueUnit: location || issuedTo || '',  // Backward compat สำหรับ getLogUnit()
      reason: reason || 'เบิกจ่ายด่วน',
      note: reason || 'เบิกจ่ายด่วน',
      actorId: requester?.id || requester?.username || '',
      actorName: requester?.name || requester?.username || issuedTo || ''
    };

    // 2. Optimistic Update ใน State ทันที
    const updatedProdsList = [...currentProds];
    updatedProdsList[targetIndex] = updatedProd;
    setProducts(updatedProdsList);

    const currentLogs = storageService.getStockLogs();
    const updatedLogsList = [logEntry, ...currentLogs];
    setStockLogs(updatedLogsList);

    // 3. บันทึกลง Local Cache (storageService) ทันที ป้องกัน background sync ดึงค่าย้อนกลับ
    storageService.saveProducts(updatedProdsList);
    storageService.saveStockLogs(updatedLogsList);

    // 4. เรียก API หลังบ้าน (GAS / Backend)
    try {
      const apiPayload = {
        productId: updatedProd.id,
        productCode: updatedProd.code,
        department: updatedProd.department || department || 'PD',
        quantity: issueQty,
        issuedTo,
        location,        // ห้อง/หน่วยที่เบิก → บันทึกลงชีต StockLogs
        reason,
        requesterId: requester?.id || requester?.username || '',
        requesterName: requester?.name || '',
        user: requester
      };
      const apiResult = await apiService.issueStock(apiPayload);
      const serverLog = apiResult?.data?.logEntry || apiResult?.logEntry;
      if (serverLog && serverLog.id) {
        setStockLogs(prev => {
          const replaced = prev.map(l => (l.id === logId ? { ...l, ...serverLog, id: serverLog.id } : l));
          storageService.saveStockLogs(replaced);
          return replaced;
        });
      }
    } catch (err) {
      console.warn('[AppContext] issueStock backend RPC warning:', err.message);
      if (err.message && err.message.includes('ไม่พอ')) {
        throw err;
      }
    }

    const toastMsg = `เบิกจ่ายสำเร็จ! ยอดคงเหลือ: ${newBalance} ${sUnit}`;

    return {
      success: true,
      updatedProduct: updatedProd,
      product: updatedProd,
      logEntry,
      newBalance,
      message: toastMsg
    };
  }, [currentUser, currentRole]);


  const globalTodoCount = useMemo(() => {
    if (!currentRole) return 0;
    const allTasks = [
      ...(prs || []).map(pr => ({ ...pr, docType: pr.docType || 'PR' })),
      ...(pos || []).map(po => ({ ...po, docType: po.docType || 'PO' }))
    ];
    return allTasks.filter(task => isToDoTask(task, currentRole, prs, pos)).length;
  }, [currentRole, prs, pos]);

  const value = useMemo(() => ({
    currentUser,
    currentRole,
    setCurrentUser,
    setCurrentRole,
    availableUsers,
    handleSwitchUser,
    isAuthLoading,
    isDataLoading,
    isLoading,
    handleLogout,
    products: getUnifiedProductList(products),
    inventory: products,
    getUnifiedProductList,
    vendors,
    storageLocations,
    usageUnits,
    getUsageUnits,
    prs,
    pos,
    stockLogs,
    budgetSummary,
    loadAllData,
    fetchBootstrapData: loadAllData,
    initAppData,
    refreshData,
    fetchPRs,
    fetchPOs,
    updatePO,
    setPOs,
    createPR: handleCreatePR,
    handleSavePR: handleCreatePR,
    updatePR,
    updatePRState: updatePR,
    handleUpdatePR: updatePR,
    rejectPR: handleRejectPR,
    reviewPR: handleReviewPR,
    approvePR: handleApprovePR,
    cancelPR: handleCancelPR,
    receivePOItems: handleReceiveGoods,
    receiveGoods: handleReceiveGoods,
    recordGoodsReceipt: handleRecordGoodsReceipt,
    rollbackBudget: handleRollbackBudget,
    receiveToStock: handleReceiveToStock,
    issueStock: handleIssueStock,
    handleIssueStock,
    quickIssueStock: handleIssueStock,
    saveProduct: handleSaveProduct,
    updateProduct: handleSaveProduct,
    deleteProduct: handleDeleteProduct,
    saveVendor: handleSaveVendor,
    deleteVendor: handleDeleteVendor,
    saveStorageLocation: handleSaveStorageLocation,
    deleteStorageLocation: handleDeleteStorageLocation,
    saveUsageUnit: handleSaveUsageUnit,
    deleteUsageUnit: handleDeleteUsageUnit,
    departments,
    saveDepartment: handleSaveDepartment,
    deleteDepartment: handleDeleteDepartment,
    users,
    saveUser: handleSaveUser,
    deleteUser: handleDeleteUser,
    updateBudget: handleUpdateBudget,
    budgetTransactions,
    adjustBudget: handleAdjustBudget,
    refundBudget: handleRefundBudget,
    preselectedProduct,
    setPreselectedProduct,
    clearPreselectedProduct: () => setPreselectedProduct(null),
    editingPR,
    setEditingPR,
    clearEditingPR: () => setEditingPR(null),
    handleQuickPR,
    handleEditPR,
    selectedPRForModal,
    setSelectedPRForModal,
    handleOpenPRById,
    selectedPOForModal,
    setSelectedPOForModal,
    handleOpenPOById,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    onNavigate,
    globalTodoCount,
  }), [
    currentUser,
    currentRole,
    availableUsers,
    handleSwitchUser,
    isAuthLoading,
    isDataLoading,
    isLoading,
    handleLogout,
    products,
    vendors,
    storageLocations,
    usageUnits,
    getUsageUnits,
    prs,
    pos,
    stockLogs,
    budgetSummary,
    loadAllData,
    fetchPRs,
    fetchPOs,
    updatePO,
    handleCreatePR,
    handleUpdatePR,
    handleRejectPR,
    handleReviewPR,
    handleApprovePR,
    handleCancelPR,
    handleReceiveGoods,
    handleSaveProduct,
    handleDeleteProduct,
    handleSaveVendor,
    handleDeleteVendor,
    handleSaveStorageLocation,
    handleDeleteStorageLocation,
    handleSaveUsageUnit,
    handleDeleteUsageUnit,
    departments,
    handleSaveDepartment,
    handleDeleteDepartment,
    users,
    handleSaveUser,
    handleDeleteUser,
    handleUpdateBudget,
    budgetTransactions,
    handleAdjustBudget,
    handleRefundBudget,
    handleRecordGoodsReceipt,
    handleRollbackBudget,
    handleReceiveToStock,
    handleIssueStock,
    preselectedProduct,
    editingPR,
    handleQuickPR,
    handleEditPR,
    selectedPRForModal,
    handleOpenPRById,
    selectedPOForModal,
    handleOpenPOById,
    isMobileSidebarOpen,
    onNavigate,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  return context || {};
}
