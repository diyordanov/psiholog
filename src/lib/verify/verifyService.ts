/**
 * verifyService.ts
 * Оркестрира пълния signing verification flow.
 *
 * Flow:
 *   1. PDF sanitization (scanPdf) — отхвърля malicious PDF
 *   2. extractByteRange()         — намира подписания диапазон
 *   3. extractCmsDer()            — извлича CMS DER от /Contents
 *   4. extractPqStream()          — извлича ML-DSA-65 JSON (или null)
 *   5. computeSignedHash()        — SHA-256 на ByteRange bytes
 *   6. parseCms()                 — извлича leaf cert, signedAttrs, sig
 *   7. verifyCertChain()          — валидира leaf cert срещу Root CA
 *   8. verifyEcdsaSignature()     — ECDSA P-256 верификация
 *   9. verifyMlDsaSignature()     — ML-DSA-65 верификация (ако е налична)
 *  10. assemblResult()            — определя overall status
 *
 * Offline верификация: нищо не напуска браузъра. Root CA cert идва от
 * rootCaCert.ts (bundled в build-а). Дългосрочно валидна — работи и след
 * 10 години без наш backend.
 */

import * as x509 from '@peculiar/x509';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { scanPdf } from '../pdfSanitizer';
import {
  extractByteRange, extractCmsDer, extractPqStream,
  extractSigningDate, computeSignedHash, bytesToHexStr, decodeBase64url,
} from '../pdf/pdfVerifier';
import { parseCms, makeSignedAttrsSet } from '../pdf/cmsParser';
import { ROOT_CA_CERT_PEM } from '../crypto/rootCaCert';
import type {
  VerifyResult, EcdsaVerifyResult, MlDsaVerifyResult, CertChainStatus,
} from './types';

// Root CA cert — PEM → DER, зарежда се веднъж при import на модула
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
const ROOT_CA_CERT_DER = pemToDer(ROOT_CA_CERT_PEM);

// ─── Sub-functions ────────────────────────────────────────────────────────────

/** Опции за verifyDocument — injectable root CA cert за тестове. */
export interface VerifyOptions {
  /** Root CA DER cert. По подразбиране: ROOT_CA_CERT_DER от rootCaCert.ts. */
  rootCaCertDer?: Uint8Array;
}

/**
 * Верифицира X.509 chain: leaf cert подписан ли е от Root CA?
 * Проверява и validity period.
 *
 * @param rootCaCertDer  Injectable за тестове (default: нашият Root CA).
 */
export async function verifyCertChain(
  leafCertDer: Uint8Array,
  rootCaCertDer: Uint8Array = ROOT_CA_CERT_DER,
): Promise<{ status: CertChainStatus; expiry: Date; signerName: string; issuerName: string }> {
  const leaf   = new x509.X509Certificate(leafCertDer as unknown as Uint8Array<ArrayBuffer>);
  const rootCa = new x509.X509Certificate(rootCaCertDer as unknown as Uint8Array<ArrayBuffer>);
  const issuerName = extractCn(leaf.issuer);

  // Validity period
  const now = new Date();
  if (now > leaf.notAfter) {
    return {
      status: 'expired',
      expiry: leaf.notAfter,
      signerName: extractCn(leaf.subject),
      issuerName,
    };
  }

  // Chain validation: leaf подписан ли е от rootCa?
  try {
    const rootPublicKey = await rootCa.publicKey.export();
    const chainValid = await leaf.verify({ publicKey: rootPublicKey });
    if (!chainValid) throw new Error('chain invalid');
  } catch {
    return {
      status: 'chain_invalid',
      expiry: leaf.notAfter,
      signerName: extractCn(leaf.subject),
      issuerName,
    };
  }

  return {
    status: 'ok',
    expiry: leaf.notAfter,
    signerName: extractCn(leaf.subject),
    issuerName,
  };
}

/** Извлича CN= стойността от X.500 DN string. */
function extractCn(dn: string): string {
  const m = dn.match(/CN=([^,]+)/i);
  return m ? m[1].trim() : dn;
}

/**
 * Верифицира ECDSA P-256 подпис.
 *
 * Стъпки:
 *   1. messageDigest от signedAttrs === computedHash → документът не е модифициран
 *   2. ECDSA подпис над signedAttrs (като SET) е валиден
 */
export async function verifyEcdsaSignature(
  leafCertDer: Uint8Array,
  signedAttrsImplicit: Uint8Array,
  ecdsaSigP1363: Uint8Array,
  messageDigest: Uint8Array,
  computedHash: Uint8Array,
): Promise<{ valid: boolean; tampered: boolean; errorMessage?: string }> {
  // Стъпка 1: integrity check — hash match
  const tampered = !bytesArrayEqual(messageDigest, computedHash);
  if (tampered) {
    return { valid: false, tampered: true, errorMessage: 'Документът е модифициран след подписване.' };
  }

  // Стъпка 2: ECDSA verify над signedAttrs
  try {
    const leaf = new x509.X509Certificate(leafCertDer as unknown as Uint8Array<ArrayBuffer>);
    const publicKey = await leaf.publicKey.export();

    // Сменяме 0xA0 → 0x31 (SET) за верификация
    const signedAttrsSet = makeSignedAttrsSet(signedAttrsImplicit);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      ecdsaSigP1363 as unknown as Uint8Array<ArrayBuffer>,
      signedAttrsSet as unknown as Uint8Array<ArrayBuffer>,
    );
    return { valid, tampered: false, errorMessage: valid ? undefined : 'ECDSA подписът е невалиден.' };
  } catch (e) {
    return {
      valid: false,
      tampered: false,
      errorMessage: `Грешка при ECDSA верификация: ${e instanceof Error ? e.message : 'неизвестна'}`,
    };
  }
}

/**
 * Верифицира ML-DSA-65 подпис от /PostQuantumSignature stream.
 *
 * Ако publicKeyB64url е празен (стар документ без вграден публичен ключ),
 * връщаме статус 'not_included' с информативно съобщение.
 */
export function verifyMlDsaSignature(
  pqData: { signatureB64url: string; publicKeyB64url: string; signedHash: string },
  computedHash: Uint8Array,
): MlDsaVerifyResult {
  const publicKeyBytes = decodeBase64url(pqData.publicKeyB64url);

  // Стар документ — публичният ключ не е бил вграден
  if (publicKeyBytes.length === 0) {
    return {
      status: 'not_included',
      algorithm: 'ml-dsa-65',
      errorMessage: 'Публичният ключ не е вграден в документа (стар формат).',
    };
  }

  try {
    const sig       = decodeBase64url(pqData.signatureB64url);
    const embHash   = decodeBase64url(pqData.signedHash);

    // Embedded hash трябва да съвпада с изчисления (допълнителна integrity проверка)
    if (!bytesArrayEqual(embHash, computedHash)) {
      return {
        status: 'invalid',
        algorithm: 'ml-dsa-65',
        errorMessage: 'ML-DSA хешът не съвпада с документа.',
      };
    }

    // ml_dsa65.verify(sig, msg, publicKey) — ред: sig, message, pubKey
    const valid = ml_dsa65.verify(sig, computedHash, publicKeyBytes);
    return {
      status: valid ? 'valid' : 'invalid',
      algorithm: 'ml-dsa-65',
      sigBytes: sig,
      errorMessage: valid ? undefined : 'ML-DSA-65 подписът е невалиден.',
    };
  } catch (e) {
    return {
      status: 'invalid',
      algorithm: 'ml-dsa-65',
      errorMessage: `Грешка при ML-DSA верификация: ${e instanceof Error ? e.message : 'неизвестна'}`,
    };
  }
}

// ─── Главен orchestrator ──────────────────────────────────────────────────────

/**
 * Верифицира подписан PDF документ.
 *
 * Верификацията е изцяло client-side — документът никога не напуска браузъра.
 * Работи offline; не изисква backend.
 *
 * @param pdfBytes       Raw байтовете на PDF файла
 * @param options        { rootCaCertDer } — injectable за тестове
 */
export async function verifyDocument(
  pdfBytes: Uint8Array,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const rootCaCertDer = options.rootCaCertDer ?? ROOT_CA_CERT_DER;

  // ── 1. PDF sanitization ───────────────────────────────────────────────────
  const sanitization = scanPdf(pdfBytes.buffer as ArrayBuffer);
  if (!sanitization.safe) {
    return {
      overall: 'error',
      documentHash: null,
      byteRange: null,
      ecdsa: null,
      mlDsa: null,
      errorMessage: `Файлът съдържа потенциално опасен код: ${sanitization.threats.join(', ')}.`,
    };
  }

  // ── 2. Извличане на ByteRange ─────────────────────────────────────────────
  const byteRange = extractByteRange(pdfBytes);
  if (!byteRange) {
    return {
      overall: 'unsigned',
      documentHash: null,
      byteRange: null,
      ecdsa: null,
      mlDsa: null,
      errorMessage: 'PDF не съдържа цифров подпис.',
    };
  }

  // ── 3. Извличане на CMS DER ───────────────────────────────────────────────
  const cmsDer = extractCmsDer(pdfBytes);
  if (!cmsDer) {
    return {
      overall: 'error',
      documentHash: null,
      byteRange,
      ecdsa: null,
      mlDsa: null,
      errorMessage: 'Не може да се извлече CMS подпис от PDF.',
    };
  }

  // ── 4. ML-DSA-65 stream (опционален) ─────────────────────────────────────
  const pqData = extractPqStream(pdfBytes);

  // ── 5. Compute document hash ──────────────────────────────────────────────
  const computedHash = computeSignedHash(pdfBytes, byteRange);
  const documentHash = bytesToHexStr(computedHash);

  // ── 6. CMS parsing ────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseCms(cmsDer);
  } catch (e) {
    return {
      overall: 'error',
      documentHash,
      byteRange,
      ecdsa: null,
      mlDsa: null,
      errorMessage: `Невалидна CMS структура: ${e instanceof Error ? e.message : 'неизвестна'}`,
    };
  }

  const { leafCertDer, signedAttrsImplicit, messageDigest, ecdsaSigP1363 } = parsed;

  // ── 7. Cert chain ─────────────────────────────────────────────────────────
  const chainResult = await verifyCertChain(leafCertDer, rootCaCertDer);
  const signedAt    = extractSigningDate(pdfBytes);

  // ── 8. ECDSA верификация ──────────────────────────────────────────────────
  const ecdsaResult = await verifyEcdsaSignature(
    leafCertDer, signedAttrsImplicit, ecdsaSigP1363, messageDigest, computedHash,
  );

  const ecdsaVerify: EcdsaVerifyResult = {
    status:    ecdsaResult.tampered ? 'invalid' : (ecdsaResult.valid ? 'valid' : 'invalid'),
    algorithm: 'ecdsa-p256',
    signerName: chainResult.signerName,
    signedAt,
    certStatus:  chainResult.status,
    certExpiry:  chainResult.expiry,
    certIssuer:  chainResult.issuerName,
    certDer:     leafCertDer,
    sigBytes:    ecdsaSigP1363,
    errorMessage: ecdsaResult.errorMessage,
  };

  // ── 9. ML-DSA верификация ─────────────────────────────────────────────────
  let mlDsaVerify: MlDsaVerifyResult;
  if (!pqData) {
    mlDsaVerify = { status: 'not_included', algorithm: 'ml-dsa-65' };
  } else {
    mlDsaVerify = verifyMlDsaSignature(pqData, computedHash);
  }

  // ── 10. Overall status ────────────────────────────────────────────────────
  const overall = determineOverall(ecdsaResult.tampered, ecdsaVerify, mlDsaVerify);

  return {
    overall,
    documentHash,
    byteRange,
    ecdsa: ecdsaVerify,
    mlDsa: mlDsaVerify,
  };
}

/**
 * Определя overall status от резултатите на отделните подписи.
 *
 * Логика:
 *   - tampered:        документът е модифициран → 'tampered' (приоритет)
 *   - ECDSA invalid:   невалиден подпис/chain → 'invalid'
 *   - ML-DSA invalid:  невалиден PQ подпис → 'invalid'
 *   - Всичко OK:       'authentic'
 *   - expired cert:    'authentic' (подписът е бил валиден; UI показва предупреждение)
 */
function determineOverall(
  tampered: boolean,
  ecdsa: EcdsaVerifyResult,
  mlDsa: MlDsaVerifyResult,
): VerifyResult['overall'] {
  if (tampered) return 'tampered';
  if (ecdsa.status === 'invalid') return 'invalid';
  // chain_invalid = сертификатът е от непозната CA → документът е invalid
  if (ecdsa.certStatus === 'chain_invalid') return 'invalid';
  if (mlDsa.status === 'invalid') return 'invalid';
  return 'authentic';
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function bytesArrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
