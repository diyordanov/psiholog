import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { type PrfExtractor, deriveAesKeyFromPRF, decryptPrivateKey } from './keyProtection';
import { fetchKeyDecryptData } from '../signingKeyStore';

/**
 * Подписва data с ECDSA P-256.
 * secretKey = PKCS8 DER байтове (от generateEcdsaKeypair или дешифриран от DB).
 * Връща P1363 подпис (64 байта: r||s) — WebCrypto native формат.
 * buildCmsDetached() конвертира P1363 → DER при нужда.
 */
export async function signWithEcdsaP256(
  secretKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(secretKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(data));
  return new Uint8Array(sigBuf); // P1363: 64 байта
}

/**
 * Верифицира ECDSA P-256 подпис.
 * publicKey = 65-байта raw uncompressed point (0x04 || x || y).
 * signature = P1363 (64 байта r||s).
 * Връща false при невалиден подпис — не хвърля.
 */
export async function verifyEcdsaP256(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(signature), new Uint8Array(data));
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
 * Интегрирана функция: зарежда ключ от DB, прави PRF ceremony,
 * декриптира secretKey, подписва data, изчиства паметта.
 *
 * @param signingKeyId  UUID на ключа в signing_keys таблицата
 * @param data          Байтовете за подписване (напр. signedAttrs SET за CMS)
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
    if (algorithm === 'ecdsa-p256') {
      return await signWithEcdsaP256(secretKey, data);
    } else {
      return await signWithMlDsa(secretKey, data);
    }
  } finally {
    secretKey.fill(0);
  }
}
