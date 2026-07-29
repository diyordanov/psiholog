-- ============================================================
-- Миграция 0018: In-app нотификации при подпис (Ден 6 hotfix v4)
--
-- При всеки подпис (owner ИЛИ recipient) останалите участници в заявката
-- трябва да видят нотификация в платформата ("Мария подписа документ X").
-- При завършване на цялата заявка (allSigned) — допълнителна "completed"
-- нотификация до всички.
--
-- Дизайн: SECURITY DEFINER RPC функция вместо директен INSERT policy —
-- insert-ващият (текущият signer) трябва да пише редове за ДРУГИ
-- потребители (user_id ≠ auth.uid()), което не е изразимо с проста row-level
-- WITH CHECK политика без разкриване на произволен insert достъп. Функцията
-- контролира точно какво се inserт-ва (само за реални участници в заявката),
-- по същия принцип като claim_recipient_invitation() (migration 0010).
-- ============================================================

CREATE TABLE public.notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  signing_request_id  uuid REFERENCES public.signing_requests (id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('recipient_signed', 'owner_signed', 'request_completed')),
  message             text NOT NULL,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx      ON public.notifications (user_id, read_at);
CREATE INDEX notifications_request_idx   ON public.notifications (signing_request_id);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "notifications_update_own" ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Съзнателно НЯМА INSERT policy за authenticated — само през функцията по-долу.

-- ============================================================
-- notify_signing_participants(p_signing_request_id, p_type, p_message, p_exclude_user_id)
--
-- Insert-ва по един notifications ред за owner-а + всеки claim-нат recipient
-- на заявката, ОСВЕН p_exclude_user_id (текущият signer — той не се
-- нотифицира за собственото си действие). Unclaimed recipients (user_id IS
-- NULL) се пропускат мълчаливо — все още нямат акаунт да им се покаже нещо.
-- ============================================================

CREATE FUNCTION public.notify_signing_participants(
  p_signing_request_id uuid,
  p_type text,
  p_message text,
  p_exclude_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT owner_user_id INTO v_owner
    FROM public.signing_requests WHERE id = p_signing_request_id;

  IF v_owner IS NOT NULL AND v_owner <> p_exclude_user_id THEN
    INSERT INTO public.notifications (user_id, signing_request_id, type, message)
    VALUES (v_owner, p_signing_request_id, p_type, p_message);
  END IF;

  INSERT INTO public.notifications (user_id, signing_request_id, type, message)
  SELECT r.user_id, p_signing_request_id, p_type, p_message
  FROM public.signing_request_recipients r
  WHERE r.signing_request_id = p_signing_request_id
    AND r.user_id IS NOT NULL
    AND r.user_id <> p_exclude_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_signing_participants(uuid, text, text, uuid) TO authenticated;
