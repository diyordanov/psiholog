-- ============================================================
-- Миграция 0012: Storage RLS за signed-documents — multi-signer поддръжка
--
-- Проблем: съществуващите storage.objects policies (migration 0001) са
-- folder-prefix-per-uploader: `(storage.foldername(name))[1] = auth.uid()::text`.
-- Това работи за single-signer (owner качва в собствената си папка), но
-- БЛОКИРА recipient-и в multi-signer flow-а — recipient (различен auth.uid())
-- не може нито да прочете текущата подписана версия (качена от owner-а в
-- НЕГОВАТА папка), нито да качи новата версия там.
--
-- Fix: нова конвенция за път на multi-signer файлове —
--   signed-documents/<signing_request_id>/v<version>.pdf
-- (папка = signing_request_id, не user_id) + policies, които ползват
-- is_signing_request_owner()/is_signing_request_recipient() от migration 0011
-- (SECURITY DEFINER, вече съществуват — избягваме circular RLS).
--
-- Старите "*_own" policies ОСТАВАТ непроменени — Postgres RLS policies от
-- един и същи FOR действие се OR-ират (permissive by default), затова двете
-- конвенции съжителстват: стари single-signer файлове (папка = user_id)
-- продължават да работят непроменено, новите multi-signer файлове (папка =
-- signing_request_id) минават през новите policies.
-- ============================================================

CREATE POLICY "signed_documents_bucket_select_signing_request" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'signed-documents' AND (
      public.is_signing_request_owner(((storage.foldername(name))[1])::uuid)
      OR public.is_signing_request_recipient(((storage.foldername(name))[1])::uuid)
    )
  );

CREATE POLICY "signed_documents_bucket_insert_signing_request" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'signed-documents' AND (
      public.is_signing_request_owner(((storage.foldername(name))[1])::uuid)
      OR public.is_signing_request_recipient(((storage.foldername(name))[1])::uuid)
    )
  );

-- Забележка: НЯМА нова DELETE policy — multi-signer версиите никога не се
-- изтриват от recipient или owner код (само soft-delete на ниво documents/
-- signing_requests редове, виж Section 3.6 на PROJECT_BRIEF.md). Старата
-- "signed_documents_bucket_delete_own" остава единствената delete policy,
-- приложима само за legacy user_id-папки.
