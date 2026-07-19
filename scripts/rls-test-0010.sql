-- ============================================================
-- RLS Manual Test Script — Migration 0010 (multi-signer)
--
-- Как да пуснеш: Supabase Dashboard → SQL Editor.
-- ВАЖНО: SQL Editor по подразбиране изпълнява като superuser/service_role
-- (bypass-ва RLS напълно). За реален RLS тест трябва да симулираш конкретен
-- auth.uid() чрез `set local role authenticated; set local request.jwt.claims`
-- ПРЕДИ всяка заявка — точно затова скриптът е разделен на именувани блокове.
--
-- Замени <OWNER_A_UUID>, <OWNER_B_UUID>, <RECIPIENT_X_UUID>,
-- <RECIPIENT_X_EMAIL> с реални стойности от auth.users в твоя проект
-- (или създай 3 тестови акаунта през UI-а: Owner A, Owner B, Recipient X).
-- ============================================================

-- ── Setup: owner A създава signing_request + кани Recipient X ─────────────
-- (Изпълни това КАТО service_role/superuser — обикновен setup, не тест сам по себе си)

insert into public.signing_requests (id, document_id, owner_user_id, status)
values ('11111111-1111-1111-1111-111111111111', '<EXISTING_DOCUMENT_UUID>', '<OWNER_A_UUID>', 'awaiting_recipients')
returning *;

insert into public.signing_request_recipients
  (id, signing_request_id, invited_email, marker_page, marker_x, marker_y)
values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   '<RECIPIENT_X_EMAIL>', 0, 30, 30)
returning *;

insert into public.email_notifications (signing_request_id, recipient_id, recipient_email, type)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
        '<RECIPIENT_X_EMAIL>', 'invitation');

-- ============================================================
-- Тест 1: Owner А вижда собствената заявка ✅
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<OWNER_A_UUID>", "email": "owner-a@example.com"}';

select count(*) as should_be_1 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- Тест 2: Owner B НЕ вижда заявката на Owner A ✅ (очакван резултат: 0 rows)
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<OWNER_B_UUID>", "email": "owner-b@example.com"}';

select count(*) as should_be_0 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- Тест 3а: Recipient X (все още НЕ линкнат, user_id IS NULL) вижда собствения
-- си recipient ред само по email fallback policy ✅
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

select count(*) as should_be_1 from public.signing_request_recipients
  where id = '22222222-2222-2222-2222-222222222222';

-- ── Claim поканата ──
select * from public.claim_recipient_invitation('22222222-2222-2222-2222-222222222222');

-- ============================================================
-- Тест 3б: Recipient X СЕГА вижда signing_request-а (чрез EXISTS policy),
-- но НЕ вижда евентуален ВТОРИ recipient ред на същата заявка ✅
-- ============================================================

select count(*) as should_be_1 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

-- (ако добавиш втори recipient row към същата request с друг email/user_id,
--  повтори SELECT * from signing_request_recipients where signing_request_id = '11111111...'
--  и провери, че Recipient X вижда САМО собствения си ред — should_be_1, не 2)

reset role;

-- ============================================================
-- Тест 4: Anon (нелогнат) НЕ може директен SELECT ✅ (очакван резултат: 0 rows,
-- НЕ грешка — RLS filter, не permission denied)
-- ============================================================
set local role anon;

select count(*) as should_be_0 from public.signing_requests;
select count(*) as should_be_0_too from public.signing_request_recipients;

reset role;

-- ============================================================
-- Тест 5: email_notifications — authenticated (дори owner A) НЕ може INSERT/UPDATE
-- директно (само service_role) ✅ (очакван резултат: грешка "new row violates
-- row-level security policy")
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<OWNER_A_UUID>", "email": "owner-a@example.com"}';

insert into public.email_notifications (signing_request_id, recipient_email, type)
values ('11111111-1111-1111-1111-111111111111', 'test@example.com', 'invitation');
-- ⬆ ОЧАКВАНО: ERROR — RLS policy violation (няма INSERT policy за authenticated)

-- Owner A обаче МОЖЕ да SELECT-не delivery статуса на собствената заявка:
select count(*) as should_be_1 from public.email_notifications
  where signing_request_id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- Cleanup (изпълни като service_role/superuser)
-- ============================================================
-- delete from public.email_notifications where signing_request_id = '11111111-1111-1111-1111-111111111111';
-- delete from public.signing_request_recipients where signing_request_id = '11111111-1111-1111-1111-111111111111';
-- delete from public.signing_requests where id = '11111111-1111-1111-1111-111111111111';