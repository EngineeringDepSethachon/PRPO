// Notification Service (In-App Local Caching)

const NOTIFICATIONS_STORAGE_KEY = 'prpo_in_app_notifications';

export const NOTIFICATION_TYPES = {
  PR_SUBMITTED: {
    id: 'PR_SUBMITTED',
    label: 'PR รอการตรวจสอบ (Review Level 1)',
    badgeColor: 'bg-amber-100 text-amber-800 border-amber-200',
    icon: 'FileText',
    colorHex: '#D97706',
    priority: 'URGENT'
  },
  PR_REVIEWED: {
    id: 'PR_REVIEWED',
    label: 'PR ผ่านการตรวจ รออนุมัติ (Final Approve)',
    badgeColor: 'bg-blue-100 text-blue-800 border-blue-200',
    icon: 'ShieldCheck',
    colorHex: '#2563EB',
    priority: 'URGENT'
  },
  PR_APPROVED: {
    id: 'PR_APPROVED',
    label: 'PR ได้รับการอนุมัติ (ออก PO อัตโนมัติ)',
    badgeColor: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    icon: 'CheckCircle2',
    colorHex: '#059669',
    priority: 'INFO'
  },
  PR_REJECTED: {
    id: 'PR_REJECTED',
    label: 'PR ถูกส่งกลับ / ปฏิเสธ',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'XCircle',
    colorHex: '#DC2626',
    priority: 'URGENT'
  },
  PR_CANCELLED: {
    id: 'PR_CANCELLED',
    label: 'PR ถูกยกเลิก',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'XCircle',
    colorHex: '#E11D48',
    priority: 'URGENT'
  },
  ONLINE_TASK: {
    id: 'ONLINE_TASK',
    label: 'งานสั่งซื้อออนไลน์ (Shopee/Lazada)',
    badgeColor: 'bg-purple-100 text-purple-800 border-purple-200',
    icon: 'ShoppingBag',
    colorHex: '#7C3AED',
    priority: 'URGENT'
  },
  ONLINE_ORDERED: {
    id: 'ONLINE_ORDERED',
    label: 'สั่งซื้อออนไลน์แล้ว (รอตรวจรับของ)',
    badgeColor: 'bg-purple-100 text-purple-800 border-purple-200',
    icon: 'ShoppingBag',
    colorHex: '#9333EA',
    priority: 'INFO'
  },
  PO_CANCELLED: {
    id: 'PO_CANCELLED',
    label: 'PO ถูกยกเลิก',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'XCircle',
    colorHex: '#BE123C',
    priority: 'URGENT'
  },
  GOODS_RECEIVED: {
    id: 'GOODS_RECEIVED',
    label: 'รับสินค้าเข้าคลัง (+IN Stock Card)',
    badgeColor: 'bg-teal-100 text-teal-800 border-teal-200',
    icon: 'PackageCheck',
    colorHex: '#0D9488',
    priority: 'INFO'
  },
  LOW_STOCK_ROP: {
    id: 'LOW_STOCK_ROP',
    label: 'แจ้งเตือนสต๊อกต่ำกว่าจุดสั่งซื้อ (ROP Alert)',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'AlertTriangle',
    colorHex: '#E11D48',
    priority: 'URGENT'
  },
  STOCK_ISSUED: {
    id: 'STOCK_ISSUED',
    label: 'เบิกจ่ายสินค้าสำเร็จ (-OUT)',
    badgeColor: 'bg-slate-100 text-slate-800 border-slate-200',
    icon: 'ArrowDownRight',
    colorHex: '#475569',
    priority: 'INFO'
  },
  PO_CLAIM: {
    id: 'PO_CLAIM',
    label: 'แจ้งปัญหา / เคลมสินค้า',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'AlertOctagon',
    colorHex: '#DC2626',
    priority: 'URGENT'
  },
  SELF_CLAIM: {
    id: 'SELF_CLAIM',
    label: 'แจ้งปัญหาสินค้า (จัดซื้อทั่วไป)',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'AlertTriangle',
    colorHex: '#E11D48',
    priority: 'URGENT'
  },
  PO_CLAIM_RESEND: {
    id: 'PO_CLAIM_RESEND',
    label: 'ส่งสินค้าทดแทน / จัดซื้อใหม่ (Claim Resend)',
    badgeColor: 'bg-blue-100 text-blue-800 border-blue-200',
    icon: 'RefreshCw',
    colorHex: '#2563EB',
    priority: 'URGENT'
  },
  PO_CLAIM_CLOSED: {
    id: 'PO_CLAIM_CLOSED',
    label: 'ปิดเคสหลังแจ้งปัญหา (Claim Closed)',
    badgeColor: 'bg-slate-100 text-slate-700 border-slate-200',
    icon: 'Lock',
    colorHex: '#64748B',
    priority: 'INFO'
  }

};

export const notificationService = {
  listeners: new Set(),

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  },

  notify() {
    const all = this.getAll();
    this.listeners.forEach(cb => {
      try { cb(all); } catch (e) { console.error(e); }
    });
  },

  // Read all notifications from local storage
  getAll() {
    try {
      const data = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveAll(notifications) {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications));
    this.notify();
  },

  // User-specific read status management in localStorage
  getReadNotificationIds(userName) {
    const safeName = String(userName || 'default').trim().toLowerCase();
    try {
      const data = localStorage.getItem(`prpo_read_notifications_${safeName}`);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveReadNotificationIds(userName, readIds) {
    const safeName = String(userName || 'default').trim().toLowerCase();
    try {
      const unique = Array.from(new Set((readIds || []).filter(Boolean)));
      localStorage.setItem(`prpo_read_notifications_${safeName}`, JSON.stringify(unique));
    } catch {}
  },

  markNotificationAsReadForUser(userName, id) {
    if (!id) return;
    const current = this.getReadNotificationIds(userName);
    current.push(id);
    this.saveReadNotificationIds(userName, current);
    this.notify();
  },

  markAllNotificationsAsReadForUser(userName, ids) {
    const current = this.getReadNotificationIds(userName);
    const combined = current.concat(ids || []);
    this.saveReadNotificationIds(userName, combined);
    this.notify();
  },

  // Helper to check if a notification is targeted for the current role and department (Strict Role & Dept, No Email)
  isNotificationTarget(n, currentRole) {
    if (!currentRole) return true;
    const roleId = String(currentRole.canonicalRole || currentRole.roleId || currentRole.id || currentRole.role || currentRole.positionKey || '').toUpperCase();
    const isAdmin = currentRole.isAdmin === true || roleId.includes('ADMIN') || Number(currentRole.level) >= 99 || currentRole.username === 'admin';
    if (isAdmin) return true;

    const userDept = String(currentRole.department || currentRole.primaryDepartment || currentRole.dept || '').toUpperCase();
    const targetDept = String(n.targetDepartment || n.targetDept || n.department || 'ALL').toUpperCase();
    const targetRole = String(n.targetRole || (Array.isArray(n.targetRoles) && n.targetRoles[0]) || 'ALL').toUpperCase();

    // 1. Department Filter: ปลดล็อกแผนกสำหรับ Approver และ MGT ให้เห็นงานขออนุมัติทุกแผนก
    const isApproverOrMGT = roleId.includes('APPROV') || roleId.includes('REVIEW') || roleId.includes('MANAGER') || userDept === 'MGT';
    const isApproverTarget = targetRole.includes('APPROV') || targetRole.includes('REVIEW') || (Array.isArray(n.targetRoles) && n.targetRoles.some(r => {
      const ru = String(r).toUpperCase();
      return ru.includes('APPROV') || ru.includes('REVIEW') || ru.includes('MANAGER');
    }));

    const matchDept = (isApproverOrMGT && isApproverTarget)
      ? true
      : (targetDept === 'ALL' || userDept === 'ALL' || targetDept === userDept || userDept.includes(targetDept) || targetDept.includes(userDept));

    if (!matchDept && !currentRole.canViewAllDepts && userDept !== 'ALL') {
      const userDepts = Array.isArray(currentRole.assignedDepartments)
        ? currentRole.assignedDepartments.map(d => String(d).toUpperCase())
        : [];
      if (!userDepts.includes(targetDept)) {
        return false;
      }
    }

    // 2. Target Roles Array Filter (WorkflowEngine & Dispatch compatibility)
    if (Array.isArray(n.targetRoles) && n.targetRoles.length > 0) {
      const userLevel = Number(currentRole.level || 1);
      const isOnline = roleId === 'ONLINE_PURCHASER' || currentRole.canOnlinePurchase;

      let roleMatches = n.targetRoles.some(r => {
        const rUpper = String(r).toUpperCase();
        return rUpper === roleId || rUpper === String(currentRole.id || '').toUpperCase() || rUpper === String(currentRole.roleId || '').toUpperCase() || rUpper === String(currentRole.positionKey || '').toUpperCase();
      });

      if (!roleMatches) {
        if (isOnline && n.targetRoles.some(r => String(r).toUpperCase().includes('ONLINE_PURCHASER') || String(r).toUpperCase().includes('PURCHAS'))) {
          roleMatches = true;
        } else if (!isOnline && (userLevel >= 2 || isApproverOrMGT) && n.targetRoles.some(r => ['ASST_MANAGER', 'REVIEWER', 'APPROVER', 'PLANT_MANAGER'].includes(String(r).toUpperCase()))) {
          roleMatches = true;
        } else if (userLevel === 1 && n.targetRoles.some(r => ['REQUESTER', 'REQUESTER_PD', 'REQUESTER_QC'].includes(String(r).toUpperCase()))) {
          roleMatches = true;
        }
      }

      if (!roleMatches) return false;
    }

    // 3. Target Role String Filter (Event-driven Notifications: 'Approver', 'Requester', 'Purchaser', 'ALL')
    if (n.targetRole) {
      const trUpper = String(n.targetRole).toUpperCase();
      if (trUpper !== 'ALL') {
        if (trUpper.includes('REQUEST')) {
          return roleId.includes('REQUEST') || roleId.includes('PD') || roleId.includes('QC') || Number(currentRole.level) === 1;
        }
        if (trUpper.includes('APPROV')) {
          return isApproverOrMGT || roleId.includes('APPROV') || roleId.includes('REVIEW') || roleId.includes('PLANT_MANAGER') || roleId.includes('ASST_MANAGER') || Boolean(currentRole.canReview || currentRole.canFinalApprove);
        }
        if (trUpper.includes('PURCHAS') || trUpper.includes('BUYER')) {
          return roleId.includes('PURCHAS') || roleId.includes('BUYER') || Boolean(currentRole.canOnlinePurchase);
        }
        return roleId.includes(trUpper);
      }
    }

    return true;
  },

  // Get notifications filtered for a specific role and augmented with user-specific read status
  getNotificationsForRole(currentRole, userName = null) {
    const all = this.getAll();
    const safeUser = userName || currentRole?.name || currentRole?.username || 'default';
    const userReadIds = new Set(this.getReadNotificationIds(safeUser));

    const augmented = all.map(n => {
      const notifId = n.id || n._id;
      const isRead = n.isRead === true || n.read === true || n.status === 'read' || userReadIds.has(notifId);
      return isRead ? { ...n, isRead: true, read: true, status: 'read' } : n;
    });

    if (!currentRole) return augmented;

    return augmented
      .filter(n => this.isNotificationTarget(n, currentRole))
      .sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0));
  },

  // Unread count
  getUnreadCountForRole(currentRole, userName = null) {
    const list = this.getNotificationsForRole(currentRole, userName);
    return list.filter(n => !(n.isRead === true || n.read === true || n.status === 'read')).length;
  },

  getUnreadCount(currentRole, userName = null) {
    return this.getUnreadCountForRole(currentRole, userName);
  },

  // Mark a specific notification as read (with user isolation)
  async markAsRead(id, userName = null) {
    if (userName) {
      this.markNotificationAsReadForUser(userName, id);
    }
    const all = this.getAll();
    const updated = all.map(n => (n.id === id || n._id === id) ? { ...n, isRead: true, read: true, status: 'read' } : n);
    this.saveAll(updated);

    return updated;
  },

  // Mark all notifications as read for role or specific item IDs (with user isolation)
  async markAllAsRead(currentRole, targetIds = null, userName = null) {
    const all = this.getAll();
    const idSet = Array.isArray(targetIds) && targetIds.length > 0 ? new Set(targetIds) : null;

    if (userName) {
      const idsToMark = idSet 
        ? Array.from(idSet)
        : all.filter(n => !currentRole || this.isNotificationTarget(n, currentRole)).map(n => n.id || n._id).filter(Boolean);
      this.markAllNotificationsAsReadForUser(userName, idsToMark);
    }

    const updated = all.map(n => {
      const shouldMark = idSet
        ? idSet.has(n.id) || idSet.has(n._id)
        : (!currentRole || this.isNotificationTarget(n, currentRole));

      if (shouldMark) {
        return { ...n, isRead: true, read: true, status: 'read' };
      }
      return n;
    });

    this.saveAll(updated);



    return updated;
  },

  // Clear all
  clearAll() {
    this.saveAll([]);

  },

  // Dispatch an In-App Notification
  dispatch({
    type,
    title,
    message,
    docNo = '',
    refDocType = '', // 'PR' | 'PO' | 'STOCK'
    refDocId = '',
    department = 'ALL',
    targetRoles = [],
    amount = null,
    actor = ''
  }) {
    const all = this.getAll();
    const typeInfo = NOTIFICATION_TYPES[type] || {
      id: type,
      label: 'การแจ้งเตือน',
      badgeColor: 'bg-slate-100 text-slate-700',
      colorHex: '#4F46E5'
    };

    const newNoti = {
      id: `NOTI-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type,
      typeInfo,
      title,
      message,
      docNo,
      refDocType,
      refDocId,
      department,
      targetRoles,
      amount,
      actor,
      timestamp: new Date().toISOString(),
      timeFormatted: new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
      isRead: false
    };

    all.unshift(newNoti);
    // Keep max 100 notifications in local cache to avoid memory bloating
    const trimmed = all.slice(0, 100);
    this.saveAll(trimmed);



    return newNoti;
  }
};
