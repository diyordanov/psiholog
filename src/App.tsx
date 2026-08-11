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
import NotificationBell from './components/NotificationBell';
import Logo from './components/common/Logo';
import DocumentList from './components/documents/DocumentList';
import KeyManagement from './components/keys/KeyManagement';
import VerifyPage from './components/verify/VerifyPage';
import HowItWorksPage from './components/howItWorks/HowItWorksPage';
import InvitationLandingPage from './components/invitations/InvitationLandingPage';
import PendingInvitationsPage from './components/invitations/PendingInvitationsPage';
import { usePendingInvitationsCount } from './hooks/usePendingInvitationsCount';
import { type ActiveTab, initialTabFromRequest } from './lib/tabNavigation';

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
  const [passkeyCheckError, setPasskeyCheckError] = useState(false);

  // /verify е публична страница — показва се без auth, дори на не-логнати потребители
  if (window.location.pathname === '/verify') {
    return <VerifyPage standalone />;
  }

  // /invite/:recipientId — за разлика от /verify, НЕ е early return преди
  // passkey gate-а по-долу: нов recipient (кликнал email покана-линка, виж
  // sendInvitationEmail в signingRequestService.ts — праща истинска Supabase
  // OTP сесия, `shouldCreateUser: true`) трябва първо да мине през
  // RegisterPasskeyStep, преди изобщо да може да подпише нещо. Затова
  // проверката е разположена СЛЕД needsPasskeySetup gate-а по-долу.
  const inviteMatch = window.location.pathname.match(/^\/invite\/([^/]+)$/);

  // Инициализираме на true веднага ако ?recovery=1 е в URL-а.
  // Ако го инициализираме на false и после го сетваме в useEffect,
  // има един render, в който dashboard-ът е видим — неприятен flash.
  const [processingRecovery, setProcessingRecovery] = useState(isRecoveryRedirect);
  const [passkeyCheckRetryTick, setPasskeyCheckRetryTick] = useState(0);

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
    //
    // ВАЖНО: при error от passkey.list() (напр. passkeys feature не е
    // конфигуриран правилно в Supabase — липсващ/грешен webauthn_rp_id)
    // НЕ пропускаме потребителя в dashboard-а мълчаливо — резултатът е
    // неизвестен (може да има passkey, може и да няма), а грешен "минаваш
    // без passkey" води точно до "нямаш регистриран passkey" при следващ
    // login. Вместо това показваме грешка с бутон за повторен опит.
    setCheckingPasskeys(true);
    setPasskeyCheckError(false);
    supabase.auth.passkey.list().then(({ data, error }) => {
      setCheckingPasskeys(false);
      if (error) {
        console.error('passkey.list() failed:', error.message);
        setPasskeyCheckError(true);
        return;
      }
      const noPasskeys = (data?.length ?? 0) === 0;
      setIsNewUser(noPasskeys); // no passkeys yet = brand-new signup
      setNeedsPasskeySetup(noPasskeys);
    });
  }, [session?.user.id, session?.user.is_anonymous, passkeyCheckRetryTick]);

  // Показваме spinner докато auth state-ът или passkey проверката не са готови.
  if (loading || checkingPasskeys || processingRecovery) {
    return (
      <div className="flex min-h-screen items-center justify-center text-neutral-400">
        {processingRecovery ? 'Изтриваме стари passkey-и...' : 'Зареждане...'}
      </div>
    );
  }

  // passkey.list() гръмна — не знаем дали има passkey, затова не пускаме
  // нито към dashboard, нито към регистрация. Изричен retry вместо тих bypass.
  if (session && !session.user.is_anonymous && passkeyCheckError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center text-neutral-500">
        <p>Възникна грешка при проверка на passkey-ите ти. Опитай отново.</p>
        <button
          onClick={() => setPasskeyCheckRetryTick((t) => t + 1)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Опитай пак
        </button>
      </div>
    );
  }

  // Потребителят е логнат, но няма passkey → трябва да регистрира един.
  // Това се случва при: нова регистрация или след успешен recovery flow.
  if (session && !session.user.is_anonymous && needsPasskeySetup) {
    return (
      <RegisterPasskeyStep
        isNewUser={isNewUser}
        needsDisplayName={!!inviteMatch}
        onDone={() => setNeedsPasskeySetup(false)}
      />
    );
  }

  // /invite/:recipientId — след passkey gate-а: ако е нов recipient, вече е
  // регистрирал passkey (клон по-горе); ако не е логнат изобщо,
  // InvitationLandingPage сам показва not_logged_in + вграден AuthScreen.
  if (inviteMatch) {
    return <InvitationLandingPage recipientId={inviteMatch[1]} />;
  }

  // Не е логнат → показваме auth екрана (login / signup / recovery избор).
  if (!session || session.user.is_anonymous) {
    return <AuthScreen />;
  }

  // Логнат с passkey → главното приложение.
  return <MainApp userId={session.user.id} />;
}

/** Главното приложение с таб навигация: Документи | Ключове | Покани | Провери | Как работи. */
function MainApp({ userId }: { userId: string }) {
  const { session } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTabFromRequest);
  const userEmail = session?.user.email ?? null;
  const { count: pendingCount, refresh: refreshPendingCount } = usePendingInvitationsCount(userEmail);

  const tabs: [ActiveTab, string][] = [
    ['documents', 'Документи'],
    ['keys', 'Ключове'],
    ['invitations', pendingCount > 0 ? `Покани (${pendingCount})` : 'Покани'],
    ['verify', 'Провери документ'],
    ['how-it-works', 'Как работи'],
  ];

  return (
    <main className="min-h-screen">
      {/* Sticky стъклен хедър — лого, потребителско меню и сегментирана таб навигация */}
      <header className="glass-panel sticky top-0 z-30 rounded-none border-x-0 border-t-0">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo size="md" />
          <div className="flex items-center gap-1">
            <NotificationBell enabled={!!userId} />
            <UserMenu />
          </div>
        </div>

        <nav className="mx-auto max-w-4xl px-4 pb-3 sm:px-6">
          <div className="flex gap-1 overflow-x-auto rounded-xl bg-neutral-900/5 p-1 scrollbar-hide">
            {tabs.map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
                  activeTab === tab
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      {activeTab === 'documents'    && <DocumentList userId={userId} onNavigateKeys={() => setActiveTab('keys')} onNavigateHowItWorks={() => setActiveTab('how-it-works')} />}
      {activeTab === 'keys'         && <KeyManagement userId={userId} />}
      {activeTab === 'invitations'  && userEmail && (
        <PendingInvitationsPage userId={userId} userEmail={userEmail} onInvitationsChanged={refreshPendingCount} />
      )}
      {activeTab === 'verify'       && <VerifyPage standalone={false} />}
      {activeTab === 'how-it-works' && <HowItWorksPage />}
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <div className="app-mesh-bg" aria-hidden="true" />
      <AppContent />
    </AuthProvider>
  );
}

export default App;
