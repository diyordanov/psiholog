import { useState } from 'react';
import { Fingerprint, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { logAuditEvent } from '../../lib/auditLog';
import Logo from '../common/Logo';

interface RegisterPasskeyStepProps {
  isNewUser: boolean;
  onDone: () => void;
}

/**
 * Финална стъпка от регистрацията — потребителят вече има потвърден email
 * (реална сесия), но все още няма passkey. Тук се извиква WebAuthn
 * ceremony-то за създаване на нов passkey и се логва завършването на
 * регистрацията. Ползва се и от recovery flow-а (isNewUser=false), където
 * потребителят вече е логнат, но старите му passkey-и са изтрити.
 */
export default function RegisterPasskeyStep({ isNewUser, onDone }: RegisterPasskeyStepProps) {
  const [status, setStatus] = useState<'idle' | 'registering' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Стартира WebAuthn "create credential" ceremony през Supabase.
   * registerPasskey() отваря системния диалог на браузъра (Face ID/Touch ID/
   * Windows Hello/security key), генерира keypair на устройството и
   * регистрира публичния ключ към текущата сесия. При успех записваме
   * audit event(и) — 'signup' само при първа регистрация, и винаги
   * 'new_passkey_registered' — и известяваме родителя (onDone), за да
   * премине към същинското приложение.
   */
  async function handleRegister() {
    setErrorMessage(null);
    setStatus('registering');

    const { error } = await supabase.auth.registerPasskey();

    if (error) {
      console.error('registerPasskey() грешка:', error);
      setErrorMessage(
        `Потвърждението с passkey не успя: ${error.message}. Натисни бутона пак, за да опиташ отново.`
      );
      setStatus('error');
      return;
    }

    // registerPasskey() не връща директно session обект, затова го дочитаме,
    // за да логнем audit събитията с коректен user id.
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      if (isNewUser) await logAuditEvent(data.session.user.id, 'signup');
      await logAuditEvent(data.session.user.id, 'new_passkey_registered');
    }
    onDone();
  }

  /** Позволява на потребителя да прекъсне регистрацията и да я довърши по-късно. */
  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="animate-scaleIn glass-panel w-full max-w-sm rounded-3xl px-8 py-10 text-center shadow-glassLg">
        <div className="flex justify-center">
          <Logo size="md" withLabel={false} />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-neutral-900">Последна стъпка</h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600">
          Email-ът е потвърден. Сега закачи passkey към профила си, за да можеш да влизаш без
          парола следващия път.
        </p>

        {status === 'registering' && (
          <p role="status" className="mt-4 text-sm text-neutral-600">
            Потвърди с биометрия или PIN на устройството си в прозореца, който се появи.
          </p>
        )}

        {errorMessage && <p role="alert" className="mt-4 text-sm text-red-600">{errorMessage}</p>}

        <button
          onClick={handleRegister}
          disabled={status === 'registering'}
          className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 text-sm font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,70,229,0.4)] transition-all hover:shadow-[0_6px_20px_-2px_rgba(79,70,229,0.5)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === 'registering' ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Очакваме потвърждение...
            </>
          ) : (
            <>
              <Fingerprint size={16} aria-hidden="true" />
              Регистрирай passkey
            </>
          )}
        </button>

        <button
          onClick={handleSignOut}
          className="mt-3 text-sm text-neutral-400 hover:text-neutral-700"
        >
          Изход (довърши по-късно)
        </button>
      </div>
    </div>
  );
}
