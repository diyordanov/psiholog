/**
 * TechnicalDetails.tsx
 * Layer 2 — collapsible технически детайли след Layer 1 hero статуса.
 *
 * Ден 3 (Фаза 8): генерализирано за N подписа — по един collapsible за
 * ВСЕКИ подписващ (ECDSA + ML-DSA + сертификат в самата секция), плюс две
 * общи секции накрая:
 *   Signer 1, Signer 2, … Signer N   (по един collapsible за подписващ)
 *   Цялост на документа (общо)
 *   Byte range (общо)
 */
import { useState } from 'react';
import {
  ChevronDown, ChevronRight,
  CheckCircle, XCircle, MinusCircle, Copy,
} from 'lucide-react';
import type { VerifyResult, SignatureStatus, CertChainStatus, SignerResult } from '../../lib/verify/types';
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

/** Роля по подразбиране за signerIndex — owner е първият подписал. */
function roleLabel(signerIndex: number): string {
  return signerIndex === 0 ? 'собственик' : `получател ${signerIndex}`;
}

/** Иконка според статуса на конкретния подпис (ECDSA или ML-DSA) — зелено/червено/сиво. */
function StatusIcon({ status }: { status: SignatureStatus }) {
  if (status === 'valid')        return <CheckCircle size={14} className="text-green-600" />;
  if (status === 'invalid')      return <XCircle     size={14} className="text-red-600" />;
  return                                <MinusCircle size={14} className="text-neutral-400" />;
}

/** Значка за статуса на веригата на доверие (сертификат → CA) — цветово кодирана по риск. */
function CertStatusBadge({ status }: { status: CertChainStatus | null }) {
  if (!status) return null;
  const cfg = {
    ok:            { cls: 'bg-green-100 text-green-700',  text: 'Верига: доверена' },
    expired:       { cls: 'bg-yellow-100 text-yellow-700',text: 'Верига: сертификатът е изтекъл' },
    chain_invalid: { cls: 'bg-red-100 text-red-700',      text: 'Верига: непозната CA' },
  }[status];
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cfg.cls}`}>{cfg.text}</span>;
}

function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = `section-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="border-b border-neutral-200/70 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-white/50"
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {title}
      </button>
      {open && <div id={contentId} className="px-4 pb-4 pt-1 text-xs text-neutral-600 space-y-2">{children}</div>}
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

/** Съдържанието на един signer collapsible: ECDSA + ML-DSA + сертификат. */
function SignerDetails({ signer, onShowCert }: { signer: SignerResult; onShowCert: () => void }) {
  const { ecdsa, mlDsa } = signer;
  return (
    <>
      <Field label="Статус">
        <StatusIcon status={ecdsa.status} />
        {ecdsa.status === 'valid' ? 'Валиден' : 'Невалиден'}
      </Field>
      <Field label="Алгоритъм">ECDSA P-256 / SHA-256</Field>
      <Field label="Роля">{roleLabel(signer.signerIndex)}</Field>
      <Field label="Дата">{fmtDateTime(ecdsa.signedAt)}</Field>
      <Field label="Издател">{ecdsa.certIssuer || '—'}</Field>
      <Field label="Cert изтича">{fmtDate(ecdsa.certExpiry)}</Field>
      <Field label="Верига">
        <CertStatusBadge status={ecdsa.certStatus} />
      </Field>
      {ecdsa.certDer && (
        <Field label="Сертификат">
          <button onClick={onShowCert} className="text-indigo-600 underline hover:text-indigo-800">
            Виж пълен сертификат
          </button>
        </Field>
      )}
      {ecdsa.errorMessage && (
        <Field label="Грешка"><span className="text-red-600">{ecdsa.errorMessage}</span></Field>
      )}

      <div className="mt-3 border-t border-neutral-200/70 pt-2">
        <Field label="ML-DSA-65">
          {mlDsa === null ? (
            <span className="text-neutral-400">Няма PQ слот за този подписващ</span>
          ) : (
            <>
              <StatusIcon status={mlDsa.status} />
              {mlDsa.status === 'valid'        ? 'Валиден'
               : mlDsa.status === 'invalid'    ? 'Невалиден'
               : 'Не е приложен'}
            </>
          )}
        </Field>
        {mlDsa?.errorMessage && mlDsa.status !== 'not_included' && (
          <Field label="PQ грешка"><span className="text-red-600">{mlDsa.errorMessage}</span></Field>
        )}
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Layer 2 на резултата от верификация — collapsible секции с техническите детайли
 * зад Layer 1 hero статуса (VerifyResult). Чисто презентационен компонент,
 * не извиква verifyService — само чете вече изчисления `result`.
 */
export default function TechnicalDetails({ result }: Props) {
  const [certModalIndex, setCertModalIndex] = useState<number | null>(null);
  const { signers, documentHash, byteRange } = result;
  const certSigner = certModalIndex !== null ? signers[certModalIndex] : undefined;

  return (
    <div className="glass-panel mt-4 overflow-hidden rounded-2xl">
      <p className="border-b border-neutral-200/70 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Технически детайли
      </p>

      {/* Един collapsible за всеки подписващ */}
      {signers.map((signer, i) => (
        <Section
          key={signer.signerIndex}
          title={`Подписващ ${i + 1} (${roleLabel(signer.signerIndex)}): ${signer.signerName || '—'}`}
          defaultOpen={signers.length === 1}
        >
          <SignerDetails signer={signer} onShowCert={() => setCertModalIndex(i)} />
        </Section>
      ))}

      {signers.length === 0 && (
        <Section title="Подпис">
          <p className="text-neutral-400">Не е намерен цифров подпис.</p>
        </Section>
      )}

      {/* Цялост на документа (общо за всички подписи) */}
      <Section title="Цялост на документа">
        {documentHash ? (
          <>
            <Field label="Алгоритъм">SHA-256</Field>
            <Field label="Хеш">
              <span className="font-mono">{documentHash.substring(0, 32)}…</span>
              <button
                aria-label="Копирай пълния хеш"
                onClick={() => navigator.clipboard.writeText(documentHash)}
                className="ml-1 text-neutral-400 hover:text-indigo-600"
              >
                <Copy size={12} aria-hidden="true" />
              </button>
            </Field>
          </>
        ) : (
          <p className="text-neutral-400">Хешът не е изчислен.</p>
        )}
      </Section>

      {/* Byte range (общо, последния /Sig — покрива целия файл) */}
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

      {certSigner?.ecdsa.certDer && (
        <CertificateModal certDer={certSigner.ecdsa.certDer} onClose={() => setCertModalIndex(null)} />
      )}
    </div>
  );
}
