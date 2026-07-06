/**
 * keyProtection.ts
 * Деривация на ключ от парола (PBKDF2-SHA256) и AES-256-GCM криптиране на private key.
 * Ползва само Web Crypto API (вградено в браузъра/Node 18+) — без external зависимости.
 *
 * Архитектурна бележка (PROJECT_BRIEF.md Section 3.2 — Approach B):
 * Парола → PBKDF2 → AES-GCM ключ → криптиран secretKey в DB.
 * При бъдеща миграция към WebAuthn PRF extension (Approach A) само тази функция се сменя;
 * генерирането, подписването и UI остават непроменени.
 */

const PBKDF2_HASH = 'SHA-256';
const AES_KEY_LENGTH = 256;

/**
 * Извежда AES-256-GCM ключ от парола чрез PBKDF2-SHA256.
 * Параметри по подразбиране: 600 000 итерации — NIST SP 800-63B препоръка за 2024.
 *
 * @param password    Паролата в plain text
 * @param salt        16-byte random salt — генерирай с crypto.getRandomValues(new Uint8Array(16))
 * @param iterations  Брой итерации (default 600 000)
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations = 600_000,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  // Cast: Web Crypto API изисква Uint8Array<ArrayBuffer>, но noble връща Uint8Array<ArrayBufferLike>
  const saltBuf = salt as unknown as Uint8Array<ArrayBuffer>;
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Криптира secretKey с AES-256-GCM.
 * JPEG analogия: AES-GCM е authenticated encryption — ако derivedKey или IV са различни
 * при декриптиране, операцията хвърля OperationError (не връща garbage bytes).
 *
 * @param secretKey   Байтовете на private key-а за криптиране
 * @param derivedKey  AES ключ от deriveKeyFromPassword()
 * @param iv          12-byte random IV — генерирай с crypto.getRandomValues(new Uint8Array(12))
 */
export async function encryptPrivateKey(
  secretKey: Uint8Array,
  derivedKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const ivBuf = iv as unknown as Uint8Array<ArrayBuffer>;
  const keyBuf = secretKey as unknown as Uint8Array<ArrayBuffer>;
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, derivedKey, keyBuf);
  return new Uint8Array(encrypted);
}

/**
 * Декриптира secretKey с AES-256-GCM.
 * Хвърля DOMException(OperationError) ако derivedKey е грешен (грешна парола).
 * Caller трябва да хване грешката и да покаже "Грешна парола".
 *
 * @param encryptedKey  Криптираните байтове от encryptPrivateKey()
 * @param derivedKey    AES ключ — трябва да е от СЪЩАТА парола и salt
 * @param iv            IV-то, ползвано при криптиране
 */
export async function decryptPrivateKey(
  encryptedKey: Uint8Array,
  derivedKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const ivBuf = iv as unknown as Uint8Array<ArrayBuffer>;
  const encBuf = encryptedKey as unknown as Uint8Array<ArrayBuffer>;
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, derivedKey, encBuf);
  return new Uint8Array(decrypted);
}
