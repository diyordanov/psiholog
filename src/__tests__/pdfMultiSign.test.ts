/**
 * pdfMultiSign.test.ts
 * Unit тестове за incremental-update primitive-а (Фаза 8, Ден 2 Стъпка 1):
 * append-only добавяне на ВТОРИ /Sig подпис върху вече подписан PDF.
 *
 * Проверява основния инвариант, който прави multi-signer подписването
 * технически коректно: signature 1 остава валиден (същия hash, същите
 * байтове) СЛЕД добавянето на signature 2 — защото incremental update е
 * чист append, никога не мутира съществуващи байтове.
 *
 * НЕ тества PQ (/PostQuantumSignature) — извън scope на Ден 2 Стъпка 1
 * (виж бележка в pdfSigner.ts, Стъпка 5).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as x509 from '@peculiar/x509';
import {
  preparePdfForSigning, computeByteRanges, patchByteRangeInPlace, hashByteRanges,
  injectSignatureAndPQ, prepareIncrementalSignature, injectIncrementalSignature,
  findPattern,
} from '../lib/pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from '../lib/pdf/cmsBuilder';
import { initTestKeys, MINIMAL_PDF, type TestKeys } from './helpers/signingFixtures';

const enc = new TextEncoder();
const SIGNING_DATE = new Date('2026-07-19T10:00:00Z');

let keys: TestKeys;
let recipientKeys: CryptoKeyPair;
let recipientCertDer: Uint8Array;

beforeAll(async () => {
  keys = await initTestKeys();

  // Втори leaf cert (различен от 'owner'-а) за "recipient" — подписан от
  // същия test Root CA, само с различна идентичност.
  recipientKeys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const recipientCert = await x509.X509CertificateGenerator.create({
    serialNumber: '06',
    subject: 'CN=Test Recipient',
    issuer: 'CN=Test Root CA, O=SignShield Test',
    notBefore: new Date('2025-01-01'),
    notAfter: new Date('2035-01-01'),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey: recipientKeys.publicKey,
    signingKey: keys.rootCaKeys.privateKey,
  });
  recipientCertDer = new Uint8Array(recipientCert.rawData);
});

/** Подписва (owner, signature 1) чрез стандартния single-signer flow. */
async function signAsOwner() {
  const prepared = await preparePdfForSigning(
    new Uint8Array(MINIMAL_PDF), 'Owner Test', SIGNING_DATE,
    { markerX: 30, markerY: 30, pageIndex: 0 },
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
  const bytes = injectSignatureAndPQ(prepared, byteRange, cmsDer, null);
  return { bytes, byteRange, messageDigest, cmsDer, sigP1363, signedAttrs, contentsOffset: prepared.contentsOffset };
}

/** Подписва (recipient, signature 2) чрез incremental-update primitive-а върху вече подписан PDF. */
async function signAsRecipient(ownerSignedBytes: Uint8Array) {
  const prepared = await prepareIncrementalSignature(
    ownerSignedBytes, 'Recipient Test', SIGNING_DATE,
    { markerX: 260, markerY: 30, pageIndex: 0, fieldName: 'Signature2' },
  );
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);
  const signedAttrs = buildSignedAttrs(messageDigest);
  const sigP1363 = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, recipientKeys.privateKey,
      signedAttrs as unknown as Uint8Array<ArrayBuffer>,
    ),
  );
  const cmsDer = buildCmsDetached(messageDigest, sigP1363, recipientCertDer, keys.rootCaCertDer);
  const bytes = injectIncrementalSignature(prepared, cmsDer);
  return { bytes, byteRange, messageDigest, cmsDer, sigP1363, signedAttrs, contentsOffset: prepared.contentsOffset };
}

describe('prepareIncrementalSignature / injectIncrementalSignature', () => {
  it('signature 1 остава валиден (same hash) СЛЕД append на signature 2', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    // Signature 1's byteRange е FIXED (записан при подписване) — препращаме
    // хеша над същия диапазон, но в КОМБИНИРАНИЯ (2-подписа) файл.
    const recomputedHash1 = hashByteRanges(sig2.bytes, sig1.byteRange);
    expect(Array.from(recomputedHash1)).toEqual(Array.from(sig1.messageDigest));
  });

  it('signature 1-те CMS bytes на оригиналния offset остават непроменени', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    // '<' + CMS hex + '>' на sig1.contentsOffset трябва да е идентично
    const before = sig1.bytes.slice(sig1.contentsOffset, sig1.contentsOffset + 20);
    const after  = sig2.bytes.slice(sig1.contentsOffset, sig1.contentsOffset + 20);
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it('signature 2 хешира правилно над своя byteRange (покрива и signature 1)', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    const recomputedHash2 = hashByteRanges(sig2.bytes, sig2.byteRange);
    expect(Array.from(recomputedHash2)).toEqual(Array.from(sig2.messageDigest));

    // signature 2-ото byteRange трябва да покрива по-голяма част от файла
    // от signature 1-ото (тъй като идва след него и включва целия предишен подпис).
    const [, , , C1] = sig1.byteRange;
    const [, A2] = sig2.byteRange;
    expect(A2).toBeGreaterThan(sig1.byteRange[1]); // A2 > A1
    void C1;
  });

  it('и двата ECDSA подписа крипто-верифицират с WebCrypto срещу собствения си public key', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    const valid1 = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.publicKey,
      sig1.sigP1363 as unknown as Uint8Array<ArrayBuffer>,
      sig1.signedAttrs as unknown as Uint8Array<ArrayBuffer>,
    );
    expect(valid1).toBe(true);

    const valid2 = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, recipientKeys.publicKey,
      sig2.sigP1363 as unknown as Uint8Array<ArrayBuffer>,
      sig2.signedAttrs as unknown as Uint8Array<ArrayBuffer>,
    );
    expect(valid2).toBe(true);
  });

  it('AcroForm /Fields съдържа 2 отделни field refs след append', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    const text = new TextDecoder('latin1').decode(sig2.bytes);
    // последното (най-новото) /Fields срещане — редефинираният AcroForm
    const matches = [...text.matchAll(/\/Fields\s*\[([^\]]*)\]/g)];
    expect(matches.length).toBeGreaterThan(0);
    const lastFields = matches[matches.length - 1][1];
    const refs = [...lastFields.matchAll(/(\d+)\s+0\s+R/g)];
    expect(refs.length).toBe(2);
  });

  it('файлът съдържа 2 отделни /Type /Sig обекта', async () => {
    const sig1 = await signAsOwner();
    const sig2 = await signAsRecipient(sig1.bytes);

    const marker = enc.encode('/Type /Sig');
    let count = 0;
    let pos = findPattern(sig2.bytes, marker, 0);
    while (pos !== -1) { count++; pos = findPattern(sig2.bytes, marker, pos + 1); }
    expect(count).toBe(2);
  });

  it('хвърля ясна грешка при несъществуваща страница', async () => {
    const sig1 = await signAsOwner();
    await expect(
      prepareIncrementalSignature(sig1.bytes, 'X', SIGNING_DATE, {
        markerX: 30, markerY: 30, pageIndex: 5, fieldName: 'Signature2',
      }),
    ).rejects.toThrow(/страница/);
  });
});