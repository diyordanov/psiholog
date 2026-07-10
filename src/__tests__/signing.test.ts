/**
 * signing.test.ts
 * Unit тестове за:
 *   1. clickToMarkerPos() — coordinate mapping (pure function)
 *   2. signDocument() onProgress callback — ред и проценти
 *   3. DEFAULT_MARKER константа
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
  fetchBestKeyId:      vi.fn(),
  fetchKeyDecryptData: vi.fn(),
}));
vi.mock('../lib/crypto/keyProtection', () => ({
  deriveAesKeyFromPRF:      vi.fn(),
  deriveDualAesKeysFromPRF: vi.fn(),
  decryptPrivateKey:        vi.fn(),
}));
vi.mock('../lib/crypto/signing', () => ({
  signWithEcdsaP256: vi.fn().mockResolvedValue(new Uint8Array(64).fill(1)),
  signWithMlDsa:     vi.fn().mockResolvedValue(new Uint8Array(3309).fill(2)),
}));
vi.mock('../lib/pdf/cmsBuilder', () => ({
  buildSignedAttrs: vi.fn().mockReturnValue(new Uint8Array(100)),
  buildCmsDetached: vi.fn().mockReturnValue(new Uint8Array(500)),
}));
vi.mock('../lib/pdf/pdfSigner', () => ({
  preparePdfForSigning: vi.fn().mockResolvedValue({
    bytes: new Uint8Array(1000), contentsOffset: 100, byteRangeNumOffset: 200,
  }),
  computeByteRanges:    vi.fn().mockReturnValue([0, 100, 200, 800] as [number,number,number,number]),
  patchByteRangeInPlace: vi.fn(),
  hashByteRanges:       vi.fn().mockReturnValue(new Uint8Array(32).fill(0xab)),
  injectSignatureAndPQ: vi.fn().mockReturnValue(new Uint8Array(1500)),
  encodeBase64url:      vi.fn().mockReturnValue('dGVzdA'),
}));

import { clickToMarkerPos, DEFAULT_MARKER } from '../components/documents/SignDocumentModal';
import { signDocument } from '../lib/signingService';
import { supabase } from '../lib/supabase';
import { fetchBestKeyId, fetchKeyDecryptData } from '../lib/signingKeyStore';
import { deriveAesKeyFromPRF, decryptPrivateKey } from '../lib/crypto/keyProtection';

const mockSupa = supabase as unknown as {
  from: ReturnType<typeof vi.fn>;
  storage: { from: ReturnType<typeof vi.fn> };
};

const FAKE_CERT = new Uint8Array([0x30, 0x82, ...new Uint8Array(254)]);
const FAKE_KEY  = new Uint8Array(138).fill(0x30);
const CRED      = new Uint8Array(16).fill(1);
const SALT      = new Uint8Array(32).fill(2);

function setupMocks() {
  vi.mocked(fetchBestKeyId).mockResolvedValueOnce('ecdsa-id').mockResolvedValueOnce(null);
  vi.mocked(fetchKeyDecryptData).mockResolvedValue({
    encryptedSecretKey: new Uint8Array(150).fill(0xaa),
    prfSalt: SALT, wrappedKeyIv: new Uint8Array(12), credentialId: CRED,
    algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT,
  });
  vi.mocked(deriveAesKeyFromPRF).mockResolvedValue({ aesKey: {} as CryptoKey, credentialId: CRED });
  vi.mocked(decryptPrivateKey).mockResolvedValue(FAKE_KEY);

  mockSupa.from.mockImplementation((table: string) => {
    if (table === 'documents') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { storage_path: 'u/test.pdf', original_filename: 'test.pdf', status: 'uploaded' },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      };
    }
    if (table === 'signatures') {
      const chain: Record<string, unknown> = {};
      ['select','eq','is','gte','order','limit'].forEach(m => { chain[m] = vi.fn().mockReturnValue(chain); });
      chain['maybeSingle'] = vi.fn().mockResolvedValue({ data: null, error: null });
      chain['insert'] = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: 'sig-id' }, error: null }),
      });
      return chain;
    }
    return { select: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }) };
  });
  mockSupa.storage.from.mockReturnValue({
    download: vi.fn().mockResolvedValue({
      data: new Blob([new TextEncoder().encode('%PDF-1.4\n%%EOF')]), error: null,
    }),
    upload: vi.fn().mockResolvedValue({ data: { path: 'ok' }, error: null }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. clickToMarkerPos ──────────────────────────────────────────────────────
//
// CSS Y=0 = горе; PDF Y=0 = долу → обратна Y-ос.
// Проверяваме с точни стойности (Math.round е детерминиран).

describe('clickToMarkerPos', () => {
  it('CSS горен-ляв ъгъл (0,0) → PDF ляво-горе (X=0, Y=pageHeight)', () => {
    const pos = clickToMarkerPos(0, 0, 300, 420, 595, 842);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(842);
  });

  it('CSS долен-ляв ъгъл (0,H) → PDF ляво-долу (X=0, Y=0)', () => {
    const pos = clickToMarkerPos(0, 420, 300, 420, 595, 842);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it('CSS център (W/2,H/2) → PDF център', () => {
    const pos = clickToMarkerPos(150, 210, 300, 420, 595, 842);
    expect(pos.x).toBe(298);   // Math.round(150/300 * 595) = Math.round(297.5) = 298
    expect(pos.y).toBe(421);   // Math.round((1 - 210/420) * 842) = Math.round(421) = 421
  });

  it('CSS десен-долен ъгъл (W,H) → PDF дясно-долу (X=pageWidth, Y=0)', () => {
    const pos = clickToMarkerPos(300, 420, 300, 420, 595, 842);
    expect(pos.x).toBe(595);
    expect(pos.y).toBe(0);
  });

  it('X и Y са цели числа', () => {
    const pos = clickToMarkerPos(123, 77, 300, 400, 595, 842);
    expect(Number.isInteger(pos.x)).toBe(true);
    expect(Number.isInteger(pos.y)).toBe(true);
  });
});

// ─── 2. DEFAULT_MARKER ────────────────────────────────────────────────────────

describe('DEFAULT_MARKER', () => {
  it('е страница 0, X=30, Y=30 (долу вляво)', () => {
    expect(DEFAULT_MARKER).toEqual({ page: 0, x: 30, y: 30 });
  });
});

// ─── 3. signDocument onProgress callback ─────────────────────────────────────

describe('signDocument onProgress', () => {
  it('извиква onProgress с нарастващи проценти в правилен ред', async () => {
    setupMocks();
    const calls: [number, string][] = [];

    await signDocument(
      'doc-id', 'user-id', 'Тест',
      { page: 0, x: 30, y: 30 },
      'localhost',
      new Uint8Array(1),
      undefined, undefined,
      (pct, label) => calls.push([pct, label]),
    );

    const pcts = calls.map(([p]) => p);
    // Процентите трябва да са строго нарастващи
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    }
    // Първата стъпка е 5%, последната ≥ 85%
    expect(pcts[0]).toBe(5);
    expect(pcts[pcts.length - 1]).toBeGreaterThanOrEqual(85);
  });

  it('не е задължителен — signDocument работи без onProgress', async () => {
    setupMocks();
    await expect(
      signDocument('doc-id', 'user-id', 'Тест', { page: 0, x: 30, y: 30 }, 'localhost', new Uint8Array(1)),
    ).resolves.toMatchObject({ pqSkipped: true });
  });
});
