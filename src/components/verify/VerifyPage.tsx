/**
 * VerifyPage.tsx
 * Публична страница за верификация на подписан PDF.
 * Без login — достъпна директно от /verify.
 *
 * State machine:
 *   idle       → UploadZone
 *   verifying  → spinner + текущ етап
 *   done       → VerifyResult (Layer 1 + 2)
 *   fileerror  → in-page error banner + нов опит
 */
import { useState, useCallback } from 'react';
import { AlertTriangle, X, UploadCloud, ScanSearch, ShieldCheck, Lock } from 'lucide-react';
import { verifyDocument } from '../../lib/verify/verifyService';
import type { VerifyResult as VerifyResultData } from '../../lib/verify/types';
import UploadZone from './UploadZone';
import VerifyResult from './VerifyResult';
import Logo from '../common/Logo';

const MINI_STEPS: { icon: React.ReactNode; title: string; description: string }[] = [
  {
    icon: <UploadCloud size={18} />,
    title: 'Качете PDF-а',
    description: 'Файлът се обработва изцяло във вашия браузър.',
  },
  {
    icon: <ScanSearch size={18} />,
    title: 'Проверяваме подписа',
    description: 'ECDSA P-256 и ML-DSA-65 се верифицират криптографски.',
  },
  {
    icon: <ShieldCheck size={18} />,
    title: 'Виждате резултата',
    description: 'Автентичен, модифициран или неподписан — веднага.',
  },
];

// Етапи показвани по време на верификация (анимирани последователно)
const STAGES = [
  'Извличане на подписа…',
  'Верификация ECDSA P-256…',
  'Верификация ML-DSA-65…',
  'Проверка на целостта…',
  'Верификация на верига…',
];

type PageState =
  | { kind: 'idle' }
  | { kind: 'verifying'; stageName: string }
  | { kind: 'done';      result: VerifyResultData; fileName: string }
  | { kind: 'fileerror'; message: string };

interface Props {
  /** true (default) — показва SignShield branded header за standalone /verify URL. */
  standalone?: boolean;
}

/**
 * Страница за верификация на подписан PDF — качване (UploadZone), извикване на
 * verifyDocument (изцяло в браузъра, без upload към сървър) и показване на
 * резултата (VerifyResult). Използва се и вградена (таб "Провери") и standalone (/verify).
 */
export default function VerifyPage({ standalone = true }: Props) {
  const [state, setState] = useState<PageState>({ kind: 'idle' });

  /**
   * Чете избрания файл като байтове и извиква verifyDocument.
   * Анимацията на етапите (STAGES) е чисто визуална — тече паралелно на реалната
   * верификация чрез interval, не отразява точния прогрес на verifyService.
   */
  const handleFile = useCallback(async (file: File) => {
    // Стартираме верификацията и анимацията едновременно
    setState({ kind: 'verifying', stageName: STAGES[0] });

    let stageIdx = 0;
    const interval = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, STAGES.length - 1);
      setState(prev =>
        prev.kind === 'verifying'
          ? { kind: 'verifying', stageName: STAGES[stageIdx] }
          : prev,
      );
    }, 350);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await verifyDocument(bytes);
      clearInterval(interval);
      setState({ kind: 'done', result, fileName: file.name });
    } catch (err) {
      clearInterval(interval);
      console.error('[SignShield] verifyDocument threw:', err);
      setState({
        kind: 'fileerror',
        message: 'Неочаквана грешка при верификация. Опитайте отново или се свържете с администратора.',
      });
    }
  }, []);

  const handleError = useCallback((msg: string) => {
    setState({ kind: 'fileerror', message: msg });
  }, []);

  const reset = useCallback(() => setState({ kind: 'idle' }), []);

  return (
    <div className="min-h-screen">

      {/* Branded header — само за standalone /verify */}
      {standalone && (
        <header className="glass-panel rounded-none border-x-0 border-t-0 px-6 py-4">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <Logo size="sm" withLabel={false} />
            <div>
              <h1 className="text-base font-semibold text-neutral-900">SignShield</h1>
              <p className="text-xs text-neutral-500">Проверка на цифров подпис</p>
            </div>
          </div>
        </header>
      )}

      <main className="animate-fadeIn mx-auto max-w-2xl px-4 py-8">

        {/* ── idle ── */}
        {state.kind === 'idle' && (
          <div className="space-y-10">
            <div className="space-y-6">
              {!standalone && (
                <h2 className="text-lg font-semibold text-neutral-800">Провери подписан документ</h2>
              )}
              <UploadZone onFile={handleFile} onError={handleError} />
            </div>

            {/* Мини "как работи" */}
            <div className="grid gap-4 sm:grid-cols-3">
              {MINI_STEPS.map((step, i) => (
                <div
                  key={step.title}
                  className="animate-fadeInUp glass-panel rounded-2xl px-4 py-4 opacity-0"
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    {step.icon}
                  </div>
                  <p className="mt-2.5 text-sm font-medium text-neutral-800">{step.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{step.description}</p>
                </div>
              ))}
            </div>

            {/* Trust блок */}
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#211d5e] via-[#1e1b4b] to-[#151235] px-6 py-7 shadow-glassLg sm:px-8">
              <div aria-hidden="true" className="animate-floatSlow absolute -right-14 -top-16 h-56 w-56 rounded-full bg-indigo-500/25 blur-3xl" />
              <div className="relative flex items-start gap-3">
                <Lock size={20} className="mt-0.5 shrink-0 text-indigo-300" />
                <div>
                  <p className="text-sm font-medium text-indigo-100">Независима проверка, без доверие в нас</p>
                  <p className="mt-1 text-xs leading-relaxed text-indigo-300">
                    Верификацията става изцяло във вашия браузър — файлът не се изпраща никъде.
                    Всеки сертификат може да бъде проследен и потвърден независимо от издателя му.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── fileerror ── */}
        {state.kind === 'fileerror' && (
          <div className="space-y-4">
            <div className="animate-fadeInUp flex items-start gap-3 rounded-2xl border border-red-200/70 bg-red-50/80 p-5 shadow-sm backdrop-blur-sm">
              <AlertTriangle size={20} className="shrink-0 text-red-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800">{state.message}</p>
              </div>
              <button onClick={reset} className="shrink-0 text-red-400 hover:text-red-600">
                <X size={18} />
              </button>
            </div>
            <UploadZone onFile={handleFile} onError={handleError} />
          </div>
        )}

        {/* ── verifying ── */}
        {state.kind === 'verifying' && (
          <div className="glass-panel flex flex-col items-center gap-6 rounded-2xl py-16 text-center">
            {/* Spinner */}
            <div role="status" aria-label="Верифициране в процес" className="relative h-16 w-16">
              <div className="absolute inset-0 rounded-full border-4 border-neutral-200" aria-hidden="true" />
              <div className="absolute inset-0 rounded-full border-4 border-indigo-600 border-t-transparent animate-spin" aria-hidden="true" />
            </div>
            <div aria-live="polite" aria-atomic="true">
              <p className="text-base font-medium text-neutral-800">Верифициране…</p>
              <p className="mt-1 text-sm text-neutral-500">{state.stageName}</p>
            </div>
            {/* Mini progress steps */}
            <ol className="flex gap-2">
              {STAGES.map((s, i) => (
                <li
                  key={s}
                  className={`h-1.5 w-8 rounded-full transition-colors ${
                    STAGES.indexOf(state.stageName) >= i ? 'bg-indigo-500' : 'bg-neutral-200'
                  }`}
                  aria-label={s}
                />
              ))}
            </ol>
          </div>
        )}

        {/* ── done ── */}
        {state.kind === 'done' && (
          <VerifyResult
            result={state.result}
            fileName={state.fileName}
            onReset={reset}
          />
        )}
      </main>
    </div>
  );
}
