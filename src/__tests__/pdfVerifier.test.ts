/**
 * pdfVerifier.test.ts
 * Unit тестове за:
 *   - extractByteRange()
 *   - extractCmsDer()
 *   - extractPqStream()
 *   - extractSigningDate()
 *   - computeSignedHash()
 *   - decodeBase64url()
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  extractByteRange, extractCmsDer, extractPqStream,
  extractSigningDate, computeSignedHash, decodeBase64url,
} from '../lib/pdf/pdfVerifier';
import { encodeBase64url } from '../lib/pdf/pdfSigner';
import {
  initTestKeys, makeValidHybridPdf, makeValidEcdsaOnlyPdf, type TestKeys,
} from './helpers/signingFixtures';

let keys: TestKeys;
let hybridPdf: Uint8Array;
let ecdsaOnlyPdf: Uint8Array;

beforeAll(async () => {
  keys = await initTestKeys();
  [hybridPdf, ecdsaOnlyPdf] = await Promise.all([
    makeValidHybridPdf(keys),
    makeValidEcdsaOnlyPdf(keys),
  ]);
}, 60_000);

// ─── extractByteRange ─────────────────────────────────────────────────────────

describe('extractByteRange', () => {
  it('връща [0, A, B, C] от подписан PDF', () => {
    const br = extractByteRange(hybridPdf);
    expect(br).not.toBeNull();
    expect(br![0]).toBe(0);               // ByteRange винаги започва от 0
    expect(br![1]).toBeGreaterThan(100);  // A > 0
    expect(br![2]).toBeGreaterThan(br![1]); // B > A
    expect(br![3]).toBeGreaterThan(0);    // C > 0
  });

  it('връща null за PDF без подпис (без /ByteRange [)', () => {
    const unsigned = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    expect(extractByteRange(unsigned)).toBeNull();
  });

  it('4-те числа покриват целия signed PDF (без /Contents)', () => {
    const br = extractByteRange(hybridPdf)!;
    const [, A, B, C] = br;
    // A + (B-A) + C = total length (където B-A е /Contents placeholder)
    // A + C < total (Contents slot се пропуска)
    expect(A + C).toBeLessThan(hybridPdf.length);
    expect(B + C).toBeLessThanOrEqual(hybridPdf.length);
  });
});

// ─── extractCmsDer ────────────────────────────────────────────────────────────

describe('extractCmsDer', () => {
  it('връща не-празен Uint8Array (CMS DER)', () => {
    const cms = extractCmsDer(hybridPdf);
    expect(cms).not.toBeNull();
    expect(cms!.length).toBeGreaterThan(100);
  });

  it('CMS започва с 0x30 (SEQUENCE tag)', () => {
    const cms = extractCmsDer(hybridPdf);
    expect(cms![0]).toBe(0x30);
  });

  it('връща null за PDF без /Contents <', () => {
    const plain = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    expect(extractCmsDer(plain)).toBeNull();
  });
});

// ─── extractPqStream ──────────────────────────────────────────────────────────

describe('extractPqStream', () => {
  it('извлича PQ stream от hybrid PDF', () => {
    const pq = extractPqStream(hybridPdf);
    expect(pq).not.toBeNull();
    expect(pq!.algorithm).toBe('ml-dsa-65');
    expect(pq!.signatureB64url).toBeTruthy();
    expect(pq!.publicKeyB64url).toBeTruthy();
    expect(pq!.signedHash).toBeTruthy();
    expect(pq!.byteRange).toHaveLength(4);
  });

  it('връща null за ECDSA-only PDF (без PQ stream)', () => {
    const pq = extractPqStream(ecdsaOnlyPdf);
    expect(pq).toBeNull();
  });
});

// ─── extractSigningDate ───────────────────────────────────────────────────────

describe('extractSigningDate', () => {
  it('извлича дата от /M поле', () => {
    const dt = extractSigningDate(hybridPdf);
    expect(dt).not.toBeNull();
    expect(dt!.getFullYear()).toBe(2026); // fixture използва 2026-07-10
    expect(dt!.getMonth()).toBe(6);       // 0-indexed, юли = 6
  });

  it('връща null за PDF без /M поле', () => {
    const plain = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    expect(extractSigningDate(plain)).toBeNull();
  });
});

// ─── computeSignedHash ────────────────────────────────────────────────────────

describe('computeSignedHash', () => {
  it('SHA-256 на ByteRange е 32 байта', () => {
    const br = extractByteRange(hybridPdf)!;
    const hash = computeSignedHash(hybridPdf, br);
    expect(hash).toHaveLength(32);
  });

  it('хешът се различава при промяна на 1 байт в signed region', () => {
    const br = extractByteRange(hybridPdf)!;
    const original = computeSignedHash(hybridPdf, br);

    const modified = new Uint8Array(hybridPdf);
    modified[50] ^= 0xFF; // байт 50 е в [0..A-1] (signed region)
    const modHash = computeSignedHash(modified, br);

    expect(Array.from(original)).not.toEqual(Array.from(modHash));
  });

  it('хешът НЕ се влияе от промяна в /Contents slot (ByteRange го изключва)', () => {
    const br = extractByteRange(hybridPdf)!;
    const [, A, B] = br;
    const original = computeSignedHash(hybridPdf, br);

    const modified = new Uint8Array(hybridPdf);
    // Позиция в /Contents slot (A < pos < B) — не е в signed range
    const contentsSlotPos = A + 5;
    if (contentsSlotPos < B) {
      modified[contentsSlotPos] ^= 0xFF;
      const sameHash = computeSignedHash(modified, br);
      expect(Array.from(original)).toEqual(Array.from(sameHash));
    }
  });
});

// ─── decodeBase64url ─────────────────────────────────────────────────────────

describe('decodeBase64url', () => {
  it('decode(encode(bytes)) = bytes', () => {
    const original = new Uint8Array([0x00, 0xFF, 0xAB, 0x12, 0x00]);
    const b64 = encodeBase64url(original);
    expect(Array.from(decodeBase64url(b64))).toEqual(Array.from(original));
  });

  it('обработва padding-free base64url (без = символи)', () => {
    // encode обикновено маха trailing '='
    const bytes = new Uint8Array([1, 2, 3]);
    const b64   = encodeBase64url(bytes);
    expect(b64.includes('=')).toBe(false);
    expect(Array.from(decodeBase64url(b64))).toEqual(Array.from(bytes));
  });

  it('декодира "" → Uint8Array(0)', () => {
    expect(decodeBase64url('')).toHaveLength(0);
  });
});
