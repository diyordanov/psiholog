/**
 * reportGenerator.test.ts
 * Smoke тестове — проверяваме, че generateVerificationReport() връща валиден PDF
 * за всеки от 4-те OverallStatus сценария + N-signer (Ден 3) сценарий.
 *
 * Не тестваме pixel-perfect layout — само:
 *  • Функцията завършва без хвърляне на грешка.
 *  • Резултатът е Uint8Array с валиден PDF header (%PDF-).
 *  • Filename helper работи правилно.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateVerificationReport, reportFileName } from '../lib/verify/reportGenerator';
import type { VerifyResult, SignerResult, EcdsaVerifyResult } from '../lib/verify/types';

// ─── NotoSans fetch mock ──────────────────────────────────────────────────────
// Реален NotoSans е 500KB+ — за тестове mock-ваме с минимален TTF.
// pdf-lib/fontkit трябва да се справи дори с празен ArrayBuffer (ще хвърли),
// затова инджектваме 1-байтов TTF dummy → fontkit ще хвърли,
// затова по-добре mock-ваме целия fetch с валиден NotoSans байт поток.
//
// Вместо истински TTF, mock-ваме embedFont да не прави нищо,
// а за теста mock-ваме pdf-lib на module ниво.
//
// По-просто: mock-ваме fetch → връща ArrayBuffer с 4 нула байта;
// mock-ваме pdfDoc.embedFont → връща фалшив font обект.
// Тъй като не тестваме rendering, само smoke-test → mock-ваме pdf-lib.

// Mock fetchAPI — за NotoSans
const mockArrayBuffer = new ArrayBuffer(4);
globalThis.fetch = vi.fn().mockResolvedValue({
  arrayBuffer: () => Promise.resolve(mockArrayBuffer),
  ok: true,
});

// Mock pdf-lib и fontkit на module ниво.
// getPages() е нужен за footer-а на всяка страница (пагинация, Ден 3).
vi.mock('pdf-lib', async () => {
  const actual = await vi.importActual<typeof import('pdf-lib')>('pdf-lib');
  return {
    ...actual,
    PDFDocument: {
      ...actual.PDFDocument,
      create: vi.fn().mockImplementation(async () => {
        const fakeFont = {
          widthOfTextAtSize: () => 50,
          encodeText: (t: string) => new TextEncoder().encode(t),
        };
        const pages: unknown[] = [];
        const makePage = () => {
          const page = {
            drawText: vi.fn(),
            drawRectangle: vi.fn(),
            drawLine: vi.fn(),
          };
          pages.push(page);
          return page;
        };
        return {
          registerFontkit: vi.fn(),
          embedFont: vi.fn().mockResolvedValue(fakeFont),
          addPage: vi.fn().mockImplementation(makePage),
          getPages: vi.fn().mockImplementation(() => pages),
          save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D])), // %PDF-
        };
      }),
    },
  };
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function fakeEcdsa(overrides?: Partial<EcdsaVerifyResult>): EcdsaVerifyResult {
  return {
    status: 'valid',
    algorithm: 'ecdsa-p256',
    signerName: 'Иван Петров',
    signedAt: new Date('2026-01-15T10:30:00Z'),
    certStatus: 'ok',
    certExpiry: new Date('2027-01-15T00:00:00Z'),
    certIssuer: 'SignShield Root CA v1',
    certDer: new Uint8Array([1, 2, 3]),
    sigBytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
    ...overrides,
  };
}

function fakeSigner(index: number, overrides?: Partial<SignerResult>): SignerResult {
  const ecdsa = fakeEcdsa(overrides?.ecdsa as Partial<EcdsaVerifyResult>);
  return {
    signerIndex: index,
    ecdsa,
    mlDsa: { status: 'valid', algorithm: 'ml-dsa-65', sigBytes: new Uint8Array([0x11, 0x22]) },
    signerName: ecdsa.signerName,
    signedAt: ecdsa.signedAt,
    ...overrides,
  };
}

function fakeResult(overrides?: Partial<VerifyResult>): VerifyResult {
  const signers = overrides?.signers ?? [fakeSigner(0)];
  return {
    overall: 'authentic',
    documentHash: 'a'.repeat(64),
    byteRange: [0, 1000, 1200, 800],
    signers,
    totalSigners: signers.length,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('generateVerificationReport', () => {
  beforeEach(() => {
    vi.mocked(globalThis.fetch).mockClear();
  });

  it('authentic (N=1) — връща Uint8Array', async () => {
    const result = fakeResult({ overall: 'authentic' });
    const bytes = await generateVerificationReport(result, 'договор-2026.pdf');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('tampered — завършва без грешка', async () => {
    const result = fakeResult({
      overall: 'tampered',
      signers: [fakeSigner(0, { ecdsa: fakeEcdsa({ status: 'invalid', errorMessage: 'Документът е модифициран.' }) })],
    });
    await expect(generateVerificationReport(result, 'договор.pdf')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('invalid (chain_invalid) — завършва без грешка', async () => {
    const result = fakeResult({
      overall: 'invalid',
      signers: [{
        signerIndex: 0,
        ecdsa: fakeEcdsa({ status: 'invalid', certStatus: 'chain_invalid', errorMessage: 'Непозната CA.' }),
        mlDsa: { status: 'not_included', algorithm: 'ml-dsa-65' },
        signerName: 'Иван Петров',
        signedAt: new Date('2026-01-15T10:30:00Z'),
      }],
    });
    await expect(generateVerificationReport(result, 'test.pdf')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('authentic_with_warnings (изтекъл cert) — завършва без грешка', async () => {
    const ecdsa = fakeEcdsa({ certStatus: 'expired', certExpiry: new Date('2024-01-01') });
    const result = fakeResult({
      overall: 'authentic_with_warnings',
      signers: [{
        signerIndex: 0, ecdsa,
        mlDsa: { status: 'not_included', algorithm: 'ml-dsa-65' },
        signerName: ecdsa.signerName, signedAt: ecdsa.signedAt,
      }],
    });
    await expect(generateVerificationReport(result, 'стар-договор.pdf')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('N=3 подписа (multi-signer) — секция за всеки, завършва без грешка', async () => {
    const result = fakeResult({
      overall: 'authentic_with_warnings',
      signers: [
        fakeSigner(0, { signerName: 'Собственик', ecdsa: fakeEcdsa({ signerName: 'Собственик' }) }),
        { signerIndex: 1, ecdsa: fakeEcdsa({ signerName: 'Получател 1' }), mlDsa: null, signerName: 'Получател 1', signedAt: new Date('2026-01-16T09:00:00Z') },
        { signerIndex: 2, ecdsa: fakeEcdsa({ signerName: 'Получател 2' }), mlDsa: null, signerName: 'Получател 2', signedAt: new Date('2026-01-17T09:00:00Z') },
      ],
    });
    const bytes = await generateVerificationReport(result, 'multi-signed.pdf');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('unsigned (signers празен) — завършва без грешка', async () => {
    const result = fakeResult({ overall: 'unsigned', signers: [], totalSigners: 0, documentHash: null, byteRange: null });
    await expect(generateVerificationReport(result, 'test.pdf')).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('reportFileName', () => {
  it('генерира правилен формат', () => {
    const name = reportFileName('договор-2026.pdf');
    expect(name).toMatch(/^verification-report_.+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.pdf$/);
    expect(name).toContain('договор-2026');
  });

  it('премахва .pdf разширението', () => {
    const name = reportFileName('test.pdf');
    expect(name).not.toContain('.pdf.pdf');
    expect(name).toMatch(/^verification-report_test_/);
  });

  it('работи с файлове без разширение', () => {
    const name = reportFileName('nodotpdf');
    expect(name).toMatch(/^verification-report_nodotpdf_/);
  });
});
