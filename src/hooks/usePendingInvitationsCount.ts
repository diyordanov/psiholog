/**
 * usePendingInvitationsCount.ts
 * Брой чакащи (pending) recipient покани за текущия потребител — за badge-а
 * в главната навигация ("Покани (2)"). Живее на ниво MainApp, `refresh()` се
 * подава надолу към PendingInvitationsPage/RecipientSigningModal, за да могат
 * claim/sign действия да обновят badge-а веднага. Няма realtime subscription
 * (explicit refetch pattern, виж бележката в useNotifications.ts) — вместо
 * това периодично polling + refresh при връщане към таба, за да не се налага
 * презареждане на страницата, когато нова покана пристигне докато е отворена.
 */
import { useState, useCallback, useEffect } from 'react';
import { listMyInvitations, isInvitationPending } from '../lib/signingRequestService';

const POLL_INTERVAL_MS = 30_000;

export function usePendingInvitationsCount(email: string | null) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!email) { setCount(0); return; }
    try {
      const invitations = await listMyInvitations(email);
      setCount(invitations.filter(isInvitationPending).length);
    } catch (e) {
      // Badge не е критичен UI елемент — грешка тук не трябва да чупи навигацията.
      console.error('usePendingInvitationsCount refresh failed:', e);
    }
  }, [email]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  return { count, refresh };
}
