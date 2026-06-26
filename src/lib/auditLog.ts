import { supabase } from './supabase';

// IP адресът не може да се прочете надеждно от браузъра — затова го оставяме
// null тук; ако потрябва, ще се добавя сървърно (Edge Function) в по-късна фаза.
export async function logAuditEvent(
  userId: string,
  action: string,
  resourceId?: string
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    user_id: userId,
    action,
    resource_id: resourceId ?? null,
    user_agent: navigator.userAgent,
  });

  if (error) {
    console.error('Audit log запис неуспешен:', error.message);
  }
}
