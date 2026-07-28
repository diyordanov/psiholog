/**
 * PendingInvitationsPage.tsx
 * Recipient dashboard — 5-ти таб „Покани" (Ден 6). Показва всички покани на
 * текущия потребител по email (auto-claim се случва вътре в listMyInvitations()).
 */
import { useState, useEffect, useCallback } from 'react';
import { FileText, User, Inbox } from 'lucide-react';
import { listMyInvitations, isInvitationPending, type InvitationDetails } from '../../lib/signingRequestService';
import RecipientSigningModal from '../documents/RecipientSigningModal';

interface PendingInvitationsPageProps {
  userId: string;
  userEmail: string;
  onInvitationsChanged?: () => void; // за refresh на badge-а в главната навигация
}

export default function PendingInvitationsPage({ userId, userEmail, onInvitationsChanged }: PendingInvitationsPageProps) {
  const [invitations, setInvitations] = useState<InvitationDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingDetails, setSigningDetails] = useState<InvitationDetails | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listMyInvitations(userEmail)
      .then(setInvitations)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [userEmail]);

  useEffect(() => { load(); }, [load]);

  const pending = invitations.filter(isInvitationPending);

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-neutral-400">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-xl font-semibold text-neutral-800">Покани за подписване</h1>

      {pending.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-neutral-200 py-14 text-center">
          <Inbox size={32} className="text-neutral-300" />
          <p className="text-sm text-neutral-500">Нямате чакащи покани.</p>
        </div>
      )}

      <ul className="space-y-3">
        {pending.map((inv) => (
          <li key={inv.recipient.id} className="glass-panel rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2 text-sm text-neutral-800">
                  <User size={14} className="shrink-0 text-neutral-400" />
                  <span className="font-medium">{inv.ownerName}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-neutral-600">
                  <FileText size={14} className="shrink-0 text-neutral-400" />
                  <span className="truncate">{inv.documentFilename}</span>
                </div>
                <p className="text-xs text-neutral-400">
                  Поканени на {new Date(inv.recipient.invited_at).toLocaleDateString('bg-BG')}
                </p>
              </div>
              <button
                onClick={() => setSigningDetails(inv)}
                className="shrink-0 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2 text-sm font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,70,229,0.4)] transition-all hover:shadow-[0_6px_20px_-2px_rgba(79,70,229,0.5)] active:scale-[0.98]"
              >
                Подпиши
              </button>
            </div>
          </li>
        ))}
      </ul>

      {signingDetails && (
        <RecipientSigningModal
          details={signingDetails}
          userId={userId}
          onClose={() => setSigningDetails(null)}
          onDone={() => {
            setSigningDetails(null);
            load();
            onInvitationsChanged?.();
          }}
        />
      )}
    </div>
  );
}
