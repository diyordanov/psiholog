/**
 * pdfVerifier.ts
 * Извлича данни за подпис от подписан PDF чрез raw byte scanning.
 *
 * Подход: raw bytes (не pdf-lib object model), защото:
 *   1. pdf-lib няма high-level signature API
 *   2. Структурата е детерминирана — ние сме я построили в pdfSigner.ts
 *   3. По-просто и по-бързо за конкретния ни формат
 *
 * Формат (от pdfSigner.ts):
 *   /ByteRange [ 0 A B C ]          — подписаните диапазони
 *   /Contents <hex...>              — CMS DER bytes (hex-encoded)
 *   /PQSignature <hex...>           — ML-DSA-65 JSON (hex-encoded, СЪЩИЯ /Sig dict — bugfix 2026-07-31)
 *   /SubFilter /adbe.pkcs7.detached — идентификатор на нашия подпис
 *
 * BUGFIX (2026-07-31): /PQSignature преди беше ОТДЕЛЕН incremental update
 * СЛЕД подписа (виж git history), асоцииран с конкретен /Sig чрез
 * `signerIndex` поле в JSON payload-а — цял клас бъгове (PQ данни, свързани
 * с грешния подписващ при наличие на чужди /Type /Sig обекти във файла,
 * виж Ден 6 hotfix v8), и допълнително причиняваше Adobe Acrobat да маркира
 * подписите като "invalid: Document has been altered or corrupted" (байтове
 * СЛЕД декларирания /ByteRange на последния подписващ). Сега /PQSignature
 * живее В СЪЩИЯ /Sig dict, вътре в ОБЩИЯ изключен /ByteRange диапазон —
 * извлича се bounded, directly paired с неговия /Sig, БЕЗ нужда от индекс.
 */

import { findPattern, hashByteRanges, findDictEnd } from './pdfSigner';
import type { PqSignatureData } from './pdfSigner';

const enc = new TextEncoder();

// ─── Общи helpers за multi-occurrence сканиране (Ден 3: N подписа) ────────────

/** Всички срещания на needle в bytes, във файлов ред (ascending). */
function findAllOccurrences(bytes: Uint8Array, needle: Uint8Array): number[] {
  const out: number[] = [];
  let pos = findPattern(bytes, needle, 0);
  while (pos !== -1) { out.push(pos); pos = findPattern(bytes, needle, pos + 1); }
  return out;
}

/** Последното срещане на needle СТРОГО преди limit (или -1). */
function findLastBefore(bytes: Uint8Array, needle: Uint8Array, limit: number): number {
  let last = -1;
  let pos = findPattern(bytes, needle, 0);
  while (pos !== -1 && pos < limit) { last = pos; pos = findPattern(bytes, needle, pos + 1); }
  return last;
}

// ─── ByteRange ────────────────────────────────────────────────────────────────

/**
 * Извлича /ByteRange [ 0 A B C ] от PDF.
 * Връща null ако не е намерен (PDF без подпис).
 *
 * Парсира се последният ByteRange в файла — при incremental update
 * последният е актуалният.
 */
export function extractByteRange(
  pdfBytes: Uint8Array,
): [number, number, number, number] | null {
  const marker = enc.encode('/ByteRange [');
  // Намираме последното срещане (може да има incremental update след оригинала)
  let pos = -1;
  let found = findPattern(pdfBytes, marker, 0);
  while (found !== -1) {
    pos = found;
    found = findPattern(pdfBytes, marker, found + 1);
  }
  if (pos === -1) return null;

  // Парсираме 4 числа след '['
  let i = pos + marker.length;
  const nums: number[] = [];
  while (nums.length < 4 && i < pdfBytes.length) {
    // прескачаме whitespace
    while (i < pdfBytes.length && (pdfBytes[i] === 0x20 || pdfBytes[i] === 0x0a || pdfBytes[i] === 0x0d)) i++;
    if (pdfBytes[i] === 0x5d) break; // ']'
    // четем число
    let n = 0;
    let hasDigit = false;
    while (i < pdfBytes.length && pdfBytes[i] >= 0x30 && pdfBytes[i] <= 0x39) {
      n = n * 10 + (pdfBytes[i] - 0x30);
      i++;
      hasDigit = true;
    }
    if (hasDigit) nums.push(n);
  }

  if (nums.length !== 4) return null;
  return nums as [number, number, number, number];
}

/** Като extractByteRange(), но търси FIRST match в диапазона [from, to). */
function extractByteRangeBounded(
  pdfBytes: Uint8Array, from: number, to: number,
): [number, number, number, number] | null {
  const marker = enc.encode('/ByteRange [');
  const pos = findPattern(pdfBytes, marker, from);
  if (pos === -1 || pos >= to) return null;

  let i = pos + marker.length;
  const nums: number[] = [];
  while (nums.length < 4 && i < to) {
    while (i < to && (pdfBytes[i] === 0x20 || pdfBytes[i] === 0x0a || pdfBytes[i] === 0x0d)) i++;
    if (pdfBytes[i] === 0x5d) break;
    let n = 0;
    let hasDigit = false;
    while (i < to && pdfBytes[i] >= 0x30 && pdfBytes[i] <= 0x39) {
      n = n * 10 + (pdfBytes[i] - 0x30);
      i++;
      hasDigit = true;
    }
    if (hasDigit) nums.push(n);
  }
  if (nums.length !== 4) return null;
  return nums as [number, number, number, number];
}

// ─── /Contents (CMS DER) ─────────────────────────────────────────────────────

/**
 * Извлича CMS DER bytes от /Contents <hex> полето на PDF.
 *
 * PDF записва подписа като hex string в /Contents <HEX...>.
 * Нулевите байтове в края са padding (placeholder overflow) — те са
 * очаквани; Adobe Reader също ги игнорира при верификация.
 */
/** Converts a single hex ASCII byte code to its numeric value (0–15). */
function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return 0;
}

/**
 * Извлича CMS DER bytes от /Contents <hex> полето на PDF.
 *
 * PDF записва подписа като hex string в /Contents <HEX...>.
 * Нулевите байтове в края са padding (placeholder overflow) — те са
 * очаквани; Adobe Reader също ги игнорира при верификация.
 *
 * Взимаме ПОСЛЕДНОТО /Contents < — подписът е добавен накрая; оригиналният
 * PDF може да съдържа /Contents < в binary потоци (шрифтове, изображения)
 * и намирането на грешно срещане би върнало корупирани данни или взривило
 * стека чрез String.fromCharCode(...гигантски_масив).
 */
export function extractCmsDer(pdfBytes: Uint8Array): Uint8Array | null {
  const marker = enc.encode('/Contents <');

  // Намираме ПОСЛЕДНОТО срещане — подписът е добавен накрая на PDF-а
  let pos = -1;
  let found = findPattern(pdfBytes, marker, 0);
  while (found !== -1) {
    pos = found;
    found = findPattern(pdfBytes, marker, found + 1);
  }
  if (pos === -1) return null;

  // Hex данните започват веднага след маркера
  const hexStart = pos + marker.length;

  // Намираме затварящото '>'
  let hexEnd = hexStart;
  while (hexEnd < pdfBytes.length && pdfBytes[hexEnd] !== 0x3e) hexEnd++;
  if (hexEnd >= pdfBytes.length) return null;

  const hexLen = hexEnd - hexStart;

  // Декодираме hex директно от байтовете — без String.fromCharCode spread,
  // което би взривило call stack при масив с милиони елементи.
  const bytes = new Uint8Array(hexLen >> 1);
  for (let j = 0; j < bytes.length; j++) {
    bytes[j] = (hexNibble(pdfBytes[hexStart + j * 2]) << 4)
              | hexNibble(pdfBytes[hexStart + j * 2 + 1]);
  }

  // Намираме реалния CMS: trim trailing zeros (padding)
  // CMS started with 0x30 (SEQUENCE tag); trim trailing 0x00 bytes
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end--;
  if (end === 0 || bytes[0] !== 0x30) return null;

  return bytes.slice(0, end);
}

/** Като extractCmsDer(), но търси FIRST match в диапазона [from, to). */
function extractCmsDerBounded(pdfBytes: Uint8Array, from: number, to: number): Uint8Array | null {
  const marker = enc.encode('/Contents <');
  const pos = findPattern(pdfBytes, marker, from);
  if (pos === -1 || pos >= to) return null;

  const hexStart = pos + marker.length;
  let hexEnd = hexStart;
  while (hexEnd < to && pdfBytes[hexEnd] !== 0x3e) hexEnd++;
  if (hexEnd >= to) return null;

  const hexLen = hexEnd - hexStart;
  const bytes = new Uint8Array(hexLen >> 1);
  for (let j = 0; j < bytes.length; j++) {
    bytes[j] = (hexNibble(pdfBytes[hexStart + j * 2]) << 4)
              | hexNibble(pdfBytes[hexStart + j * 2 + 1]);
  }

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end--;
  if (end === 0 || bytes[0] !== 0x30) return null;

  return bytes.slice(0, end);
}

// ─── /PQSignature (СЪЩИЯ /Sig dict) ────────────────────────────────────────────

/**
 * Извлича ML-DSA-65 PQ JSON payload от /PQSignature <hex> поле — bounded в
 * границите [from, to) на КОНКРЕТЕН /Sig dict (виж bugfix 2026-07-31:
 * /PQSignature вече живее В СЪЩИЯ /Sig dict, директно до /Contents, вместо
 * като отделен incremental stream, асоцииран чрез signerIndex).
 *
 * Hex-декодиране + trim на trailing zero padding — идентичен подход на
 * extractCmsDerBounded(), но резултатът е UTF-8 JSON текст, не binary DER.
 */
function extractPqDataBounded(pdfBytes: Uint8Array, from: number, to: number): PqSignatureData | null {
  const marker = enc.encode('/PQSignature <');
  const pos = findPattern(pdfBytes, marker, from);
  if (pos === -1 || pos >= to) return null;

  const hexStart = pos + marker.length;
  let hexEnd = hexStart;
  while (hexEnd < to && pdfBytes[hexEnd] !== 0x3e) hexEnd++;
  if (hexEnd >= to) return null;

  const hexLen = hexEnd - hexStart;
  const bytes = new Uint8Array(hexLen >> 1);
  for (let j = 0; j < bytes.length; j++) {
    bytes[j] = (hexNibble(pdfBytes[hexStart + j * 2]) << 4)
              | hexNibble(pdfBytes[hexStart + j * 2 + 1]);
  }

  // Trailing zero-byte padding (placeholder overflow) — trim преди JSON.parse.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end--;
  if (end === 0) return null;

  try {
    return JSON.parse(new TextDecoder().decode(bytes.slice(0, end))) as PqSignatureData;
  } catch {
    return null;
  }
}

// ─── /M (signing date) ────────────────────────────────────────────────────────

/**
 * Извлича датата на подписване от /M поле в signature dictionary.
 * Формат: D:YYYYMMDDHHmmSSZ
 */
export function extractSigningDate(pdfBytes: Uint8Array): Date | null {
  const marker = enc.encode('/M (D:');
  const pos = findPattern(pdfBytes, marker, 0);
  if (pos === -1) return null;

  let i = pos + marker.length;
  const dateChars: number[] = [];
  while (i < pdfBytes.length && pdfBytes[i] !== 0x29) { // ')'
    dateChars.push(pdfBytes[i]);
    i++;
  }
  const dateStr = String.fromCharCode(...dateChars); // YYYYMMDDHHmmSSZ
  if (dateStr.length < 14) return null;

  const y  = parseInt(dateStr.slice(0, 4));
  const mo = parseInt(dateStr.slice(4, 6)) - 1;
  const d  = parseInt(dateStr.slice(6, 8));
  const h  = parseInt(dateStr.slice(8, 10));
  const mi = parseInt(dateStr.slice(10, 12));
  const s  = parseInt(dateStr.slice(12, 14));
  const dt = new Date(Date.UTC(y, mo, d, h, mi, s));
  return isNaN(dt.getTime()) ? null : dt;
}

/** Като extractSigningDate(), но търси FIRST match в диапазона [from, to). */
function extractSigningDateBounded(pdfBytes: Uint8Array, from: number, to: number): Date | null {
  const marker = enc.encode('/M (D:');
  const pos = findPattern(pdfBytes, marker, from);
  if (pos === -1 || pos >= to) return null;

  let i = pos + marker.length;
  const dateChars: number[] = [];
  while (i < to && pdfBytes[i] !== 0x29) {
    dateChars.push(pdfBytes[i]);
    i++;
  }
  const dateStr = String.fromCharCode(...dateChars);
  if (dateStr.length < 14) return null;

  const y  = parseInt(dateStr.slice(0, 4));
  const mo = parseInt(dateStr.slice(4, 6)) - 1;
  const d  = parseInt(dateStr.slice(6, 8));
  const h  = parseInt(dateStr.slice(8, 10));
  const mi = parseInt(dateStr.slice(10, 12));
  const s  = parseInt(dateStr.slice(12, 14));
  const dt = new Date(Date.UTC(y, mo, d, h, mi, s));
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── N подписа (Ден 3: verify pipeline generalize) ────────────────────────────
//
// Всеки /Sig обект е самостоятелен dictionary (без nested << >>, виж
// pdfSigner.ts) — намираме всичките чрез /Type /Sig marker occurrences (файлов
// ред = ред на подписване, owner пръв), после за всеки locate-ваме dict
// границите (backward до най-близкото предхождащо '<<', forward чрез
// findDictEnd — балансиран << >> scan, споделен с pdfSigner.ts) и extract-ваме
// /ByteRange, /Contents, /M В РАМКИТЕ на този dict (bounded вариант на
// съществуващите single-shot extract функции по-горе).
//
// extractByteRange()/extractCmsDer()/extractSigningDate() ОСТАВАТ непроменени
// (single-signer поведение, все още ползвани от pdfVerifier.test.ts) — новите
// функции са добавка, не замяна.

export interface ExtractedSignature {
  /** 0-based, файлов ред = ред на подписване (owner е 0). */
  index:      number;
  byteRange:  [number, number, number, number] | null;
  cmsDer:     Uint8Array | null;
  signedAt:   Date | null;
  /** ML-DSA-65 PQ данни от /PQSignature В СЪЩИЯ /Sig dict, или null ако липсва. */
  pqData:     PqSignatureData | null;
}

/** Брой /Type /Sig обекта във файла (0 = наистина unsigned, >0 но без extractAllSignatures резултати = поврежден подпис). */
export function countSignatureMarkers(pdfBytes: Uint8Array): number {
  return findAllOccurrences(pdfBytes, enc.encode('/Type /Sig')).length;
}

/**
 * Извлича byteRange/cmsDer/signedAt за ВСЕКИ /Sig обект във файла (не само
 * последния). Никога не пропуска намерен /Type /Sig marker — при повреден
 * dict (липсващ /ByteRange или /Contents) все пак връща запис с null полета,
 * за да verifyService да покаже конкретния подписващ като invalid, вместо
 * тихо да го изпусне от резултата.
 */
export function extractAllSignatures(pdfBytes: Uint8Array): ExtractedSignature[] {
  const sigTypeMarker = enc.encode('/Type /Sig');
  const openMarker     = enc.encode('<<');
  const positions = findAllOccurrences(pdfBytes, sigTypeMarker);

  const results: ExtractedSignature[] = [];
  positions.forEach((sigPos, index) => {
    const dictStart = findLastBefore(pdfBytes, openMarker, sigPos);
    if (dictStart === -1) {
      results.push({ index, byteRange: null, cmsDer: null, signedAt: null, pqData: null });
      return;
    }
    const dictEnd = findDictEnd(pdfBytes, dictStart);

    results.push({
      index,
      byteRange: extractByteRangeBounded(pdfBytes, dictStart, dictEnd),
      cmsDer:    extractCmsDerBounded(pdfBytes, dictStart, dictEnd),
      signedAt:  extractSigningDateBounded(pdfBytes, dictStart, dictEnd),
      pqData:    extractPqDataBounded(pdfBytes, dictStart, dictEnd),
    });
  });
  return results;
}

// ─── Hash of signed bytes ─────────────────────────────────────────────────────

/**
 * Изчислява SHA-256 на подписаните байтове (ByteRange диапазони).
 * Wrapper около hashByteRanges() от pdfSigner.ts.
 */
export function computeSignedHash(
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
): Uint8Array {
  return hashByteRanges(pdfBytes, byteRange);
}

/** Uint8Array → hex string за display. */
export function bytesToHexStr(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** base64url → Uint8Array */
export function decodeBase64url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
