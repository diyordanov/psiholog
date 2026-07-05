import { useState } from 'react';
import SignUpForm from './SignUpForm';
import SignInForm from './SignInForm';
import RecoveryFlow from './RecoveryFlow';
import UnsupportedBrowserNotice from './UnsupportedBrowserNotice';
import { isPasskeySupported } from '../../lib/webauthnSupport';

type AuthMode = 'signup' | 'signin' | 'recovery';

export default function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>('signup');

  if (!isPasskeySupported()) {
    return (
      <div className="mx-auto mt-24 max-w-sm px-6">
        <UnsupportedBrowserNotice />
      </div>
    );
  }

  if (mode === 'recovery') {
    return (
      <div className="mx-auto mt-24 max-w-sm px-6">
        <h2 className="mb-4 text-lg font-semibold text-neutral-900">
          Възстановяване на достъп
        </h2>
        <RecoveryFlow onCancel={() => setMode('signin')} />
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-6">
      <div className="mb-6 flex gap-2 border-b border-neutral-200">
        <button
          onClick={() => setMode('signup')}
          className={`px-3 py-2 text-sm font-medium ${
            mode === 'signup'
              ? 'border-b-2 border-neutral-900 text-neutral-900'
              : 'text-neutral-400'
          }`}
        >
          Регистрация
        </button>
        <button
          onClick={() => setMode('signin')}
          className={`px-3 py-2 text-sm font-medium ${
            mode === 'signin'
              ? 'border-b-2 border-neutral-900 text-neutral-900'
              : 'text-neutral-400'
          }`}
        >
          Вход
        </button>
      </div>

      {mode === 'signup'
        ? <SignUpForm />
        : <SignInForm onStartRecovery={() => setMode('recovery')} />
      }
    </div>
  );
}
