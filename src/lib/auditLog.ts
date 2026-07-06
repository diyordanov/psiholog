/**
 * auditLog.ts
 * Записва потребителски действия в таблицата `audit_log` за одит и проследимост.
 *
 * Таблицата има само INSERT политика (без UPDATE/DELETE) — веднъж записан ред
 * не може да бъде изтрит дори от самия потребител. Това е умишлено.
 */
import { supabase } from './supabase';

/** Всички валидни audit действия — централизирано, за да няма typo в различни компоненти. */
export type AuditAction =
  | 'login'
  | 'signup'
  | 'logout'
  | 'recovery_requested'
  | 'recovery_otp_verified'   // потребителят е кликнал recovery линка
  | 'old_passkeys_deleted'    // старите passkey-и са изтрити преди регистрация на нов
  | 'new_passkey_registered'
  | 'document_uploaded'
  | 'document_signed'
  | 'document_downloaded'
  | 'document_deleted'
  | 'signing_key_generated'
  | 'signing_key_deleted'
  | 'signature_verified';

/**
 * Записва едно действие в audit_log.
 *
 * @param userId    UUID на текущия потребител (от session.user.id)
 * @param action    Тип на действието (от AuditAction)
 * @param resourceId  Опционален UUID на засегнатия ресурс (документ, подпис и др.)
 *
 * IP адресът не може да се прочете надеждно от браузъра — оставяме null.
 * При нужда може да се добавя сървърно в Edge Function.
 * Грешката при запис е само логната (не блокира потребителя).
 */
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
