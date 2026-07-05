// Edge Function: delete-user-passkeys
//
// Изтрива ВСИЧКИ passkey-и на текущо логнатия потребител.
// Вика public.delete_user_webauthn_credentials() — SECURITY DEFINER функция,
// която достъпва auth.webauthn_credentials (недостъпна директно от PostgREST).
//
// Сигурност:
//   - user_id се взима от JWT токена (не от request body) — не може да се подправи
//   - Използва service_role key — никога не излиза от сървърната среда
//   - CORS ограничен до собствения домейн на приложението

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://psiholog.pages.dev';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(ALLOWED_ORIGIN),
    });
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('Missing or invalid Authorization header', 401);
  }
  const jwt = authHeader.slice(7);

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Верифицираме JWT-а
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !user) {
    return jsonError('Invalid or expired token', 401);
  }

  // Викаме SECURITY DEFINER функцията — тя достъпва auth.webauthn_credentials
  // (PostgREST не излага auth schema директно)
  const { data: deletedCount, error: deleteError } = await supabaseAdmin
    .rpc('delete_user_webauthn_credentials', { p_user_id: user.id });

  if (deleteError) {
    console.error('delete_user_webauthn_credentials грешка:', deleteError);
    return jsonError('Failed to delete passkeys', 500);
  }

  return new Response(
    JSON.stringify({ deleted_count: deletedCount ?? 0 }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(ALLOWED_ORIGIN) },
    }
  );
});

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
