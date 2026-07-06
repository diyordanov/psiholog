/**
 * signing.ts
 * Подписване и верификация за Ed25519 и ML-DSA-65.
 *
 * Всички функции са async за еднаков интерфейс — ML-DSA вътрешно е sync,
 * но Promise.resolve() го обгръща без overhead.
 *
 * Конвенция: data е вече хеширан (SHA-256) масив от байтове.
 * Тук не хешираме — отговорността е на caller-а.
 */
import { signAsync, verifyAsync } from '@noble/ed25519';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

/** Подписва data с Ed25519 secretKey. Връща 64-byte подпис. */
export async function signWithEd25519(
  secretKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return signAsync(data, secretKey);
}

/**
 * Верифицира Ed25519 подпис.
 * Връща false при невалиден подпис — не хвърля, за да може caller-ът да
 * покаже ясно "невалиден" вместо да handle-ва exception.
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await verifyAsync(signature, data, publicKey);
  } catch {
    return false;
  }
}

/**
 * Подписва data с ML-DSA-65 secretKey. Връща ~3309-byte подпис.
 * Noble post-quantum v0.6+ API: sign(msg, secretKey) — съобщението е ПЪРВО.
 */
export async function signWithMlDsa(
  secretKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return Promise.resolve(ml_dsa65.sign(data, secretKey));
}

/**
 * Верифицира ML-DSA-65 подпис. Връща false при невалиден подпис — не хвърля.
 * Noble post-quantum v0.6+ API: verify(signature, msg, publicKey) — подписът е ПЪРВО.
 */
export async function verifyMlDsa(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return Promise.resolve(ml_dsa65.verify(signature, data, publicKey));
  } catch {
    return false;
  }
}
