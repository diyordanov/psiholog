/**
 * notificationService.ts
 * In-app нотификации при подпис (Ден 6 hotfix v4) — виж migration 0018.
 */
import { supabase } from './supabase';
import type { NotificationRow, NotificationType } from './types';

/**
 * Известява всички ОСТАНАЛИ участници на заявка (owner + claim-нати
 * recipients, без текущия signer) чрез SECURITY DEFINER RPC. Best-effort —
 * вика се СЛЕД успешен подпис, неуспех тук не отменя вече записания подпис.
 */
export async function notifySigningParticipants(
  signingRequestId: string,
  type: NotificationType,
  message: string,
  excludeUserId: string,
): Promise<void> {
  const { error } = await supabase.rpc('notify_signing_participants', {
    p_signing_request_id: signingRequestId,
    p_type: type,
    p_message: message,
    p_exclude_user_id: excludeUserId,
  });
  if (error) console.error('notifySigningParticipants failed:', error.message);
}

/** Зарежда последните нотификации на текущия потребител (най-нови първи). */
export async function listNotifications(limit = 20): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, signing_request_id, type, message, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

/** Брой непрочетени нотификации — за badge в главната навигация. */
export async function getUnreadNotificationCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Маркира една нотификация като прочетена. */
export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Маркира ВСИЧКИ нотификации на текущия потребител като прочетени. */
export async function markAllNotificationsRead(): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw new Error(error.message);
}
