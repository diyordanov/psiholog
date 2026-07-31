/**
 * verifyService.ts
 * Оркестрира пълния signing verification flow — Ден 3 (Фаза 8): генерализирано
 * за N подписа (multi-signer PDF-и от incremental-update signing pipeline-а).
 *
 * Flow:
 *   1. PDF sanitization (scanPdf)       — отхвърля malicious PDF
 *   2. extractAllSignatures()           — намира ВСИЧКИ /Sig обекта (файлов ред),
 *                                          вкл. /PQSignature от СЪЩИЯ dict (bugfix 2026-07-31)
 *   3. За всеки /Sig обект:
 *        computeSignedHash()            — SHA-256 на своя ByteRange
 *        parseCms()                     — leaf cert, signedAttrs, sig
 *        verifyCertChain()              — валидира leaf cert срещу Root CA
 *        verifyEcdsaSignature()         — ECDSA P-256 верификация
 *        verifyMlDsaSignature()         — ако има pqData в /Sig dict-а
 *   4. determineOverall()                — приоритет: tampered > invalid >
 *                                          authentic_with_warnings > authentic
 *
 * N=1 (single-signer PDF) е частен случай: extractAllSignatures() връща масив
 * с 1 елемент — same code path, без специален case.
 *
 * Offline верификация: нищо не напуска браузъра. Root CA cert идва от
 * rootCaCert.ts (bundled в build-а). Дългосрочно валидна — работи и след
 * 10 години без наш backend.
 */

import * as x509 from '@peculiar/x509';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { scanPdf } from '../pdfSanitizer';
import {
  extractAllSignatures, countSignatureMarkers,
  computeSignedHash, bytesToHexStr, decodeBase64url,
} from '../pdf/pdfVerifier';
import { parseCms, makeSignedAttrsSet } from '../pdf/cmsParser';
import { ROOT_CA_CERT_PEM } from '../crypto/rootCaCert';
import type {
  VerifyResult, SignerResult, EcdsaVerifyResult, MlDsaVerifyResult, CertChainStatus,
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
 * Верифицира ML-DSA-65 подпис от /PQSignature (виж bugfix 2026-07-31 в pdfSigner.ts).
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

/**
 * Верифицира ЕДИН /Sig обект (raw extraction резултат) → SignerResult.
 * Никога не хвърля — при повредена CMS структура връща signer с
 * ecdsa.status='invalid' и ясно errorMessage, вместо да прекъсне целия flow
 * (така другите N-1 подписа в документа продължават да се верифицират и
 * показват коректно).
 */
async function verifySingleSigner(
  pdfBytes: Uint8Array,
  raw: {
    index: number;
    byteRange: [number, number, number, number] | null;
    cmsDer: Uint8Array | null;
    signedAt: Date | null;
    pqData: import('../pdf/pdfSigner').PqSignatureData | null;
  },
  rootCaCertDer: Uint8Array,
): Promise<SignerResult> {
  // Структурно повреден /Sig обект (липсва ByteRange или Contents в dict-а) —
  // не можем да изчислим hash или да парснем CMS.
  if (!raw.byteRange || !raw.cmsDer) {
    const ecdsa: EcdsaVerifyResult = {
      status: 'invalid',
      algorithm: 'ecdsa-p256',
      signerName: '—',
      signedAt: raw.signedAt,
      certStatus: null,
      certExpiry: null,
      certIssuer: null,
      certDer: null,
      sigBytes: null,
      tampered: false,
      errorMessage: !raw.byteRange
        ? 'ByteRange не е намерен за този подпис.'
        : 'Не може да се извлече CMS подпис от този слот.',
    };
    return { signerIndex: raw.index, ecdsa, mlDsa: null, signerName: ecdsa.signerName, signedAt: ecdsa.signedAt };
  }

  const computedHash = computeSignedHash(pdfBytes, raw.byteRange);
  const mlDsa: MlDsaVerifyResult | null = raw.pqData ? verifyMlDsaSignature(raw.pqData, computedHash) : null;

  let ecdsa: EcdsaVerifyResult;
  try {
    const { leafCertDer, signedAttrsImplicit, messageDigest, ecdsaSigP1363 } = parseCms(raw.cmsDer);
    const chainResult = await verifyCertChain(leafCertDer, rootCaCertDer);
    const ecdsaResult = await verifyEcdsaSignature(
      leafCertDer, signedAttrsImplicit, ecdsaSigP1363, messageDigest, computedHash,
    );
    ecdsa = {
      status: ecdsaResult.valid ? 'valid' : 'invalid',
      algorithm: 'ecdsa-p256',
      signerName: chainResult.signerName,
      signedAt: raw.signedAt,
      certStatus: chainResult.status,
      certExpiry: chainResult.expiry,
      certIssuer: chainResult.issuerName,
      certDer: leafCertDer,
      sigBytes: ecdsaSigP1363,
      tampered: ecdsaResult.tampered,
      errorMessage: ecdsaResult.errorMessage,
    };
  } catch (e) {
    ecdsa = {
      status: 'invalid',
      algorithm: 'ecdsa-p256',
      signerName: '—',
      signedAt: raw.signedAt,
      certStatus: null,
      certExpiry: null,
      certIssuer: null,
      certDer: null,
      sigBytes: null,
      tampered: false,
      errorMessage: `Невалидна CMS структура: ${e instanceof Error ? e.message : 'неизвестна'}`,
    };
  }

  return { signerIndex: raw.index, ecdsa, mlDsa, signerName: ecdsa.signerName, signedAt: ecdsa.signedAt };
}

/**
 * Определя overall status от резултатите на всички подписващи.
 *
 * Приоритет (най-тежкото печели):
 *   1. tampered                — hash mismatch при поне един подпис
 *   2. invalid                 — ECDSA sig fail / chain untrusted / ML-DSA invalid
 *                                 при поне един подпис (вкл. повредена CMS структура)
 *   3. authentic_with_warnings — изтекъл сертификат ИЛИ "смесена" PQ защита
 *                                 (поне 1 signer има валиден ML-DSA, друг няма PQ изобщо)
 *   4. authentic                — всичко чисто
 *
 * Забележка: НЕ следваме буквално "any ECDSA invalid → tampered" (опростен
 * реминдър от плана) — пазим по-прецизното разграничение tampered (hash
 * mismatch, документът е пипнат) vs invalid (подпис/верига невалидни, но
 * данните са същите), установено още в single-signer verifyService и
 * потвърдено от съществуващите modified-body/modified-signature fixtures.
 */
function determineOverall(signers: SignerResult[]): VerifyResult['overall'] {
  if (signers.some(s => s.ecdsa.tampered)) return 'tampered';
  if (signers.some(s => s.ecdsa.status === 'invalid')) return 'invalid';
  if (signers.some(s => s.ecdsa.certStatus === 'chain_invalid')) return 'invalid';
  if (signers.some(s => s.mlDsa?.status === 'invalid')) return 'invalid';

  const anyExpired      = signers.some(s => s.ecdsa.certStatus === 'expired');
  const anyValidMlDsa   = signers.some(s => s.mlDsa?.status === 'valid');
  const anyMissingMlDsa = signers.some(s => s.mlDsa === null || s.mlDsa.status === 'not_included');
  if (anyExpired || (anyValidMlDsa && anyMissingMlDsa)) return 'authentic_with_warnings';

  return 'authentic';
}

// ─── Главен orchestrator ──────────────────────────────────────────────────────

/**
 * Верифицира подписан PDF документ — поддържа N подписа (N≥1).
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
      signers: [],
      totalSigners: 0,
      errorMessage: `Файлът съдържа потенциално опасен код: ${sanitization.threats.join(', ')}.`,
    };
  }

  // ── 2. Извличане на ВСИЧКИ /Sig обекта (файлов ред = ред на подписване) ───
  const rawSignatures = extractAllSignatures(pdfBytes);
  if (rawSignatures.length === 0) {
    const hasMarkers = countSignatureMarkers(pdfBytes) > 0;
    return {
      overall: hasMarkers ? 'error' : 'unsigned',
      documentHash: null,
      byteRange: null,
      signers: [],
      totalSigners: 0,
      errorMessage: hasMarkers
        ? 'Не може да се извлече CMS подпис от PDF.'
        : 'PDF не съдържа цифров подпис.',
    };
  }

  // ── 3. Верификация на всеки подписващ поотделно (pqData вече directly
  // paired В extractAllSignatures() резултата — /PQSignature е В СЪЩИЯ /Sig
  // dict, виж bugfix 2026-07-31, елиминира целия signerIndex association клас
  // бъгове) ─────────────────────────────────────────────────────────────────
  const signers: SignerResult[] = [];
  for (const raw of rawSignatures) {
    signers.push(await verifySingleSigner(pdfBytes, raw, rootCaCertDer));
  }

  // ── 5. documentHash / byteRange на ниво резултат ─────────────────────────
  // Взимаме ПОСЛЕДНИЯ /Sig с валиден ByteRange — той покрива целия файл,
  // включително всички предходни подписи (най-представителен за "цялост").
  const lastWithByteRange = [...rawSignatures].reverse().find(r => r.byteRange);
  const byteRange = lastWithByteRange?.byteRange ?? null;
  const documentHash = byteRange ? bytesToHexStr(computeSignedHash(pdfBytes, byteRange)) : null;

  // ── 6. Overall status ─────────────────────────────────────────────────────
  const overall = determineOverall(signers);
  const firstError = signers.find(s => s.ecdsa.errorMessage)?.ecdsa.errorMessage;

  return {
    overall,
    documentHash,
    byteRange,
    signers,
    totalSigners: signers.length,
    errorMessage: overall === 'invalid' || overall === 'tampered' ? firstError : undefined,
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function bytesArrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
