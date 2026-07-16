/**
 * KeyCard.tsx
 * Единичен ред в списъка с ключове.
 * Показва: algorithm badge, cert status badge, thumbprint, дата, soft delete.
 *
 * certStatus визуализация:
 *   ok           → зелена точка (без текст, за да не претрупва UI)
 *   expiring-soon → amber badge "Сертификатът изтича скоро"
 *   expired       → червен badge "Сертификатът е изтекъл"
 *   missing       → amber badge "⚠ Липсва сертификат" (retrofit в ход или неуспешен)
 */
import { useState } from 'react';
import { KeyRound, Trash2, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { SigningKeyRow, CertStatus } from '../../lib/signingKeyStore';

interface KeyCardProps {
  signingKey: SigningKeyRow;
  onDelete: (id: string) => Promise<void>;
}

export default function KeyCard({ signingKey, onDelete }: KeyCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(signingKey.id);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex gap-3 px-4 py-3 transition-colors hover:bg-white/40">
      {/* Икона */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
        <KeyRound size={18} className="text-indigo-500" />
      </div>

      {/* Съдържание */}
      <div className="min-w-0 flex-1">
        {/* Ред 1: алгоритъм badge + cert status + thumbprint */}
        <div className="flex flex-wrap items-center gap-2">
          <AlgorithmBadge algorithm={signingKey.algorithm} />
          <CertStatusBadge status={signingKey.certStatus} expiresAt={signingKey.certificateExpiresAt} />
          <span className="font-mono text-xs text-neutral-500">{signingKey.thumbprint}</span>
        </div>

        {/* Ред 2: дата + действия */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs text-neutral-400">{formatDate(signingKey.created_at)}</span>

          {confirming ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
              >
                {deleting ? <RefreshCw size={11} className="animate-spin" /> : 'Потвърди изтриване'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:text-neutral-600"
              >
                Откажи
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="rounded-lg p-1 text-neutral-300 transition-colors hover:bg-red-50 hover:text-red-500"
              title="Изтрий ключ"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function AlgorithmBadge({ algorithm }: { algorithm: 'ed25519' | 'ml-dsa-65' | 'ecdsa-p256' }) {
  if (algorithm === 'ecdsa-p256') {
    return (
      <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
        ECDSA P-256
      </span>
    );
  }
  if (algorithm === 'ed25519') {
    return (
      <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-500">
        Ed25519 (legacy)
      </span>
    );
  }
  return (
    <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700">
      ML-DSA-65
    </span>
  );
}

function CertStatusBadge({ status, expiresAt }: { status: CertStatus; expiresAt: string | null }) {
  if (status === 'ok') {
    return (
      <span className="flex items-center gap-1 text-xs text-green-600" title={`Сертификат валиден до ${expiresAt ? formatDate(expiresAt) : ''}`}>
        <CheckCircle2 size={12} />
        <span className="hidden sm:inline">Сертификат</span>
      </span>
    );
  }

  if (status === 'expiring-soon') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        <AlertTriangle size={11} />
        Изтича скоро
      </span>
    );
  }

  if (status === 'expired') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        <AlertTriangle size={11} />
        Сертификатът е изтекъл
      </span>
    );
  }

  // missing
  return (
    <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      <AlertTriangle size={11} />
      Липсва сертификат
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
