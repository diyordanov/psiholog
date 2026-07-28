/**
 * SigningRequestStatus.tsx
 * Показва статуса на multi-signer заявка (Ден 5, Фаза 8) — sub-section в
 * DocumentList за документи в State B ("awaiting_recipients"): owner е
 * подписал, чака се recipients.
 *
 * Layout:
 *   Status: Routing (1/3)   [Виж детайли ▼] [actions slot]
 *   [expanded:]
 *     ✅ Дима Йорданов (Собственик) — подписан 15.07.2026 10:30
 *     ⏳ ivan@example.com (Получател 1) — очаква подпис
 *     ⏳ maria@example.com (Получател 2) — очаква подпис
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, Clock } from 'lucide-react';
import type { SigningRequestWithRecipients } from '../../lib/types';

interface SigningRequestStatusProps {
  data: SigningRequestWithRecipients;
  ownerName: string;
  /** Слот за CancelSigningRequestButton (или друго действие) до "Виж детайли". */
  actions?: React.ReactNode;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' })
      + ', ' + new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/** Заглавен label за текущия статус на заявката. */
function statusLabel(status: SigningRequestWithRecipients['request']['status'], signed: number, total: number): string {
  switch (status) {
    case 'draft':               return 'Чернова';
    case 'owner_signing':       return 'Подписва се от собственика…';
    case 'awaiting_recipients': return `Routing (${signed}/${total})`;
    case 'completed':           return 'Завършено ✅';
    case 'cancelled':           return 'Отменено';
  }
}

export default function SigningRequestStatus({ data, ownerName, actions }: SigningRequestStatusProps) {
  const [expanded, setExpanded] = useState(false);
  const { request, recipients } = data;

  const total = 1 + recipients.length; // owner + recipients
  const signed = 1 + recipients.filter(r => r.status === 'signed').length; // owner вече е подписал по дефиниция

  return (
    <div className="mt-1.5 rounded-xl border border-neutral-200 bg-white/60 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-600">
          Статус: {statusLabel(request.status, signed, total)}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            Виж детайли
          </button>
          {actions}
        </div>
      </div>

      {expanded && (
        <ul className="mt-2 space-y-1.5 border-t border-neutral-100 pt-2">
          <li className="flex items-center gap-2 text-xs">
            <CheckCircle size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-neutral-700">
              {ownerName || 'Собственик'} <span className="text-neutral-400">(Собственик)</span>
            </span>
            <span className="shrink-0 text-neutral-400">подписан {fmtDate(request.owner_signed_at)}</span>
          </li>
          {recipients.map((r, i) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              {r.status === 'signed'
                ? <CheckCircle size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
                : <Clock size={13} className="shrink-0 text-amber-500" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate text-neutral-700">
                {r.invited_email} <span className="text-neutral-400">(Получател {i + 1})</span>
              </span>
              <span className="shrink-0 text-neutral-400">
                {r.status === 'signed' ? `подписан ${fmtDate(r.signed_at)}` : 'очаква подпис'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
