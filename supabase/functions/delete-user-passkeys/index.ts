// Edge Function: delete-user-passkeys
//
// Изтрива ВСИЧКИ passkey-и на текущо логнатия потребител от auth.webauthn_credentials.
// Supabase Passkeys (beta) пази credentials в auth.webauthn_credentials, НЕ в
// auth.mfa_factors — затова auth.admin.mfa.deleteFactor() не работи тук.
//
// Сигурност:
//   - user_id се взима от JWT токена (не от request body) — не може да се подправи
//   - Използва service_role key — никога не излиза от сървърната среда
//   - CORS ограничен до собствения домейн на приложението

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://psiholog.pages.dev';

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(ALLOWED_ORIGIN),
    });
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  // Извличаме JWT от Authorization header
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('Missing or invalid Authorization header', 401);
  }
  const jwt = authHeader.slice(7);

  // Admin клиент с service_role — има достъп до auth schema
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Верифицираме JWT-а и извличаме потребителя
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !user) {
    return jsonError('Invalid or expired token', 401);
  }

  // Изтриваме всички passkey-и от auth.webauthn_credentials
  // (Supabase Passkeys beta пази credentials тук, не в auth.mfa_factors)
  const { data: deleted, error: deleteError } = await supabaseAdmin
    .schema('auth')
    .from('webauthn_credentials')
    .delete()
    .eq('user_id', user.id)
    .select('id');

  if (deleteError) {
    console.error('webauthn_credentials delete грешка:', deleteError);
    return jsonError('Failed to delete passkeys', 500);
  }

  const deletedCount = deleted?.length ?? 0;

  return new Response(
    JSON.stringify({ deleted_count: deletedCount }),
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
