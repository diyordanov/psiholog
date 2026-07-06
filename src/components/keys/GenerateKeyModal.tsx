/**
 * GenerateKeyModal.tsx
 * Модал за генериране на нов криптографски ключ.
 *
 * Pipeline:
 *   1. Потребителят избира алгоритъм и въвежда парола (live валидация)
 *   2. При "Генерирай": rate limit проверка → keypair generation
 *      - Ed25519: на main thread (~1ms), незабележимо
 *      - ML-DSA-65: в Web Worker (2–15s) с бутон "Отмени"
 *   3. Keypair → PBKDF2 деривация → AES-GCM криптиране → INSERT в DB
 *   4. При успех: modal се затваря, списъкът се обновява
 *
 * Rate limiting: max 1 генериране на 5 секунди (module-level, предотвратява double-click).
 */
import { useState, useRef, useCallback } from 'react';
import { X, Eye, EyeOff, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import MlDsaWorker from '../../workers/mlDsaKeygen.worker.ts?worker';
import { generateEd25519Keypair } from '../../lib/crypto/keyGeneration';
import { deriveKeyFromPassword, encryptPrivateKey } from '../../lib/crypto/keyProtection';
import { saveSigningKey } from '../../lib/signingKeyStore';

// Module-level: предотвратява double-click да стартира 2 генерирания наведнъж
let lastGenerationAttempt = 0;

interface GenerateKeyModalProps {
  userId: string;
  existingAlgorithms: ('ed25519' | 'ml-dsa-65')[];
  onKeyGenerated: () => void;
  onClose: () => void;
}

type Stage = 'form' | 'generating' | 'error';

interface PasswordRules {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
}

function checkPassword(pw: string): PasswordRules {
  return {
    minLength: pw.length >= 12,
    hasUpper: /[A-Z]/.test(pw),
    hasLower: /[a-z]/.test(pw),
    hasDigit: /[0-9]/.test(pw),
  };
}

export default function GenerateKeyModal({
  userId,
  existingAlgorithms,
  onKeyGenerated,
  onClose,
}: GenerateKeyModalProps) {
  const [algorithm, setAlgorithm] = useState<'ed25519' | 'ml-dsa-65'>('ed25519');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [stage, setStage] = useState<Stage>('form');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);

  const rules = checkPassword(password);
  const isPasswordValid = Object.values(rules).every(Boolean);
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const hasDuplicateAlgorithm = existingAlgorithms.includes(algorithm);
  const canSubmit = isPasswordValid && passwordsMatch && stage === 'form';

  // Затваряме modal само ако не генерираме в момента
  const handleClose = () => {
    if (stage === 'generating') return;
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

  const finalizeKeyGeneration = useCallback(async (keypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }) => {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const derivedKey = await deriveKeyFromPassword(password, salt, 600_000);
      const encryptedSecretKey = await encryptPrivateKey(keypair.secretKey, derivedKey, iv);

      // Изчистваме secret key от паметта веднага след криптирането
      keypair.secretKey.fill(0);

      await saveSigningKey({
        userId,
        algorithm,
        publicKey: keypair.publicKey,
        encryptedSecretKey,
        kdfSalt: salt,
        kdfIterations: 600_000,
        aesIv: iv,
      });

      onKeyGenerated();
      onClose();
    } catch (err) {
      setStage('error');
      setErrorMessage(err instanceof Error ? err.message : 'Грешка при запазване на ключа.');
    }
  }, [password, userId, algorithm, onKeyGenerated, onClose]);

  const handleGenerate = async () => {
    // Rate limit: 5 сек между опити
    const now = Date.now();
    const elapsed = now - lastGenerationAttempt;
    if (elapsed < 5000) {
      setErrorMessage(`Изчакайте ${Math.ceil((5000 - elapsed) / 1000)} сек. преди следващ опит.`);
      setStage('error');
      return;
    }
    lastGenerationAttempt = now;

    setStage('generating');
    setErrorMessage(null);

    if (algorithm === 'ml-dsa-65') {
      // ML-DSA-65 в Web Worker — не блокира UI thread
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
      // Ed25519 на main thread — под 10ms, UI не забелязва
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
          {stage !== 'generating' && (
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
                title="Ed25519"
                description="Бърз · компактен (32-byte ключ)"
                tag="Класически"
              />
              <AlgorithmOption
                id="ml-dsa-65"
                selected={algorithm === 'ml-dsa-65'}
                onClick={() => setAlgorithm('ml-dsa-65')}
                title="ML-DSA-65"
                description="Бавно генериране · голям ключ (1952 bytes)"
                tag="Пост-квантов"
              />
            </div>
          </div>

          {/* Warning при дублиран алгоритъм */}
          {hasDuplicateAlgorithm && (
            <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <p className="text-xs text-amber-700">
                Вече имате активен <strong>{algorithm === 'ed25519' ? 'Ed25519' : 'ML-DSA-65'}</strong> ключ.
                Препоръчваме един ключ на алгоритъм. Ако генерирате нов, старите подписи
                остават верифицируеми, но при бъдещи подписвания ще трябва да избирате кой ключ да ползвате.
              </p>
            </div>
          )}

          {/* Полета за парола */}
          <div className="space-y-3">
            <PasswordField
              label="Ключова парола"
              value={password}
              onChange={setPassword}
              show={showPw}
              onToggleShow={() => setShowPw((v) => !v)}
              disabled={stage === 'generating'}
            />

            {/* Live password strength чеклист */}
            {password.length > 0 && (
              <ul className="space-y-1 pl-1">
                {(
                  [
                    [rules.minLength, 'Минимум 12 символа'],
                    [rules.hasUpper, 'Поне 1 главна буква'],
                    [rules.hasLower, 'Поне 1 малка буква'],
                    [rules.hasDigit, 'Поне 1 цифра'],
                  ] as [boolean, string][]
                ).map(([ok, label]) => (
                  <li key={label} className={`flex items-center gap-1.5 text-xs ${ok ? 'text-emerald-600' : 'text-neutral-400'}`}>
                    <Check size={11} className={ok ? 'text-emerald-500' : 'text-neutral-300'} />
                    {label}
                  </li>
                ))}
              </ul>
            )}

            <PasswordField
              label="Потвърди паролата"
              value={confirmPassword}
              onChange={setConfirmPassword}
              show={showPw}
              onToggleShow={() => setShowPw((v) => !v)}
              disabled={stage === 'generating'}
            />

            {/* Inline съобщение при несъвпадане */}
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-xs text-red-500">Паролите не съвпадат.</p>
            )}
          </div>

          {/* Warning за загубена парола */}
          <p className="rounded-lg bg-neutral-50 px-3 py-2.5 text-xs text-neutral-500">
            ⚠ Ако забравите тази парола, ще трябва да генерирате нов ключ.
            Старите подписи остават верифицируеми.
          </p>

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
          {stage === 'generating' ? (
            <div className="flex flex-col items-center gap-3">
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
          ) : (
            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Откажи
              </button>
              <button
                onClick={handleGenerate}
                disabled={!canSubmit}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
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
  title: string;
  description: string;
  tag: string;
}

function AlgorithmOption({ selected, onClick, title, description, tag }: AlgorithmOptionProps) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border-2 px-3 py-3 text-left transition-colors ${
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

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  disabled: boolean;
}

function PasswordField({ label, value, onChange, show, onToggleShow, disabled }: PasswordFieldProps) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600">{label}</label>
      <div className="flex items-center rounded-lg border border-neutral-200 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-200">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 rounded-lg bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-50"
          autoComplete="new-password"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="px-3 text-neutral-400 hover:text-neutral-600"
          tabIndex={-1}
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}
