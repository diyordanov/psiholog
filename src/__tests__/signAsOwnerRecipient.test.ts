/**
 * signAsOwnerRecipient.test.ts
 * Ден 4 (Фаза 8): unit тестове за signAsOwner() / signAsRecipient().
 *
 * Стратегия: mock-ваме supabase/crypto/pdf зависимости на module ниво (същия
 * подход като signingService.test.ts) и тестваме САМО orchestration логиката:
 *   - signAsOwner: 0/1/2 recipients → правилен signing_requests/recipients insert,
 *     правилен overall status ('completed' vs 'awaiting_recipients')
 *   - signAsRecipient: success path, security validation, already-signed guard,
 *     optimistic-concurrency retry (race между двама recipients)
 *
 * Реалната PDF/крипто логика е тествана другаде (pdfMultiSign.test.ts,
 * crypto.test.ts); тук е чисто DB orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module-level mocks (същите като signingService.test.ts) ────────────────

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('../lib/auditLog', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/signingKeyStore', () => ({
  fetchBestKeyId:      vi.fn(),
  fetchKeyDecryptData:  vi.fn(),
}));
vi.mock('../lib/crypto/keyProtection', () => ({
  deriveAesKeyFromPRF:      vi.fn(),
  deriveDualAesKeysFromPRF: vi.fn(),
  decryptPrivateKey:        vi.fn(),
}));
vi.mock('../lib/crypto/signing', () => ({
  signWithEcdsaP256: vi.fn().mockResolvedValue(new Uint8Array(64).fill(0x01)),
  signWithMlDsa:     vi.fn().mockResolvedValue(new Uint8Array(3309).fill(0x02)),
}));
vi.mock('../lib/pdf/cmsBuilder', () => ({
  buildSignedAttrs: vi.fn().mockReturnValue(new Uint8Array(100).fill(0x31)),
  buildCmsDetached: vi.fn().mockReturnValue(new Uint8Array(500).fill(0x30)),
}));
vi.mock('../lib/pdf/pdfSigner', () => ({
  preparePdfForSigning: vi.fn().mockResolvedValue({
    bytes: new Uint8Array(1000).fill(0), contentsOffset: 100, byteRangeNumOffset: 200,
  }),
  prepareIncrementalSignature: vi.fn().mockResolvedValue({
    bytes: new Uint8Array(1200).fill(0), contentsOffset: 150, byteRangeNumOffset: 250,
  }),
  computeByteRanges:     vi.fn().mockReturnValue([0, 100, 200, 800] as [number, number, number, number]),
  patchByteRangeInPlace: vi.fn(),
  hashByteRanges:        vi.fn().mockReturnValue(new Uint8Array(32).fill(0xab)),
  injectSignatureAndPQ:  vi.fn().mockReturnValue(new Uint8Array(1500).fill(0)),
  injectIncrementalSignature: vi.fn().mockReturnValue(new Uint8Array(1700).fill(0)),
  encodeBase64url:       vi.fn().mockReturnValue('dGVzdA'),
}));

// ─── Imports след mock ─────────────────────────────────────────────────────────

import { signAsOwner, signAsRecipient } from '../lib/signingService';
import { supabase } from '../lib/supabase';
import { fetchBestKeyId, fetchKeyDecryptData } from '../lib/signingKeyStore';
import { deriveAesKeyFromPRF, decryptPrivateKey } from '../lib/crypto/keyProtection';

const mockSupabase = supabase as unknown as {
  from: ReturnType<typeof vi.fn>;
  storage: { from: ReturnType<typeof vi.fn> };
};

// ─── Константи ───────────────────────────────────────────────────────────────

const DOC_ID    = 'doc-uuid';
const OWNER_ID  = 'owner-uuid';
const RECIP_ID  = 'recipient-uuid';
const CRED      = new Uint8Array(16).fill(1);
const SALT      = new Uint8Array(32).fill(2);
const FAKE_CERT = new Uint8Array([0x30, 0x82, 0x01, 0x00, ...new Uint8Array(252).fill(0x00)]);
const FAKE_KEY  = new Uint8Array(138).fill(0x30);

const defaultPos = { page: 0, x: 30, y: 30 };

/** thenable-обект, който ИМА .then() (за директен await) И допълнителни chain методи. */
function thenable(resolveValue: unknown, extra: Record<string, unknown> = {}) {
  return { then: (resolve: (v: unknown) => void) => resolve(resolveValue), ...extra };
}

// ─── Общи setup helpers ──────────────────────────────────────────────────────

function setupKeysAndStorage() {
  // mockImplementation (не mockResolvedValueOnce×2) — resolveSigningKeys() се
  // вика ПРИ ВСЕКИ retry опит на signAsRecipient() (не само веднъж), затова
  // fetchBestKeyId трябва да отговаря коректно произволен брой пъти, не само
  // за първите 2 извиквания.
  vi.mocked(fetchBestKeyId).mockImplementation((algorithm) =>
    Promise.resolve(algorithm === 'ecdsa-p256' ? 'ecdsa-id' : null),
  );
  vi.mocked(fetchKeyDecryptData).mockResolvedValue({
    encryptedSecretKey: new Uint8Array(150).fill(0xaa), prfSalt: SALT,
    wrappedKeyIv: new Uint8Array(12), credentialId: CRED,
    algorithm: 'ecdsa-p256' as const, certificateDer: FAKE_CERT, publicKey: null,
  });
  vi.mocked(deriveAesKeyFromPRF).mockResolvedValue({ aesKey: {} as CryptoKey, credentialId: CRED });
  vi.mocked(decryptPrivateKey).mockResolvedValue(FAKE_KEY);

  mockSupabase.storage.from.mockReturnValue({
    download: vi.fn().mockResolvedValue({
      data: new Blob([new TextEncoder().encode('%PDF-1.4\n%%EOF')]), error: null,
    }),
    upload: vi.fn().mockResolvedValue({ data: { path: 'ok' }, error: null }),
  });
}

/** documents таблица: select().eq().eq().single() + update().eq() (thenable). */
function documentsTable(status: string = 'uploaded') {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { storage_path: `${OWNER_ID}/test.pdf`, original_filename: 'test.pdf', status },
            error: null,
          }),
        }),
      }),
    }),
    // .eq() поддържа И директен await (signAsOwner completion update, без
    // .select()), И допълнителен .select() chain (signAsRecipient completion
    // update, ИЗИСКВА .select('id') за rows-affected проверка — виж migration
    // 0013 бележката в signingService.ts).
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockImplementation(() =>
        thenable({ error: null }, { select: vi.fn().mockResolvedValue({ data: [{ id: 'doc-id' }], error: null }) }),
      ),
    }),
  };
}

/** signatures таблица: select-chain за grace period (нищо) + insert().select().single(). */
function signaturesTable(signatureId = 'new-sig-id') {
  const chain: Record<string, unknown> = {};
  ['select', 'eq', 'gte'].forEach(m => { chain[m] = vi.fn().mockReturnValue(chain); });
  chain['maybeSingle'] = vi.fn().mockResolvedValue({ data: null, error: null });
  chain['insert'] = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: signatureId }, error: null }),
  });
  return chain;
}

// ═══════════════════════════════════════════════════════════════════════════
// signAsOwner
// ═══════════════════════════════════════════════════════════════════════════

describe('signAsOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupKeysAndStorage();
  });

  /** signing_requests таблица за owner тестове: active-check (none) + insert + update. */
  function signingRequestsTableForOwner(signingRequestId = 'sr-id') {
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // няма активна заявка
            }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: signingRequestId }, error: null }),
      }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    };
  }

  it('0 recipients (backward compat) → status=completed, documents.status=signed', async () => {
    const recipientsInsert = vi.fn();
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents')                  return documentsTable();
      if (table === 'signing_requests')            return signingRequestsTableForOwner();
      if (table === 'signing_request_recipients')  return { insert: recipientsInsert };
      if (table === 'signatures')                  return signaturesTable();
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsOwner(DOC_ID, OWNER_ID, 'Owner Test', defaultPos, [], 'localhost');

    expect(result.status).toBe('completed');
    expect(result.version).toBe(1);
    expect(result.signedStoragePath).toBe('sr-id/v1.pdf');
    expect(recipientsInsert).not.toHaveBeenCalled(); // 0 recipients → без INSERT въобще
  });

  it('1 recipient → status=awaiting_recipients, insert-ва 1 recipient ред', async () => {
    const recipientsInsert = vi.fn().mockResolvedValue({ error: null });
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents')                  return documentsTable();
      if (table === 'signing_requests')            return signingRequestsTableForOwner();
      if (table === 'signing_request_recipients')  return { insert: recipientsInsert };
      if (table === 'signatures')                  return signaturesTable();
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsOwner(
      DOC_ID, OWNER_ID, 'Owner Test', defaultPos,
      [{ email: 'Recipient1@Example.com', position: { page: 0, x: 260, y: 30 } }],
      'localhost',
    );

    expect(result.status).toBe('awaiting_recipients');
    expect(recipientsInsert).toHaveBeenCalledTimes(1);
    const insertedRows = recipientsInsert.mock.calls[0][0] as Array<{ invited_email: string }>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].invited_email).toBe('recipient1@example.com'); // lowercase-нат
  });

  it('2 recipients → insert-ва 2 реда, status=awaiting_recipients', async () => {
    const recipientsInsert = vi.fn().mockResolvedValue({ error: null });
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents')                  return documentsTable();
      if (table === 'signing_requests')            return signingRequestsTableForOwner();
      if (table === 'signing_request_recipients')  return { insert: recipientsInsert };
      if (table === 'signatures')                  return signaturesTable();
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsOwner(
      DOC_ID, OWNER_ID, 'Owner Test', defaultPos,
      [
        { email: 'r1@example.com', position: { page: 0, x: 260, y: 30 } },
        { email: 'r2@example.com', position: { page: 0, x: 30, y: 90 } },
      ],
      'localhost',
    );

    expect(result.status).toBe('awaiting_recipients');
    const insertedRows = recipientsInsert.mock.calls[0][0] as Array<unknown>;
    expect(insertedRows).toHaveLength(2);
  });

  it('хвърля ако вече има активна заявка за документа', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents') return documentsTable();
      if (table === 'signing_requests') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'existing-sr' }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    await expect(
      signAsOwner(DOC_ID, OWNER_ID, 'Owner Test', defaultPos, [], 'localhost'),
    ).rejects.toThrow('Вече има активна заявка');
    expect(vi.mocked(fetchBestKeyId)).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// signAsRecipient
// ═══════════════════════════════════════════════════════════════════════════

describe('signAsRecipient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupKeysAndStorage();
  });

  const SR_ID = 'sr-id';

  /** signing_request_recipients таблица: fetch-one (recipientId) + update (mark signed) + fetch-all (status check). */
  function recipientsTable(opts: {
    recipientRow: { id: string; signing_request_id: string; user_id: string | null; status: string };
    allRecipientsAfter: { status: string }[]; // резултат от "fetch all" ПОСЛЕ update-а
  }) {
    return {
      // Едно и също select()→eq() обслужва и "fetch one" (.single() отгоре, за
      // fetchRecipientForSigning), и "fetch all" (awaited директно, за allSigned
      // проверката) — реалният код различава по това дали .single() е chain-нат.
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() =>
          thenable(
            { data: opts.allRecipientsAfter, error: null },
            { single: vi.fn().mockResolvedValue({ data: opts.recipientRow, error: null }) },
          ),
        ),
      }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    };
  }

  /**
   * signing_requests таблица за recipient тестове.
   * @param optimisticSelectResults — по един резултат за всеки поред опит
   *   (за race теста: [{data:[],error:null}, {data:[{id}],error:null}])
   */
  function signingRequestsTableForRecipient(
    srRow: { id: string; document_id: string; status: string; current_signed_storage_path: string | null; version: number },
    optimisticSelectResults: { data: unknown[] | null; error: unknown }[] = [{ data: [{ id: SR_ID }], error: null }],
  ) {
    let optimisticCallIndex = 0;
    const optimisticSelect = vi.fn().mockImplementation(() =>
      Promise.resolve(optimisticSelectResults[optimisticCallIndex++] ?? { data: [], error: null }),
    );

    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: srRow, error: null }) }),
      }),
      update: vi.fn().mockImplementation(() => ({
        eq: vi.fn().mockImplementation(() =>
          thenable(
            { error: null }, // (неизползвано в реалния код — completion update вече вика .select())
            {
              eq: vi.fn().mockReturnValue({ select: optimisticSelect }), // optimistic-concurrency path (2 eq + select)
              select: vi.fn().mockResolvedValue({ data: [{ id: SR_ID }], error: null }), // completion path (1 eq + select)
            },
          ),
        ),
      })),
    };
  }

  it('успешно подписване — version се увеличава, recipient маркиран signed, allSigned=false (не последен)', async () => {
    const srRow = { id: SR_ID, document_id: DOC_ID, status: 'awaiting_recipients', current_signed_storage_path: `${SR_ID}/v1.pdf`, version: 1 };
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: OWNER_ID, status: 'registered' };

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [{ status: 'signed' }, { status: 'pending' }] });
      }
      if (table === 'signing_requests') return signingRequestsTableForRecipient(srRow);
      if (table === 'signatures')       return signaturesTable('recipient-sig-id');
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost');

    expect(result.version).toBe(2);
    expect(result.signedStoragePath).toBe(`${SR_ID}/v2.pdf`);
    expect(result.allSigned).toBe(false);
    expect(result.status).toBe('awaiting_recipients');
    expect(result.signatureId).toBe('recipient-sig-id');
  });

  it('последният recipient → allSigned=true, status=completed', async () => {
    const srRow = { id: SR_ID, document_id: DOC_ID, status: 'awaiting_recipients', current_signed_storage_path: `${SR_ID}/v1.pdf`, version: 1 };
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: OWNER_ID, status: 'registered' };

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents') return documentsTable();
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [{ status: 'signed' }] }); // всички подписали
      }
      if (table === 'signing_requests') return signingRequestsTableForRecipient(srRow);
      if (table === 'signatures')       return signaturesTable('recipient-sig-id');
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost');

    expect(result.allSigned).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('невалиден recipient (не негов ред) → security грешка, БЕЗ key lookup', async () => {
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: 'someone-else-uuid', status: 'registered' };
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [] });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    await expect(
      signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost'),
    ).rejects.toThrow('Нямате достъп');
    expect(vi.mocked(fetchBestKeyId)).not.toHaveBeenCalled();
  });

  it('вече подписал recipient → ясна грешка, БЕЗ key lookup', async () => {
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: OWNER_ID, status: 'signed' };
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [] });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    await expect(
      signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost'),
    ).rejects.toThrow('Вече сте подписали');
    expect(vi.mocked(fetchBestKeyId)).not.toHaveBeenCalled();
  });

  it('concurrent race (version mismatch) → retry успешно на 2-рия опит', async () => {
    const srRow = { id: SR_ID, document_id: DOC_ID, status: 'awaiting_recipients', current_signed_storage_path: `${SR_ID}/v1.pdf`, version: 1 };
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: OWNER_ID, status: 'registered' };

    // ВАЖНО: конструираме таблиците ВЕДНЪЖ, извън mockImplementation callback-а
    // — .from('signing_requests') се вика МНОГОКРАТНО (fetch + optimistic
    // update) на опит, а mockImplementation callback-ът се изпълнява при ВСЯКО
    // извикване; ако таблицата (с вътрешния optimisticCallIndexброяч) се
    // конструира вътре в callback-а, брояча се нулира при всяко извикване.
    const signingRequestsTable = signingRequestsTableForRecipient(srRow, [
      { data: [], error: null },              // опит 1: race — 0 rows
      { data: [{ id: SR_ID }], error: null }, // опит 2: успех
    ]);
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'documents') return documentsTable();
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [{ status: 'signed' }, { status: 'signed' }] });
      }
      if (table === 'signing_requests') return signingRequestsTable;
      if (table === 'signatures') return signaturesTable('recipient-sig-id-retry');
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost');

    // Успя на втория опит — резултатът е валиден (не хвърля).
    expect(result.signatureId).toBe('recipient-sig-id-retry');
  });

  it('изчерпани retries (3/3 race) → ясна грешка за презареждане', async () => {
    const srRow = { id: SR_ID, document_id: DOC_ID, status: 'awaiting_recipients', current_signed_storage_path: `${SR_ID}/v1.pdf`, version: 1 };
    const recipientRow = { id: RECIP_ID, signing_request_id: SR_ID, user_id: OWNER_ID, status: 'registered' };

    // Конструираме ВЕДНЪЖ, извън callback-а (виж коментара в предния тест).
    const signingRequestsTable = signingRequestsTableForRecipient(srRow, [
      { data: [], error: null }, // И трите опита се провалят (race персистира)
      { data: [], error: null },
      { data: [], error: null },
    ]);
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'signing_request_recipients') {
        return recipientsTable({ recipientRow, allRecipientsAfter: [] });
      }
      if (table === 'signing_requests') return signingRequestsTable;
      throw new Error(`unexpected table: ${table}`);
    });

    await expect(
      signAsRecipient(RECIP_ID, OWNER_ID, 'Recipient Test', 'localhost'),
    ).rejects.toThrow('презаредете страницата');
  });
});
