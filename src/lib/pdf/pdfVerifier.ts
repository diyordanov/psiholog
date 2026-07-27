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
 *   /PostQuantumSignature stream    — ML-DSA-65 JSON (incremental update)
 *   /SubFilter /adbe.pkcs7.detached — идентификатор на нашия подпис
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

// ─── /PostQuantumSignature stream ─────────────────────────────────────────────

/**
 * Извлича /PostQuantumSignature stream от PDF incremental update.
 *
 * Стриймът е raw JSON (без компресия), добавен от injectSignatureAndPQ()
 * в pdfSigner.ts. Намираме го по type marker.
 */
export function extractPqStream(pdfBytes: Uint8Array): PqSignatureData | null {
  const typeMarker = enc.encode('/PostQuantumSignature');
  const pos = findPattern(pdfBytes, typeMarker, 0);
  if (pos === -1) return null;

  // Намираме 'stream\n' или 'stream\r\n' след маркера
  const streamMarker1 = enc.encode('stream\r\n');
  const streamMarker2 = enc.encode('stream\n');
  let streamStart = findPattern(pdfBytes, streamMarker1, pos);
  let streamDataOffset: number;
  if (streamStart !== -1) {
    streamDataOffset = streamStart + streamMarker1.length;
  } else {
    streamStart = findPattern(pdfBytes, streamMarker2, pos);
    if (streamStart === -1) return null;
    streamDataOffset = streamStart + streamMarker2.length;
  }

  // Намираме '\nendstream' след началото
  const endMarker1 = enc.encode('\r\nendstream');
  const endMarker2 = enc.encode('\nendstream');
  let streamEnd = findPattern(pdfBytes, endMarker1, streamDataOffset);
  if (streamEnd === -1) streamEnd = findPattern(pdfBytes, endMarker2, streamDataOffset);
  if (streamEnd === -1) return null;

  const jsonBytes = pdfBytes.slice(streamDataOffset, streamEnd);
  const jsonStr = new TextDecoder().decode(jsonBytes);

  try {
    return JSON.parse(jsonStr) as PqSignatureData;
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
// extractByteRange()/extractCmsDer()/extractSigningDate()/extractPqStream()
// ОСТАВАТ непроменени (single-signer поведение, все още ползвани от
// pdfVerifier.test.ts) — новите функции са добавка, не замяна.

export interface ExtractedSignature {
  /** 0-based, файлов ред = ред на подписване (owner е 0). */
  index:      number;
  byteRange:  [number, number, number, number] | null;
  cmsDer:     Uint8Array | null;
  signedAt:   Date | null;
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
      results.push({ index, byteRange: null, cmsDer: null, signedAt: null });
      return;
    }
    const dictEnd = findDictEnd(pdfBytes, dictStart);

    results.push({
      index,
      byteRange: extractByteRangeBounded(pdfBytes, dictStart, dictEnd),
      cmsDer:    extractCmsDerBounded(pdfBytes, dictStart, dictEnd),
      signedAt:  extractSigningDateBounded(pdfBytes, dictStart, dictEnd),
    });
  });
  return results;
}

/** Резултат от extractAllPqStreams() — асоцииран с конкретен signerIndex. */
export interface ExtractedPqSignature {
  signerIndex: number;
  data:        PqSignatureData;
}

/**
 * Извлича ВСИЧКИ /PostQuantumSignature streams (не само първия — виж bug fix
 * Ден 3: recipients в incremental flow-а нямат PQ, но бъдещ N-PQ сценарий
 * трябва да работи без промяна тук). Асоциация със signerIndex:
 *   - ако JSON payload-ът съдържа `signerIndex` — ползваме го директно
 *   - иначе — позиционен fallback (ред на срещане във файла), coверд текущия
 *     single-signer случай (единствен PQ stream, без signerIndex поле → 0)
 */
export function extractAllPqStreams(pdfBytes: Uint8Array): ExtractedPqSignature[] {
  const typeMarker = enc.encode('/PostQuantumSignature');
  const positions  = findAllOccurrences(pdfBytes, typeMarker);

  const streamMarker1 = enc.encode('stream\r\n');
  const streamMarker2 = enc.encode('stream\n');
  const endMarker1    = enc.encode('\r\nendstream');
  const endMarker2    = enc.encode('\nendstream');

  const results: ExtractedPqSignature[] = [];
  positions.forEach((pos, i) => {
    let streamStart = findPattern(pdfBytes, streamMarker1, pos);
    let streamDataOffset: number;
    if (streamStart !== -1) {
      streamDataOffset = streamStart + streamMarker1.length;
    } else {
      streamStart = findPattern(pdfBytes, streamMarker2, pos);
      if (streamStart === -1) return;
      streamDataOffset = streamStart + streamMarker2.length;
    }

    let streamEnd = findPattern(pdfBytes, endMarker1, streamDataOffset);
    if (streamEnd === -1) streamEnd = findPattern(pdfBytes, endMarker2, streamDataOffset);
    if (streamEnd === -1) return;

    const jsonStr = new TextDecoder().decode(pdfBytes.slice(streamDataOffset, streamEnd));
    try {
      const data = JSON.parse(jsonStr) as PqSignatureData;
      const signerIndex = typeof data.signerIndex === 'number' ? data.signerIndex : i;
      results.push({ signerIndex, data });
    } catch { /* повреден JSON — игнорираме този stream */ }
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
