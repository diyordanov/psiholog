/**
 * types.ts — типове за резултата от верификация на подписан PDF.
 *
 * OverallStatus:
 *   authentic       — всички налични подписи са валидни, документът не е модифициран
 *   tampered        — документът е модифициран след подписване (hash mismatch)
 *   invalid         — поне един подпис е невалиден (chain, sig bytes)
 *   unsigned        — PDF не съдържа цифров подпис
 *   error           — неочаквана грешка при парсиране (повреден PDF и т.н.)
 */

export type OverallStatus = 'authentic' | 'tampered' | 'invalid' | 'unsigned' | 'error';

/** Статус на отделен подпис. */
export type SignatureStatus = 'valid' | 'invalid' | 'not_included';

/** Статус на X.509 сертификата. */
export type CertChainStatus = 'ok' | 'expired' | 'chain_invalid';

export interface EcdsaVerifyResult {
  status: SignatureStatus;
  algorithm: 'ecdsa-p256';
  /** Подписващ — SubjectCN от X.509 сертификата. */
  signerName: string;
  /** Дата от /M полето на PDF signature dictionary. */
  signedAt: Date | null;
  certStatus: CertChainStatus | null;
  certExpiry: Date | null;
  /** CN на издателя (от X.509 cert.issuer). */
  certIssuer: string | null;
  /** Raw DER байтове на leaf сертификата — за CertificateModal. */
  certDer: Uint8Array | null;
  /** P1363 подписни байтове — за fingerprint в доклада. */
  sigBytes: Uint8Array | null;
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

export interface VerifyResult {
  overall: OverallStatus;
  /** SHA-256 hex на подписаните байтове (ByteRange). */
  documentHash: string | null;
  /** [0, A, B, C] — подписаният byte range. */
  byteRange: [number, number, number, number] | null;
  ecdsa: EcdsaVerifyResult | null;
  mlDsa: MlDsaVerifyResult | null;
  /** Глобална грешка (PDF не може да се parse-не, малициозно и т.н.). */
  errorMessage?: string;
}
