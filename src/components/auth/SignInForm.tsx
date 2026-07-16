import { useState } from 'react';
import { Shield, Fingerprint, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { logAuditEvent } from '../../lib/auditLog';

interface SignInFormProps {
  onStartRecovery: () => void;
  onShowSignup: () => void;
}

/**
 * Форма за вход само с passkey (WebAuthn) — няма парола/email поле.
 * При успех Supabase създава сесия автоматично; App.tsx поема нататък през AuthContext.
 */
export default function SignInForm({ onStartRecovery, onShowSignup }: SignInFormProps) {
  const [status, setStatus] = useState<'idle' | 'signing-in' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Стартира WebAuthn "get" церемония през Supabase — браузърът показва
   * системния диалог за избор на passkey (Face ID/Touch ID/Windows Hello и т.н.).
   * При грешка (отказан диалог, липсващ passkey на устройството) показваме общо
   * съобщение, без да разкриваме дали конкретен акаунт съществува.
   */
  async function handleSignIn() {
    setErrorMessage(null);
    setStatus('signing-in');

    const { data, error } = await supabase.auth.signInWithPasskey();

    if (error || !data.user) {
      setErrorMessage('Входът не успя. Провери дали имаш регистриран passkey на това устройство.');
      setStatus('error');
      return;
    }

    // Одитно логване на успешен вход (за comply/security trail).
    await logAuditEvent(data.user.id, 'login');
    setStatus('idle');
  }

  return (
    <div className="flex flex-1 flex-col px-8 py-10 lg:px-12 lg:py-14">
      {/* Лого */}
      <div className="flex items-center gap-2.5">
        <Shield size={30} className="text-indigo-800" strokeWidth={2} aria-hidden="true" />
        <span className="text-xl font-medium tracking-tight text-neutral-900">SignShield</span>
      </div>

      {/* Заглавие + форма — вертикално центрирани */}
      <div className="flex flex-1 flex-col justify-center">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-medium leading-snug text-neutral-900">Добре дошли</h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            Използвайте Face ID, Touch ID, passkey или друг метод на устройството си, за да
            влезете сигурно — без пароли за помнене.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            {errorMessage && (
              <div role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleSignIn}
              disabled={status === 'signing-in'}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-800 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-800 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status === 'signing-in' ? (
                <>
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                  Изчакайте...
                </>
              ) : (
                <>
                  <Fingerprint size={16} aria-hidden="true" />
                  Продължи с passkey
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onStartRecovery}
              className="text-center text-sm text-neutral-400 transition-colors hover:text-neutral-600"
            >
              Забравен достъп
            </button>
          </div>
        </div>
      </div>

      {/* Footer — навигация към регистрация */}
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-neutral-200" />
          <span className="text-xs text-neutral-400">нямате акаунт?</span>
          <div className="flex-1 border-t border-neutral-200" />
        </div>
        <button
          type="button"
          onClick={onShowSignup}
          className="mt-3 w-full text-center text-sm font-medium text-indigo-800 transition-colors hover:text-indigo-900"
        >
          Създайте акаунт
        </button>
      </div>
    </div>
  );
}
