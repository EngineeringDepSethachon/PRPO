/**
 * Global Authentication & Role-Based Access Control (RBAC) Subsystem
 * 
 * Provides centralized session management, canonical role normalization,
 * permission guards, and authentication.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { authService, DEFAULT_EMPLOYEE_ACCOUNTS } from '../services/authService.js';
import { storageService } from '../services/storageService.js';
import { auditService } from '../services/auditService.js';
import { resolveUserPermissions } from '../config/constants.js';
import { isCloudflareMode, SESSION_INVALID_EVENT, updateStoredSessionToken, storedSessionBelongsToOther, readStoredSession, SESSION_GONE_EVENT, announceSessionGone } from '../config/backendMode.js';
import { modalService } from '../services/modalService.js';
import { isAdminUser } from '../utils/adminRule.js';
import { isBufferRole } from '../utils/bufferRole.js';
import { clearProxiedFileCache } from '../utils/cfAttachments.js';

let _cachedClientIp = null;

/**
 * Non-blocking client IP detection via CORS-enabled endpoint
 * Caches IP in memory and sessionStorage
 */
export const fetchClientIp = async () => {
  if (_cachedClientIp && _cachedClientIp !== 'CLIENT_DIRECT' && _cachedClientIp !== 'UNKNOWN_IP') {
    return _cachedClientIp;
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem('client_ip');
      if (stored) {
        _cachedClientIp = stored;
        return stored;
      }
    }
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    const ip = data.ip || 'UNKNOWN_IP';
    _cachedClientIp = ip;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('client_ip', ip);
    }
    return ip;
  } catch (e) {
    const fallback = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('client_ip')) || 'CLIENT_DIRECT';
    _cachedClientIp = fallback;
    return fallback;
  }
};

/**
 * Synchronous getter for cached client IP
 */
export const getClientIp = () => {
  if (_cachedClientIp && _cachedClientIp !== 'UNKNOWN_IP') return _cachedClientIp;
  if (typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem('client_ip');
    if (stored) {
      _cachedClientIp = stored;
      return stored;
    }
  }
  return 'CLIENT_DIRECT';
};

export const AUTH_STORAGE_KEY = 'prpo_auth_session';
export const SESSION_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 Hours (mock / gas)
export const CF_SESSION_EXPIRATION_MS = 8 * 60 * 60 * 1000; // cloudflare : same as the server token TTL (TOKEN_TTL_SECONDS)
const sessionTtlMs = () => (isCloudflareMode() ? CF_SESSION_EXPIRATION_MS : SESSION_EXPIRATION_MS);

export const CANONICAL_ROLES = {
  REQUESTER: 'REQUESTER',
  REVIEWER: 'REVIEWER',
  PURCHASER: 'PURCHASER',
  APPROVER: 'APPROVER',
  ADMIN: 'ADMIN',
  // Phase 3 (FR-01) : the purchasing checker "พี่สุ" (roleId BUFFER, level 2) - sees the budget / every department and creates PRs, but is not a
  // reviewer / approver / budget setter (decision Q7), so it must not fall into REQUESTER (department-scoped) or REVIEWER
  BUFFER: 'BUFFER'
};

export const PERMISSIONS = {
  PR_CREATE: ['REQUESTER', 'BUFFER', 'ADMIN'],
  PR_APPROVE: ['APPROVER', 'ADMIN', 'REVIEWER'],
  ONLINE_PROCURE: ['PURCHASER', 'ADMIN'],
  CLAIM_RESOLVE: ['PURCHASER', 'ADMIN'],
  GRN_RECEIVE: ['REQUESTER', 'REVIEWER', 'ADMIN'],
  BUDGET_MANAGE: ['APPROVER', 'ADMIN', 'REVIEWER'],
  BUDGET_VIEW: ['APPROVER', 'ADMIN', 'REVIEWER', 'BUFFER'], // read the budget page (route guard) ; BUDGET_MANAGE stays the set / allocate right
  SYSTEM_ADMIN: ['ADMIN'],
  MASTER_DATA: ['REQUESTER', 'REVIEWER', 'PURCHASER', 'APPROVER', 'BUFFER', 'ADMIN']
};

/**
 * Normalizes any legacy or custom role into one of the canonical roles
 */
export const normalizeRole = (roleOrUser) => {
  if (!roleOrUser) return CANONICAL_ROLES.REQUESTER;

  // BUFFER is told apart by roleId (never by level) and wins over a stale stored canonicalRole (older sessions saved REQUESTER for it)
  if (typeof roleOrUser === 'string' ? roleOrUser.trim().toUpperCase() === 'BUFFER' : isBufferRole(roleOrUser)) return CANONICAL_ROLES.BUFFER;

  const rawRole = typeof roleOrUser === 'string'
    ? roleOrUser
    : (roleOrUser.canonicalRole || roleOrUser.roleId || roleOrUser.role || roleOrUser.positionKey || '');

  const val = String(rawRole).toUpperCase().trim();
  if (val.includes('ADMIN') || val.includes('SYS')) return CANONICAL_ROLES.ADMIN;
  if (val.includes('PURCHAS') || val.includes('BUYER') || val.includes('ONLINE')) return CANONICAL_ROLES.PURCHASER;
  if (val.includes('REVIEW') || val.includes('ASST')) return CANONICAL_ROLES.REVIEWER;
  if (val.includes('APPROV') || val.includes('PLANT_MANAGER') || val.includes('MANAGER') || val.includes('MGR')) return CANONICAL_ROLES.APPROVER;
  if (val.includes('REQUEST') || val.includes('USER') || val.includes('PD') || val.includes('QC') || val.includes('STOCK') || val.includes('WH') || val.includes('WAREHOUSE')) return CANONICAL_ROLES.REQUESTER;

  return CANONICAL_ROLES.REQUESTER;
};

/**
 * Reads `exp` (seconds) from a "base64url(payload).signature" token. No signature check.
 * Returns null when the token cannot be decoded or has no numeric exp.
 */
const getTokenExp = (token) => {
  try {
    const part = String(token).split('.')[0];
    if (!part) return null;
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const exp = Number(JSON.parse(json)?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp : null;
  } catch {
    return null;
  }
};

/**
 * Validates whether an existing stored session is still valid
 */
export const isSessionValid = (session) => {
  if (!session) return false;
  if (!session.id && !session.canonicalRole && !session.roleId && !session.employeeId && !session.username) return false;
  if (isCloudflareMode()) {
    // Server-issued token is mandatory; check exp (seconds) when the payload is decodable.
    if (typeof session.token !== 'string' || !session.token) return false;
    const exp = getTokenExp(session.token);
    if (exp !== null && Date.now() >= exp * 1000) return false;
  }
  if (!session.expiresAt) return true; // Legacy session format without expiresAt
  return Date.now() < Number(session.expiresAt);
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      if (typeof localStorage === 'undefined') return null;
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('prpo_explicit_signout') === 'true') {
        return null;
      }
      const stored = localStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem('prpo_auth_session');
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      if (!isSessionValid(parsed)) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem('prpo_auth_session');
        try { storageService.clearCloudflareDataCache?.(); } catch { /* best effort */ }
        return null;
      }
      return {
        id: parsed.id || ('SESSION-' + (parsed.canonicalRole || 'USER')),
        ...parsed,
        canonicalRole: normalizeRole(parsed)
      };
    } catch {
      return null;
    }
  });

  const [originalUser, setOriginalUser] = useState(() => {
    try {
      if (typeof localStorage === 'undefined') return null;
      const stored = localStorage.getItem('prpo_original_admin_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState(null);

  // Determine if current user or original user is Administrator
  const isAdmin = useMemo(() => {
    const userToCheck = originalUser || currentUser;
    if (!userToCheck) return false;
    const roleStr = String(userToCheck.canonicalRole || userToCheck.roleId || userToCheck.role || userToCheck.positionKey || '').toUpperCase();
    return isAdminUser(userToCheck, userToCheck.isAdmin === true ||
      roleStr.includes('ADMIN') ||
      Number(userToCheck.level) >= 99 ||
      userToCheck.username === 'admin');
  }, [currentUser, originalUser]);

  const isSimulating = Boolean(originalUser && originalUser.id !== currentUser?.id);

  // Synchronize canonical role and department info
  const canonicalRole = useMemo(() => {
    return normalizeRole(currentUser);
  }, [currentUser]);

  const currentRole = useMemo(() => {
    return currentUser ? { ...currentUser, canonicalRole } : null;
  }, [currentUser, canonicalRole]);

  const department = useMemo(() => {
    return currentUser?.department || 'PD';
  }, [currentUser]);

  const isAuthenticated = Boolean(currentUser && isSessionValid(currentUser));

  // Background client IP fetch without blocking page load
  useEffect(() => {
    fetchClientIp().catch(() => {});
  }, []);



  // Synchronize state when persona or session changes from outside (storage or custom event)
  useEffect(() => {
    const handleSync = (event) => {
      try {
        // cloudflare : another tab removed the session (sign-out) -> this tab signs out too, right away
        if (isCloudflareMode() && event?.type === 'storage' && (event.key === AUTH_STORAGE_KEY || event.key === null)
          && typeof localStorage !== 'undefined' && !localStorage.getItem(AUTH_STORAGE_KEY)) {
          announceSessionGone();
          return;
        }
        let session = event?.detail;
        if (!session && typeof localStorage !== 'undefined') {
          const stored = localStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem('prpo_auth_session');
          if (stored) session = JSON.parse(stored);
        }
        if (session && isSessionValid(session)) {
          const normalized = normalizeRole(session);
          setCurrentUser(prev => {
            // same user but a new token / forced-change flag / expiry (another tab signed in again or changed the password) must update this tab too
            if (!prev || prev.id !== session.id || prev.username !== session.username || prev.canonicalRole !== normalized
              || prev.token !== session.token || Boolean(prev.mustChangePassword) !== Boolean(session.mustChangePassword) || prev.expiresAt !== session.expiresAt) {
              return {
                ...session,
                canonicalRole: normalized
              };
            }
            return prev;
          });
        }
      } catch (e) {
        console.warn('[AuthContext] sync event error:', e);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handleSync);
      window.addEventListener('prpo_user_switched', handleSync);
      return () => {
        window.removeEventListener('storage', handleSync);
        window.removeEventListener('prpo_user_switched', handleSync);
      };
    }
  }, []);

  /**
   * Clear active session and reset credentials
   */
  const logout = useCallback(() => {
    const foreignSession = storedSessionBelongsToOther(currentUser?.token);
    try {
      if (currentUser) {
        try {
          auditService.logAction({
            action: 'LOGOUT',
            docType: 'USER',
            docNo: currentUser.username || currentUser.employeeId || 'USER',
            details: `ออกจากระบบสำเร็จ (Username: ${currentUser.username || currentUser.employeeId || 'USER'})`,
            actor: currentUser,
            department: currentUser.department || currentUser.primaryDepartment || 'PD'
          });
        } catch (auditErr) {
          console.warn('[AuthContext] Logout audit error:', auditErr);
        }
      }
      // another tab may already hold a NEWER session (signed in again / changed the password) : this tab only drops its own state
      if (!foreignSession) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem('prpo_current_user');
        localStorage.removeItem('currentUser');
        localStorage.removeItem('prpo_user');
        localStorage.removeItem('prpo_auth_session');
        localStorage.removeItem('prpo_original_admin_user');
      }
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.clear();
        sessionStorage.setItem('prpo_explicit_signout', 'true');
      }
    } catch (e) {
      console.warn('[AuthContext] Error clearing session:', e);
    }
    if (!foreignSession) {
      authService.logout();
      // cloudflare : the previous user's real data must not stay in memory / browser storage for the next sign-in
      try { storageService.clearCloudflareDataCache?.(); } catch (e) { console.warn('[AuthContext] cache clear error:', e); }
    }
    clearProxiedFileCache(); // blob: copies of protected files must not outlive the sign-in (this tab's cache is its own even if another tab has a newer session)
    setCurrentUser(null);
    setOriginalUser(null);
    setAuthError(null);
  }, [currentUser]);

  // cloudflare mode : the server rejected our token (password changed / reset, account closed) -> ask for a new sign-in, once
  const sessionInvalidHandled = React.useRef(false);
  const ignoreInvalidUntil = React.useRef(0); // requests that were already in flight with the OLD token answer 401 right after a password change
  useEffect(() => {
    if (!isCloudflareMode() || !currentUser || typeof window === 'undefined') return undefined;
    sessionInvalidHandled.current = false;
    const onInvalid = (ev) => {
      if (sessionInvalidHandled.current || Date.now() < ignoreInvalidUntil.current) return;
      const sent = ev && ev.detail ? ev.detail.token : '';
      const stored = readStoredSession();
      // Another tab already replaced the token (signed in again / changed the password) : the 401 belongs to the OLD token. Adopt the newer
      // session from storage instead of signing out.
      if (sent && stored && typeof stored.token === 'string' && stored.token && stored.token !== sent) {
        if (isSessionValid(stored)) setCurrentUser({ ...stored, canonicalRole: normalizeRole(stored) });
        return;
      }
      sessionInvalidHandled.current = true;
      const code = ev && ev.detail ? ev.detail.code : '';
      try {
        if (code === 'TOKEN_EXPIRED') modalService.warning('เซสชันหมดอายุ', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
        else modalService.warning('กรุณาเข้าสู่ระบบใหม่', 'เซสชันของคุณถูกยกเลิก (รหัสผ่านถูกเปลี่ยนหรือบัญชีถูกปิดใช้งาน) กรุณาเข้าสู่ระบบใหม่');
      } catch { /* UI optional */ }
      logout();
    };
    window.addEventListener(SESSION_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(SESSION_INVALID_EVENT, onInvalid);
  }, [currentUser, logout]);

  // cloudflare mode : another tab signed out (stored session removed) and a revalidation noticed -> drop this tab's state, keep storage as it is
  useEffect(() => {
    if (!isCloudflareMode() || typeof window === 'undefined') return undefined;
    const onGone = () => {
      if (readStoredSession() !== null) return;
      // no newer session exists any more : the real data cached by the previous user goes too
      try { storageService.clearCloudflareDataCache?.(); } catch (e) { console.warn('[AuthContext] cache clear error:', e); }
      setCurrentUser(null);
      setOriginalUser(null);
    };
    window.addEventListener(SESSION_GONE_EVENT, onGone);
    return () => window.removeEventListener(SESSION_GONE_EVENT, onGone);
  }, []);

  /** After POST /api/me/password : keep the fresh token, clear the forced-change flag. */
  const completePasswordChange = useCallback((newToken) => {
    ignoreInvalidUntil.current = Date.now() + 5000;
    const session = updateStoredSessionToken(newToken, false);
    setCurrentUser((prev) => (prev ? { ...prev, ...(session || {}), token: newToken, mustChangePassword: false, canonicalRole: prev.canonicalRole } : prev));
  }, []);

  // Periodic expiration verification
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(() => {
      if (currentUser.expiresAt && Date.now() > currentUser.expiresAt) {
        logout();
      }
    }, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [currentUser, logout]);

  /**
   * Helper Guard: Check if current user has the specified canonical role
   */
  const hasRole = useCallback((role) => {
    if (!isAuthenticated) return false;
    if (canonicalRole === CANONICAL_ROLES.ADMIN) return true; // Admin has super-role
    const target = Array.isArray(role) ? role : [role];
    return target.map(r => String(r).toUpperCase()).includes(canonicalRole);
  }, [isAuthenticated, canonicalRole]);

  /**
   * Helper Guard: Check if current user possesses permission
   */
  const canAccess = useCallback((permissionKey) => {
    if (!isAuthenticated) return false;
    if (canonicalRole === CANONICAL_ROLES.ADMIN) return true; // Admin always permitted
    if (canonicalRole === CANONICAL_ROLES.REVIEWER) {
      if (permissionKey === 'PR_REVIEW' || permissionKey === 'PR_APPROVE' || permissionKey === 'BUDGET_MANAGE' || permissionKey === 'MASTER_DATA') {
        return true;
      }
    }
    const allowedRoles = PERMISSIONS[permissionKey];
    if (!allowedRoles) return false;
    return allowedRoles.includes(canonicalRole);
  }, [isAuthenticated, canonicalRole]);

  /**
   * Helper Guard: Department scoping rule
   * - ADMIN, PURCHASER, APPROVER, BUFFER (read across departments) can access all departments
   * - REVIEWER is scoped to their assigned departments (e.g. 'PD, QC')
   * - REQUESTER is strictly scoped to their own department (e.g. 'PD' or 'QC')
   */
  const canAccessDepartment = useCallback((deptToCheck) => {
    if (!isAuthenticated) return false;
    if (canonicalRole === CANONICAL_ROLES.ADMIN ||
        canonicalRole === CANONICAL_ROLES.PURCHASER ||
        canonicalRole === CANONICAL_ROLES.APPROVER ||
        canonicalRole === CANONICAL_ROLES.BUFFER) {
      return true;
    }

    if (!deptToCheck || deptToCheck === 'ALL') return true;

    const userDept = currentUser?.department || '';
    const userDepts = currentUser?.departments || (
      userDept.includes(',') ? userDept.split(',').map(d => d.trim()) : [userDept]
    );

    return userDept === deptToCheck || userDepts.includes(deptToCheck);
  }, [isAuthenticated, canonicalRole, currentUser]);

  /**
   * Authenticate user with Identifier (Employee ID / Email) and PIN
   */
  const login = useCallback(async (usernameOrId, password) => {
    setIsLoading(true);
    setAuthError(null);

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('prpo_explicit_signout');
    }
    authService.clearExplicitSignOut();

    // Clear stale cached keys from previous sessions
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem('prpo_current_user');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('prpo_user');
    localStorage.removeItem('prpo_auth_session');
    localStorage.removeItem('prpo_original_admin_user');

    try {
      const verifiedUser = await authService.login(usernameOrId, password);
      if (!verifiedUser) {
        throw new Error('Username หรือ Password ไม่ถูกต้อง');
      }

      const normalized = normalizeRole(verifiedUser);
      const userDepts = verifiedUser.departments || verifiedUser.allowedDepartments || (verifiedUser.department ? [verifiedUser.department] : ['PD']);

      const sessionPayload = {
        ...verifiedUser,
        name: verifiedUser.name || verifiedUser.employeeName || verifiedUser.displayName,
        employeeName: verifiedUser.name || verifiedUser.employeeName || verifiedUser.displayName,
        displayName: verifiedUser.name || verifiedUser.employeeName || verifiedUser.displayName,
        primaryDepartment: verifiedUser.primaryDepartment || verifiedUser.department || 'PD',
        department: verifiedUser.department || 'PD',
        departments: userDepts,
        assignedDepartments: userDepts,
        allowedDepartments: userDepts,
        canonicalRole: normalized,
        expiresAt: Date.now() + sessionTtlMs()
      };

      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload));
      localStorage.setItem('prpo_auth_session', JSON.stringify(sessionPayload));
      storageService.setCurrentRole?.(sessionPayload);
      setCurrentUser(sessionPayload);
      setIsLoading(false);

      // Audit log successful login with client IP and Thai description
      try {
        auditService.logAction({
          action: 'LOGIN',
          docType: 'USER',
          docNo: verifiedUser.username || verifiedUser.employeeId || 'USER',
          details: `เข้าสู่ระบบสำเร็จ (Username: ${verifiedUser.username || verifiedUser.employeeId})`,
          actor: sessionPayload,
          department: sessionPayload.department || 'PD'
        });
      } catch (auditErr) {
        console.warn('[AuthContext] Login audit error:', auditErr);
      }

      return sessionPayload;
    } catch (err) {
      const msg = err?.message || 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ';
      setAuthError(msg);
      setIsLoading(false);
      throw err;
    }
  }, []);

  /**
   * Explicit Google Apps Script Login:
   * Clears explicit sign-out flag and invokes getNativeGoogleUser(true)
   */
  const loginWithGoogle = useCallback(async () => {
    setIsLoading(true);
    setAuthError(null);

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('prpo_explicit_signout');
    }
    authService.clearExplicitSignOut();

    try {
      const nativeSession = await authService.getNativeGoogleUser(true);
      if (!nativeSession) {
        throw new Error('ไม่พบข้อมูลบัญชี Google หรือยังไม่ได้รับสิทธิ์เข้าใช้งานระบบ (โปรดติดต่อผู้ดูแลระบบ)');
      }

      const normalized = normalizeRole(nativeSession);
      const userDepts = nativeSession.departments || nativeSession.allowedDepartments || (nativeSession.department ? [nativeSession.department] : ['PD']);

      const sessionPayload = {
        ...nativeSession,
        name: nativeSession.name || nativeSession.employeeName || nativeSession.displayName,
        employeeName: nativeSession.name || nativeSession.employeeName || nativeSession.displayName,
        displayName: nativeSession.name || nativeSession.employeeName || nativeSession.displayName,
        primaryDepartment: nativeSession.primaryDepartment || nativeSession.department || 'PD',
        department: nativeSession.department || 'PD',
        departments: userDepts,
        assignedDepartments: userDepts,
        allowedDepartments: userDepts,
        canonicalRole: normalized,
        expiresAt: Date.now() + sessionTtlMs()
      };

      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload));
      localStorage.setItem('prpo_auth_session', JSON.stringify(sessionPayload));
      storageService.setCurrentRole?.(sessionPayload);
      setCurrentUser(sessionPayload);
      setIsLoading(false);

      try {
        auditService.logAction({
          action: 'LOGIN',
          docType: 'USER',
          docNo: nativeSession.email || nativeSession.username || 'GOOGLE_USER',
          details: `เข้าสู่ระบบสำเร็จผ่าน Google Native Identity (${nativeSession.email || nativeSession.username})`,
          actor: sessionPayload,
          department: sessionPayload.department || 'PD'
        });
      } catch (auditErr) {
        console.warn('[AuthContext] Google Login audit error:', auditErr);
      }

      return sessionPayload;
    } catch (err) {
      const msg = err?.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อกับ Google Account';
      setAuthError(msg);
      setIsLoading(false);
      throw err;
    }
  }, []);

  /**
   * Fast Switcher for Development, UAT, and Admin Testing
   */
  const switchRoleDev = useCallback((roleOrUser) => {
    // Cloudflare mode: never mint a session client-side (no server token).
    if (isCloudflareMode()) {
      console.warn('[AuthContext] switchRoleDev ใช้ได้เฉพาะโหมดทดสอบ');
      return null;
    }
    let target = null;
    let userPool = DEFAULT_EMPLOYEE_ACCOUNTS;
    try {
      const cached = localStorage.getItem('prpo_users_cache') || localStorage.getItem('prpo_registered_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) userPool = parsed;
      }
    } catch (e) {}

    if (typeof roleOrUser === 'string') {
      const cleanKey = roleOrUser.trim().toLowerCase();
      target = userPool.find(u => 
        (u.id && u.id.toLowerCase() === cleanKey) ||
        (u.username && u.username.toLowerCase() === cleanKey) ||
        (u.roleId && u.roleId.toLowerCase() === cleanKey) ||
        (u.positionKey && u.positionKey.toLowerCase() === cleanKey) ||
        (u.canonicalRole && u.canonicalRole.toLowerCase() === cleanKey)
      );
      if (!target) {
        const targetCanonical = normalizeRole(roleOrUser);
        target = userPool.find(u => u.canonicalRole === targetCanonical) || userPool[0];
      }
    } else if (roleOrUser && typeof roleOrUser === 'object') {
      target = roleOrUser;
    }

    if (!target) return;

    // If simulating for the first time, save the original user session
    if (!originalUser && currentUser) {
      setOriginalUser(currentUser);
      try {
        localStorage.setItem('prpo_original_admin_user', JSON.stringify(currentUser));
      } catch (e) {
        console.warn('[AuthContext] Error storing original admin user:', e);
      }
    }

    const normalized = normalizeRole(target);
    const rolePermissions = resolveUserPermissions({ ...target, canonicalRole: normalized });
    const userDepts = target.departments || target.assignedDepartments || target.allowedDepartments || (target.department ? [target.department] : ['PD']);
    const sessionPayload = {
      ...target,
      ...rolePermissions,
      role: rolePermissions,
      rolePermissions: rolePermissions,
      departments: userDepts,
      assignedDepartments: target.assignedDepartments || userDepts,
      allowedDepartments: target.allowedDepartments || userDepts,
      primaryDepartment: target.primaryDepartment || userDepts[0] || 'PD',
      department: target.department || userDepts[0] || 'PD',
      canonicalRole: normalized,
      expiresAt: Date.now() + sessionTtlMs()
    };

    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload));
    localStorage.setItem('prpo_auth_session', JSON.stringify(sessionPayload));
    localStorage.setItem('prpo_current_user', JSON.stringify(sessionPayload));
    storageService.setCurrentRole?.(sessionPayload);
    setCurrentUser(sessionPayload);

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('prpo_user_switched', { detail: sessionPayload }));
      } catch (e) {}
    }

    return sessionPayload;
  }, [currentUser, originalUser]);

  /**
   * Revert simulation back to the primary authenticated admin user
   */
  const revertSimulation = useCallback(() => {
    if (!originalUser) return null;
    const restoredUser = {
      ...originalUser,
      canonicalRole: normalizeRole(originalUser),
      expiresAt: Date.now() + sessionTtlMs()
    };

    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(restoredUser));
    localStorage.removeItem('prpo_original_admin_user');
    storageService.setCurrentRole?.(restoredUser);
    setCurrentUser(restoredUser);
    setOriginalUser(null);
    return restoredUser;
  }, [originalUser]);

  const value = useMemo(() => ({
    currentUser,
    currentRole,
    canonicalRole,
    department,
    isAuthenticated,
    isLoading,
    authError,
    isAdmin,
    isSimulating,
    originalUser,
    login,
    loginWithGoogle,
    logout,
    switchRoleDev,
    revertSimulation,
    completePasswordChange,
    hasRole,
    canAccess,
    canAccessDepartment
  }), [
    completePasswordChange,
    currentUser,
    currentRole,
    canonicalRole,
    department,
    isAuthenticated,
    isLoading,
    authError,
    isAdmin,
    isSimulating,
    originalUser,
    login,
    loginWithGoogle,
    logout,
    switchRoleDev,
    revertSimulation,
    hasRole,
    canAccess,
    canAccessDepartment
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    return {
      currentUser: null,
      currentRole: null,
      canonicalRole: 'REQUESTER',
      department: 'PD',
      isAuthenticated: false,
      isLoading: false,
      authError: null,
      isAdmin: false,
      isSimulating: false,
      originalUser: null,
      login: async () => ({}),
      loginWithGoogle: async () => ({}),
      logout: () => {},
      switchRoleDev: () => ({}),
      revertSimulation: () => ({}),
      completePasswordChange: () => {},
      hasRole: () => false,
      canAccess: () => false,
      canAccessDepartment: () => false
    };
  }
  return context;
};

export default AuthContext;
