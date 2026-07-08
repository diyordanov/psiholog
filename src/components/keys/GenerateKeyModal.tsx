/**
 * GenerateKeyModal.tsx
 * Модал за генериране на нов криптографски ключ.
 *
 * Pipeline (PRF-базиран, Section 3.2):
 *   1. Потребителят избира алгоритъм и кликва „Генерирай"
 *   2. Ed25519: keygen на main thread (~1ms)
 *      ML-DSA-65: keygen в Web Worker (2–15s) с бутон „Отмени"
 *   3. Генерираме prf_salt (32 bytes) + wrapped_key_iv (12 bytes)
 *   4. Passkey ceremony: браузърът показва Face ID / Windows Hello / PIN
 *      → WebAuthn PRF → HKDF → AES-256 ключ + credential_id
 *   5. AES-GCM криптираме secretKey → записваме в DB → затваряме
 *
 * Паролата е премахната напълно. НЯМА password поле.
 */
import { useState, useRef, useCallback } from 'react';
import { X, AlertTriangle, RefreshCw, Fingerprint } from 'lucide-react';
import MlDsaWorker from '../../workers/mlDsaKeygen.worker.ts?worker';
import { generateEd25519Keypair } from '../../lib/crypto/keyGeneration';
import { deriveAesKeyFromPRF, encryptPrivateKey } from '../../lib/crypto/keyProtection';
import { saveSigningKey } from '../../lib/signingKeyStore';
import { issueCertificate } from '../../lib/certificateService';

// Module-level: предотвратява double-click двойно генериране (5 сек throttle)
let lastGenerationAttempt = 0;

interface GenerateKeyModalProps {
  userId: string;
  existingAlgorithms: ('ed25519' | 'ml-dsa-65')[];
  onKeyGenerated: () => void;
  onClose: () => void;
}

type Stage = 'form' | 'generating-key' | 'awaiting-passkey' | 'encrypting' | 'error';

export default function GenerateKeyModal({
  userId,
  existingAlgorithms,
  onKeyGenerated,
  onClose,
}: GenerateKeyModalProps) {
  const [algorithm, setAlgorithm] = useState<'ed25519' | 'ml-dsa-65'>('ed25519');
  const [stage, setStage] = useState<Stage>('form');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);

  const hasDuplicateAlgorithm = existingAlgorithms.includes(algorithm);
  const isGenerating = stage !== 'form' && stage !== 'error';

  const handleClose = () => {
    if (isGenerating) return;
    onClose();
  };

  const handleCancel = () => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setStage('form');
    setErrorMessage(null);
  };

  /**
   * Финализира генерирането: PRF ceremony → AES encrypt → DB запис.
   * Вика се след успешно keypair generation (от Worker или Ed25519).
   */
  const finalizeKeyGeneration = useCallback(async (keypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }) => {
    try {
      setStage('awaiting-passkey');

      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // PRF ceremony: браузърът показва passkey prompt (Face ID / Windows Hello / PIN)
      const { aesKey, credentialId } = await deriveAesKeyFromPRF(
        prfSalt,
        window.location.hostname,
      );

      setStage('encrypting');

      const encryptedSecretKey = await encryptPrivateKey(keypair.secretKey, aesKey, iv);
      keypair.secretKey.fill(0); // изчистваме secretKey веднага след криптиране

      const signingKeyId = await saveSigningKey({
        userId,
        algorithm,
        publicKey: keypair.publicKey,
        encryptedSecretKey,
        prfSalt,
        wrappedKeyIv: iv,
        credentialId,
      });

      // Издаване на сертификат — fire-and-forget.
      // При провал: KeyManagement ще покаже ⚠️ и ще retry при следващо зареждане.
      issueCertificate(signingKeyId).catch((err) => {
        console.warn('Сертификатът не беше издаден автоматично:', err);
      });

      onKeyGenerated();
      onClose();
    } catch (err) {
      keypair.secretKey.fill(0); // изчистваме и при грешка
      setStage('error');
      setErrorMessage(err instanceof Error ? err.message : 'Грешка при запазване на ключа.');
    }
  }, [userId, algorithm, onKeyGenerated, onClose]);

  const handleGenerate = async () => {
    const now = Date.now();
    const elapsed = now - lastGenerationAttempt;
    if (elapsed < 5000) {
      setErrorMessage(`Изчакайте ${Math.ceil((5000 - elapsed) / 1000)} сек. преди следващ опит.`);
      setStage('error');
      return;
    }
    lastGenerationAttempt = now;

    setStage('generating-key');
    setErrorMessage(null);

    if (algorithm === 'ml-dsa-65') {
      const worker = new MlDsaWorker();
      workerRef.current = worker;

      worker.onmessage = async (e: MessageEvent<{
        ok: boolean;
        publicKey?: Uint8Array;
        secretKey?: Uint8Array;
        error?: string;
      }>) => {
        workerRef.current = null;
        const { ok, publicKey, secretKey, error } = e.data;
        if (!ok || !publicKey || !secretKey) {
          setStage('error');
          setErrorMessage(error ?? 'Worker грешка при генериране на ML-DSA-65 ключ.');
          worker.terminate();
          return;
        }
        await finalizeKeyGeneration({ publicKey, secretKey });
        worker.terminate();
      };

      worker.onerror = (e) => {
        workerRef.current = null;
        setStage('error');
        setErrorMessage(`Worker грешка: ${e.message}`);
      };

      worker.postMessage(null);
    } else {
      try {
        const keypair = await generateEd25519Keypair();
        await finalizeKeyGeneration(keypair);
      } catch (err) {
        setStage('error');
        setErrorMessage(err instanceof Error ? err.message : 'Грешка при генериране на Ed25519 ключ.');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-800">Генерирай нов ключ</h2>
          {!isGenerating && (
            <button onClick={handleClose} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100">
              <X size={18} />
            </button>
          )}
        </div>

        <div className="px-6 py-5 space-y-5">

          {/* Избор на алгоритъм */}
          <div>
            <p className="mb-2.5 text-sm font-medium text-neutral-700">Алгоритъм</p>
            <div className="grid grid-cols-2 gap-3">
              <AlgorithmOption
                id="ed25519"
                selected={algorithm === 'ed25519'}
                onClick={() => setAlgorithm('ed25519')}
                disabled={isGenerating}
                title="Ed25519"
                description="Бърз · компактен (32-byte ключ)"
                tag="Класически"
              />
              <AlgorithmOption
                id="ml-dsa-65"
                selected={algorithm === 'ml-dsa-65'}
                onClick={() => setAlgorithm('ml-dsa-65')}
                disabled={isGenerating}
                title="ML-DSA-65"
                description="Бавно генериране · голям ключ (1952 bytes)"
                tag="Пост-квантов"
              />
            </div>
          </div>

          {/* Warning при дублиран алгоритъм */}
          {hasDuplicateAlgorithm && !isGenerating && (
            <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <p className="text-xs text-amber-700">
                Вече имате активен <strong>{algorithm === 'ed25519' ? 'Ed25519' : 'ML-DSA-65'}</strong> ключ.
                Препоръчваме един ключ на алгоритъм. При подписване се ползва най-новият активен ключ.
              </p>
            </div>
          )}

          {/* Passkey info */}
          {!isGenerating && (
            <div className="flex gap-2 rounded-lg bg-indigo-50 px-3 py-2.5">
              <Fingerprint size={15} className="mt-0.5 shrink-0 text-indigo-500" />
              <p className="text-xs text-indigo-700">
                Ключът ще бъде защитен с вашия passkey (Face ID / Windows Hello / PIN).
                Браузърът ще поиска потвърждение след генерирането.
              </p>
            </div>
          )}

          {/* Статус при генериране */}
          {stage === 'generating-key' && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="flex items-center gap-2 text-sm text-neutral-500">
                <RefreshCw size={14} className="animate-spin" />
                {algorithm === 'ml-dsa-65'
                  ? 'Генерираме пост-квантов ключ… (може да отнеме до 15 сек)'
                  : 'Генерираме ключ…'}
              </div>
              {algorithm === 'ml-dsa-65' && (
                <button
                  onClick={handleCancel}
                  className="text-xs text-neutral-400 underline underline-offset-2 hover:text-neutral-600"
                >
                  Отмени
                </button>
              )}
            </div>
          )}

          {stage === 'awaiting-passkey' && (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-indigo-600">
              <Fingerprint size={16} className="animate-pulse" />
              Потвърдете с passkey (Face ID / Windows Hello / PIN)…
            </div>
          )}

          {stage === 'encrypting' && (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-neutral-500">
              <RefreshCw size={14} className="animate-spin" />
              Записваме ключа…
            </div>
          )}

          {/* Грешка */}
          {stage === 'error' && errorMessage && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
              <p className="text-xs text-red-700">{errorMessage}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-100 px-6 py-4">
          {isGenerating && stage !== 'generating-key' ? null : isGenerating ? null : (
            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Откажи
              </button>
              <button
                onClick={handleGenerate}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Генерирай
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface AlgorithmOptionProps {
  id: string;
  selected: boolean;
  onClick: () => void;
  disabled: boolean;
  title: string;
  description: string;
  tag: string;
}

function AlgorithmOption({ selected, onClick, disabled, title, description, tag }: AlgorithmOptionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border-2 px-3 py-3 text-left transition-colors disabled:opacity-50 ${
        selected
          ? 'border-indigo-500 bg-indigo-50'
          : 'border-neutral-200 hover:border-neutral-300'
      }`}
    >
      <p className={`text-sm font-semibold ${selected ? 'text-indigo-700' : 'text-neutral-700'}`}>
        {title}
      </p>
      <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
        selected ? 'bg-indigo-100 text-indigo-600' : 'bg-neutral-100 text-neutral-500'
      }`}>
        {tag}
      </span>
      <p className="mt-1.5 text-xs text-neutral-400">{description}</p>
    </button>
  );
}
