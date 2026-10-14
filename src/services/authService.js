import { resolveUserPermissions } from '../config/constants.js';
import { isGAS, callGAS } from './storageService.js';
import { isCloudflareMode } from '../config/backendMode.js';
import { isAdminUser } from '../utils/adminRule.js';

const AUTH_SESSION_KEY = 'prpo_auth_session';
const REGISTERED_USERS_KEY = 'prpo_registered_users';
export const EXPLICIT_SIGNOUT_KEY = 'prpo_explicit_signout';

// `vite build --mode cloudflare` : Vite replaces import.meta.env.MODE by the string literal, so every demo account / password shortcut below is
// dead code there and is dropped from the bundle (no credentials ship to production). mock / gas / dev / test builds keep them exactly as before.
// (same definition as vite.config.js : --mode cloudflare OR VITE_BACKEND_MODE=cloudflare ; production is always built with `npm run build:cf`)
export const IS_CLOUDFLARE_BUILD = import.meta.env.MODE === 'cloudflare' || String(import.meta.env.VITE_BACKEND_MODE || '').trim().toLowerCase() === 'cloudflare';

// Inert placeholder for the Cloudflare build : no password, no pin, nobody can log in with it (the real accounts come from the server).
// It only keeps the pre-login code paths that read DEFAULT_EMPLOYEE_ACCOUNTS[0] working.
const CLOUDFLARE_PLACEHOLDER_ACCOUNTS = [{
  id: 'GUEST', username: '', name: 'Guest', department: 'PD', primaryDepartment: 'PD', departments: ['PD'], assignedDepartments: ['PD'], allowedDepartments: ['PD'],
  roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1, status: 'INACTIVE'
}];

// Pre-configured Employee Accounts categorized by Position for Localhost Testing
export const DEFAULT_EMPLOYEE_ACCOUNTS = IS_CLOUDFLARE_BUILD ? CLOUDFLARE_PLACEHOLDER_ACCOUNTS : [
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
    assignedDepartments: ['PD'],
    allowedDepartments: ['PD'],
    roleId: 'REQUESTER_PD',
    canonicalRole: 'REQUESTER',
    positionKey: 'REQUESTER_PD',
    title: 'Requester (PD)',
    level: 1,
    status: 'ACTIVE',
    description: 'สร้าง/ส่ง PR ฝ่ายผลิต, เบิกจ่ายสินค้า, ตรวจรับของเข้าสต็อก'
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
    assignedDepartments: ['QC'],
    allowedDepartments: ['QC'],
    roleId: 'REQUESTER_QC',
    canonicalRole: 'REQUESTER',
    positionKey: 'REQUESTER_QC',
    title: 'Requester (QC)',
    level: 1,
    status: 'ACTIVE',
    description: 'สร้าง/ส่ง PR ฝ่าย QC/Lab, เบิกจ่ายสารเคมี, ตรวจรับของ'
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
    assignedDepartments: ['PD', 'QC'],
    allowedDepartments: ['PD', 'QC'],
    roleId: 'ASST_MANAGER',
    canonicalRole: 'REVIEWER',
    positionKey: 'REVIEWER',
    title: 'Assistant Manager',
    level: 2,
    status: 'ACTIVE',
    description: 'ตรวจทาน PR (Level 1 Reviewer), ดูแลฝ่ายผลิต (PD) และฝ่ายควบคุมคุณภาพ (QC)'
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
    departments: ['PD', 'QC', 'WH', 'PUR', 'ENG'],
    assignedDepartments: ['*'],
    allowedDepartments: ['*'],
    roleId: 'ONLINE_PURCHASER',
    canonicalRole: 'PURCHASER',
    positionKey: 'ONLINE_PURCHASER',
    title: 'Online Purchaser (คุณนัท)',
    level: 2,
    status: 'ACTIVE',
    description: 'จัดการสั่งซื้อออนไลน์ Shopee/Lazada, บันทึกราคาจริง'
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
    departments: ['PD', 'QC', 'WH', 'PUR', 'ENG'],
    assignedDepartments: ['*'],
    allowedDepartments: ['*'],
    roleId: 'PLANT_MANAGER',
    canonicalRole: 'APPROVER',
    positionKey: 'APPROVER',
    title: 'Plant Manager',
    level: 3,
    status: 'ACTIVE',
    description: 'อนุมัติสั่งซื้อ (Final Approver), ออก PO อัตโนมัติ, คุมงบประมาณ'
  },
  {
    id: 'USR-0006',
    employeeId: 'EMP-SYS-999',
    username: 'admin',
    email: 'admin@company.com',
    password: 'password123',
    pin: 'password123',
    name: 'Admin System',
    employeeName: 'ผู้ดูแลระบบ',
    displayName: 'Admin System',
    position: 'ผู้ดูแลระบบ (Admin)',
    department: 'MGT',
    primaryDepartment: 'MGT',
    departments: ['*'],
    assignedDepartments: ['*'],
    allowedDepartments: ['*'],
    roleId: 'ADMIN',
    canonicalRole: 'ADMIN',
    positionKey: 'ADMIN',
    title: 'System Administrator',
    level: 99,
    status: 'ACTIVE',
    description: 'ผู้ดูแลระบบ สิทธิ์สูงสุดในการจัดการข้อมูลทุกส่วน'
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
  const isAdmin = isAdminUser(userOrRole, userOrRole.isAdmin === true || roleStr.includes('ADMIN') || Number(userOrRole.level) >= 99 || userOrRole.username === 'admin');
  const isApprover = isAdmin || roleStr.includes('APPROV') || roleStr.includes('PLANT_MANAGER');
  const isPurchaser = isAdmin || roleStr.includes('PURCHAS') || roleStr.includes('BUYER');
  const isRequesterOrStaff = isAdmin || roleStr.includes('REQUEST') || roleStr.includes('REVIEW') || roleStr.includes('STOCK') || roleStr.includes('PD') || roleStr.includes('QC');
  const isRequester = isAdmin || roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC');

  return [
    {
      key: 'PR_CREATION',
      label: 'สร้างใบขอซื้อ (PR Creation)',
      description: 'สร้าง ร่าง และส่งคำขอซื้อเข้าระบบ',
      allowed: Boolean(isAdmin || isRequester || userOrRole.canCreatePR)
    },
    {
      key: 'APPROVAL',
      label: 'ตรวจทานและอนุมัติ (Approval)',
      description: 'ตรวจทานงบประมาณและอนุมัติใบขอซื้อ',
      allowed: Boolean(isAdmin || isApprover || userOrRole.canReview || userOrRole.canFinalApprove)
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
      allowed: Boolean(isAdmin || isRequesterOrStaff || userOrRole.canReceiveGRN || userOrRole.canReceiveGoods)
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
      const data = localStorage.getItem(REGISTERED_USERS_KEY);
      if (!data) return DEFAULT_EMPLOYEE_ACCOUNTS;
      const parsed = JSON.parse(data);
      return parsed.map(u => {
        const def = DEFAULT_EMPLOYEE_ACCOUNTS.find(d => d.id === u.id || d.username === u.username);
        if (def && def.departments && (!u.departments || u.departments.length < def.departments.length)) {
          return {
            ...u,
            departments: def.departments,
            assignedDepartments: def.assignedDepartments || def.departments,
            allowedDepartments: def.allowedDepartments || def.departments
          };
        }
        return u;
      });
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

    // 2a. Cloudflare mode: authenticate against D1 via /api/auth (token kept for Bearer header)
    // No local-credential fallback in this mode: every failure throws.
    if (isCloudflareMode()) {
      const BAD_CRED_MSG = 'ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง';
      const UNAVAILABLE_MSG = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง';
      let apiRes;
      try {
        apiRes = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: cleanUser, password: cleanPass })
        });
      } catch {
        throw new Error(UNAVAILABLE_MSG);
      }
      {
        if (apiRes.ok) {
          const authData = await apiRes.json().catch(() => null);
          if (authData && authData.user && typeof authData.token === 'string' && authData.token) {
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
              mustChangePassword: authData.mustChangePassword === true,
              lastLogin: new Date().toISOString(),
              ...rolePermissions,
              // `id` is overwritten by rolePermissions.id (= roleId) above ; userId is the stable per-user key (client cache owner)
              userId: userObj.id,
              role: rolePermissions,
              rolePermissions: rolePermissions,
              expiresAt: Date.now() + (8 * 60 * 60 * 1000) // = server token TTL (TOKEN_TTL_SECONDS)
            };
            localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
            localStorage.setItem('prpo_auth_session', JSON.stringify(sessionData));
            return sessionData;
          }
          throw new Error(UNAVAILABLE_MSG);
        }
        if (apiRes.status === 401 || apiRes.status === 400) {
          const errorData = await apiRes.json().catch(() => ({}));
          throw new Error(errorData.error || BAD_CRED_MSG);
        }
        // 429 (rate limit) / 403 (blocked): show the server's Thai message when provided
        if (apiRes.status === 429 || apiRes.status === 403) {
          const errorData = await apiRes.json().catch(() => ({}));
          throw new Error(typeof errorData?.error === 'string' && errorData.error ? errorData.error : UNAVAILABLE_MSG);
        }
        throw new Error(UNAVAILABLE_MSG);
      }
    }

    // 2. In Google Apps Script environment: Authenticate directly against Users sheet backend
    if (isGAS()) {
      try {
        const gasUser = await callGAS('apiLogin', cleanUser, cleanPass);
        if (!gasUser) {
          throw new Error('ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
        }

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
      } catch (gasErr) {
        console.warn('[authService] GAS apiLogin error:', gasErr.message);
        throw new Error(gasErr.message || 'ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
      }
    }

    // 3. Localhost / Offline / Unit Testing Mode: Authenticate against registered users / authentic personas
    const users = this.getRegisteredUsers();
    const cleanUserLower = cleanUser.toLowerCase();
    
    const matched = users.find(u => {
      const uUser = (u.username || '').toLowerCase();
      const uEmp = (u.employeeId || '').toLowerCase();
      const userMatch = uUser === cleanUserLower || uEmp === cleanUserLower ||
        (cleanUserLower === 'siraphat.pd' && uUser === 'wichai.pd') ||
        (cleanUserLower === 'natthinee.qc' && uUser === 'somying.qc') ||
        (cleanUserLower === 'kallayani.mgr' && uUser === 'somchai.am');
      // the password shortcuts (admin123 / password123 / 123456 for anyone) exist for the localhost test modes only - not in the Cloudflare build
      const passMatch = u.password === cleanPass || u.pin === cleanPass ||
        (!IS_CLOUDFLARE_BUILD && (
          (uUser === 'admin' && (cleanPass === 'admin123' || cleanPass === 'password123' || cleanPass === '123456')) ||
          (cleanPass === '123456')));
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
