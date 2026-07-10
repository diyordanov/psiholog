-- ============================================================
-- Миграция 0009: Hybrid signatures schema (ECDSA P-256 + ML-DSA-65)
--
-- Добавя три нови колони към signatures:
--   ecdsa_key_id        UUID NOT NULL  → ECDSA P-256 ключ (primary за PAdES)
--   ml_dsa_key_id       UUID NULL      → ML-DSA-65 ключ (null = PQ пропуснат)
--   signed_storage_path TEXT           → път в signed-documents bucket
--
-- signing_key_id се запазва (NOT NULL, backward compat) но е deprecated.
-- Нови редове трябва да попълват signing_key_id = ecdsa_key_id.
--
-- Re-signing: ЗАБРАНЕНО на ниво application (status='signed' → throw).
-- Следователно: един документ → точно един signed файл → UNIQUE path.
--
-- Grace period index: предотвратява double-signing на един документ.
-- ============================================================

-- ── 1. Добавяме новите колони ──────────────────────────────────────────────
ALTER TABLE public.signatures
  ADD COLUMN IF NOT EXISTS ecdsa_key_id        UUID REFERENCES public.signing_keys(id),
  ADD COLUMN IF NOT EXISTS ml_dsa_key_id       UUID REFERENCES public.signing_keys(id),
  ADD COLUMN IF NOT EXISTS signed_storage_path TEXT;

-- ── 2. Backfill: ecdsa_key_id = signing_key_id за съществуващи редове ─────
UPDATE public.signatures
  SET ecdsa_key_id = signing_key_id
  WHERE ecdsa_key_id IS NULL;

-- ── 3. NOT NULL след backfill ──────────────────────────────────────────────
ALTER TABLE public.signatures
  ALTER COLUMN ecdsa_key_id SET NOT NULL;

COMMENT ON COLUMN public.signatures.signing_key_id IS
  'Deprecated — use ecdsa_key_id. Retained NOT NULL for backward compatibility.';

-- ── 4. Check constraint: signed_storage_path задължителен за нови записи ──
--    Стари записи (преди Фаза 4, 2026-07-10) могат да имат NULL.
--    Всички нови записи (от Фаза 4 нататък) ТРЯБВА да имат path.
--    signatures таблицата няма created_at — timestamp колоната е signed_at.
ALTER TABLE public.signatures
  ADD CONSTRAINT signatures_signed_path_required_for_new
  CHECK (
    signed_storage_path IS NOT NULL
    OR signed_at < '2026-07-10'::timestamptz
  );

-- ── 5. UNIQUE индекс за signed_storage_path ───────────────────────────────
--    Един документ = един signed файл (re-signing е забранен).
--    WHERE signed_storage_path IS NOT NULL: не блокира стари записи.
CREATE UNIQUE INDEX IF NOT EXISTS signatures_signed_path_unique
  ON public.signatures (signed_storage_path)
  WHERE signed_storage_path IS NOT NULL;

-- ── 6. Grace period index ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS signatures_doc_signed_at_idx
  ON public.signatures (document_id, signed_at DESC);

-- ── 7. Audit index за ecdsa_key_id ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS signatures_ecdsa_key_idx
  ON public.signatures (ecdsa_key_id);

-- ── 8. RLS verification (информационен) ──────────────────────────────────
-- Съществуващите политики от migration 0001 работят без промяна:
--   "signatures_select_own": for select using (auth.uid() = user_id)
--   "signatures_insert_own": for insert with check (auth.uid() = user_id)
-- Политиките са row-level (по user_id), не column-level.
-- Новите колони автоматично са достъпни за SELECT и INSERT.
-- Не се добавят нови policies.
