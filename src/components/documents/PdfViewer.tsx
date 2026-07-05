import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Module-level cache — оцелява при затваряне/отваряне на viewer-а в рамките на сесията.
// Ключ: "${cacheId}:${page}:${scaleBucket}" → JPEG data URL на рендираната страница.
const pageCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 30;

// Скейл за бързия preview (рендира ~(0.35/userScale)² пъти по-малко пиксели)
const PREVIEW_SCALE = 0.35;

function scaleBucket(s: number): string {
  // Групираме в стъпки от 0.25, за да ползваме кеша при незначителни разлики
  return (Math.round(s * 4) / 4).toFixed(2);
}

function cacheKey(cacheId: string, page: number, scale: number) {
  return `${cacheId}:${page}:${scaleBucket(scale)}`;
}

function saveToCache(key: string, canvas: HTMLCanvasElement) {
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
    if (pageCache.size >= MAX_CACHE_ENTRIES) {
      pageCache.delete(pageCache.keys().next().value!);
    }
    pageCache.set(key, dataUrl);
  } catch {
    // canvas.toDataURL може да хвърли SecurityError при tainted canvas
  }
}

async function renderToCanvas(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<pdfjsLib.RenderTask> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  return page.render({
    canvasContext: ctx,
    viewport,
    intent: 'display',
  } as Parameters<typeof page.render>[0]);
}

function drawCachedToCanvas(dataUrl: string, canvas: HTMLCanvasElement): Promise<void> {
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

interface PdfViewerProps {
  url: string;
  filename: string;
  cacheId: string; // стабилен document.id — ключ за кеша при повторно отваряне
  onClose: () => void;
}

export default function PdfViewer({ url, filename, cacheId, onClose }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [renderState, setRenderState] = useState<'idle' | 'preview' | 'full'>('idle');
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  // Зареждаме PDF документа чрез URL + range requests (само данните за текущата страница)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageNum(1);
    setPdf(null);

    const loadingTask = pdfjsLib.getDocument(
      { url, withCredentials: false } as Parameters<typeof pdfjsLib.getDocument>[0]
    );

    loadingTask.promise
      .then((doc) => {
        if (cancelled) { (doc as unknown as { destroy(): void }).destroy(); return; }
        setPdf(doc);
        setTotalPages(doc.numPages);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Грешка при зареждане на PDF.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [url]);

  // Двустъпков рендер при смяна на страница/скейл:
  //   1. Ако пълният рендер е в кеша → покажи незабавно
  //   2. Иначе: рендирай preview (0.35×) за ~5 сек → покажи го,
  //      след това рендирай пълен → замести + кешира
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const fullKey = cacheKey(cacheId, pageNum, scale);
    const previewKey = cacheKey(cacheId, pageNum, PREVIEW_SCALE);

    // Отменяме текущ рендер
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    // --- Кеш hit за пълна резолюция → незабавно ---
    const cachedFull = pageCache.get(fullKey);
    if (cachedFull) {
      drawCachedToCanvas(cachedFull, canvas).then(() => setRenderState('full'));
      return;
    }

    setRenderState('preview');

    // --- Стартираме двата рендера паралелно ---
    const offscreen = document.createElement('canvas');

    // Preview рендер (бърз)
    const cachedPreview = pageCache.get(previewKey);
    const previewPromise: Promise<void> = cachedPreview
      ? drawCachedToCanvas(cachedPreview, canvas)
      : renderToCanvas(pdf, pageNum, PREVIEW_SCALE, canvas).then((task) => {
          renderTaskRef.current = task;
          return task.promise
            .then(() => { saveToCache(previewKey, canvas); })
            .catch(() => {});
        });

    // Пълен рендер (бавен, в offscreen canvas)
    const fullRenderPromise = renderToCanvas(pdf, pageNum, scale, offscreen)
      .then((task) => {
        renderTaskRef.current = task;
        return task.promise
          .then(() => {
            // Копираме offscreen → видимия canvas
            canvas.width = offscreen.width;
            canvas.height = offscreen.height;
            canvas.getContext('2d')!.drawImage(offscreen, 0, 0);
            saveToCache(fullKey, canvas);
            setRenderState('full');
          })
          .catch((e) => {
            if (e?.name !== 'RenderingCancelledException') {
              console.error('PDF full render грешка:', e);
            }
          });
      });

    previewPromise
      .then(() => { if (renderState !== 'full') setRenderState('preview'); })
      .catch(() => {});

    fullRenderPromise.catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNum, scale, cacheId]);

  // Keyboard навигация
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && pageNum < totalPages) setPageNum((p) => p + 1);
      if (e.key === 'ArrowLeft' && pageNum > 1) setPageNum((p) => p - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, pageNum, totalPages]);

  const renderLabel =
    renderState === 'preview' ? 'Зарежда пълна резолюция...' :
    renderState === 'full'    ? '' : '';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950/95">
      {/* Горна лента */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1 || loading}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-neutral-300">
            {loading ? '—' : `${pageNum} / ${totalPages}`}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
            disabled={pageNum >= totalPages || loading}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Заглавие + статус */}
        <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center">
          <p className="max-w-xs truncate text-sm text-neutral-300">{filename}</p>
          {renderLabel && (
            <p className="text-xs text-neutral-500">{renderLabel}</p>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)))}
            disabled={loading}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ZoomOut size={18} />
          </button>
          <span className="min-w-[3rem] text-center text-xs text-neutral-400">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
            disabled={loading}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ZoomIn size={18} />
          </button>
          <button
            onClick={onClose}
            className="ml-2 rounded-lg p-1.5 text-neutral-400 hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Canvas зона */}
      <div className="flex flex-1 items-start justify-center overflow-auto p-6">
        {loading && (
          <div className="flex items-center gap-2 self-center text-neutral-400">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span className="text-sm">Зареждаме документа...</span>
          </div>
        )}
        {error && (
          <p className="self-center text-sm text-red-400">{error}</p>
        )}
        <canvas
          ref={canvasRef}
          className={`shadow-2xl transition-opacity duration-300 ${
            loading || error ? 'hidden' :
            renderState === 'preview' ? 'opacity-60' : 'opacity-100'
          }`}
          style={{ maxWidth: '100%' }}
        />
      </div>
    </div>
  );
}
