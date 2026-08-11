/**
 * documentDeleteConsentService.ts
 * Взаимно съгласувано изтриване на споделен (multi-signer) документ (migration 0020).
 *
 * Документът/signing_request е ЕДИН споделен ред между owner и recipients —
 * eднолично изтриване от която и да е страна премахва документа за всички
 * (виж migration 0019). Затова: ако документът има поне един claim-нат
 * recipient, изтриването минава през request→consent RPC flow вместо директен
 * UPDATE. Мутациите са изцяло в SECURITY DEFINER функции — тук само ги викаме.
 */
import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';
import type { DeleteRequestRow, DeleteConsentRow, DeleteDecision } from './types';

export interface RequestDeletionResult {
  status: 'deleted' | 'pending';
  requestId: string | null;
}

/**
 * Инициира изтриване на документ. Ако документът няма claim-нати recipients
 * (solo или все още невключен в подписването), изтрива веднага. Иначе създава
 * pending заявка за съгласие (requester-ът автоматично се брои за съгласен) и
 * известява останалите страни.
 */
export async function requestDocumentDeletion(
  documentId: string,
  userId: string,
): Promise<RequestDeletionResult> {
  const { data, error } = await supabase.rpc('request_document_deletion', {
    p_document_id: documentId,
  });
  if (error) {
    console.error('requestDocumentDeletion failed:', error.message);
    throw new Error('Грешка при заявка за изтриване. Опитайте отново.');
  }
  const result = data as { status: 'deleted' | 'pending'; request_id: string | null };

  await logAuditEvent(
    userId,
    result.status === 'deleted' ? 'document_deleted' : 'document_delete_requested',
    documentId,
  );

  return { status: result.status, requestId: result.request_id };
}

/**
 * Отговор на pending заявка за изтриване. 'declined' анулира заявката веднага.
 * 'approved' записва съгласието на текущия потребител — ако това е последната
 * нужна страна, документът реално се изтрива в същата транзакция (в RPC-то).
 */
export async function respondDocumentDeletion(
  requestId: string,
  decision: DeleteDecision,
  userId: string,
  documentId: string,
): Promise<DeleteRequestRow['status']> {
  const { data, error } = await supabase.rpc('respond_document_deletion', {
    p_request_id: requestId,
    p_decision: decision,
  });
  if (error) {
    console.error('respondDocumentDeletion failed:', error.message);
    throw new Error('Грешка при отговор на заявката. Опитайте отново.');
  }

  await logAuditEvent(
    userId,
    decision === 'approved' ? 'document_delete_consented' : 'document_delete_declined',
    documentId,
  );

  return data as DeleteRequestRow['status'];
}

/** Всички pending заявки, видими за текущия потребител (owner или recipient на свързаната заявка). */
export async function listPendingDeleteRequests(): Promise<DeleteRequestRow[]> {
  const { data, error } = await supabase
    .from('document_delete_requests')
    .select('id, document_id, signing_request_id, requested_by, status, created_at, resolved_at')
    .eq('status', 'pending');
  if (error) throw new Error(error.message);
  return (data ?? []) as DeleteRequestRow[];
}

/** Consent редовете за дадени pending заявки — ползва се за да определим дали текущият потребител вече е отговорил. */
export async function listDeleteConsents(requestIds: string[]): Promise<DeleteConsentRow[]> {
  if (requestIds.length === 0) return [];
  const { data, error } = await supabase
    .from('document_delete_consents')
    .select('id, delete_request_id, user_id, decision, decided_at')
    .in('delete_request_id', requestIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeleteConsentRow[];
}
