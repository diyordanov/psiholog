-- Migration 0005: Fix signing_keys UPDATE RLS policy
--
-- Проблем: политиката от 0003 има само USING (... AND deleted_at IS NULL)
-- без WITH CHECK. PostgreSQL прилага USING и върху резултантния ред —
-- след soft-delete (deleted_at = now()) редът не удовлетворява
-- "deleted_at IS NULL" и UPDATE се отказва.
--
-- Решение: разделяме USING (проверка на текущия ред преди update)
-- от WITH CHECK (проверка на новия ред след update).
-- WITH CHECK изисква само собственост (auth.uid() = user_id),
-- без ограничение на deleted_at — позволява soft-delete.

DROP POLICY IF EXISTS "Users can update own signing keys" ON public.signing_keys;

CREATE POLICY "Users can update own signing keys"
  ON public.signing_keys FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
