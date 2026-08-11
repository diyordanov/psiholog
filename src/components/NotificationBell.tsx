import { useState, useRef, useEffect } from 'react';
import { Bell, CheckCircle, FileSignature, PartyPopper, Trash2, XCircle } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import type { NotificationRow } from '../lib/types';

const ICONS: Record<NotificationRow['type'], typeof Bell> = {
  owner_signed: FileSignature,
  recipient_signed: FileSignature,
  request_completed: PartyPopper,
  delete_requested: Trash2,
  delete_declined: XCircle,
};

/** Показва относително време ("преди 5 мин") за компактен нотификационен списък. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'току-що';
  if (mins < 60) return `преди ${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `преди ${hours} ч`;
  const days = Math.floor(hours / 24);
  return `преди ${days} д`;
}

/**
 * Bell икона с unread badge + dropdown списък нотификации (Ден 6 hotfix v4).
 * `enabled` спира заявките, докато потребителят не е логнат (виж App.tsx).
 */
export default function NotificationBell({ enabled }: { enabled: boolean }) {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications(enabled);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  if (!enabled) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Нотификации"
        className="relative rounded-lg p-2 text-neutral-500 transition-colors hover:bg-white/70 hover:text-neutral-900"
      >
        <Bell size={18} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-glassLg">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-neutral-800">Нотификации</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
                Маркирай всички
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-neutral-400">Нямате нотификации.</p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {notifications.map(n => {
                  const Icon = ICONS[n.type] ?? Bell;
                  const unread = !n.read_at;
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => unread && markRead(n.id)}
                        className={`flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${unread ? 'bg-indigo-50/50' : ''}`}
                      >
                        <Icon size={15} className={`mt-0.5 shrink-0 ${unread ? 'text-indigo-500' : 'text-neutral-300'}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-xs ${unread ? 'font-medium text-neutral-800' : 'text-neutral-500'}`}>{n.message}</span>
                          <span className="mt-0.5 block text-[10px] text-neutral-400">{relativeTime(n.created_at)}</span>
                        </span>
                        {unread && <CheckCircle size={13} className="mt-0.5 shrink-0 text-neutral-300" aria-hidden="true" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
