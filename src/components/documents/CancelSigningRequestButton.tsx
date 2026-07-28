/**
 * CancelSigningRequestButton.tsx
 * Бутон „Откажи" за активна multi-signer заявка (Ден 5, Фаза 8) — inline
 * confirmation dialog по модел на DocumentList soft-delete (не native confirm()).
 *
 * Показва се само за signing_requests в НЕ-финално състояние (owner решава
 * дали да покаже, филтрирано в DocumentList — този компонент не знае за
 * status, само изпълнява отмяната при потвърждение).
 *
 * Email известия до recipients за отмяна са Ден 7 — извън scope тук.
 */
import { useState } from 'react';
import { X, AlertTriangle, RefreshCw } from 'lucide-react';

interface CancelSigningRequestButtonProps {
  filename: string;
  onCancel: () => Promise<void>;
  /** Извиква се след успешна отмяна — родителят обновява DocumentList. */
  onCancelled: () => void;
}

export default function CancelSigningRequestButton({ filename, onCancel, onCancelled }: CancelSigningRequestButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
      setConfirming(false);
      onCancelled();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Грешка при отказ на заявката.');
    } finally {
      setCancelling(false);
    }
  };

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
      >
        Откажи
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-request-title"
        className="animate-scaleIn glass-panel w-full max-w-sm rounded-2xl p-6 shadow-glassLg"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle size={18} className="text-red-500" aria-hidden="true" />
            </div>
            <div>
              <h2 id="cancel-request-title" className="text-sm font-semibold text-neutral-800">
                Отказ от подписване?
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                Ще бъде отменено подписването на „{filename}". Recipients, които все още не са
                подписали, ще получат известие.
              </p>
            </div>
          </div>
          <button
            onClick={() => setConfirming(false)}
            aria-label="Затвори"
            className="shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-900/5"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>
        )}

        <div className="mt-4 flex gap-3">
          <button
            onClick={() => setConfirming(false)}
            className="flex-1 rounded-xl border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Върни
          </button>
          <button
            onClick={handleConfirm}
            disabled={cancelling}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-600 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelling && <RefreshCw size={13} className="animate-spin" aria-hidden="true" />}
            Откажи
          </button>
        </div>
      </div>
    </div>
  );
}
