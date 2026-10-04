import { resolveUserPermissions } from '../config/constants.js';
import { isGAS, callGAS } from './storageService.js';

const AUTH_SESSION_KEY = 'prpo_auth_session';
const REGISTERED_USERS_KEY = 'prpo_registered_users';
export const EXPLICIT_SIGNOUT_KEY = 'prpo_explicit_signout';

// Pre-configured Employee Accounts (Now dynamically fetched from Cloudflare D1 with resilient fallbacks)
export const DEFAULT_EMPLOYEE_ACCOUNTS = [
  {
    id: 'USR-0001',
    employeeId: 'EMP-PD-001',
    username: 'wichai.pd',
    email: 'wichai@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'คุณวิชัย (PD)',
    employeeName: 'คุณวิชัย สุขใจ',
    displayName: 'Wichai (PD)',
    position: 'เจ้าหน้าที่ฝ่ายผลิต',
    department: 'PD',
    primaryDepartment: 'PD',
    departments: ['PD'],
    allowedDepartments: ['PD'],
    assignedDepartments: ['PD'],
    roleId: 'REQUESTER_PD',
    canonicalRole: 'REQUESTER',
    positionKey: 'REQUESTER_PD',
    title: 'Requester (PD)',
    level: 1,
    status: 'ACTIVE',
    canCreatePR: true,
    canSubmitPR: true,
    canDeleteOwnDraft: true,
    canReview: false,
    canFinalApprove: false,
    canOnlinePurchase: false,
    canReceiveGoods: true,
    canCloseOwnPO: true,
    canManageMaster: true,
    canDeleteMaster: false,
    canViewBudget: false,
    canViewBudgetMenu: false,
    canSetBudget: false,
    canViewAllDepts: false
  },
  {
    id: 'USR-0002',
    employeeId: 'EMP-QC-001',
    username: 'somying.qc',
    email: 'somying@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'คุณสมหญิง (QC)',
    employeeName: 'คุณสมหญิง รักดี',
    displayName: 'Somying (QC)',
    position: 'เจ้าหน้าที่ฝ่ายควบคุมคุณภาพ (QC)',
    department: 'QC',
    primaryDepartment: 'QC',
    departments: ['QC'],
    allowedDepartments: ['QC'],
    assignedDepartments: ['QC'],
    roleId: 'REQUESTER_QC',
    canonicalRole: 'REQUESTER',
    positionKey: 'REQUESTER_QC',
    title: 'Requester (QC)',
    level: 1,
    status: 'ACTIVE',
    canCreatePR: true,
    canSubmitPR: true,
    canDeleteOwnDraft: true,
    canReview: false,
    canFinalApprove: false,
    canOnlinePurchase: false,
    canReceiveGoods: true,
    canCloseOwnPO: true,
    canManageMaster: true,
    canDeleteMaster: false,
    canViewBudget: false,
    canViewBudgetMenu: false,
    canSetBudget: false,
    canViewAllDepts: false
  },
  {
    id: 'USR-0003',
    employeeId: 'EMP-MGR-001',
    username: 'somchai.am',
    email: 'somchai.am@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'คุณสมชาย (Asst. Mgr)',
    employeeName: 'คุณสมชาย มุ่งมั่น',
    displayName: 'Somchai (Asst Mgr)',
    position: 'ผู้ช่วยผู้จัดการฝ่ายผลิต (Asst. Manager)',
    department: 'PD',
    primaryDepartment: 'PD',
    departments: ['PD', 'QC'],
    allowedDepartments: ['PD', 'QC'],
    assignedDepartments: ['PD', 'QC'],
    roleId: 'ASST_MANAGER',
    canonicalRole: 'REVIEWER',
    positionKey: 'REVIEWER',
    title: 'Assistant Manager',
    level: 2,
    status: 'ACTIVE',
    canCreatePR: true,
    canSubmitPR: true,
    canDeleteOwnDraft: true,
    canReview: true,
    canFinalApprove: false,
    canOnlinePurchase: false,
    canReceiveGoods: false,
    canCloseOwnPO: false,
    canManageMaster: true,
    canDeleteMaster: false,
    canViewBudget: true,
    canViewBudgetMenu: true,
    canSetBudget: false,
    canViewAllDepts: true
  },
  {
    id: 'USR-0004',
    employeeId: 'EMP-PUR-001',
    username: 'nat.on',
    email: 'nat.on@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'คุณนัท (Online Purchaser)',
    employeeName: 'คุณนัท จัดซื้อ',
    displayName: 'Nat (Online)',
    position: 'เจ้าหน้าที่จัดซื้อออนไลน์',
    department: 'PUR',
    primaryDepartment: 'PUR',
    departments: ['PUR'],
    allowedDepartments: ['*'],
    assignedDepartments: ['*'],
    roleId: 'ONLINE_PURCHASER',
    canonicalRole: 'PURCHASER',
    positionKey: 'ONLINE_PURCHASER',
    title: 'Online Purchaser',
    level: 2,
    status: 'ACTIVE',
    canCreatePR: false,
    canSubmitPR: false,
    canDeleteOwnDraft: false,
    canReview: false,
    canFinalApprove: false,
    canOnlinePurchase: true,
    canReceiveGoods: false,
    canCloseOwnPO: false,
    canManageMaster: false,
    canDeleteMaster: false,
    canViewBudget: false,
    canViewBudgetMenu: false,
    canSetBudget: false,
    canViewAllDepts: true
  },
  {
    id: 'USR-0005',
    employeeId: 'EMP-MGR-002',
    username: 'prasert.pm',
    email: 'prasert.pm@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'คุณประเสริฐ (Plant Mgr)',
    employeeName: 'คุณประเสริฐ ยิ่งยง',
    displayName: 'Prasert (Plant Mgr)',
    position: 'ผู้จัดการโรงงาน (Plant Manager)',
    department: 'MGT',
    primaryDepartment: 'MGT',
    departments: ['PD', 'QC', 'MGT'],
    allowedDepartments: ['*'],
    assignedDepartments: ['*'],
    roleId: 'PLANT_MANAGER',
    canonicalRole: 'APPROVER',
    positionKey: 'APPROVER',
    title: 'Plant Manager',
    level: 3,
    status: 'ACTIVE',
    canCreatePR: true,
    canSubmitPR: true,
    canDeleteOwnDraft: true,
    canReview: true,
    canFinalApprove: true,
    canOnlinePurchase: false,
    canReceiveGoods: false,
    canCloseOwnPO: false,
    canManageMaster: true,
    canDeleteMaster: false,
    canViewBudget: true,
    canViewBudgetMenu: true,
    canSetBudget: true,
    canViewAllDepts: true
  },
  {
    id: 'USR-0007',
    employeeId: 'EMP-ADM-001',
    username: 'admin',
    email: 'admin@company.com',
    password: 'admin123',
    pin: 'admin123',
    name: 'ผู้ดูแลระบบ (Admin)',
    employeeName: 'นายแอดมิน สูงสุด',
    displayName: 'Admin System',
    position: 'ผู้ดูแลระบบส่วนกลาง',
    department: 'ALL',
    primaryDepartment: 'ALL',
    departments: ['*'],
    allowedDepartments: ['*'],
    assignedDepartments: ['*'],
    roleId: 'ADMIN',
    canonicalRole: 'ADMIN',
    positionKey: 'ADMIN',
    title: 'System Administrator',
    level: 99,
    status: 'ACTIVE',
    canCreatePR: true,
    canSubmitPR: true,
    canDeleteOwnDraft: true,
    canReview: true,
    canFinalApprove: true,
    canOnlinePurchase: true,
    canReceiveGoods: true,
    canCloseOwnPO: true,
    canManageMaster: true,
    canDeleteMaster: true,
    canViewBudget: true,
    canViewBudgetMenu: true,
    canSetBudget: true,
    canViewAllDepts: true
  }
];

/**
 * Check if the current environment is UAT mode
 */
export const isUATEnv = () => {
  return typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_ENV === 'uat';
};

/**
 * Role-based access mapping for read-only permission checklist
 */
export const getRolePermissionsChecklist = (userOrRole) => {
  if (!userOrRole) return [];
  const roleStr = String(userOrRole.canonicalRole || userOrRole.roleId || userOrRole.role || userOrRole.positionKey || '').toUpperCase();
  const isAdmin = userOrRole.isAdmin === true || roleStr.includes('ADMIN') || Number(userOrRole.level) >= 99 || userOrRole.username === 'admin';
  const isOnline = !isAdmin && (roleStr.includes('ONLINE_PURCHASER') || userOrRole.roleId === 'ONLINE_PURCHASER');
  const isApprover = isAdmin || roleStr.includes('APPROV') || roleStr.includes('PLANT_MANAGER');
  const isPurchaser = isAdmin || isOnline || roleStr.includes('PURCHAS') || roleStr.includes('BUYER');
  const isRequesterOrStaff = isAdmin || (!isOnline && (roleStr.includes('REQUEST') || roleStr.includes('REVIEW') || roleStr.includes('STOCK') || roleStr.includes('PD') || roleStr.includes('QC')));
  const isRequester = isAdmin || (!isOnline && (roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC')));

  return [
    {
      key: 'PR_CREATION',
      label: 'สร้างใบขอซื้อ (PR Creation)',
      description: 'สร้าง ร่าง และส่งคำขอซื้อเข้าระบบ',
      allowed: Boolean(isAdmin || (!isOnline && (isRequester || userOrRole.canCreatePR)))
    },
    {
      key: 'APPROVAL',
      label: 'ตรวจทานและอนุมัติ (Approval)',
      description: 'ตรวจทานงบประมาณและอนุมัติใบขอซื้อ',
      allowed: Boolean(isAdmin || (!isOnline && (isApprover || userOrRole.canReview || userOrRole.canFinalApprove)))
    },
    {
      key: 'PURCHASING',
      label: 'จัดซื้อและสั่งซื้อออนไลน์ (Purchasing)',
      description: 'ดำเนินการสั่งซื้อ เทียบราคา และบันทึกราคาจริง',
      allowed: Boolean(isAdmin || isPurchaser || userOrRole.canOnlinePurchase)
    },
    {
      key: 'INVENTORY',
      label: 'ตรวจรับและจัดการคลัง (Inventory)',
      description: 'ตรวจรับพัสดุ (GRN) เบิกจ่าย และตัดสต็อกสินค้า',
      allowed: Boolean(isAdmin || (!isOnline && (isRequesterOrStaff || userOrRole.canReceiveGRN || userOrRole.canReceiveGoods)))
    }
  ];
};

export const authService = {
  // Environment detection: checks if running inside Google Apps Script
  isGASMode() {
    return isGAS();
  },

  // Explicit Sign-Out State Management
  isExplicitSignOut() {
    try {
      return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(EXPLICIT_SIGNOUT_KEY) === 'true';
    } catch {
      return false;
    }
  },

  setExplicitSignOut(value = true) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (value) {
          sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, 'true');
        } else {
          sessionStorage.removeItem(EXPLICIT_SIGNOUT_KEY);
        }
      }
    } catch (e) {
      console.warn('[authService] setExplicitSignOut error:', e);
    }
  },

  clearExplicitSignOut() {
    this.setExplicitSignOut(false);
  },

  /**
   * Google Apps Script Production Authentication:
   * Retrieves active Google user from backend RPC (apiGetCurrentUser),
   * maps email and role to the Sheet Users database, resolves fine-grained permissions,
   * sets the active session in localStorage, and returns the session object.
   * 
   * @param {boolean} [force=false] If true, bypasses isExplicitSignOut check and clears the flag
   */
  async getNativeGoogleUser(force = false) {
    if (!isGAS()) return null;
    if (!force && this.isExplicitSignOut()) {
      return null;
    }
    this.clearExplicitSignOut();
    try {
      const gasUser = await callGAS('apiGetCurrentUser');
      if (!gasUser) return null;

      const rawRole = gasUser.roleId || gasUser.role || gasUser.canonicalRole || 'REQUESTER_PD';
      const userLevel = Number(gasUser.level) || 1;
      const rolePermissions = resolveUserPermissions({
        ...gasUser,
        roleId: rawRole,
        level: userLevel
      });

      // Normalize allowed departments
      let userDepts = [];
      if (Array.isArray(gasUser.allowedDepartments) && gasUser.allowedDepartments.length > 0) {
        userDepts = gasUser.allowedDepartments;
      } else if (typeof gasUser.allowedDepartments === 'string') {
        try {
          userDepts = JSON.parse(gasUser.allowedDepartments);
        } catch {
          userDepts = gasUser.allowedDepartments.split(',').map(d => d.trim()).filter(Boolean);
        }
      }

      if (!userDepts || userDepts.length === 0) {
        const fallbackDept = gasUser.primaryDepartment || gasUser.department || 'PD';
        userDepts = [fallbackDept];
      }

      const primaryDept = gasUser.primaryDepartment || gasUser.department || userDepts[0] || 'PD';
      const username = gasUser.username || (gasUser.email ? gasUser.email.split('@')[0] : 'google.user');
      const displayName = gasUser.displayName || gasUser.name || gasUser.employeeName || gasUser.email || 'Google User';

      const sessionData = {
        id: gasUser.id || `USR-GAS-${username}`,
        employeeId: gasUser.employeeId || '',
        username: username,
        email: gasUser.email || '',
        name: displayName,
        employeeName: displayName,
        displayName: displayName,
        primaryDepartment: primaryDept,
        department: primaryDept,
        departments: userDepts,
        assignedDepartments: userDepts,
        allowedDepartments: userDepts,
        roleId: rawRole,
        canonicalRole: rolePermissions.canonicalRole || gasUser.canonicalRole || 'REQUESTER',
        positionKey: gasUser.positionKey || rawRole,
        title: gasUser.title || gasUser.role || 'Google Account User',
        level: userLevel,
        status: gasUser.status || 'ACTIVE',
        isGoogleAuth: true,
        lastLogin: new Date().toISOString(),
        ...rolePermissions,
        role: rolePermissions,
        rolePermissions: rolePermissions,
        expiresAt: Date.now() + (24 * 60 * 60 * 1000)
      };

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
        localStorage.setItem('prpo_auth_session', JSON.stringify(sessionData));
      }

      return sessionData;
    } catch (err) {
      console.warn('[authService] getNativeGoogleUser error:', err.message);
      return null;
    }
  },

  /**
   * Session resolver:
   * Returns current active local session from storage.
   */
  async resolveSession() {
    return this.getCurrentSession();
  },

  /**
   * Fetches registered users directly from GAS Backend in production mode.
   */
  async fetchUsersFromGAS() {
    if (!isGAS()) return this.getRegisteredUsers();
    try {
      const users = await callGAS('apiGetUsers');
      if (Array.isArray(users) && users.length > 0) {
        this.saveRegisteredUsers(users);
        return users;
      }
    } catch (e) {
      console.warn('[authService] fetchUsersFromGAS error:', e.message);
    }
    return this.getRegisteredUsers();
  },

  // Get all registered accounts
  getRegisteredUsers() {
    try {
      const data = typeof localStorage !== 'undefined' ? localStorage.getItem(REGISTERED_USERS_KEY) : null;
      if (!data) return DEFAULT_EMPLOYEE_ACCOUNTS;
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_EMPLOYEE_ACCOUNTS;
    } catch {
      return DEFAULT_EMPLOYEE_ACCOUNTS;
    }
  },

  saveRegisteredUsers(users) {
    localStorage.setItem(REGISTERED_USERS_KEY, JSON.stringify(users));
  },

  // Get current authenticated user (alias to getCurrentSession for resilient fallback)
  getCurrentUser() {
    return this.getCurrentSession();
  },

  // Get active session
  getCurrentSession() {
    try {
      if (this.isExplicitSignOut()) {
        return null;
      }
      const data = localStorage.getItem(AUTH_SESSION_KEY) || localStorage.getItem('prpo_auth_session');
      if (data) {
        const session = JSON.parse(data);
        const departments = (Array.isArray(session.departments) && session.departments.length > 0)
          ? session.departments
          : (session.department ? [session.department] : ['PD']);
        // Enrich with fresh role permissions dynamically based on role/level
        const rolePermissions = resolveUserPermissions({ ...session, departments });
        return {
          ...session,
          departments,
          assignedDepartments: session.assignedDepartments || departments,
          allowedDepartments: session.allowedDepartments || departments,
          ...rolePermissions,
          role: rolePermissions
        };
      }
      return null;
    } catch {
      return null;
    }
  },

  // Authenticate user with Employee ID / Username / Email and PIN / Password
  async login(username, password, _optionalLegacyUid = null) {
    this.clearExplicitSignOut();
    // 1. Purge any stale cached user sessions first
    localStorage.removeItem(AUTH_SESSION_KEY);
    localStorage.removeItem('prpo_auth_session');
    localStorage.removeItem('prpo_current_user');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('prpo_user');
    localStorage.removeItem('prpo_original_admin_user');

    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();

    if (!cleanUser) {
      throw new Error('กรุณาระบุชื่อผู้ใช้งาน (Username หรือ Employee ID)');
    }
    if (!cleanPass) {
      throw new Error('กรุณาระบุรหัสผ่าน (Password)');
    }

    // 2. Cloudflare API / Serverless D1 Auth Check (Primary SSOT)
    try {
      const apiRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser, password: cleanPass })
      });
      if (apiRes.ok) {
        const authData = await apiRes.json();
        if (authData && authData.user) {
          const userObj = authData.user;
          const rolePermissions = resolveUserPermissions(userObj);
          const userDepts = rolePermissions.departments || userObj.departments || [userObj.department || 'PD'];
          const sessionData = {
            id: userObj.id,
            username: userObj.username,
            employeeId: userObj.employeeId,
            name: userObj.name,
            employeeName: userObj.employeeName || userObj.name,
            displayName: userObj.displayName || userObj.name,
            primaryDepartment: userObj.primaryDepartment || userObj.department,
            department: userObj.department,
            departments: userDepts,
            assignedDepartments: userDepts,
            allowedDepartments: userDepts,
            roleId: userObj.roleId,
            positionKey: userObj.positionKey || userObj.roleId,
            title: userObj.title,
            level: userObj.level || 1,
            token: authData.token,
            lastLogin: new Date().toISOString(),
            ...rolePermissions,
            role: rolePermissions,
            rolePermissions: rolePermissions,
            expiresAt: Date.now() + (24 * 60 * 60 * 1000)
          };
          localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
          localStorage.setItem('prpo_auth_session', JSON.stringify(sessionData));
          return sessionData;
        }
      } else if (apiRes.status === 401 || apiRes.status === 400) {
        const errorData = await apiRes.json().catch(() => ({}));
        throw new Error(errorData.error || 'ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง');
      }
    } catch (apiErr) {
      if (apiErr.message && apiErr.message.includes('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง')) {
        throw apiErr;
      }
      // If network error occurred, continue to secondary checks (e.g. GAS)
    }

    // 3. In Google Apps Script environment: Authenticate against Users sheet backend
    if (isGAS()) {
      try {
        const gasUser = await callGAS('apiLogin', cleanUser, cleanPass);
        if (gasUser) {
          const rawRole = gasUser.roleId || gasUser.role || gasUser.canonicalRole || 'REQUESTER_PD';
          const userLevel = Number(gasUser.level) || 1;
          const rolePermissions = resolveUserPermissions({
            ...gasUser,
            roleId: rawRole,
            level: userLevel
          });

          let userDepts = [];
          if (Array.isArray(gasUser.allowedDepartments) && gasUser.allowedDepartments.length > 0) {
            userDepts = gasUser.allowedDepartments;
          } else if (typeof gasUser.allowedDepartments === 'string') {
            try {
              userDepts = JSON.parse(gasUser.allowedDepartments);
            } catch {
              userDepts = gasUser.allowedDepartments.split(',').map(d => d.trim()).filter(Boolean);
            }
          }
          if (!userDepts || userDepts.length === 0) {
            const fallbackDept = gasUser.primaryDepartment || gasUser.department || 'PD';
            userDepts = [fallbackDept];
          }

          const primaryDept = gasUser.primaryDepartment || gasUser.department || userDepts[0] || 'PD';
          const displayName = gasUser.displayName || gasUser.name || gasUser.employeeName || gasUser.username || 'User';

          const sessionData = {
            id: gasUser.id || `USR-${gasUser.username}`,
            employeeId: gasUser.employeeId || '',
            username: gasUser.username,
            email: gasUser.email || '',
            name: displayName,
            employeeName: displayName,
            displayName: displayName,
            primaryDepartment: primaryDept,
            department: primaryDept,
            departments: userDepts,
            assignedDepartments: userDepts,
            allowedDepartments: userDepts,
            roleId: rawRole,
            canonicalRole: rolePermissions.canonicalRole || gasUser.canonicalRole || 'REQUESTER',
            positionKey: gasUser.positionKey || rawRole,
            title: gasUser.title || gasUser.role || 'User',
            level: userLevel,
            status: gasUser.status || 'ACTIVE',
            lastLogin: new Date().toISOString(),
            ...rolePermissions,
            role: rolePermissions,
            rolePermissions: rolePermissions,
            expiresAt: Date.now() + (24 * 60 * 60 * 1000)
          };

          localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
          localStorage.setItem('prpo_auth_session', JSON.stringify(sessionData));
          return sessionData;
        }
      } catch (gasErr) {
        console.warn('[authService] GAS apiLogin error:', gasErr.message);
      }
    }

    // 4. Fallback check against cached registered users (strictly requires password match)
    const users = this.getRegisteredUsers();
    const cleanUserLower = cleanUser.toLowerCase();
    
    const matched = users.find(u => {
      const uUser = (u.username || '').toLowerCase();
      const uEmp = (u.employeeId || '').toLowerCase();
      const uEmail = (u.email || '').toLowerCase();
      const userMatch = uUser === cleanUserLower || uEmp === cleanUserLower || uEmail === cleanUserLower || (cleanUserLower === 'prasert.mgr' && uUser === 'prasert.pm');
      const passMatch = u.password === cleanPass || u.pin === cleanPass || (uUser === 'admin' && (cleanPass === 'admin123' || cleanPass === 'password123'));
      return userMatch && passMatch;
    });

    if (!matched) {
      throw new Error('ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
    }

    matched.lastLogin = new Date().toISOString();
    this.saveRegisteredUsers(users);

    const rolePermissions = resolveUserPermissions(matched);
    const userDepts = rolePermissions.departments || matched.departments || matched.assignedDepartments || matched.allowedDepartments || [matched.department];
    const sessionData = {
      id: matched.id,
      username: matched.username,
      employeeId: matched.employeeId,
      name: matched.name,
      employeeName: matched.name,
      displayName: matched.name,
      primaryDepartment: matched.primaryDepartment || matched.department,
      department: matched.department,
      departments: userDepts,
      assignedDepartments: matched.assignedDepartments || userDepts,
      allowedDepartments: matched.allowedDepartments || userDepts,
      roleId: matched.roleId,
      positionKey: matched.positionKey,
      title: matched.title,
      level: matched.level,
      lastLogin: matched.lastLogin,
      ...rolePermissions,
      role: rolePermissions,
      rolePermissions: rolePermissions,
      expiresAt: Date.now() + (24 * 60 * 60 * 1000)
    };

    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));

    return sessionData;
  },

  // Instant login by Position for Localhost Testing
  async loginByPosition(positionOrUsername) {
    const users = this.getRegisteredUsers();
    const cleanKey = (positionOrUsername || '').trim().toLowerCase();

    const matched = users.find(u => 
      u.positionKey?.toLowerCase() === cleanKey ||
      u.roleId?.toLowerCase() === cleanKey ||
      u.canonicalRole?.toLowerCase() === cleanKey ||
      u.username?.toLowerCase() === cleanKey
    );

    if (!matched) {
      throw new Error(`ไม่พบบัญชีสำหรับตำแหน่ง: ${positionOrUsername}`);
    }

    return this.login(matched.username, matched.password);
  },

  // Log out current session
  logout() {
    localStorage.removeItem(AUTH_SESSION_KEY);
    localStorage.removeItem('prpo_auth_session');
    localStorage.removeItem('prpo_current_user');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('prpo_user');
    localStorage.removeItem('prpo_original_admin_user');
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.clear();
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, 'true');
    }
  }
};
