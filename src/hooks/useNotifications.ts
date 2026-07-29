/**
 * useNotifications.ts
 * In-app нотификации (Ден 6 hotfix v4) — списък + unread брой за bell iconа
 * в главната навигация. Explicit refetch (не realtime subscription — виж
 * usePendingInvitationsCount.ts за същото design решение и обосновка).
 */
import { useState, useCallback, useEffect } from 'react';
import {
  listNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead,
} from '../lib/notificationService';
import type { NotificationRow } from '../lib/types';

export function useNotifications(enabled: boolean) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [list, count] = await Promise.all([listNotifications(), getUnreadNotificationCount()]);
      setNotifications(list);
      setUnreadCount(count);
    } catch (e) {
      console.error('useNotifications refresh failed:', e);
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const markRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await markNotificationRead(id);
    } catch (e) {
      console.error('markRead failed:', e);
      refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? now })));
    setUnreadCount(0);
    try {
      await markAllNotificationsRead();
    } catch (e) {
      console.error('markAllRead failed:', e);
      refresh();
    }
  }, [refresh]);

  return { notifications, unreadCount, refresh, markRead, markAllRead };
}
