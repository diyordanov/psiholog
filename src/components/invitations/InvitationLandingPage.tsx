/**
 * InvitationLandingPage.tsx
 * Публична страница за покана: /invite/:recipientId (Ден 6).
 *
 * State machine (виж PROGRESS.md Ден 6 за пълния план):
 *   not_logged_in         → generic съобщение + вграден <AuthScreen/> (без
 *                           redirect round-trip — след успешен login/signup
 *                           auth state-ът се обновява реактивно и страницата
 *                           автоматично преминава в следващото състояние).
 *   checking              → зареждаме claim + детайли.
 *   wrong_email           → email mismatch (RPC грешка съдържа "друг email").
 *   error                 → всичко друго (невалиден token, вече claim-нат от
 *                           друг акаунт) — показваме директно съобщението от
 *                           RPC-то (вече е ясно и на български).
 *   cancelled             → заявката е отменена от owner-а.
 *   details               → успешно claim-нат, показваме детайли + „Подпиши".
 */
import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, LogOut, FileText, User } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import Logo from '../common/Logo';
import AuthScreen from '../auth/AuthScreen';
import RecipientSigningModal from '../documents/RecipientSigningModal';
import { claimInvitation, getInvitationDetails, type InvitationDetails } from '../../lib/signingRequestService';

type LandingState = 'checking' | 'not_logged_in' | 'details' | 'wrong_email' | 'error' | 'cancelled';

interface InvitationLandingPageProps {
  recipientId: string;
}

export default function InvitationLandingPage({ recipientId }: InvitationLandingPageProps) {
  const { session, loading } = useAuth();
  const [state, setState] = useState<LandingState>('checking');
  const [errorMessage, setErrorMessage] = useState('');
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [signingOpen, setSigningOpen] = useState(false);

  useEffect(() => {
    if (loading) return;

    if (!session || session.user.is_anonymous) {
      setState('not_logged_in');
      return;
    }

    let cancelled = false;
    setState('checking');

    claimInvitation(recipientId)
      .then(() => getInvitationDetails(recipientId))
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setState(d.request.status === 'cancelled' ? 'cancelled' : 'details');
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        setState(msg.includes('друг email') ? 'wrong_email' : 'error');
      });

    return () => { cancelled = true; };
  }, [session, loading, recipientId]);

  if (loading || state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center text-neutral-400">
        Зареждане...
      </div>
    );
  }

  if (state === 'not_logged_in') {
    return (
      <div>
        <div className="mx-auto max-w-md px-4 pt-10 text-center sm:pt-16">
          <div className="mx-auto mb-4 flex justify-center"><Logo size="md" /></div>
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
            Поканени сте да подпишете документ. Влезте, за да продължите.
          </p>
        </div>
        <AuthScreen />
      </div>
    );
  }

  if (state === 'wrong_email') {
    return (
      <CenteredMessage
        icon={<XCircle className="text-red-500" size={40} />}
        title="Грешен акаунт"
        message="Тази покана е изпратена до друг email адрес."
      >
        <button
          onClick={() => supabase.auth.signOut()}
          className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <LogOut size={15} />
          Излез и влез с правилен акаунт
        </button>
      </CenteredMessage>
    );
  }

  if (state === 'cancelled') {
    return (
      <CenteredMessage
        icon={<XCircle className="text-neutral-400" size={40} />}
        title="Заявката е отменена"
        message="Тази заявка е отменена от собственика."
      />
    );
  }

  if (state === 'error') {
    return (
      <CenteredMessage
        icon={<XCircle className="text-red-500" size={40} />}
        title="Поканата не е намерена"
        message={errorMessage || 'Поканата не е намерена или е невалидна.'}
      />
    );
  }

  // state === 'details'
  if (!details) return null;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-scaleIn glass-panel w-full max-w-md rounded-2xl p-6 shadow-glassLg">
        <div className="mb-4 flex justify-center"><Logo size="md" /></div>

        <h1 className="mb-4 text-center text-lg font-semibold text-neutral-800">
          Покана за подписване
        </h1>

        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-4 py-3">
            <User size={18} className="shrink-0 text-neutral-400" />
            <div>
              <p className="text-xs text-neutral-500">Поканени сте от</p>
              <p className="text-sm font-medium text-neutral-800">{details.ownerName}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-4 py-3">
            <FileText size={18} className="shrink-0 text-neutral-400" />
            <div>
              <p className="text-xs text-neutral-500">Документ</p>
              <p className="truncate text-sm font-medium text-neutral-800">{details.documentFilename}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-4 py-3">
            <CheckCircle2 size={18} className="shrink-0 text-neutral-400" />
            <div>
              <p className="text-xs text-neutral-500">Позиция на подписа</p>
              <p className="text-sm font-medium text-neutral-800">
                Страница {details.recipient.marker_page + 1}
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => setSigningOpen(true)}
          className="mt-5 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 py-2.5 text-sm font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,70,229,0.4)] transition-all hover:shadow-[0_6px_20px_-2px_rgba(79,70,229,0.5)] active:scale-[0.98]"
        >
          Подпиши
        </button>
      </div>

      {signingOpen && session && (
        <RecipientSigningModal
          details={details}
          userId={session.user.id}
          onClose={() => setSigningOpen(false)}
          onDone={() => {
            setSigningOpen(false);
            getInvitationDetails(recipientId).then(setDetails);
          }}
        />
      )}
    </div>
  );
}

function CenteredMessage({
  icon, title, message, children,
}: { icon: React.ReactNode; title: string; message: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-scaleIn glass-panel w-full max-w-sm rounded-2xl p-6 text-center shadow-glassLg">
        <div className="mb-3 flex justify-center">{icon}</div>
        <h1 className="mb-2 text-base font-semibold text-neutral-800">{title}</h1>
        <p className="text-sm text-neutral-500">{message}</p>
        {children}
      </div>
    </div>
  );
}
