-- Migration 0006: WebAuthn PRF колони за signing_keys
--
-- Добавяме три нови колони за PRF-базирана защита на signing keys (Section 3.2).
-- Старите колони kdf_salt, kdf_iterations, aes_iv ОСТАВАТ — soft-deleted
-- парола-базирани ключове ги ползват и не трябва да се загубят от историята.
--
-- Нови PRF ключове използват: prf_salt, wrapped_key_iv, credential_id.
-- Стари парола-базирани ключове: prf_salt IS NULL (лесно разпознаваеми).
--
-- Потребителите с парола-базирани ключове ще видят migration banner в UI
-- и ще трябва ръчно да изтрият старите и да генерират нови.

ALTER TABLE public.signing_keys
  ADD COLUMN IF NOT EXISTS prf_salt       BYTEA NULL,  -- 32 random bytes, PRF input per-key
  ADD COLUMN IF NOT EXISTS wrapped_key_iv BYTEA NULL,  -- 12 bytes, IV за AES-GCM
  ADD COLUMN IF NOT EXISTS credential_id  TEXT  NULL;  -- WebAuthn credential rawId (base64url)
