/**
 * pdfSigner.ts
 * PDF подписване: подготовка, byte range изчисление, инжектиране на подпис.
 *
 * Flow:
 *   1. preparePdfForSigning()  → pdfWithPlaceholder + offsets
 *   2. computeByteRanges()     → [0, A, B, C]
 *   3. hashByteRanges()        → SHA-256 (messageDigest)
 *   4. buildSignedAttrs()      → (от cmsBuilder) — подписва Ed25519
 *   5. buildCmsDetached()      → (от cmsBuilder) — пълен CMS
 *   6. injectSignatureAndPQ()  → финален подписан PDF
 *
 * Забележка: Cyrillic font embedding идва в Ден 2. Ден 1 ползва стандартен Helvetica.
 */
import {
  PDFDocument, PDFName, PDFHexString, PDFString, PDFRef, PDFNumber,
} from 'pdf-lib';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Константи ────────────────────────────────────────────────────────────────

/** Брой байтове, резервирани за CMS подпис в /Contents placeholder. */
export const CONTENTS_PLACEHOLDER_BYTES = 8192;  // ~1.5 KB нужни, ~x5 buffer

const CONTENTS_HEX_LENGTH = CONTENTS_PLACEHOLDER_BYTES * 2; // 16384 hex chars в PDF

/**
 * Placeholder стойности за /ByteRange — точно 9 цифри, заместват се in-place.
 * 999999999 > max expected PDF size (25 MB = ~8 цифри) → достатъчно.
 */
const BR_PLACEHOLDER_NUM  = 999999999;
const BR_PLACEHOLDER_STR  = String(BR_PLACEHOLDER_NUM); // '999999999'

// ─── Типове ───────────────────────────────────────────────────────────────────

export interface PreparedPdf {
  bytes:               Uint8Array; // PDF с placeholders
  contentsOffset:      number;     // byte offset на '<' в /Contents <000...>
  byteRangeNumOffset:  number;     // byte offset на '0 999...' в /ByteRange [...]
}

export interface PqSignatureData {
  algorithm:       string;        // 'ml-dsa-65'
  signedHash:      string;        // base64url на SHA-256 (byte ranges)
  signatureB64url: string;        // base64url на ML-DSA-65 подпис
  publicKeyB64url: string;        // base64url на ML-DSA-65 публичен ключ
  attestation:     unknown;       // JSON attestation от DB (parse-нат обект)
  byteRange:       number[];      // [0, A, B, C]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Търси needle в haystack; връща -1 ако не е намерен. */
export function findPattern(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Форматира Date → PDF date string: D:YYYYMMDDHHmmSSZ */
export function formatPdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Стъпка 1: Подготовка на PDF с placeholders ──────────────────────────────

/**
 * Зарежда PDF, добавя AcroForm + signature widget field с placeholders,
 * и сериализира обратно като bytes.
 *
 * Важно: useObjectStreams: false — необходимо, за да са searchable обектите в raw bytes.
 *
 * @param pdfBytes    Оригинален PDF
 * @param signerName  Показва се в /Name поле на подписа (и визуалния маркер)
 * @param signingDate Датата на подписване
 * @param markerX     X позиция на визуалния маркер в PDF points (default: 30)
 * @param markerY     Y позиция на визуалния маркер в PDF points (default: 30)
 */
export async function preparePdfForSigning(
  pdfBytes: Uint8Array,
  signerName: string,
  signingDate: Date,
  markerX = 30,
  markerY = 30,
): Promise<PreparedPdf> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages  = pdfDoc.getPages();
  const page   = pages[0];
  const ctx    = pdfDoc.context;

  // ── Signature dictionary ref ──
  const sigDictRef  = ctx.nextRef();
  const fieldRef    = ctx.nextRef();

  // ── Signature dictionary с placeholders ──
  // PDFHexString.of(value) записва value директно между < > (без кодиране!).
  // Затова подаваме ВЕЧЕ hex-кодираното съдържание: 16384 ASCII '0' символа.
  // /ByteRange ще съдържа placeholder числа, заменими in-place
  const sigDict = ctx.obj({
    Type:       PDFName.of('Sig'),
    Filter:     PDFName.of('Adobe.PPKLite'),
    SubFilter:  PDFName.of('adbe.pkcs7.detached'),
    ByteRange:  ctx.obj([0, BR_PLACEHOLDER_NUM, BR_PLACEHOLDER_NUM, BR_PLACEHOLDER_NUM]),
    Contents:   PDFHexString.of('0'.repeat(CONTENTS_HEX_LENGTH)),
    Reason:     PDFString.of('SignShield Digital Signature'),
    M:          PDFString.of(formatPdfDate(signingDate)),
    Name:       PDFString.of(signerName),
  });
  ctx.assign(sigDictRef, sigDict);

  // ── Widget annotation (signature form field) ──
  const MARKER_W = 200, MARKER_H = 50;
  const sigField = ctx.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Widget'),
    FT:      PDFName.of('Sig'),
    V:       sigDictRef,
    Rect:    ctx.obj([markerX, markerY, markerX + MARKER_W, markerY + MARKER_H]),
    P:       page.ref,
    T:       PDFString.of('Signature1'),
    F:       PDFNumber.of(4), // Print flag
  });
  ctx.assign(fieldRef, sigField);

  // ── Добавяме field в page /Annots ──
  const pageNode = page.node;
  const existingAnnots = pageNode.get(PDFName.of('Annots'));
  if (existingAnnots && 'push' in existingAnnots) {
    (existingAnnots as { push: (r: PDFRef) => void }).push(fieldRef);
  } else {
    pageNode.set(PDFName.of('Annots'), ctx.obj([fieldRef]));
  }

  // ── AcroForm ──
  const acroFormRef = ctx.nextRef();
  const acroForm = ctx.obj({
    Fields:   ctx.obj([fieldRef]),
    SigFlags: PDFNumber.of(3), // 1=SignaturesExist, 2=AppendOnly
  });
  ctx.assign(acroFormRef, acroForm);
  pdfDoc.catalog.set(PDFName.of('AcroForm'), acroFormRef);

  // ── Serialize: object streams изключени за да са searchable обектите ──
  const saved = await pdfDoc.save({ useObjectStreams: false });
  const bytes = new Uint8Array(saved);

  // ── Намираме /Contents < ──
  const contentsMarker = new TextEncoder().encode('/Contents <');
  const contentsMarkerPos = findPattern(bytes, contentsMarker);
  if (contentsMarkerPos === -1) {
    throw new Error('PDF подготовка: /Contents placeholder не е намерен след serialize');
  }
  // '<' е последният символ в маркера
  const contentsOffset = contentsMarkerPos + contentsMarker.length - 1;

  // ── Намираме /ByteRange [ ... ] placeholder ──
  // Търсим конкретния placeholder: `0 999999999 999999999 999999999`
  const brMarker = new TextEncoder().encode('/ByteRange [');
  const brMarkerPos = findPattern(bytes, brMarker);
  if (brMarkerPos === -1) {
    throw new Error('PDF подготовка: /ByteRange placeholder не е намерен след serialize');
  }
  // Числата започват след '[': offset = brMarkerPos + '/ByteRange ['.length
  const byteRangeNumOffset = brMarkerPos + brMarker.length;

  return { bytes, contentsOffset, byteRangeNumOffset };
}

// ─── Стъпка 2: Изчисляване на byte range ─────────────────────────────────────

/**
 * Изчислява /ByteRange стойностите от подготвения PDF.
 *
 * ByteRange = [0, A, B, C] където:
 *   - A = offset на '<' в /Contents (bytes 0..A-1 са подписани)
 *   - B = A + CONTENTS_HEX_LENGTH + 2 (байтът след '>')
 *   - C = total_length - B (останалата дължина до края)
 */
export function computeByteRanges(
  prepared: PreparedPdf,
): [number, number, number, number] {
  const A = prepared.contentsOffset;          // позиция на '<'
  const B = A + CONTENTS_HEX_LENGTH + 2;     // +2 за '<' и '>'
  const C = prepared.bytes.length - B;
  return [0, A, B, C];
}

// ─── Стъпка 2б: Patch на реалния /ByteRange ПРЕДИ хеширане ──────────────────

/**
 * Записва реалните ByteRange стойности в prepared.bytes IN-PLACE.
 *
 * ВАЖНО: трябва да се извика ПРЕДИ hashByteRanges(), защото /ByteRange полето
 * е в подписания диапазон [0..A-1]. Ако хешираме с placeholder стойности
 * (999999999), подписът никога няма да верифицира в Adobe Reader.
 */
export function patchByteRangeInPlace(
  prepared: PreparedPdf,
  byteRange: [number, number, number, number],
): void {
  const [, A, B, C] = byteRange;

  // Намираме затварящото ] за да знаем точната дължина на вътрешното съдържание.
  // pdf-lib пише масиви като `[ 0 999999999 ... 999999999 ]` (интервали около числата),
  // така inner length ≠ 31 (стойностите). Трябва да запишем ТОЧНО толкова символа.
  let closeBracket = prepared.byteRangeNumOffset;
  while (closeBracket < prepared.bytes.length && prepared.bytes[closeBracket] !== 0x5d) {
    closeBracket++;
  }
  const innerLen = closeBracket - prepared.byteRangeNumOffset;

  // " 0 A B C" padded с trailing spaces до точно innerLen символа
  const newBR = ` 0 ${A} ${B} ${C}`.padEnd(innerLen, ' ');
  prepared.bytes.set(new TextEncoder().encode(newBR), prepared.byteRangeNumOffset);
}

// ─── Стъпка 3: SHA-256 на byte range ─────────────────────────────────────────

/**
 * Изчислява SHA-256 хеш на байтовете от byte range.
 * messageDigest = SHA-256( bytes[0..A-1] + bytes[B..B+C-1] )
 */
export function hashByteRanges(
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
): Uint8Array {
  const [, A, B, C] = byteRange;
  // Конкатенираме двата диапазона в един буфер и хешираме
  const toHash = new Uint8Array(A + C);
  toHash.set(pdfBytes.subarray(0, A), 0);
  toHash.set(pdfBytes.subarray(B, B + C), A);
  return sha256(toHash);
}

// ─── Стъпка 4: Инжектиране на подпис ─────────────────────────────────────────

/**
 * Инжектира CMS подпис в /Contents placeholder и обновява /ByteRange.
 * Добавя /PostQuantumSignature stream като incremental update.
 *
 * @param prepared    Резултат от preparePdfForSigning()
 * @param byteRange   Резултат от computeByteRanges()
 * @param cmsDer      CMS ContentInfo DER (от buildCmsDetached())
 * @param pqData      ML-DSA-65 данни за /PostQuantumSignature
 */
export function injectSignatureAndPQ(
  prepared: PreparedPdf,
  byteRange: [number, number, number, number],
  cmsDer: Uint8Array,
  pqData: PqSignatureData,
): Uint8Array {
  if (cmsDer.length > CONTENTS_PLACEHOLDER_BYTES) {
    throw new Error(
      `CMS (${cmsDer.length} bytes) надвишава placeholder (${CONTENTS_PLACEHOLDER_BYTES} bytes)`,
    );
  }

  const result = new Uint8Array(prepared.bytes); // копие

  // 1. Инжектираме CMS hex в /Contents (след '<')
  const cmsHex = bytesToHex(cmsDer).toUpperCase().padEnd(CONTENTS_HEX_LENGTH, '0');
  const hexBytes = new TextEncoder().encode(cmsHex);
  result.set(hexBytes, prepared.contentsOffset + 1); // +1 прескача '<'

  // 2. /ByteRange е вече patch-нат от patchByteRangeInPlace() (задължително преди хеширане).
  // result е копие на prepared.bytes, което вече съдържа реалните ByteRange стойности.
  // Нищо допълнително не е нужно тук.

  // 3. /PostQuantumSignature като incremental update в края на PDF
  const pqJsonStr = JSON.stringify({ ...pqData, byteRange });
  const pqJsonBytes = new TextEncoder().encode(pqJsonStr);

  const pqUpdate = buildPqIncrementalUpdate(result, pqJsonBytes);

  // Конкатенираме подписания PDF с PQ incremental update
  const finalPdf = new Uint8Array(result.length + pqUpdate.length);
  finalPdf.set(result, 0);
  finalPdf.set(pqUpdate, result.length);
  return finalPdf;
}

// ─── /PostQuantumSignature incremental update ─────────────────────────────────

/**
 * Добавя /PostQuantumSignature stream като минимален PDF incremental update.
 * Adobe Reader игнорира непознатите ключове в catalog — обновлението е "read-safe".
 *
 * Структура (raw PDF текст):
 *   [N 0 obj] stream съдържа PQ JSON [endobj]
 *   xref table
 *   trailer с /Prev → старото startxref
 *   startxref → новото xref
 */
function buildPqIncrementalUpdate(signedPdf: Uint8Array, pqJsonBytes: Uint8Array): Uint8Array {
  const prevXref   = findStartXref(signedPdf);
  const nextObjNum = findHighestObjectNumber(signedPdf) + 1;
  const streamLen  = pqJsonBytes.length;

  // objHeader started with \n — обектът започва 1 байт след updateOffset
  const updateOffset = signedPdf.length;
  const objHeader    = `\n${nextObjNum} 0 obj\n<< /Type /PostQuantumSignature /Length ${streamLen} >>\nstream\n`;
  const objFooter    = `\nendstream\nendobj\n`;
  const objHeaderBytes = new TextEncoder().encode(objHeader);
  const objFooterBytes = new TextEncoder().encode(objFooter);

  // Bug fix #1: обектът е на updateOffset+1 (след водещото \n в objHeader)
  const objOffsetStr = String(updateOffset + 1).padStart(10, '0');

  // xref block: започва на updateOffset + всички байтове преди него
  // Bug fix #3: xrefKeyword е на xrefBlockStart + 1 (след водещото \n в xref стринга)
  const xrefBlockStart = updateOffset + objHeaderBytes.length + streamLen + objFooterBytes.length;
  const xrefKeyword    = xrefBlockStart + 1; // +1 за водещото \n

  const xref = `\nxref\n${nextObjNum} 1\n${objOffsetStr} 00000 n \n`;

  // Bug fix #2: /Root е reference, не масив — без квадратни скоби
  // Bug fix #3: startxref сочи на "xref" keyword, не след xref таблицата
  const trailer = `trailer\n<< /Size ${nextObjNum + 1} /Root ${findCatalogRef(signedPdf)} /Prev ${prevXref} >>\nstartxref\n${xrefKeyword}\n%%EOF\n`;

  const xrefBytes    = new TextEncoder().encode(xref);
  const trailerBytes = new TextEncoder().encode(trailer);

  const total = new Uint8Array(
    objHeaderBytes.length + streamLen + objFooterBytes.length +
    xrefBytes.length + trailerBytes.length,
  );
  let pos = 0;
  total.set(objHeaderBytes, pos); pos += objHeaderBytes.length;
  total.set(pqJsonBytes, pos);    pos += streamLen;
  total.set(objFooterBytes, pos); pos += objFooterBytes.length;
  total.set(xrefBytes, pos);      pos += xrefBytes.length;
  total.set(trailerBytes, pos);

  return total;
}

/** Чете startxref стойността от края на PDF. */
function findStartXref(pdfBytes: Uint8Array): number {
  // Търсим 'startxref' в последните 256 байта
  const tail = pdfBytes.slice(Math.max(0, pdfBytes.length - 256));
  const text = new TextDecoder().decode(tail);
  const m = text.match(/startxref\s+(\d+)\s+%%EOF/);
  return m ? parseInt(m[1]) : 0;
}

/** Намира catalog ref (Root) от trailer на PDF. */
function findCatalogRef(pdfBytes: Uint8Array): string {
  const tail = new TextDecoder().decode(pdfBytes.slice(Math.max(0, pdfBytes.length - 512)));
  const m = tail.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  return m ? m[1] : '1 0 R';
}

/** Намира най-високия обект номер от xref таблицата. */
function findHighestObjectNumber(pdfBytes: Uint8Array): number {
  // Търсим 'xref' блок — Size стойността е N (total objects)
  const text = new TextDecoder().decode(pdfBytes.slice(Math.max(0, pdfBytes.length - 512)));
  const m = text.match(/\/Size\s+(\d+)/);
  return m ? parseInt(m[1]) - 1 : 100;
}

// ─── Публично помощно API ─────────────────────────────────────────────────────

/** Конвертира Uint8Array → base64url за PQ JSON payload. */
export function encodeBase64url(bytes: Uint8Array): string {
  return toBase64url(bytes);
}
