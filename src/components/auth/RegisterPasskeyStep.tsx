import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { logAuditEvent } from '../../lib/auditLog';

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
    <div className="mx-auto mt-24 max-w-sm px-6 text-center">
      <h2 className="text-lg font-semibold text-neutral-900">Последна стъпка</h2>
      <p className="mt-2 text-sm text-neutral-600">
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
        className="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {status === 'registering' ? 'Очакваме потвърждение...' : 'Регистрирай passkey'}
      </button>

      <button
        onClick={handleSignOut}
        className="mt-3 text-sm text-neutral-400 hover:text-neutral-700"
      >
        Изход (довърши по-късно)
      </button>
    </div>
  );
}
