/**
 * SignDocumentModal.tsx
 * 3-стъпков модал за хибридно PDF подписване (ECDSA P-256 + ML-DSA-65).
 *
 * Стъпки:
 *   1. Позиция — PDF thumbnail с клик-за-маркер + page navigation
 *   2. Потвърждение — преглед на ключове/предупреждения преди биометрия
 *   3. Прогрес → Готово / Грешка
 *
 * Координатно преобразуване: clickToMarkerPos() е pure function (тествана отделно).
 * PDF Y-ос е от долу нагоре — обратно на CSS (от горе надолу).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Fingerprint, AlertTriangle, CheckCircle, Download, RefreshCw, MapPin } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { supabase } from '../../lib/supabase';
import { signDocument, resolveSigningKeys, getSignedDownloadUrl, type SignDocumentResult, type ResolvedKeys } from '../../lib/signingService';
import { browserPrfExtractor, browserDualPrfExtractor } from '../../lib/crypto/keyProtection';
import type { PrfResult, DualPrfResult, PrfExtractor, DualPrfExtractor } from '../../lib/crypto/keyProtection';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Типове ──────────────────────────────────────────────────────────────────

export interface MarkerPos {
  page: number;   // 0-indexed
  x: number;      // PDF points от ляво
  y: number;      // PDF points от долу
}

type ModalStage = 'position' | 'confirm' | 'signing' | 'done' | 'error';

interface SignDocumentModalProps {
  documentId: string;
  storagePath: string;
  filename: string;
  userId: string;
  onDone: () => void;   // затваря + refresh на списъка
  onClose: () => void;  // откажи
}

// ─── Pure helpers (тествани в signing.test.ts) ───────────────────────────────

/**
 * Преобразува клик-координати в PDF точки.
 * PDF Y-ос е от долу нагоре — обратно на CSS.
 */
export function clickToMarkerPos(
  clickX: number, clickY: number,
  containerW: number, containerH: number,
  pageWidthPt: number, pageHeightPt: number,
): { x: number; y: number } {
  return {
    x: Math.round((clickX / containerW) * pageWidthPt),
    y: Math.round((1 - clickY / containerH) * pageHeightPt),
  };
}

/** Позиция по подразбиране: долу вляво, 30pt от ръба (стандартно нотариално място). */
export const DEFAULT_MARKER: MarkerPos = { page: 0, x: 30, y: 30 };

// ─── Thumbnail cache (session-level) ─────────────────────────────────────────

const thumbCache = new Map<string, string>(); // `${docId}:${page}` → JPEG data URL

// ─── Hook: зарежда PDF + рендира thumbnail за текущата страница ───────────────

interface ThumbnailState {
  dataUrl: string | null;
  widthPt: number;
  heightPt: number;
  numPages: number;
  loading: boolean;
  error: string | null;
}

/**
 * Зарежда PDF документа веднъж (по signedUrl) и рендира JPEG thumbnail за текущата
 * страница при нужда. Резултатите се кешират в module-level thumbCache по "docId:page",
 * за да не се рендира наново при връщане на вече видяна страница в рамките на сесията.
 */
function usePdfThumbnail(signedUrl: string | null, docId: string, page: number): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>({
    dataUrl: null, widthPt: 595, heightPt: 842, numPages: 1, loading: true, error: null,
  });
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const numPagesRef = useRef(1);

  // Зареждаме PDF документа веднъж при mount
  useEffect(() => {
    if (!signedUrl) return;
    let cancelled = false;

    const task = pdfjsLib.getDocument(
      { url: signedUrl, withCredentials: false } as Parameters<typeof pdfjsLib.getDocument>[0]
    );

    task.promise
      .then(async (doc) => {
        if (cancelled) { (doc as unknown as { destroy(): void }).destroy(); return; }
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        pdfRef.current = doc;
        numPagesRef.current = doc.numPages;
        if (!cancelled) {
          setState(prev => ({
            ...prev,
            widthPt: vp.width,
            heightPt: vp.height,
            numPages: doc.numPages,
          }));
        }
      })
      .catch((e) => {
        if (!cancelled) setState(prev => ({
          ...prev, loading: false,
          error: e instanceof Error ? e.message : 'Грешка при зареждане на PDF.',
        }));
      });

    return () => { cancelled = true; task.destroy(); };
  }, [signedUrl]);

  // Рендираме thumbnail при смяна на страница или след зареждане на PDF
  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf) return;

    let cancelled = false;
    const cacheKey = `${docId}:${page}`;

    // Cache hit → незабавно
    const cached = thumbCache.get(cacheKey);
    if (cached) {
      setState(prev => ({ ...prev, dataUrl: cached, loading: false, error: null }));
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    const THUMB_W = 300;
    pdf.getPage(page + 1).then(async (pdfPage) => {
      if (cancelled) return;
      const nat = pdfPage.getViewport({ scale: 1 });
      const scale = THUMB_W / nat.width;
      const vp = pdfPage.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d')!;

      const task = pdfPage.render({
        canvasContext: ctx,
        viewport: vp,
      } as Parameters<typeof pdfPage.render>[0]);

      await task.promise;

      if (cancelled) return;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      thumbCache.set(cacheKey, dataUrl);

      setState(prev => ({
        ...prev,
        dataUrl,
        widthPt: nat.width,
        heightPt: nat.height,
        numPages: numPagesRef.current,
        loading: false,
        error: null,
      }));
    }).catch((e) => {
      if (!cancelled && e?.name !== 'RenderingCancelledException') {
        setState(prev => ({
          ...prev, loading: false,
          error: e instanceof Error ? e.message : 'Грешка при рендиране.',
        }));
      }
    });

    return () => { cancelled = true; };
  }, [docId, page, pdfRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

// ─── StepPosition ────────────────────────────────────────────────────────────

interface StepPositionProps {
  signedUrl: string | null;
  docId: string;
  marker: MarkerPos | null;
  onMarkerChange: (m: MarkerPos) => void;
  onNext: () => void;
  onClose: () => void;
}

/** Стъпка 1: избор на страница + клик върху thumbnail за поставяне на маркера на подписа. */
function StepPosition({ signedUrl, docId, marker, onMarkerChange, onNext, onClose }: StepPositionProps) {
  const [currentPage, setCurrentPage] = useState(marker?.page ?? 0);
  const [jumpInput, setJumpInput] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  const { dataUrl, widthPt, heightPt, numPages, loading, error } = usePdfThumbnail(signedUrl, docId, currentPage);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = clickToMarkerPos(
      e.clientX - rect.left, e.clientY - rect.top,
      rect.width, rect.height,
      widthPt, heightPt,
    );
    onMarkerChange({ page: currentPage, ...pos });
  };

  const handleJump = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(jumpInput, 10);
    if (!isNaN(n) && n >= 1 && n <= numPages) {
      const newPage = n - 1;
      setCurrentPage(newPage);
      setJumpInput('');
    }
  };

  const handleDefaultPos = () => {
    setCurrentPage(0);
    onMarkerChange(DEFAULT_MARKER);
  };

  // Маркер е видим ако е на текущата страница
  const markerOnPage = marker?.page === currentPage ? marker : null;

  // Page selector: показваме макс. 3 бутона + jump input ако > 3 страници
  const pageButtons = Math.min(numPages, 3);

  return (
    <div>
      <ModalHeader step={1} title="Позиция на подписа" onClose={onClose} />

      <div className="px-6 py-4 space-y-4">
        {/* Page selector */}
        {numPages > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500 shrink-0">Страница:</span>
            {Array.from({ length: pageButtons }, (_, i) => (
              <button
                key={i}
                onClick={() => setCurrentPage(i)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  currentPage === i
                    ? 'bg-indigo-600 text-white'
                    : 'border border-neutral-200 text-neutral-600 hover:border-indigo-300 hover:text-indigo-600'
                }`}
              >
                {i + 1}
              </button>
            ))}
            {numPages > 3 && (
              <form onSubmit={handleJump} className="flex items-center gap-1.5">
                <span className="text-xs text-neutral-400">или</span>
                <input
                  type="number"
                  min={1}
                  max={numPages}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  placeholder="страница"
                  className="w-20 rounded-lg border border-neutral-200 px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:border-indigo-300 hover:text-indigo-600"
                >
                  Отиди
                </button>
              </form>
            )}
          </div>
        )}

        {/* Thumbnail + overlay */}
        <div>
          <p className="mb-2 text-xs text-neutral-500">
            Кликнете за да поставите подписа. Текуща страница: {currentPage + 1}/{numPages}
          </p>
          <div className="relative mx-auto overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50" style={{ width: 300 }}>
            {loading && (
              <div className="flex h-48 items-center justify-center text-neutral-400">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              </div>
            )}
            {error && !loading && (
              <div className="flex h-48 items-center justify-center px-4 text-center text-xs text-red-500">
                {error}
              </div>
            )}
            {dataUrl && !loading && (
              <>
                <img src={dataUrl} alt={`Страница ${currentPage + 1}`} className="block w-full" draggable={false} />
                {/* Click overlay */}
                <div
                  ref={overlayRef}
                  className="absolute inset-0 cursor-crosshair"
                  onClick={handleClick}
                />
                {/* Marker dot */}
                {markerOnPage && (
                  <div
                    className="absolute h-4 w-4 rounded-full border-2 border-white bg-indigo-600 shadow-md pointer-events-none"
                    style={{
                      left: `${(markerOnPage.x / widthPt) * 100}%`,
                      top: `${(1 - markerOnPage.y / heightPt) * 100}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                )}
              </>
            )}
          </div>

          {/* Позиция по подразбиране */}
          <button
            onClick={handleDefaultPos}
            className="mt-2 flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800"
          >
            <MapPin size={12} />
            Позиция по подразбиране (долу вляво)
          </button>
        </div>

        {/* Потвърждение за избраната позиция */}
        {marker ? (
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            Подпис: страница {marker.page + 1}, X={marker.x} pt, Y={marker.y} pt
          </p>
        ) : (
          <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            Кликнете върху документа за да поставите подписа.
          </p>
        )}
      </div>

      <ModalFooter
        onBack={onClose}
        backLabel="Откажи"
        onNext={onNext}
        nextLabel="Напред →"
        nextDisabled={!marker}
      />
    </div>
  );
}

// ─── StepConfirm ─────────────────────────────────────────────────────────────

interface StepConfirmProps {
  marker: MarkerPos;
  preflightKeys: ResolvedKeys | null;
  preflightError: string | null;
  signerName: string;
  onBack: () => void;
  onSign: () => void;
}

/** Стъпка 2: обобщение на избраните ключове/алгоритми и preflight грешки преди биометрията. */
function StepConfirm({ marker, preflightKeys, preflightError, signerName, onBack, onSign }: StepConfirmProps) {
  const hasNoCert = preflightKeys !== null && preflightKeys.ecdsaData.certificateDer == null;
  const hasMlDsa = preflightKeys?.mlDsaData != null;
  const blocked = !!preflightError || hasNoCert;

  return (
    <div>
      <ModalHeader step={2} title="Потвърждение" onClose={onBack} />

      <div className="px-6 py-4 space-y-4">
        {/* Позиция */}
        <InfoRow label="Позиция" value={`Страница ${marker.page + 1}, X=${marker.x} pt, Y=${marker.y} pt`} />
        {signerName && <InfoRow label="Подписващ" value={signerName} />}

        {/* Ключове */}
        {preflightKeys && (
          <InfoRow
            label="Алгоритми"
            value={hasMlDsa ? 'ECDSA P-256 + ML-DSA-65 (хибриден)' : 'ECDSA P-256 (само класически)'}
          />
        )}
        {preflightKeys && (
          <InfoRow
            label="PRF ceremony"
            value={preflightKeys.singlePrf ? 'Един биометричен tap' : hasMlDsa ? 'Два биометрични tapа' : 'Един биометричен tap'}
          />
        )}

        {/* Warning: без ML-DSA-65 */}
        {preflightKeys && !hasMlDsa && (
          <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-xs text-amber-700">
              Квантовата защита не е активна — нямате ML-DSA-65 ключ.
              Подписът ще съдържа само ECDSA P-256. Генерирайте ML-DSA-65 ключ в „Ключове" за пълна защита.
            </p>
          </div>
        )}

        {/* Blocker: грешка при preflight */}
        {preflightError && (
          <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{preflightError}</p>
          </div>
        )}

        {/* Blocker: без сертификат */}
        {hasNoCert && (
          <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">
              ECDSA ключът няма сертификат. Отидете в „Ключове" → „Издай сертификат".
            </p>
          </div>
        )}

        {/* Loading: preflight в процес */}
        {!preflightKeys && !preflightError && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
            Проверка на ключовете…
          </div>
        )}

        {/* Passkey info */}
        {!blocked && (
          <div className="flex gap-2 rounded-lg bg-indigo-50 px-3 py-2.5">
            <Fingerprint size={14} className="mt-0.5 shrink-0 text-indigo-500" />
            <p className="text-xs text-indigo-700">
              Браузърът ще поиска биометрично потвърждение (Face ID / Windows Hello / PIN) след натискане на „Подпиши".
            </p>
          </div>
        )}
      </div>

      <ModalFooter
        onBack={onBack}
        backLabel="← Назад"
        onNext={onSign}
        nextLabel="Подпиши"
        nextDisabled={blocked || (!preflightKeys && !preflightError)}
        nextClassName={blocked ? undefined : 'bg-indigo-600 hover:bg-indigo-700 text-white'}
      />
    </div>
  );
}

// ─── StepSigning ─────────────────────────────────────────────────────────────

interface StepSigningProps {
  progress: number;
  progressLabel: string;
  error: string | null;
  result: SignDocumentResult | null;
  onRetry: () => void;
  onDownload: () => void;
  onDone: () => void;
  downloadLoading: boolean;
}

const SIGNING_STEPS: [number, string][] = [
  [5,  'Проверка на документа'],
  [15, 'Намиране на ключове'],
  [35, 'Биометрична верификация'],
  [55, 'Подписване ECDSA P-256'],
  [70, 'Подписване ML-DSA-65'],
  [85, 'Качване на документа'],
  [100,'Завършено'],
];

/** Стъпка 3: прогрес бар с фиксирани чекпойнти (SIGNING_STEPS) + краен резултат/грешка. */
function StepSigning({ progress, progressLabel, error, result, onRetry, onDownload, onDone, downloadLoading }: StepSigningProps) {
  const isDone = result !== null;

  return (
    <div>
      <ModalHeader step={3} title={isDone ? 'Документът е подписан' : error ? 'Грешка' : 'Подписване...'} />

      <div className="px-6 py-5 space-y-5">
        {/* Progress bar */}
        {!error && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500">
              <span>{progressLabel}</span>
              <span>{progress}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={progressLabel || 'Подписване в процес'}
              className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
            >
              <div
                className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Steps list */}
        {!error && (
          <ol className="space-y-2">
            {SIGNING_STEPS.map(([pct, label]) => {
              const done = progress >= pct;
              const active = !isDone && progressLabel.startsWith(label.split(' ')[0]) && progress < pct + 20;
              return (
                <li key={pct} className={`flex items-center gap-2.5 text-xs ${
                  done ? 'text-neutral-700' : 'text-neutral-400'
                }`}>
                  {done ? (
                    <CheckCircle size={13} className="shrink-0 text-emerald-500" />
                  ) : active ? (
                    <div className="h-3 w-3 shrink-0 animate-spin rounded-full border border-indigo-500 border-t-transparent" />
                  ) : (
                    <div className="h-3 w-3 shrink-0 rounded-full border border-neutral-300" />
                  )}
                  {label}
                  {pct === 70 && result?.pqSkipped && <span className="text-neutral-400">(пропуснат)</span>}
                </li>
              );
            })}
          </ol>
        )}

        {/* Error state */}
        {error && (
          <div className="space-y-3">
            <div role="alert" className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
            <button
              onClick={onRetry}
              className="w-full rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Опитай отново
            </button>
          </div>
        )}

        {/* Done state */}
        {isDone && !error && (
          <div className="space-y-3">
            <div role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5">
              <CheckCircle size={15} className="shrink-0 text-emerald-500" aria-hidden="true" />
              <p className="text-xs text-emerald-700 font-medium">
                Документът е подписан успешно.
                {result.pqSkipped && ' (само ECDSA P-256 — без ML-DSA-65)'}
              </p>
            </div>
            <button
              onClick={onDownload}
              disabled={downloadLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {downloadLoading
                ? <><RefreshCw size={14} className="animate-spin" /> Генериране на линк…</>
                : <><Download size={14} /> Свали подписания документ</>
              }
            </button>
            <button
              onClick={onDone}
              className="w-full rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Затвори
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Байт-по-байт сравнение на два PRF salt-а — ползва се за да разпознаем кой mock extractor да върне резултата. */
function saltsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function SignDocumentModal({
  documentId,
  storagePath,
  filename,
  userId,
  onDone,
  onClose,
}: SignDocumentModalProps) {
  const [stage, setStage] = useState<ModalStage>('position');
  const [marker, setMarker] = useState<MarkerPos | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  // Preflight: resolveSigningKeys (DB only — без биометрия)
  const [preflightKeys, setPreflightKeys] = useState<ResolvedKeys | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');

  // Signing progress
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [signingError, setSigningError] = useState<string | null>(null);
  const [signingResult, setSigningResult] = useState<SignDocumentResult | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);

  // Генерираме signed URL за thumbnail rendering (не за audit logging)
  useEffect(() => {
    supabase.storage.from('documents')
      .createSignedUrl(storagePath, 300)
      .then(({ data }) => setSignedUrl(data?.signedUrl ?? null));
  }, [storagePath]);

  // Pre-fetch NotoSans при mount — font-ът трябва да е готов ПРЕДИ PRF ceremony,
  // защото iOS Safari губи user gesture context след await за мрежа.
  const fontBytesRef = useRef<Uint8Array | undefined>(undefined);
  useEffect(() => {
    fetch('/fonts/NotoSans-Regular.ttf')
      .then(r => r.arrayBuffer())
      .then(buf => { fontBytesRef.current = new Uint8Array(buf); })
      .catch(() => {});
  }, []);

  // Preflight: resolveSigningKeys + display_name (заедно при mount)
  useEffect(() => {
    resolveSigningKeys()
      .then(keys => setPreflightKeys(keys))
      .catch(err => setPreflightError(err instanceof Error ? err.message : String(err)));

    supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
      .then(({ data }) => setSignerName(data?.display_name ?? ''));
  }, [userId]);

  const handleSign = useCallback(async () => {
    if (!marker || !preflightKeys) return;
    setStage('signing');
    setSigningError(null);
    setSigningResult(null);
    setProgress(0);
    setProgressLabel('');

    const rpId = window.location.hostname;

    // ── PRF ceremony(ies) FIRST ──────────────────────────────────────────────
    // iOS Safari изисква navigator.credentials.get() да е в "user gesture context".
    // Всеки await за мрежа (fetch, supabase) преди WebAuthn губи този контекст
    // и iOS тихо блокира Face ID без да показва грешка.
    // Решение: PRF преди всичко останало; signDocument получава mock extractor.
    let capturedPrf: PrfResult | null = null;
    let capturedPrfMlDsa: PrfResult | null = null;
    let capturedDualPrf: DualPrfResult | null = null;

    try {
      if (preflightKeys.singlePrf && preflightKeys.mlDsaData) {
        // Един tap → два ключа
        capturedDualPrf = await browserDualPrfExtractor(
          preflightKeys.ecdsaData.prfSalt,
          preflightKeys.mlDsaData.prfSalt,
          rpId,
          preflightKeys.ecdsaData.credentialId,
        );
      } else if (preflightKeys.mlDsaData) {
        // Два отделни credential-а → два tapа
        capturedPrf = await browserPrfExtractor(
          preflightKeys.ecdsaData.prfSalt, rpId, preflightKeys.ecdsaData.credentialId,
        );
        capturedPrfMlDsa = await browserPrfExtractor(
          preflightKeys.mlDsaData.prfSalt, rpId, preflightKeys.mlDsaData.credentialId,
        );
      } else {
        // Само ECDSA
        capturedPrf = await browserPrfExtractor(
          preflightKeys.ecdsaData.prfSalt, rpId, preflightKeys.ecdsaData.credentialId,
        );
      }
    } catch (err) {
      setSigningError(err instanceof Error ? err.message : 'Биометричната верификация неуспешна.');
      return;
    }

    // ── Font (pre-fetched при mount; fallback fetch ако кешът не е готов) ────
    let fontBytes: Uint8Array | undefined = fontBytesRef.current;
    if (!fontBytes) {
      try {
        fontBytes = new Uint8Array(
          await (await fetch('/fonts/NotoSans-Regular.ttf')).arrayBuffer(),
        );
      } catch {
        fontBytes = undefined; // без визуален маркер — подписът е валиден
      }
    }

    // ── Mock PRF extractors — връщат pre-captured резултати, без нов UI prompt ──
    const mlDsaSalt = preflightKeys.mlDsaData?.prfSalt;
    const mockPrfExtractor: PrfExtractor = async (salt) => {
      if (capturedPrfMlDsa && mlDsaSalt && saltsEqual(salt, mlDsaSalt)) {
        return capturedPrfMlDsa;
      }
      return capturedPrf!;
    };
    const mockDualPrfExtractor: DualPrfExtractor = async () => capturedDualPrf!;

    try {
      const result = await signDocument(
        documentId,
        userId,
        signerName,
        { page: marker.page, x: marker.x, y: marker.y },
        rpId,
        fontBytes,
        capturedPrf || capturedPrfMlDsa ? mockPrfExtractor : undefined,
        capturedDualPrf ? mockDualPrfExtractor : undefined,
        (pct, label) => { setProgress(pct); setProgressLabel(label); },
      );

      setProgress(100);
      setProgressLabel('Завършено');
      setSigningResult(result);
    } catch (err) {
      setSigningError(err instanceof Error ? err.message : String(err));
    }
  }, [marker, preflightKeys, documentId, userId, signerName]);

  /**
   * Сваля току-що подписания PDF локално.
   * Изтегляме blob вместо да навигираме директно към signed URL — Supabase Storage
   * прави redirect към различен origin, при което браузърът игнорира a.download
   * и слага UUID вместо оригиналното име на файла.
   */
  const handleDownload = async () => {
    if (!signingResult) return;
    setDownloadLoading(true);
    try {
      const signedUrl = await getSignedDownloadUrl(signingResult.signedStoragePath);
      const response = await fetch(signedUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename.replace(/\.pdf$/i, '_signed.pdf');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 150);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Грешка при сваляне.');
    } finally {
      setDownloadLoading(false);
    }
  };

  const handleDone = () => {
    onDone(); // refresh list + close
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-modal-title"
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <p id="sign-modal-title" className="px-6 pt-4 text-xs font-medium text-neutral-400 tracking-wide uppercase truncate">
          {filename}
        </p>

        {stage === 'position' && (
          <StepPosition
            signedUrl={signedUrl}
            docId={documentId}
            marker={marker}
            onMarkerChange={setMarker}
            onNext={() => setStage('confirm')}
            onClose={onClose}
          />
        )}

        {stage === 'confirm' && marker && (
          <StepConfirm
            marker={marker}
            preflightKeys={preflightKeys}
            preflightError={preflightError}
            signerName={signerName}
            onBack={() => setStage('position')}
            onSign={handleSign}
          />
        )}

        {(stage === 'signing' || stage === 'done' || stage === 'error') && (
          <StepSigning
            progress={progress}
            progressLabel={progressLabel}
            error={signingError}
            result={signingResult}
            onRetry={() => setStage('confirm')}
            onDownload={handleDownload}
            onDone={handleDone}
            downloadLoading={downloadLoading}
          />
        )}
      </div>
    </div>
  );
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────

function ModalHeader({ step, title, onClose }: { step?: number; title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
      <div>
        {step && <p className="text-xs text-neutral-400 mb-0.5">Стъпка {step} от 3</p>}
        <h2 className="text-base font-semibold text-neutral-800">{title}</h2>
      </div>
      {onClose && (
        <button onClick={onClose} aria-label="Затвори" className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100">
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

interface ModalFooterProps {
  onBack: () => void;
  backLabel: string;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  nextClassName?: string;
}

function ModalFooter({ onBack, backLabel, onNext, nextLabel, nextDisabled, nextClassName }: ModalFooterProps) {
  return (
    <div className="flex gap-3 border-t border-neutral-100 px-6 py-4">
      <button
        onClick={onBack}
        className="flex-1 rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
      >
        {backLabel}
      </button>
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className={`flex-1 rounded-lg py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed ${
          nextClassName ?? 'bg-indigo-600 text-white hover:bg-indigo-700'
        }`}
      >
        {nextLabel}
      </button>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-28 shrink-0 text-neutral-500">{label}:</span>
      <span className="text-neutral-800">{value}</span>
    </div>
  );
}
