import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
// Legacy build включва polyfill-и за Map.getOrInsertComputed и др. нови API,
// които iOS Safari не поддържа. Стандартният build гърми на мобилно.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Module-level cache — оцелява при затваряне/отваряне в рамките на сесията
const pageCache = new Map<string, string>(); // key → JPEG data URL
const MAX_CACHE_ENTRIES = 20;

// iOS Safari: max ~16.7M px на canvas; десктоп: ~268M px. Ограничаваме консервативно.
const MAX_CANVAS_PIXELS = 8_000_000;

function cacheKey(cacheId: string, page: number, scale: number) {
  return `${cacheId}:${page}:${(Math.round(scale * 4) / 4).toFixed(2)}`;
}

function saveToCache(key: string, canvas: HTMLCanvasElement) {
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    if (pageCache.size >= MAX_CACHE_ENTRIES) {
      pageCache.delete(pageCache.keys().next().value!);
    }
    pageCache.set(key, dataUrl);
  } catch { /* SecurityError при tainted canvas */ }
}

function drawFromCache(dataUrl: string, canvas: HTMLCanvasElement): Promise<void> {
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
  cacheId: string;
  onClose: () => void;
}

export default function PdfViewer({ url, filename, cacheId, onClose }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [docLoading, setDocLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  // Зареждаме PDF чрез URL + range requests (само данните за текущата страница)
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

        // Изчисляваме fit-width скейл спрямо ширината на екрана
        const page = await doc.getPage(1);
        const naturalVp = page.getViewport({ scale: 1 });
        const containerW = Math.min(window.innerWidth, 900) - 48;
        const fitScale = containerW / naturalVp.width;
        const clampedScale = Math.max(0.4, Math.min(fitScale, 2.0));

        if (!cancelled) {
          setScale(clampedScale);
          setPdf(doc);
          setTotalPages(doc.numPages);
          setDocLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Грешка при зареждане на PDF.');
          setDocLoading(false);
        }
      });

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url]);

  // Рендираме страница при промяна на pdf / pageNum / scale
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const key = cacheKey(cacheId, pageNum, scale);

    // Отменяме текущ рендер
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    // Cache hit → покажи незабавно
    const cached = pageCache.get(key);
    if (cached) {
      drawFromCache(cached, canvas).then(() => setRendering(false));
      setRendering(false);
      return;
    }

    setRendering(true);
    setError(null);

    pdf.getPage(pageNum)
      .then((page) => {
        // Ограничаваме скейла ако canvas-ът би надхвърлил iOS/браузър лимита
        const naturalVp = page.getViewport({ scale: 1 });
        const naturalPixels = naturalVp.width * naturalVp.height;
        const effectiveScale = naturalPixels * scale * scale > MAX_CANVAS_PIXELS
          ? Math.sqrt(MAX_CANVAS_PIXELS / naturalPixels)
          : scale;

        const viewport = page.getViewport({ scale: effectiveScale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const ctx = canvas.getContext('2d');
        if (!ctx) { setRendering(false); return; }

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
        } as Parameters<typeof page.render>[0]);

        renderTaskRef.current = renderTask;

        renderTask.promise
          .then(() => {
            saveToCache(key, canvas);
            setRendering(false);
          })
          .catch((e) => {
            if (e?.name === 'RenderingCancelledException') return;
            setError('Грешка при рендиране на страницата.');
            setRendering(false);
          });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Грешка при зареждане на страница.');
        setRendering(false);
      });
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

  const isLoading = docLoading || rendering;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950">

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/10 bg-neutral-900">

        {/* Ред 1: навигация + zoom + затваряне */}
        <div className="flex h-11 items-center gap-1 px-3">

          {/* Навигация по страници */}
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1 || docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[3.5rem] text-center text-sm text-neutral-300">
            {docLoading ? '—' : `${pageNum} / ${totalPages}`}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
            disabled={pageNum >= totalPages || docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>

          <div className="flex-1" />

          {/* Zoom */}
          <button
            onClick={() => setScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))}
            disabled={docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ZoomOut size={16} />
          </button>
          <span className="w-10 text-center text-xs text-neutral-400">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
            disabled={docLoading}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-30"
          >
            <ZoomIn size={16} />
          </button>

          <div className="mx-1 h-5 w-px bg-white/10" />

          {/* Затваряне */}
          <button onClick={onClose} className="rounded p-1.5 text-neutral-400 hover:bg-white/10">
            <X size={16} />
          </button>
        </div>

        {/* Ред 2: файлово наименование (центрирано) */}
        <div className="flex h-8 items-center justify-center px-4">
          <p className="max-w-full truncate text-center text-xs text-neutral-400">
            {filename}
          </p>
        </div>
      </div>

      {/* ── Canvas зона ─────────────────────────────────────────────── */}
      <div className="relative flex flex-1 items-start justify-center overflow-auto p-4">

        {/* Loading / статус — абсолютно центриран */}
        {isLoading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-400">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span className="text-sm">
              {docLoading ? 'Зареждаме документа...' : 'Рендираме страницата...'}
            </span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <p className="text-center text-sm text-red-400">{error}</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className={`shadow-2xl transition-opacity duration-200 ${
            docLoading || error ? 'invisible' : rendering ? 'opacity-50' : 'opacity-100'
          }`}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      </div>
    </div>
  );
}
