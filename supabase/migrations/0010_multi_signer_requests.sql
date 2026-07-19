-- ============================================================
-- Миграция 0010: Multi-signer workflow (DocuSign-style)
--
-- Нови таблици:
--   signing_requests            — кой (owner) кани кого за какъв документ
--   signing_request_recipients  — recipients + позиции на маркер + status
--   email_notifications         — delivery tracking за Resend имейли
--
-- Дизайн решение: documents.status остава НЕПРОМЕНЕН enum
-- ('uploaded' | 'signed'). Целият multi-signer progress живее в
-- signing_requests.status. documents.status минава 'signed' само
-- когато ПОСЛЕДНИЯТ recipient подпише — така съществуващият
-- "Свали подписан" бутон в DocumentList.tsx работи без промяна.
--
-- signatures таблицата НЕ се пипа структурно (само добавяме nullable
-- signing_request_id за convenience filtering) — всеки signer вече
-- ще качва собствена incremental версия с уникален signed_storage_path,
-- което вече е съвместимо със съществуващия UNIQUE INDEX от 0009.
-- ============================================================

-- ============================================================
-- Таблици
-- ============================================================

CREATE TABLE public.signing_requests (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id                 uuid NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  owner_user_id                uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status                       text NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'owner_signing', 'awaiting_recipients', 'completed', 'cancelled')),
  message                      text,
  -- Последната налична подписана версия — обновява се след ВСЕКИ подпис
  -- (owner-ски или recipient-ски), не само при завършване.
  current_signed_storage_path  text,
  -- Optimistic concurrency lock: recipient чете version преди подписване,
  -- UPDATE ... WHERE version = <прочетеното> при запис на новата версия.
  -- 0 rows affected => race с друг recipient => re-fetch + retry.
  version                      int NOT NULL DEFAULT 0,
  owner_signed_at              timestamptz,
  completed_at                 timestamptz,
  cancelled_at                 timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  deleted_at                   timestamptz
);

CREATE TABLE public.signing_request_recipients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signing_request_id    uuid NOT NULL REFERENCES public.signing_requests (id) ON DELETE CASCADE,
  -- Нормализиран (lowercase) email, на който е изпратена поканата.
  -- Линкването към user_id е ПРЕЗ id-то на този ред (token-scoped claim,
  -- виж claim_recipient_invitation по-долу), не automatic email match —
  -- по-безопасно: избягва случайно линкване при несвързана регистрация
  -- със същия email.
  invited_email         text NOT NULL CHECK (invited_email = lower(invited_email)),
  user_id               uuid REFERENCES auth.users (id),
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'registered', 'signed')),
  marker_page           int NOT NULL,
  marker_x              numeric NOT NULL,
  marker_y              numeric NOT NULL,
  signed_at             timestamptz,
  signature_id          uuid REFERENCES public.signatures (id),
  invited_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signing_request_id, invited_email)
);

CREATE TABLE public.email_notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signing_request_id    uuid NOT NULL REFERENCES public.signing_requests (id) ON DELETE CASCADE,
  -- NULL за completion/cancellation имейли до owner-а (той не е recipient row).
  recipient_id          uuid REFERENCES public.signing_request_recipients (id) ON DELETE CASCADE,
  recipient_email        text NOT NULL,
  -- 'reminder' умишлено НЕ е включен — pg_cron reminder emails са future
  -- work (виж PROGRESS.md), не част от MVP scope.
  type                  text NOT NULL CHECK (type IN ('invitation', 'completion', 'cancellation')),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  resend_message_id      text,
  error_message          text,
  sent_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ── signatures: linkage за multi-signer заявки (nullable, backward-compat) ──
ALTER TABLE public.signatures
  ADD COLUMN IF NOT EXISTS signing_request_id uuid REFERENCES public.signing_requests (id);

-- ============================================================
-- Индекси
-- ============================================================

CREATE INDEX signing_requests_owner_idx      ON public.signing_requests (owner_user_id);
CREATE INDEX signing_requests_document_idx   ON public.signing_requests (document_id);
CREATE INDEX signing_requests_status_idx     ON public.signing_requests (status);

CREATE INDEX signing_request_recipients_request_idx ON public.signing_request_recipients (signing_request_id);
CREATE INDEX signing_request_recipients_email_idx   ON public.signing_request_recipients (invited_email);
CREATE INDEX signing_request_recipients_user_idx    ON public.signing_request_recipients (user_id);

CREATE INDEX email_notifications_request_idx   ON public.email_notifications (signing_request_id);
CREATE INDEX email_notifications_recipient_idx  ON public.email_notifications (recipient_id);

CREATE INDEX signatures_signing_request_idx ON public.signatures (signing_request_id);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

ALTER TABLE public.signing_requests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signing_request_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_notifications        ENABLE ROW LEVEL SECURITY;

-- ── signing_requests ──────────────────────────────────────────────────────
-- Owner: пълен CRUD (без hard DELETE — soft delete чрез deleted_at, конвенция
-- от Section 3.6 на PROJECT_BRIEF.md).
CREATE POLICY "signing_requests_select_owner" ON public.signing_requests
  FOR SELECT USING (auth.uid() = owner_user_id);
CREATE POLICY "signing_requests_insert_owner" ON public.signing_requests
  FOR INSERT WITH CHECK (auth.uid() = owner_user_id);
CREATE POLICY "signing_requests_update_owner" ON public.signing_requests
  FOR UPDATE USING (auth.uid() = owner_user_id) WITH CHECK (auth.uid() = owner_user_id);

-- Recipient: SELECT само ако има линкнат recipient ред за тази заявка.
CREATE POLICY "signing_requests_select_recipient" ON public.signing_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.signing_request_recipients r
      WHERE r.signing_request_id = signing_requests.id
        AND r.user_id = auth.uid()
    )
  );

-- ── signing_request_recipients ────────────────────────────────────────────
-- Owner: пълен CRUD през join към собствената signing_request.
CREATE POLICY "recipients_select_owner" ON public.signing_request_recipients
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.signing_requests sr
      WHERE sr.id = signing_request_recipients.signing_request_id
        AND sr.owner_user_id = auth.uid()
    )
  );
CREATE POLICY "recipients_insert_owner" ON public.signing_request_recipients
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.signing_requests sr
      WHERE sr.id = signing_request_recipients.signing_request_id
        AND sr.owner_user_id = auth.uid()
    )
  );
CREATE POLICY "recipients_update_owner" ON public.signing_request_recipients
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.signing_requests sr
      WHERE sr.id = signing_request_recipients.signing_request_id
        AND sr.owner_user_id = auth.uid()
    )
  );

-- Recipient: вижда и обновява само СОБСТВЕНИЯ си ред (не другите recipients
-- на същата заявка — email-ите на другите участници не изтичат).
-- Бележка: RLS е row-level, не column-level — recipient технически може да
-- PATCH-не marker_x/marker_y на собствения си ред през PostgREST. Приемливо
-- за MVP (истинският signing flow пише само status/signed_at/signature_id
-- през signingService.ts кода); column-level hardening е follow-up.
CREATE POLICY "recipients_select_own" ON public.signing_request_recipients
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "recipients_update_own" ON public.signing_request_recipients
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Fallback claim flow (виж Б.1 от плана): логнат потребител може да SELECT-не
-- покани, изпратени до собствения му email, дори преди user_id да е линкнат.
CREATE POLICY "recipients_select_by_own_email" ON public.signing_request_recipients
  FOR SELECT USING (invited_email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ── email_notifications ───────────────────────────────────────────────────
-- Без INSERT/UPDATE policies за authenticated/anon — само service_role
-- (Edge Functions) пише тук; RLS default-deny покрива това автоматично.
CREATE POLICY "email_notifications_select_owner" ON public.email_notifications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.signing_requests sr
      WHERE sr.id = email_notifications.signing_request_id
        AND sr.owner_user_id = auth.uid()
    )
  );

-- ============================================================
-- claim_recipient_invitation(recipient_id) — token-scoped linking
--
-- Извиква се от InvitationLandingPage след login/signup за конкретната
-- покана. SECURITY DEFINER, защото трябва да линкне ред, който recipient-ът
-- все още не притежава (user_id е NULL) — обикновена RLS UPDATE policy не
-- може да разреши "стани owner на този ред", само проверка на вече наличен
-- user_id.
--
-- Проверки:
--   1. invited_email на реда == email от JWT на текущата сесия (case-insensitive)
--   2. user_id е или NULL, или вече е auth.uid() (идемпотентно при повторен клик)
-- ============================================================

CREATE FUNCTION public.claim_recipient_invitation(p_recipient_id uuid)
RETURNS public.signing_request_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   public.signing_request_recipients;
  v_email text;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  IF v_email = '' THEN
    RAISE EXCEPTION 'Не е логнат потребител.';
  END IF;

  SELECT * INTO v_row FROM public.signing_request_recipients
    WHERE id = p_recipient_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Поканата не е намерена.';
  END IF;

  IF v_row.invited_email <> v_email THEN
    RAISE EXCEPTION 'Тази покана е изпратена до друг email адрес.';
  END IF;

  IF v_row.user_id IS NOT NULL AND v_row.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Поканата вече е приета от друг акаунт.';
  END IF;

  UPDATE public.signing_request_recipients
    SET user_id = auth.uid(),
        status  = CASE WHEN status = 'pending' THEN 'registered' ELSE status END
    WHERE id = p_recipient_id
    RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_recipient_invitation(uuid) TO authenticated;