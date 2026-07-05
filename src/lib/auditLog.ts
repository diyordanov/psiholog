import { supabase } from './supabase';

// Всички валидни audit действия — централизирано, за да няма typo в различни компоненти.
export type AuditAction =
  | 'login'
  | 'signup'
  | 'logout'
  | 'recovery_requested'
  | 'recovery_otp_verified'
  | 'old_passkeys_deleted'
  | 'new_passkey_registered'
  | 'document_uploaded'
  | 'document_signed'
  | 'document_downloaded'
  | 'document_deleted'
  | 'signing_key_generated'
  | 'signature_verified';

// IP адресът не може да се прочете надеждно от браузъра — оставяме null;
// ако потрябва, ще се добавя сървърно (Edge Function) в по-късна фаза.
export async function logAuditEvent(
  userId: string,
  action: AuditAction,
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
