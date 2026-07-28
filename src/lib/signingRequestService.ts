/**
 * signingRequestService.ts
 * DB READ/UPDATE операции за multi-signer заявки (signing_requests +
 * signing_request_recipients) — за Owner UI (Ден 5). Самата signing логика
 * (signAsOwner()/signAsRecipient()) живее в signingService.ts.
 */
import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';
import type {
  SigningRequestRow, SigningRequestRecipientRow, SigningRequestWithRecipients,
} from './types';

const SIGNING_REQUEST_COLUMNS =
  'id, document_id, owner_user_id, status, message, current_signed_storage_path, version, owner_signed_at, completed_at, cancelled_at, created_at, deleted_at';
const RECIPIENT_COLUMNS =
  'id, signing_request_id, invited_email, user_id, status, marker_page, marker_x, marker_y, signed_at, signature_id, invited_at';

/**
 * Зарежда всички (не soft-изтрити) signing_requests на текущия owner, всяка
 * заедно с recipients-ите ѝ. RLS ("signing_requests_select_owner") скопира
 * автоматично до auth.uid() — не е нужен explicit owner filter.
 *
 * Ползва се от DocumentList за определяне на состоянието (State A/B/C/D) на
 * всеки документ — join-ва се client-side по document_id.
 */
export async function listSigningRequests(): Promise<SigningRequestWithRecipients[]> {
  const { data: requests, error: reqErr } = await supabase
    .from('signing_requests')
    .select(SIGNING_REQUEST_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (reqErr) throw new Error(reqErr.message);

  const requestRows = (requests ?? []) as SigningRequestRow[];
  if (requestRows.length === 0) return [];

  const ids = requestRows.map(r => r.id);
  const { data: recipients, error: recErr } = await supabase
    .from('signing_request_recipients')
    .select(RECIPIENT_COLUMNS)
    .in('signing_request_id', ids);
  if (recErr) throw new Error(recErr.message);

  const recipientRows = (recipients ?? []) as SigningRequestRecipientRow[];
  return requestRows.map(request => ({
    request,
    recipients: recipientRows.filter(r => r.signing_request_id === request.id),
  }));
}

/** Зарежда една заявка + нейните recipients (за refresh след cancel/expand). */
export async function getSigningRequestDetails(requestId: string): Promise<SigningRequestWithRecipients> {
  const { data: request, error: reqErr } = await supabase
    .from('signing_requests')
    .select(SIGNING_REQUEST_COLUMNS)
    .eq('id', requestId)
    .single();
  if (reqErr || !request) {
    throw new Error(reqErr?.message ?? 'Заявката не е намерена.');
  }

  const { data: recipients, error: recErr } = await supabase
    .from('signing_request_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('signing_request_id', requestId);
  if (recErr) throw new Error(recErr.message);

  return {
    request: request as SigningRequestRow,
    recipients: (recipients ?? []) as SigningRequestRecipientRow[],
  };
}

/**
 * Отменя активна signing_request. RLS ("signing_requests_update_owner")
 * гарантира, че само owner-ът може да го направи — recipient/анонимен опит
 * би засегнал 0 реда (не хвърля грешка, само не променя нищо).
 *
 * Email известия до recipients за отмяна са Ден 7 (email код) — извън scope тук.
 */
export async function cancelSigningRequest(requestId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('signing_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', requestId);

  if (error) {
    console.error('cancelSigningRequest failed:', error.message);
    throw new Error('Грешка при отказ на заявката. Опитайте отново.');
  }

  await logAuditEvent(userId, 'signing_request_cancelled', requestId);
}
