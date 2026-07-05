/**
 * PdfViewer.tsx
 * Fullscreen PDF viewer с двустъпков рендер и session-level кеш.
 *
 * Рендер стратегия:
 *   1. Preview (бързо, ~1–5 сек): рендира при ~80 000 px canvas — достатъчно малко
 *      за да е бързо дори при 19 MB PDF, показва се веднага на потребителя.
 *   2. Quality (бавно, в background): рендира при до 4 MP в offscreen canvas,
 *      след което го копира в главния canvas без видим flash.
 *
 * Кеш: module-level Map (не React state) — оцелява при затваряне/отваряне на viewer-а
 * в рамките на една сесия. Ключ = "{cacheId}:{page}:{label}" (стабилен document.id,
 * не временния signed URL). Стойност = JPEG data URL на рендирания canvas.
 *
 * iOS Safari забележки:
 *   - Стандартният pdfjs-dist build ползва Map.getOrInsertComputed (не поддържан).
 *     Затова импортираме legacy build с polyfill-и.
 *   - Максималната canvas площ на iOS е ~16.7 MP; ограничаваме до 4 MP за безопасност.
 *
 * Бутон ↗ (ExternalLink): отваря signed URL в нов tab → iOS/Android native PDF viewer,
 * hardware-оптимизиран, зарежда 19 MB PDF мигновено.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, ExternalLink } from 'lucide-react';
// Legacy build — iOS Safari не поддържа Map.getOrInsertComputed от стандартния build
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

// Указваме на pdf.js worker-а пътя към отделния JS файл (bundled от Vite като ?url import).
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Module-level кеш: оцелява при unmount/remount на компонента в рамките на сесията.
// Ключ: "${cacheId}:${page}:${label}" → JPEG data URL на рендираната страница.
const pageCache = new Map<string, string>();
const MAX_CACHE = 30; // брой cached страници преди LRU eviction

// iOS Safari поддържа до ~16.7 MP на canvas; ползваме 4 MP за качество + скорост.
const MAX_CANVAS_PX = 4_000_000;
// Preview: ~80 000 px = ~283×283 px еквивалент — рендира за 1–5 сек дори при 19 MB PDF.
const PREVIEW_MAX_PX = 80_000;

/** Генерира уникален cache ключ за страница при дадено качество. */
function ck(id: string, page: number, label: string) {
  return `${id}:${page}:${label}`;
}

/**
 * Записва рендирания canvas в кеша като JPEG data URL.
 * JPEG е избран пред PNG — значително по-малък размер при незначителна разлика в качеството.
 * SecurityError може да се хвърли ако canvas-ът е "tainted" от cross-origin content.
 */
function saveCache(key: string, canvas: HTMLCanvasElement) {
  try {
    const url = canvas.toDataURL('image/jpeg', 0.88);
    if (pageCache.size >= MAX_CACHE) pageCache.delete(pageCache.keys().next().value!);
    pageCache.set(key, url);
  } catch { /* tainted canvas — пропускаме кеширането */ }
}

/**
 * Рисува кеширано изображение в canvas.
 * Промяната на canvas.width/height изчиства съдържанието — правим го преди drawImage.
 */
function drawCache(dataUrl: string, canvas: HTMLCanvasElement): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      resolve();
    };
    img.src = dataUrl;
  });
}

/**
 * Изчислява ефективния скейл така, че canvas площта да не надхвърля maxPx.
 * Ако wantedScale би произвел твърде голям canvas, го намалява пропорционално.
 */
function cappedScale(naturalW: number, naturalH: number, maxPx: number, wantedScale: number) {
  const wouldBe = naturalW * wantedScale * naturalH * wantedScale;
  return wouldBe > maxPx ? Math.sqrt(maxPx / (naturalW * naturalH)) : wantedScale;
}

interface PdfViewerProps {
  url: string;
  filename: string;
  /** Стабилен document.id — ключ за кеша при повторно отваряне (signed URL се генерира наново). */
  cacheId: string;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function PdfViewer({ url, filename, cacheId, onClose }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [fitScale, setFitScale] = useState(1.0);   // fit-width скейл за quality render
  const [userScale, setUserScale] = useState(1.0); // мащаб избран от потребителя (×fitScale)
  const [docLoading, setDocLoading] = useState(true);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const effectiveScale = fitScale * userScale;

  // ── Зареждаме PDF ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setDocLoading(true);
    setError(null);
    setPageNum(1);
    setPdf(null);

    const task = pdfjsLib.getDocument(
      { url, withCredentials: false } as Parameters<typeof pdfjsLib.getDocument>[0]
    );

    task.promise
      .then(async (doc) => {
        if (cancelled) { (doc as unknown as { destroy(): void }).destroy(); return; }
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const containerW = Math.min(window.innerWidth, 900) - 48;
        const fs = Math.max(0.2, Math.min(containerW / vp.width, 3));
        if (!cancelled) {
          setFitScale(fs);
          setPdf(doc);
          setTotalPages(doc.numPages);
          setDocLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Грешка при зареждане.');
          setDocLoading(false);
        }
      });

    return () => { cancelled = true; task.destroy(); };
  }, [url]);

  // ── Двустъпков рендер: preview (бързо) → quality (в background) ─────────────
  const renderPage = useCallback(async (
    doc: pdfjsLib.PDFDocumentProxy,
    page: number,
    es: number,           // effective scale
    canvas: HTMLCanvasElement,
  ) => {
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    const pdfPage = await doc.getPage(page);
    const nat = pdfPage.getViewport({ scale: 1 });

    // ── Quality cache hit → показваме незабавно ─────────────────────────────
    const qualKey = ck(cacheId, page, `q:${es.toFixed(2)}`);
    const cachedQ = pageCache.get(qualKey);
    if (cachedQ) {
      await drawCache(cachedQ, canvas);
      setQualityLoading(false);
      return;
    }

    // ── Preview (fast) ──────────────────────────────────────────────────────
    const prevKey = ck(cacheId, page, 'preview');
    const prevScale = cappedScale(nat.width, nat.height, PREVIEW_MAX_PX, es);
    const cachedP = pageCache.get(prevKey);

    if (cachedP) {
      await drawCache(cachedP, canvas);
    } else {
      const vp = pdfPage.getViewport({ scale: prevScale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d')!;
      const t = pdfPage.render({ canvasContext: ctx, viewport: vp } as Parameters<typeof pdfPage.render>[0]);
      renderTaskRef.current = t;
      await t.promise.catch(() => {});
      saveCache(prevKey, canvas);
    }

    // Preview зареден — показваме го веднага
    setQualityLoading(true);

    // ── Quality render в background ─────────────────────────────────────────
    const qScale = cappedScale(nat.width, nat.height, MAX_CANVAS_PX, es);
    // Ако скейловете съвпадат (PDF е малък) — вече имаме quality
    if (Math.abs(qScale - prevScale) < 0.01) {
      saveCache(qualKey, canvas);
      setQualityLoading(false);
      return;
    }

    const offscreen = document.createElement('canvas');
    const qVp = pdfPage.getViewport({ scale: qScale });
    offscreen.width = Math.floor(qVp.width);
    offscreen.height = Math.floor(qVp.height);
    const offCtx = offscreen.getContext('2d')!;

    const qt = pdfPage.render({
      canvasContext: offCtx,
      viewport: qVp,
    } as Parameters<typeof pdfPage.render>[0]);

    renderTaskRef.current = qt;

    qt.promise
      .then(() => {
        saveCache(qualKey, offscreen);
        // Бlit в главния canvas без flash
        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.getContext('2d')!.drawImage(offscreen, 0, 0);
        setQualityLoading(false);
      })
      .catch((e) => {
        if (e?.name !== 'RenderingCancelledException') {
          console.error('Quality render грешка:', e);
        }
        setQualityLoading(false);
      });
  }, [cacheId]);

  useEffect(() => {
    if (!pdf || !canvasRef.current || docLoading) return;
    setError(null);
    renderPage(pdf, pageNum, effectiveScale, canvasRef.current).catch((e) => {
      setError(e instanceof Error ? e.message : 'Грешка при рендиране.');
    });
  }, [pdf, pageNum, effectiveScale, docLoading, renderPage]);

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && pageNum < totalPages) setPageNum((p) => p + 1);
      if (e.key === 'ArrowLeft' && pageNum > 1) setPageNum((p) => p - 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, pageNum, totalPages]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950">

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/10 bg-neutral-900">

        {/* Ред 1: навигация + zoom + действия */}
        <div className="flex h-11 items-center gap-1 px-3">
          <button onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1 || docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[3.5rem] text-center text-sm text-neutral-300">
            {docLoading ? '—' : `${pageNum} / ${totalPages}`}
          </span>
          <button onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
            disabled={pageNum >= totalPages || docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30">
            <ChevronRight size={16} />
          </button>

          <div className="flex-1" />

          {/* Zoom */}
          <button onClick={() => setUserScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))}
            disabled={docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30">
            <ZoomOut size={16} />
          </button>
          <span className="w-10 text-center text-xs text-neutral-400">
            {Math.round(userScale * 100)}%
          </span>
          <button onClick={() => setUserScale((s) => Math.min(4, +(s + 0.25).toFixed(2)))}
            disabled={docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30">
            <ZoomIn size={16} />
          </button>

          <div className="mx-1 h-5 w-px bg-white/10" />

          {/* Отвори в браузъра — native PDF viewer (мигновено на iOS) */}
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            title="Отвори в браузъра">
            <ExternalLink size={16} />
          </a>

          <button onClick={onClose}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10">
            <X size={16} />
          </button>
        </div>

        {/* Ред 2: файлово наименование */}
        <div className="flex h-8 items-center justify-center gap-2 px-4">
          <p className="max-w-full truncate text-center text-xs text-neutral-400">{filename}</p>
          {qualityLoading && !docLoading && (
            <span className="shrink-0 text-xs text-neutral-500">· зарежда в HD…</span>
          )}
        </div>
      </div>

      {/* ── Canvas зона ─────────────────────────────────────────────────────── */}
      <div className="relative flex flex-1 items-start justify-center overflow-auto p-4">

        {/* Loading / грешка — центрирани */}
        {docLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-400">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span className="text-sm">Зареждаме документа...</span>
          </div>
        )}
        {error && !docLoading && (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <p className="text-center text-sm text-red-400">{error}</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className={`shadow-2xl ${docLoading || error ? 'invisible' : ''}`}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      </div>
    </div>
  );
}
