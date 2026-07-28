/**
 * RecipientSigningModal.tsx
 * 2-стъпков модал за recipient подпис (incremental, Ден 6).
 *
 * За разлика от SignDocumentModal (owner, 3 стъпки с избор на позиция):
 *   - Позицията е ФИКСИРАНА от owner-а при поканата (marker_page/x/y) —
 *     Стъпка 1 показва read-only preview, без клик за позициониране.
 *   - PRF extractors НЕ се capture-ват предварително (за разлика от
 *     usePrfCeremony, ползван от SignDocumentModal/InviteRecipientsModal) —
 *     signAsRecipient() може да прави retry при race с друг recipient, и
 *     всеки retry се нуждае от НОВ WebAuthn prompt (message digest-ът се
 *     сменя). Затова просто пропускаме extractPrf/extractDualPrf изцяло —
 *     decryptSigningSecretKeys() ползва default-ите си (browserPrfExtractor/
 *     browserDualPrfExtractor), които са "живи" при всяко извикване.
 */
import { useState, useEffect, useCallback } from 'react';
import { Fingerprint, AlertTriangle, CheckCircle, Download, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  resolveSigningKeys, signAsRecipient, getSignedDownloadUrl,
  type ResolvedKeys, type RecipientSignResult,
} from '../../lib/signingService';
import type { InvitationDetails } from '../../lib/signingRequestService';
import { ModalHeader, ModalFooter, InfoRow, usePdfThumbnail } from './SignDocumentModal';

type ModalStage = 'confirm' | 'signing';

interface RecipientSigningModalProps {
  details: InvitationDetails;
  userId: string;
  onDone: () => void;   // затваря + refresh на поканите
  onClose: () => void;  // откажи
}

const RECIPIENT_SIGNING_STEPS: [number, string][] = [
  [5,  'Проверка на поканата'],
  [15, 'Намиране на ключове'],
  [35, 'Биометрична верификация'],
  [55, 'Подписване ECDSA P-256'],
  [75, 'Качване на документа'],
  [100,'Завършено'],
];

export default function RecipientSigningModal({ details, userId, onDone, onClose }: RecipientSigningModalProps) {
  const [stage, setStage] = useState<ModalStage>('confirm');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  const [preflightKeys, setPreflightKeys] = useState<ResolvedKeys | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');

  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [signingError, setSigningError] = useState<string | null>(null);
  const [signingResult, setSigningResult] = useState<RecipientSignResult | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);

  const { recipient, request, documentFilename, ownerName } = details;

  // Signed URL за preview thumbnail — текущата версия (с всички предходни подписи).
  useEffect(() => {
    if (!request.current_signed_storage_path) return;
    supabase.storage.from('signed-documents')
      .createSignedUrl(request.current_signed_storage_path, 300)
      .then(({ data }) => setSignedUrl(data?.signedUrl ?? null));
  }, [request.current_signed_storage_path]);

  useEffect(() => {
    resolveSigningKeys()
      .then(keys => setPreflightKeys(keys))
      .catch(err => setPreflightError(err instanceof Error ? err.message : String(err)));

    supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
      .then(({ data }) => setSignerName(data?.display_name ?? ''));
  }, [userId]);

  const { dataUrl, widthPt, heightPt, loading: thumbLoading, error: thumbError } =
    usePdfThumbnail(signedUrl, request.id, recipient.marker_page);

  const handleSign = useCallback(async () => {
    if (!preflightKeys) return;
    setStage('signing');
    setSigningError(null);
    setSigningResult(null);
    setProgress(0);
    setProgressLabel('');

    const rpId = window.location.hostname;

    try {
      // Нарочно БЕЗ explicit extractPrf/extractDualPrf — signingService използва
      // browserPrfExtractor/browserDualPrfExtractor по подразбиране, които правят
      // НОВ WebAuthn prompt при всяко извикване (нужно за retry loop-а вътре в
      // signAsRecipient()).
      const result = await signAsRecipient(
        recipient.id, userId, signerName, rpId,
        undefined, undefined,
        (pct, label) => { setProgress(pct); setProgressLabel(label); },
      );
      setProgress(100);
      setProgressLabel('Завършено');
      setSigningResult(result);
    } catch (err) {
      setSigningError(err instanceof Error ? err.message : String(err));
    }
  }, [preflightKeys, recipient.id, userId, signerName]);

  const handleDownload = async () => {
    if (!signingResult) return;
    setDownloadLoading(true);
    try {
      const url = await getSignedDownloadUrl(signingResult.signedStoragePath);
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = documentFilename.replace(/\.pdf$/i, '_signed.pdf');
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

  const hasNoCert = preflightKeys !== null && preflightKeys.ecdsaData.certificateDer == null;
  const hasMlDsa = preflightKeys?.mlDsaData != null;
  const blocked = !!preflightError || hasNoCert;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recipient-sign-modal-title"
        className="animate-scaleIn glass-panel w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl shadow-glassLg"
      >
        <p id="recipient-sign-modal-title" className="px-6 pt-4 text-xs font-medium text-neutral-400 tracking-wide uppercase truncate">
          {documentFilename}
        </p>

        {stage === 'confirm' && (
          <div>
            <ModalHeader step={1} totalSteps={2} title="Потвърждение" onClose={onClose} />

            <div className="px-6 py-4 space-y-4">
              <InfoRow label="От" value={ownerName} />
              <InfoRow label="Позиция" value={`Страница ${recipient.marker_page + 1}, X=${recipient.marker_x} pt, Y=${recipient.marker_y} pt`} />
              {signerName && <InfoRow label="Подписващ" value={signerName} />}

              {/* Read-only preview с маркер (не е кликаем — позицията е фиксирана от owner-а) */}
              <div>
                <p className="mb-2 text-xs text-neutral-500">Преглед — вашият подпис ще се появи тук:</p>
                <div className="relative mx-auto overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50" style={{ width: 300 }}>
                  {thumbLoading && (
                    <div className="flex h-48 items-center justify-center text-neutral-400">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    </div>
                  )}
                  {thumbError && !thumbLoading && (
                    <div className="flex h-48 items-center justify-center px-4 text-center text-xs text-red-500">
                      {thumbError}
                    </div>
                  )}
                  {dataUrl && !thumbLoading && (
                    <>
                      <img src={dataUrl} alt={`Страница ${recipient.marker_page + 1}`} className="block w-full" draggable={false} />
                      <div
                        className="absolute h-4 w-4 rounded-full border-2 border-white bg-emerald-600 shadow-md pointer-events-none"
                        style={{
                          left: `${(recipient.marker_x / widthPt) * 100}%`,
                          top: `${(1 - recipient.marker_y / heightPt) * 100}%`,
                          transform: 'translate(-50%, -50%)',
                        }}
                      />
                    </>
                  )}
                </div>
              </div>

              {preflightKeys && (
                <InfoRow
                  label="Алгоритми"
                  value={hasMlDsa ? 'ECDSA P-256 (+ ML-DSA-65 налично, не се ползва за incremental)' : 'ECDSA P-256'}
                />
              )}

              {preflightError && (
                <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
                  <div className="text-xs text-red-700">
                    <p>{preflightError}</p>
                    {/* /invite/ е standalone route без таб навигация — recipient без
                        ключове няма как да стигне до "Ключове" сам, затова директен
                        линк с ?tab=keys (App.tsx MainApp го чете при mount). */}
                    {preflightError.includes('ECDSA P-256 ключ') && (
                      <a href="/?tab=keys" className="mt-1 inline-block font-medium underline hover:text-red-800">
                        Генерирай ключ →
                      </a>
                    )}
                  </div>
                </div>
              )}

              {hasNoCert && (
                <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
                  <div className="text-xs text-red-700">
                    <p>ECDSA ключът няма сертификат. Отидете в „Ключове" → „Издай сертификат".</p>
                    <a href="/?tab=keys" className="mt-1 inline-block font-medium underline hover:text-red-800">
                      Отиди в „Ключове" →
                    </a>
                  </div>
                </div>
              )}

              {!preflightKeys && !preflightError && (
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                  Проверка на ключовете…
                </div>
              )}

              {!blocked && preflightKeys && (
                <div className="flex gap-2 rounded-lg bg-indigo-50 px-3 py-2.5">
                  <Fingerprint size={14} className="mt-0.5 shrink-0 text-indigo-500" />
                  <p className="text-xs text-indigo-700">
                    Браузърът ще поиска биометрично потвърждение (Face ID / Windows Hello / PIN) след натискане на „Подпиши".
                  </p>
                </div>
              )}
            </div>

            <ModalFooter
              onBack={onClose}
              backLabel="Откажи"
              onNext={handleSign}
              nextLabel="Подпиши"
              nextDisabled={blocked || !preflightKeys}
              nextClassName={blocked ? undefined : 'bg-indigo-600 hover:bg-indigo-700 text-white'}
            />
          </div>
        )}

        {stage === 'signing' && (
          <div>
            <ModalHeader
              step={2}
              totalSteps={2}
              title={signingResult ? 'Документът е подписан' : signingError ? 'Грешка' : 'Подписване...'}
            />

            <div className="px-6 py-5 space-y-5">
              {!signingError && (
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

              {!signingError && (
                <ol className="space-y-2">
                  {RECIPIENT_SIGNING_STEPS.map(([pct, label]) => {
                    const done = progress >= pct;
                    const active = !signingResult && progressLabel.startsWith(label.split(' ')[0]) && progress < pct + 20;
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
                      </li>
                    );
                  })}
                </ol>
              )}

              {signingError && (
                <div className="space-y-3">
                  <div role="alert" className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
                    <p className="text-xs text-red-700">{signingError}</p>
                  </div>
                  <button
                    onClick={() => setStage('confirm')}
                    className="w-full rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Опитай отново
                  </button>
                </div>
              )}

              {signingResult && !signingError && (
                <div className="space-y-3">
                  <div role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5">
                    <CheckCircle size={15} className="shrink-0 text-emerald-500" aria-hidden="true" />
                    <p className="text-xs text-emerald-700 font-medium">
                      Документът е подписан успешно.
                      {signingResult.allSigned && ' Всички участници вече са подписали.'}
                    </p>
                  </div>
                  <button
                    onClick={handleDownload}
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
        )}
      </div>
    </div>
  );
}
