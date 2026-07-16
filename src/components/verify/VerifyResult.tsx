/**
 * VerifyResult.tsx
 * Layer 1: Hero статус (иконка + заглавие + ключови данни).
 * Layer 2: TechnicalDetails (collapsible секции).
 *
 * Цветова схема:
 *   green  → authentic + cert ok
 *   yellow → authentic + cert expired
 *   red    → tampered | invalid | error
 *   neutral→ unsigned
 */
import { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Info, RotateCcw, Download, Loader2 } from 'lucide-react';
import type { VerifyResult as VResult } from '../../lib/verify/types';
import TechnicalDetails from './TechnicalDetails';
import { generateVerificationReport, reportFileName } from '../../lib/verify/reportGenerator';

interface Props {
  result: VResult;
  fileName: string;
  onReset: () => void;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

type DisplayKind = 'green' | 'yellow' | 'red' | 'neutral';

/**
 * Извежда цвета на Layer 1 банера от overall резултата и статуса на сертификатната
 * верига. authentic + изтекъл сертификат е отделен случай (yellow) — подписът
 * все още е математически валиден, но доверието в сертификата е под въпрос.
 */
function getKind(r: VResult): DisplayKind {
  if (r.overall === 'unsigned') return 'neutral';
  if (r.overall === 'error' || r.overall === 'tampered' || r.overall === 'invalid') return 'red';
  // authentic
  if (r.ecdsa?.certStatus === 'expired') return 'yellow';
  return 'green';
}

const KIND_CFG: Record<DisplayKind, {
  banner: string; iconColor: string; Icon: React.ElementType;
}> = {
  green:   { banner: 'bg-green-50 border-green-200',  iconColor: 'text-green-600',  Icon: CheckCircle },
  yellow:  { banner: 'bg-yellow-50 border-yellow-200',iconColor: 'text-yellow-600', Icon: AlertTriangle },
  red:     { banner: 'bg-red-50 border-red-200',      iconColor: 'text-red-600',    Icon: XCircle },
  neutral: { banner: 'bg-neutral-50 border-neutral-200',iconColor:'text-neutral-500',Icon: Info },
};

/** Заглавие на Layer 1 банера — текстовото обяснение, съответстващо на getKind. */
function getHeading(r: VResult): string {
  switch (r.overall) {
    case 'authentic':
      return r.ecdsa?.certStatus === 'expired'
        ? 'Документът е автентичен — сертификатът е изтекъл'
        : 'Документът е автентичен и непроменен';
    case 'tampered':  return 'Документът е модифициран след подписване';
    case 'invalid':
      return r.ecdsa?.certStatus === 'chain_invalid'
        ? 'Подписът е от неизвестен издател'
        : 'Подписът е невалиден';
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

  const showReport = result.overall === 'authentic' || result.overall === 'tampered' || result.overall === 'invalid';

  return (
    <div className="space-y-4">

      {/* ── Layer 1: Hero banner ── */}
      <div className={`rounded-xl border p-6 ${banner}`}>
        <div className="flex items-start gap-4">
          <Icon size={36} className={`shrink-0 ${iconColor}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-neutral-500 truncate" title={fileName}>{fileName}</p>
            <h2 className="mt-1 text-lg font-semibold text-neutral-900">{heading}</h2>

            {/* PQ не е приложен — само информация, не warning */}
            {result.overall === 'authentic' && result.mlDsa?.status === 'not_included' && (
              <p className="mt-1 text-sm text-neutral-600">
                Пост-квантов подпис: не е приложен (стар документ)
              </p>
            )}

            {/* Основни данни */}
            {result.ecdsa && (
              <dl className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2 text-sm">
                {result.ecdsa.signerName && (
                  <div>
                    <dt className="inline text-neutral-500">Подписал: </dt>
                    <dd className="inline font-medium text-neutral-800">{result.ecdsa.signerName}</dd>
                  </div>
                )}
                {result.ecdsa.signedAt && (
                  <div>
                    <dt className="inline text-neutral-500">Дата: </dt>
                    <dd className="inline font-medium text-neutral-800">
                      {fmtDateTime(result.ecdsa.signedAt)}
                    </dd>
                  </div>
                )}
              </dl>
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
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-medium text-white hover:bg-indigo-700 active:scale-95 transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
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
          className="flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-5 py-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50 active:scale-95 transition-transform"
        >
          <RotateCcw size={15} aria-hidden="true" />
          Провери друг документ
        </button>
      </div>
    </div>
  );
}
