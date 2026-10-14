/**
 * ProtectedRoute Component
 * 
 * Enforces declarative Route-Level Authentication and Role-Based Access Control (RBAC).
 * Evaluates `isAuthenticated`, `requiredRole`, `requiredPermission`, and department boundaries.
 */

import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, CANONICAL_ROLES, normalizeRole, PERMISSIONS } from '../../context/AuthContext';
import { authService } from '../../services/authService';

export function AccessDeniedCard({ 
  requiredRole, 
  requiredPermission, 
  currentRole, 
  onBack 
}) {
  const navigate = useNavigate();
  const handleReturn = () => {
    if (onBack) {
      onBack();
    } else {
      navigate('/dashboard', { replace: true });
    }
  };

  const cleanRoles = Array.isArray(requiredRole)
    ? requiredRole.filter(r => String(r).toUpperCase() !== 'WAREHOUSE')
    : (requiredRole && String(requiredRole).toUpperCase() !== 'WAREHOUSE' ? requiredRole : null);
  const roleLabel = Array.isArray(cleanRoles) ? cleanRoles.join(' หรือ ') : (cleanRoles || requiredRole);

  return (
    <div className="flex flex-col items-center justify-center min-h-[65vh] p-6 text-center animate-fade-in">
      <div className="w-full max-w-md bg-white border border-rose-100 rounded-3xl shadow-xl shadow-rose-500/5 p-8 relative overflow-hidden">
        {/* Subtle decorative background glow */}
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-rose-500/10 rounded-full blur-2xl pointer-events-none" />
        <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-indigo-500/10 rounded-full blur-2xl pointer-events-none" />

        {/* Lock Icon */}
        <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-tr from-rose-50 to-rose-100/80 border border-rose-200 flex items-center justify-center text-3xl shadow-sm text-rose-600 mb-5">
          🔒
        </div>

        <h2 className="text-xl font-bold text-slate-800 tracking-tight mb-2">
          สิทธิ์การเข้าถึงถูกจำกัด
        </h2>
        <p className="text-xs text-rose-600 font-mono tracking-wider uppercase font-semibold mb-4">
          403 Access Denied / Role Restriction
        </p>

        <p className="text-sm text-slate-600 leading-relaxed mb-6">
          บัญชีของคุณ (<span className="font-semibold text-slate-800">{currentRole?.name || currentRole?.displayName || currentRole?.canonicalRole || 'ผู้ใช้งาน'}</span>) 
          ไม่มีสิทธิ์เข้าถึงหน้านี้
        </p>

        {/* Security Meta details */}
        <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 text-left text-xs space-y-2 mb-6 font-mono">
          <div className="flex justify-between items-center text-slate-500">
            <span>บทบาทปัจจุบัน:</span>
            <span className="font-semibold text-slate-800 bg-slate-200/80 px-2 py-0.5 rounded">
              {currentRole?.canonicalRole || currentRole?.roleId || 'REQUESTER'}
            </span>
          </div>
          {requiredRole && (
            <div className="flex justify-between items-center text-slate-500">
              <span>บทบาทที่ต้องการ:</span>
              <span className="font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded">
                {roleLabel}
              </span>
            </div>
          )}
          {requiredPermission && (
            <div className="flex justify-between items-center text-slate-500">
              <span>สิทธิ์ที่ต้องการ:</span>
              <span className="font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded">
                {requiredPermission}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleReturn}
            className="flex-1 inline-flex justify-center items-center px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-[0.98] text-white text-xs font-semibold shadow-md transition-all duration-150"
          >
            ← กลับสู่หน้าหลัก
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProtectedRoute({
  children,
  requiredRole,
  allowedRoles,
  disallowRoles,
  disallowOnlinePurchaser,
  requiredPermission,
  requiredDepartment,
  fallback
}) {
  const location = useLocation();
  const auth = useAuth();

  const {
    isAuthenticated: authIsAuthenticated,
    canonicalRole: authCanonicalRole,
    currentRole: authCurrentRole,
    currentUser: authCurrentUser,
    hasRole,
    canAccess,
    canAccessDepartment,
    isLoading
  } = auth;

  // Real-time user resolution with fresh fallback to authService.getCurrentUser()
  const fallbackUser = typeof authService?.getCurrentUser === 'function' ? authService.getCurrentUser() : null;
  const activeUser = authCurrentUser || authCurrentRole || fallbackUser;
  const isAuthenticated = authIsAuthenticated || Boolean(activeUser);

  const effectiveCanonical = activeUser?.canonicalRole || 
    (activeUser ? normalizeRole(activeUser) : null) || 
    authCanonicalRole || 
    CANONICAL_ROLES.REQUESTER;

  // 1. Loading state
  if (isLoading && !activeUser) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
          <span className="text-xs text-slate-400 font-mono tracking-wider">กำลังตรวจสอบสิทธิ์...</span>
        </div>
      </div>
    );
  }

  // 2. Unauthenticated check -> Redirect to /login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // 3. Admin bypasses all role/permission restrictions
  const isAdmin = effectiveCanonical === CANONICAL_ROLES.ADMIN ||
    activeUser?.isAdmin === true ||
    activeUser?.roleId === 'ADMIN' ||
    String(activeUser?.role || '').toLowerCase() === 'admin' ||
    Number(activeUser?.level || 0) >= 99;

  if (isAdmin) {
    return children;
  }

  // 4. Role requirements resolution
  const effectiveRoles = allowedRoles || requiredRole;

  // Strict Online Purchaser check (strictly roleId or id === 'ONLINE_PURCHASER')
  const isOnlinePurchaser = !isAdmin && Boolean(
    activeUser?.roleId === 'ONLINE_PURCHASER' ||
    activeUser?.id === 'ONLINE_PURCHASER'
  );

  // Disallow Check (disallowOnlinePurchaser or disallowRoles)
  const isDisallowedByRole = Array.isArray(disallowRoles) && disallowRoles.some(r => {
    const roleUpper = String(r).toUpperCase();
    return (
      roleUpper === effectiveCanonical ||
      (activeUser?.roleId && roleUpper === String(activeUser.roleId).toUpperCase()) ||
      (roleUpper === 'ONLINE_PURCHASER' && isOnlinePurchaser)
    );
  });

  if ((disallowOnlinePurchaser && isOnlinePurchaser) || isDisallowedByRole) {
    if (fallback) {
      return <Navigate to={fallback} replace />;
    }
    return (
      <AccessDeniedCard
        requiredRole={effectiveRoles || 'AUTHORIZED_USERS'}
        currentRole={activeUser}
      />
    );
  }

  // 5. Role Requirement check (supports single role or array via requiredRole or allowedRoles)
  if (effectiveRoles) {
    const targetRoles = (Array.isArray(effectiveRoles) ? effectiveRoles : [effectiveRoles]).map(r => String(r).toUpperCase());
    const roleMatches = targetRoles.includes(effectiveCanonical) || 
      (activeUser?.roleId && targetRoles.includes(String(activeUser.roleId).toUpperCase())) ||
      (typeof hasRole === 'function' && hasRole(effectiveRoles));

    if (!roleMatches) {
      if (fallback) {
        return <Navigate to={fallback} replace />;
      }
      return (
        <AccessDeniedCard
          requiredRole={effectiveRoles}
          currentRole={activeUser}
        />
      );
    }
  }

  // 6. Permission Requirement check
  if (requiredPermission) {
    let hasPermission = typeof canAccess === 'function' ? canAccess(requiredPermission) : false;

    // Resilient Real-Time Fallbacks during State Transitions
    if (!hasPermission && activeUser) {
      if (requiredPermission === 'BUDGET_MANAGE') {
        hasPermission = Boolean(
          isAdmin ||
          isOnlinePurchaser ||
          activeUser.canViewBudget === true ||
          activeUser.canViewBudgetMenu === true ||
          ['APPROVER', 'ADMIN', 'REVIEWER'].includes(effectiveCanonical) ||
          ['ASST_MANAGER', 'PLANT_MANAGER', 'ADMIN'].includes(activeUser.roleId)
        );
      } else if (requiredPermission === 'PR_CREATE') {
        hasPermission = Boolean(
          isAdmin ||
          activeUser.canCreatePR === true ||
          ['REQUESTER', 'ADMIN'].includes(effectiveCanonical)
        );
      } else if (requiredPermission === 'PR_APPROVE') {
        hasPermission = Boolean(
          isAdmin ||
          activeUser.canReview === true ||
          activeUser.canFinalApprove === true ||
          ['APPROVER', 'REVIEWER', 'ADMIN'].includes(effectiveCanonical)
        );
      } else if (requiredPermission === 'ONLINE_PROCURE') {
        hasPermission = Boolean(
          isAdmin ||
          activeUser.canOnlinePurchase === true ||
          ['PURCHASER', 'ADMIN'].includes(effectiveCanonical)
        );
      } else if (requiredPermission === 'SYSTEM_ADMIN') {
        hasPermission = isAdmin;
      } else {
        const allowed = PERMISSIONS?.[requiredPermission];
        if (allowed && allowed.includes(effectiveCanonical)) {
          hasPermission = true;
        }
      }
    }

    if (!hasPermission) {
      if (fallback) {
        return <Navigate to={fallback} replace />;
      }
      return (
        <AccessDeniedCard
          requiredPermission={requiredPermission}
          currentRole={activeUser}
        />
      );
    }
  }

  // 6. Department Scoping check
  if (requiredDepartment && typeof canAccessDepartment === 'function' && !canAccessDepartment(requiredDepartment)) {
    if (fallback) {
      return <Navigate to={fallback} replace />;
    }
    return (
      <AccessDeniedCard
        requiredPermission={`DEPARTMENT_${requiredDepartment}`}
        currentRole={activeUser}
      />
    );
  }

  return children;
}
