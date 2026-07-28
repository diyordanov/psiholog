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

// ═══════════════════════════════════════════════════════════════════════════
// Ден 6: Recipient страна — invitation claim + детайли
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token-scoped claim на покана — линква auth.uid() към recipient реда.
 * SECURITY DEFINER RPC (migration 0010), идемпотентна — безопасно за
 * повторно извикване (напр. при всяко зареждане на PendingInvitationsPage).
 *
 * Хвърля с ясно съобщение (директно от Postgres RAISE EXCEPTION) при:
 *   - невалиден recipientId ("Поканата не е намерена.")
 *   - email mismatch ("Тази покана е изпратена до друг email адрес.")
 *   - вече claim-ната от друг акаунт ("Поканата вече е приета от друг акаунт.")
 */
export async function claimInvitation(recipientId: string): Promise<SigningRequestRecipientRow> {
  const { data, error } = await supabase.rpc('claim_recipient_invitation', { p_recipient_id: recipientId });
  if (error || !data) {
    throw new Error(error?.message ?? 'Поканата не е намерена.');
  }
  return data as SigningRequestRecipientRow;
}

export interface InvitationDetails {
  recipient: SigningRequestRecipientRow;
  request: SigningRequestRow;
  documentFilename: string;
  ownerName: string;
}

/**
 * Зарежда пълните детайли за ЕДНА покана — ИЗИСКВА recipient вече да е
 * claim-нат (user_id линкнат). Преди claim, RLS на `signing_requests`/
 * `documents`/`profiles` (migrations 0011/0014/0015) блокира тези четения —
 * затова InvitationLandingPage/listMyInvitations() винаги викат
 * claimInvitation() ПРЕДИ тази функция.
 */
export async function getInvitationDetails(recipientId: string): Promise<InvitationDetails> {
  const { data: recipient, error: recErr } = await supabase
    .from('signing_request_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('id', recipientId)
    .single();
  if (recErr || !recipient) throw new Error(recErr?.message ?? 'Поканата не е намерена.');
  const recipientRow = recipient as SigningRequestRecipientRow;

  const { data: request, error: reqErr } = await supabase
    .from('signing_requests')
    .select(SIGNING_REQUEST_COLUMNS)
    .eq('id', recipientRow.signing_request_id)
    .single();
  if (reqErr || !request) throw new Error(reqErr?.message ?? 'Заявката не е намерена.');
  const requestRow = request as SigningRequestRow;

  const [{ data: doc, error: docErr }, { data: profile }] = await Promise.all([
    supabase.from('documents').select('original_filename').eq('id', requestRow.document_id).single(),
    supabase.from('profiles').select('display_name').eq('id', requestRow.owner_user_id).maybeSingle(),
  ]);
  if (docErr || !doc) throw new Error(docErr?.message ?? 'Документът не е намерен.');

  return {
    recipient: recipientRow,
    request: requestRow,
    documentFilename: doc.original_filename as string,
    ownerName: (profile?.display_name as string | undefined) ?? 'Собственик',
  };
}

/**
 * Зарежда ВСИЧКИ покани на текущия потребител по email — покрива едновременно
 * pre-claim редове (чрез "recipients_select_by_own_email" fallback policy) и
 * вече claim-нати (чрез "recipients_select_own"). Auto-claim-ва всеки все още
 * unclaimed ред, преди да зареди пълните детайли — "unclaimed" остава
 * невидим implementation detail за PendingInvitationsPage.
 */
export async function listMyInvitations(email: string): Promise<InvitationDetails[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const { data: rows, error } = await supabase
    .from('signing_request_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('invited_email', normalizedEmail)
    .order('invited_at', { ascending: false });
  if (error) throw new Error(error.message);

  const recipientRows = (rows ?? []) as SigningRequestRecipientRow[];

  await Promise.all(
    recipientRows.filter(r => r.user_id === null).map(r => claimInvitation(r.id)),
  );

  return Promise.all(recipientRows.map(r => getInvitationDetails(r.id)));
}

/** Покана е "чакаща" ако recipient-ът все още не е подписал И заявката не е приключила/отменена. */
export function isInvitationPending(details: InvitationDetails): boolean {
  return details.recipient.status !== 'signed' && details.request.status === 'awaiting_recipients';
}

// ═══════════════════════════════════════════════════════════════════════════
// Ден 7: Email покани — по същия механизъм като регистрация/recovery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Праща покана по email до ЕДИН recipient — по абсолютно същия път като
 * signup/recovery имейлите (Фаза 1): `supabase.auth.signInWithOtp()`.
 * Съзнателно НЕ ползваме отделен Resend Edge Function/API key — reuse-ваме
 * вече работещата (и в production потвърдена) Supabase SMTP конфигурация,
 * която праща до произволен адрес (не e ограничена до един sandbox акаунт).
 *
 * `emailRedirectTo` сочи към /invite/:recipientId вместо стандартния следсигн-ъп
 * път — при клик, recipient-ът получава РЕАЛНА сесия (нов user, ако имейлът
 * не е регистриран — `shouldCreateUser: true`, идентично на нормалния signup)
 * И директно каца на InvitationLandingPage. Ако е нов потребител без passkey,
 * App.tsx routing-ът (виж bugfix там) първо го прекарва през
 * RegisterPasskeyStep, преди да покаже поканата.
 *
 * Best-effort: неуспех тук НЕ отменя вече създадената покана в базата
 * (recipient-ът може все пак да получи линка ръчно) — само хвърля за UI-я
 * да покаже предупреждение.
 */
export async function sendInvitationEmail(recipientId: string, invitedEmail: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: invitedEmail,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${window.location.origin}/invite/${recipientId}`,
    },
  });
  if (error) throw new Error(`Грешка при изпращане на покана: ${error.message}`);
}

/**
 * Праща покани до всички recipients на заявка (след успешен signAsOwner()).
 * Partial failure е ОК (Promise.allSettled) — връща брой успешно изпратени,
 * за UI feedback ("Изпратени са N от M покани по email").
 */
export async function sendAllInvitationEmails(
  recipients: { id: string; invited_email: string }[],
): Promise<number> {
  const results = await Promise.allSettled(
    recipients.map(r => sendInvitationEmail(r.id, r.invited_email)),
  );
  return results.filter(r => r.status === 'fulfilled').length;
}
