/**
 * TechnicalDetails.tsx
 * Layer 2 — collapsible технически детайли след Layer 1 hero статуса.
 *
 * Секции:
 *   1. Класически подпис (ECDSA P-256)
 *   2. Пост-квантов подпис (ML-DSA-65)
 *   3. Цялост на документа (hash)
 *   4. Byte range
 */
import { useState } from 'react';
import {
  ChevronDown, ChevronRight,
  CheckCircle, XCircle, MinusCircle, Copy,
} from 'lucide-react';
import type { VerifyResult, SignatureStatus, CertChainStatus } from '../../lib/verify/types';
import CertificateModal from './CertificateModal';

interface Props {
  result: VerifyResult;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDateTime(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('bg-BG', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('bg-BG', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  }) + ' г.';
}

function StatusIcon({ status }: { status: SignatureStatus }) {
  if (status === 'valid')        return <CheckCircle size={14} className="text-green-600" />;
  if (status === 'invalid')      return <XCircle     size={14} className="text-red-600" />;
  return                                <MinusCircle size={14} className="text-neutral-400" />;
}

function CertStatusBadge({ status }: { status: CertChainStatus | null }) {
  if (!status) return null;
  const cfg = {
    ok:            { cls: 'bg-green-100 text-green-700',  text: 'Верига: доверена' },
    expired:       { cls: 'bg-yellow-100 text-yellow-700',text: 'Верига: сертификатът е изтекъл' },
    chain_invalid: { cls: 'bg-red-100 text-red-700',      text: 'Верига: непозната CA' },
  }[status];
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cfg.cls}`}>{cfg.text}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-neutral-200 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-50"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="px-4 pb-4 pt-1 text-xs text-neutral-600 space-y-2">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-32 shrink-0 text-neutral-400">{label}</span>
      <span className="flex items-center gap-1 break-all">{children}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TechnicalDetails({ result }: Props) {
  const [certModalOpen, setCertModalOpen] = useState(false);

  const { ecdsa, mlDsa, documentHash, byteRange } = result;

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <p className="border-b border-neutral-200 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Технически детайли
      </p>

      {/* 1. ECDSA */}
      <Section title="Класически подпис (ECDSA P-256)">
        {ecdsa ? (
          <>
            <Field label="Статус">
              <StatusIcon status={ecdsa.status} />
              {ecdsa.status === 'valid' ? 'Валиден' : 'Невалиден'}
            </Field>
            <Field label="Алгоритъм">ECDSA P-256 / SHA-256</Field>
            <Field label="Подписал">{ecdsa.signerName || '—'}</Field>
            <Field label="Дата">{fmtDateTime(ecdsa.signedAt)}</Field>
            <Field label="Издател">{ecdsa.certIssuer || '—'}</Field>
            <Field label="Cert изтича">{fmtDate(ecdsa.certExpiry)}</Field>
            <Field label="Верига">
              <CertStatusBadge status={ecdsa.certStatus} />
            </Field>
            {ecdsa.certDer && (
              <Field label="Сертификат">
                <button
                  onClick={() => setCertModalOpen(true)}
                  className="text-indigo-600 underline hover:text-indigo-800"
                >
                  Виж пълен сертификат
                </button>
              </Field>
            )}
            {ecdsa.errorMessage && (
              <Field label="Грешка"><span className="text-red-600">{ecdsa.errorMessage}</span></Field>
            )}
          </>
        ) : (
          <p className="text-neutral-400">Не е намерен ECDSA подпис.</p>
        )}
      </Section>

      {/* 2. ML-DSA */}
      <Section title="Пост-квантов подпис (ML-DSA-65)">
        {mlDsa ? (
          <>
            <Field label="Статус">
              <StatusIcon status={mlDsa.status} />
              {mlDsa.status === 'valid'       ? 'Валиден'
               : mlDsa.status === 'invalid'   ? 'Невалиден'
               : 'Не е приложен'}
            </Field>
            <Field label="Алгоритъм">ML-DSA-65 (FIPS 204)</Field>
            {mlDsa.status === 'not_included' && (
              <p className="text-neutral-400 italic">
                Документът е подписан без пост-квантова защита (стар формат).
                Класическият подпис е напълно валиден.
              </p>
            )}
            {mlDsa.errorMessage && (
              <Field label="Грешка"><span className="text-red-600">{mlDsa.errorMessage}</span></Field>
            )}
          </>
        ) : (
          <p className="text-neutral-400">Не е намерен ML-DSA подпис.</p>
        )}
      </Section>

      {/* 3. Цялост */}
      <Section title="Цялост на документа">
        {documentHash ? (
          <>
            <Field label="Алгоритъм">SHA-256</Field>
            <Field label="Хеш">
              <span className="font-mono">{documentHash.substring(0, 32)}…</span>
              <button
                title="Копирай пълния хеш"
                onClick={() => navigator.clipboard.writeText(documentHash)}
                className="ml-1 text-neutral-400 hover:text-indigo-600"
              >
                <Copy size={12} />
              </button>
            </Field>
          </>
        ) : (
          <p className="text-neutral-400">Хешът не е изчислен.</p>
        )}
      </Section>

      {/* 4. Byte range */}
      <Section title="Покрити байтове (byte range)">
        {byteRange ? (
          <>
            <Field label="Диапазон 1">[0 … {byteRange[1].toLocaleString('bg-BG')}]</Field>
            <Field label="Диапазон 2">[{byteRange[2].toLocaleString('bg-BG')} … {(byteRange[2] + byteRange[3]).toLocaleString('bg-BG')}]</Field>
            <Field label="Общо">
              {(byteRange[1] + byteRange[3]).toLocaleString('bg-BG')} байта подписани
            </Field>
          </>
        ) : (
          <p className="text-neutral-400">Не е намерен byte range.</p>
        )}
      </Section>

      {certModalOpen && ecdsa?.certDer && (
        <CertificateModal certDer={ecdsa.certDer} onClose={() => setCertModalOpen(false)} />
      )}
    </div>
  );
}
