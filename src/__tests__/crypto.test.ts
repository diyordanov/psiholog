/**
 * crypto.test.ts
 * Vitest unit тестове за криптографски helper функции.
 *
 * Тествани сценарии:
 *   ECDSA P-256: keygen → sign → verify (positive + negative)
 *   ML-DSA-65: keygen → sign → verify (positive + negative)
 *   PRF + AES-GCM: mock extractor → roundtrip, грешен PRF → хвърля
 *   Thumbprint: deterministic за един ключ, различен за друг ключ
 */
import { describe, it, expect, vi } from 'vitest';
import { generateEcdsaKeypair, generateMlDsaKeypair } from '../lib/crypto/keyGeneration';
import { signWithEcdsaP256, verifyEcdsaP256, signWithMlDsa, verifyMlDsa } from '../lib/crypto/signing';
import {
  deriveAesKeyFromPRF,
  encryptPrivateKey,
  decryptPrivateKey,
  type PrfExtractor,
} from '../lib/crypto/keyProtection';
import { computePublicKeyThumbprint } from '../lib/crypto/thumbprint';

// ─── ECDSA P-256 ───────────────────────────────────────────────────────────────

describe('ECDSA P-256', () => {
  it('генерира keypair с правилните размери', async () => {
    const kp = await generateEcdsaKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    // 65 байта uncompressed point (0x04 || x || y)
    expect(kp.publicKey.length).toBe(65);
    expect(kp.publicKey[0]).toBe(0x04);
    // PKCS8 DER — минимум 100 байта
    expect(kp.secretKey.length).toBeGreaterThan(100);
  });

  it('верифицира валиден подпис (positive)', async () => {
    const kp = await generateEcdsaKeypair();
    const message = new TextEncoder().encode('тестово съобщение');
    const sig = await signWithEcdsaP256(kp.secretKey, message);
    const valid = await verifyEcdsaP256(kp.publicKey, message, sig);
    expect(valid).toBe(true);
  });

  it('подписът е 64 байта P1363 (r||s)', async () => {
    const kp = await generateEcdsaKeypair();
    const sig = await signWithEcdsaP256(kp.secretKey, new Uint8Array(32));
    expect(sig.length).toBe(64);
  });

  it('отхвърля подпис при променено съобщение (negative)', async () => {
    const kp = await generateEcdsaKeypair();
    const original = new TextEncoder().encode('оригинал');
    const tampered = new TextEncoder().encode('манипулирано');
    const sig = await signWithEcdsaP256(kp.secretKey, original);
    const valid = await verifyEcdsaP256(kp.publicKey, tampered, sig);
    expect(valid).toBe(false);
  });

  it('отхвърля подпис при грешен public key (negative)', async () => {
    const kp1 = await generateEcdsaKeypair();
    const kp2 = await generateEcdsaKeypair();
    const message = new TextEncoder().encode('тест');
    const sig = await signWithEcdsaP256(kp1.secretKey, message);
    const valid = await verifyEcdsaP256(kp2.publicKey, message, sig);
    expect(valid).toBe(false);
  });
});

// ─── ML-DSA-65 ────────────────────────────────────────────────────────────────

describe('ML-DSA-65', () => {
  it('генерира keypair с правилните размери', () => {
    const kp = generateMlDsaKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(1952);
    expect(kp.secretKey.length).toBe(4032);
  });

  it('верифицира валиден подпис (positive)', async () => {
    const kp = generateMlDsaKeypair();
    const message = new TextEncoder().encode('пост-квантово съобщение');
    const sig = await signWithMlDsa(kp.secretKey, message);
    const valid = await verifyMlDsa(kp.publicKey, message, sig);
    expect(valid).toBe(true);
  });

  it('отхвърля подпис при променено съобщение (negative)', async () => {
    const kp = generateMlDsaKeypair();
    const original = new TextEncoder().encode('оригинал');
    const tampered = new TextEncoder().encode('манипулирано');
    const sig = await signWithMlDsa(kp.secretKey, original);
    const valid = await verifyMlDsa(kp.publicKey, tampered, sig);
    expect(valid).toBe(false);
  });

  it('отхвърля подпис при грешен public key (negative)', async () => {
    const kp1 = generateMlDsaKeypair();
    const kp2 = generateMlDsaKeypair();
    const message = new TextEncoder().encode('тест');
    const sig = await signWithMlDsa(kp1.secretKey, message);
    const valid = await verifyMlDsa(kp2.publicKey, message, sig);
    expect(valid).toBe(false);
  });
});

// ─── PRF + AES-GCM ────────────────────────────────────────────────────────────

/** Помощна функция: прави mock PrfExtractor с фиксиран PRF output. */
function makeMockExtractor(prfOutputBytes: Uint8Array): PrfExtractor {
  const fixedCredentialId = new Uint8Array(16).fill(1);
  return vi.fn().mockResolvedValue({
    prfOutput: prfOutputBytes.buffer,
    credentialId: fixedCredentialId,
  });
}

describe('PRF + AES-GCM', () => {
  it('deriveAesKeyFromPRF с mock extractor връща CryptoKey', async () => {
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const mockExtractor = makeMockExtractor(new Uint8Array(32).fill(42));

    const { aesKey, credentialId } = await deriveAesKeyFromPRF(
      prfSalt,
      'test.localhost',
      undefined,
      mockExtractor,
    );

    expect(aesKey).toBeDefined();
    expect(credentialId).toBeInstanceOf(Uint8Array);
    expect(credentialId.length).toBe(16);
  });

  it('roundtrip: encrypt → decrypt с правилен PRF output дава оригиналния ключ', async () => {
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    const prfOutput = new Uint8Array(32).fill(99);

    const mockExtractor = makeMockExtractor(prfOutput);

    const { aesKey } = await deriveAesKeyFromPRF(prfSalt, 'test.localhost', undefined, mockExtractor);
    const encrypted = await encryptPrivateKey(secretKey, aesKey, iv);

    // Деривираме отново с ЕДИН И СЪЩИ PRF output (детерминиран)
    const { aesKey: aesKey2 } = await deriveAesKeyFromPRF(prfSalt, 'test.localhost', undefined, mockExtractor);
    const decrypted = await decryptPrivateKey(encrypted, aesKey2, iv);

    expect(decrypted).toEqual(secretKey);
  });

  it('хвърля при грешен PRF output (симулирана грешна passkey)', async () => {
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secretKey = crypto.getRandomValues(new Uint8Array(32));

    const correctExtractor = makeMockExtractor(new Uint8Array(32).fill(11));
    const wrongExtractor = makeMockExtractor(new Uint8Array(32).fill(22));

    const { aesKey } = await deriveAesKeyFromPRF(prfSalt, 'test.localhost', undefined, correctExtractor);
    const encrypted = await encryptPrivateKey(secretKey, aesKey, iv);

    const { aesKey: wrongKey } = await deriveAesKeyFromPRF(prfSalt, 'test.localhost', undefined, wrongExtractor);
    await expect(decryptPrivateKey(encrypted, wrongKey, iv)).rejects.toThrow();
  });
});

// ─── Thumbprint ───────────────────────────────────────────────────────────────

describe('computePublicKeyThumbprint', () => {
  it('е deterministic — един ключ дава един и същи thumbprint', async () => {
    const kp = await generateEcdsaKeypair();
    const t1 = computePublicKeyThumbprint(kp.publicKey);
    const t2 = computePublicKeyThumbprint(kp.publicKey);
    expect(t1).toBe(t2);
  });

  it('е различен за различни ключове', async () => {
    const kp1 = await generateEcdsaKeypair();
    const kp2 = await generateEcdsaKeypair();
    expect(computePublicKeyThumbprint(kp1.publicKey)).not.toBe(
      computePublicKeyThumbprint(kp2.publicKey),
    );
  });

  it('е кратък base64url низ (~11 символа)', async () => {
    const kp = await generateEcdsaKeypair();
    const thumb = computePublicKeyThumbprint(kp.publicKey);
    expect(thumb.length).toBeGreaterThanOrEqual(8);
    expect(thumb.length).toBeLessThanOrEqual(14);
    expect(thumb).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
