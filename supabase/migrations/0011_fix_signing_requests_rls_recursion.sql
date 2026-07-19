-- ============================================================
-- Миграция 0011: Fix infinite recursion в RLS policies (0010)
--
-- Открито при RLS ръчно тестване (Тест 2, 2026-07-19):
--   ERROR 42P17: infinite recursion detected in policy for relation
--   "signing_requests"
--
-- Причина: "signing_requests_select_recipient" policy-то на
-- signing_requests прави EXISTS заявка към signing_request_recipients.
-- Едновременно "recipients_select_owner"/"recipients_insert_owner"/
-- "recipients_update_owner" policies на signing_request_recipients правят
-- EXISTS заявка обратно към signing_requests. При evaluate на едната
-- таблица, Postgres тръгва да evaluate-ва другата, която тръгва да
-- evaluate-ва първата — circular dependency между RLS policies на двете
-- таблици.
--
-- Fix: two SECURITY DEFINER helper функции. SECURITY DEFINER функция се
-- изпълнява с правата на своя owner (postgres/table owner в Supabase) —
-- RLS не важи за table owner, затова вътрешната SELECT в тези функции НЕ
-- тригва policy evaluation на другата таблица и цикълът се прекъсва.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_signing_request_owner(p_request_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.signing_requests sr
    WHERE sr.id = p_request_id AND sr.owner_user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_signing_request_recipient(p_request_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.signing_request_recipients r
    WHERE r.signing_request_id = p_request_id AND r.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_signing_request_owner(uuid)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_signing_request_recipient(uuid) TO authenticated;

-- ── Преизползваме policies да викат функциите вместо inline EXISTS ────────

DROP POLICY "signing_requests_select_recipient" ON public.signing_requests;
CREATE POLICY "signing_requests_select_recipient" ON public.signing_requests
  FOR SELECT USING (public.is_signing_request_recipient(id));

DROP POLICY "recipients_select_owner" ON public.signing_request_recipients;
CREATE POLICY "recipients_select_owner" ON public.signing_request_recipients
  FOR SELECT USING (public.is_signing_request_owner(signing_request_id));

DROP POLICY "recipients_insert_owner" ON public.signing_request_recipients;
CREATE POLICY "recipients_insert_owner" ON public.signing_request_recipients
  FOR INSERT WITH CHECK (public.is_signing_request_owner(signing_request_id));

DROP POLICY "recipients_update_owner" ON public.signing_request_recipients;
CREATE POLICY "recipients_update_owner" ON public.signing_request_recipients
  FOR UPDATE USING (public.is_signing_request_owner(signing_request_id));