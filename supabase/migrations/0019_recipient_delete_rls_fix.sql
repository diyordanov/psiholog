-- ============================================================
-- Миграция 0019: RLS gap fix #3 — recipient soft-delete на чужд документ
--
-- Открито реално: recipient изтрива поканен документ от своя панел →
-- документът изчезва и от панела на owner-а. Причина: "documents_update_
-- signing_recipient" (migration 0013) и "signing_requests_update_recipient"
-- (migration 0013) нямат column-level ограничение — recipient-ският UPDATE
-- достъп е предвиден само за status/version/current_signed_storage_path
-- (при завършване на подписването), но WITH CHECK не пречи на recipient
-- да зададе и deleted_at, тъй като documents/signing_requests е ЕДИН споделен
-- ред между owner и recipients (не отделно копие per user). Migration 0010
-- вече документираше този пропуск като "future work — acceptable за MVP" —
-- това е точно него.
--
-- Fix: recipient-ските UPDATE policies вече изискват deleted_at да остане
-- NULL в новия ред — soft-delete остава възможен само през owner-ските
-- policies (documents_update_own / signing_requests_update_owner).
-- ============================================================

DROP POLICY IF EXISTS "documents_update_signing_recipient" ON public.documents;
CREATE POLICY "documents_update_signing_recipient" ON public.documents
  FOR UPDATE TO authenticated
  USING (public.is_document_signing_recipient(id))
  WITH CHECK (public.is_document_signing_recipient(id) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "signing_requests_update_recipient" ON public.signing_requests;
CREATE POLICY "signing_requests_update_recipient" ON public.signing_requests
  FOR UPDATE TO authenticated
  USING (public.is_signing_request_recipient(id))
  WITH CHECK (public.is_signing_request_recipient(id) AND deleted_at IS NULL);
