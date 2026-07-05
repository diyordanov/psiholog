import { useEffect, useState, useCallback } from 'react';
import { FileText, Eye, RefreshCw } from 'lucide-react';
import { fetchUserDocuments, getDocumentSignedUrl, type DocumentRow } from '../../lib/documentUpload';
import UploadDocument from './UploadDocument';
import PdfViewer from './PdfViewer';

interface DocumentListProps {
  userId: string;
}

export default function DocumentList({ userId }: DocumentListProps) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingUrl, setViewingUrl] = useState<string | null>(null);
  const [viewingName, setViewingName] = useState<string>('');
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null); // document id

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

  const handleView = async (doc: DocumentRow) => {
    setLoadingUrl(doc.id);
    try {
      const url = await getDocumentSignedUrl(doc.storage_path);
      setViewingUrl(url);
      setViewingName(doc.original_filename);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Грешка при отваряне на документа.');
    } finally {
      setLoadingUrl(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Заглавие */}
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

      {/* Качване */}
      <div className="mb-8">
        <UploadDocument userId={userId} onUploaded={load} />
      </div>

      {/* Списък */}
      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {loading && documents.length === 0 ? (
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
            <div key={doc.id} className="flex items-center gap-4 px-4 py-3">
              {/* Икона */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
                <FileText size={18} className="text-indigo-500" />
              </div>

              {/* Информация */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-800">
                  {doc.original_filename}
                </p>
                <p className="text-xs text-neutral-400">
                  {formatDate(doc.created_at)}
                </p>
              </div>

              {/* Статус бадж */}
              <StatusBadge status={doc.status} />

              {/* Бутон преглед */}
              <button
                onClick={() => handleView(doc)}
                disabled={loadingUrl === doc.id}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50"
              >
                {loadingUrl === doc.id
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <Eye size={12} />
                }
                Преглед
              </button>
            </div>
          ))}
        </div>
      )}

      {/* PDF Viewer модал */}
      {viewingUrl && (
        <PdfViewer
          url={viewingUrl}
          filename={viewingName}
          onClose={() => { setViewingUrl(null); setViewingName(''); }}
        />
      )}
    </div>
  );
}

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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
