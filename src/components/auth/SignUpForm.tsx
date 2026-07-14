import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';

type Step = 'enter-email' | 'link-sent';

export default function SignUpForm() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>('enter-email');
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSendLink(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsBusy(true);

    // Supabase праща линк за потвърждение на email (Confirm signup темплейт), не код.
    // Кликвайки линка, потребителят се връща тук с реална (не анонимна) сесия —
    // App.tsx поема оттук нататък и показва стъпката за регистрация на passkey.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        data: { display_name: displayName },
        emailRedirectTo: window.location.origin,
      },
    });

    setIsBusy(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setStep('link-sent');
  }

  if (step === 'link-sent') {
    return (
      <div className="flex flex-col gap-3 text-sm text-neutral-600">
        <p>
          Пратихме линк за потвърждение на <span className="font-medium">{email}</span>.
        </p>
        <p>
          Провери пощата си (и папка Spam) и кликни на линка. Ще се върнеш автоматично тук, за
          да завършиш регистрацията с passkey.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSendLink} className="flex flex-col gap-4">
      <div>
        <label htmlFor="display-name" className="block text-sm font-medium text-neutral-700">
          Как да те наричаме?
        </label>
        <input
          id="display-name"
          type="text"
          required
          maxLength={50}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={isBusy}
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 focus:border-neutral-900 focus:outline-none"
          placeholder="напр. Иван"
        />
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={isBusy}
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 focus:border-neutral-900 focus:outline-none"
          placeholder="ti@example.com"
        />
      </div>

      <p className="text-xs text-neutral-500">
        Email-ът се ползва само за потвърждение в момента на регистрация. След това влизаш
        винаги само с passkey.
      </p>

      {errorMessage && <p role="alert" className="text-sm text-red-600">{errorMessage}</p>}

      <button
        type="submit"
        disabled={isBusy}
        className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {isBusy ? 'Пращаме линк...' : 'Изпрати линк за потвърждение'}
      </button>
    </form>
  );
}
