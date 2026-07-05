import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { logAuditEvent } from '../../lib/auditLog';

interface SignInFormProps {
  onStartRecovery: () => void;
}

export default function SignInForm({ onStartRecovery }: SignInFormProps) {
  const [status, setStatus] = useState<'idle' | 'signing-in' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSignIn() {
    setErrorMessage(null);
    setStatus('signing-in');

    const { data, error } = await supabase.auth.signInWithPasskey();

    if (error || !data.user) {
      setErrorMessage('Входът не успя. Провери дали имаш регистриран passkey на това устройство.');
      setStatus('error');
      return;
    }

    await logAuditEvent(data.user.id, 'login');
    setStatus('idle');
  }

  return (
    <div className="flex flex-col gap-4">
      {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
      <button
        onClick={handleSignIn}
        disabled={status === 'signing-in'}
        className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {status === 'signing-in' ? 'Влизаме...' : 'Влез с passkey'}
      </button>
      <button
        type="button"
        onClick={onStartRecovery}
        className="text-sm text-neutral-400 hover:text-neutral-700"
      >
        Забравих си passkey
      </button>
    </div>
  );
}
