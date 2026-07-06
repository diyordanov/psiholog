/**
 * signingKeyStore.ts
 * DB операции за таблица signing_keys: запис, зареждане, soft delete.
 *
 * Bytea конвенция: байтовете се изпращат в Postgres \xhex формат (toByteaHex)
 * и се получават обратно като низ в същия формат (fromByteaHex).
 * Thumbprint-ът се изчислява локално при зареждане — не се пази в DB.
 */
import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';
import { computePublicKeyThumbprint } from './crypto/thumbprint';

export interface SigningKeyRow {
  id: string;
  user_id: string;
  algorithm: 'ed25519' | 'ml-dsa-65';
  public_key: string;       // \xhex от Postgres bytea
  kdf_iterations: number;
  created_at: string;
  deleted_at: string | null;
  thumbprint: string;        // изчислен локално, не е в DB
}

export interface SaveKeyParams {
  userId: string;
  algorithm: 'ed25519' | 'ml-dsa-65';
  publicKey: Uint8Array;
  encryptedSecretKey: Uint8Array;
  kdfSalt: Uint8Array;
  kdfIterations: number;
  aesIv: Uint8Array;
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
 * Записва нов ключ в DB и логва одит събитие.
 * Връща UUID на новия ред.
 */
export async function saveSigningKey(params: SaveKeyParams): Promise<string> {
  const { data, error } = await supabase
    .from('signing_keys')
    .insert({
      user_id: params.userId,
      algorithm: params.algorithm,
      public_key: toByteaHex(params.publicKey),
      encrypted_private_key: toByteaHex(params.encryptedSecretKey),
      kdf_salt: toByteaHex(params.kdfSalt),
      kdf_iterations: params.kdfIterations,
      aes_iv: toByteaHex(params.aesIv),
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
 */
export async function fetchUserSigningKeys(): Promise<SigningKeyRow[]> {
  const { data, error } = await supabase
    .from('signing_keys')
    .select('id, user_id, algorithm, public_key, kdf_iterations, created_at, deleted_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as Omit<SigningKeyRow, 'thumbprint'>[]).map((row) => ({
    ...row,
    thumbprint: computePublicKeyThumbprint(fromByteaHex(row.public_key as string)),
  }));
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
 * Зарежда криптираните данни за декриптиране на secret key.
 * Ползва се при подписване (Фаза 4) — не при листване.
 */
export async function fetchKeyDecryptData(keyId: string): Promise<{
  encryptedSecretKey: Uint8Array;
  kdfSalt: Uint8Array;
  kdfIterations: number;
  aesIv: Uint8Array;
  algorithm: 'ed25519' | 'ml-dsa-65';
}> {
  const { data, error } = await supabase
    .from('signing_keys')
    .select('encrypted_private_key, kdf_salt, kdf_iterations, aes_iv, algorithm')
    .eq('id', keyId)
    .is('deleted_at', null)
    .single();

  if (error || !data) {
    throw new Error(`Ключът не е намерен: ${error?.message ?? 'неизвестна'}`);
  }

  return {
    encryptedSecretKey: fromByteaHex(data.encrypted_private_key as string),
    kdfSalt: fromByteaHex(data.kdf_salt as string),
    kdfIterations: data.kdf_iterations as number,
    aesIv: fromByteaHex(data.aes_iv as string),
    algorithm: data.algorithm as 'ed25519' | 'ml-dsa-65',
  };
}
