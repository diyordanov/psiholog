// Edge Function: delete-user-passkeys
//
// Изтрива ВСИЧКИ passkey-и (MFA factors от тип 'webauthn') на текущо логнатия потребител.
// Извиква се само по време на recovery flow — след успешен email OTP, преди регистрация
// на нов passkey. Целта: устройство, което е изгубено или откраднато, да загуби достъп.
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

  // Създаваме admin клиент (service_role) за управление на passkey-и
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Верифицираме JWT-а и извличаме потребителя — без да разчитаме на request body
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !user) {
    return jsonError('Invalid or expired token', 401);
  }

  // Взимаме всички MFA factors на потребителя
  const { data: factorsData, error: listError } =
    await supabaseAdmin.auth.admin.mfa.listFactors({ userId: user.id });

  if (listError) {
    console.error('listFactors грешка:', listError);
    return jsonError('Failed to list passkeys', 500);
  }

  // Филтрираме само webauthn factors (passkey-ите)
  const passkeyFactors = (factorsData?.all ?? []).filter(
    (f) => f.factor_type === 'webauthn'
  );

  // Изтриваме всеки passkey
  let deletedCount = 0;
  for (const factor of passkeyFactors) {
    const { error: deleteError } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
      userId: user.id,
      id: factor.id,
    });
    if (deleteError) {
      console.error(`Грешка при изтриване на factor ${factor.id}:`, deleteError);
      // Продължаваме с останалите — не спираме при единична грешка
    } else {
      deletedCount++;
    }
  }

  return new Response(
    JSON.stringify({ deleted_count: deletedCount, total_found: passkeyFactors.length }),
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
