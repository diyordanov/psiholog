/**
 * App.tsx
 * Коренният компонент. Управлява кой екран се показва въз основа на auth state-а.
 *
 * Логика на routing-а (в реда, по който се проверява):
 *   1. loading / checkingPasskeys / processingRecovery → spinner
 *   2. Логнат + няма passkey → RegisterPasskeyStep (довърши регистрацията)
 *   3. Не е логнат (или анонимен) → AuthScreen (login / signup / recovery)
 *   4. Логнат с passkey → DocumentList (главното приложение)
 *
 * Recovery flow (?recovery=1):
 *   Когато потребителят кликне recovery линка от email-а, Supabase го пренасочва
 *   обратно с ?recovery=1 в URL-а. App.tsx хваща това, изтрива старите passkey-и
 *   (чрез Edge Function) и показва RegisterPasskeyStep за нов passkey.
 */
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { supabase } from './lib/supabase';
import { logAuditEvent } from './lib/auditLog';
import AuthScreen from './components/auth/AuthScreen';
import RegisterPasskeyStep from './components/auth/RegisterPasskeyStep';
import UserMenu from './components/UserMenu';
import DocumentList from './components/documents/DocumentList';
import KeyManagement from './components/keys/KeyManagement';
import VerifyPage from './components/verify/VerifyPage';

type ActiveTab = 'documents' | 'keys' | 'verify';

/**
 * Проверява дали текущият URL съдържа ?recovery=1.
 * Параметърът се поставя от RecoveryFlow като część от emailRedirectTo.
 * Използва се като функция (не inline) за да може да се подаде на useState
 * като initializer — изпълнява се само веднъж при mount.
 */
function isRecoveryRedirect(): boolean {
  return new URLSearchParams(window.location.search).get('recovery') === '1';
}

/**
 * Извиква Edge Function `delete-user-passkeys` с JWT токена на текущия потребител.
 * Edge Function верифицира токена и изтрива ВСИЧКИ passkey-и на потребителя
 * чрез SECURITY DEFINER PostgreSQL функция (PostgREST не достъпва auth schema директно).
 *
 * @returns Брой изтрити passkey-и, или null при мрежова/сървърна грешка.
 */
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
  const [isNewUser, setIsNewUser] = useState(false);

  // /verify е публична страница — показва се без auth, дори на не-логнати потребители
  if (window.location.pathname === '/verify') {
    return <VerifyPage standalone />;
  }

  // Инициализираме на true веднага ако ?recovery=1 е в URL-а.
  // Ако го инициализираме на false и после го сетваме в useEffect,
  // има един render, в който dashboard-ът е видим — неприятен flash.
  const [processingRecovery, setProcessingRecovery] = useState(isRecoveryRedirect);

  useEffect(() => {
    // Без активна реална сесия няма нищо за проверяване.
    if (!session || session.user.is_anonymous) {
      setNeedsPasskeySetup(false);
      return;
    }

    // ── Recovery flow ────────────────────────────────────────────────────────
    // Потребителят е кликнал recovery линка от email-а → ?recovery=1 е в URL-а.
    // Изтриваме ВСИЧКИ стари passkey-и преди да пуснем регистрация на нов.
    // Ако изтриването е неуспешно — прекратяваме recovery и изписваме грешка,
    // защото не е сигурно да се регистрира нов passkey ако старите са останали.
    if (isRecoveryRedirect()) {
      setProcessingRecovery(true);

      // Почистваме ?recovery=1 от URL без reload, за да не задейства отново при F5.
      window.history.replaceState({}, '', window.location.pathname);

      const token = session.access_token;
      const userId = session.user.id;

      logAuditEvent(userId, 'recovery_otp_verified');

      deleteAllUserPasskeys(token).then((deletedCount) => {
        if (deletedCount === null) {
          console.error('delete-user-passkeys Edge Function върна грешка — recovery прекратен');
          alert('Възникна грешка при изтриване на старите passkey-и. Опитай отново.');
          supabase.auth.signOut();
          setProcessingRecovery(false);
          return;
        }
        logAuditEvent(userId, 'old_passkeys_deleted');
        setIsNewUser(false); // recovery — not a new signup
        setNeedsPasskeySetup(true);
        setProcessingRecovery(false);
      });

      return;
    }

    // ── Нормален flow: проверка за passkey ──────────────────────────────────
    // Не разчитаме на локален флаг — проверяваме реално в Supabase дали
    // потребителят има регистриран passkey. Така работи коректно дори при
    // презареждане на страницата по средата на регистрационния процес.
    setCheckingPasskeys(true);
    supabase.auth.passkey.list().then(({ data, error }) => {
      const noPasskeys = !error && (data?.length ?? 0) === 0;
      setIsNewUser(noPasskeys); // no passkeys yet = brand-new signup
      setNeedsPasskeySetup(noPasskeys);
      setCheckingPasskeys(false);
    });
  }, [session?.user.id, session?.user.is_anonymous]);

  // Показваме spinner докато auth state-ът или passkey проверката не са готови.
  if (loading || checkingPasskeys || processingRecovery) {
    return (
      <div className="flex min-h-screen items-center justify-center text-neutral-400">
        {processingRecovery ? 'Изтриваме стари passkey-и...' : 'Зареждане...'}
      </div>
    );
  }

  // Потребителят е логнат, но няма passkey → трябва да регистрира един.
  // Това се случва при: нова регистрация или след успешен recovery flow.
  if (session && !session.user.is_anonymous && needsPasskeySetup) {
    return <RegisterPasskeyStep isNewUser={isNewUser} onDone={() => setNeedsPasskeySetup(false)} />;
  }

  // Не е логнат → показваме auth екрана (login / signup / recovery избор).
  if (!session || session.user.is_anonymous) {
    return <AuthScreen />;
  }

  // Логнат с passkey → главното приложение.
  return <MainApp userId={session.user.id} />;
}

/** Главното приложение с таб навигация: Документи | Ключове | Провери. */
function MainApp({ userId }: { userId: string }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('documents');

  return (
    <main>
      <UserMenu />

      {/* Таб навигация */}
      <div className="border-b border-neutral-200 bg-white">
        <nav className="mx-auto flex max-w-3xl gap-1 px-4">
          {(
            [
              ['documents', 'Документи'],
              ['keys', 'Ключове'],
              ['verify', 'Провери документ'],
            ] as [ActiveTab, string][]
          ).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'documents' && <DocumentList userId={userId} />}
      {activeTab === 'keys'      && <KeyManagement userId={userId} />}
      {activeTab === 'verify'    && <VerifyPage standalone={false} />}
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
