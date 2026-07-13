import { useState } from 'react';
import { supabase } from '../../lib/supabase';

interface RecoveryFlowProps {
  onCancel: () => void;
}

// Recovery flow — само стъпка "въведи email":
// 1. Потребителят въвежда email
// 2. Изпращаме OTP линк с ?recovery=1 в redirect URL
// 3. След клик на линка App.tsx поема: изтрива старите passkey-и и показва RegisterPasskeyStep
export default function RecoveryFlow({ onCancel }: RecoveryFlowProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSendLink(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setStatus('sending');

    const redirectTo = `${window.location.origin}/?recovery=1`;

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: redirectTo,
      },
    });

    if (error) {
      // "shouldCreateUser: false" означава, че ако email-ът не съществува,
      // Supabase връща грешка. Показваме общо съобщение — не разкриваме дали
      // акаунтът съществува (security best practice).
      setErrorMessage(
        'Не можахме да изпратим линка. Провери email адреса и опитай пак.'
      );
      setStatus('error');
      return;
    }

    // user_id не е известен тук (не сме логнати) — recovery_otp_verified се логва в App.tsx
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-sm text-neutral-700">
          Изпратихме линк за възстановяване на <strong>{email}</strong>.
        </p>
        <p className="text-sm text-neutral-500">
          Кликни линка в имейла — след това ще можеш да регистрираш нов passkey.
          Всички стари passkey-и ще бъдат изтрити автоматично.
        </p>
        <button
          onClick={onCancel}
          className="mt-2 text-sm text-neutral-400 hover:text-neutral-700"
        >
          Назад към вход
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSendLink} className="flex flex-col gap-4">
      <div>
        <p className="mb-3 text-sm text-neutral-600">
          Въведи email адреса на акаунта си. Ще получиш линк за възстановяване —
          след клик старите passkey-и се изтриват и можеш да регистрираш нов.
        </p>
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          Email адрес
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="name@example.com"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
        />
      </div>

      {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

      <button
        type="submit"
        disabled={status === 'sending' || !email.trim()}
        className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {status === 'sending' ? 'Изпращаме линк...' : 'Изпрати линк за възстановяване'}
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-neutral-400 hover:text-neutral-700"
      >
        Назад към вход
      </button>
    </form>
  );
}
