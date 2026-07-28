/**
 * supabase.ts
 * Създава и експортира единствения Supabase клиент за цялото приложение.
 *
 * Всички компоненти импортират `supabase` от тук — не създаваме нови клиенти
 * на места, за да не се дублират WebSocket връзките и auth listener-ите.
 */
import { createClient } from '@supabase/supabase-js';

// import.meta.env е Vite-специфично — недостъпно при `tsx` Node скриптове
// (виж scripts/test-multi-signer-e2e.ts). Node env fallback е само за тази
// ситуация; в браузъра import.meta.env винаги е налично и има приоритет.
// Достъпваме process ЧРЕЗ globalThis (не директно) — browser tsconfig-ът
// (tsconfig.app.json) няма @types/node, директна `process` референция чупи
// production build-а (tsc -b), макар да минава под plain `tsc --noEmit`.
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL ?? nodeEnv?.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY ?? nodeEnv?.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Липсват VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Провери .env.local файла.'
  );
}

// experimental.passkey: true е задължително — без него auth.registerPasskey()
// и auth.signInWithPasskey() хвърлят грешка "passkeys not enabled".
// Виж PROJECT_BRIEF.md Section 6.1 за подробности.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    experimental: {
      passkey: true,
    },
  },
});
