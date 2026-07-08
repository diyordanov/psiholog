/**
 * KeyManagement.tsx
 * Страница "Мои ключове" — списък с активните криптографски ключове и генериране на нов.
 *
 * Migration banner: ако потребителят има парола-базирани ключове (prf_salt IS NULL),
 * показваме предупреждение и бутон за soft-delete на всички стари ключове.
 *
 * Auto-retrofit: при зареждане автоматично вика issue-certificate за ключове
 * без сертификат (certificate IS NULL). Провалите се показват с ⚠️ в KeyCard.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, RefreshCw, KeyRound, AlertTriangle, Fingerprint } from 'lucide-react';
import {
  fetchUserSigningKeys,
  softDeleteSigningKey,
  softDeleteLegacyPasswordKeys,
  type SigningKeyRow,
} from '../../lib/signingKeyStore';
import { retrofitMissingCerts } from '../../lib/certificateService';
import KeyCard from './KeyCard';
import GenerateKeyModal from './GenerateKeyModal';

interface KeyManagementProps {
  userId: string;
}

export default function KeyManagement({ userId }: KeyManagementProps) {
  const [keys, setKeys] = useState<SigningKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [confirmMigration, setConfirmMigration] = useState(false);

  // Предотвратява двойно извикване на retrofit при StrictMode double-mount
  const retrofitRunRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await fetchUserSigningKeys();
      setKeys(fetched);
      return fetched;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Грешка при зареждане.');
      return [] as SigningKeyRow[];
    } finally {
      setLoading(false);
    }
  }, []);

  // При първоначално зареждане: fetch → retrofit на ключове без сертификат
  useEffect(() => {
    if (retrofitRunRef.current) return;
    retrofitRunRef.current = true;

    load().then(async (fetched) => {
      const missingCertIds = fetched
        .filter((k) => k.isPrfBased && k.certStatus === 'missing')
        .map((k) => k.id);

      if (missingCertIds.length === 0) return;

      await retrofitMissingCerts(missingCertIds);
      // Презареждаме за да отразим новите certificate_expires_at стойности
      await load();
    });
  }, [load]);

  const handleDelete = async (keyId: string) => {
    await softDeleteSigningKey(keyId, userId);
    setKeys((prev) => prev.filter((k) => k.id !== keyId));
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setError(null);
    try {
      await softDeleteLegacyPasswordKeys(userId);
      setConfirmMigration(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Грешка при миграция.');
    } finally {
      setMigrating(false);
    }
  };

  const existingAlgorithms = keys.map((k) => k.algorithm);
  const legacyKeys = keys.filter((k) => !k.isPrfBased);
  const hasLegacyKeys = legacyKeys.length > 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Заглавие + бутон */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-800">Мои ключове</h1>
        <div className="flex gap-2">
          <button
            onClick={() => { retrofitRunRef.current = false; load(); }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Обнови
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={14} />
            Генерирай нов ключ
          </button>
        </div>
      </div>

      {/* Migration banner */}
      {hasLegacyKeys && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800">
                Имате {legacyKeys.length} {legacyKeys.length === 1 ? 'ключ' : 'ключа'} с остарял формат
              </p>
              <p className="mt-1 text-xs text-amber-700">
                Тези ключове са защитени с парола — функционалност, която е премахната.
                Трябва да ги изтриете и да генерирате нови, защитени с вашия passkey (Face ID / Windows Hello).
                Вече подписани документи остават валидни завинаги.
              </p>

              {!confirmMigration ? (
                <button
                  onClick={() => setConfirmMigration(true)}
                  className="mt-3 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                >
                  Изтрий остарелите ключове
                </button>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <p className="text-xs font-medium text-amber-800">Сигурни ли сте?</p>
                  <button
                    onClick={handleMigrate}
                    disabled={migrating}
                    className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {migrating && <RefreshCw size={10} className="animate-spin" />}
                    Да, изтрий ги
                  </button>
                  <button
                    onClick={() => setConfirmMigration(false)}
                    className="rounded-lg px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-100"
                  >
                    Откажи
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Грешка */}
      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {/* Списък */}
      {loading && keys.length === 0 ? (
        <div className="flex justify-center py-12 text-neutral-400">
          <RefreshCw size={20} className="animate-spin" />
        </div>
      ) : keys.filter((k) => k.isPrfBased).length === 0 && !hasLegacyKeys ? (
        <div className="flex flex-col items-center gap-3 py-16 text-neutral-400">
          <KeyRound size={32} strokeWidth={1.5} />
          <p className="text-sm">Все още нямате генерирани ключове</p>
          <p className="max-w-xs text-center text-xs text-neutral-400">
            Ключовете се ползват за криптографско подписване на документи.
            Генерирайте поне един Ed25519 и един ML-DSA-65 ключ, за да можете да подписвате.
          </p>
          <div className="flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            <Fingerprint size={13} />
            Ключовете се защитават с вашия passkey — без парола
          </div>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-neutral-400">
            Fingerprint = SHA-256 от публичния ключ, първите 8 байта, base64url. Служи само за визуална идентификация.
          </p>
          <div className="divide-y divide-neutral-100 rounded-xl border border-neutral-100 bg-white shadow-sm">
            {keys.map((key) => (
              <KeyCard key={key.id} signingKey={key} onDelete={handleDelete} />
            ))}
          </div>
        </>
      )}

      {/* Modal */}
      {showModal && (
        <GenerateKeyModal
          userId={userId}
          existingAlgorithms={existingAlgorithms}
          onKeyGenerated={() => { retrofitRunRef.current = false; load(); }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
