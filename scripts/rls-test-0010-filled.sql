-- ============================================================
-- RLS Manual Test — попълнен с реални UUID-и
-- Owner A  = 0ace47cc-df27-4163-bb79-cdd1b763c77d
-- Owner B / Recipient X (същият акаунт, преизползван) = 290a5914-5d31-4418-b3ff-f124154a278e
-- Document = 02607a9f-e2c5-4ca4-9683-4282fe212b98 (притежание на Owner A)
--
-- ⚠️ Замени <OWNER_A_EMAIL> и <PROFILE2_EMAIL> с реалните email-и преди Run.
-- Пускай СЕКЦИЯ по СЕКЦИЯ (highlight + Run selection), не целия файл наведнъж —
-- SQL Editor показва само последния SELECT резултат, а искаме да видим всеки.
-- ============================================================

-- ── SETUP (като superuser/service_role — обикновен insert) ────────────────

insert into public.signing_requests (id, document_id, owner_user_id, status)
values ('11111111-1111-1111-1111-111111111111',
        '02607a9f-e2c5-4ca4-9683-4282fe212b98',
        '0ace47cc-df27-4163-bb79-cdd1b763c77d',
        'awaiting_recipients')
returning *;

insert into public.signing_request_recipients
  (id, signing_request_id, invited_email, marker_page, marker_x, marker_y)
values
  ('22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111',
   '<PROFILE2_EMAIL>', 0, 30, 30)
returning *;

insert into public.email_notifications (signing_request_id, recipient_id, recipient_email, type)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
        '<PROFILE2_EMAIL>', 'invitation');

-- ============================================================
-- ТЕСТ 1: Owner A вижда собствената заявка → очаквано: 1
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "0ace47cc-df27-4163-bb79-cdd1b763c77d", "email": "<OWNER_A_EMAIL>"}';

select count(*) as should_be_1 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- ТЕСТ 2: Owner B (Profile 2, ОЩЕ не е recipient) НЕ вижда заявката → очаквано: 0
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "290a5914-5d31-4418-b3ff-f124154a278e", "email": "<PROFILE2_EMAIL>"}';

select count(*) as should_be_0 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- ТЕСТ 3а: Profile 2 (сега като Recipient X, user_id ОЩЕ NULL в реда)
-- вижда собствения си recipient ред по email fallback policy → очаквано: 1
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "290a5914-5d31-4418-b3ff-f124154a278e", "email": "<PROFILE2_EMAIL>"}';

select count(*) as should_be_1 from public.signing_request_recipients
  where id = '22222222-2222-2222-2222-222222222222';

-- ── Claim поканата ──
select * from public.claim_recipient_invitation('22222222-2222-2222-2222-222222222222');

-- ============================================================
-- ТЕСТ 3б: Profile 2 СЕГА вижда signing_request-а през recipient policy → очаквано: 1
-- ============================================================
select count(*) as should_be_1 from public.signing_requests
  where id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- ТЕСТ 4: Anon (нелогнат) не вижда нищо → очаквано: 0 и 0 (НЕ грешка)
-- ============================================================
set local role anon;

select count(*) as should_be_0 from public.signing_requests;
select count(*) as should_be_0_too from public.signing_request_recipients;

reset role;

-- ============================================================
-- ТЕСТ 5: email_notifications — authenticated НЕ може INSERT → очаквано: ERROR
-- (грешката Е успешният резултат тук)
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "0ace47cc-df27-4163-bb79-cdd1b763c77d", "email": "<OWNER_A_EMAIL>"}';

insert into public.email_notifications (signing_request_id, recipient_email, type)
values ('11111111-1111-1111-1111-111111111111', 'test@example.com', 'invitation');
-- ⬆ ОЧАКВАНО: ERROR — "new row violates row-level security policy"

-- Owner A МОЖЕ да SELECT-не delivery статус на собствената заявка → очаквано: 1
select count(*) as should_be_1 from public.email_notifications
  where signing_request_id = '11111111-1111-1111-1111-111111111111';

reset role;

-- ============================================================
-- CLEANUP (като superuser/service_role, след като приключиш)
-- ============================================================
-- delete from public.email_notifications where signing_request_id = '11111111-1111-1111-1111-111111111111';
-- delete from public.signing_request_recipients where signing_request_id = '11111111-1111-1111-1111-111111111111';
-- delete from public.signing_requests where id = '11111111-1111-1111-1111-111111111111';