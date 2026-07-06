/**
 * KeyManagement.tsx
 * Страница "Мои ключове" — списък с активните криптографски ключове и генериране на нов.
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, RefreshCw, KeyRound } from 'lucide-react';
import {
  fetchUserSigningKeys,
  softDeleteSigningKey,
  type SigningKeyRow,
} from '../../lib/signingKeyStore';
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await fetchUserSigningKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Грешка при зареждане.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (keyId: string) => {
    await softDeleteSigningKey(keyId, userId);
    setKeys((prev) => prev.filter((k) => k.id !== keyId));
  };

  // Алгоритмите на текущите активни ключове — за warning при дублиране в модала
  const existingAlgorithms = keys.map((k) => k.algorithm);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Заглавие + бутон */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-800">Мои ключове</h1>
        <div className="flex gap-2">
          <button
            onClick={load}
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

      {/* Грешка */}
      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {/* Списък */}
      {loading && keys.length === 0 ? (
        <div className="flex justify-center py-12 text-neutral-400">
          <RefreshCw size={20} className="animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-neutral-400">
          <KeyRound size={32} strokeWidth={1.5} />
          <p className="text-sm">Все още нямате генерирани ключове</p>
          <p className="max-w-xs text-center text-xs text-neutral-400">
            Ключовете се ползват за криптографско подписване на документи.
            Генерирайте поне един, за да можете да подписвате.
          </p>
        </div>
      ) : (
        <>
          {/* Информационна лента — обяснение на thumbprint */}
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
          onKeyGenerated={() => { load(); }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
