-- Migration 0003: soft delete колони + нови колони за signing_keys (Approach B)
--
-- Добавяме deleted_at към profiles, signing_keys, documents, signatures.
-- audit_log е умишлено изключена — тя е immutable (виж Section 3.6 на PROJECT_BRIEF.md).
--
-- Новите колони на signing_keys подкрепят Approach B (fallback) от Section 3.2:
-- ако PRF extension не е наличен, частният ключ се пази криптиран в БД.

-- ───────────────────────────────────────────────
-- 1. Soft delete колони
-- ───────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE public.signing_keys
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE public.signatures
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- ───────────────────────────────────────────────
-- 2. Допълнителни колони на signing_keys (Approach B — encrypted private key storage)
-- ───────────────────────────────────────────────

ALTER TABLE public.signing_keys
  ADD COLUMN IF NOT EXISTS encrypted_private_key BYTEA NULL,
  ADD COLUMN IF NOT EXISTS kdf_salt              BYTEA NULL,
  ADD COLUMN IF NOT EXISTS kdf_iterations        INT   NULL DEFAULT 600000,
  ADD COLUMN IF NOT EXISTS aes_iv                BYTEA NULL,
  ADD COLUMN IF NOT EXISTS certificate           BYTEA NULL;

-- ───────────────────────────────────────────────
-- 3. Обновени RLS policies — добавяме "AND deleted_at IS NULL"
--    към всички SELECT и UPDATE policies на засегнатите таблици.
--
--    Стратегия: DROP старата policy, CREATE нова с допълнителното условие.
--    INSERT и DELETE policies не се променят.
-- ───────────────────────────────────────────────

-- profiles
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id AND deleted_at IS NULL);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id AND deleted_at IS NULL);

-- signing_keys
DROP POLICY IF EXISTS "Users can view own signing keys" ON public.signing_keys;
CREATE POLICY "Users can view own signing keys"
  ON public.signing_keys FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

DROP POLICY IF EXISTS "Users can update own signing keys" ON public.signing_keys;
CREATE POLICY "Users can update own signing keys"
  ON public.signing_keys FOR UPDATE
  USING (auth.uid() = user_id AND deleted_at IS NULL);

-- documents
DROP POLICY IF EXISTS "Users can view own documents" ON public.documents;
CREATE POLICY "Users can view own documents"
  ON public.documents FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

DROP POLICY IF EXISTS "Users can update own documents" ON public.documents;
CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  USING (auth.uid() = user_id AND deleted_at IS NULL);

-- signatures (само SELECT — без UPDATE по design от 0001)
DROP POLICY IF EXISTS "Users can view own signatures" ON public.signatures;
CREATE POLICY "Users can view own signatures"
  ON public.signatures FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);
