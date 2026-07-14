import { useEffect, useState } from 'react';
import SignUpForm from './SignUpForm';
import SignInForm from './SignInForm';
import RecoveryFlow from './RecoveryFlow';
import BrandPanel from './BrandPanel';
import UnsupportedBrowserNotice from './UnsupportedBrowserNotice';
import { isPasskeySupported } from '../../lib/webauthnSupport';
import { Shield } from 'lucide-react';

type AuthMode = 'signup' | 'signin' | 'recovery';

export default function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>('signup');

  // Обновяваме page title спрямо текущия режим
  useEffect(() => {
    const titles: Record<AuthMode, string> = {
      signin: 'Вход | SignShield',
      signup: 'Регистрация | SignShield',
      recovery: 'Възстановяване | SignShield',
    };
    document.title = titles[mode];
  }, [mode]);

  if (!isPasskeySupported()) {
    return (
      <div className="mx-auto mt-24 max-w-sm px-6">
        <UnsupportedBrowserNotice />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Лява страна — форма (60% на desktop, 50% на tablet, 100% на mobile) */}
      <div className="flex flex-1 flex-col md:max-w-[60%]">
        {mode === 'signin' && (
          <SignInForm
            onStartRecovery={() => setMode('recovery')}
            onShowSignup={() => setMode('signup')}
          />
        )}
        {mode === 'signup' && <SignupPanel onShowSignin={() => setMode('signin')} />}
        {mode === 'recovery' && <RecoveryPanel onCancel={() => setMode('signin')} />}
      </div>

      {/* Дясна страна — brand panel (скрит на mobile) */}
      <div className="hidden md:flex md:flex-1 md:max-w-[40%]">
        <BrandPanel variant={mode === 'signup' ? 'signup' : 'login'} />
      </div>
    </div>
  );
}

// Временен wrapper за SignUpForm докато не бъде redesign-нат —
// добавя само логото и навигационния линк към вход
function SignupPanel({ onShowSignin }: { onShowSignin: () => void }) {
  return (
    <div className="flex flex-1 flex-col px-8 py-10 lg:px-12 lg:py-14">
      <div className="flex items-center gap-2">
        <Shield size={22} className="text-indigo-800" strokeWidth={2} aria-hidden="true" />
        <span className="text-[15px] font-medium tracking-tight text-neutral-900">SignShield</span>
      </div>
      <div className="flex flex-1 flex-col justify-center">
        <div className="w-full max-w-sm">
          <SignUpForm />
        </div>
      </div>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-neutral-200" />
          <span className="text-xs text-neutral-400">вече имате акаунт?</span>
          <div className="flex-1 border-t border-neutral-200" />
        </div>
        <button
          type="button"
          onClick={onShowSignin}
          className="mt-3 w-full text-center text-sm font-medium text-indigo-800 transition-colors hover:text-indigo-900"
        >
          Влезте
        </button>
      </div>
    </div>
  );
}

// Временен wrapper за RecoveryFlow — добавя логото и layout
function RecoveryPanel({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex flex-1 flex-col px-8 py-10 lg:px-12 lg:py-14">
      <div className="flex items-center gap-2">
        <Shield size={22} className="text-indigo-800" strokeWidth={2} aria-hidden="true" />
        <span className="text-[15px] font-medium tracking-tight text-neutral-900">SignShield</span>
      </div>
      <div className="flex flex-1 flex-col justify-center">
        <div className="w-full max-w-sm">
          <h1 className="mb-4 text-2xl font-medium text-neutral-900">Възстановяване на достъп</h1>
          <RecoveryFlow onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
