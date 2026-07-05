import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewerProps {
  url: string;
  filename: string;
  onClose: () => void;
}

export default function PdfViewer({ url, filename, onClose }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  // Зареждаме PDF чрез URL — pdf.js прави range requests и изтегля само данните
  // за текущата страница, без да чака целия файл.
  // withCredentials: false е критично за cross-origin Supabase Storage URLs.
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
        docRef.current = doc;
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

  // Рендираме страницата при промяна на pdf / pageNum / scale
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setRendering(true);

    pdf.getPage(pageNum).then((page) => {
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      // Не подаваме 'canvas' параметър — той е само за OffscreenCanvas рендиране.
      // Подаването на HTMLCanvasElement там причинява бяла страница в pdf.js v4.
      const task = page.render({
        canvasContext: ctx,
        viewport,
      } as Parameters<typeof page.render>[0]);

      renderTaskRef.current = task;

      task.promise
        .then(() => setRendering(false))
        .catch((e) => {
          if (e?.name !== 'RenderingCancelledException') {
            console.error('PDF render грешка:', e);
          }
          setRendering(false);
        });
    });
  }, [pdf, pageNum, scale]);

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

        <p className="absolute left-1/2 -translate-x-1/2 max-w-xs truncate text-sm text-neutral-300">
          {filename}
          {rendering && !loading && (
            <span className="ml-2 text-xs text-neutral-500">Рендираме...</span>
          )}
        </p>

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
        {/* Canvas остава монтиран дори при зареждане — показваме го само след loading */}
        <canvas
          ref={canvasRef}
          className={`shadow-2xl ${loading || error ? 'hidden' : ''}`}
          style={{ maxWidth: '100%' }}
        />
      </div>
    </div>
  );
}
