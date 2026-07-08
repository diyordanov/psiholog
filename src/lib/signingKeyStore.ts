/**
 * signingKeyStore.ts
 * DB операции за таблица signing_keys: запис, зареждане, soft delete.
 *
 * Bytea конвенция: байтовете се изпращат в Postgres \xhex формат (toByteaHex)
 * и се получават обратно като низ в същия формат (fromByteaHex).
 * Thumbprint-ът се изчислява локално при зареждане — не се пази в DB.
 *
 * PRF миграция (0006): нови ключове ползват prf_salt + wrapped_key_iv + credential_id.
 * Стари (парола-базирани) ключове имат prf_salt IS NULL — показват migration banner.
 */
import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';
import { computePublicKeyThumbprint } from './crypto/thumbprint';

export interface SigningKeyRow {
  id: string;
  user_id: string;
  algorithm: 'ed25519' | 'ml-dsa-65';
  public_key: string;       // \xhex от Postgres bytea
  kdf_iterations: number | null;
  created_at: string;
  deleted_at: string | null;
  thumbprint: string;        // изчислен локално
  isPrfBased: boolean;       // true = PRF ключ; false = стар парола-базиран (migration needed)
  // Фаза 3.5 — сертификат
  hasCertificate: boolean;          // true ако certificate IS NOT NULL в DB
  certificateExpiresAt: string | null; // ISO timestamp
  certStatus: CertStatus;           // изчислен локално при зареждане
}

/** Статус на сертификата — изчислява се клиентски от certificate_expires_at. */
export type CertStatus = 'ok' | 'expiring-soon' | 'expired' | 'missing';

/** Изчислява certStatus от certificate_expires_at (или null ако липсва). */
export function computeCertStatus(expiresAt: string | null): CertStatus {
  if (!expiresAt) return 'missing';
  const expiry = new Date(expiresAt);
  const now = new Date();
  if (expiry < now) return 'expired';
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  if (expiry < thirtyDays) return 'expiring-soon';
  return 'ok';
}

export interface SaveKeyParams {
  userId: string;
  algorithm: 'ed25519' | 'ml-dsa-65';
  publicKey: Uint8Array;
  encryptedSecretKey: Uint8Array;
  prfSalt: Uint8Array;       // 32 bytes, per-key PRF input
  wrappedKeyIv: Uint8Array;  // 12 bytes, IV за AES-GCM
  credentialId: Uint8Array;  // WebAuthn credential rawId
}

/** Uint8Array → '\xhex' за Postgres bytea INSERT. */
export function toByteaHex(bytes: Uint8Array): string {
  return '\\x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * '\xhex' от Postgres bytea SELECT → Uint8Array.
 * Supabase връща bytea като низ с един backslash: \xdeadbeef
 */
export function fromByteaHex(hex: string): Uint8Array {
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Записва нов PRF-базиран ключ в DB и логва одит събитие.
 * Връща UUID на новия ред.
 */
export async function saveSigningKey(params: SaveKeyParams): Promise<string> {
  // credential_id се пази като base64url (text колона)
  const credentialIdBase64 = btoa(String.fromCharCode(...params.credentialId))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const { data, error } = await supabase
    .from('signing_keys')
    .insert({
      user_id: params.userId,
      algorithm: params.algorithm,
      public_key: toByteaHex(params.publicKey),
      encrypted_private_key: toByteaHex(params.encryptedSecretKey),
      prf_salt: toByteaHex(params.prfSalt),
      wrapped_key_iv: toByteaHex(params.wrappedKeyIv),
      credential_id: credentialIdBase64,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Грешка при записване на ключа: ${error?.message ?? 'неизвестна'}`);
  }

  await logAuditEvent(params.userId, 'signing_key_generated', data.id as string);
  return data.id as string;
}

/**
 * Зарежда активните ключове на текущия потребител.
 * Thumbprint-ът се изчислява клиентски от public_key.
 * isPrfBased = true ако prf_salt е попълнен (PRF ключ), false = стар парола-базиран.
 */
export async function fetchUserSigningKeys(): Promise<SigningKeyRow[]> {
  const { data, error } = await supabase
    .from('signing_keys')
    .select('id, user_id, algorithm, public_key, kdf_iterations, prf_salt, certificate_expires_at, created_at, deleted_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as (Omit<SigningKeyRow, 'thumbprint' | 'isPrfBased' | 'hasCertificate' | 'certificateExpiresAt' | 'certStatus'> & {
    prf_salt: string | null;
    certificate_expires_at: string | null;
  })[]).map((row) => {
    const expiresAt = row.certificate_expires_at ?? null;
    return {
      ...row,
      thumbprint: computePublicKeyThumbprint(fromByteaHex(row.public_key as string)),
      isPrfBased: row.prf_salt !== null,
      hasCertificate: expiresAt !== null,
      certificateExpiresAt: expiresAt,
      certStatus: computeCertStatus(expiresAt),
    };
  });
}

/** Soft-изтрива ключ — поставя deleted_at timestamp. */
export async function softDeleteSigningKey(keyId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('signing_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', keyId);

  if (error) throw new Error(`Грешка при изтриване на ключа: ${error.message}`);

  await logAuditEvent(userId, 'signing_key_deleted', keyId);
}

/**
 * Soft-изтрива всички парола-базирани ключове на потребителя.
 * Вика се от migration banner когато потребителят потвърди.
 * Връща броя изтрити ключове.
 */
export async function softDeleteLegacyPasswordKeys(userId: string): Promise<number> {
  // Зареждаме всички активни парола-базирани ключове (prf_salt IS NULL)
  // Използваме service-layer SELECT (RLS ги ограничава до own keys автоматично)
  const { data: legacyKeys, error: fetchError } = await supabase
    .from('signing_keys')
    .select('id')
    .is('deleted_at', null)
    .is('prf_salt', null);

  if (fetchError) throw new Error(`Грешка при зареждане: ${fetchError.message}`);
  if (!legacyKeys || legacyKeys.length === 0) return 0;

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('signing_keys')
    .update({ deleted_at: now })
    .is('deleted_at', null)
    .is('prf_salt', null);

  if (updateError) throw new Error(`Грешка при изтриване: ${updateError.message}`);

  // Логваме по един audit event за всеки изтрит ключ
  await Promise.all(
    legacyKeys.map((k: { id: string }) =>
      logAuditEvent(userId, 'signing_key_deleted', k.id),
    ),
  );

  return legacyKeys.length;
}

/**
 * Зарежда криптираните PRF данни за декриптиране на secret key при подписване (Фаза 4).
 */
export async function fetchKeyDecryptData(keyId: string): Promise<{
  encryptedSecretKey: Uint8Array;
  prfSalt: Uint8Array;
  wrappedKeyIv: Uint8Array;
  credentialId: Uint8Array;
  algorithm: 'ed25519' | 'ml-dsa-65';
}> {
  const { data, error } = await supabase
    .from('signing_keys')
    .select('encrypted_private_key, prf_salt, wrapped_key_iv, credential_id, algorithm')
    .eq('id', keyId)
    .is('deleted_at', null)
    .single();

  if (error || !data) {
    throw new Error(`Ключът не е намерен: ${error?.message ?? 'неизвестна'}`);
  }

  if (!data.prf_salt || !data.wrapped_key_iv || !data.credential_id) {
    throw new Error('Ключът е парола-базиран и не може да се ползва. Генерирайте нов ключ.');
  }

  // credential_id е base64url text → Uint8Array
  const credentialIdBase64 = (data.credential_id as string)
    .replace(/-/g, '+').replace(/_/g, '/');
  const credentialIdBytes = Uint8Array.from(atob(credentialIdBase64), (c) => c.charCodeAt(0));

  return {
    encryptedSecretKey: fromByteaHex(data.encrypted_private_key as string),
    prfSalt: fromByteaHex(data.prf_salt as string),
    wrappedKeyIv: fromByteaHex(data.wrapped_key_iv as string),
    credentialId: credentialIdBytes,
    algorithm: data.algorithm as 'ed25519' | 'ml-dsa-65',
  };
}
