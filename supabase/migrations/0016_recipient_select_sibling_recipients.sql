-- ============================================================
-- Миграция 0016: RLS gap fix #3 — recipient SELECT на sibling recipients
--
-- Открито при реален E2E тест (Ден 6, live): при 2 поканени recipients
-- (A регистриран, B нерегистриран), след като САМО A подписа, заявката
-- премина в status='completed' и documents.status='signed' — въпреки че
-- B изобщо не беше подписал (нито дори claim-нал поканата).
--
-- Причина: attemptRecipientSign() (signingService.ts) проверява дали ВСИЧКИ
-- recipients са подписали чрез:
--     supabase.from('signing_request_recipients').select('status')
--       .eq('signing_request_id', signingRequest.id)
-- Тази заявка минава през RLS от гледна точка на ТЕКУЩИЯ recipient (A), не
-- на owner-а. Съществуващите SELECT policies за recipients (migration 0010):
--   - "recipients_select_own"          → user_id = auth.uid() (само СВОЯ ред)
--   - "recipients_select_by_own_email" → invited_email = JWT email (пак само
--                                        собствения ред, преди claim)
--   - "recipients_select_owner"        → само за owner-а
-- НИТО ЕДНА не позволява на A да вижда реда на B (различен user_id, различен
-- email). Заявката тихо връща САМО реда на A → `.every(r => r.status ===
-- 'signed')` на единичен елемент е тривиално true → преждевременно
-- "завършване" на заявката, докато реалния PDF файл все още има само
-- подписите на owner-а и A (потвърдено визуално — вторият (recipient)
-- маркер в PDF-а е празен рамка, третия липсва изцяло).
--
-- Fix: нов SELECT policy — claim-нат recipient може да вижда ВСИЧКИ
-- recipient редове на заявка, на която самият той е recipient (не просто
-- собствения си ред). Ползва вече съществуващия is_signing_request_recipient()
-- helper (migration 0011) — безопасно е: recipients на едно DocuSign-style
-- routing по дизайн виждат кой друг трябва да подпише (не изтича данни между
-- НЕсвързани заявки/документи).
-- ============================================================

CREATE POLICY "recipients_select_siblings" ON public.signing_request_recipients
  FOR SELECT TO authenticated
  USING (public.is_signing_request_recipient(signing_request_id));

-- ============================================================
-- Data repair: коригира заявки, погрешно маркирани 'completed' от бъга
-- по-горе, докато реално не всички recipients са подписали.
--
-- Обхват: само status='completed', но НЕ всички recipients имат
-- status='signed'. Връща signing_requests обратно в 'awaiting_recipients' и
-- documents обратно в 'uploaded' (единствените 2 валидни стойности за
-- documents.status, виж migration 0010 бележка) — current_signed_storage_path
-- / version остават непроменени (реалният файл вече отразява коректно
-- междинното състояние — само DB статус полетата бяха грешни).
-- ============================================================

WITH broken_requests AS (
  SELECT sr.id
  FROM public.signing_requests sr
  WHERE sr.status = 'completed'
    AND EXISTS (
      SELECT 1 FROM public.signing_request_recipients r
      WHERE r.signing_request_id = sr.id AND r.status <> 'signed'
    )
)
UPDATE public.signing_requests
SET status = 'awaiting_recipients', completed_at = NULL
WHERE id IN (SELECT id FROM broken_requests);

UPDATE public.documents d
SET status = 'uploaded', signed_at = NULL, signed_storage_path = NULL
WHERE EXISTS (
  SELECT 1 FROM public.signing_requests sr
  WHERE sr.document_id = d.id
    AND sr.status = 'awaiting_recipients'
    AND sr.completed_at IS NULL
    AND d.status = 'signed'
);
