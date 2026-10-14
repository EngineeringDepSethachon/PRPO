import React from 'react';
import { createPortal } from 'react-dom';
import { 
  UserCheck, Shield, X, Check, User, ArrowRightLeft, 
  Sparkles, Building2, ShoppingBag, Crown, Layers, LogOut
} from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useAuth, normalizeRole, PERMISSIONS } from '../../context/AuthContext';
import { getUserDepartments } from '../../utils/permissions';

const getDeptBadgeStyle = (dept) => {
  switch (dept?.toUpperCase()) {
    case 'QC':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'PD':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'WH':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'PUR':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'ENG':
      return 'bg-cyan-50 text-cyan-700 border-cyan-200';
    case 'ALL':
      return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    default:
      return 'bg-slate-50 text-slate-700 border-slate-200';
  }
};

export default function UserProfileModal({ 
  isOpen, 
  onClose, 
  currentRole, 
  currentUser,
  onLogout,
  isDev
}) {
  const appContext = useAppContext() || {};
  const { availableUsers = [], handleSwitchUser } = appContext;

  let auth = null;
  try {
    auth = useAuth();
  } catch (e) {
    auth = null;
  }

  if (!isOpen) return null;

  // Environment Detection: dev when in import.meta.env.DEV and not GAS
  const isDevEnvironment = isDev !== undefined ? Boolean(isDev) : Boolean(import.meta.env.DEV);

  const targetUser = auth?.currentUser || currentRole || currentUser || auth?.currentRole;
  if (!targetUser) return null;

  const currentDepts = getUserDepartments(targetUser);
  const canonicalRole = targetUser?.canonicalRole || 
    (targetUser ? normalizeRole(targetUser) : null) || 
    auth?.canonicalRole || 
    'REQUESTER';

  const handleSelectUser = (userAcc) => {
    let newSession = null;
    if (auth?.switchRoleDev) {
      newSession = auth.switchRoleDev(userAcc);
    }
    if (handleSwitchUser) {
      handleSwitchUser(userAcc);
    }

    // Safety check on active route/tab:
    // If the target persona lacks permission for the current screen, redirect immediately
    try {
      const activePath = (typeof window !== 'undefined' ? (window.location.hash || window.location.pathname) : '') || '';
      const newUser = newSession || userAcc;
      const roleId = String(newUser?.roleId || newUser?.id || '').toUpperCase();
      const canonical = String(newUser?.canonicalRole || (newUser ? normalizeRole(newUser) : '') || '').toUpperCase();
      const isAdminUser = roleId === 'ADMIN' || canonical === 'ADMIN' || Number(newUser?.level || 0) >= 99;
      const isOnlinePurchaserUser = roleId === 'ONLINE_PURCHASER' || canonical === 'PURCHASER';
      const hasBudgetPermission = isAdminUser || newUser?.canViewBudget === true || ['APPROVER', 'REVIEWER', 'ADMIN'].includes(canonical);

      if (!isAdminUser) {
        if (activePath.includes('budget') && !hasBudgetPermission) {
          if (appContext?.onNavigate) appContext.onNavigate('dashboard');
          else if (typeof window !== 'undefined') window.location.hash = '#/dashboard';
        } else if (activePath.includes('online-tasks') && !isOnlinePurchaserUser && !newUser?.canOnlinePurchase) {
          if (appContext?.onNavigate) appContext.onNavigate('dashboard');
          else if (typeof window !== 'undefined') window.location.hash = '#/dashboard';
        } else if (activePath.includes('master-data') && isOnlinePurchaserUser) {
          if (appContext?.onNavigate) appContext.onNavigate('online-tasks');
          else if (typeof window !== 'undefined') window.location.hash = '#/online-tasks';
        }
      }
    } catch (routeErr) {
      console.warn('[UserProfileModal] Route permission guard error:', routeErr);
    }

    onClose();
  };

  const handleLogoutFromModal = (e) => {
    if (e) e.stopPropagation();
    onClose();
    if (onLogout) {
      onLogout();
    } else if (appContext?.handleLogout) {
      appContext.handleLogout();
    } else if (auth?.logout) {
      auth.logout();
    }
  };

  // Dynamic Read-Only Permissions Matrix
  const canAccess = (perm) => {
    if (canonicalRole === 'ADMIN') return true;
    if (auth?.canAccess && !currentRole && !currentUser) {
      return auth.canAccess(perm);
    }
    const allowed = PERMISSIONS?.[perm];
    return allowed ? allowed.includes(canonicalRole) : false;
  };

  const canCreatePR = Boolean(
    canAccess('PR_CREATE') || 
    ['REQUESTER', 'ADMIN'].includes(canonicalRole) || 
    targetUser?.canCreatePR
  );

  const canApprove = Boolean(
    canAccess('PR_APPROVE') || 
    ['APPROVER', 'ADMIN'].includes(canonicalRole) || 
    targetUser?.canReview || 
    targetUser?.canFinalApprove
  );

  const canOnlineProcure = Boolean(
    canAccess('ONLINE_PROCURE') || 
    ['PURCHASER', 'ADMIN'].includes(canonicalRole) || 
    targetUser?.canOnlinePurchase
  );

  const canReceiveGRN = Boolean(
    canAccess('GRN_RECEIVE') || 
    ['WAREHOUSE', 'REQUESTER', 'ADMIN'].includes(canonicalRole) || 
    targetUser?.canReceiveGRN
  );

  const canManageBudget = Boolean(
    canAccess('BUDGET_MANAGE') || 
    ['APPROVER', 'ADMIN'].includes(canonicalRole) || 
    targetUser?.canViewBudgetMenu
  );

  const canManageMaster = Boolean(
    canAccess('SYSTEM_ADMIN') || 
    canonicalRole === 'ADMIN' || 
    targetUser?.canManageMaster
  );

  const modalContent = (
    <div 
      data-testid="user-profile-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden"
    >
      <div 
        data-testid="user-profile-modal"
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in"
      >
        
        {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <User className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 
                data-testid="profile-modal-title"
                className="font-bold text-slate-900 text-base tracking-tight"
              >
                {isDevEnvironment ? 'ข้อมูลผู้ใช้งาน & สลับบัญชี' : 'ข้อมูลผู้ใช้งานและสิทธิ์ในระบบ'}
              </h3>
              <p 
                data-testid="profile-modal-subtitle"
                className="text-xs text-slate-500 font-normal truncate mt-0.5"
              >
                {isDevEnvironment 
                  ? 'สิทธิ์การทำงานและสลับบทบาทจำลอง (Fast Account Switcher)' 
                  : 'รายละเอียดบัญชีผู้ใช้งานปัจจุบันและขอบเขตสิทธิ์การดำเนินงาน'}
              </p>
            </div>
          </div>

          <button 
            type="button"
            onClick={onClose} 
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            aria-label="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── 2. Scrollable Content Body (Flex-1 / Dynamic Height) ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0 custom-scrollbar bg-slate-50/30">
          
          {/* Active User Info Card */}
          <div className="p-4 bg-white rounded-2xl border border-slate-200/80 shadow-xs flex items-center gap-3.5">
            {targetUser.pictureUrl ? (
              <img
                src={targetUser.pictureUrl}
                alt="Profile"
                className="w-14 h-14 rounded-full object-cover border-2 border-indigo-500 shadow-xs shrink-0"
              />
            ) : (
              <div className="w-14 h-14 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xl border-2 border-indigo-300 shrink-0">
                {targetUser.name?.charAt(0) || 'U'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="font-bold text-slate-900 text-base truncate">{targetUser.name}</h4>
                {currentDepts.map(d => (
                  <span key={d} className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${getDeptBadgeStyle(d)}`}>
                    {d}
                  </span>
                ))}
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Active
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-0.5 font-medium">
                ตำแหน่ง: <span className="font-bold text-slate-800">{targetUser.position || targetUser.title || targetUser.canonicalRole || 'ผู้ใช้งาน'}</span>
                {currentDepts.length > 1 && (
                  <span className="text-indigo-600 font-bold ml-1.5">
                    ({currentDepts.join(', ')})
                  </span>
                )}
              </p>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-slate-400 flex-wrap">
                {targetUser.username && <span>@{targetUser.username}</span>}
                {targetUser.employeeId && <span>• {targetUser.employeeId}</span>}
                {targetUser.email && <span>• {targetUser.email}</span>}
                <span className="bg-indigo-50 text-indigo-700 border border-indigo-200/60 px-1.5 py-0.2 rounded font-sans text-[10px] font-bold">
                  {canonicalRole}
                </span>
              </div>
            </div>
          </div>

          {/* Fast Account Switcher Section (Dev Environment Only) */}
          {isDevEnvironment && (
            <div data-testid="dev-account-switcher-section" className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wider">
                  <ArrowRightLeft className="w-3.5 h-3.5 text-indigo-600" />
                  <span>สลับบัญชีผู้ใช้งาน (Fast Account Switcher)</span>
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  {availableUsers.length} บัญชีในระบบ
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {availableUsers.map((userAcc) => {
                  const isCurrent = userAcc.id === targetUser.id || 
                    userAcc.username === targetUser.username || 
                    (userAcc.roleId && userAcc.roleId === targetUser.roleId);

                  return (
                    <button
                      key={userAcc.id}
                      type="button"
                      onClick={() => handleSelectUser(userAcc)}
                      className={`p-3 rounded-2xl border text-left transition-all duration-150 cursor-pointer flex items-center justify-between gap-2.5 group ${
                        isCurrent
                          ? 'bg-indigo-50/80 border-indigo-300/80 shadow-xs ring-1 ring-indigo-500/20'
                          : 'bg-white hover:bg-slate-50 border-slate-200/80 hover:border-slate-300 shadow-2xs'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="relative shrink-0">
                          {userAcc.pictureUrl ? (
                            <img
                              src={userAcc.pictureUrl}
                              alt=""
                              className="w-9 h-9 rounded-full object-cover border border-slate-200"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs border border-slate-200">
                              {userAcc.name?.charAt(0) || <User className="w-4 h-4" />}
                            </div>
                          )}
                          {isCurrent && (
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white absolute -bottom-0.5 -right-0.5"></span>
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-xs font-bold block truncate ${
                              isCurrent ? 'text-indigo-900' : 'text-slate-800 group-hover:text-indigo-600'
                            }`}>
                              {userAcc.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                            <span className="text-[10px] text-slate-500 block truncate font-normal">
                              {userAcc.title}
                            </span>
                            {(() => {
                              const accDepts = getUserDepartments(userAcc).filter(d => d !== 'ALL' && d !== '*');
                              if (accDepts.length > 1) {
                                return (
                                  <div className="flex items-center gap-1">
                                    {accDepts.map(d => (
                                      <span key={d} className={`text-[9px] font-bold px-1.5 py-0.2 rounded-md border ${getDeptBadgeStyle(d)}`}>
                                        {d}
                                      </span>
                                    ))}
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        </div>
                      </div>

                      {isCurrent ? (
                        <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-2xs">
                          <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400 group-hover:text-indigo-600 font-medium shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          สลับ
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Permissions Matrix Box */}
          <div className="p-4 bg-white border border-slate-200/80 rounded-2xl space-y-2.5 text-xs shadow-xs">
            <p className="font-bold text-slate-800 flex items-center gap-2 pb-2 border-b border-slate-100">
              <Shield className="w-4 h-4 text-indigo-600" />
              <span>สิทธิ์การเข้าถึงและการดำเนินงานของบัญชีนี้:</span>
            </p>
            <ul className="space-y-2 text-slate-600 text-xs pt-1">
              <li className="flex items-center justify-between">
                <span>สร้างใบขอซื้อ (PR):</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canCreatePR ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canCreatePR ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>ตรวจทาน / อนุมัติ (Approver):</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canApprove ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canApprove ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>สั่งซื้อและดำเนินการออนไลน์:</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canOnlineProcure ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canOnlineProcure ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>ตรวจรับพัสดุเข้าคลัง (GRN):</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canReceiveGRN ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canReceiveGRN ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>จัดการงบประมาณแผนก:</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canManageBudget ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canManageBudget ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>จัดการข้อมูลหลัก (Master Data):</span>
                <span className={`font-semibold inline-flex items-center gap-1 ${canManageMaster ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {canManageMaster ? <><Check className="w-3.5 h-3.5" /> มีสิทธิ์</> : <><X className="w-3.5 h-3.5" /> ไม่มีสิทธิ์</>}
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* ── 3. Sticky Action Footer ── */}
        <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-3 sticky bottom-0 z-20">
          <div className="flex items-center gap-2">
            {isDevEnvironment && (
              <button
                type="button"
                onClick={onLogout}
                className="px-4 py-2 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                title="รีเซ็ตกลับเป็นบัญชีเริ่มต้น (คุณวิชัย - PD)"
                data-testid="modal-reset-default-btn"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 text-slate-400" />
                <span>รีเซ็ตบัญชีเริ่มต้น</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleLogoutFromModal}
              data-testid="modal-logout-btn"
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100/80 border border-rose-200/70 rounded-xl transition-colors duration-150 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>ออกจากระบบ (Sign Out)</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold transition-all cursor-pointer"
          >
            ปิด
          </button>
        </div>

      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalContent, document.body);
  }
  return modalContent;
}
