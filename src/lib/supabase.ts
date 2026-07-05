/**
 * supabase.ts
 * Създава и експортира единствения Supabase клиент за цялото приложение.
 *
 * Всички компоненти импортират `supabase` от тук — не създаваме нови клиенти
 * на места, за да не се дублират WebSocket връзките и auth listener-ите.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
