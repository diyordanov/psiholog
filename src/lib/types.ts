/**
 * types.ts
 * Споделени типове за multi-signer workflow (Фаза 8).
 *
 * За разлика от DocumentRow/SigningKeyRow (co-located в съответните lib
 * файлове), тези типове се ползват едновременно от signingRequestService,
 * няколко UI компонента (InviteRecipientsModal, PendingInvitationsPage,
 * InvitationLandingPage, SigningRequestStatus) и Edge Functions — централно
 * място избягва circular imports между тях.
 */

// ─── signing_requests ───────────────────────────────────────────────────────

export type SigningRequestStatus =
  | 'draft'                // създадена, owner все още не е подписал
  | 'owner_signing'        // owner ceremony в прогрес
  | 'awaiting_recipients'  // owner подписан, покани изпратени, чака се recipients
  | 'completed'            // всички са подписали
  | 'cancelled';           // owner е отменил преди завършване

/** Един ред от таблицата `signing_requests`. */
export interface SigningRequestRow {
  id: string;
  document_id: string;
  owner_user_id: string;
  status: SigningRequestStatus;
  message: string | null;
  current_signed_storage_path: string | null;
  version: number;
  owner_signed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

// ─── signing_request_recipients ────────────────────────────────────────────

export type RecipientStatus =
  | 'pending'     // поканен, все още не е регистриран/линкнат
  | 'registered'  // user_id линкнат (регистрирал се е или вече е имал акаунт)
  | 'signed';     // подписал е

/** Един ред от таблицата `signing_request_recipients`. */
export interface SigningRequestRecipientRow {
  id: string;
  signing_request_id: string;
  invited_email: string;
  user_id: string | null;
  status: RecipientStatus;
  marker_page: number;
  marker_x: number;
  marker_y: number;
  signed_at: string | null;
  signature_id: string | null;
  invited_at: string;
}

// ─── email_notifications ───────────────────────────────────────────────────

export type EmailNotificationType = 'invitation' | 'completion' | 'cancellation';
export type EmailNotificationStatus = 'queued' | 'sent' | 'failed';

/** Един ред от таблицата `email_notifications` (само за display — записва се от Edge Functions). */
export interface EmailNotificationRow {
  id: string;
  signing_request_id: string;
  recipient_id: string | null;
  recipient_email: string;
  type: EmailNotificationType;
  status: EmailNotificationStatus;
  resend_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
}

// ─── UI-composed изгледи ────────────────────────────────────────────────────

/**
 * SigningRequestStatus компонентът показва "X от Y подписали" — комбинира
 * заявката с всичките ѝ recipients в едно извикване (join на клиента, не в DB).
 */
export interface SigningRequestWithRecipients {
  request: SigningRequestRow;
  recipients: SigningRequestRecipientRow[];
}

/** Позиция на подписващ маркер — споделен формат с SigningPosition от signingService.ts. */
export interface RecipientMarkerPosition {
  page: number;
  x: number;
  y: number;
}

/** Вход за InviteRecipientsModal при създаване на нова заявка. */
export interface NewRecipientInput {
  email: string;
  position: RecipientMarkerPosition;
}