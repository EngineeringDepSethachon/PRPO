import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import NotificationPopover from './NotificationPopover';
import { notificationService } from '../../services/notificationService';
import { useAppContext } from '../../context/AppContext';

export default function NotificationDrawer({ 
  isOpen, 
  onClose, 
  currentRole, 
  onNavigate, 
  onOpenPR, 
  onOpenPO, 
  onRefresh 
}) {
  const context = useAppContext();
  const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER';

  const userName = context?.currentUser?.name || context?.currentUser?.username || currentRole?.name || currentRole?.username;

  const [notifications, setNotifications] = useState(() => {
    return notificationService.getNotificationsForRole(currentRole, userName);
  });

  useEffect(() => {
    const rawList = (context?.notifications && context.notifications.length > 0)
      ? context.notifications
      : notificationService.getAll();
    const filtered = (rawList || []).filter(n => notificationService.isNotificationTarget(n, currentRole))
      .sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0));
    setNotifications(filtered);
  }, [context?.notifications, currentRole, isOpen]);

  useEffect(() => {
    const unsub = notificationService.subscribe?.(() => {
      setNotifications(notificationService.getNotificationsForRole(currentRole, userName));
    });
    return () => {
      if (unsub) unsub();
    };
  }, [currentRole, userName]);

  if (!isOpen) return null;

  // Atomic state update: Single click marks all as read instantly!
  const handleMarkAllAsRead = async (itemsToMark) => {
    const listToMark = Array.isArray(itemsToMark) && itemsToMark.length > 0 ? itemsToMark : notifications;
    const ids = listToMark.map(n => n.id || n._id).filter(Boolean);

    setNotifications(prev => prev.map(n => ({ ...n, isRead: true, read: true, status: 'read' })));
    if (context?.setNotifications) {
      context.setNotifications(prev => prev.map(n => {
        if (ids.length === 0 || ids.includes(n.id) || ids.includes(n._id) || (!currentRole || notificationService.isNotificationTarget(n, currentRole))) {
          return { ...n, isRead: true, read: true, status: 'read' };
        }
        return n;
      }));
    }
    if (notificationService?.markAllAsRead) {
      await notificationService.markAllAsRead(currentRole, ids, userName);
    }
  };

  const handleMarkAsRead = async (id) => {
    setNotifications(prev => prev.map(n => (n.id === id || n._id === id) ? { ...n, isRead: true, read: true, status: 'read' } : n));
    if (context?.setNotifications) {
      context.setNotifications(prev => prev.map(n => (n.id === id || n._id === id) ? { ...n, isRead: true, read: true, status: 'read' } : n));
    }
    if (notificationService?.markAsRead) {
      await notificationService.markAsRead(id, userName);
    }
  };

  const handleNotificationClick = (item) => {
    handleMarkAsRead(item.id || item._id);
    onClose?.();
    
    const docRef = String(item.docRef || item.refDocId || '').toUpperCase();
    const type = String(item.type || '').toUpperCase();
    
    if (docRef.includes('PR') || docRef.startsWith('PR-') || item.refDocType === 'PR') {
      if (onOpenPR && docRef) {
        onOpenPR(docRef);
      } else if (onNavigate) {
        onNavigate('pr-list');
      }
    } else if (docRef.includes('PO') || docRef.startsWith('PO-') || item.refDocType === 'PO') {
      if (onOpenPO && docRef) {
        onOpenPO(docRef);
      } else if (onNavigate) {
        onNavigate(type === 'ONLINE_TASK' ? 'online-tasks' : 'po-list');
      }
    } else if (type === 'LOW_STOCK_ROP' || type === 'STOCK_ISSUED' || type === 'GOODS_RECEIVED' || item.refDocType === 'STOCK') {
      if (onNavigate) onNavigate('stock-card');
    } else {
      if (onNavigate) onNavigate('my-workspace');
    }
  };

  return createPortal(
    <>
      {/* ── Invisible Backdrop (Click-outside) ── */}
      <div 
        className="fixed inset-0 z-40 bg-slate-900/10 backdrop-blur-2xs no-print animate-fade-in" 
        onClick={onClose} 
      />

      {/* ── Floating Notification Popover (Fixed Position) ── */}
      <NotificationPopover
        notifications={notifications}
        onMarkAllAsRead={handleMarkAllAsRead}
        markAllAsRead={handleMarkAllAsRead}
        onMarkAsRead={handleMarkAsRead}
        onClose={onClose}
        onNotificationClick={handleNotificationClick}
        currentUser={context?.currentUser}
        currentRole={currentRole}
      />
    </>,
    document.body
  );
}
