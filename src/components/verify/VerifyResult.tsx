/**
 * VerifyResult.tsx
 * Layer 1: Hero статус (иконка + заглавие + списък подписващи).
 * Layer 2: TechnicalDetails (collapsible секции, по един за всеки подписващ).
 *
 * Ден 3 (Фаза 8): генерализирано за N подписа — Layer 1 показва броя
 * подписващи ("Подписан от 2 лица") + списък с име/дата/статус за всеки.
 *
 * Цветова схема:
 *   green  → authentic
 *   yellow → authentic_with_warnings (изтекъл cert или "смесена" PQ защита)
 *   red    → tampered | invalid | error
 *   neutral→ unsigned
 */
import { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Info, RotateCcw, Download, Loader2 } from 'lucide-react';
import type { VerifyResult as VResult, SignerResult } from '../../lib/verify/types';
import TechnicalDetails from './TechnicalDetails';
import { generateVerificationReport, reportFileName } from '../../lib/verify/reportGenerator';

interface Props {
  result: VResult;
  fileName: string;
  onReset: () => void;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

type DisplayKind = 'green' | 'yellow' | 'red' | 'neutral';

function getKind(r: VResult): DisplayKind {
  if (r.overall === 'unsigned') return 'neutral';
  if (r.overall === 'error' || r.overall === 'tampered' || r.overall === 'invalid') return 'red';
  if (r.overall === 'authentic_with_warnings') return 'yellow';
  return 'green';
}

const KIND_CFG: Record<DisplayKind, {
  banner: string; iconColor: string; Icon: React.ElementType;
}> = {
  green:   { banner: 'bg-green-50/80 border-green-200/70',   iconColor: 'text-green-600',  Icon: CheckCircle },
  yellow:  { banner: 'bg-yellow-50/80 border-yellow-200/70', iconColor: 'text-yellow-600', Icon: AlertTriangle },
  red:     { banner: 'bg-red-50/80 border-red-200/70',       iconColor: 'text-red-600',    Icon: XCircle },
  neutral: { banner: 'bg-neutral-50/80 border-neutral-200/70', iconColor:'text-neutral-500', Icon: Info },
};

/** Заглавие на Layer 1 банера — текстовото обяснение, съответстващо на getKind. */
function getHeading(r: VResult): string {
  switch (r.overall) {
    case 'authentic':                return 'Документът е автентичен и непроменен';
    case 'authentic_with_warnings':  return 'Документът е автентичен — с предупреждения';
    case 'tampered':                 return 'Документът е модифициран след подписване';
    case 'invalid': {
      const anyChainInvalid = r.signers.some(s => s.ecdsa.certStatus === 'chain_invalid');
      return anyChainInvalid ? 'Подписът е от неизвестен издател' : 'Подписът е невалиден';
    }
    case 'unsigned':  return 'Документът не съдържа цифров подпис';
    case 'error':     return 'Грешка при верификация';
  }
}

function fmtDateTime(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('bg-BG', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

/** Роля по подразбиране за signerIndex — owner е първият подписал. */
function roleLabel(signerIndex: number): string {
  return signerIndex === 0 ? 'собственик' : `получател ${signerIndex}`;
}

/** Малка иконка + текст статус за един подписващ в списъка на Layer 1. */
function SignerRow({ signer }: { signer: SignerResult }) {
  const ok = signer.ecdsa.status === 'valid';
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle size={14} className="shrink-0 text-green-600" aria-hidden="true" />
          : <XCircle size={14} className="shrink-0 text-red-600" aria-hidden="true" />}
      <span className="font-medium text-neutral-800">{signer.signerName || '—'}</span>
      <span className="text-neutral-400">({roleLabel(signer.signerIndex)})</span>
      {signer.signedAt && <span className="text-neutral-500">— {fmtDateTime(signer.signedAt)}</span>}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Показва резултата от verifyDocument — Layer 1 hero статус + Layer 2 технически
 * детайли (TechnicalDetails) + бутон за верификационен PDF доклад.
 */
export default function VerifyResult({ result, fileName, onReset }: Props) {
  const kind = getKind(result);
  const { banner, iconColor, Icon } = KIND_CFG[kind];
  const heading = getHeading(result);
  const [downloading, setDownloading] = useState(false);

  /** Генерира верификационен PDF доклад (reportGenerator) и го отваря в нов таб. */
  async function handleOpenReport() {
    setDownloading(true);
    // Отваряме нов таб СИНХРОННО (преди await) — popup blocker блокира window.open
    // извикан след await защото браузърът губи контекста на потребителския жест.
    const tab = window.open('', '_blank');
    try {
      const bytes = await generateVerificationReport(result, fileName);
      const blob = new Blob([bytes as unknown as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      const url  = URL.createObjectURL(blob);
      if (tab) {
        tab.location.href = url;
        // Отменяме URL след 60 сек — достатъчно за зареждане в новия таб
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // Popup блокиран — fallback към download
        const a = document.createElement('a');
        a.href = url;
        a.download = reportFileName(fileName);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 150);
      }
    } catch (e) {
      tab?.close();
      throw e;
    } finally {
      setDownloading(false);
    }
  }

  const showReport = result.overall === 'authentic' || result.overall === 'authentic_with_warnings'
    || result.overall === 'tampered' || result.overall === 'invalid';

  // Информационен текст за липсващ PQ — само ако НИКОЙ подписващ няма ML-DSA
  // (uniform отсъствие, не warning-worthy несъответствие между подписите).
  const noSignerHasPq = result.signers.length > 0
    && result.signers.every(s => s.mlDsa === null || s.mlDsa.status === 'not_included');

  return (
    <div className="animate-fadeInUp space-y-4">

      {/* ── Layer 1: Hero banner ── */}
      <div className={`rounded-2xl border p-6 shadow-sm backdrop-blur-xl ${banner}`}>
        <div className="flex items-start gap-4">
          <Icon size={36} className={`shrink-0 ${iconColor}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-neutral-500 truncate" title={fileName}>{fileName}</p>
            <h2 className="mt-1 text-lg font-semibold text-neutral-900">{heading}</h2>

            {result.totalSigners > 0 && (
              <p className="mt-1 text-sm text-neutral-600">
                {result.totalSigners === 1 ? 'Подписан от 1 лице' : `Подписан от ${result.totalSigners} лица`}
              </p>
            )}

            {/* PQ не е приложен изобщо — само информация, не warning */}
            {result.overall === 'authentic' && noSignerHasPq && (
              <p className="mt-1 text-sm text-neutral-600">
                Пост-квантов подпис: не е приложен (стар документ)
              </p>
            )}

            {/* Списък подписващи */}
            {result.signers.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {result.signers.map(s => <SignerRow key={s.signerIndex} signer={s} />)}
              </div>
            )}

            {/* Съобщения при грешка/unsigned */}
            {result.errorMessage && (
              <p className="mt-2 text-sm text-red-700">{result.errorMessage}</p>
            )}
            {result.overall === 'unsigned' && (
              <p className="mt-2 text-sm text-neutral-600">
                Искате ли да подпишете документ?{' '}
                <a href="/" className="underline text-indigo-600 hover:text-indigo-800">
                  Влезте в приложението
                </a>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Layer 2: Технически детайли ── */}
      {result.overall !== 'error' && result.overall !== 'unsigned' && (
        <TechnicalDetails result={result} />
      )}

      {/* ── Свали верификационен доклад ── */}
      {showReport && (
        <div className="flex justify-center">
          <button
            onClick={handleOpenReport}
            disabled={downloading}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,70,229,0.4)] transition-all hover:shadow-[0_6px_20px_-2px_rgba(79,70,229,0.5)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {downloading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
            Виж верификационен доклад
          </button>
        </div>
      )}

      {/* ── Провери друг документ ── */}
      <div className="flex justify-center pt-2">
        <button
          onClick={onReset}
          className="flex items-center gap-2 rounded-xl border border-neutral-300 bg-white/70 px-5 py-3 text-sm font-medium text-neutral-700 backdrop-blur-sm transition-all hover:bg-white active:scale-95"
        >
          <RotateCcw size={15} aria-hidden="true" />
          Провери друг документ
        </button>
      </div>
    </div>
  );
}
