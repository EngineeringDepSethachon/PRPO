import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, Sparkles, ScrollText, ReceiptText, Boxes, Zap, 
  SlidersHorizontal, WalletCards, ShoppingBag, Factory, X,
  User, ArrowRightLeft, ShieldCheck, LogOut
} from 'lucide-react';
import { workflowEngine } from '../../services/workflowEngine';
import { notificationService } from '../../services/notificationService';
import UserProfileModal from './UserProfileModal';
import { useAppContext } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { authService } from '../../services/authService';
import { getUserDepartments } from '../../utils/permissions';
import { calculateActiveClaimCount, calculatePendingActionCount, calculateUrgentTaskCount } from '../../context/ProcurementContext';
import { calculateProcurementBadgeCount } from '../../services/procurementService';

export default function Sidebar({ 
  activeView, 
  setActiveView, 
  currentRole, 
  currentUser,
  prs = [], 
  pos = [],
  urgentTaskCount: propUrgentTaskCount,
  isMobileOpen = false,
  onCloseMobile = () => {},
  onNavigate,
  onOpenPR,
  onOpenPO,
  onLogout,
  onRefresh,
  isDev
}) {

  const [showProfileModal, setShowProfileModal] = useState(false);

  // App context for dynamic notifications
  let context = null;
  try {
    context = useAppContext();
  } catch {
    context = null;
  }

  const globalTodoCount = context?.globalTodoCount || 0;

  let auth = null;
  try {
    auth = useAuth();
  } catch {
    auth = null;
  }

  // Environment Detection: dev when in import.meta.env.DEV
  const isDevEnvironment = isDev !== undefined
    ? Boolean(isDev)
    : Boolean(import.meta.env.DEV);

  const notifUserName = currentUser?.name || currentUser?.username || currentRole?.name || currentRole?.username || context?.currentUser?.name || context?.currentUser?.username;

  // Single-Click Instant Reactive Notification State (Role-scoped)
  const [notifications, setNotifications] = useState(() => {
    return notificationService.getNotificationsForRole(currentRole, notifUserName);
  });

  useEffect(() => {
    const rawList = (context?.notifications && context.notifications.length > 0)
      ? context.notifications
      : notificationService.getAll();
    const filtered = (rawList || []).filter(n => notificationService.isNotificationTarget(n, currentRole))
      .sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0));
    setNotifications(filtered);
  }, [context?.notifications, currentRole]);

  useEffect(() => {
    const unsub = notificationService.subscribe?.(() => {
      setNotifications(notificationService.getNotificationsForRole(currentRole, notifUserName));
    });
    return () => {
      if (unsub) unsub();
    };
  }, [currentRole, notifUserName]);

  // Helper ตรวจสอบ Unread ให้ครอบคลุมทุกคีย์
  const isUnread = (n) => {
    if (!n) return false;
    if (n.isRead === true || n.read === true || n.status === 'read') return false;
    const notifId = n.id || n._id;
    const readIds = notificationService.getReadNotificationIds(notifUserName);
    if (notifId && readIds.includes(notifId)) return false;
    return true;
  };

  const unreadBadgeCount = notifications.filter(isUnread).length;

  const handleMarkAllAsRead = async (itemsToMark) => {
    const listToMark = Array.isArray(itemsToMark) && itemsToMark.length > 0 ? itemsToMark : notifications;
    const ids = listToMark.map(n => n.id || n._id).filter(Boolean);

    // 1. บังคับ Re-render ใน React State ทันทีแบบ Optimistic (Single-Click Instant Update)
    setNotifications(prev => 
      prev.map(n => ({
        ...n,
        isRead: true,
        read: true,
        status: 'read'
      }))
    );

    // 2. อัปเดต AppContext ทันที
    if (context?.setNotifications) {
      context.setNotifications(prev =>
        prev.map(n => {
          if (ids.length === 0 || ids.includes(n.id) || ids.includes(n._id) || (!currentRole || notificationService.isNotificationTarget(n, currentRole))) {
            return { ...n, isRead: true, read: true, status: 'read' };
          }
          return n;
        })
      );
    }

    // 3. สั่ง Service ทำงาน (Persist ลง Storage และ Backend)
    if (notificationService?.markAllAsRead) {
      await notificationService.markAllAsRead(currentRole, ids, notifUserName);
    }
  };



  const fallbackUser = typeof authService?.getCurrentUser === 'function' ? authService.getCurrentUser() : null;
  const effectiveUser = currentRole || currentUser || auth?.currentUser || auth?.currentRole || fallbackUser;

  const isAdmin = Boolean(
    currentUser?.role === 'admin' || 
    currentUser?.roleId === 'ADMIN' || 
    currentRole?.role === 'admin' || 
    currentRole?.roleId === 'ADMIN' || 
    currentRole?.id === 'ADMIN' || 
    (currentRole?.level && currentRole.level >= 99) ||
    effectiveUser?.role === 'admin' ||
    effectiveUser?.roleId === 'ADMIN' ||
    effectiveUser?.canonicalRole === 'ADMIN' ||
    effectiveUser?.id === 'ADMIN' ||
    (effectiveUser?.level && effectiveUser.level >= 99) ||
    auth?.isAdmin
  );

  const isOnlinePurchaser = !isAdmin && Boolean(
    effectiveUser?.roleId === 'ONLINE_PURCHASER' ||
    effectiveUser?.id === 'ONLINE_PURCHASER'
  );

  // Dynamic UX Filtering: Check if current user has permission to view/manage budget
  // True for Admin, Plant Manager / Approver, Asst Manager / Reviewer, and Online Purchaser (Overview)
  const canViewBudget = Boolean(
    isAdmin ||
    isOnlinePurchaser || (
      effectiveUser?.canViewBudget === true ||
      effectiveUser?.canViewBudgetMenu === true ||
      auth?.canAccess?.('BUDGET_MANAGE') ||
      ['APPROVER', 'REVIEWER'].includes(effectiveUser?.canonicalRole) ||
      ['ASST_MANAGER', 'PLANT_MANAGER'].includes(effectiveUser?.roleId)
    )
  );

  // Helper: ตรวจสอบสถานะ Order ที่ปิดงานแล้ว
  const isOrderClosed = (status) => {
    if (!status) return false;
    const s = String(status).toUpperCase();
    return ['COMPLETED', 'CLOSED', 'COMPLETED_DELIVERY', 'CLOSED_ORDER', 'FINISHED', 'RESOLVED', 'CANCELLED'].includes(s) || s.startsWith('COMPLETED') || s.startsWith('CLOSED');
  };

  // Execution Directive 1: คำนวณจำนวน PO ที่อยู่ในแท็บรอเคลมจริง (activeClaimCount)
  const activeClaimCount = React.useMemo(() => {
    const orders = (pos && pos.length > 0) ? pos : (context?.pos || []);
    return calculateActiveClaimCount(orders);
  }, [pos, context?.pos]);

  // คำนวณจำนวนงานในแท็บ "รอดำเนินการ" (pendingActionCount)
  const pendingActionCount = React.useMemo(() => {
    const orders = (pos && pos.length > 0) ? pos : (context?.pos || []);
    const prList = (prs && prs.length > 0) ? prs : (context?.prs || []);
    return calculatePendingActionCount(orders, prList);
  }, [pos, prs, context?.pos, context?.prs]);

  // ผลรวมของ 2 แท็บที่เป็น Actionable Tasks สำคัญ: urgentTaskCount
  // กฎเหล็ก: ให้นับผ่าน calculateProcurementBadgeCount ที่เป็น Single Source of Truth
  const urgentTaskCount = React.useMemo(() => {
    const orders = (pos && pos.length > 0) ? pos : (context?.pos || []);
    return calculateProcurementBadgeCount(orders);
  }, [pos, context?.pos]);

  // Calculate Task Counts for Badges (using unified workflowEngine task aggregator)
  const taskCounts = React.useMemo(() => {
    const userTasks = workflowEngine.getUserTasks(effectiveUser || currentRole, prs, pos);
    return userTasks.counts;
  }, [prs, pos, currentRole, effectiveUser]);

  const menuCategories = [
    {
      title: 'WORKSPACE',
      items: [
        { 
          id: 'dashboard', 
          path: '/dashboard', 
          label: 'ภาพรวม',
          ariaLabel: 'ภาพรวม',
          icon: LayoutDashboard, 
          visible: true 
        },
        { 
          id: 'my-workspace', 
          path: '/my-workspace', 
          label: 'งานของฉัน',
          ariaLabel: 'งานของฉัน',
          icon: Sparkles, 
          visible: !isOnlinePurchaser, 
          badge: globalTodoCount > 0 ? globalTodoCount : null 
        },
        { 
          id: 'online-tasks', 
          path: '/online-tasks', 
          label: 'งานจัดซื้อ',
          ariaLabel: 'งานจัดซื้อ',
          icon: ShoppingBag, 
          visible: Boolean(effectiveUser?.canOnlinePurchase || isOnlinePurchaser), 
          badge: urgentTaskCount > 0 ? urgentTaskCount : null 
        },
      ]
    },
    {
      title: 'PROCUREMENT',
      items: [
        { 
          id: 'pr-list', 
          path: '/prs', 
          label: 'ใบขอซื้อ',
          ariaLabel: 'ใบขอซื้อ',
          icon: ScrollText, 
          visible: true, 
          badge: taskCounts.prCount > 0 ? taskCounts.prCount : null 
        },
        { 
          id: 'po-list', 
          path: '/pos', 
          label: 'ใบสั่งซื้อ',
          ariaLabel: 'ใบสั่งซื้อ',
          icon: ReceiptText, 
          visible: true, 
          badge: !isOnlinePurchaser && taskCounts.poCount > 0 ? taskCounts.poCount : null 
        },
        { 
          id: 'budget', 
          path: '/budget', 
          label: 'งบประมาณ',
          ariaLabel: 'งบประมาณ',
          icon: WalletCards, 
          visible: !isAdmin && canViewBudget 
        },
      ]
    },
    {
      title: 'INVENTORY & OPERATIONS',
      items: [
        { 
          id: 'stock-card', 
          path: '/inventory/stock-card', 
          label: 'คลังพัสดุ',
          ariaLabel: 'คลังพัสดุ',
          icon: Boxes, 
          visible: true 
        },
        { 
          id: 'quick-issue', 
          path: '/inventory/quick-issue', 
          label: 'เบิกจ่ายด่วน',
          ariaLabel: 'เบิกจ่ายด่วน',
          icon: Zap, 
          visible: !isOnlinePurchaser 
        },
      ]
    },
    {
      title: 'SYSTEM & ADMIN',
      items: [
        { 
          id: 'budget', 
          path: '/budget', 
          label: 'งบประมาณ',
          ariaLabel: 'งบประมาณ',
          icon: WalletCards, 
          visible: isAdmin 
        },
        { 
          id: 'master-data', 
          path: '/master-data', 
          label: 'ข้อมูลระบบ',
          ariaLabel: 'ข้อมูลระบบ',
          icon: SlidersHorizontal, 
          visible: !isOnlinePurchaser 
        },
        { 
          id: 'audit-logs', 
          path: '/admin/audit-logs', 
          label: 'บันทึกระบบ (Audit Logs)',
          ariaLabel: 'บันทึกระบบ (Audit Logs)',
          icon: ShieldCheck, 
          visible: isAdmin 
        },
      ]
    }
  ];

  const renderNavContent = (onItemClick = null) => (
    <div className="flex flex-col h-full">
      {/* ── 1. Top Section: Logo + System Name + Notification Bell ── */}
      <div className="px-1 pt-0.5 pb-3.5 border-b border-slate-100 shrink-0">
        <div className="flex items-center justify-between gap-2">
          {/* Logo & Title */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-xs shrink-0">
              <Factory className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-black tracking-tight text-slate-900 leading-none truncate">
                PR/PO & Stock
              </h1>
              <div className="flex items-center gap-1 mt-1">
                {(() => {
                  const userDepts = getUserDepartments(currentRole || currentUser).filter(d => d !== 'ALL' && d !== '*');
                  const deptText = userDepts.length > 0 ? userDepts.join(', ') : (isOnlinePurchaser ? 'Online' : 'ส่วนกลาง');
                  return (
                    <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md leading-none">
                      {deptText}
                    </span>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Top Actions: Notification Bell & Mobile Close Button */}
          <div className="flex items-center gap-1.5 shrink-0 ml-1">

            {onItemClick && (
              <button 
                onClick={onCloseMobile}
                className="md:hidden w-8 h-8 rounded-xl border border-slate-200/80 hover:bg-slate-100/80 flex items-center justify-center text-slate-400 hover:text-slate-900 transition-colors cursor-pointer"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 2. Navigation Links (Linear SaaS Style) ── */}
      <nav className="flex-1 overflow-y-auto py-2 pr-0.5 custom-scrollbar min-h-0 space-y-1">
        {menuCategories.map((category) => {
          if (category.visible === false) return null;
          const visibleItems = category.items.filter(item => item.visible);
          if (visibleItems.length === 0) return null;

          return (
            <div key={category.title} className="space-y-0.5">
              <div className="text-[11px] font-semibold text-slate-400 tracking-wider uppercase px-3 mb-1.5 mt-5 first:mt-2">
                {category.title}
              </div>

              {visibleItems.map(item => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    role="button"
                    aria-label={item.ariaLabel || item.label}
                    onClick={() => {
                      if (setActiveView) setActiveView(item.id);
                      if (onItemClick) onItemClick();
                    }}
                    className={({ isActive: navActive }) => {
                      const isActive = navActive || activeView === item.id;
                      return `group flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm transition-all duration-150 cursor-pointer ${
                        isActive
                          ? 'bg-slate-900 text-white font-semibold shadow-xs'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium'
                      }`;
                    }}
                  >
                    {({ isActive: navActive }) => {
                      const isActive = navActive || activeView === item.id;
                      return (
                        <>
                          <div className="flex items-center gap-3 min-w-0">
                            <Icon 
                              size={20} 
                              strokeWidth={1.8} 
                              className={`w-5 h-5 shrink-0 transition-colors ${
                                isActive 
                                  ? 'text-white' 
                                  : 'text-slate-400 group-hover:text-slate-700'
                              }`} 
                            />
                            <span className="truncate">{item.label}</span>
                          </div>

                          {item.id === 'online-tasks' ? (
                            urgentTaskCount > 0 && (
                              <span className={`ml-auto px-2 py-0.5 rounded-full text-xs font-bold text-white bg-rose-500 ${isActive ? 'shadow-sm ring-2 ring-slate-900' : 'shadow-xs'}`}>
                                {urgentTaskCount}
                              </span>
                            )
                          ) : (
                            item.badge && Number(item.badge) > 0 && (
                              isActive ? (
                                <span className="ml-auto px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold bg-white/20 text-white leading-none shrink-0">
                                  {item.badge}
                                </span>
                              ) : (item.id === 'my-tasks' || item.id === 'my-workspace') ? (
                                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                  <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold bg-rose-50 text-rose-600 border border-rose-200 leading-none">
                                    {item.badge}
                                  </span>
                                </span>
                              ) : (
                                <span className="ml-auto px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold bg-slate-100 text-slate-600 group-hover:bg-slate-200 transition-colors leading-none shrink-0">
                                  {item.badge}
                                </span>
                              )
                            )
                          )}
                        </>
                      );
                    }}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* ── 3. Footer: Modern Minimalist User Profile with Dedicated Logout Action ── */}
      <div className="mt-auto pt-2.5 border-t border-slate-100 shrink-0">
        <div className="w-full p-2 rounded-2xl bg-slate-50/60 hover:bg-slate-100/80 border border-slate-200/60 transition-colors flex items-center justify-between gap-2 text-left">
          {/* Left: User avatar with active status dot */}
          <button
            type="button"
            onClick={() => setShowProfileModal(true)}
            className="relative shrink-0 cursor-pointer focus:outline-none"
            title="คลิกเพื่อดูข้อมูลผู้ใช้งาน"
          >
            <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs ring-2 ring-white shadow-2xs">
              {currentRole?.name?.charAt(0) || <User className="w-4 h-4" />}
            </div>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white absolute -bottom-0.5 -right-0.5" />
          </button>

          {/* Middle: Truncated Info */}
          {(() => {
            const userDepts = getUserDepartments(currentRole || currentUser).filter(d => d !== 'ALL' && d !== '*');
            const rawTitle = currentRole?.title || 'Staff';
            const baseTitle = rawTitle.replace(/\s*\([^)]*\)\s*$/, '').trim();
            const deptDisplay = userDepts.length > 0 ? `(${userDepts.join(', ')})` : '';
            const displayRole = deptDisplay ? `${baseTitle} ${deptDisplay}` : rawTitle;

            return (
              <div 
                className="overflow-hidden min-w-0 flex-1 cursor-pointer"
                onClick={() => setShowProfileModal(true)}
                title="คลิกเพื่อดูข้อมูลโปรไฟล์และสลับบทบาท"
              >
                <span className="text-xs font-semibold text-slate-900 truncate block leading-tight hover:text-indigo-600 transition-colors">
                  {currentRole?.name || 'ผู้ใช้งาน'}
                </span>
                <span className="text-[11px] font-normal text-slate-500 truncate block leading-tight mt-0.5" title={displayRole}>
                  {displayRole}
                </span>
              </div>
            );
          })()}

          {/* Right: Action Group */}
          <div className="flex items-center gap-1 shrink-0">
            {isDevEnvironment && (
              <button
                type="button"
                onClick={() => setShowProfileModal(true)}
                title="สลับบัญชีผู้ใช้ (Switch Role)"
                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-white rounded-lg transition-colors duration-150 focus:outline-none cursor-pointer"
                aria-label="สลับบัญชีผู้ใช้"
                data-testid="sidebar-role-switch-btn"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                if (e) e.stopPropagation();
                if (onLogout) onLogout();
                else if (context?.handleLogout) context.handleLogout();
                else if (auth?.logout) auth.logout();
              }}
              title="ออกจากระบบ (Sign Out)"
              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-rose-500/20 cursor-pointer"
              aria-label="ออกจากระบบ"
              data-testid="sidebar-logout-btn"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Desktop Sidebar (Fixed Left) ── */}
      <aside className="w-64 bg-white border-r border-slate-200/80 shrink-0 h-screen fixed left-0 top-0 flex flex-col px-4 pt-3 pb-4 no-print z-40 hidden md:flex text-slate-900 shadow-sm">
        {renderNavContent()}
      </aside>

      {/* ── Mobile Sidebar Drawer (Overlay) ── */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex no-print animate-fade-in">
          <div 
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
          />
          <aside className="relative w-[280px] max-w-[85vw] bg-white border-r border-slate-200/80 h-full flex flex-col p-5 shadow-2xl z-10 animate-slide-in-left text-slate-900">
            {renderNavContent(onCloseMobile)}
          </aside>
        </div>
      )}


      {/* ── Integrated User Profile & Role Modal (with Fast Account Switcher) ── */}
      <UserProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        currentRole={currentRole}
        currentUser={currentUser}
        onLogout={onLogout}
        isDev={isDev}
      />
    </>
  );
}
