/**
 * signing.ts
 * Подписване и верификация за Ed25519 и ML-DSA-65.
 *
 * Чисти функции (signWithEd25519, signWithMlDsa, verify*): приемат raw bytes.
 * Интегрирана функция (signWithStoredKey): PRF ceremony → decrypt → sign → clear.
 *
 * Конвенция: data е вече хеширан (SHA-256) масив от байтове.
 * Тук не хешираме — отговорността е на caller-а.
 */
import { signAsync, verifyAsync } from '@noble/ed25519';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { type PrfExtractor, deriveAesKeyFromPRF, decryptPrivateKey } from './keyProtection';
import { fetchKeyDecryptData } from '../signingKeyStore';

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

/**
 * Интегрирана функция за Фаза 4: зарежда ключ от DB, прави PRF ceremony,
 * декриптира secretKey, подписва data, изчиства паметта.
 *
 * @param signingKeyId  UUID на ключа в signing_keys таблицата
 * @param data          SHA-256 хеш на документа (32 bytes)
 * @param rpId          WebAuthn RP ID (window.location.hostname в браузъра)
 * @param extractPrf    Injectable за тестове; default: browserPrfExtractor
 */
export async function signWithStoredKey(
  signingKeyId: string,
  data: Uint8Array,
  rpId: string,
  extractPrf?: PrfExtractor,
): Promise<Uint8Array> {
  const { encryptedSecretKey, prfSalt, wrappedKeyIv, credentialId, algorithm } =
    await fetchKeyDecryptData(signingKeyId);

  const { aesKey } = await deriveAesKeyFromPRF(prfSalt, rpId, credentialId, extractPrf);
  const secretKey = await decryptPrivateKey(encryptedSecretKey, aesKey, wrappedKeyIv);

  try {
    if (algorithm === 'ed25519') {
      return await signWithEd25519(secretKey, data);
    } else {
      return await signWithMlDsa(secretKey, data);
    }
  } finally {
    secretKey.fill(0); // изчистваме от паметта независимо от изхода
  }
}
