import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Липсват VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Провери .env.local файла.'
  );
}

// experimental.passkey: true е задължително — без него auth.registerPasskey()
// и auth.signInWithPasskey() гърмят грешка (виж PROJECT_BRIEF.md 6.1).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    experimental: {
      passkey: true,
    },
  },
});
