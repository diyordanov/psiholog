/**
 * crypto.test.ts
 * Vitest unit тестове за криптографски helper функции.
 *
 * Тествани сценарии:
 *   Ed25519: keygen → sign → verify (positive + negative)
 *   ML-DSA-65: keygen → sign → verify (positive + negative)
 *   PBKDF2 + AES-GCM: roundtrip (правилна парола), грешна парола хвърля
 *   Thumbprint: deterministic за един ключ, различен за друг ключ
 */
import { describe, it, expect } from 'vitest';
import { generateEd25519Keypair, generateMlDsaKeypair } from '../lib/crypto/keyGeneration';
import { signWithEd25519, verifyEd25519, signWithMlDsa, verifyMlDsa } from '../lib/crypto/signing';
import { deriveKeyFromPassword, encryptPrivateKey, decryptPrivateKey } from '../lib/crypto/keyProtection';
import { computePublicKeyThumbprint } from '../lib/crypto/thumbprint';

// ─── Ed25519 ───────────────────────────────────────────────────────────────────

describe('Ed25519', () => {
  it('генерира keypair с правилните размери', async () => {
    const kp = await generateEd25519Keypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('верифицира валиден подпис (positive)', async () => {
    const kp = await generateEd25519Keypair();
    const message = new TextEncoder().encode('тестово съобщение');
    const sig = await signWithEd25519(kp.secretKey, message);
    const valid = await verifyEd25519(kp.publicKey, message, sig);
    expect(valid).toBe(true);
  });

  it('отхвърля подпис при променено съобщение (negative)', async () => {
    const kp = await generateEd25519Keypair();
    const original = new TextEncoder().encode('оригинал');
    const tampered = new TextEncoder().encode('манипулирано');
    const sig = await signWithEd25519(kp.secretKey, original);
    const valid = await verifyEd25519(kp.publicKey, tampered, sig);
    expect(valid).toBe(false);
  });

  it('отхвърля подпис при грешен public key (negative)', async () => {
    const kp1 = await generateEd25519Keypair();
    const kp2 = await generateEd25519Keypair();
    const message = new TextEncoder().encode('тест');
    const sig = await signWithEd25519(kp1.secretKey, message);
    // Верифицираме с ГРЕШЕН public key
    const valid = await verifyEd25519(kp2.publicKey, message, sig);
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

// ─── PBKDF2 + AES-GCM ─────────────────────────────────────────────────────────

describe('PBKDF2 + AES-GCM roundtrip', () => {
  it('декриптира с правилна парола и дава bit-for-bit еднакъв резултат', async () => {
    const password = 'TestPassword123!';
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secretKey = crypto.getRandomValues(new Uint8Array(32));

    const derivedKey = await deriveKeyFromPassword(password, salt, 100); // 100 iter за скорост в тестове
    const encrypted = await encryptPrivateKey(secretKey, derivedKey, iv);

    // Деривираме отново с СЪЩАТА парола и salt
    const derivedKey2 = await deriveKeyFromPassword(password, salt, 100);
    const decrypted = await decryptPrivateKey(encrypted, derivedKey2, iv);

    expect(decrypted).toEqual(secretKey);
  });

  it('хвърля при грешна парола', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secretKey = crypto.getRandomValues(new Uint8Array(32));

    const correctKey = await deriveKeyFromPassword('CorrectPass123!', salt, 100);
    const encrypted = await encryptPrivateKey(secretKey, correctKey, iv);

    const wrongKey = await deriveKeyFromPassword('WrongPass456!', salt, 100);
    // Трябва да хвърли DOMException или Error при грешна парола
    await expect(decryptPrivateKey(encrypted, wrongKey, iv)).rejects.toThrow();
  });
});

// ─── Thumbprint ───────────────────────────────────────────────────────────────

describe('computePublicKeyThumbprint', () => {
  it('е deterministic — един ключ дава един и същи thumbprint', async () => {
    const kp = await generateEd25519Keypair();
    const t1 = computePublicKeyThumbprint(kp.publicKey);
    const t2 = computePublicKeyThumbprint(kp.publicKey);
    expect(t1).toBe(t2);
  });

  it('е различен за различни ключове', async () => {
    const kp1 = await generateEd25519Keypair();
    const kp2 = await generateEd25519Keypair();
    expect(computePublicKeyThumbprint(kp1.publicKey)).not.toBe(
      computePublicKeyThumbprint(kp2.publicKey),
    );
  });

  it('е кратък base64url низ (~11 символа)', async () => {
    const kp = await generateEd25519Keypair();
    const thumb = computePublicKeyThumbprint(kp.publicKey);
    expect(thumb.length).toBeGreaterThanOrEqual(8);
    expect(thumb.length).toBeLessThanOrEqual(14);
    // base64url: само букви, цифри, -, _
    expect(thumb).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
