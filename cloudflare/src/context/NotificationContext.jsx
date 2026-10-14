import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { notificationService } from '../services/notificationService';

const NotificationContext = createContext(null);

export function NotificationProvider({ children, currentRole }) {
  const [notifications, setNotifications] = useState(() => {
    return notificationService.getAll() || [];
  });

  // Sync with notificationService on mount or role change
  useEffect(() => {
    const list = notificationService.getNotificationsForRole(currentRole);
    setNotifications(list);

    const unsubscribe = notificationService.subscribe?.((updated) => {
      if (Array.isArray(updated)) {
        setNotifications(updated);
      }
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [currentRole]);

  // Real-time calculated unread count
  const unreadCount = useMemo(() => {
    return notifications.filter(n => !n.isRead && !n.read).length;
  }, [notifications]);

  // Atomic state update: Single-click immediate mark all as read
  const handleMarkAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true, read: true })));
    if (notificationService?.markAllAsRead) {
      notificationService.markAllAsRead(currentRole);
    }
  }, [currentRole]);

  // Atomic state update: Single-click immediate mark item as read
  const handleMarkAsRead = useCallback((id) => {
    setNotifications(prev => prev.map(n => (n.id === id || n._id === id) ? { ...n, isRead: true, read: true } : n));
    if (notificationService?.markAsRead) {
      notificationService.markAsRead(id);
    }
  }, []);

  // Clear all
  const handleClearAll = useCallback(() => {
    setNotifications([]);
    if (notificationService?.clearAll) {
      notificationService.clearAll();
    }
  }, []);

  const value = useMemo(() => ({
    notifications,
    unreadCount,
    setNotifications,
    markAllAsRead: handleMarkAllAsRead,
    markAsRead: handleMarkAsRead,
    clearAll: handleClearAll,
  }), [notifications, unreadCount, handleMarkAllAsRead, handleMarkAsRead, handleClearAll]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationContext() {
  const context = useContext(NotificationContext);
  return context;
}

export function useNotifications() {
  return useNotificationContext();
}

export default NotificationContext;
