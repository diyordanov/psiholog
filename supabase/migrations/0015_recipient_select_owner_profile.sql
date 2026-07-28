-- ============================================================
-- Миграция 0015: recipient SELECT на owner profile (Ден 6)
--
-- InvitationLandingPage/PendingInvitationsPage трябва да покажат "Поканени
-- сте от Дима Йорданов" (owner display_name) — но "profiles_select_own"
-- (migration 0001) позволява SELECT само на auth.uid() = id (собствения
-- профил). Recipient няма никакъв начин да прочете owner-ския display_name.
--
-- Fix: нов SELECT policy, по същия SECURITY DEFINER helper-функция pattern
-- от migrations 0011/0013/0014 — recipient (линкнат user_id) може да чете
-- профила на owner-а на КОЯТО И ДА Е негова заявка.
--
-- Проактивно добавена ПРЕДИ implementация на UI-я (за разлика от 0012-0014,
-- открити reactively при E2E провал) — базирано на урока от Ден 4-5 сесията.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_signing_owner_of_recipient(p_owner_id uuid)
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
    WHERE sr.owner_user_id = p_owner_id AND r.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_signing_owner_of_recipient(uuid) TO authenticated;

CREATE POLICY "profiles_select_signing_owner" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_signing_owner_of_recipient(id));
