/**
 * signingService.test.ts
 * Unit тестове за signing orchestration.
 *
 * Стратегия: mock-ваме всички external dependencies (supabase, crypto функции,
 * pdf функции). Тестваме САМО orchestration логиката:
 *   - PRF strategy detection (single vs dual ceremony)
 *   - Error handling (no ECDSA key, no cert, double-signing, signed doc)
 *   - pqSkipped=true ако няма ML-DSA-65 ключ
 *   - Правилни DB calls (документ update + signature insert)
 *
 * Реалната криптография е тествана в crypto.test.ts и pdfSigning.test.ts.
 *
 * Принцип на тестовете за ранни грешки (стъпки 1-2):
 *   Ако стъпка 1 (status=signed) или стъпка 2 (grace period) трябва да хвърли,
 *   не mock-ваме key lookup (стъпка 3+) — ако mock-овете за ключове са нужни
 *   за ранен throw, значи редът е грешен.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
}));

vi.mock('../lib/auditLog', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/signingKeyStore', () => ({
  fetchBestKeyId:       vi.fn(),
  fetchKeyDecryptData:  vi.fn(),
}));

vi.mock('../lib/crypto/keyProtection', () => ({
  deriveAesKeyFromPRF:      vi.fn(),
  deriveDualAesKeysFromPRF: vi.fn(),
  decryptPrivateKey:        vi.fn(),
  browserPrfExtractor:      vi.fn(),
  browserDualPrfExtractor:  vi.fn(),
}));

vi.mock('../lib/crypto/signing', () => ({
  signWithEcdsaP256: vi.fn().mockResolvedValue(new Uint8Array(64).fill(0x01)),
  signWithMlDsa:     vi.fn().mockResolvedValue(new Uint8Array(3309).fill(0x02)),
}));

vi.mock('../lib/pdf/cmsBuilder', () => ({
  buildSignedAttrs:  vi.fn().mockReturnValue(new Uint8Array(100).fill(0x31)),
  buildCmsDetached:  vi.fn().mockReturnValue(new Uint8Array(500).fill(0x30)),
}));

vi.mock('../lib/pdf/pdfSigner', () => ({
  preparePdfForSigning: vi.fn().mockResolvedValue({
    bytes: new Uint8Array(1000).fill(0),
    contentsOffset: 100,
    byteRangeNumOffset: 200,
  }),
  computeByteRanges:     vi.fn().mockReturnValue([0, 100, 200, 800] as [number, number, number, number]),
  patchByteRangeInPlace: vi.fn(),
  hashByteRanges:        vi.fn().mockReturnValue(new Uint8Array(32).fill(0xab)),
  injectSignatureAndPQ:  vi.fn().mockReturnValue(new Uint8Array(1500).fill(0)),
  encodeBase64url:       vi.fn().mockReturnValue('dGVzdA'),
}));

// ─── Imports след mock ─────────────────────────────────────────────────────────

import { resolveSigningKeys, signDocument } from '../lib/signingService';
import { supabase } from '../lib/supabase';
import { fetchBestKeyId, fetchKeyDecryptData } from '../lib/signingKeyStore';
import {
  deriveAesKeyFromPRF, deriveDualAesKeysFromPRF, decryptPrivateKey,
} from '../lib/crypto/keyProtection';

const mockSupabase = supabase as unknown as {
  from: ReturnType<typeof vi.fn>;
  storage: { from: ReturnType<typeof vi.fn> };
};

// ─── Константи ───────────────────────────────────────────────────────────────

const ECDSA_KEY_ID  = 'ecdsa-key-uuid';
const ML_DSA_KEY_ID = 'mldsa-key-uuid';
const DOC_ID        = 'doc-uuid';
const USER_ID       = 'user-uuid';
const CRED_SAME     = new Uint8Array(16).fill(1);
const CRED_DIFF     = new Uint8Array(16).fill(2);

const ECDSA_PRF_SALT  = new Uint8Array(32).fill(1);
const ML_DSA_PRF_SALT = new Uint8Array(32).fill(2);

const FAKE_CERT_DER  = new Uint8Array([0x30, 0x82, 0x01, 0x00, ...new Uint8Array(252).fill(0x00)]);
const FAKE_KEY_PKCS8 = new Uint8Array(138).fill(0x30);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Chainable Supabase query builder mock. */
function mockChain(finalValue: unknown) {
  const self: Record<string, unknown> = {};
  ['select', 'insert', 'update', 'eq', 'is', 'gte', 'order', 'limit'].forEach(m => {
    self[m] = vi.fn().mockReturnValue(self);
  });
  self['maybeSingle'] = vi.fn().mockResolvedValue(finalValue);
  self['single']      = vi.fn().mockResolvedValue(finalValue);
  return self;
}

/** Настройва supabase storage mock. */
function setupStorage() {
  const minimalPdfBytes = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n' +
    '0000000052 00000 n\n0000000101 00000 n\n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n173\n%%EOF',
  );
  mockSupabase.storage.from.mockReturnValue({
    download:        vi.fn().mockResolvedValue({ data: new Blob([minimalPdfBytes]), error: null }),
    upload:          vi.fn().mockResolvedValue({ data: { path: 'ok' }, error: null }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://test.com/signed' }, error: null }),
  });
}

/**
 * Настройва supabase.from mock за documents + signatures таблици.
 *
 * Покрива:
 *   - Стъпка 1: documents SELECT (status check)
 *   - Стъпка 2: signatures SELECT + maybeSingle (grace period)
 *   - Стъпка 12: documents UPDATE + signatures INSERT
 */
function setupDocumentAndSignatureMocks({
  existingSignature = false,
  docStatus = 'uploaded',
} = {}) {
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'signatures') {
      return {
        ...mockChain({ data: existingSignature ? { id: 'old-sig' } : null, error: null }),
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { id: 'new-sig-id' }, error: null }),
        }),
      };
    }
    if (table === 'documents') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                storage_path:      `${USER_ID}/test.pdf`,
                original_filename: 'test.pdf',
                status:            docStatus,
              },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // fetchKeyDecryptData default — ECDSA key с cert
  vi.mocked(fetchKeyDecryptData).mockResolvedValue({
    encryptedSecretKey: new Uint8Array(150).fill(0xaa),
    prfSalt:            ECDSA_PRF_SALT,
    wrappedKeyIv:       new Uint8Array(12).fill(3),
    credentialId:       CRED_SAME,
    algorithm:          'ecdsa-p256' as const,
    certificateDer:     FAKE_CERT_DER,
    publicKey:          null,
  });

  // PRF + decrypt defaults
  vi.mocked(deriveAesKeyFromPRF).mockResolvedValue({
    aesKey: {} as CryptoKey, credentialId: CRED_SAME,
  });
  vi.mocked(deriveDualAesKeysFromPRF).mockResolvedValue({
    aesKey1: {} as CryptoKey, aesKey2: {} as CryptoKey,
  });
  vi.mocked(decryptPrivateKey).mockResolvedValue(FAKE_KEY_PKCS8);

  setupStorage();
  setupDocumentAndSignatureMocks();
});

// ─── resolveSigningKeys ───────────────────────────────────────────────────────

describe('resolveSigningKeys', () => {
  it('хвърля ако няма ECDSA P-256 ключ', async () => {
    vi.mocked(fetchBestKeyId).mockResolvedValue(null);
    await expect(resolveSigningKeys()).rejects.toThrow('Няма активен ECDSA P-256 ключ');
  });

  it('хвърля ако ECDSA ключът няма сертификат', async () => {
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(null);
    vi.mocked(fetchKeyDecryptData).mockResolvedValueOnce({
      encryptedSecretKey: new Uint8Array(1), prfSalt: ECDSA_PRF_SALT,
      wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
      algorithm: 'ecdsa-p256' as const, certificateDer: null, publicKey: null,
    });

    await expect(resolveSigningKeys()).rejects.toThrow('ECDSA ключът няма сертификат');
  });

  it('singlePrf=true ако credential_id-тата съвпадат', async () => {
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(ML_DSA_KEY_ID);
    vi.mocked(fetchKeyDecryptData)
      .mockResolvedValueOnce({
        encryptedSecretKey: new Uint8Array(1), prfSalt: ECDSA_PRF_SALT,
        wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
        algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT_DER, publicKey: null,
      })
      .mockResolvedValueOnce({
        encryptedSecretKey: new Uint8Array(1), prfSalt: ML_DSA_PRF_SALT,
        wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
        algorithm: 'ml-dsa-65' as const, certificateDer: null, publicKey: null,
      });

    const result = await resolveSigningKeys();
    expect(result.singlePrf).toBe(true);
    expect(result.mlDsaKeyId).toBe(ML_DSA_KEY_ID);
  });

  it('singlePrf=false ако credential_id-тата се различават', async () => {
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(ML_DSA_KEY_ID);
    vi.mocked(fetchKeyDecryptData)
      .mockResolvedValueOnce({
        encryptedSecretKey: new Uint8Array(1), prfSalt: ECDSA_PRF_SALT,
        wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
        algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT_DER, publicKey: null,
      })
      .mockResolvedValueOnce({
        encryptedSecretKey: new Uint8Array(1), prfSalt: ML_DSA_PRF_SALT,
        wrappedKeyIv: new Uint8Array(12), credentialId: CRED_DIFF,
        algorithm: 'ml-dsa-65' as const, certificateDer: null, publicKey: null,
      });

    const result = await resolveSigningKeys();
    expect(result.singlePrf).toBe(false);
  });

  it('mlDsaKeyId=null ако няма ML-DSA-65 ключ', async () => {
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(null);
    vi.mocked(fetchKeyDecryptData).mockResolvedValueOnce({
      encryptedSecretKey: new Uint8Array(1), prfSalt: ECDSA_PRF_SALT,
      wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
      algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT_DER, publicKey: null,
    });

    const result = await resolveSigningKeys();
    expect(result.mlDsaKeyId).toBeNull();
    expect(result.singlePrf).toBe(false);
  });
});

// ─── signDocument ─────────────────────────────────────────────────────────────

describe('signDocument', () => {
  const defaultPos = { page: 0, x: 30, y: 30 };

  /**
   * Настройва fetchBestKeyId + fetchKeyDecryptData за стандартен ECDSA + ML-DSA flow.
   * Използва се само за тестове, в които стигаме до стъпка 3 (resolveSigningKeys).
   */
  function setupBothKeys({ sameCredential = true } = {}) {
    const mlCred = sameCredential ? CRED_SAME : CRED_DIFF;
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(ML_DSA_KEY_ID);
    vi.mocked(fetchKeyDecryptData).mockImplementation(async (keyId) => {
      if (keyId === ECDSA_KEY_ID) {
        return {
          encryptedSecretKey: new Uint8Array(150).fill(0xaa), prfSalt: ECDSA_PRF_SALT,
          wrappedKeyIv: new Uint8Array(12).fill(3), credentialId: CRED_SAME,
          algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT_DER, publicKey: null,
        };
      }
      return {
        encryptedSecretKey: new Uint8Array(150).fill(0xbb), prfSalt: ML_DSA_PRF_SALT,
        wrappedKeyIv: new Uint8Array(12).fill(4), credentialId: mlCred,
        algorithm: 'ml-dsa-65' as const, certificateDer: null, publicKey: null,
      };
    });
  }

  // ── Стъпка 1: status check (ПРЕДИ всичко) ──────────────────────────────────

  it('хвърля ако документът има status=signed — БЕЗ key lookup', async () => {
    // Само documents mock — key lookup НЕ трябва да се достига
    setupDocumentAndSignatureMocks({ docStatus: 'signed' });

    await expect(
      signDocument(DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1)),
    ).rejects.toThrow('вече е подписан');

    // Потвърждаваме: fetchBestKeyId не е извикан (key lookup е стъпка 3)
    expect(vi.mocked(fetchBestKeyId)).not.toHaveBeenCalled();
  });

  // ── Стъпка 2: grace period (ПРЕДИ key lookup) ──────────────────────────────

  it('хвърля при grace period — БЕЗ key lookup', async () => {
    // Само documents + signatures mock — key lookup НЕ трябва да се достига
    setupDocumentAndSignatureMocks({ existingSignature: true });

    await expect(
      signDocument(DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1)),
    ).rejects.toThrow('вече е подписан преди по-малко от 30 секунди');

    // Потвърждаваме: fetchBestKeyId не е извикан (key lookup е стъпка 3)
    expect(vi.mocked(fetchBestKeyId)).not.toHaveBeenCalled();
  });

  // ── Стъпка 3: cert validation (СЛЕД doc check и grace period) ──────────────

  it('хвърля ако ECDSA ключът няма сертификат', async () => {
    // Стъпки 1+2 минават → mock-ваме documents + signatures
    setupDocumentAndSignatureMocks();
    // Стъпка 3 хвърля → ECDSA ключ без cert
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(null);
    vi.mocked(fetchKeyDecryptData).mockResolvedValue({
      encryptedSecretKey: new Uint8Array(1), prfSalt: ECDSA_PRF_SALT,
      wrappedKeyIv: new Uint8Array(12), credentialId: CRED_SAME,
      algorithm: 'ecdsa-p256' as const, certificateDer: null, publicKey: null,
    });

    await expect(
      signDocument(DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1)),
    ).rejects.toThrow('ECDSA ключът няма сертификат');
  });

  // ── Успешни flows ───────────────────────────────────────────────────────────

  it('успешно подписване — pqSkipped=false (ECDSA + ML-DSA, единичен PRF)', async () => {
    setupBothKeys({ sameCredential: true });
    setupDocumentAndSignatureMocks();

    const result = await signDocument(
      DOC_ID, USER_ID, 'Дима Йорданов', defaultPos, 'localhost', new Uint8Array(1),
    );

    expect(result.pqSkipped).toBe(false);
    expect(result.signatureId).toBe('new-sig-id');
    expect(result.signedStoragePath).toBe(`${USER_ID}/${DOC_ID}_signed.pdf`);
  });

  it('успешно подписване — pqSkipped=true (само ECDSA, няма ML-DSA-65 ключ)', async () => {
    vi.mocked(fetchBestKeyId)
      .mockResolvedValueOnce(ECDSA_KEY_ID)
      .mockResolvedValueOnce(null);
    vi.mocked(fetchKeyDecryptData).mockResolvedValue({
      encryptedSecretKey: new Uint8Array(150).fill(0xaa), prfSalt: ECDSA_PRF_SALT,
      wrappedKeyIv: new Uint8Array(12).fill(3), credentialId: CRED_SAME,
      algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT_DER, publicKey: null,
    });
    setupDocumentAndSignatureMocks();

    const result = await signDocument(
      DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1),
    );

    expect(result.pqSkipped).toBe(true);
    expect(result.signatureId).toBe('new-sig-id');
  });

  it('ползва единичен PRF ceremony ако credential_id-тата съвпадат', async () => {
    setupBothKeys({ sameCredential: true });
    setupDocumentAndSignatureMocks();

    await signDocument(DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1));

    expect(vi.mocked(deriveDualAesKeysFromPRF)).toHaveBeenCalledOnce();
    expect(vi.mocked(deriveAesKeyFromPRF)).not.toHaveBeenCalled();
  });

  it('ползва два отделни PRF ceremony ако credential_id-тата се различават', async () => {
    setupBothKeys({ sameCredential: false });
    setupDocumentAndSignatureMocks();

    await signDocument(DOC_ID, USER_ID, 'Тест', defaultPos, 'localhost', new Uint8Array(1));

    expect(vi.mocked(deriveAesKeyFromPRF)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deriveDualAesKeysFromPRF)).not.toHaveBeenCalled();
  });
});
