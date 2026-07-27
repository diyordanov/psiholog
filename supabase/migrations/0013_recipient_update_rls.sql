-- ============================================================
-- Миграция 0013: RLS gap fix — recipient UPDATE права
--
-- Открито при реален E2E тест (Ден 4): signAsRecipient() постоянно хвърляше
-- "Документът беше подписан от друг участник междувременно" ДОРЕ БЕЗ никаква
-- реална конкуренция (single recipient, sequential run). Причина: RLS.
--
--   1. "signing_requests_update_owner" (migration 0010) е ЕДИНСТВЕНАТА UPDATE
--      policy на signing_requests — позволява UPDATE само на owner-а.
--      Recipient-ският optimistic-concurrency UPDATE (version bump +
--      current_signed_storage_path) засягаше 0 реда — RLS филтрира тихо,
--      без грешка — signAsRecipient() го тълкуваше погрешно като version
--      mismatch (race) вместо permission gap.
--
--   2. "documents_update_own" (migration 0001) позволява UPDATE само на
--      auth.uid() = documents.user_id (owner-а). Когато RECIPIENT е
--      последният подписващ, signAsRecipient() опитва да сложи
--      documents.status='signed' — RLS ГО БЛОКИРА ТИХО (UPDATE засяга 0
--      реда, БЕЗ грешка от Postgres/PostgREST) — по-опасно от bug #1, защото
--      кодът не проверява rows-affected на тази UPDATE и би "успял" мълчаливо
--      без документът действително да мине в status='signed'.
--
-- Fix: нови UPDATE policies за recipients, по същия SECURITY DEFINER
-- helper-функция patterns от migration 0011 (избягва circular RLS).
-- Column-level hardening (recipient да може да пипа само version/path/status,
-- не напр. owner_user_id) е future work — приемливо за MVP, като
-- "recipients_update_own" бележката в migration 0010 вече документира.
-- ============================================================

-- ── signing_requests: recipient UPDATE (optimistic concurrency + completion) ──
CREATE POLICY "signing_requests_update_recipient" ON public.signing_requests
  FOR UPDATE TO authenticated
  USING (public.is_signing_request_recipient(id))
  WITH CHECK (public.is_signing_request_recipient(id));

-- ── documents: recipient UPDATE, само ако е линкнат recipient на активна ─────
--    заявка за ТОЗИ документ (не произволен документ).
CREATE OR REPLACE FUNCTION public.is_document_signing_recipient(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.signing_requests sr
    JOIN public.signing_request_recipients r ON r.signing_request_id = sr.id
    WHERE sr.document_id = p_document_id AND r.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_document_signing_recipient(uuid) TO authenticated;

CREATE POLICY "documents_update_signing_recipient" ON public.documents
  FOR UPDATE TO authenticated
  USING (public.is_document_signing_recipient(id))
  WITH CHECK (public.is_document_signing_recipient(id));
