import { useState } from 'react';
import SignUpForm from './SignUpForm';
import SignInForm from './SignInForm';
import UnsupportedBrowserNotice from './UnsupportedBrowserNotice';
import { isPasskeySupported } from '../../lib/webauthnSupport';

export default function AuthScreen() {
  const [tab, setTab] = useState<'signup' | 'signin'>('signup');

  if (!isPasskeySupported()) {
    return (
      <div className="mx-auto mt-24 max-w-sm px-6">
        <UnsupportedBrowserNotice />
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-6">
      <div className="mb-6 flex gap-2 border-b border-neutral-200">
        <button
          onClick={() => setTab('signup')}
          className={`px-3 py-2 text-sm font-medium ${
            tab === 'signup'
              ? 'border-b-2 border-neutral-900 text-neutral-900'
              : 'text-neutral-400'
          }`}
        >
          Регистрация
        </button>
        <button
          onClick={() => setTab('signin')}
          className={`px-3 py-2 text-sm font-medium ${
            tab === 'signin'
              ? 'border-b-2 border-neutral-900 text-neutral-900'
              : 'text-neutral-400'
          }`}
        >
          Вход
        </button>
      </div>

      {tab === 'signup' ? <SignUpForm /> : <SignInForm />}
    </div>
  );
}
