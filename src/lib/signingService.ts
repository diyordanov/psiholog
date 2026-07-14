/**
 * signingService.ts — Ден 3 orchestration
 *
 * Flow:
 *   1. Fetch документа + validate ownership → if status='signed' → throw
 *   2. Grace period: последен подпис за documentId < 30 сек → throw
 *   3. resolveSigningKeys → fetchBestKeyId × 2 → fetchKeyDecryptData × 2 → cert validation
 *   4. PRF ceremony (единичен ако credential_id съвпадат, иначе два) → decrypt secret keys
 *   5. Download PDF → preparePdfForSigning → byte ranges → hash
 *   6. ECDSA P-256 подпис → CMS/PAdES → ML-DSA-65 PQ подпис (ако е наличен)
 *   7. injectSignatureAndPQ → upload signed-documents → UPDATE documents + INSERT signatures
 *
 * Root CA cert идва от repo (src/lib/crypto/rootCaCert.ts) — публичен, не от DB.
 */

import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';
import { fetchBestKeyId, fetchKeyDecryptData } from './signingKeyStore';
import {
  deriveAesKeyFromPRF, deriveDualAesKeysFromPRF, decryptPrivateKey,
  type PrfExtractor, type DualPrfExtractor,
} from './crypto/keyProtection';
import { signWithEcdsaP256, signWithMlDsa } from './crypto/signing';
import { ROOT_CA_CERT_PEM } from './crypto/rootCaCert';
import {
  preparePdfForSigning, computeByteRanges, patchByteRangeInPlace,
  hashByteRanges, injectSignatureAndPQ, encodeBase64url,
  type PqSignatureData, type SignOptions,
} from './pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from './pdf/cmsBuilder';

// ─── Типове ──────────────────────────────────────────────────────────────────

export interface SigningPosition {
  page: number;  // 0-indexed
  x: number;     // PDF points
  y: number;     // PDF points
}

export interface SignDocumentResult {
  signatureId: string;
  signedStoragePath: string;
  pqSkipped: boolean;
}

/** Данни за един ключ, нужни за PRF ceremony + AES decrypt. */
export interface ResolvedKeyData {
  encryptedSecretKey: Uint8Array;
  prfSalt: Uint8Array;
  wrappedKeyIv: Uint8Array;
  credentialId: Uint8Array;
  publicKey: Uint8Array | null;
}

/**
 * Резултат от resolveSigningKeys — включва пълните данни на ключовете.
 * ecdsaData.certificateDer е гарантирано NOT NULL (resolveSigningKeys хвърля ако е null).
 */
export interface ResolvedKeys {
  ecdsaKeyId: string;
  mlDsaKeyId: string | null;
  singlePrf: boolean;
  ecdsaData: ResolvedKeyData & { certificateDer: Uint8Array };
  mlDsaData: (ResolvedKeyData & { certificateDer: Uint8Array | null }) | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

const ROOT_CA_CERT_DER = pemToDer(ROOT_CA_CERT_PEM);

// ─── Публично API ─────────────────────────────────────────────────────────────

/**
 * Избира ECDSA P-256 и ML-DSA-65 ключовете, зарежда пълните им данни и
 * валидира ECDSA сертификат. Детектира единичен vs двоен PRF ceremony.
 *
 * Хвърля ако:
 *   - Няма ECDSA P-256 ключ
 *   - ECDSA ключът няма сертификат
 * Връща mlDsaData: null ако няма ML-DSA-65 ключ.
 */
export async function resolveSigningKeys(): Promise<ResolvedKeys> {
  const ecdsaKeyId = await fetchBestKeyId('ecdsa-p256');
  if (!ecdsaKeyId) {
    throw new Error('Няма активен ECDSA P-256 ключ. Генерирайте ключ преди подписване.');
  }

  const mlDsaKeyId = await fetchBestKeyId('ml-dsa-65');

  const ecdsaRaw = await fetchKeyDecryptData(ecdsaKeyId);
  if (!ecdsaRaw.certificateDer) {
    throw new Error(
      'ECDSA ключът няма сертификат. Натиснете "Издай сертификат" в управлението на ключове.',
    );
  }

  let mlDsaData: ResolvedKeys['mlDsaData'] = null;
  if (mlDsaKeyId) {
    const mlRaw = await fetchKeyDecryptData(mlDsaKeyId);
    mlDsaData = {
      encryptedSecretKey: mlRaw.encryptedSecretKey,
      prfSalt:            mlRaw.prfSalt,
      wrappedKeyIv:       mlRaw.wrappedKeyIv,
      credentialId:       mlRaw.credentialId,
      publicKey:          mlRaw.publicKey,
      certificateDer:     mlRaw.certificateDer,
    };
  }

  const singlePrf = mlDsaData !== null && bytesEqual(ecdsaRaw.credentialId, mlDsaData.credentialId);

  return {
    ecdsaKeyId,
    mlDsaKeyId,
    singlePrf,
    ecdsaData: {
      encryptedSecretKey: ecdsaRaw.encryptedSecretKey,
      prfSalt:            ecdsaRaw.prfSalt,
      wrappedKeyIv:       ecdsaRaw.wrappedKeyIv,
      credentialId:       ecdsaRaw.credentialId,
      publicKey:          ecdsaRaw.publicKey,
      certificateDer:     ecdsaRaw.certificateDer,  // non-null — validated above
    },
    mlDsaData,
  };
}

/**
 * Главната функция: оркестрира пълния signing flow.
 *
 * @param documentId     UUID на документа в таблица documents
 * @param userId         UUID на текущия потребител
 * @param signerName     Показва се в визуалния маркер (display_name от profiles)
 * @param position       Позиция на маркера (от Step 1 на SignDocumentModal)
 * @param rpId           WebAuthn RP ID (window.location.hostname)
 * @param fontBytes      NotoSans-Regular.ttf байтове за Кирилица в маркера
 * @param extractPrf     Injectable single PRF extractor (за тестове)
 * @param extractDualPrf Injectable dual PRF extractor (за тестове)
 */
export async function signDocument(
  documentId: string,
  userId: string,
  signerName: string,
  position: SigningPosition,
  rpId: string,
  fontBytes: Uint8Array | undefined,
  extractPrf?: PrfExtractor,
  extractDualPrf?: DualPrfExtractor,
  onProgress?: (pct: number, label: string) => void,
): Promise<SignDocumentResult> {
  const signingDate = new Date();

  // ── 1. Fetch документа + validate status ──────────────────────────────────
  onProgress?.(5, 'Проверка на документа...');
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .select('storage_path, original_filename, status')
    .eq('id', documentId)
    .single();
  if (docErr || !docRow) {
    console.error('signDocument: fetch document failed:', docErr?.message);
    throw new Error('Документът не е намерен или достъпът е отказан.');
  }
  if (docRow.status === 'signed') throw new Error('Документът вече е подписан.');

  // ── 2. Grace period: проверка за double-signing < 30 сек ──────────────────
  const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
  const { data: existingSig } = await supabase
    .from('signatures')
    .select('id')
    .eq('document_id', documentId)
    .gte('signed_at', thirtySecsAgo)
    .maybeSingle();
  if (existingSig) {
    throw new Error('Документът вече е подписан преди по-малко от 30 секунди. Опитайте отново.');
  }

  // ── 3. Resolve ключове + cert validation ──────────────────────────────────
  onProgress?.(15, 'Намиране на ключове...');
  const keys = await resolveSigningKeys();

  // ── 4. PRF ceremony(ies) → AES ключове → decrypt secret keys ─────────────
  onProgress?.(35, 'Биометрична верификация...');
  let ecdsaSecretKey: Uint8Array | null = null;
  let mlDsaSecretKey: Uint8Array | null = null;

  try {
    if (keys.singlePrf && keys.mlDsaData) {
      // Един биометричен tap → два ключа
      const { aesKey1, aesKey2 } = await deriveDualAesKeysFromPRF(
        keys.ecdsaData.prfSalt,
        keys.mlDsaData.prfSalt,
        rpId,
        keys.ecdsaData.credentialId,
        extractDualPrf,
      );
      const [ecdsa, mlDsa] = await Promise.all([
        decryptPrivateKey(keys.ecdsaData.encryptedSecretKey, aesKey1, keys.ecdsaData.wrappedKeyIv),
        decryptPrivateKey(keys.mlDsaData.encryptedSecretKey, aesKey2, keys.mlDsaData.wrappedKeyIv),
      ]);
      ecdsaSecretKey = ecdsa;
      mlDsaSecretKey = mlDsa;

    } else {
      // ECDSA ceremony (насочен към конкретния credential)
      const { aesKey: ecdsaAes } = await deriveAesKeyFromPRF(
        keys.ecdsaData.prfSalt, rpId, keys.ecdsaData.credentialId, extractPrf,
      );
      ecdsaSecretKey = await decryptPrivateKey(
        keys.ecdsaData.encryptedSecretKey, ecdsaAes, keys.ecdsaData.wrappedKeyIv,
      );

      // ML-DSA ceremony (отделен credential)
      if (keys.mlDsaData) {
        const { aesKey: mlDsaAes } = await deriveAesKeyFromPRF(
          keys.mlDsaData.prfSalt, rpId, keys.mlDsaData.credentialId, extractPrf,
        );
        mlDsaSecretKey = await decryptPrivateKey(
          keys.mlDsaData.encryptedSecretKey, mlDsaAes, keys.mlDsaData.wrappedKeyIv,
        );
      }
    }

    // ── 5. Download оригинален PDF от storage ─────────────────────────────
    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('documents')
      .download(docRow.storage_path as string);
    if (dlErr || !pdfBlob) {
      console.error('signDocument: download PDF failed:', dlErr?.message);
      throw new Error('Грешка при изтегляне на документа. Опитайте отново.');
    }

    const originalPdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    // ── 6. Подготовка на PDF с визуален маркер ────────────────────────────
    const signOptions: SignOptions = {
      markerX:   position.x,
      markerY:   position.y,
      pageIndex: position.page,
      fontBytes,
    };
    const prepared = await preparePdfForSigning(
      originalPdfBytes, signerName, signingDate, signOptions,
    );

    // ── 7. Byte ranges + SHA-256 hash ─────────────────────────────────────
    const byteRange = computeByteRanges(prepared);
    patchByteRangeInPlace(prepared, byteRange);
    const messageDigest = hashByteRanges(prepared.bytes, byteRange);

    // ── 8. ECDSA P-256 подпис + CMS с leaf cert + Root CA chain ──────────
    onProgress?.(55, 'Подписване ECDSA P-256...');
    const signedAttrs   = buildSignedAttrs(messageDigest);
    const ecdsaSigP1363 = await signWithEcdsaP256(ecdsaSecretKey, signedAttrs);
    const cmsDer        = buildCmsDetached(
      messageDigest,
      ecdsaSigP1363,
      keys.ecdsaData.certificateDer,
      ROOT_CA_CERT_DER,
    );

    // ── 9. ML-DSA-65 PQ подпис (пропуснат ако няма ключ) ─────────────────
    let pqData: PqSignatureData | null = null;
    let mlDsaKeyIdUsed: string | null  = keys.mlDsaKeyId;

    if (mlDsaSecretKey && keys.mlDsaData) {
      onProgress?.(70, 'Подписване ML-DSA-65...');
      const mlDsaSig = await signWithMlDsa(mlDsaSecretKey, messageDigest);
      pqData = {
        algorithm:       'ml-dsa-65',
        signedHash:      encodeBase64url(messageDigest),
        signatureB64url: encodeBase64url(mlDsaSig),
        publicKeyB64url: encodeBase64url(keys.mlDsaData.publicKey ?? new Uint8Array(0)),
        attestation: keys.mlDsaData.certificateDer
          ? { hasCert: true }
          : { hasCert: false },
        byteRange: [...byteRange],
      };
    } else {
      mlDsaKeyIdUsed = null;
    }

    // ── 10. Инжектиране на подписа ────────────────────────────────────────
    const finalPdf = injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);

    // ── 11. Upload в signed-documents bucket ──────────────────────────────
    onProgress?.(85, 'Качване на документа...');
    const signedPath = `${userId}/${documentId}_signed.pdf`;
    const { error: ulErr } = await supabase.storage
      .from('signed-documents')
      .upload(signedPath, finalPdf, {
        contentType: 'application/pdf',
        upsert: false,   // консистентно с UNIQUE constraint на signatures.signed_storage_path
      });
    if (ulErr) {
      console.error('signDocument: upload signed PDF failed:', ulErr.message);
      throw new Error('Грешка при качване на подписания документ. Опитайте отново.');
    }

    // ── 12. DB updates ────────────────────────────────────────────────────
    const now = signingDate.toISOString();

    const { error: docUpdateErr } = await supabase
      .from('documents')
      .update({
        status:              'signed',
        signed_at:            now,
        signed_storage_path:  signedPath,
      })
      .eq('id', documentId);
    if (docUpdateErr) {
      console.error('signDocument: update document status failed:', docUpdateErr.message);
      throw new Error('Грешка при обновяване на документа. Опитайте отново.');
    }

    const { data: sigRow, error: sigErr } = await supabase
      .from('signatures')
      .insert({
        document_id:          documentId,
        user_id:              userId,
        signing_key_id:       keys.ecdsaKeyId,      // deprecated but NOT NULL
        ecdsa_key_id:         keys.ecdsaKeyId,
        ml_dsa_key_id:        mlDsaKeyIdUsed,
        algorithm:            'ecdsa-p256',
        signature_bytes:      `\\x${Array.from(cmsDer).map(b => b.toString(16).padStart(2, '0')).join('')}`,
        signed_at:            now,
        visual_marker_page:   position.page,
        visual_marker_x:      position.x,
        visual_marker_y:      position.y,
        signed_storage_path:  signedPath,
      })
      .select('id')
      .single();
    if (sigErr || !sigRow) {
      console.error('signDocument: insert signature failed:', sigErr?.message);
      throw new Error('Грешка при запис на подписа. Опитайте отново.');
    }

    await logAuditEvent(userId, 'document_signed', documentId);

    return {
      signatureId:       sigRow.id as string,
      signedStoragePath: signedPath,
      pqSkipped:         mlDsaKeyIdUsed === null,
    };

  } finally {
    ecdsaSecretKey?.fill(0);
    mlDsaSecretKey?.fill(0);
  }
}

/** Генерира signed URL за изтегляне на подписания PDF (валиден 60 минути). */
export async function getSignedDownloadUrl(signedStoragePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('signed-documents')
    .createSignedUrl(signedStoragePath, 3600);
  if (error || !data) {
    console.error('getSignedDownloadUrl failed:', error?.message);
    throw new Error('Грешка при генериране на download URL. Опитайте отново.');
  }
  return data.signedUrl;
}
