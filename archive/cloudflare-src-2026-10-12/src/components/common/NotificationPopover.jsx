import React, { useState, useMemo } from 'react';
import { 
  Bell, 
  CheckCheck, 
  X, 
  AlertTriangle, 
  CheckCircle2, 
  Package, 
  Lock, 
  Clock, 
  Inbox
} from 'lucide-react';

// Thai Date Formatter Helper
function formatNotificationTime(timestamp) {
  if (!timestamp) return 'เมื่อสักครู่';
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return String(timestamp);
    
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 60 && diffSec >= -60) return 'เมื่อสักครู่';
    if (diffSec >= 60 && diffSec < 3600) return `เมื่อ ${Math.floor(diffSec / 60)} นาทีที่แล้ว`;
    
    // แสดงเป็น วัน/เดือน เวลา น.
    const day = date.getDate();
    const month = date.toLocaleDateString('th-TH', { month: 'short' });
    const time = date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${day} ${month}, ${time} น.`;
  } catch (e) {
    return String(timestamp);
  }
}

export default function NotificationPopover(props) {
  const { 
    notifications = [], 
    onMarkAllAsRead, 
    markAllAsRead,
    onMarkAsRead, 
    onClose,
    onNotificationClick,
    currentUser,
    currentRole,
    className = ''
  } = props;

  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'unread'

  const user = currentUser || currentRole;
  const safeUserName = String(user?.name || user?.username || 'default').trim().toLowerCase();

  // Helper ดึง readIds แยกตาม user จาก localStorage
  const getLocalReadIds = () => {
    try {
      const stored = localStorage.getItem(`prpo_read_notifications_${safeUserName}`);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  };

  // Helper ตรวจสอบ Role & Department Filter (Strict Role & Dept, No Email)
  const matchesRoleAndDept = (n) => {
    if (!user) return true;

    const roleStr = String(user.role || user.canonicalRole || user.roleId || user.positionKey || '').toUpperCase();
    const isAdmin = user.isAdmin === true || roleStr.includes('ADMIN') || Number(user.level) >= 99 || user.username === 'admin';
    if (isAdmin) return true;

    const userDept = String(user.department || user.primaryDepartment || user.dept || '').toUpperCase();
    const targetDept = String(n.targetDepartment || n.targetDept || n.department || 'ALL').toUpperCase();
    const targetRole = String(n.targetRole || (Array.isArray(n.targetRoles) && n.targetRoles[0]) || 'ALL').toUpperCase();

    // 1. Department Filter: หากเป็น Approver หรืองานของ MGT ให้ข้ามเงื่อนไขตรวจสอบ department ได้
    const isApproverOrMGT = roleStr.includes('APPROV') || roleStr.includes('REVIEW') || roleStr.includes('MANAGER') || userDept === 'MGT';
    const isApproverTarget = targetRole.includes('APPROV') || targetRole.includes('REVIEW') || (Array.isArray(n.targetRoles) && n.targetRoles.some(r => {
      const ru = String(r).toUpperCase();
      return ru.includes('APPROV') || ru.includes('REVIEW') || ru.includes('MANAGER');
    }));

    const matchDept = (isApproverOrMGT && isApproverTarget)
      ? true
      : (targetDept === 'ALL' || userDept === 'ALL' || targetDept === userDept || userDept.includes(targetDept) || targetDept.includes(userDept));

    if (!matchDept && !user.canViewAllDepts && userDept !== 'ALL') {
      const userDepts = Array.isArray(user.assignedDepartments)
        ? user.assignedDepartments.map(d => String(d).toUpperCase())
        : [];
      if (!userDepts.includes(targetDept)) {
        return false;
      }
    }

    // 2. Role Filter
    if (targetRole === 'ALL') return true;

    if (targetRole.includes('REQUEST')) {
      return roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC') || Number(user.level) === 1;
    }
    if (targetRole.includes('APPROV')) {
      return isApproverOrMGT || roleStr.includes('APPROV') || roleStr.includes('REVIEW') || roleStr.includes('MANAGER') || Boolean(user.canReview || user.canFinalApprove);
    }
    if (targetRole.includes('PURCHAS') || targetRole.includes('BUYER')) {
      return roleStr.includes('PURCHAS') || roleStr.includes('BUYER') || Boolean(user.canOnlinePurchase);
    }

    return roleStr.includes(targetRole);
  };

  // กรอง notifications ตาม Role และ Department
  const scopedNotifications = useMemo(() => {
    return notifications.filter(matchesRoleAndDept);
  }, [notifications, user]);

  // Helper ตรวจสอบ Unread ให้ครอบคลุมทุกคีย์ และ localStorage readIds แยกตาม user
  const isUnread = (n) => {
    if (!n) return false;
    if (n.isRead === true || n.read === true || n.status === 'read') return false;
    const notifId = n.id || n._id;
    if (notifId && getLocalReadIds().includes(notifId)) return false;
    return true;
  };

  // คำนวณ Unread Count แบบ Real-time
  const unreadCount = useMemo(() => {
    return scopedNotifications.filter(isUnread).length;
  }, [scopedNotifications]);

  // กรองรายการตาม Tab
  const displayedNotifications = useMemo(() => {
    if (activeTab === 'unread') {
      return scopedNotifications.filter(isUnread);
    }
    return scopedNotifications;
  }, [scopedNotifications, activeTab]);

  // จัดการการคลิกที่รายการแจ้งเตือน: บันทึก readIds ลง localStorage ตาม user
  const handleItemClick = (item) => {
    const notifId = item.id || item._id;
    if (notifId) {
      try {
        const readIds = getLocalReadIds();
        if (!readIds.includes(notifId)) {
          readIds.push(notifId);
          localStorage.setItem(`prpo_read_notifications_${safeUserName}`, JSON.stringify(readIds));
        }
      } catch {}
    }
    if (onMarkAsRead) {
      onMarkAsRead(notifId);
    }
    if (onNotificationClick) {
      onNotificationClick(item);
    }
  };

  // ปรับการดักฟังปุ่ม "อ่านทั้งหมด": บันทึกลง localStorage ตาม user และแจ้ง Callback
  const handleMarkAll = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const readIds = getLocalReadIds();
      const idsToMark = scopedNotifications.map(n => n.id || n._id).filter(Boolean);
      const combined = Array.from(new Set(readIds.concat(idsToMark)));
      localStorage.setItem(`prpo_read_notifications_${safeUserName}`, JSON.stringify(combined));
    } catch {}
    const markFn = onMarkAllAsRead || markAllAsRead || props.markAllAsRead || props.onMarkAllAsRead;
    if (typeof markFn === 'function') {
      markFn(scopedNotifications);
    }
  };

  // Helper เลือกสไตล์และไอคอนตามประเภทการแจ้งเตือน
  const getNotificationVisuals = (item) => {
    const text = ((item.title || '') + ' ' + (item.message || '') + ' ' + (item.type || '')).toLowerCase();
    
    if (text.includes('short-close') || text.includes('ปิดก่อน') || text.includes('ยกเลิก')) {
      return {
        icon: <Lock size={15} strokeWidth={2.2} />,
        bg: 'bg-rose-50 text-rose-600 ring-1 ring-rose-200/60',
        badge: 'bg-rose-50 text-rose-700 border-rose-200',
        label: 'ปิดก่อนกำหนด'
      };
    }
    if (text.includes('partial') || text.includes('บางส่วน') || text.includes('ค้างส่ง')) {
      return {
        icon: <AlertTriangle size={15} strokeWidth={2.2} />,
        bg: 'bg-amber-50 text-amber-600 ring-1 ring-amber-200/60',
        badge: 'bg-amber-50 text-amber-700 border-amber-200',
        label: 'รับของบางส่วน'
      };
    }
    if (text.includes('รอการตรวจสอบ') || text.includes('รออนุมัติ') || text.includes('review') || item.type === 'PR_SUBMITTED' || item.type === 'PR_REVIEWED') {
      return {
        icon: <Clock size={15} strokeWidth={2.2} />,
        bg: 'bg-amber-50 text-amber-600 ring-1 ring-amber-200/60',
        badge: 'bg-amber-50 text-amber-700 border-amber-200',
        label: 'รออนุมัติ'
      };
    }
    if (text.includes('อนุมัติเรียบร้อย') || item.type === 'PR_APPROVED' || item.type === 'PO_APPROVED' || text.includes('ได้รับการอนุมัติ') || text.includes('สำเร็จ') || text.includes('approved')) {
      return {
        icon: <CheckCircle2 size={15} strokeWidth={2.2} />,
        bg: 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/60',
        badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        label: 'อนุมัติเรียบร้อย'
      };
    }
    return {
      icon: <Package size={15} strokeWidth={2.2} />,
      bg: 'bg-indigo-50 text-indigo-600 ring-1 ring-indigo-200/60',
      badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      label: 'คำสั่งซื้อ'
    };
  };

  return (
    <div 
      className={className || "fixed left-4 sm:left-[260px] top-4 w-[400px] max-w-[calc(100vw-32px)] sm:max-w-[calc(100vw-280px)] bg-white/95 backdrop-blur-xl rounded-3xl shadow-[0_25px_60px_-15px_rgba(15,23,42,0.25)] ring-1 ring-slate-900/10 overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-150 font-sans"}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 1. Header สไตล์คลีน พร้อมปุ่ม Action ที่ชัดเจน */}
      <div className="p-4 pb-3 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center shadow-xs">
            <Bell size={15} strokeWidth={2} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-900 tracking-tight">การแจ้งเตือน</h3>
              {unreadCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500 text-white shadow-xs font-mono">
                  {unreadCount}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleMarkAll}
            disabled={notifications.length === 0}
            className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold transition-all cursor-pointer active:scale-95 ${
              unreadCount > 0
                ? 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:text-indigo-700 border border-indigo-200/80 shadow-2xs'
                : 'text-slate-500 bg-slate-100 hover:bg-slate-200/70 border border-slate-200/80'
            } ${notifications.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
            title="ทำเครื่องหมายว่าอ่านแล้วทั้งหมด"
          >
            <CheckCheck className={`transition-transform ${unreadCount > 0 ? 'group-hover:scale-110 text-indigo-600' : 'text-slate-400'}`} size={14} strokeWidth={2.2} />
            <span>อ่านทั้งหมด</span>
          </button>
          {onClose && (
            <button 
              type="button"
              onClick={onClose}
              className="w-7 h-7 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
              title="ปิดหน้าต่าง"
            >
              <X size={15} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* 2. Modern Segmented Tab Switcher */}
      <div className="px-4 pt-3 pb-2 bg-slate-50/50">
        <div className="grid grid-cols-2 p-1 bg-slate-200/60 rounded-xl text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('all')}
            className={`py-1.5 rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'all'
                ? 'bg-white text-slate-900 shadow-xs font-bold'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span>ทั้งหมด</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-100 text-slate-600 font-mono">
              {notifications.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('unread')}
            className={`py-1.5 rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'unread'
                ? 'bg-white text-slate-900 shadow-xs font-bold'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span>ยังไม่อ่าน</span>
            {unreadCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-indigo-500 text-white font-bold font-mono">
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 3. Notification Card Stream */}
      <div className="max-h-[390px] overflow-y-auto divide-y divide-slate-100/80 overscroll-contain custom-scrollbar pb-1.5">
        {displayedNotifications.length === 0 ? (
          <div className="py-12 px-4 text-center">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
              <Inbox size={22} strokeWidth={1.5} />
            </div>
            <p className="text-xs font-semibold text-slate-700">ไม่มีการแจ้งเตือน</p>
            <p className="text-[11px] text-slate-400 mt-0.5">คุณเคลียร์งานทั้งหมดเรียบร้อยแล้ว เยี่ยมมาก! ⚡</p>
          </div>
        ) : (
          displayedNotifications.map((item) => {
            const itemUnread = isUnread(item);
            const visual = getNotificationVisuals(item);

            // Clean title and message to prevent 'undefined' string rendering
            const cleanTitle = (item.title || '').replace(/undefined/g, '').trim() || 'การแจ้งเตือน';
            const rawMessage = (item.message || '').replace(/undefined/g, 'หน่วย').trim();
            const cleanMessage = rawMessage.replace(/หน่วย\s*หน่วย/g, 'หน่วย');
            const displayMessage = (cleanMessage && cleanMessage !== 'หน่วย' && cleanMessage !== cleanTitle) ? cleanMessage : '';
            const cleanDocNo = (item.docNo && item.docNo !== 'undefined') ? item.docNo : '';

            return (
              <div
                key={item.id || item._id || Math.random()}
                onClick={() => handleItemClick(item)}
                className={`relative p-3.5 flex items-start gap-3 transition-all cursor-pointer group ${
                  itemUnread 
                    ? 'bg-indigo-50/25 hover:bg-indigo-50/50' 
                    : 'bg-white hover:bg-slate-50/80 opacity-80 hover:opacity-100'
                }`}
              >
                {/* Unread Left Border Stripe */}
                {itemUnread && (
                  <div className="absolute left-0 top-2 bottom-2 w-1 bg-indigo-600 rounded-r-full" />
                )}

                {/* Squircle Icon Container */}
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105 ${visual.bg}`}>
                  {visual.icon}
                </div>

                {/* Content Box */}
                <div className="flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${visual.badge}`}>
                      {visual.label}
                    </span>
                    {cleanDocNo && (
                      <span className="text-[10px] font-mono font-medium text-slate-400">
                        {cleanDocNo}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-400 ml-auto flex items-center gap-1 shrink-0">
                      <Clock size={11} />
                      {formatNotificationTime(item.timestamp || item.createdAt || item.time)}
                    </span>
                  </div>

                  {/* Title */}
                  <h4 className={`text-xs leading-snug line-clamp-1 ${itemUnread ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>
                    {cleanTitle}
                  </h4>

                  {/* Clean Non-repeating Description (No 'undefined') */}
                  {displayMessage && (
                    <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">
                      {displayMessage}
                    </p>
                  )}
                </div>

                {/* Pulse Indicator สำหรับรายการที่ยังไม่ได้อ่าน */}
                {itemUnread && (
                  <div className="shrink-0 self-center">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-600 ring-2 ring-white"></span>
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
