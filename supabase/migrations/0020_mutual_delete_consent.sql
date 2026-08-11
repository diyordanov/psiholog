-- ============================================================
-- Миграция 0020: Взаимно съгласие за изтриване на споделен документ
--
-- Migration 0019 затвори пропуска "recipient soft-delete-ва чужд документ",
-- но резултатът беше твърде рестриктивен в другата посока: сега само owner-ът
-- може да изтрие документ, дори когато и двете страни искат това. Тази
-- миграция въвежда "request → consent" flow: ако документът има signing_request
-- с поне един claim-нат recipient (истинска "друга страна"), изтриването
-- изисква съгласие от ВСИЧКИ участници (owner + всеки claim-нат recipient).
-- Solo документи (без recipients, или recipients все още unclaimed — няма
-- реална "друга страна" все още) продължават да се трият директно от owner-а
-- (documents_update_own, непроменена).
--
-- Дизайн: същият SECURITY DEFINER RPC pattern като claim_recipient_invitation/
-- notify_signing_participants — мутациите минават само през функциите по-долу,
-- директен INSERT/UPDATE достъп на клиента до новите таблици НЕ се дава.
-- ============================================================

CREATE TABLE public.document_delete_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES public.documents (id),
  signing_request_id  uuid NOT NULL REFERENCES public.signing_requests (id),
  requested_by        uuid NOT NULL REFERENCES auth.users (id),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE INDEX document_delete_requests_document_idx ON public.document_delete_requests (document_id, status);

CREATE TABLE public.document_delete_consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delete_request_id  uuid NOT NULL REFERENCES public.document_delete_requests (id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users (id),
  decision           text NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delete_request_id, user_id)
);

ALTER TABLE public.document_delete_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_delete_consents  ENABLE ROW LEVEL SECURITY;

-- Видимост само за страните по свързаната signing_request (owner + recipients).
-- Съзнателно НЯМА INSERT/UPDATE policies — само през RPC функциите по-долу.
CREATE POLICY "delete_requests_select_parties" ON public.document_delete_requests
  FOR SELECT TO authenticated
  USING (
    public.is_signing_request_owner(signing_request_id)
    OR public.is_signing_request_recipient(signing_request_id)
  );

CREATE POLICY "delete_consents_select_parties" ON public.document_delete_consents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.document_delete_requests dr
      WHERE dr.id = delete_request_id
        AND (public.is_signing_request_owner(dr.signing_request_id)
             OR public.is_signing_request_recipient(dr.signing_request_id))
    )
  );

-- Разширяваме notifications.type за новите известия (виж migration 0018).
ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('recipient_signed', 'owner_signed', 'request_completed', 'delete_requested', 'delete_declined'));

-- ============================================================
-- request_document_deletion(p_document_id)
--
-- Намира последната (не soft-изтрита) signing_request на документа. Ако
-- няма claim-нати recipients (само owner) — изтрива веднага (символно
-- еквивалентно на стария еднолиден delete) и връща 'deleted'. Иначе създава
-- pending заявка за съгласие (requester-ът автоматично се брои за съгласен),
-- notify-ва останалите участници, връща 'pending' + request_id.
-- ============================================================
CREATE FUNCTION public.request_document_deletion(p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signing_request_id uuid;
  v_total_parties      int;
  v_existing           uuid;
  v_new_id             uuid;
BEGIN
  SELECT id INTO v_signing_request_id
  FROM public.signing_requests
  WHERE document_id = p_document_id AND deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_signing_request_id IS NULL THEN
    RAISE EXCEPTION 'no_signing_request';
  END IF;

  IF NOT (public.is_signing_request_owner(v_signing_request_id)
          OR public.is_signing_request_recipient(v_signing_request_id)) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) + 1 INTO v_total_parties  -- +1 = owner-ът винаги е страна
  FROM public.signing_request_recipients
  WHERE signing_request_id = v_signing_request_id AND user_id IS NOT NULL;

  IF v_total_parties <= 1 THEN
    UPDATE public.documents        SET deleted_at = now() WHERE id = p_document_id;
    UPDATE public.signing_requests SET deleted_at = now() WHERE id = v_signing_request_id;
    RETURN jsonb_build_object('status', 'deleted', 'request_id', null);
  END IF;

  SELECT id INTO v_existing
  FROM public.document_delete_requests
  WHERE document_id = p_document_id AND status = 'pending';

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'pending', 'request_id', v_existing);
  END IF;

  INSERT INTO public.document_delete_requests (document_id, signing_request_id, requested_by)
  VALUES (p_document_id, v_signing_request_id, auth.uid())
  RETURNING id INTO v_new_id;

  INSERT INTO public.document_delete_consents (delete_request_id, user_id, decision)
  VALUES (v_new_id, auth.uid(), 'approved');

  PERFORM public.notify_signing_participants(
    v_signing_request_id, 'delete_requested',
    'Поискано е изтриване на споделен документ — нужно е вашето съгласие.',
    auth.uid()
  );

  RETURN jsonb_build_object('status', 'pending', 'request_id', v_new_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_document_deletion(uuid) TO authenticated;

-- ============================================================
-- respond_document_deletion(p_request_id, p_decision)
--
-- 'declined' → анулира заявката веднага, notify-ва останалите. 'approved' →
-- записва съгласието; ако всички claim-нати страни (owner + recipients) вече
-- са approved, изпълнява реалния soft-delete. Връща крайния статус.
-- ============================================================
CREATE FUNCTION public.respond_document_deletion(p_request_id uuid, p_decision text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signing_request_id uuid;
  v_document_id        uuid;
  v_total_parties       int;
  v_approved_count      int;
BEGIN
  IF p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT signing_request_id, document_id INTO v_signing_request_id, v_document_id
  FROM public.document_delete_requests
  WHERE id = p_request_id AND status = 'pending';

  IF v_signing_request_id IS NULL THEN
    RAISE EXCEPTION 'request_not_found_or_resolved';
  END IF;

  IF NOT (public.is_signing_request_owner(v_signing_request_id)
          OR public.is_signing_request_recipient(v_signing_request_id)) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  INSERT INTO public.document_delete_consents (delete_request_id, user_id, decision)
  VALUES (p_request_id, auth.uid(), p_decision)
  ON CONFLICT (delete_request_id, user_id) DO UPDATE SET decision = EXCLUDED.decision, decided_at = now();

  IF p_decision = 'declined' THEN
    UPDATE public.document_delete_requests SET status = 'declined', resolved_at = now() WHERE id = p_request_id;
    PERFORM public.notify_signing_participants(
      v_signing_request_id, 'delete_declined',
      'Заявка за изтриване на споделен документ беше отказана.',
      auth.uid()
    );
    RETURN 'declined';
  END IF;

  SELECT count(*) + 1 INTO v_total_parties
  FROM public.signing_request_recipients
  WHERE signing_request_id = v_signing_request_id AND user_id IS NOT NULL;

  SELECT count(*) INTO v_approved_count
  FROM public.document_delete_consents
  WHERE delete_request_id = p_request_id AND decision = 'approved';

  IF v_approved_count >= v_total_parties THEN
    UPDATE public.documents        SET deleted_at = now() WHERE id = v_document_id;
    UPDATE public.signing_requests SET deleted_at = now() WHERE id = v_signing_request_id;
    UPDATE public.document_delete_requests SET status = 'approved', resolved_at = now() WHERE id = p_request_id;
    RETURN 'approved';
  END IF;

  RETURN 'pending';
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_document_deletion(uuid, text) TO authenticated;
