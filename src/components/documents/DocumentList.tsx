/**
 * DocumentList.tsx
 * Главният екран на приложението след login.
 * Показва upload зона и списък с качените документи на потребителя.
 *
 * Всеки документ има:
 *   - Бутон "Преглед" → генерира 5-минутен signed URL и отваря PdfViewer
 *   - Бутон "Подпиши" → pre-flight key check → SignDocumentModal (3 стъпки)
 *   - Бутон "Свали подписан" → при status='signed', сваля подписания PDF
 *   - Бутон изтриване → inline потвърждение → soft delete (deleted_at в DB)
 */
import { useEffect, useState, useCallback } from 'react';
import { FileText, Eye, RefreshCw, Trash2, PenLine, Download, CheckCircle } from 'lucide-react';
import { fetchUserDocuments, getDocumentSignedUrl, softDeleteDocument, type DocumentRow } from '../../lib/documentUpload';
import { fetchBestKeyId } from '../../lib/signingKeyStore';
import { getSignedDownloadUrl } from '../../lib/signingService';
import { logAuditEvent } from '../../lib/auditLog';
import UploadDocument from './UploadDocument';
import PdfViewer from './PdfViewer';
import SignDocumentModal from './SignDocumentModal';

interface DocumentListProps {
  userId: string;
}

export default function DocumentList({ userId }: DocumentListProps) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Viewer state
  const [viewingUrl, setViewingUrl] = useState<string | null>(null);
  const [viewingName, setViewingName] = useState<string>('');
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);

  // Signing state
  const [signingDoc, setSigningDoc] = useState<DocumentRow | null>(null);
  const [signPreflight, setSignPreflight] = useState<string | null>(null); // inline error bellow doc
  const [signPreflightId, setSignPreflightId] = useState<string | null>(null);

  // Loading/action states
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingSignedId, setDownloadingSignedId] = useState<string | null>(null);

  // Toast state
  const [toast, setToast] = useState<string | null>(null);

  /** Зарежда документите от базата. */
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

  /** Показва toast за 3 секунди. */
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  /** Soft-изтрива документ. */
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

  /** Генерира signed URL и отваря PdfViewer. */
  const handleView = async (doc: DocumentRow) => {
    setLoadingUrl(doc.id);
    try {
      const url = await getDocumentSignedUrl(doc.storage_path, userId, doc.id);
      setViewingUrl(url);
      setViewingName(doc.original_filename);
      setViewingDocId(doc.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Грешка при отваряне на документа.');
    } finally {
      setLoadingUrl(null);
    }
  };

  /**
   * Pre-flight преди отваряне на SignDocumentModal.
   * Проверява дали има ECDSA P-256 ключ — ако не, показва inline съобщение.
   * Не проверява cert (ще се провери в StepConfirm).
   */
  const handleSignClick = async (doc: DocumentRow) => {
    setSignPreflightId(doc.id);
    setSignPreflight(null);
    try {
      const ecdsaKeyId = await fetchBestKeyId('ecdsa-p256');
      if (!ecdsaKeyId) {
        setSignPreflight('Първо генерирайте ECDSA P-256 ключ в „Ключове".');
        return;
      }
      setSigningDoc(doc);
    } catch {
      setSignPreflight('Грешка при проверка на ключовете.');
    } finally {
      setSignPreflightId(null);
    }
  };

  /** Сваля подписания PDF за вече подписан документ. */
  const handleDownloadSigned = async (doc: DocumentRow) => {
    if (!doc.signed_storage_path) return;
    setDownloadingSignedId(doc.id);
    try {
      const signedUrl = await getSignedDownloadUrl(doc.signed_storage_path);
      await logAuditEvent(userId, 'document_downloaded', doc.id);

      // Изтегляме blob локално — Supabase signed URL прави redirect към различен
      // origin, при което браузърът игнорира a.download и използва UUID от пътя.
      const response = await fetch(signedUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = doc.original_filename.replace(/\.pdf$/i, '_signed.pdf');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 150);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Грешка при сваляне.');
    } finally {
      setDownloadingSignedId(null);
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

      {/* Upload зона */}
      <div className="mb-8">
        <UploadDocument userId={userId} onUploaded={load} />
      </div>

      {/* Грешка при зареждане */}
      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {/* Списък */}
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
            <div key={doc.id} className="flex gap-3 px-4 py-3">
              {/* Икона */}
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                doc.status === 'signed' ? 'bg-emerald-50' : 'bg-indigo-50'
              }`}>
                {doc.status === 'signed'
                  ? <CheckCircle size={18} className="text-emerald-500" />
                  : <FileText size={18} className="text-indigo-500" />
                }
              </div>

              {/* Двуредово съдържание */}
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium leading-snug text-neutral-800">
                  {doc.original_filename}
                </p>

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

                  {/* Бутон Подпиши (само за неподписани) */}
                  {doc.status !== 'signed' && (
                    <button
                      onClick={() => handleSignClick(doc)}
                      disabled={signPreflightId === doc.id}
                      className="flex items-center gap-1 rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50"
                    >
                      {signPreflightId === doc.id
                        ? <RefreshCw size={11} className="animate-spin" />
                        : <PenLine size={11} />
                      }
                      Подпиши
                    </button>
                  )}

                  {/* Бутон Свали подписан (само за подписани) */}
                  {doc.status === 'signed' && doc.signed_storage_path && (
                    <button
                      onClick={() => handleDownloadSigned(doc)}
                      disabled={downloadingSignedId === doc.id}
                      className="flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                    >
                      {downloadingSignedId === doc.id
                        ? <RefreshCw size={11} className="animate-spin" />
                        : <Download size={11} />
                      }
                      Свали подписан
                    </button>
                  )}

                  {/* Бутон изтриване */}
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
                      aria-label="Изтрий документ"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Inline preflight error под бутоните */}
                {signPreflightId !== doc.id && signPreflight && signingDoc === null && (
                  <p className="mt-1.5 text-xs text-red-600">{signPreflight}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PDF Viewer */}
      {viewingUrl && viewingDocId && (
        <PdfViewer
          url={viewingUrl}
          filename={viewingName}
          cacheId={viewingDocId}
          onClose={() => { setViewingUrl(null); setViewingName(''); setViewingDocId(null); }}
        />
      )}

      {/* Sign Document Modal */}
      {signingDoc && (
        <SignDocumentModal
          documentId={signingDoc.id}
          storagePath={signingDoc.storage_path}
          filename={signingDoc.original_filename}
          userId={userId}
          onDone={() => {
            setSigningDoc(null);
            load();
            showToast('Документът е подписан успешно.');
          }}
          onClose={() => setSigningDoc(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-neutral-900 px-5 py-3 text-sm text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

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
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return iso;
  }
}
