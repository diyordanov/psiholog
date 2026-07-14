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
import { ShieldCheck, AlertTriangle, X } from 'lucide-react';
import { verifyDocument } from '../../lib/verify/verifyService';
import type { VerifyResult as VerifyResultData } from '../../lib/verify/types';
import UploadZone from './UploadZone';
import VerifyResult from './VerifyResult';

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

export default function VerifyPage({ standalone = true }: Props) {
  const [state, setState] = useState<PageState>({ kind: 'idle' });

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
    <div className="min-h-screen bg-neutral-50">

      {/* Branded header — само за standalone /verify */}
      {standalone && (
        <header className="border-b border-neutral-200 bg-white px-6 py-4">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <ShieldCheck size={24} className="text-indigo-600" />
            <div>
              <h1 className="text-base font-semibold text-neutral-900">SignShield</h1>
              <p className="text-xs text-neutral-500">Проверка на цифров подпис</p>
            </div>
          </div>
        </header>
      )}

      <main className="mx-auto max-w-2xl px-4 py-8">

        {/* ── idle ── */}
        {state.kind === 'idle' && (
          <div className="space-y-6">
            {!standalone && (
              <h2 className="text-lg font-semibold text-neutral-800">Провери подписан документ</h2>
            )}
            <UploadZone onFile={handleFile} onError={handleError} />
          </div>
        )}

        {/* ── fileerror ── */}
        {state.kind === 'fileerror' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5">
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
          <div className="flex flex-col items-center gap-6 py-16 text-center">
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
