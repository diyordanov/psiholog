/**
 * usePendingInvitationsCount.ts
 * Брой чакащи (pending) recipient покани за текущия потребител — за badge-а
 * в главната навигация ("Покани (2)"). Живее на ниво MainApp, `refresh()` се
 * подава надолу към PendingInvitationsPage/RecipientSigningModal, за да могат
 * claim/sign действия да обновят badge-а веднага (не realtime subscription —
 * explicit refetch след действие, достатъчно за MVP scope).
 */
import { useState, useCallback, useEffect } from 'react';
import { listMyInvitations, isInvitationPending } from '../lib/signingRequestService';

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

  return { count, refresh };
}
