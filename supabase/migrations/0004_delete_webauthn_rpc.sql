-- Migration 0004: SECURITY DEFINER функция за изтриване на WebAuthn credentials
--
-- PostgREST не излага auth schema — затова Edge Function не може да достъпи
-- auth.webauthn_credentials директно чрез supabase-js клиента.
-- Решение: public функция с SECURITY DEFINER, която върви с привилегиите на
-- дефиниращия я потребител (postgres) и може да пише в auth schema.
-- Само service_role може да я вика — anon и authenticated нямат EXECUTE.

CREATE OR REPLACE FUNCTION public.delete_user_webauthn_credentials(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
DECLARE
  deleted_count int;
BEGIN
  WITH deleted AS (
    DELETE FROM auth.webauthn_credentials
    WHERE user_id = p_user_id
    RETURNING id
  )
  SELECT count(*)::int INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

-- Ограничаваме достъпа — само service_role може да вика тази функция
REVOKE ALL ON FUNCTION public.delete_user_webauthn_credentials(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_user_webauthn_credentials(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_user_webauthn_credentials(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_webauthn_credentials(uuid) TO service_role;
