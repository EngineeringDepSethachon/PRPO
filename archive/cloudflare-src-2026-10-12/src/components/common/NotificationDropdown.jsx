import React, { useMemo } from 'react';
import NotificationPopover from './NotificationPopover';

/**
 * Modern NotificationDropdown (Alias / Adapter for NotificationPopover)
 */
export default function NotificationDropdown({ 
  notifications: propNotifications,
  onMarkAllAsRead, 
  onMarkAsRead, 
  onClose,
  onNotificationClick,
  prs = [],
  pos = [],
  currentRole,
  onNavigate
}) {
  // If standard notifications prop is provided, pass directly to NotificationPopover
  if (propNotifications) {
    return (
      <NotificationPopover
        notifications={propNotifications}
        onMarkAllAsRead={onMarkAllAsRead}
        onMarkAsRead={onMarkAsRead}
        onClose={onClose}
        onNotificationClick={onNotificationClick}
      />
    );
  }

  // Legacy fallback adapter if called with prs/pos
  const adaptedNotifications = useMemo(() => {
    const list = [];
    prs.forEach(pr => {
      if (pr.status === 'PENDING' || pr.status === 'SUBMITTED') {
        list.push({
          id: `pr-${pr.id}`,
          title: `ใบขอซื้อ ${pr.prNo || pr.id}`,
          message: `รอการอนุมัติ ยอดรวม ฿${(pr.grandTotal || pr.totalAmount || 0).toLocaleString()}`,
          type: 'PR',
          docNo: pr.prNo || pr.id,
          timestamp: pr.requestedDate || 'เมื่อสักครู่',
          isRead: false
        });
      }
    });
    pos.forEach(po => {
      if (po.status === 'IN_PROGRESS_ONLINE') {
        list.push({
          id: `po-${po.id}`,
          title: `งานสั่งซื้อออนไลน์ ${po.poNo || po.id}`,
          message: 'รอการสั่งซื้อในระบบออนไลน์',
          type: 'PO',
          docNo: po.poNo || po.id,
          timestamp: po.issueDate || 'เมื่อสักครู่',
          isRead: false
        });
      }
    });
    return list;
  }, [prs, pos]);

  return (
    <NotificationPopover
      notifications={adaptedNotifications}
      onMarkAllAsRead={onMarkAllAsRead}
      onMarkAsRead={onMarkAsRead}
      onClose={onClose}
      onNotificationClick={(item) => {
        if (onNotificationClick) onNotificationClick(item);
        else if (onNavigate) onNavigate(item.type === 'PR' ? 'pr-list' : 'po-list');
      }}
    />
  );
}
