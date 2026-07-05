import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { supabase } from './lib/supabase';
import { logAuditEvent } from './lib/auditLog';
import AuthScreen from './components/auth/AuthScreen';
import RegisterPasskeyStep from './components/auth/RegisterPasskeyStep';
import UserMenu from './components/UserMenu';

// Проверяваме дали URL-ът съдържа ?recovery=1 — поставен от RecoveryFlow при redirect.
function isRecoveryRedirect(): boolean {
  return new URLSearchParams(window.location.search).get('recovery') === '1';
}

// Извиква Edge Function delete-user-passkeys с текущия JWT.
// Връща броя изтрити passkey-и или null при грешка.
async function deleteAllUserPasskeys(accessToken: string): Promise<number | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/delete-user-passkeys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = await res.json() as { deleted_count: number };
    return json.deleted_count;
  } catch {
    return null;
  }
}

function AppContent() {
  const { session, loading } = useAuth();
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [checkingPasskeys, setCheckingPasskeys] = useState(false);
  // true докато изтриваме старите passkey-и след recovery redirect
  const [processingRecovery, setProcessingRecovery] = useState(false);

  useEffect(() => {
    if (!session || session.user.is_anonymous) {
      setNeedsPasskeySetup(false);
      return;
    }

    // Recovery flow: потребителят е кликнал recovery линка → ?recovery=1 е в URL-а.
    // Изтриваме всички стари passkey-и, след което го пускаме да регистрира нов.
    if (isRecoveryRedirect()) {
      setProcessingRecovery(true);

      // Почистваме ?recovery=1 от URL без да презареждаме страницата
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);

      const token = session.access_token;
      const userId = session.user.id;

      logAuditEvent(userId, 'recovery_otp_verified');

      deleteAllUserPasskeys(token).then((deletedCount) => {
        if (deletedCount === null) {
          // Edge Function е върнала грешка — не пускаме регистрация на нов passkey,
          // защото старите може да не са изтрити (security risk).
          console.error('delete-user-passkeys Edge Function върна грешка — recovery прекратен');
          alert('Възникна грешка при изтриване на старите passkey-и. Опитай отново.');
          supabase.auth.signOut();
          setProcessingRecovery(false);
          return;
        }
        logAuditEvent(userId, 'old_passkeys_deleted');
        setNeedsPasskeySetup(true);
        setProcessingRecovery(false);
      });

      return;
    }

    // Нормален flow: проверяваме дали потребителят има регистриран passkey.
    // supabase.auth.passkey.list() е единственият надежден начин — не разчитаме на
    // local state, защото потребителят може да е презаредил страницата по средата
    // на регистрацията.
    setCheckingPasskeys(true);
    supabase.auth.passkey.list().then(({ data, error }) => {
      setNeedsPasskeySetup(!error && (data?.length ?? 0) === 0);
      setCheckingPasskeys(false);
    });
  }, [session?.user.id, session?.user.is_anonymous]);

  if (loading || checkingPasskeys || processingRecovery) {
    return (
      <div className="flex min-h-screen items-center justify-center text-neutral-400">
        {processingRecovery ? 'Изтриваме стари passkey-и...' : 'Зареждане...'}
      </div>
    );
  }

  if (session && !session.user.is_anonymous && needsPasskeySetup) {
    return <RegisterPasskeyStep onDone={() => setNeedsPasskeySetup(false)} />;
  }

  if (!session || session.user.is_anonymous) {
    return <AuthScreen />;
  }

  return (
    <main>
      <UserMenu />
      <div className="flex min-h-[80vh] items-center justify-center px-6 text-center text-neutral-400">
        Тук ще бъде списъкът с документи (Фаза 2).
      </div>
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
