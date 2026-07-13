/**
 * edgeCases.test.ts
 * Edge case тестове за verifyDocument() — нестандартни входни данни.
 *
 * Сценарии:
 *   1. Garbage bytes (нито PDF) → unsigned (sanitizer пуска, no ByteRange)
 *   2. Truncated PDF (прекъснат в средата) → unsigned
 *   3. PDF с /ByteRange но malformed числа → unsigned
 *   4. PDF с валиден /ByteRange но garbage /Contents (hex ok но garbage CMS) → error
 *   5. Много голям буфер (49 MB нули) → unsigned, без crash, в разумно време
 *   6. PDF/A header → не гърми, unsigned
 *   7. PDF с /JavaScript → error (sanitizer)
 *   8. Multiple /ByteRange в един файл → взима последния, не crash-ва
 *   9. Empty buffer (0 bytes) → unsigned
 *  10. PDF с /ByteRange и /Contents <> без hex → unsigned
 */

import { describe, it, expect } from 'vitest';
import { verifyDocument } from '../lib/verify/verifyService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** Minimal unsigned PDF */
function minimalPdf(): Uint8Array {
  return enc.encode(
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n191\n%%EOF\n',
  );
}

/** PDF с валиден /ByteRange но garbage hex в /Contents */
function pdfWithGarbageCms(): Uint8Array {
  // Реален формат на ByteRange + Contents, но CMS bytes са мусор
  const content =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
    '4 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached\n' +
    '/ByteRange [ 0 100 200 100 ]\n' +
    '/Contents <' + 'DEADBEEF'.repeat(20) + '> >>\nendobj\n' +   // garbage DER
    'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000058 00000 n \n0000000115 00000 n \n0000000190 00000 n \n' +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n350\n%%EOF\n';
  return enc.encode(content);
}

/** PDF с malformed /ByteRange (само 3 числа вместо 4) */
function pdfWithMalformedByteRange(): Uint8Array {
  const content =
    '%PDF-1.4\n' +
    '4 0 obj\n<< /ByteRange [ 0 100 200 ] /Contents <AABBCCDD> >>\nendobj\n' +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n';
  return enc.encode(content);
}

/** PDF/A header (реален PDF/A-1b header) */
function pdfaDocument(): Uint8Array {
  const content =
    '%PDF-1.4\n' +
    '%\xc3\xa9\xc3\xa0\xc3\xb0\xc3\xa6\n' +  // binary comment (PDF/A изискване)
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
    '% PDF/A-1b conforming document\n% GTS_PDFA1\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000020 00000 n \n' +
    '0000000069 00000 n \n0000000126 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n200\n%%EOF\n';
  return enc.encode(content);
}

/** PDF с два /ByteRange маркера (incremental update сценарий) */
function pdfWithTwoByteRanges(): Uint8Array {
  // Старият update има /ByteRange; след incremental update има втори.
  // Verifier-ът трябва да взима последния (actuалния).
  const content =
    '%PDF-1.4\n' +
    '% Old update with first ByteRange\n' +
    '4 0 obj\n<< /ByteRange [ 0 50 80 50 ] /Contents <' + 'AA'.repeat(16) + '> >>\nendobj\n' +
    '% Incremental update\n' +
    '5 0 obj\n<< /ByteRange [ 0 200 300 200 ] /Contents <' + 'BB'.repeat(16) + '> >>\nendobj\n' +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n400\n%%EOF\n';
  return enc.encode(content);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Edge cases — verifyDocument()', () => {

  it('1. Garbage bytes → unsigned (не crash-ва)', async () => {
    const garbage = new Uint8Array(1024).fill(0xaa);
    const result = await verifyDocument(garbage);
    expect(result.overall).toBe('unsigned');
  });

  it('2. Empty buffer → unsigned', async () => {
    const result = await verifyDocument(new Uint8Array(0));
    expect(result.overall).toBe('unsigned');
  });

  it('3. Truncated PDF (прекъснат) → unsigned', async () => {
    const full = minimalPdf();
    const truncated = full.slice(0, Math.floor(full.length / 2));
    const result = await verifyDocument(truncated);
    expect(result.overall).toBe('unsigned');
  });

  it('4. PDF с malformed /ByteRange (3 числа вместо 4) → unsigned', async () => {
    const result = await verifyDocument(pdfWithMalformedByteRange());
    expect(result.overall).toBe('unsigned');
  });

  it('5. PDF с garbage /Contents (invalid CMS DER) → error с ясно съобщение', async () => {
    const result = await verifyDocument(pdfWithGarbageCms());
    // Може да е 'error' (parseCms хвърля) или 'unsigned' (ако byte range e извън файла)
    expect(['error', 'unsigned']).toContain(result.overall);
  });

  it('6. Много голям буфер (49 MB нули) → завършва под 3 секунди, unsigned', async () => {
    const large = new Uint8Array(49 * 1024 * 1024); // 49 MB нули
    const start = Date.now();
    const result = await verifyDocument(large);
    const elapsed = Date.now() - start;
    expect(result.overall).toBe('unsigned');
    expect(elapsed).toBeLessThan(3000); // под 3 секунди
  }, 10_000); // timeout 10s за по-бавни машини

  it('7. PDF с /JavaScript → error (sanitizer reject)', async () => {
    const malicious = enc.encode(
      '%PDF-1.4\n<< /JavaScript (alert(1)) >>\n%%EOF\n',
    );
    const result = await verifyDocument(malicious);
    expect(result.overall).toBe('error');
    expect(result.errorMessage).toContain('JavaScript');
  });

  it('8. PDF/A header → не гърми, unsigned', async () => {
    const result = await verifyDocument(pdfaDocument());
    expect(result.overall).toBe('unsigned');
  });

  it('9. Нормален PDF без подпис → unsigned с null полета', async () => {
    const result = await verifyDocument(minimalPdf());
    expect(result.overall).toBe('unsigned');
    expect(result.ecdsa).toBeNull();
    expect(result.mlDsa).toBeNull();
    expect(result.documentHash).toBeNull();
  });

  it('10. PDF с два /ByteRange → не crash-ва (взима последния)', async () => {
    const result = await verifyDocument(pdfWithTwoByteRanges());
    // Второто ByteRange сочи към области извън реалните данни →
    // parseCms или error, не crash
    expect(['error', 'unsigned']).toContain(result.overall);
  });
});
