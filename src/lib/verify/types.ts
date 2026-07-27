/**
 * types.ts — типове за резултата от верификация на подписан PDF.
 *
 * Ден 3 (Фаза 8): генерализирано за N подписа — `VerifyResult.signers` съдържа
 * по един `SignerResult` за всеки /Sig обект във файла, във файлов ред (owner
 * пръв). N=1 (single-signer PDF) е просто частен случай: `signers.length === 1`.
 *
 * OverallStatus:
 *   authentic                — всички подписи валидни, документът не е модифициран
 *   authentic_with_warnings  — документът е автентичен, но има несъответствие
 *                               (изтекъл сертификат при поне 1 подписващ, ИЛИ
 *                               поне 1 подписващ има валиден ML-DSA докато
 *                               друг няма PQ защита изобщо — "смесена" защита)
 *   tampered                 — документът е модифициран след подписване (hash mismatch
 *                               при поне един подпис — приоритет пред всичко друго)
 *   invalid                  — поне един подпис е невалиден (crypto verify fail,
 *                               непозната CA верига, повредена CMS структура, или
 *                               невалиден ML-DSA)
 *   unsigned                 — PDF не съдържа нито един /Sig обект
 *   error                    — неочаквана грешка (malicious PDF, sanitizer reject)
 */

export type OverallStatus =
  | 'authentic'
  | 'authentic_with_warnings'
  | 'tampered'
  | 'invalid'
  | 'unsigned'
  | 'error';

/** Статус на отделен подпис. */
export type SignatureStatus = 'valid' | 'invalid' | 'not_included';

/** Статус на X.509 сертификата. */
export type CertChainStatus = 'ok' | 'expired' | 'chain_invalid';

export interface EcdsaVerifyResult {
  status: SignatureStatus;
  algorithm: 'ecdsa-p256';
  /** Подписващ — SubjectCN от X.509 сертификата ("—" ако CMS не парсва). */
  signerName: string;
  /** Дата от /M полето на PDF signature dictionary (за този конкретен подпис). */
  signedAt: Date | null;
  certStatus: CertChainStatus | null;
  certExpiry: Date | null;
  /** CN на издателя (от X.509 cert.issuer). */
  certIssuer: string | null;
  /** Raw DER байтове на leaf сертификата — за CertificateModal. */
  certDer: Uint8Array | null;
  /** P1363 подписни байтове — за fingerprint в доклада. */
  sigBytes: Uint8Array | null;
  /**
   * true = hash mismatch (документът е модифициран СЛЕД този подпис) —
   * различно от sig/chain failure. Определя overall='tampered' с приоритет.
   */
  tampered?: boolean;
  /** Ясно съобщение при невалиден статус (на български). */
  errorMessage?: string;
}

export interface MlDsaVerifyResult {
  status: SignatureStatus;
  algorithm: 'ml-dsa-65';
  /** Raw подписни байтове — за fingerprint в доклада. */
  sigBytes?: Uint8Array;
  errorMessage?: string;
}

/** Резултат за ЕДИН подписващ в N-signer документ (Ден 3 generalize). */
export interface SignerResult {
  /** 0-based, файлов ред = ред на подписване (owner е 0). */
  signerIndex: number;
  ecdsa: EcdsaVerifyResult;
  /** null = за този подписващ няма PQ слот изобщо (recipient в incremental flow, не legacy). */
  mlDsa: MlDsaVerifyResult | null;
  /** Convenience alias на ecdsa.signerName. */
  signerName: string;
  /** Convenience alias на ecdsa.signedAt. */
  signedAt: Date | null;
}

export interface VerifyResult {
  overall: OverallStatus;
  /** SHA-256 hex на подписаните байтове от ПОСЛЕДНИЯ /Sig (покрива целия файл). */
  documentHash: string | null;
  /** [0, A, B, C] на ПОСЛЕДНИЯ /Sig — byte range-ът, който покрива целия документ. */
  byteRange: [number, number, number, number] | null;
  /** Един запис за всеки /Sig обект във файла, файлов ред (owner пръв). */
  signers: SignerResult[];
  /** signers.length — convenience за UI ("Подписан от N лица"). */
  totalSigners: number;
  /** Глобална грешка (PDF не може да се parse-не, malicious, и т.н.). */
  errorMessage?: string;
}
