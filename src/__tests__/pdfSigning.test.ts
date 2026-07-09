/**
 * pdfSigning.test.ts
 * Unit тестове за CMS DER структура и byte range математика.
 *
 * НЕ тества пълния signing flow (passkey, pdf-lib) — само чистите функции.
 * Тествани: extractCertInfo, buildSignedAttrs, buildCmsDetached,
 *            findPattern, computeByteRanges, hashByteRanges.
 */
import { describe, it, expect } from 'vitest';
import { extractCertInfo, buildSignedAttrs, buildCmsDetached } from '../lib/pdf/cmsBuilder';
import {
  findPattern, computeByteRanges, hashByteRanges, formatPdfDate,
  CONTENTS_PLACEHOLDER_BYTES, type PreparedPdf,
} from '../lib/pdf/pdfSigner';
import { ROOT_CA_CERT_PEM } from '../lib/crypto/rootCaCert';

// ─── Помощни функции ──────────────────────────────────────────────────────────

/** PEM → DER Uint8Array (за тестове с реален Root CA сертификат). */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** Прочита TLV tag и length от DER bytes; връща дължината на content и offset до него. */
function parseTlv(bytes: Uint8Array, pos = 0): { tag: number; len: number; contentStart: number } {
  const tag = bytes[pos];
  pos++;
  let len: number;
  if (bytes[pos] < 0x80) {
    len = bytes[pos]; pos++;
  } else {
    const nb = bytes[pos] & 0x7f; pos++;
    len = 0;
    for (let i = 0; i < nb; i++) len = (len << 8) | bytes[pos++];
  }
  return { tag, len, contentStart: pos };
}

// Root CA cert DER (реален, генериран от scripts/generate-root-ca.mjs)
const caCertDer = pemToDer(ROOT_CA_CERT_PEM);

// ─── extractCertInfo ──────────────────────────────────────────────────────────

describe('extractCertInfo', () => {
  it('извлича issuerDN като SEQUENCE (tag 0x30)', () => {
    const { issuerDN } = extractCertInfo(caCertDer);
    expect(issuerDN[0]).toBe(0x30);
    expect(issuerDN.length).toBeGreaterThan(10);
  });

  it('извлича serialNumberDer като INTEGER (tag 0x02)', () => {
    const { serialNumberDer } = extractCertInfo(caCertDer);
    expect(serialNumberDer[0]).toBe(0x02); // INTEGER tag
    expect(serialNumberDer.length).toBeGreaterThan(2);
  });

  it('issuerDN + serialNumberDer правят IssuerAndSerialNumber с правилна дължина', () => {
    const { issuerDN, serialNumberDer } = extractCertInfo(caCertDer);
    // И двете заедно трябва да са < 200 bytes за нашия CA
    expect(issuerDN.length + serialNumberDer.length).toBeLessThan(200);
  });
});

// ─── buildSignedAttrs ─────────────────────────────────────────────────────────

describe('buildSignedAttrs', () => {
  const hash32 = new Uint8Array(32).fill(0xab);

  it('тагът е SET (0x31)', () => {
    const sa = buildSignedAttrs(hash32);
    expect(sa[0]).toBe(0x31);
  });

  it('съдържа contentType OID (1.2.840.113549.1.9.3 → ends 09 03)', () => {
    const sa = buildSignedAttrs(hash32);
    // OID_CONTENT_TYPE последните байтове: 0x09 0x03
    const saHex = Array.from(sa).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(saHex).toContain('0903');
  });

  it('съдържа messageDigest OID (1.2.840.113549.1.9.4 → ends 09 04)', () => {
    const sa = buildSignedAttrs(hash32);
    const saHex = Array.from(sa).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(saHex).toContain('0904');
  });

  it('съдържа всичките 32 hash байта', () => {
    const sa = buildSignedAttrs(hash32);
    // hash32 е всичко 0xab → трябва да се появи като 32 поредни 0xab байта
    const found = sa.some((_, i) =>
      i + 32 <= sa.length && sa.subarray(i, i + 32).every(b => b === 0xab),
    );
    expect(found).toBe(true);
  });

  it('два извиквания с един hash дават еднакъв резултат', () => {
    const a = buildSignedAttrs(hash32);
    const b = buildSignedAttrs(hash32);
    expect(a).toEqual(b);
  });

  it('различен hash → различен резултат', () => {
    const a = buildSignedAttrs(new Uint8Array(32).fill(0x01));
    const b = buildSignedAttrs(new Uint8Array(32).fill(0x02));
    expect(a).not.toEqual(b);
  });
});

// ─── buildCmsDetached ─────────────────────────────────────────────────────────

describe('buildCmsDetached', () => {
  // P1363 подпис (64 байта r||s) — какъвто WebCrypto връща
  const hash32  = new Uint8Array(32).fill(0x01);
  const sig64   = new Uint8Array(64).fill(0x02); // r = [0x02*32], s = [0x02*32]

  it('тагът е SEQUENCE (0x30) — ContentInfo', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    expect(cms[0]).toBe(0x30);
  });

  it('размерът е > 100 байта (смислена структура)', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    expect(cms.length).toBeGreaterThan(100);
  });

  it('размерът е < 4096 байта (в рамките на placeholder)', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    expect(cms.length).toBeLessThan(CONTENTS_PLACEHOLDER_BYTES);
  });

  it('съдържа OID на signedData (2a 86 48 86 f7 0d 01 07 02)', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    const cmsHex = Array.from(cms).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(cmsHex).toContain('2a864886f70d010702');
  });

  it('съдържа ecdsa-with-SHA256 OID (2a 86 48 ce 3d 04 03 02)', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    const cmsHex = Array.from(cms).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(cmsHex).toContain('2a8648ce3d040302');
  });

  it('outer ContentInfo е валиден TLV (tag + length + content)', () => {
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    const { tag, len, contentStart } = parseTlv(cms, 0);
    expect(tag).toBe(0x30);
    expect(contentStart + len).toBe(cms.length);
  });

  it('sig64 r-байтовете присъстват в CMS в DER-кодиран вид', () => {
    // sig64 = r || s, r = [0x02*32], s = [0x02*32]
    // 0x02 & 0x80 = 0 → без 0x00 prefix; DER INTEGER = 02 20 [0x02*32]
    const cms = buildCmsDetached(hash32, sig64, caCertDer);
    const cmsHex = Array.from(cms).map(b => b.toString(16).padStart(2, '0')).join('');
    // r като DER INTEGER: 0220 + 32*"02"
    const rDer = '0220' + '02'.repeat(32);
    expect(cmsHex).toContain(rDer);
  });

  it('с caCertDer chain размерът е по-голям (включва и двата сертификата)', () => {
    const withChain    = buildCmsDetached(hash32, sig64, caCertDer, caCertDer);
    const withoutChain = buildCmsDetached(hash32, sig64, caCertDer);
    expect(withChain.length).toBeGreaterThan(withoutChain.length);
  });
});

// ─── findPattern ─────────────────────────────────────────────────────────────

describe('findPattern', () => {
  it('намира pattern на правилния offset', () => {
    const haystack = new TextEncoder().encode('abcXYZdef');
    const needle   = new TextEncoder().encode('XYZ');
    expect(findPattern(haystack, needle)).toBe(3);
  });

  it('връща -1 при липсващ pattern', () => {
    const haystack = new TextEncoder().encode('abcdef');
    const needle   = new TextEncoder().encode('XYZ');
    expect(findPattern(haystack, needle)).toBe(-1);
  });

  it('работи при pattern в края', () => {
    const haystack = new TextEncoder().encode('abcXYZ');
    const needle   = new TextEncoder().encode('XYZ');
    expect(findPattern(haystack, needle)).toBe(3);
  });
});

// ─── computeByteRanges + hashByteRanges ──────────────────────────────────────

describe('computeByteRanges', () => {
  /**
   * Строим фалшив "PDF" с /Contents <000...000> и /ByteRange placeholder
   * за да тестваме математиката без реален PDF.
   */
  function makeFakePrepared(): PreparedPdf {
    const CONT_HEX_LEN = CONTENTS_PLACEHOLDER_BYTES * 2;
    const prefix  = '/Contents <';      // 11 chars
    const hex     = '0'.repeat(CONT_HEX_LEN);
    const suffix  = '>/ByteRange [0 999999999 999999999 999999999]rest';

    const raw = prefix + hex + suffix;
    const bytes = new TextEncoder().encode(raw);

    // contentsOffset = позиция на '<' = 10 (след '/Contents ')
    const contentsOffset = '/Contents '.length; // = 10, позиция на '<'
    // byteRangeNumOffset = позиция след '[' в '/ByteRange ['
    const afterContents = prefix.length + CONT_HEX_LEN + '>'.length;
    const brHeader = '/ByteRange [';
    const byteRangeNumOffset = afterContents + brHeader.length;

    return { bytes, contentsOffset, byteRangeNumOffset };
  }

  it('byteRange[0] е 0', () => {
    const br = computeByteRanges(makeFakePrepared());
    expect(br[0]).toBe(0);
  });

  it('byteRange[1] е offset на < (= /Contents offset)', () => {
    const prepared = makeFakePrepared();
    const br = computeByteRanges(prepared);
    expect(br[1]).toBe(prepared.contentsOffset);
  });

  it('byteRange[2] е byteRange[1] + CONTENTS_HEX_LENGTH + 2', () => {
    const prepared = makeFakePrepared();
    const br = computeByteRanges(prepared);
    expect(br[2]).toBe(prepared.contentsOffset + CONTENTS_PLACEHOLDER_BYTES * 2 + 2);
  });

  it('byteRange[1] + byteRange[3] + CONTENTS_HEX_LENGTH + 2 = total bytes', () => {
    const prepared = makeFakePrepared();
    const br = computeByteRanges(prepared);
    const total = br[1] + (CONTENTS_PLACEHOLDER_BYTES * 2 + 2) + br[3];
    expect(total).toBe(prepared.bytes.length);
  });
});

describe('hashByteRanges', () => {
  it('хешът е 32 байта', () => {
    const data = new Uint8Array(100).fill(0xaa);
    const br: [number, number, number, number] = [0, 40, 60, 40];
    const h = hashByteRanges(data, br);
    expect(h.length).toBe(32);
  });

  it('детерминиран — два пъти дава същия хеш', () => {
    const data = new Uint8Array(100).fill(0xbb);
    const br: [number, number, number, number] = [0, 30, 70, 30];
    const h1 = hashByteRanges(data, br);
    const h2 = hashByteRanges(data, br);
    expect(h1).toEqual(h2);
  });

  it('различни данни → различен хеш', () => {
    const br: [number, number, number, number] = [0, 30, 70, 30];
    const h1 = hashByteRanges(new Uint8Array(100).fill(0x01), br);
    const h2 = hashByteRanges(new Uint8Array(100).fill(0x02), br);
    expect(h1).not.toEqual(h2);
  });

  it('промяна само в excluded range не влияе на хеша', () => {
    // byteRange[1]=30 → bytes 30..69 са excluded (contents placeholder area)
    const br: [number, number, number, number] = [0, 30, 70, 30];
    const data1 = new Uint8Array(100).fill(0xcc);
    const data2 = new Uint8Array(100).fill(0xcc);
    // Сменяме само excluded зоната (bytes 30..69)
    data2.fill(0xff, 30, 70);
    const h1 = hashByteRanges(data1, br);
    const h2 = hashByteRanges(data2, br);
    expect(h1).toEqual(h2); // excluded → хешовете трябва да съвпадат
  });

  it('промяна в signed range влияе на хеша', () => {
    const br: [number, number, number, number] = [0, 30, 70, 30];
    const data1 = new Uint8Array(100).fill(0xcc);
    const data2 = new Uint8Array(100).fill(0xcc);
    // Сменяме байт в signed zone (byte 5, преди excluded 30..69)
    data2[5] = 0xff;
    const h1 = hashByteRanges(data1, br);
    const h2 = hashByteRanges(data2, br);
    expect(h1).not.toEqual(h2); // signed range → хешовете трябва да се различават
  });
});

// ─── formatPdfDate ────────────────────────────────────────────────────────────

describe('formatPdfDate', () => {
  it('форматира дата в PDF формат D:YYYYMMDDHHmmSSZ', () => {
    const d = new Date('2026-07-08T12:30:45Z');
    expect(formatPdfDate(d)).toBe('D:20260708123045Z');
  });
});
