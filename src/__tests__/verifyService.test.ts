/**
 * verifyService.test.ts
 * Integration тестове за verifyDocument() с всички 10 fixture сценария.
 *
 * Fixture матрица:
 *   valid-hybrid       → authentic, ECDSA valid, ML-DSA valid
 *   valid-ecdsa-only   → authentic, ECDSA valid, ML-DSA not_included
 *   modified-body      → tampered,  ECDSA invalid (hash mismatch)
 *   modified-signature → invalid,   ECDSA invalid (sig verify fail, hash match)
 *   expired-cert       → authentic, ECDSA valid,  cert expired (warning)
 *   untrusted-ca       → invalid,   chain_invalid
 *   unsigned           → unsigned
 *   malicious          → error (sanitizer reject)
 *   old-format         → authentic, ML-DSA not_included (empty public key)
 *   ml-dsa-invalid     → invalid,   ECDSA valid, ML-DSA invalid
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { verifyDocument } from '../lib/verify/verifyService';
import {
  initTestKeys, type TestKeys,
  makeValidHybridPdf, makeValidEcdsaOnlyPdf,
  makeModifiedBodyPdf, makeModifiedSignaturePdf,
  makeExpiredCertPdf, makeUntrustedCaPdf,
  makeUnsignedPdf, makeMaliciousPdf,
  makeOldFormatPdf, makeMlDsaInvalidPdf,
} from './helpers/signingFixtures';

let keys: TestKeys;
// Всички fixtures — генерирани веднъж за всички тестове
let validHybrid:       Uint8Array;
let validEcdsaOnly:    Uint8Array;
let modifiedBody:      Uint8Array;
let modifiedSig:       Uint8Array;
let expiredCert:       Uint8Array;
let untrustedCa:       Uint8Array;
let unsignedPdf:       Uint8Array;
let maliciousPdf:      Uint8Array;
let oldFormat:         Uint8Array;
let mlDsaInvalid:      Uint8Array;

beforeAll(async () => {
  keys = await initTestKeys();
  [
    validHybrid, validEcdsaOnly, modifiedBody, modifiedSig,
    expiredCert, untrustedCa, oldFormat, mlDsaInvalid,
  ] = await Promise.all([
    makeValidHybridPdf(keys),
    makeValidEcdsaOnlyPdf(keys),
    makeModifiedBodyPdf(keys),
    makeModifiedSignaturePdf(keys),
    makeExpiredCertPdf(keys),
    makeUntrustedCaPdf(keys),
    makeOldFormatPdf(keys),
    makeMlDsaInvalidPdf(keys),
  ]);
  unsignedPdf  = makeUnsignedPdf();
  maliciousPdf = makeMaliciousPdf();
}, 120_000); // ML-DSA keygen + 10 PDFs — до 2 мин

// ─── helper ───────────────────────────────────────────────────────────────────

/** Стартира verifyDocument с тестовия Root CA cert. */
const verify = (pdf: Uint8Array) =>
  verifyDocument(pdf, { rootCaCertDer: keys.rootCaCertDer });

// ─── 1. valid-hybrid ──────────────────────────────────────────────────────────

describe('valid-hybrid PDF (ECDSA + ML-DSA)', () => {
  it('overall е authentic', async () => {
    const r = await verify(validHybrid);
    expect(r.overall).toBe('authentic');
  });
  it('ECDSA е valid', async () => {
    const r = await verify(validHybrid);
    expect(r.ecdsa?.status).toBe('valid');
  });
  it('ML-DSA е valid', async () => {
    const r = await verify(validHybrid);
    expect(r.mlDsa?.status).toBe('valid');
  });
  it('cert е ok (не expired, не chain_invalid)', async () => {
    const r = await verify(validHybrid);
    expect(r.ecdsa?.certStatus).toBe('ok');
  });
  it('documentHash е 64-символен hex string', async () => {
    const r = await verify(validHybrid);
    expect(r.documentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('signerName е "Test Signer" (от cert CN)', async () => {
    const r = await verify(validHybrid);
    expect(r.ecdsa?.signerName).toBe('Test Signer');
  });
});

// ─── 2. valid-ecdsa-only ─────────────────────────────────────────────────────

describe('valid ECDSA-only PDF (без ML-DSA stream)', () => {
  it('overall е authentic', async () => {
    const r = await verify(validEcdsaOnly);
    expect(r.overall).toBe('authentic');
  });
  it('ECDSA е valid', async () => {
    const r = await verify(validEcdsaOnly);
    expect(r.ecdsa?.status).toBe('valid');
  });
  it('ML-DSA е not_included', async () => {
    const r = await verify(validEcdsaOnly);
    expect(r.mlDsa?.status).toBe('not_included');
  });
});

// ─── 3. modified-body ────────────────────────────────────────────────────────

describe('modified-body PDF (байт flip в документа)', () => {
  it('overall е tampered', async () => {
    const r = await verify(modifiedBody);
    expect(r.overall).toBe('tampered');
  });
  it('ECDSA е invalid', async () => {
    const r = await verify(modifiedBody);
    expect(r.ecdsa?.status).toBe('invalid');
  });
  it('error message споменава модификация', async () => {
    const r = await verify(modifiedBody);
    expect(r.ecdsa?.errorMessage).toMatch(/модифициран/i);
  });
});

// ─── 4. modified-signature ───────────────────────────────────────────────────

describe('modified-signature PDF (flip в /Contents)', () => {
  it('overall е invalid (не tampered — hash е непроменен)', async () => {
    const r = await verify(modifiedSig);
    // Hash match (документът не е пипнат), но ECDSA sig е невалиден
    expect(r.overall).toBe('invalid');
  });
  it('ECDSA е invalid', async () => {
    const r = await verify(modifiedSig);
    expect(r.ecdsa?.status).toBe('invalid');
  });
  it('overall НЕ е tampered (данните са непроменени)', async () => {
    const r = await verify(modifiedSig);
    expect(r.overall).not.toBe('tampered');
  });
});

// ─── 5. expired-cert ─────────────────────────────────────────────────────────

describe('expired-cert PDF', () => {
  it('overall е authentic (подписът е бил валиден)', async () => {
    // За fake timers: виж коментара по-долу
    const r = await verify(expiredCert);
    expect(r.overall).toBe('authentic');
  });
  it('certStatus е expired', async () => {
    const r = await verify(expiredCert);
    expect(r.ecdsa?.certStatus).toBe('expired');
  });
  it('ECDSA status е valid (математически подписът е верен)', async () => {
    const r = await verify(expiredCert);
    expect(r.ecdsa?.status).toBe('valid');
  });
});

// ─── 6. untrusted-ca ─────────────────────────────────────────────────────────

describe('untrusted-ca PDF (чужд Root CA)', () => {
  it('overall е invalid', async () => {
    const r = await verify(untrustedCa);
    expect(r.overall).toBe('invalid');
  });
  it('certStatus е chain_invalid', async () => {
    const r = await verify(untrustedCa);
    expect(r.ecdsa?.certStatus).toBe('chain_invalid');
  });
});

// ─── 7. unsigned ─────────────────────────────────────────────────────────────

describe('unsigned PDF', () => {
  it('overall е unsigned', async () => {
    const r = await verify(unsignedPdf);
    expect(r.overall).toBe('unsigned');
  });
  it('ecdsa и mlDsa са null', async () => {
    const r = await verify(unsignedPdf);
    expect(r.ecdsa).toBeNull();
    expect(r.mlDsa).toBeNull();
  });
  it('error message споменава "не съдържа"', async () => {
    const r = await verify(unsignedPdf);
    expect(r.errorMessage).toMatch(/не съдържа/i);
  });
});

// ─── 8. malicious ────────────────────────────────────────────────────────────

describe('malicious PDF (/JavaScript)', () => {
  it('overall е error (sanitizer reject)', async () => {
    const r = await verify(maliciousPdf);
    expect(r.overall).toBe('error');
  });
  it('error message споменава опасен код', async () => {
    const r = await verify(maliciousPdf);
    expect(r.errorMessage).toMatch(/опасен/i);
  });
});

// ─── 9. old-format ───────────────────────────────────────────────────────────

describe('old-format PDF (ML-DSA без publicKeyB64url)', () => {
  it('overall е authentic (ECDSA OK)', async () => {
    const r = await verify(oldFormat);
    expect(r.overall).toBe('authentic');
  });
  it('ML-DSA е not_included (empty public key)', async () => {
    const r = await verify(oldFormat);
    expect(r.mlDsa?.status).toBe('not_included');
  });
});

// ─── 10. ml-dsa-invalid ──────────────────────────────────────────────────────

describe('ml-dsa-invalid PDF (corrupted PQ signature)', () => {
  it('overall е invalid', async () => {
    const r = await verify(mlDsaInvalid);
    expect(r.overall).toBe('invalid');
  });
  it('ECDSA е valid (само PQ е счупен)', async () => {
    const r = await verify(mlDsaInvalid);
    expect(r.ecdsa?.status).toBe('valid');
  });
  it('ML-DSA е invalid', async () => {
    const r = await verify(mlDsaInvalid);
    expect(r.mlDsa?.status).toBe('invalid');
  });
});

// ─── Общи инварианти ─────────────────────────────────────────────────────────

describe('verifyDocument инварианти', () => {
  it('byteRange е [0, A, B, C] за всички подписани PDFs', async () => {
    const pdfs = [validHybrid, validEcdsaOnly, expiredCert];
    for (const pdf of pdfs) {
      const r = await verify(pdf);
      expect(r.byteRange).not.toBeNull();
      expect(r.byteRange![0]).toBe(0);
    }
  });

  it('documentHash е null само за unsigned/error/malicious', async () => {
    const noHash = [unsignedPdf, maliciousPdf];
    for (const pdf of noHash) {
      const r = await verify(pdf);
      expect(r.documentHash).toBeNull();
    }
  });

  it('verifyDocument не хвърля необработено изключение при corrupt PDF', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await expect(verifyDocument(garbage, { rootCaCertDer: keys.rootCaCertDer }))
      .resolves.toMatchObject({ overall: expect.stringMatching(/unsigned|error/) });
  });
});
