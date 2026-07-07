/**
 * DocumentList.tsx
 * Главният екран на приложението след login.
 * Показва upload зона и списък с качените документи на потребителя.
 *
 * Всеки документ има:
 *   - Бутон "Преглед" → генерира 5-минутен signed URL и отваря PdfViewer
 *   - Бутон изтриване → inline потвърждение → soft delete (deleted_at в DB)
 */
import { useEffect, useState, useCallback } from 'react';
import { FileText, Eye, RefreshCw, Trash2 } from 'lucide-react';
import { fetchUserDocuments, getDocumentSignedUrl, softDeleteDocument, type DocumentRow } from '../../lib/documentUpload';
import UploadDocument from './UploadDocument';
import PdfViewer from './PdfViewer';

interface DocumentListProps {
  userId: string;
}

export default function DocumentList({ userId }: DocumentListProps) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Viewer state — url е временен (signed, 5 min TTL), cacheId е стабилен (document.id)
  const [viewingUrl, setViewingUrl] = useState<string | null>(null);
  const [viewingName, setViewingName] = useState<string>('');
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);

  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);   // id на документа, за който се генерира URL
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null); // id на документа в режим "потвърди изтриване"
  const [deletingId, setDeletingId] = useState<string | null>(null);   // id на документа, който в момента се изтрива

  /** Зарежда документите от базата. Извиква се при mount и след качване/изтриване. */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const docs = await fetchUserDocuments();
      setDocuments(docs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Грешка при зареждане.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Soft-изтрива документ. Оптимистично го маха от UI веднага,
   * без да чака презареждане на целия списък.
   */
  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await softDeleteDocument(id, userId);
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Грешка при изтриване.');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  /**
   * Генерира временен signed URL за документа и отваря PdfViewer.
   * URL-ът е валиден 5 минути — достатъчно за преглед, но не за споделяне.
   */
  const handleView = async (doc: DocumentRow) => {
    setLoadingUrl(doc.id);
    try {
      const url = await getDocumentSignedUrl(doc.storage_path, userId, doc.id);
      setViewingUrl(url);
      setViewingName(doc.original_filename);
      setViewingDocId(doc.id); // стабилен ключ за render кеша в PdfViewer
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Грешка при отваряне на документа.');
    } finally {
      setLoadingUrl(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Заглавие + бутон за ръчно обновяване */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-800">Моите документи</h1>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Обнови
        </button>
      </div>

      {/* Upload зона — след успешно качване извиква load() за обновяване на списъка */}
      <div className="mb-8">
        <UploadDocument userId={userId} onUploaded={load} />
      </div>

      {/* Грешка при зареждане на списъка */}
      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {/* Списък с документи */}
      {loading && documents.length === 0 ? (
        // Начално зареждане — само spinner (без "Все още няма документи")
        <div className="flex justify-center py-12 text-neutral-400">
          <RefreshCw size={20} className="animate-spin" />
        </div>
      ) : documents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-neutral-400">
          <FileText size={32} strokeWidth={1.5} />
          <p className="text-sm">Все още няма качени документи</p>
        </div>
      ) : (
        <div className="divide-y divide-neutral-100 rounded-xl border border-neutral-100 bg-white shadow-sm">
          {documents.map((doc) => (
            <div key={doc.id} className="flex gap-3 px-4 py-3">
              {/* Икона */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
                <FileText size={18} className="text-indigo-500" />
              </div>

              {/* Двуредово съдържание за мобилна съвместимост */}
              <div className="min-w-0 flex-1">
                {/* Ред 1: Пълно файлово наименование с пренос (break-all предотвратява overflow) */}
                <p className="break-all text-sm font-medium leading-snug text-neutral-800">
                  {doc.original_filename}
                </p>

                {/* Ред 2: Метаданни и действия — flex-wrap за мобилно */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-xs text-neutral-400">{formatDate(doc.created_at)}</span>
                  <StatusBadge status={doc.status} />

                  {/* Бутон Преглед */}
                  <button
                    onClick={() => handleView(doc)}
                    disabled={loadingUrl === doc.id}
                    className="flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50"
                  >
                    {loadingUrl === doc.id
                      ? <RefreshCw size={11} className="animate-spin" />
                      : <Eye size={11} />
                    }
                    Преглед
                  </button>

                  {/* Бутон изтрий — с inline потвърждение преди действието */}
                  {confirmDeleteId === doc.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(doc.id)}
                        disabled={deletingId === doc.id}
                        className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                      >
                        {deletingId === doc.id ? <RefreshCw size={11} className="animate-spin" /> : 'Потвърди'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:text-neutral-600"
                      >
                        Откажи
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(doc.id)}
                      className="rounded-lg p-1 text-neutral-300 transition-colors hover:bg-red-50 hover:text-red-500"
                      title="Изтрий документ"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PDF Viewer — fullscreen overlay, показван когато viewingUrl е зададен */}
      {viewingUrl && viewingDocId && (
        <PdfViewer
          url={viewingUrl}
          filename={viewingName}
          cacheId={viewingDocId}
          onClose={() => { setViewingUrl(null); setViewingName(''); setViewingDocId(null); }}
        />
      )}
    </div>
  );
}

/** Цветен бадж за статуса на документа. */
function StatusBadge({ status }: { status: DocumentRow['status'] }) {
  if (status === 'signed') {
    return (
      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
        Подписан
      </span>
    );
  }
  return (
    <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-500">
      Качен
    </span>
  );
}

/** Форматира ISO дата като "5 юли 2026 г." на български. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso; // fallback при невалидна дата
  }
}
