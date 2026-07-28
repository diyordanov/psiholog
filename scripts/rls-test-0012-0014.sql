-- ============================================================
-- RLS Manual Test Script — Migrations 0012-0014 (multi-signer recipient RLS gaps)
--
-- Как да пуснеш: Supabase Dashboard → SQL Editor.
-- ВАЖНО: SQL Editor по подразбиране изпълнява като superuser/service_role
-- (bypass-ва RLS напълно). За реален RLS тест трябва да симулираш конкретен
-- auth.uid() чрез `set local role authenticated; set local request.jwt.claims`
-- ПРЕДИ всяка заявка — точно затова скриптът е разделен на именувани блокове.
--
-- ⚠️ ТРАНЗАКЦИОНЕН GOTCHA: изпълнявай ВСЕКИ номериран Тест като ОТДЕЛЕН "Run"
-- в SQL Editor-а (маркирай блока и Ctrl+Enter / Run), НЕ целия файл наведнъж.
-- Supabase SQL Editor изпълнява всеки "Run" в ЕДНА транзакция — ако по-ранен
-- statement в СЪЩИЯ Run хвърли грешка, ЦЯЛАТА транзакция (вкл. по-ранния
-- успешен SETUP) се roll-back-ва. Setup блокът също трябва да е свой Run.
--
-- Замени <OWNER_A_UUID>, <DOC1_UUID>, <DOC2_UUID>, <RECIPIENT_X_UUID>,
-- <RECIPIENT_X_EMAIL>, <RECIPIENT_Y_UUID>, <RECIPIENT_Y_EMAIL> с реални
-- стойности (2 съществуващи документа на един owner + 2 test recipient
-- акаунта — единият линкнат към SR1, другият изобщо непоканен никъде).
-- ============================================================

-- ============================================================
-- SETUP (изпълни като service_role/superuser, собствен Run)
-- ============================================================

-- SR1: активна заявка, Recipient X вече линкнат (status='registered')
insert into public.signing_requests
  (id, document_id, owner_user_id, status, current_signed_storage_path, version, owner_signed_at)
values
  ('a1111111-1111-1111-1111-111111111111', '<DOC1_UUID>', '<OWNER_A_UUID>',
   'awaiting_recipients', 'a1111111-1111-1111-1111-111111111111/v1.pdf', 1, now())
returning *;

insert into public.signing_request_recipients
  (id, signing_request_id, invited_email, user_id, status, marker_page, marker_x, marker_y)
values
  ('a2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111',
   '<RECIPIENT_X_EMAIL>', '<RECIPIENT_X_UUID>', 'registered', 0, 260, 30)
returning *;

-- SR2: ДРУГА заявка (различен документ), Recipient X НЕ участва тук изобщо —
-- симулира "чужда" multi-signer заявка за negative тестовете.
insert into public.signing_requests
  (id, document_id, owner_user_id, status, current_signed_storage_path, version, owner_signed_at)
values
  ('b1111111-1111-1111-1111-111111111111', '<DOC2_UUID>', '<OWNER_A_UUID>',
   'awaiting_recipients', 'b1111111-1111-1111-1111-111111111111/v1.pdf', 1, now())
returning *;

-- Storage: симулираме "качени" файлове (реалните bytes не са нужни за RLS
-- тест — RLS върху storage.objects проверява САМО path/bucket_id/metadata).
insert into storage.objects (bucket_id, name)
values
  ('signed-documents', 'a1111111-1111-1111-1111-111111111111/v1.pdf'),
  ('signed-documents', 'b1111111-1111-1111-1111-111111111111/v1.pdf')
on conflict do nothing;

-- ============================================================
-- Тест 1: Recipient X МОЖЕ да SELECT-не signed PDF на СВОЯТА заявка (SR1)
--         ✅ Gap 1 fix (migration 0012) — очакван резултат: 1
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

select count(*) as should_be_1 from storage.objects
  where bucket_id = 'signed-documents'
    and name = 'a1111111-1111-1111-1111-111111111111/v1.pdf';

reset role;

-- ============================================================
-- Тест 2: Recipient X НЕ МОЖЕ да SELECT-не signed PDF на ЧУЖДА заявка (SR2)
--         ✅ security guardrail — очакван резултат: 0
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

select count(*) as should_be_0 from storage.objects
  where bucket_id = 'signed-documents'
    and name = 'b1111111-1111-1111-1111-111111111111/v1.pdf';

reset role;

-- ============================================================
-- Тест 3: Recipient X МОЖЕ да UPDATE-не signing_requests.version +
--         current_signed_storage_path на SВОЯТА заявка (SR1)
--         ✅ Gap 2 fix (migration 0013, signing_requests policy)
--         Очакван резултат: 1 върнат ред, version = 2
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

update public.signing_requests
  set version = 2, current_signed_storage_path = 'a1111111-1111-1111-1111-111111111111/v2.pdf'
  where id = 'a1111111-1111-1111-1111-111111111111' and version = 1
  returning id, version, current_signed_storage_path;
-- ⬆ ОЧАКВАНО: 1 ред, version=2 (optimistic-concurrency UPDATE, точния path,
-- по който signAsRecipient() минава реално)

reset role;

-- ============================================================
-- Тест 4: Recipient Y (НЕ линкнат никъде към SR1) НЕ МОЖЕ да UPDATE-не SR1
--         ✅ security guardrail — очакван резултат: 0 засегнати реда
--         (RLS филтрира тихо чрез USING клаузата, БЕЗ грешка — обичайно
--         UPDATE поведение под RLS, не деструктивен error)
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_Y_UUID>", "email": "<RECIPIENT_Y_EMAIL>"}';

update public.signing_requests
  set version = 99
  where id = 'a1111111-1111-1111-1111-111111111111'
  returning id, version;
-- ⬆ ОЧАКВАНО: 0 реда (Recipient Y не е нито owner, нито recipient на SR1)

-- Потвърждение, че version НЕ е станал 99 (проверка от друга роля по-долу
-- в Тест 6 ще покаже version=2, не 99).

reset role;

-- ============================================================
-- Тест 5: Recipient X МОЖЕ да UPDATE-не documents.status='signed' за
--         документа на СВОЯТА заявка (SR1 → DOC1)
--         ✅ Gap 3 UPDATE fix (migration 0013, documents policy)
--         Очакван резултат: 1 върнат ред, status='signed'
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

update public.documents
  set status = 'signed', signed_at = now(),
      signed_storage_path = 'a1111111-1111-1111-1111-111111111111/v2.pdf'
  where id = '<DOC1_UUID>'
  returning id, status;
-- ⬆ ОЧАКВАНО: 1 ред, status='signed' — ТОЧНО .select('id') проверката,
-- добавена в signingService.ts след откриването на Gap 3.

reset role;

-- ============================================================
-- Тест 6: Recipient X МОЖЕ да SELECT-не documents.status СЛЕД update-а
--         ✅ Gap 3 SELECT fix (migration 0014) — очакван резултат: 'signed'
--         (без 0014 UPDATE-ът в Тест 5 щеше физически да мине, но
--         RETURNING/последващ SELECT да върнат 0 реда — silent success bug)
-- ============================================================
set local role authenticated;
set local request.jwt.claims = '{"sub": "<RECIPIENT_X_UUID>", "email": "<RECIPIENT_X_EMAIL>"}';

select status as should_be_signed from public.documents where id = '<DOC1_UUID>';

reset role;

-- ============================================================
-- Тест 7: Anon (нелогнат) НЕ МОЖЕ нищо от горното — общ default-deny
--         ✅ очакван резултат: 0 навсякъде, БЕЗ грешка (RLS filter)
-- ============================================================
set local role anon;

select count(*) as should_be_0_storage from storage.objects
  where bucket_id = 'signed-documents'
    and name = 'a1111111-1111-1111-1111-111111111111/v1.pdf';

select count(*) as should_be_0_sr from public.signing_requests
  where id = 'a1111111-1111-1111-1111-111111111111';

select count(*) as should_be_0_docs from public.documents where id = '<DOC1_UUID>';

reset role;

-- ============================================================
-- Cleanup (изпълни като service_role/superuser, собствен Run)
-- ============================================================
-- delete from storage.objects where bucket_id = 'signed-documents'
--   and name in ('a1111111-1111-1111-1111-111111111111/v1.pdf', 'b1111111-1111-1111-1111-111111111111/v1.pdf');
-- delete from public.signing_request_recipients where signing_request_id in
--   ('a1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111');
-- delete from public.signing_requests where id in
--   ('a1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111');
-- update public.documents set status = 'uploaded', signed_at = null, signed_storage_path = null
--   where id = '<DOC1_UUID>'; -- връща DOC1 в изходно състояние, ако е нужно повторно тестване
