-- ============================================================
-- Миграция 0014: RLS gap fix #2 — recipient SELECT на documents
--
-- Открито при реален E2E тест (Ден 4), СЛЕД migration 0013: UPDATE-ът на
-- documents.status='signed' (при последен recipient) вече минаваше RLS
-- проверката за UPDATE (migration 0013 policy), но `.select('id')` СЛЕД
-- UPDATE-а (нужен за rows-affected verification — виж бележката в
-- signingService.ts) продължаваше да връща 0 реда.
--
-- Причина: PostgREST-ovото `Prefer: return=representation` (активирано от
-- .select() след .update()) чете обратно засегнатите редове ПРЕЗ SELECT RLS
-- policies — не само UPDATE policies. "documents_select_own" (migration 0001)
-- позволява SELECT само на auth.uid() = user_id (owner-а). Recipient-ът НЕ е
-- owner → UPDATE-ът физически се изпълнява коректно, но RETURNING-ът връща 0
-- видими реда за recipient-ската сесия → кодът тълкува това като failure.
--
-- Fix: SELECT policy за documents, огледална на UPDATE policy-то от 0013,
-- ползваща същата is_document_signing_recipient() helper функция.
-- ============================================================

CREATE POLICY "documents_select_signing_recipient" ON public.documents
  FOR SELECT TO authenticated
  USING (public.is_document_signing_recipient(id));
