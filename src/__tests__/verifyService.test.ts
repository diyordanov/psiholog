/**
 * verifyService.test.ts
 * Integration тестове за verifyDocument() с всички 10 fixture сценария
 * (single-signer, N=1) + Ден 3 (Фаза 8) N-signer тестове (N=2, N=3, corrupt-one).
 *
 * Схема на резултата (Ден 3): VerifyResult.signers[] — по един SignerResult
 * за всеки /Sig обект, файлов ред (owner пръв). N=1 е частен случай:
 * signers.length === 1, всички стари fixtures продължават да минават без
 * промяна в signing логиката, само в assertion пътя (r.signers[0].ecdsa вместо
 * старото r.ecdsa).
 *
 * Fixture матрица (single-signer, N=1):
 *   valid-hybrid       → authentic, ECDSA valid, ML-DSA valid
 *   valid-ecdsa-only   → authentic, ECDSA valid, ML-DSA not_included
 *   modified-body      → tampered,  ECDSA invalid (hash mismatch)
 *   modified-signature → invalid,   ECDSA invalid (sig verify fail, hash match)
 *   expired-cert       → authentic_with_warnings, ECDSA valid, cert expired
 *   untrusted-ca       → invalid,   chain_invalid
 *   unsigned           → unsigned
 *   malicious          → error (sanitizer reject)
 *   old-format         → authentic, ML-DSA not_included (empty public key)
 *   ml-dsa-invalid     → invalid,   ECDSA valid, ML-DSA invalid
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as x509 from '@peculiar/x509';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { verifyDocument } from '../lib/verify/verifyService';
import {
  preparePdfForSigning, computeByteRanges, patchByteRangeInPlace, hashByteRanges,
  injectSignatureAndPQ, prepareIncrementalSignature, injectIncrementalSignature,
  encodeBase64url,
} from '../lib/pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from '../lib/pdf/cmsBuilder';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  initTestKeys, type TestKeys, MINIMAL_PDF, loadTestFontBytes,
  makeValidHybridPdf, makeValidEcdsaOnlyPdf,
  makeModifiedBodyPdf, makeModifiedSignaturePdf,
  makeExpiredCertPdf, makeUntrustedCaPdf,
  makeUnsignedPdf, makeMaliciousPdf,
  makeOldFormatPdf, makeMlDsaInvalidPdf,
} from './helpers/signingFixtures';

let keys: TestKeys;
let fontBytes: Uint8Array;
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
  fontBytes = loadTestFontBytes();
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
  it('totalSigners е 1 (N=1 backward compat)', async () => {
    const r = await verify(validHybrid);
    expect(r.totalSigners).toBe(1);
    expect(r.signers).toHaveLength(1);
  });
  it('ECDSA е valid', async () => {
    const r = await verify(validHybrid);
    expect(r.signers[0].ecdsa.status).toBe('valid');
  });
  it('ML-DSA е valid', async () => {
    const r = await verify(validHybrid);
    expect(r.signers[0].mlDsa?.status).toBe('valid');
  });
  it('cert е ok (не expired, не chain_invalid)', async () => {
    const r = await verify(validHybrid);
    expect(r.signers[0].ecdsa.certStatus).toBe('ok');
  });
  it('documentHash е 64-символен hex string', async () => {
    const r = await verify(validHybrid);
    expect(r.documentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('signerName е "Test Signer" (от cert CN)', async () => {
    const r = await verify(validHybrid);
    expect(r.signers[0].signerName).toBe('Test Signer');
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
    expect(r.signers[0].ecdsa.status).toBe('valid');
  });
  it('ML-DSA е null (няма PQ слот изобщо)', async () => {
    const r = await verify(validEcdsaOnly);
    expect(r.signers[0].mlDsa).toBeNull();
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
    expect(r.signers[0].ecdsa.status).toBe('invalid');
  });
  it('error message споменава модификация', async () => {
    const r = await verify(modifiedBody);
    expect(r.signers[0].ecdsa.errorMessage).toMatch(/модифициран/i);
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
    expect(r.signers[0].ecdsa.status).toBe('invalid');
  });
  it('overall НЕ е tampered (данните са непроменени)', async () => {
    const r = await verify(modifiedSig);
    expect(r.overall).not.toBe('tampered');
  });
});

// ─── 5. expired-cert ─────────────────────────────────────────────────────────

describe('expired-cert PDF', () => {
  it('overall е authentic_with_warnings (подписът е бил валиден, но cert-ът е изтекъл)', async () => {
    const r = await verify(expiredCert);
    expect(r.overall).toBe('authentic_with_warnings');
  });
  it('certStatus е expired', async () => {
    const r = await verify(expiredCert);
    expect(r.signers[0].ecdsa.certStatus).toBe('expired');
  });
  it('ECDSA status е valid (математически подписът е верен)', async () => {
    const r = await verify(expiredCert);
    expect(r.signers[0].ecdsa.status).toBe('valid');
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
    expect(r.signers[0].ecdsa.certStatus).toBe('chain_invalid');
  });
});

// ─── 7. unsigned ─────────────────────────────────────────────────────────────

describe('unsigned PDF', () => {
  it('overall е unsigned', async () => {
    const r = await verify(unsignedPdf);
    expect(r.overall).toBe('unsigned');
  });
  it('signers е празен масив, totalSigners е 0', async () => {
    const r = await verify(unsignedPdf);
    expect(r.signers).toEqual([]);
    expect(r.totalSigners).toBe(0);
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
    expect(r.signers[0].mlDsa?.status).toBe('not_included');
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
    expect(r.signers[0].ecdsa.status).toBe('valid');
  });
  it('ML-DSA е invalid', async () => {
    const r = await verify(mlDsaInvalid);
    expect(r.signers[0].mlDsa?.status).toBe('invalid');
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

// ═══════════════════════════════════════════════════════════════════════════
// Ден 3 (Фаза 8): N-signer verify pipeline — N=2, N=3, corrupt-one-of-N
// ═══════════════════════════════════════════════════════════════════════════

const SIGNING_DATE = new Date('2026-07-19T10:00:00Z');

/** Owner: preparePdfForSigning + injectSignatureAndPQ (с опционален PQ подпис). */
async function signAsOwner(withPq: boolean) {
  const prepared = await preparePdfForSigning(
    new Uint8Array(MINIMAL_PDF), 'Owner Test', SIGNING_DATE,
    { markerX: 30, markerY: 30, pageIndex: 0, includePq: withPq },
  );
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);
  const signedAttrs = buildSignedAttrs(messageDigest);
  const sigP1363 = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.privateKey,
      signedAttrs as unknown as Uint8Array<ArrayBuffer>,
    ),
  );
  const cmsDer = buildCmsDetached(messageDigest, sigP1363, keys.leafCertDer, keys.rootCaCertDer);

  let pqData = null;
  if (withPq) {
    const mlSig = ml_dsa65.sign(messageDigest, keys.mlDsaSecretKey);
    pqData = {
      algorithm: 'ml-dsa-65',
      signedHash: encodeBase64url(messageDigest),
      signatureB64url: encodeBase64url(mlSig),
      publicKeyB64url: encodeBase64url(keys.mlDsaPublicKey),
      attestation: { hasCert: false },
    };
  }
  return injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
}

/**
 * Recipient: prepareIncrementalSignature + injectIncrementalSignature.
 * `withPq` (Ден 6 hotfix v5) — вгражда ML-DSA-65 /PQSignature В СЪЩИЯ /Sig
 * dict (bugfix 2026-07-31, вместо отделен incremental stream + signerIndex).
 */
async function signAsRecipient(
  prevBytes: Uint8Array, name: string, privateKey: CryptoKey, certDer: Uint8Array,
  fieldName: string, markerX: number, _signerIndex: number, withPq = false,
) {
  const prepared = await prepareIncrementalSignature(
    prevBytes, name, SIGNING_DATE, { markerX, markerY: 30, pageIndex: 0, fieldName, fontBytes, includePq: withPq },
  );
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);
  const signedAttrs = buildSignedAttrs(messageDigest);
  const sigP1363 = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, privateKey,
      signedAttrs as unknown as Uint8Array<ArrayBuffer>,
    ),
  );
  const cmsDer = buildCmsDetached(messageDigest, sigP1363, certDer, keys.rootCaCertDer);

  let pqData = null;
  if (withPq) {
    const mlSig = ml_dsa65.sign(messageDigest, keys.mlDsaSecretKey);
    pqData = {
      algorithm: 'ml-dsa-65',
      signedHash: encodeBase64url(messageDigest),
      signatureB64url: encodeBase64url(mlSig),
      publicKeyB64url: encodeBase64url(keys.mlDsaPublicKey),
      attestation: { hasCert: false },
    };
  }
  return injectIncrementalSignature(prepared, cmsDer, pqData);
}

describe('N=2 подписа (owner + 1 recipient, от multi-sign fixtures)', () => {
  let recipientKeys: CryptoKeyPair;
  let recipientCertDer: Uint8Array;
  let dualSigned: Uint8Array;

  beforeAll(async () => {
    recipientKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: '30', subject: 'CN=Recipient N2', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipientKeys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    recipientCertDer = new Uint8Array(cert.rawData);

    const ownerSigned = await signAsOwner(true); // owner ИМА PQ
    dualSigned = await signAsRecipient(ownerSigned, 'Recipient N2', recipientKeys.privateKey, recipientCertDer, 'Signature2', 260, 1);
  }, 60_000);

  it('totalSigners е 2', async () => {
    const r = await verify(dualSigned);
    expect(r.totalSigners).toBe(2);
    expect(r.signers).toHaveLength(2);
  });

  it('и двата ECDSA подписа са valid', async () => {
    const r = await verify(dualSigned);
    expect(r.signers[0].ecdsa.status).toBe('valid');
    expect(r.signers[1].ecdsa.status).toBe('valid');
  });

  it('signerName-ите идват от cert CN (не от /Name полето)', async () => {
    const r = await verify(dualSigned);
    // signerName = CN от X.509 сертификата — owner тук преизползва keys.leafCertDer
    // (CN=Test Signer), /Name полето в PDF-а ("Owner Test") е отделен, чисто
    // визуален маркер и не участва в signerName резолюцията.
    expect(r.signers[0].signerName).toBe('Test Signer');
    expect(r.signers[1].signerName).toBe('Recipient N2');
  });

  it('owner има валиден ML-DSA, recipient няма PQ слот (mlDsa === null)', async () => {
    const r = await verify(dualSigned);
    expect(r.signers[0].mlDsa?.status).toBe('valid');
    expect(r.signers[1].mlDsa).toBeNull();
  });

  it('overall е authentic_with_warnings ("смесена" PQ защита — owner има, recipient няма)', async () => {
    const r = await verify(dualSigned);
    expect(r.overall).toBe('authentic_with_warnings');
  });

  it('signerIndex е 0 за owner, 1 за recipient (файлов ред)', async () => {
    const r = await verify(dualSigned);
    expect(r.signers[0].signerIndex).toBe(0);
    expect(r.signers[1].signerIndex).toBe(1);
  });
});

describe('N=2 подписа, auto-layout размери (owner С PQ, recipient БЕЗ PQ, широки маркери)', () => {
  let recipientKeys: CryptoKeyPair;
  let recipientCertDer: Uint8Array;
  let signed: Uint8Array;

  beforeAll(async () => {
    recipientKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: '32', subject: 'CN=Recipient AutoLayout', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipientKeys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    recipientCertDer = new Uint8Array(cert.rawData);

    // Owner: auto-layout зона (широк маркер, НЕ default 200×50) + fontBytes
    // (реалният app flow ВИНАГИ подава fontBytes/markerWidth/markerHeight
    // за owner-а — за разлика от по-стария test helper по-долу, който не ги
    // подава изобщо, крие точно тази комбинация).
    const preparedOwner = await preparePdfForSigning(
      new Uint8Array(MINIMAL_PDF), 'Owner AutoLayout', SIGNING_DATE,
      { markerX: 30, markerY: 30, pageIndex: 0, fontBytes, markerWidth: 270, markerHeight: 60, includePq: true },
    );
    const ownerByteRange = computeByteRanges(preparedOwner);
    patchByteRangeInPlace(preparedOwner, ownerByteRange);
    const ownerDigest = hashByteRanges(preparedOwner.bytes, ownerByteRange);
    const ownerSignedAttrs = buildSignedAttrs(ownerDigest);
    const ownerSig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.privateKey, ownerSignedAttrs as unknown as Uint8Array<ArrayBuffer>),
    );
    const ownerCms = buildCmsDetached(ownerDigest, ownerSig, keys.leafCertDer, keys.rootCaCertDer);
    const mlSig = ml_dsa65.sign(ownerDigest, keys.mlDsaSecretKey);
    const ownerPq = {
      algorithm: 'ml-dsa-65', signedHash: encodeBase64url(ownerDigest), signatureB64url: encodeBase64url(mlSig),
      publicKeyB64url: encodeBase64url(keys.mlDsaPublicKey), attestation: { hasCert: false },
    };
    const ownerSigned = injectSignatureAndPQ(preparedOwner, ownerByteRange, ownerCms, ownerPq);

    // Recipient: auto-layout зона, БЕЗ PQ (не всеки recipient има ML-DSA ключ) —
    // точната комбинация от live репродукцията на потребителя.
    const preparedRecipient = await prepareIncrementalSignature(
      ownerSigned, 'Recipient AutoLayout', SIGNING_DATE,
      { markerX: 320, markerY: 30, pageIndex: 0, fieldName: 'Signature2', fontBytes, markerWidth: 270, markerHeight: 60 },
    );
    const recByteRange = computeByteRanges(preparedRecipient);
    patchByteRangeInPlace(preparedRecipient, recByteRange);
    const recDigest = hashByteRanges(preparedRecipient.bytes, recByteRange);
    const recSignedAttrs = buildSignedAttrs(recDigest);
    const recSig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, recipientKeys.privateKey, recSignedAttrs as unknown as Uint8Array<ArrayBuffer>),
    );
    const recCms = buildCmsDetached(recDigest, recSig, recipientCertDer, keys.rootCaCertDer);
    signed = injectIncrementalSignature(preparedRecipient, recCms, null);
  }, 60_000);

  it('totalSigners е ТОЧНО 2', async () => {
    const r = await verify(signed);
    expect(r.totalSigners).toBe(2);
    expect(r.signers).toHaveLength(2);
  });

  it('и двата ECDSA подписа са valid, имената са коректни', async () => {
    const r = await verify(signed);
    expect(r.signers[0].signerName).toBe('Test Signer'); // CN на keys.leafCertDer
    expect(r.signers[0].ecdsa.status).toBe('valid');
    expect(r.signers[1].signerName).toBe('Recipient AutoLayout');
    expect(r.signers[1].ecdsa.status).toBe('valid');
  });

  it('owner ML-DSA valid, recipient mlDsa е null (няма PQ)', async () => {
    const r = await verify(signed);
    expect(r.signers[0].mlDsa?.status).toBe('valid');
    expect(r.signers[1].mlDsa).toBeNull();
  });
});

describe('N=2 подписа, recipient С ML-DSA (Ден 6 hotfix v5 — hybrid incremental)', () => {
  let recipientKeys: CryptoKeyPair;
  let recipientCertDer: Uint8Array;
  let hybridDualSigned: Uint8Array;

  beforeAll(async () => {
    recipientKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: '31', subject: 'CN=Recipient Hybrid', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipientKeys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    recipientCertDer = new Uint8Array(cert.rawData);

    const ownerSigned = await signAsOwner(true); // owner ИМА PQ
    // recipient СЪЩО ИМА PQ (withPq=true) — тества, че /PQSignature на
    // ВТОРИЯ /Sig dict се извлича правилно, независимо от owner-ския.
    hybridDualSigned = await signAsRecipient(
      ownerSigned, 'Recipient Hybrid', recipientKeys.privateKey, recipientCertDer, 'Signature2', 260, 1, true,
    );
  }, 60_000);

  it('totalSigners е ТОЧНО 2 (не 3 — PQ block-ът не създава фантомен трети signer)', async () => {
    const r = await verify(hybridDualSigned);
    expect(r.totalSigners).toBe(2);
    expect(r.signers).toHaveLength(2);
  });

  it('и двата подписа имат валиден ML-DSA (не само owner-ският)', async () => {
    const r = await verify(hybridDualSigned);
    expect(r.signers[0].mlDsa?.status).toBe('valid');
    expect(r.signers[1].mlDsa?.status).toBe('valid');
  });

  it('и двата ECDSA подписа са valid, byteRange е намерен за двата', async () => {
    const r = await verify(hybridDualSigned);
    expect(r.signers[0].ecdsa.status).toBe('valid');
    expect(r.signers[1].ecdsa.status).toBe('valid');
  });

  it('overall е authentic (НЕ with_warnings — и двамата имат PQ, няма "смесена" защита)', async () => {
    const r = await verify(hybridDualSigned);
    expect(r.overall).toBe('authentic');
  });

  it('signerIndex-ите на PQ streams-ите съвпадат с ECDSA signerIndex (0 и 1)', async () => {
    const r = await verify(hybridDualSigned);
    expect(r.signers[0].signerIndex).toBe(0);
    expect(r.signers[1].signerIndex).toBe(1);
  });
});

describe('N=3 подписа (owner + 2 recipients, от multi-sign-3 fixtures)', () => {
  let recipient1Keys: CryptoKeyPair, recipient2Keys: CryptoKeyPair;
  let recipient1CertDer: Uint8Array, recipient2CertDer: Uint8Array;
  let tripleSigned: Uint8Array;

  beforeAll(async () => {
    recipient1Keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    recipient2Keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert1 = await x509.X509CertificateGenerator.create({
      serialNumber: '31', subject: 'CN=Recipient N3 A', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipient1Keys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    const cert2 = await x509.X509CertificateGenerator.create({
      serialNumber: '32', subject: 'CN=Recipient N3 B', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipient2Keys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    recipient1CertDer = new Uint8Array(cert1.rawData);
    recipient2CertDer = new Uint8Array(cert2.rawData);

    const ownerSigned = await signAsOwner(false); // без PQ — тества "всички без PQ" пътя (не warning)
    const dual = await signAsRecipient(ownerSigned, 'Recipient N3 A', recipient1Keys.privateKey, recipient1CertDer, 'Signature2', 260, 1);
    tripleSigned = await signAsRecipient(dual, 'Recipient N3 B', recipient2Keys.privateKey, recipient2CertDer, 'Signature3', 30, 2);
  }, 60_000);

  it('totalSigners е 3', async () => {
    const r = await verify(tripleSigned);
    expect(r.totalSigners).toBe(3);
    expect(r.signers).toHaveLength(3);
  });

  it('и трите ECDSA подписа са valid', async () => {
    const r = await verify(tripleSigned);
    expect(r.signers.every(s => s.ecdsa.status === 'valid')).toBe(true);
  });

  it('signerIndex-ите са 0, 1, 2 (файлов ред)', async () => {
    const r = await verify(tripleSigned);
    expect(r.signers.map(s => s.signerIndex)).toEqual([0, 1, 2]);
  });

  it('overall е authentic (никой няма PQ — не е "смесена" защита)', async () => {
    const r = await verify(tripleSigned);
    expect(r.overall).toBe('authentic');
  });

  it('documentHash покрива целия файл (byteRange на последния подпис)', async () => {
    const r = await verify(tripleSigned);
    expect(r.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.byteRange![1]).toBeGreaterThan(0);
  });
});

describe('Corrupt one signature от N — само тя се показва invalid, останалите valid', () => {
  it('корупция на recipient ECDSA sig bytes (signature 2 от 2) не засяга owner (signature 1)', async () => {
    const recipientKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: '33', subject: 'CN=Recipient Corrupt', issuer: 'CN=Test Root CA, O=SignShield Test',
      notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01'),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      publicKey: recipientKeys.publicKey, signingKey: keys.rootCaKeys.privateKey,
    });
    const recipientCertDer = new Uint8Array(cert.rawData);

    const ownerSigned = await signAsOwner(false);

    // Подписваме recipient-а РЪЧНО (не чрез signAsRecipient helper-а), за да
    // флипнем P1363 sig байтовете ПРЕДИ да ги вградим в CMS — гарантирано
    // невалиден ECDSA подпис, детерминирано (по модела на
    // makeModifiedSignaturePdf в signingFixtures.ts), вместо крехко post-hoc
    // флипване на произволни hex символи във финалния файл (може да уцели
    // байт, който не участва в криптографската проверка).
    const prepared = await prepareIncrementalSignature(
      ownerSigned, 'Recipient Corrupt', SIGNING_DATE,
      { markerX: 260, markerY: 30, pageIndex: 0, fieldName: 'Signature2', fontBytes },
    );
    const byteRange = computeByteRanges(prepared);
    patchByteRangeInPlace(prepared, byteRange);
    const messageDigest = hashByteRanges(prepared.bytes, byteRange);
    const signedAttrs = buildSignedAttrs(messageDigest);
    const realSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, recipientKeys.privateKey,
        signedAttrs as unknown as Uint8Array<ArrayBuffer>,
      ),
    );
    const corruptedSig = new Uint8Array(realSig);
    corruptedSig[12] ^= 0xFF;
    corruptedSig[13] ^= 0xFF;
    const cmsDer = buildCmsDetached(messageDigest, corruptedSig, recipientCertDer, keys.rootCaCertDer);
    const dualSigned = injectIncrementalSignature(prepared, cmsDer);

    const r = await verify(dualSigned);

    expect(r.totalSigners).toBe(2);
    expect(r.signers[0].ecdsa.status).toBe('valid');   // owner непроменен
    expect(r.signers[1].ecdsa.status).toBe('invalid'); // recipient корумпиран
    expect(r.overall).toBe('invalid');
  });
});

// ─── Regression: pre-existing чужд /Contents /ByteRange в изходния PDF ───────
//
// Открито при live тест (2026-07-29): потребител качи PDF, в който вече
// имаше leftover placeholder signature field (напр. от предишно частично
// подписване в Adobe Acrobat Reader — среща се и при PDF шаблони, генерирани
// с вграден празен signature field). preparePdfForSigning() ползваше
// findPattern(bytes, '/Contents <') от НАЧАЛОТО на serialize-натия файл —
// ако чуждият placeholder идва ПРЕДИ нашия нов sig обект в байтовия поток,
// patchByteRangeInPlace()/fillContentsPlaceholder() пишат в ГРЕШНИЯ обект.
// Резултат: нашият РЕАЛЕН подпис остава завинаги непопълнен (/ByteRange си
// стои 999999999, /Contents — нули) → verify показва "invalid" + фантомен
// допълнителен "подписващ" (самия чужд, вече презаписан частично placeholder).
//
// Fix: preparePdfForSigning() вече намира sig обекта по собствения си
// object number (sigDictRef) ПЪРВО, после търси /Contents//ByteRange само
// В РАМКИТЕ на него — имунизирано срещу произволен чужд placeholder другаде
// във файла.
describe('preparePdfForSigning с pre-existing чужд /Contents /ByteRange placeholder', () => {
  /** Симулира "отровен" източник — PDF с чужд/непопълнен signature field ПРЕДИ нашия. */
  async function makePoisonedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const ctx = doc.context;
    const fakeSigRef = ctx.nextRef();
    const fakeSig = ctx.obj({
      Type: PDFName.of('Sig'),
      Filter: PDFName.of('Adobe.PPKLite'),
      SubFilter: PDFName.of('adbe.pkcs7.detached'),
      ByteRange: ctx.obj([0, 999999999, 999999999, 999999999]),
      Contents: PDFHexString.of('0'.repeat(200)),
    });
    ctx.assign(fakeSigRef, fakeSig);
    const bytes = await doc.save({ useObjectStreams: false });
    return new Uint8Array(bytes);
  }

  // Забележка: тази конкретна синтетична конструкция (отделен pdf-lib
  // документ, presave-нат и после reload-нат) НЕ винаги слага чуждия
  // placeholder ПРЕДИ нашия в serialize-натия byte stream (зависи от
  // вътрешния object-ordering на pdf-lib при .save()) — затова тестът може
  // да мине дори със старата (бъгава) find-first логика. Реалният бъг е
  // потвърден чрез директен byte-level анализ на действителния PDF от
  // потребителя (Adobe Acrobat Reader leftover signature field, обект с
  // по-нисък номер от нашия, физически ПРЕДИ него във файла) — тестът тук
  // остава като допълнително покритие на "работи коректно в присъствие на
  // чужд /Type /Sig обект", не като гарантиран repro на точния byte-order бъг.
  it('намира и попълва СОБСТВЕНИЯ си placeholder, не чуждия — резултатът е валиден подпис', async () => {
    const poisoned = await makePoisonedPdf();

    const prepared = await preparePdfForSigning(
      poisoned, 'Poisoned Test Signer', SIGNING_DATE, { markerX: 30, markerY: 30, pageIndex: 0 },
    );
    const byteRange = computeByteRanges(prepared);
    patchByteRangeInPlace(prepared, byteRange);
    const digest = hashByteRanges(prepared.bytes, byteRange);
    const signedAttrs = buildSignedAttrs(digest);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.privateKey,
        signedAttrs as unknown as Uint8Array<ArrayBuffer>,
      ),
    );
    const cmsDer = buildCmsDetached(digest, sig, keys.leafCertDer, keys.rootCaCertDer);
    const finalPdf = injectSignatureAndPQ(prepared, byteRange, cmsDer, null);

    const r = await verify(finalPdf);
    // Чуждият placeholder ОСТАВА като отделен (невалиден/непопълнен) /Type /Sig
    // обект — verify го вижда, но НАШИЯТ реален подпис трябва да е valid.
    // signerName идва от X.509 cert CN (keys.leafCertDer → "Test Signer"), не
    // от PDF /Name полето ("Poisoned Test Signer" подадено в preparePdfForSigning).
    const realSigner = r.signers.find(s => s.signerName === 'Test Signer');
    expect(realSigner).toBeDefined();
    expect(realSigner!.ecdsa.status).toBe('valid');
  });
});
