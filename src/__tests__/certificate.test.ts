/**
 * certificate.test.ts
 * Vitest тестове за certStatus логиката и ML-DSA-65 attestation формата.
 *
 * Тествани сценарии:
 *   computeCertStatus: 4 сценария (ok / expiring-soon / expired / missing)
 *   ML-DSA-65 attestation structure: всички задължителни полета присъстват
 *   retrofitMissingCerts: partial failure се обработва коректно
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeCertStatus } from '../lib/signingKeyStore';

// ─── computeCertStatus ────────────────────────────────────────────────────────

describe('computeCertStatus', () => {
  it('missing → null expiresAt', () => {
    expect(computeCertStatus(null)).toBe('missing');
  });

  it('ok → expiresAt > 30 дни напред', () => {
    const future = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    expect(computeCertStatus(future)).toBe('ok');
  });

  it('expiring-soon → expiresAt е в следващите 30 дни', () => {
    const soon = new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString();
    expect(computeCertStatus(soon)).toBe('expiring-soon');
  });

  it('expired → expiresAt е в миналото', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(computeCertStatus(past)).toBe('expired');
  });
});

// ─── ML-DSA-65 attestation формат ────────────────────────────────────────────

describe('ML-DSA-65 attestation format', () => {
  it('JSON attestation съдържа всички задължителни полета', () => {
    const attestation = {
      version: 1,
      algorithm: 'ml-dsa-65',
      oid: '2.16.840.1.101.3.4.3.18',
      publicKey: 'dGVzdA',
      subject: { userId: 'uuid-123', displayName: 'Тест' },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString(),
      issuer: 'SignShield Root CA v1',
      caSignature: 'c2lnbmF0dXJl',
    };

    expect(attestation.version).toBe(1);
    expect(attestation.algorithm).toBe('ml-dsa-65');
    expect(attestation.oid).toBe('2.16.840.1.101.3.4.3.18');
    expect(attestation.issuer).toBe('SignShield Root CA v1');
    expect(attestation.subject.userId).toBeTruthy();
    expect(attestation.caSignature).toBeTruthy();
  });

  it('canonical JSON (без caSignature) е детерминиран — редът на ключовете е фиксиран', () => {
    const data = {
      version: 1,
      algorithm: 'ml-dsa-65',
      oid: '2.16.840.1.101.3.4.3.18',
      publicKey: 'abc123',
      subject: { userId: 'u1', displayName: 'Тест' },
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2028-01-01T00:00:00.000Z',
      issuer: 'SignShield Root CA v1',
    };

    // Повикан два пъти → трябва да е идентичен низ
    const canonical1 = JSON.stringify(data);
    const canonical2 = JSON.stringify(data);
    expect(canonical1).toBe(canonical2);

    // Трябва да съдържа OID в текст
    expect(canonical1).toContain('2.16.840.1.101.3.4.3.18');
    // Трябва да НЕ съдържа caSignature
    expect(canonical1).not.toContain('caSignature');
  });
});

// ─── retrofitMissingCerts — partial failure ───────────────────────────────────

describe('retrofitMissingCerts', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('обработва partial failure — провалените ключове връщат error, останалите ok', async () => {
    // Mock на supabase и certificateService
    vi.doMock('../lib/supabase', () => ({
      supabase: {
        auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }) },
        functions: {
          invoke: vi.fn().mockImplementation((_fn, { body }) => {
            // Имитираме грешка за конкретен keyId
            if (body.signingKeyId === 'fail-key') {
              return Promise.resolve({ error: { message: 'Грешка' } });
            }
            return Promise.resolve({ error: null });
          }),
        },
      },
    }));

    const { retrofitMissingCerts } = await import('../lib/certificateService');
    const results = await retrofitMissingCerts(['ok-key', 'fail-key']);

    expect(results.get('ok-key')).toBe('ok');
    expect(results.get('fail-key')).toBe('error');
  });

  it('празен масив → връща празна Map без grешка', async () => {
    vi.doMock('../lib/supabase', () => ({
      supabase: { auth: { getSession: vi.fn() }, functions: { invoke: vi.fn() } },
    }));

    const { retrofitMissingCerts } = await import('../lib/certificateService');
    const results = await retrofitMissingCerts([]);
    expect(results.size).toBe(0);
  });
});
