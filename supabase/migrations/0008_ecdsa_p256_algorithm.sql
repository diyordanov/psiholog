-- 0008_ecdsa_p256_algorithm.sql
-- Добавя 'ecdsa-p256' към signing_algorithm enum.
-- Append-only: 'ed25519' остава в enum за обратна съвместимост (съществуващи ключове).
ALTER TYPE signing_algorithm ADD VALUE IF NOT EXISTS 'ecdsa-p256';
