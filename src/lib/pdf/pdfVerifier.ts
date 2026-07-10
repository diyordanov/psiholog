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

import { findPattern, hashByteRanges } from './pdfSigner';
import type { PqSignatureData } from './pdfSigner';

const enc = new TextEncoder();

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

// ─── /Contents (CMS DER) ─────────────────────────────────────────────────────

/**
 * Извлича CMS DER bytes от /Contents <hex> полето на PDF.
 *
 * PDF записва подписа като hex string в /Contents <HEX...>.
 * Нулевите байтове в края са padding (placeholder overflow) — те са
 * очаквани; Adobe Reader също ги игнорира при верификация.
 */
export function extractCmsDer(pdfBytes: Uint8Array): Uint8Array | null {
  const marker = enc.encode('/Contents <');
  const pos = findPattern(pdfBytes, marker, 0);
  if (pos === -1) return null;

  // '<' е последният символ на маркера; hex started right after
  let i = pos + marker.length; // позиция на първия hex символ

  const hexChars: number[] = [];
  while (i < pdfBytes.length && pdfBytes[i] !== 0x3e) { // '>'
    hexChars.push(pdfBytes[i]);
    i++;
  }

  // Конвертираме hex → bytes
  const hexStr = String.fromCharCode(...hexChars).toLowerCase();
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let j = 0; j < bytes.length; j++) {
    bytes[j] = parseInt(hexStr.slice(j * 2, j * 2 + 2), 16);
  }

  // Намираме реалния CMS: trim trailing zeros (padding)
  // CMS started with 0x30 (SEQUENCE tag); trim trailing 0x00 bytes
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
