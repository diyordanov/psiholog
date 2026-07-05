import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { logAuditEvent } from '../../lib/auditLog';

interface RegisterPasskeyStepProps {
  onDone: () => void;
}

export default function RegisterPasskeyStep({ onDone }: RegisterPasskeyStepProps) {
  const [status, setStatus] = useState<'idle' | 'registering' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

    const { data } = await supabase.auth.getSession();
    if (data.session) {
      await logAuditEvent(data.session.user.id, 'new_passkey_registered');
      // signup се логва само при първоначална регистрация (не при recovery)
      // — разграничаваме в App.tsx, тук логваме само регистрацията на passkey-а
    }
    onDone();
  }

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
        <p className="mt-4 text-sm text-neutral-600">
          Потвърди с биометрия или PIN на устройството си в прозореца, който се появи.
        </p>
      )}

      {errorMessage && <p className="mt-4 text-sm text-red-600">{errorMessage}</p>}

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
