import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { supabase } from './lib/supabase';
import AuthScreen from './components/auth/AuthScreen';
import RegisterPasskeyStep from './components/auth/RegisterPasskeyStep';
import UserMenu from './components/UserMenu';

function AppContent() {
  const { session, loading } = useAuth();
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [checkingPasskeys, setCheckingPasskeys] = useState(false);

  // auth.signInWithOtp() + verifyOtp() дава "реална" сесия, но profile-ът може
  // все още да няма закачен passkey (нов потребител, или прекъснат предишен опит,
  // напр. след презареждане на страницата). supabase.auth.passkey.list() е
  // единственият сигурен начин да проверим това — затова не разчитаме на local state.
  useEffect(() => {
    if (!session || session.user.is_anonymous) {
      setNeedsPasskeySetup(false);
      return;
    }

    setCheckingPasskeys(true);
    supabase.auth.passkey.list().then(({ data, error }) => {
      setNeedsPasskeySetup(!error && (data?.length ?? 0) === 0);
      setCheckingPasskeys(false);
    });
  }, [session?.user.id, session?.user.is_anonymous]);

  if (loading || checkingPasskeys) {
    return (
      <div className="flex min-h-screen items-center justify-center text-neutral-400">
        Зареждане...
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
