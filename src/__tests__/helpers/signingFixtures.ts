/**
 * signingFixtures.ts
 * Генератор на тестови fixtures за верификационните тестове.
 *
 * Детерминизъм:
 *   - ML-DSA-65 keypair: ml_dsa65.keygen(FIXED_SEED) → идентични bytes при всеки run
 *   - Root CA / Leaf ECDSA ключове: генерирани веднъж в beforeAll() и кешчирани за run-а
 *   - ECDSA подписите са не-детерминирани (WebCrypto random nonce) — различни bytes
 *     между runs, но поведението (pass/fail) е идентично
 *
 * 10 fixture сценария:
 *   1. valid-hybrid        ECDSA ✅ + ML-DSA ✅
 *   2. valid-ecdsa-only    ECDSA ✅, без ML-DSA stream
 *   3. modified-body       1 байт flip в signed region → hash mismatch
 *   4. modified-signature  Flip на 1 байт в /Contents (signature bytes) → ECDSA fail
 *   5. expired-cert        leaf cert notAfter в миналото
 *   6. untrusted-ca        leaf cert подписан от различен Root CA
 *   7. unsigned-pdf        Чист PDF без подпис
 *   8. malicious-pdf       PDF с /JavaScript → sanitizer reject
 *   9. valid-old-format    ECDSA ✅, ML-DSA present но publicKeyB64url е "" (стар формат)
 *  10. ml-dsa-invalid      ECDSA ✅, ML-DSA signature corrupted
 */

import * as x509 from '@peculiar/x509';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  preparePdfForSigning, computeByteRanges, patchByteRangeInPlace,
  hashByteRanges, injectSignatureAndPQ, encodeBase64url,
} from '../../lib/pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from '../../lib/pdf/cmsBuilder';

// ─── Константи ────────────────────────────────────────────────────────────────

/** Фиксиран seed за детерминистичен ML-DSA keypair. */
const FIXED_ML_DSA_SEED = new Uint8Array(32).fill(0x42);

/** Минимален валиден PDF за тестови fixtures (без съдържание). */
const MINIMAL_PDF = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
  'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
  '0000000058 00000 n \n0000000115 00000 n \n' +
  'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n191\n%%EOF\n',
);

// ─── Test keys (генерирани веднъж за целия тестов run) ───────────────────────

export interface TestKeys {
  // Нашият test Root CA (замества реалния в тестове)
  rootCaKeys:   CryptoKeyPair;
  rootCaCertDer: Uint8Array;
  // Нормален leaf cert (подписан от test Root CA)
  leafKeys:     CryptoKeyPair;
  leafCertDer:  Uint8Array;
  // "Expired" leaf cert (подписан от test Root CA, notAfter в миналото)
  expiredLeafKeys:   CryptoKeyPair;
  expiredLeafCertDer: Uint8Array;
  // "Untrusted CA" — различен Root CA (не нашият)
  foreignCaKeys:    CryptoKeyPair;
  foreignLeafKeys:  CryptoKeyPair;
  foreignLeafCertDer: Uint8Array;
  // ML-DSA keys (детерминирани)
  mlDsaPublicKey:  Uint8Array;
  mlDsaSecretKey:  Uint8Array;
}

let _testKeys: TestKeys | null = null;

const ECDSA_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

/**
 * Инициализира тестовите ключове. Вика се веднъж от beforeAll().
 * Кешира резултата на модул ниво за целия test run.
 */
export async function initTestKeys(): Promise<TestKeys> {
  if (_testKeys) return _testKeys;

  // ML-DSA — детерминиран
  const mlDsaKey = ml_dsa65.keygen(FIXED_ML_DSA_SEED);

  // Root CA keypair
  const rootCaKeys = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
  const rootCaCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Test Root CA, O=SignShield Test',
    notBefore: new Date('2025-01-01'),
    notAfter:  new Date('2035-01-01'),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys: rootCaKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true,
      ),
    ],
  });

  // Нормален leaf cert (valid, подписан от test Root CA)
  const leafKeys = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
  const leafCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=Test Signer',
    issuer:  rootCaCert.subject,
    notBefore: new Date('2025-01-01'),
    notAfter:  new Date('2035-01-01'),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey:   leafKeys.publicKey,
    signingKey:  rootCaKeys.privateKey,
  });

  // Expired leaf cert
  const expiredLeafKeys = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
  const expiredLeafCert = await x509.X509CertificateGenerator.create({
    serialNumber: '03',
    subject: 'CN=Expired Signer',
    issuer:  rootCaCert.subject,
    notBefore: new Date('2020-01-01'),
    notAfter:  new Date('2021-01-01'), // в миналото
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey:  expiredLeafKeys.publicKey,
    signingKey: rootCaKeys.privateKey,
  });

  // Foreign CA (untrusted)
  const foreignCaKeys = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
  const foreignLeafKeys = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
  const foreignCaCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '04',
    name: 'CN=Foreign Root CA',
    notBefore: new Date('2025-01-01'),
    notAfter:  new Date('2035-01-01'),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys: foreignCaKeys,
  });
  const foreignLeafCert = await x509.X509CertificateGenerator.create({
    serialNumber: '05',
    subject: 'CN=Foreign Signer',
    issuer:  foreignCaCert.subject,
    notBefore: new Date('2025-01-01'),
    notAfter:  new Date('2035-01-01'),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey:  foreignLeafKeys.publicKey,
    signingKey: foreignCaKeys.privateKey,
  });

  _testKeys = {
    rootCaKeys,
    rootCaCertDer: new Uint8Array(rootCaCert.rawData),
    leafKeys,
    leafCertDer:   new Uint8Array(leafCert.rawData),
    expiredLeafKeys,
    expiredLeafCertDer: new Uint8Array(expiredLeafCert.rawData),
    foreignCaKeys,
    foreignLeafKeys,
    foreignLeafCertDer: new Uint8Array(foreignLeafCert.rawData),
    mlDsaPublicKey: mlDsaKey.publicKey,
    mlDsaSecretKey: mlDsaKey.secretKey,
  };
  return _testKeys;
}

// ─── Core signing helper ──────────────────────────────────────────────────────

interface SignOptions {
  privateKey:   CryptoKey;
  certDer:      Uint8Array;
  caCertDer:    Uint8Array;
  includePQ?:   boolean;
  mlDsaSecret?: Uint8Array;
  mlDsaPublic?: Uint8Array;
  /**
   * Ако true → вграждаме publicKeyB64url = "" (симулира стар формат).
   */
  emptyPqPublicKey?: boolean;
}

/** Подписва MINIMAL_PDF с дадените ключове. Връща signed PDF bytes. */
async function signPdf(opts: SignOptions): Promise<Uint8Array> {
  const signingDate = new Date('2026-07-10T12:00:00Z');

  const prepared = await preparePdfForSigning(
    new Uint8Array(MINIMAL_PDF),
    'Test Signer',
    signingDate,
    { markerX: 30, markerY: 30, pageIndex: 0 },
  );

  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);

  const signedAttrs = buildSignedAttrs(messageDigest);

  // Подписваме signedAttrs (SET bytes, tag 0x31) директно с CryptoKey.
  // buildCmsDetached() вътрешно пресъздава signedAttrs — подаваме messageDigest.
  const ecdsaSigReal = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.privateKey, signedAttrs as unknown as Uint8Array<ArrayBuffer>),
  );
  void signedAttrs; // изчислен по-горе, ползван само за подписването

  const cmsDer = buildCmsDetached(messageDigest, ecdsaSigReal, opts.certDer, opts.caCertDer);

  let pqData = null;
  if (opts.includePQ && opts.mlDsaSecret && opts.mlDsaPublic) {
    const mlSig = ml_dsa65.sign(messageDigest, opts.mlDsaSecret);
    pqData = {
      algorithm:       'ml-dsa-65',
      signedHash:      encodeBase64url(messageDigest),
      signatureB64url: encodeBase64url(mlSig),
      publicKeyB64url: opts.emptyPqPublicKey ? '' : encodeBase64url(opts.mlDsaPublic),
      attestation:     { hasCert: false },
      byteRange:       [...byteRange],
    };
  }

  return injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
}

// ─── Fixture генератори ────────────────────────────────────────────────────────

/** 1. Валиден хибриден подпис (ECDSA + ML-DSA). */
export async function makeValidHybridPdf(keys: TestKeys): Promise<Uint8Array> {
  return signPdf({
    privateKey: keys.leafKeys.privateKey,
    certDer:    keys.leafCertDer,
    caCertDer:  keys.rootCaCertDer,
    includePQ:  true,
    mlDsaSecret: keys.mlDsaSecretKey,
    mlDsaPublic: keys.mlDsaPublicKey,
  });
}

/** 2. Валиден ECDSA-only подпис (без ML-DSA stream). */
export async function makeValidEcdsaOnlyPdf(keys: TestKeys): Promise<Uint8Array> {
  return signPdf({
    privateKey: keys.leafKeys.privateKey,
    certDer:    keys.leafCertDer,
    caCertDer:  keys.rootCaCertDer,
    includePQ:  false,
  });
}

/**
 * 3. Модифициран документ — 1 байт flip в SIGNED region (не в /Contents).
 * Résultat: messageDigest mismatch → 'tampered'.
 */
export async function makeModifiedBodyPdf(keys: TestKeys): Promise<Uint8Array> {
  const signed = await makeValidEcdsaOnlyPdf(keys);
  const modified = new Uint8Array(signed);
  // Байт 50 е в signed region [0..A-1], далеч от /Contents placeholder
  modified[50] = modified[50] ^ 0xFF;
  return modified;
}

/**
 * 4. Модифицирана сигнатура — вграждаме нарочно невалиден ECDSA P1363 подпис.
 * DER структурата на CMS е валидна, но sig bytes са грешни.
 * Résultat: hash match (messageDigest = computedHash, документът не е пипнат),
 *           но ECDSA verify fail-ва → overall = 'invalid'.
 */
export async function makeModifiedSignaturePdf(keys: TestKeys): Promise<Uint8Array> {
  const signingDate = new Date('2026-07-10T12:00:00Z');
  const prepared = await preparePdfForSigning(
    new Uint8Array(MINIMAL_PDF), 'Test Signer', signingDate,
    { markerX: 30, markerY: 30, pageIndex: 0 },
  );
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);

  // Генерираме валиден ECDSA подпис, после флипваме 10+ байта дълбоко в r-компонента
  const signedAttrs = buildSignedAttrs(messageDigest);
  const realSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.privateKey, signedAttrs as unknown as Uint8Array<ArrayBuffer>),
  );
  // Флипваме байтове 12..15 в P1363 (дълбоко в r, далеч от DER структурните байтове)
  const corruptedSig = new Uint8Array(realSig);
  corruptedSig[12] ^= 0xFF;
  corruptedSig[13] ^= 0xFF;

  const cmsDer = buildCmsDetached(messageDigest, corruptedSig, keys.leafCertDer, keys.rootCaCertDer);
  return injectSignatureAndPQ(prepared, byteRange, cmsDer, null);
}

/** 5. Изтекъл сертификат (notAfter в миналото). */
export async function makeExpiredCertPdf(keys: TestKeys): Promise<Uint8Array> {
  return signPdf({
    privateKey: keys.expiredLeafKeys.privateKey,
    certDer:    keys.expiredLeafCertDer,
    caCertDer:  keys.rootCaCertDer,
    includePQ:  false,
  });
}

/** 6. Untrusted CA — подписан от чужд Root CA. */
export async function makeUntrustedCaPdf(keys: TestKeys): Promise<Uint8Array> {
  return signPdf({
    privateKey: keys.foreignLeafKeys.privateKey,
    certDer:    keys.foreignLeafCertDer,
    caCertDer:  keys.rootCaCertDer, // нашият CA в CMS (за да изглежда легитимно), но листът е чужд
    includePQ:  false,
  });
}

/** 7. PDF без подпис. */
export function makeUnsignedPdf(): Uint8Array {
  return new Uint8Array(MINIMAL_PDF);
}

/** 8. Malicious PDF с /JavaScript. */
export function makeMaliciousPdf(): Uint8Array {
  const base = new TextDecoder().decode(MINIMAL_PDF);
  const malicious = base + '\n/JavaScript << /JS (app.alert("XSS")) >>\n';
  return new TextEncoder().encode(malicious);
}

/**
 * 9. Стар формат — ML-DSA присъства но publicKeyB64url е "" (преди fix-а).
 * Verifier трябва да върне mlDsa.status = 'not_included'.
 */
export async function makeOldFormatPdf(keys: TestKeys): Promise<Uint8Array> {
  return signPdf({
    privateKey: keys.leafKeys.privateKey,
    certDer:    keys.leafCertDer,
    caCertDer:  keys.rootCaCertDer,
    includePQ:  true,
    mlDsaSecret: keys.mlDsaSecretKey,
    mlDsaPublic: keys.mlDsaPublicKey,
    emptyPqPublicKey: true,
  });
}

/**
 * 10. ML-DSA подписът е corrupted — вграждаме невалиден PQ sig при construction.
 * PQ stream е извън ByteRange (incremental update), затова ECDSA не го засяга.
 * Résultat: ECDSA valid, ML-DSA invalid → overall = 'invalid'.
 */
export async function makeMlDsaInvalidPdf(keys: TestKeys): Promise<Uint8Array> {
  const signingDate = new Date('2026-07-10T12:00:00Z');
  const prepared = await preparePdfForSigning(
    new Uint8Array(MINIMAL_PDF), 'Test Signer', signingDate,
    { markerX: 30, markerY: 30, pageIndex: 0 },
  );
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);

  const signedAttrs = buildSignedAttrs(messageDigest);
  const ecdsaSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.leafKeys.privateKey, signedAttrs as unknown as Uint8Array<ArrayBuffer>),
  );
  const cmsDer = buildCmsDetached(messageDigest, ecdsaSig, keys.leafCertDer, keys.rootCaCertDer);

  // Генерираме валиден ML-DSA подпис, после корумпираме първите 10 байта
  const mlSig = ml_dsa65.sign(messageDigest, keys.mlDsaSecretKey);
  const corruptedMlSig = new Uint8Array(mlSig);
  corruptedMlSig[0]  ^= 0xFF;
  corruptedMlSig[5]  ^= 0xFF;
  corruptedMlSig[10] ^= 0xFF;

  const pqData = {
    algorithm:       'ml-dsa-65',
    signedHash:      encodeBase64url(messageDigest),
    signatureB64url: encodeBase64url(corruptedMlSig),
    publicKeyB64url: encodeBase64url(keys.mlDsaPublicKey),
    attestation:     { hasCert: false },
    byteRange:       [...byteRange],
  };

  return injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
}
