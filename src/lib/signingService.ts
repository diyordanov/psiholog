/**
 * signingService.ts — Ден 3 orchestration (single-signer) + Ден 4 (multi-signer)
 *
 * Ден 4 (Фаза 8) генерализира signing flow-а за N подписа (DocuSign-style):
 *
 *   signAsOwner()      — owner подписва ПЪРВИ (preparePdfForSigning, стандартния
 *                        single-signer path), опционално създава покани за
 *                        recipients. Backward compat: signDocument() е тънък
 *                        wrapper около signAsOwner(..., recipients: [], ...).
 *
 *   signAsRecipient()  — recipient подписва INCREMENTALLY върху последната
 *                        качена версия (prepareIncrementalSignature от Ден 2).
 *                        Optimistic concurrency: signing_requests.version се
 *                        инкрементира атомарно (UPDATE ... WHERE version = X);
 *                        0 rows affected → race с друг recipient → auto-retry
 *                        (до MAX_RECIPIENT_SIGN_RETRIES пъти, всеки retry прави
 *                        НОВ PRF ceremony, защото message digest-ът се е сменил).
 *
 * И двете функции живеят в signing_requests/signing_request_recipients
 * (migration 0010/0011) — виж PROGRESS.md за пълния data model. Storage path
 * конвенция за multi-signer файлове: `signed-documents/<signing_request_id>/
 * v<version>.pdf` (папка = заявката, не user_id) — изисква migration 0012
 * (storage RLS през is_signing_request_owner()/is_signing_request_recipient()).
 *
 * Email изпращане (invitation/completion) е Ден 7 — извън scope тук.
 * UI wiring е Ден 5-6 — тези функции не се викат от никой компонент още.
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
  prepareIncrementalSignature, injectIncrementalSignature,
  type PqSignatureData, type SignOptions,
} from './pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from './pdf/cmsBuilder';
import { notifySigningParticipants } from './notificationService';
import type { NewRecipientInput, SigningRequestStatus } from './types';

// ─── Типове ──────────────────────────────────────────────────────────────────

export interface SigningPosition {
  page: number;  // 0-indexed
  x: number;     // PDF points
  y: number;     // PDF points
  /** Размер на маркера в PDF points (auto-layout при multi-signer, виж markerLayout.ts). Default 200×50 (single-signer, backward compat). */
  width?: number;
  height?: number;
}

export interface SignDocumentResult {
  signatureId: string;
  signedStoragePath: string;
  pqSkipped: boolean;
}

/** Резултат от signAsOwner() — по-богат от SignDocumentResult (signDocument() го изтънява за backward compat). */
export interface SigningRequestResult {
  signingRequestId: string;
  signatureId: string;
  signedStoragePath: string;
  version: number;
  status: SigningRequestStatus; // 'completed' (0 recipients) | 'awaiting_recipients' (1+)
  pqSkipped: boolean;
}

/** Резултат от signAsRecipient() — след успешен (евентуално retry-нат) опит. */
export interface RecipientSignResult {
  signingRequestId: string;
  signatureId: string;
  signedStoragePath: string;
  version: number;
  allSigned: boolean;
  status: SigningRequestStatus; // 'completed' (allSigned) | 'awaiting_recipients'
  pqSkipped: boolean; // true ако recipient-ът няма ML-DSA-65 ключ (само ECDSA подпис)
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

/**
 * Хвърля се вътрешно при optimistic-concurrency конфликт (друг recipient е
 * подписал междувременно — version mismatch при UPDATE, или storage upload
 * conflict за същия version номер). signAsRecipient() я хваща и retry-ва;
 * никога не изтича извън функцията при нормална употреба.
 */
export class ConcurrentSignError extends Error {}

const MAX_RECIPIENT_SIGN_RETRIES = 3;

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

/** CMS DER → '\xhex' за bytea INSERT в signatures.signature_bytes. */
function cmsToByteaHex(cmsDer: Uint8Array): string {
  return `\\x${Array.from(cmsDer).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Storage path конвенция за multi-signer версии: `<signing_request_id>/v<version>.pdf`. */
function versionedPath(signingRequestId: string, version: number): string {
  return `${signingRequestId}/v${version}.pdf`;
}

// ─── Публично API — споделено ──────────────────────────────────────────────────

/**
 * Избира ECDSA P-256 и ML-DSA-65 ключовете, зарежда пълните им данни и
 * валидира ECDSA сертификат. Детектира единичен vs двоен PRF ceremony.
 *
 * Хвърля ако:
 *   - Няма ECDSA P-256 ключ
 *   - ECDSA ключът няма сертификат
 * Връща mlDsaData: null ако няма ML-DSA-65 ключ.
 *
 * Ползва се и от signAsOwner(), и от signAsRecipient() — RLS на signing_keys
 * автоматично скопира до auth.uid() на извикващия (текущо логнатия recipient
 * или owner), не изисква явен userId параметър.
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
 * Декриптира ECDSA (+ опционално ML-DSA) secret keys чрез PRF ceremony(ies).
 * Споделена между signAsOwner() и attemptRecipientSign() — единствената
 * разлика между двата flow-а е КАК се подписва PDF-ът (стъпка след тази), не
 * как се декриптират ключовете.
 */
async function decryptSigningSecretKeys(
  keys: ResolvedKeys,
  rpId: string,
  extractPrf?: PrfExtractor,
  extractDualPrf?: DualPrfExtractor,
): Promise<{ ecdsaSecretKey: Uint8Array; mlDsaSecretKey: Uint8Array | null }> {
  if (keys.singlePrf && keys.mlDsaData) {
    // Един биометричен tap → два ключа
    const { aesKey1, aesKey2 } = await deriveDualAesKeysFromPRF(
      keys.ecdsaData.prfSalt, keys.mlDsaData.prfSalt, rpId, keys.ecdsaData.credentialId, extractDualPrf,
    );
    const [ecdsaSecretKey, mlDsaSecretKey] = await Promise.all([
      decryptPrivateKey(keys.ecdsaData.encryptedSecretKey, aesKey1, keys.ecdsaData.wrappedKeyIv),
      decryptPrivateKey(keys.mlDsaData.encryptedSecretKey, aesKey2, keys.mlDsaData.wrappedKeyIv),
    ]);
    return { ecdsaSecretKey, mlDsaSecretKey };
  }

  // ECDSA ceremony (насочен към конкретния credential)
  const { aesKey: ecdsaAes } = await deriveAesKeyFromPRF(
    keys.ecdsaData.prfSalt, rpId, keys.ecdsaData.credentialId, extractPrf,
  );
  const ecdsaSecretKey = await decryptPrivateKey(
    keys.ecdsaData.encryptedSecretKey, ecdsaAes, keys.ecdsaData.wrappedKeyIv,
  );

  let mlDsaSecretKey: Uint8Array | null = null;
  if (keys.mlDsaData) {
    const { aesKey: mlDsaAes } = await deriveAesKeyFromPRF(
      keys.mlDsaData.prfSalt, rpId, keys.mlDsaData.credentialId, extractPrf,
    );
    mlDsaSecretKey = await decryptPrivateKey(
      keys.mlDsaData.encryptedSecretKey, mlDsaAes, keys.mlDsaData.wrappedKeyIv,
    );
  }
  return { ecdsaSecretKey, mlDsaSecretKey };
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

// ─── Ден 4: signAsOwner() ───────────────────────────────────────────────────

/**
 * Owner flow: създава signing_request (+ recipients ако има) и прави ПЪРВИЯ
 * подпис (стандартен single-signer path — preparePdfForSigning/injectSignatureAndPQ,
 * не incremental primitive, защото owner-ът винаги е signer #1 във файла).
 *
 * @param documentId  UUID на документа
 * @param userId      UUID на owner-а (текущия потребител)
 * @param signerName  Показва се в /Name полето + визуалния маркер
 * @param position    Позиция на owner-ския маркер
 * @param recipients  0 или повече покани (0 = backward-compat single-signer, виж signDocument())
 * @param rpId        WebAuthn RP ID
 */
export async function signAsOwner(
  documentId: string,
  userId: string,
  signerName: string,
  position: SigningPosition,
  recipients: NewRecipientInput[],
  rpId: string,
  fontBytes?: Uint8Array,
  extractPrf?: PrfExtractor,
  extractDualPrf?: DualPrfExtractor,
  onProgress?: (pct: number, label: string) => void,
): Promise<SigningRequestResult> {
  const signingDate = new Date();

  // ── 1. Fetch документа + validate ownership + status ──────────────────────
  onProgress?.(5, 'Проверка на документа...');
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .select('storage_path, original_filename, status')
    .eq('id', documentId)
    .eq('user_id', userId)
    .single();
  if (docErr || !docRow) {
    console.error('signAsOwner: fetch document failed:', docErr?.message);
    throw new Error('Документът не е намерен или достъпът е отказан.');
  }
  if (docRow.status === 'signed') throw new Error('Документът вече е подписан.');

  // ── 2. Не позволяваме втора активна заявка за същия документ ─────────────
  const { data: activeRequest } = await supabase
    .from('signing_requests')
    .select('id')
    .eq('document_id', documentId)
    .is('deleted_at', null)
    .in('status', ['draft', 'owner_signing', 'awaiting_recipients'])
    .maybeSingle();
  if (activeRequest) {
    throw new Error('Вече има активна заявка за подписване на този документ.');
  }

  // ── 3. Grace period: проверка за double-signing < 30 сек ──────────────────
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

  // ── 4. Създаваме signing_request (status='draft') ─────────────────────────
  const { data: srRow, error: srErr } = await supabase
    .from('signing_requests')
    .insert({ document_id: documentId, owner_user_id: userId, status: 'draft' })
    .select('id')
    .single();
  if (srErr || !srRow) {
    console.error('signAsOwner: insert signing_request failed:', srErr?.message);
    throw new Error('Грешка при създаване на заявката за подписване. Опитайте отново.');
  }
  const signingRequestId = srRow.id as string;

  // ── 5. Insert recipients (ако има) ─────────────────────────────────────────
  if (recipients.length > 0) {
    const rows = recipients.map(r => ({
      signing_request_id: signingRequestId,
      invited_email:       r.email.trim().toLowerCase(),
      marker_page:         r.position.page,
      marker_x:            r.position.x,
      marker_y:            r.position.y,
      marker_width:        r.position.width,
      marker_height:       r.position.height,
    }));
    const { error: recErr } = await supabase.from('signing_request_recipients').insert(rows);
    if (recErr) {
      console.error('signAsOwner: insert recipients failed:', recErr.message);
      throw new Error('Грешка при добавяне на поканените лица. Опитайте отново.');
    }
  }

  // ── 6. Resolve ключове + PRF ceremony(ies) ─────────────────────────────────
  onProgress?.(15, 'Намиране на ключове...');
  const keys = await resolveSigningKeys();

  onProgress?.(35, 'Биометрична верификация...');
  let ecdsaSecretKey: Uint8Array | null = null;
  let mlDsaSecretKey: Uint8Array | null = null;

  try {
    ({ ecdsaSecretKey, mlDsaSecretKey } =
      await decryptSigningSecretKeys(keys, rpId, extractPrf, extractDualPrf));

    // ── 7. Download оригинален PDF от storage ─────────────────────────────
    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('documents')
      .download(docRow.storage_path as string);
    if (dlErr || !pdfBlob) {
      console.error('signAsOwner: download PDF failed:', dlErr?.message);
      throw new Error('Грешка при изтегляне на документа. Опитайте отново.');
    }
    const originalPdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    // ── 8. Подготовка на PDF с визуален маркер (owner е ВИНАГИ signer #1) ──
    const signOptions: SignOptions = {
      markerX: position.x, markerY: position.y, pageIndex: position.page, fontBytes,
      markerWidth: position.width, markerHeight: position.height,
    };
    const prepared = await preparePdfForSigning(originalPdfBytes, signerName, signingDate, signOptions);

    // ── 9. Byte ranges + SHA-256 hash ─────────────────────────────────────
    const byteRange = computeByteRanges(prepared);
    patchByteRangeInPlace(prepared, byteRange);
    const messageDigest = hashByteRanges(prepared.bytes, byteRange);

    // ── 10. ECDSA P-256 подпис + CMS ───────────────────────────────────────
    onProgress?.(55, 'Подписване ECDSA P-256...');
    const signedAttrs   = buildSignedAttrs(messageDigest);
    const ecdsaSigP1363 = await signWithEcdsaP256(ecdsaSecretKey, signedAttrs);
    const cmsDer = buildCmsDetached(messageDigest, ecdsaSigP1363, keys.ecdsaData.certificateDer, ROOT_CA_CERT_DER);

    // ── 11. ML-DSA-65 PQ подпис (пропуснат ако няма ключ) ─────────────────
    let pqData: PqSignatureData | null = null;
    let mlDsaKeyIdUsed: string | null = keys.mlDsaKeyId;

    if (mlDsaSecretKey && keys.mlDsaData) {
      onProgress?.(70, 'Подписване ML-DSA-65...');
      const mlDsaSig = await signWithMlDsa(mlDsaSecretKey, messageDigest);
      pqData = {
        algorithm: 'ml-dsa-65',
        signedHash: encodeBase64url(messageDigest),
        signatureB64url: encodeBase64url(mlDsaSig),
        publicKeyB64url: encodeBase64url(keys.mlDsaData.publicKey ?? new Uint8Array(0)),
        attestation: keys.mlDsaData.certificateDer ? { hasCert: true } : { hasCert: false },
        byteRange: [...byteRange],
        signerIndex: 0, // owner е ВИНАГИ signer #0 (файлов ред)
      };
    } else {
      mlDsaKeyIdUsed = null;
    }

    // ── 12. Инжектиране + upload на v1 ─────────────────────────────────────
    const finalPdf = injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);

    onProgress?.(85, 'Качване на документа...');
    const signedPath = versionedPath(signingRequestId, 1);
    const { error: ulErr } = await supabase.storage
      .from('signed-documents')
      .upload(signedPath, finalPdf, { contentType: 'application/pdf', upsert: false });
    if (ulErr) {
      console.error('signAsOwner: upload signed PDF failed:', ulErr.message);
      throw new Error('Грешка при качване на подписания документ. Опитайте отново.');
    }

    // ── 13. DB updates ────────────────────────────────────────────────────
    const now = signingDate.toISOString();
    const isComplete = recipients.length === 0; // няма поканени → owner е последният подписващ

    const { error: srUpdateErr } = await supabase
      .from('signing_requests')
      .update({
        status:                      isComplete ? 'completed' : 'awaiting_recipients',
        current_signed_storage_path: signedPath,
        version:                     1,
        owner_signed_at:             now,
        completed_at:                isComplete ? now : null,
      })
      .eq('id', signingRequestId);
    if (srUpdateErr) {
      console.error('signAsOwner: update signing_request failed:', srUpdateErr.message);
      throw new Error('Грешка при обновяване на заявката. Опитайте отново.');
    }

    if (isComplete) {
      const { error: docUpdateErr } = await supabase
        .from('documents')
        .update({ status: 'signed', signed_at: now, signed_storage_path: signedPath })
        .eq('id', documentId);
      if (docUpdateErr) {
        console.error('signAsOwner: update document status failed:', docUpdateErr.message);
        throw new Error('Грешка при обновяване на документа. Опитайте отново.');
      }
    }

    const { data: sigRow, error: sigErr } = await supabase
      .from('signatures')
      .insert({
        document_id:          documentId,
        user_id:              userId,
        signing_key_id:       keys.ecdsaKeyId, // deprecated but NOT NULL
        ecdsa_key_id:         keys.ecdsaKeyId,
        ml_dsa_key_id:        mlDsaKeyIdUsed,
        algorithm:            'ecdsa-p256',
        signature_bytes:      cmsToByteaHex(cmsDer),
        signed_at:            now,
        visual_marker_page:   position.page,
        visual_marker_x:      position.x,
        visual_marker_y:      position.y,
        signed_storage_path:  signedPath,
        signing_request_id:   signingRequestId,
      })
      .select('id')
      .single();
    if (sigErr || !sigRow) {
      console.error('signAsOwner: insert signature failed:', sigErr?.message);
      throw new Error('Грешка при запис на подписа. Опитайте отново.');
    }

    await logAuditEvent(userId, 'document_signed', documentId);

    // Известяваме recipients-ите best-effort (Ден 6 hotfix v4) — само ако
    // има на кого (recipients.length > 0); single-signer flow няма други участници.
    if (!isComplete) {
      await notifySigningParticipants(
        signingRequestId, 'owner_signed',
        `${signerName} подписа документа и очаква вашия подпис.`, userId,
      );
    }

    return {
      signingRequestId,
      signatureId:       sigRow.id as string,
      signedStoragePath: signedPath,
      version:           1,
      status:            isComplete ? 'completed' : 'awaiting_recipients',
      pqSkipped:         mlDsaKeyIdUsed === null,
    };

  } finally {
    ecdsaSecretKey?.fill(0);
    mlDsaSecretKey?.fill(0);
  }
}

/**
 * Backward compat: single-signer flow (без покани) — тънък wrapper около
 * signAsOwner(..., recipients: [], ...). Външният signature/return type е
 * НЕПРОМЕНЕН спрямо преди Ден 4 (SignDocumentModal.tsx продължава да работи
 * без промяна).
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
  const result = await signAsOwner(
    documentId, userId, signerName, position, [], rpId,
    fontBytes, extractPrf, extractDualPrf, onProgress,
  );
  return {
    signatureId:       result.signatureId,
    signedStoragePath: result.signedStoragePath,
    pqSkipped:         result.pqSkipped,
  };
}

// ─── Ден 4: signAsRecipient() ────────────────────────────────────────────────

/** Ред от signing_request_recipients, нужен за подписване (не пълния SigningRequestRecipientRow). */
interface RecipientRowForSigning {
  id: string;
  signing_request_id: string;
  user_id: string | null;
  status: string;
  marker_page: number;
  marker_x: number;
  marker_y: number;
  marker_width: number;
  marker_height: number;
}

/** Ред от signing_requests, нужен за подписване (не пълния SigningRequestRow). */
interface SigningRequestRowForSigning {
  id: string;
  document_id: string;
  status: SigningRequestStatus;
  current_signed_storage_path: string | null;
  version: number;
}

async function fetchRecipientForSigning(recipientId: string): Promise<RecipientRowForSigning> {
  const { data, error } = await supabase
    .from('signing_request_recipients')
    .select('id, signing_request_id, user_id, status, marker_page, marker_x, marker_y, marker_width, marker_height')
    .eq('id', recipientId)
    .single();
  if (error || !data) {
    console.error('signAsRecipient: fetch recipient failed:', error?.message);
    throw new Error('Поканата не е намерена или достъпът е отказан.');
  }
  return data as RecipientRowForSigning;
}

async function fetchSigningRequestForSigning(signingRequestId: string): Promise<SigningRequestRowForSigning> {
  const { data, error } = await supabase
    .from('signing_requests')
    .select('id, document_id, status, current_signed_storage_path, version')
    .eq('id', signingRequestId)
    .single();
  if (error || !data) {
    console.error('signAsRecipient: fetch signing_request failed:', error?.message);
    throw new Error('Заявката за подписване не е намерена.');
  }
  return data as SigningRequestRowForSigning;
}

/**
 * ЕДИН опит за recipient подпис — извиква се от signAsRecipient() в retry
 * loop. Хвърля ConcurrentSignError при optimistic-concurrency конфликт
 * (друг recipient е подписал междувременно); всички други грешки (validation,
 * PRF cancel, липсващи ключове) излизат директно, без retry.
 *
 * @param fontBytes  TTF байтове на Unicode шрифт (NotoSans) — вграждат се
 *                   като subset CID font в incremental update-а, за пълна
 *                   кирилица в recipient маркера (Ден 6 hotfix v2; виж
 *                   cidFont.ts). За разлика от Ден 2 бележката (по-долу вече
 *                   невярна), recipient маркерът вече РИСУВА текст.
 */
async function attemptRecipientSign(
  recipientId: string,
  userId: string,
  signerName: string,
  rpId: string,
  fontBytes: Uint8Array,
  extractPrf: PrfExtractor | undefined,
  extractDualPrf: DualPrfExtractor | undefined,
  onProgress: ((pct: number, label: string) => void) | undefined,
): Promise<RecipientSignResult> {
  const signingDate = new Date();

  // ── 1. Fetch recipient + validate security/status ──────────────────────────
  onProgress?.(5, 'Проверка на поканата...');
  const recipient = await fetchRecipientForSigning(recipientId);
  if (recipient.user_id !== userId) {
    throw new Error('Нямате достъп до тази покана.');
  }
  if (recipient.status === 'signed') {
    throw new Error('Вече сте подписали този документ.');
  }

  // ── 2. Fetch parent signing_request + validate status ──────────────────────
  const signingRequest = await fetchSigningRequestForSigning(recipient.signing_request_id);
  if (signingRequest.status === 'cancelled') {
    throw new Error('Заявката за подписване е отменена.');
  }
  if (signingRequest.status === 'completed') {
    throw new Error('Документът вече е напълно подписан.');
  }
  if (signingRequest.status !== 'awaiting_recipients' || !signingRequest.current_signed_storage_path) {
    throw new Error('Собственикът все още не е подписал документа.');
  }

  // ── 3. Resolve ключове + PRF ceremony(ies) ──────────────────────────────────
  onProgress?.(15, 'Намиране на ключове...');
  const keys = await resolveSigningKeys();

  onProgress?.(35, 'Биометрична верификация...');
  let ecdsaSecretKey: Uint8Array | null = null;
  let mlDsaSecretKey: Uint8Array | null = null;

  try {
    ({ ecdsaSecretKey, mlDsaSecretKey } =
      await decryptSigningSecretKeys(keys, rpId, extractPrf, extractDualPrf));

    // ── 4. Download текущата подписана версия ──────────────────────────────
    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('signed-documents')
      .download(signingRequest.current_signed_storage_path);
    if (dlErr || !pdfBlob) {
      console.error('signAsRecipient: download signed PDF failed:', dlErr?.message);
      throw new Error('Грешка при изтегляне на текущата версия. Опитайте отново.');
    }
    const currentPdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    // ── 5. Incremental подпис (append-only, върху последната версия) ───────
    const newVersion = signingRequest.version + 1;
    // Маркерният текст трябва да отразява дали РЕАЛНО ще опитаме ML-DSA (по
    // keys.mlDsaData, известно вече от resolveSigningKeys() по-горе) — виж
    // bugfix бележката в pdfSigner.ts/IncrementalSignOptions.algoLabel.
    const algoLabel = keys.mlDsaData ? 'ECDSA P-256 + ML-DSA-65 (хибриден)' : 'ECDSA P-256';
    const prepared = await prepareIncrementalSignature(currentPdfBytes, signerName, signingDate, {
      markerX: recipient.marker_x, markerY: recipient.marker_y,
      pageIndex: recipient.marker_page, fieldName: `Signature${newVersion}`,
      fontBytes, markerWidth: recipient.marker_width, markerHeight: recipient.marker_height,
      algoLabel,
    });
    const byteRange = computeByteRanges(prepared);
    patchByteRangeInPlace(prepared, byteRange);
    const messageDigest = hashByteRanges(prepared.bytes, byteRange);

    onProgress?.(55, 'Подписване ECDSA P-256...');
    const signedAttrs   = buildSignedAttrs(messageDigest);
    const ecdsaSigP1363 = await signWithEcdsaP256(ecdsaSecretKey, signedAttrs);
    const cmsDer = buildCmsDetached(messageDigest, ecdsaSigP1363, keys.ecdsaData.certificateDer, ROOT_CA_CERT_DER);

    // ── 5б. ML-DSA-65 PQ подпис (ако recipient-ът има ключ — задание изисква
    // хибриден подпис навсякъде, не само за owner-а; виж PROJECT_BRIEF.md
    // "Ключово изискване"). signerIndex = файловия ред на този подпис
    // (newVersion-1, 0-based, owner е винаги 0) — extractAllPqStreams() в
    // pdfVerifier.ts вече е построена да чете N такива streams по signerIndex.
    let pqData: PqSignatureData | null = null;
    let mlDsaKeyIdUsed: string | null = null;
    if (mlDsaSecretKey && keys.mlDsaData) {
      onProgress?.(70, 'Подписване ML-DSA-65...');
      const mlDsaSig = await signWithMlDsa(mlDsaSecretKey, messageDigest);
      pqData = {
        algorithm: 'ml-dsa-65',
        signedHash: encodeBase64url(messageDigest),
        signatureB64url: encodeBase64url(mlDsaSig),
        publicKeyB64url: encodeBase64url(keys.mlDsaData.publicKey ?? new Uint8Array(0)),
        attestation: keys.mlDsaData.certificateDer ? { hasCert: true } : { hasCert: false },
        byteRange: [...byteRange],
        signerIndex: newVersion - 1,
      };
      mlDsaKeyIdUsed = keys.mlDsaKeyId;
    }

    const finalPdf = injectIncrementalSignature(prepared, cmsDer, pqData);

    // ── 6. Upload новата версия ─────────────────────────────────────────────
    onProgress?.(85, 'Качване на документа...');
    const newPath = versionedPath(signingRequest.id, newVersion);
    const { error: ulErr } = await supabase.storage
      .from('signed-documents')
      .upload(newPath, finalPdf, { contentType: 'application/pdf', upsert: false });
    if (ulErr) {
      // Duplicate path (upsert:false) — най-вероятно друг recipient е качил
      // СЪЩИЯ version номер междувременно (race). Retry-able.
      throw new ConcurrentSignError(`Race при качване на нова версия: ${ulErr.message}`);
    }

    // ── 7. Optimistic concurrency UPDATE ────────────────────────────────────
    const { data: updatedRows, error: srUpdateErr } = await supabase
      .from('signing_requests')
      .update({ current_signed_storage_path: newPath, version: newVersion })
      .eq('id', signingRequest.id)
      .eq('version', signingRequest.version)
      .select('id');
    if (srUpdateErr) {
      console.error('signAsRecipient: update signing_request failed:', srUpdateErr.message);
      throw new Error('Грешка при обновяване на заявката. Опитайте отново.');
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Друг recipient е подписал междувременно (version вече е различен) —
      // retry-able, viz. signAsRecipient() retry loop-а.
      throw new ConcurrentSignError('Документът беше подписан от друг участник междувременно.');
    }

    // ── 8. Signature insert + recipient update ──────────────────────────────
    const now = signingDate.toISOString();
    const { data: sigRow, error: sigErr } = await supabase
      .from('signatures')
      .insert({
        document_id:          signingRequest.document_id,
        user_id:              userId,
        signing_key_id:       keys.ecdsaKeyId,
        ecdsa_key_id:         keys.ecdsaKeyId,
        ml_dsa_key_id:        mlDsaKeyIdUsed,
        algorithm:            'ecdsa-p256',
        signature_bytes:      cmsToByteaHex(cmsDer),
        signed_at:            now,
        visual_marker_page:   recipient.marker_page,
        visual_marker_x:      recipient.marker_x,
        visual_marker_y:      recipient.marker_y,
        signed_storage_path:  newPath,
        signing_request_id:   signingRequest.id,
      })
      .select('id')
      .single();
    if (sigErr || !sigRow) {
      console.error('signAsRecipient: insert signature failed:', sigErr?.message);
      throw new Error('Грешка при запис на подписа. Опитайте отново.');
    }
    const signatureId = sigRow.id as string;

    const { error: recUpdateErr } = await supabase
      .from('signing_request_recipients')
      .update({ status: 'signed', signed_at: now, signature_id: signatureId })
      .eq('id', recipientId);
    if (recUpdateErr) {
      console.error('signAsRecipient: update recipient failed:', recUpdateErr.message);
      throw new Error('Грешка при обновяване на статуса. Опитайте отново.');
    }

    // ── 9. Проверка дали ВСИЧКИ recipients са подписали ─────────────────────
    const { data: allRecipients, error: allRecErr } = await supabase
      .from('signing_request_recipients')
      .select('status')
      .eq('signing_request_id', signingRequest.id);
    if (allRecErr) {
      console.error('signAsRecipient: fetch all recipients failed:', allRecErr.message);
      throw new Error('Грешка при проверка на статуса. Опитайте отново.');
    }
    const allSigned = (allRecipients ?? []).every(r => (r as { status: string }).status === 'signed');

    if (allSigned) {
      // .select('id') е нарочно тук (не само за грешки): RLS-блокирано UPDATE
      // НЕ връща error от PostgREST — просто засяга 0 реда тихо. Без .select()
      // за проверка на rows-affected, бихме "успели" мълчаливо без документът
      // действително да мине в status='signed' (виж migration 0013 бележката —
      // точно този silent-fail беше открит при реалния E2E тест).
      const { data: srCompleteRows, error: completeErr } = await supabase
        .from('signing_requests')
        .update({ status: 'completed', completed_at: now })
        .eq('id', signingRequest.id)
        .select('id');
      if (completeErr || !srCompleteRows || srCompleteRows.length === 0) {
        console.error('signAsRecipient: complete signing_request failed:', completeErr?.message ?? 'RLS blocked (0 rows)');
        throw new Error('Грешка при завършване на заявката. Опитайте отново.');
      }
      const { data: docCompleteRows, error: docCompleteErr } = await supabase
        .from('documents')
        .update({ status: 'signed', signed_at: now, signed_storage_path: newPath })
        .eq('id', signingRequest.document_id)
        .select('id');
      if (docCompleteErr || !docCompleteRows || docCompleteRows.length === 0) {
        console.error('signAsRecipient: complete document failed:', docCompleteErr?.message ?? 'RLS blocked (0 rows)');
        throw new Error('Грешка при обновяване на документа. Опитайте отново.');
      }
    }

    await logAuditEvent(userId, 'document_signed', signingRequest.document_id);

    // Известяваме останалите участници best-effort (Ден 6 hotfix v4).
    await notifySigningParticipants(
      signingRequest.id, 'recipient_signed',
      `${signerName} подписа документа.`, userId,
    );
    if (allSigned) {
      await notifySigningParticipants(
        signingRequest.id, 'request_completed',
        'Документът е подписан от всички участници.', userId,
      );
    }

    return {
      signingRequestId: signingRequest.id,
      signatureId,
      signedStoragePath: newPath,
      version: newVersion,
      allSigned,
      status: allSigned ? 'completed' : 'awaiting_recipients',
      pqSkipped: mlDsaKeyIdUsed === null,
    };

  } finally {
    ecdsaSecretKey?.fill(0);
    mlDsaSecretKey?.fill(0);
  }
}

/**
 * Recipient flow: подписва INCREMENTALLY върху последната налична версия.
 *
 * Retry logic (optimistic concurrency): ако друг recipient подпише
 * междувременно (между нашето fetch на `version` и нашия UPDATE/upload), се
 * получава едно от две неща:
 *   1. `signing_requests` UPDATE засяга 0 реда (WHERE version = X вече не пасва)
 *   2. Storage upload на `v{newVersion}.pdf` се проваля (друг recipient вече
 *      го е качил — upsert:false)
 * И двата случая хвърлят ConcurrentSignError вътрешно (attemptRecipientSign) —
 * тук ги хващаме и повтаряме целия опит от начало (refetch на signing_request,
 * повторно download на най-новата версия, НОВ PRF ceremony — message digest-ът
 * се е сменил, старият подпис вече не е валиден за новия byte range).
 *
 * Max MAX_RECIPIENT_SIGN_RETRIES (3) опита; при изчерпване хвърля ясно
 * съобщение с инструкция да презаредят страницата.
 */
export async function signAsRecipient(
  recipientId: string,
  userId: string,
  signerName: string,
  rpId: string,
  fontBytes: Uint8Array,
  extractPrf?: PrfExtractor,
  extractDualPrf?: DualPrfExtractor,
  onProgress?: (pct: number, label: string) => void,
): Promise<RecipientSignResult> {
  for (let attempt = 1; attempt <= MAX_RECIPIENT_SIGN_RETRIES; attempt++) {
    try {
      return await attemptRecipientSign(
        recipientId, userId, signerName, rpId, fontBytes, extractPrf, extractDualPrf, onProgress,
      );
    } catch (e) {
      if (!(e instanceof ConcurrentSignError)) throw e;
      console.error(`signAsRecipient: concurrency conflict on attempt ${attempt}:`, e.message);
      if (attempt === MAX_RECIPIENT_SIGN_RETRIES) {
        throw new Error(
          `Документът беше подписан от друг участник междувременно. ` +
          `Опитахме ${MAX_RECIPIENT_SIGN_RETRIES} пъти без успех — презаредете страницата и опитайте отново.`,
        );
      }
      onProgress?.(10, `Друг участник подписа междувременно — повторен опит (${attempt + 1}/${MAX_RECIPIENT_SIGN_RETRIES})...`);
    }
  }
  /* istanbul ignore next -- unreachable, за TypeScript exhaustiveness */
  throw new Error('Неочаквана грешка при подписване.');
}
