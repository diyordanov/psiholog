-- ============================================================
-- Миграция 0007: X.509 сертификати за signing_keys (Фаза 3.5)
--
-- Добавя две nullable колони:
--   certificate         BYTEA  — DER-encoded X.509 (Ed25519) или
--                                UTF-8 JSON attestation (ML-DSA-65)
--   certificate_expires_at TIMESTAMPTZ — за UI 30-дневно предупреждение
--                                        и Phase 5 timestamp-at-signing
--
-- Съществуващите ключове (без сертификат) ще получат certificate = NULL.
-- Edge Function issue-certificate ги попълва при retrofit или при ново генериране.
-- ============================================================

ALTER TABLE public.signing_keys
  ADD COLUMN IF NOT EXISTS certificate            BYTEA        NULL,
  ADD COLUMN IF NOT EXISTS certificate_expires_at TIMESTAMPTZ  NULL;

-- Индекс за бърза проверка "има ли сертификат" при retrofit заявка.
CREATE INDEX IF NOT EXISTS signing_keys_cert_null_idx
  ON public.signing_keys (user_id)
  WHERE certificate IS NULL AND deleted_at IS NULL;
