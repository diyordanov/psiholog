/**
 * thumbprint.ts
 * Кратък "fingerprint" на публичен ключ за показване в UI.
 *
 * Алгоритъм: SHA-256(publicKey) → първите 8 байта → base64url без padding.
 * Пример: "a3Kx9P-rTmU"
 * Детерминистичен — един ключ винаги дава един и същи thumbprint.
 * Не е collision-safe за security употреба — само за визуална идентификация.
 */
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Изчислява thumbprint на подадения публичен ключ (raw байтове — за ECDSA 65-байта
 * uncompressed point, за ML-DSA raw public key). Виж алгоритъма във file-level коментара.
 */
export function computePublicKeyThumbprint(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  // base64url без padding: заменяме +/= за URL-friendly display в UI
  return btoa(String.fromCharCode(...hash.slice(0, 8)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
