/**
 * pdfSigner.ts
 * PDF подписване: подготовка, byte range изчисление, инжектиране на подпис.
 *
 * Flow:
 *   1. preparePdfForSigning()  → pdfWithPlaceholder + offsets
 *   2. computeByteRanges()     → [0, A, B, C]
 *   3. hashByteRanges()        → SHA-256 (messageDigest)
 *   4. buildSignedAttrs()      → (от cmsBuilder) — подписва ECDSA P-256
 *   5. buildCmsDetached()      → (от cmsBuilder) — пълен CMS
 *   6. injectSignatureAndPQ()  → финален подписан PDF
 */
import {
  PDFDocument, PDFName, PDFHexString, PDFString, PDFRef, PDFNumber, rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildCidFontSubset, encodeCidHexString, buildWidthsArray } from './cidFont';

// ─── Константи ────────────────────────────────────────────────────────────────

/** Брой байтове, резервирани за CMS подпис в /Contents placeholder. */
export const CONTENTS_PLACEHOLDER_BYTES = 8192;  // ~1.5 KB нужни, ~x5 buffer

const CONTENTS_HEX_LENGTH = CONTENTS_PLACEHOLDER_BYTES * 2; // 16384 hex chars в PDF

/**
 * Placeholder стойности за /ByteRange — точно 9 цифри, заместват се in-place.
 * 999999999 > max expected PDF size (25 MB = ~8 цифри) → достатъчно.
 */
const BR_PLACEHOLDER_NUM  = 999999999;

// ─── Типове ───────────────────────────────────────────────────────────────────

/** Опции за preparePdfForSigning(). */
export interface SignOptions {
  /** X позиция на маркера в PDF points (default: 30). */
  markerX?: number;
  /** Y позиция на маркера в PDF points (default: 30). */
  markerY?: number;
  /** 0-indexed страница за маркера (default: 0). */
  pageIndex?: number;
  /** TTF байтове на NotoSans (или друг Unicode шрифт) за Кирилица; ако липсват — маркер без текст. */
  fontBytes?: Uint8Array;
  /** Ширина на маркера в PDF points (default: 200) — виж markerLayout.ts за auto-layout изчисление при N подписващи. */
  markerWidth?: number;
  /** Височина на маркера в PDF points (default: 50) — текстът е закотвен към горния край, ако е по-висока от 50pt остава празно място отдолу. */
  markerHeight?: number;
}

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
  /**
   * 0-based индекс на подписващия (file order), за N-signer PQ асоцииране
   * (Ден 3 verify pipeline). Опционален — липсва при единичен ECDSA+PQ подпис
   * (single-signer flow), verifyService асоциира позиционно (index 0) в този случай.
   */
  signerIndex?:    number;
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

/** Форматира Date → Bulgarian display string: ДД.ММ.ГГГГ г. */
function formatDisplayDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth()+1)}.${d.getUTCFullYear()} г.`;
}

function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Записва CMS DER hex в /Contents placeholder-а IN-PLACE (uppercase hex,
 * padded с нули до CONTENTS_HEX_LENGTH). Споделена между injectSignatureAndPQ
 * (единичен подпис) и injectIncrementalSignature (N-ти подпис).
 */
function fillContentsPlaceholder(bytes: Uint8Array, contentsOffset: number, cmsDer: Uint8Array): void {
  if (cmsDer.length > CONTENTS_PLACEHOLDER_BYTES) {
    throw new Error(
      `CMS (${cmsDer.length} bytes) надвишава placeholder (${CONTENTS_PLACEHOLDER_BYTES} bytes)`,
    );
  }
  const cmsHex = bytesToHex(cmsDer).toUpperCase().padEnd(CONTENTS_HEX_LENGTH, '0');
  const hexBytes = new TextEncoder().encode(cmsHex);
  bytes.set(hexBytes, contentsOffset + 1); // +1 прескача '<'
}

// ─── Стъпка 1: Подготовка на PDF с placeholders ──────────────────────────────

/**
 * Зарежда PDF, добавя AcroForm + signature widget field с placeholders,
 * рисува визуален маркер (с Кирилица ако fontBytes е подаден),
 * и сериализира обратно като bytes.
 *
 * Важно: useObjectStreams: false — необходимо, за да са searchable обектите в raw bytes.
 *
 * @param pdfBytes    Оригинален PDF
 * @param signerName  Показва се в /Name поле на подписа (и визуалния маркер)
 * @param signingDate Датата на подписване
 * @param options     Позиция на маркер, страница, и шрифт за Кирилица
 */
export async function preparePdfForSigning(
  pdfBytes: Uint8Array,
  signerName: string,
  signingDate: Date,
  options: SignOptions = {},
): Promise<PreparedPdf> {
  const {
    markerX = 30,
    markerY = 30,
    pageIndex = 0,
    fontBytes,
    markerWidth: MARKER_W = 200,
    markerHeight: MARKER_H = 50,
  } = options;

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  pdfDoc.registerFontkit(fontkit);
  const pages  = pdfDoc.getPages();
  const pageIdx = Math.min(pageIndex, pages.length - 1);
  const page   = pages[pageIdx];
  const ctx    = pdfDoc.context;

  // ── Визуален маркер (рисуван върху страницата, включен в подписаните байтове) ──
  if (fontBytes) {
    const font = await pdfDoc.embedFont(fontBytes);

    // Фон + рамка
    page.drawRectangle({
      x: markerX, y: markerY,
      width: MARKER_W, height: MARKER_H,
      color: rgb(0.94, 0.94, 0.98),
      borderColor: rgb(0.25, 0.25, 0.70),
      borderWidth: 0.5,
    });

    // Заглавие
    page.drawText('Подписан цифрово', {
      x: markerX + 5, y: markerY + MARKER_H - 13,
      size: 8, font,
      color: rgb(0.15, 0.15, 0.60),
    });
    // Подписващ
    page.drawText(signerName, {
      x: markerX + 5, y: markerY + MARKER_H - 25,
      size: 8, font,
      color: rgb(0, 0, 0),
    });
    // Дата
    page.drawText(formatDisplayDate(signingDate), {
      x: markerX + 5, y: markerY + MARKER_H - 37,
      size: 7, font,
      color: rgb(0.3, 0.3, 0.3),
    });
    // Алгоритъм
    page.drawText('ECDSA P-256 · ML-DSA-65', {
      x: markerX + 5, y: markerY + MARKER_H - 47,
      size: 6, font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

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
    // PDFHexString.fromText() кодира UTF-16BE + BOM (PDF spec 1.7 §7.9.2.2) —
    // PDFString.of() ползва PDFDocEncoding, което чупи кирилица (виж bugfix 2026-07-19).
    Reason:      PDFHexString.fromText('SignShield Digital Signature'),
    M:           PDFString.of(formatPdfDate(signingDate)), // дата, не Unicode текст
    Name:        PDFHexString.fromText(signerName),
    Location:    PDFHexString.fromText('SignShield Platform'),
    ContactInfo: PDFHexString.fromText('psiholog.pages.dev'),
  });
  ctx.assign(sigDictRef, sigDict);

  // ── Widget annotation (signature form field) ──
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

  // ── Намираме НАШИЯ sig обект по object number (sigDictRef), НЕ първото
  // срещане на /Contents</ByteRange в целия файл ──
  //
  // BUGFIX (открит при live тест, 2026-07-29): ако ИЗТОЧНИКЪТ на документа
  // вече съдържа СВОЙ собствен /Contents/<...>/ или /ByteRange [...] (напр.
  // потребителят е качил PDF, който преди това е бил отворен/частично
  // подписан в Adobe Acrobat Reader и има leftover placeholder signature
  // field) — findPattern(bytes, '/Contents <') от начало на файла намира
  // ЧУЖДИЯ placeholder ПЪРВИ, вместо нашия. patchByteRangeInPlace() после
  // пише в грешно място — нашият SIGNATURE ОБЕКТ остава завинаги
  // непопълнен (/ByteRange все още 999999999, /Contents все още нули),
  // докато чуждият обект бива тихо презаписан. Резултат: "invalid" подпис,
  // фантомен допълнителен "подписващ" при verify (виж bug report).
  //
  // Fix: първо намираме нашия sig обект по '\nN 0 obj' (N = sigDictRef.objectNumber,
  // pdf-lib-овата конвенция за object numbering), после търсим /Contents и
  // /ByteRange САМО в байтовете СЛЕД тази позиция.
  const sigObjMarker = new TextEncoder().encode(`\n${sigDictRef.objectNumber} 0 obj`);
  const sigObjPos = findPattern(bytes, sigObjMarker);
  if (sigObjPos === -1) {
    throw new Error('PDF подготовка: sig обектът не е намерен след serialize');
  }

  // ── Намираме /Contents < (в рамките на sig обекта) ──
  const contentsMarker = new TextEncoder().encode('/Contents <');
  const contentsMarkerPos = findPattern(bytes, contentsMarker, sigObjPos);
  if (contentsMarkerPos === -1) {
    throw new Error('PDF подготовка: /Contents placeholder не е намерен след serialize');
  }
  // '<' е последният символ в маркера
  const contentsOffset = contentsMarkerPos + contentsMarker.length - 1;

  // ── Намираме /ByteRange [ ... ] placeholder (в рамките на sig обекта) ──
  const brMarker = new TextEncoder().encode('/ByteRange [');
  const brMarkerPos = findPattern(bytes, brMarker, sigObjPos);
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
  pqData?: PqSignatureData | null,
): Uint8Array {
  const result = new Uint8Array(prepared.bytes); // копие

  // 1. Инжектираме CMS hex в /Contents (след '<') — fillContentsPlaceholder
  // хвърля ако cmsDer надвишава CONTENTS_PLACEHOLDER_BYTES.
  fillContentsPlaceholder(result, prepared.contentsOffset, cmsDer);

  // 2. /ByteRange е вече patch-нат от patchByteRangeInPlace() (задължително преди хеширане).
  // result е копие на prepared.bytes, което вече съдържа реалните ByteRange стойности.

  // 3. /PostQuantumSignature като incremental update — само ако pqData е подаден
  if (!pqData) return result;

  const pqJsonStr = JSON.stringify({ ...pqData, byteRange });
  const pqJsonBytes = new TextEncoder().encode(pqJsonStr);
  const pqUpdate = buildPqIncrementalUpdate(result, pqJsonBytes);

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

// ─── Стъпка 5: Incremental добавяне на ВТОРИ (и следващ) подпис ──────────────
//
// За multi-signer: всеки следващ signer подписва "over the last version" —
// НЕ прекарваме файла пак през PDFDocument.load()/.save() (pdf-lib не
// гарантира byte-for-byte запазване на вече подписаните региони, което би
// счупило предния подпис). Вместо това — чист append-only incremental
// update, по модела на buildPqIncrementalUpdate() по-горе, но по-сложен:
// освен нов /Sig + Widget обект, трябва да REDEFINE-нем AcroForm (нов
// /Fields ref) и Page (нов /Annots ref) — REDEFINE тук означава нова
// ревизия на СЪЩИЯ object number на ново място във файла + нов xref entry,
// НЕ мутация на старите байтове (те вече са част от подписания диапазон
// на предния signer).

export interface IncrementalSignOptions {
  markerX: number;
  markerY: number;
  pageIndex: number;
  /** Уникално /T поле, напр. 'Signature2', 'Signature3'. */
  fieldName: string;
  /**
   * TTF байтове на Unicode шрифт (NotoSans) за пълна кирилица в recipient
   * маркера — вгражда се като subset Type0/CIDFontType2 (виж cidFont.ts).
   * Задължителен (за разлика от по-стария Helvetica/латиница подход) —
   * recipient маркерите вече показват кирилица, идентично на owner-ския.
   */
  fontBytes: Uint8Array;
  /** Ширина на маркера в PDF points (default: 200) — виж markerLayout.ts. */
  markerWidth?: number;
  /** Височина на маркера в PDF points (default: 50). */
  markerHeight?: number;
}

export interface PreparedIncrementalSignature {
  bytes:              Uint8Array; // оригинален PDF + нов incremental block с placeholders
  contentsOffset:     number;     // byte offset на '<' в новия /Contents <000...>
  byteRangeNumOffset: number;     // byte offset на '0 999...' в новия /ByteRange [...]
}

/**
 * Намира offset веднага СЛЕД matching '>>' за dictionary, започващ на dictStart
 * (offset на отварящото '<<'). Балансира вложени << >> (напр. /Resources).
 * Не handle-ва << / >> вътре в string/hex литерали — приемливо за AcroForm/
 * Page dict-ове от pdf-lib, които нямат такива edge cases в тестовите PDF-и.
 */
export function findDictEnd(bytes: Uint8Array, dictStart: number): number {
  let depth = 0;
  let i = dictStart;
  while (i < bytes.length - 1) {
    if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) { depth++; i += 2; continue; }
    if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('findDictEnd: непълен dictionary (липсва matching >>)');
}

interface ObjectDict {
  dictStart: number; // offset на '<<'
  dictEnd:   number; // offset веднага след matching '>>'
  text:      string; // decoded latin1 текст на dict-а (вкл. << >>)
}

/**
 * Намира ПОСЛЕДНОТО срещане на "\nN 0 obj" — при incremental updates това е
 * най-новата ревизия на обекта (всяка REDEFINE се append-ва отзад, никога
 * не мутира старите байтове). Водещото '\n' в маркера предотвратява фалшиво
 * съвпадение (напр. obj 5 вътре в "15 0 obj").
 */
function findLastObjectDict(bytes: Uint8Array, objNum: number): ObjectDict {
  const marker = new TextEncoder().encode(`\n${objNum} 0 obj`);
  let pos = -1;
  let found = findPattern(bytes, marker, 0);
  while (found !== -1) { pos = found; found = findPattern(bytes, marker, found + 1); }
  if (pos === -1) throw new Error(`Обект ${objNum} 0 obj не е намерен`);

  let dictStart = pos + marker.length;
  while (dictStart < bytes.length &&
         (bytes[dictStart] === 0x0a || bytes[dictStart] === 0x0d || bytes[dictStart] === 0x20)) {
    dictStart++;
  }
  const dictEnd = findDictEnd(bytes, dictStart);
  return { dictStart, dictEnd, text: new TextDecoder('latin1').decode(bytes.slice(dictStart, dictEnd)) };
}

/** Извлича obj номера от "/Key N 0 R" в decoded dict текст. */
function extractRefNumber(dictText: string, key: string): number {
  const m = dictText.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  if (!m) throw new Error(`/${key} ref не е намерен в dict-а`);
  return parseInt(m[1], 10);
}

/** Извлича catalog obj номера от текущия /Root в trailer-а (reuse findCatalogRef). */
function findCatalogObjectNumber(bytes: Uint8Array): number {
  const ref = findCatalogRef(bytes); // "N 0 R"
  const m = ref.match(/^(\d+)/);
  if (!m) throw new Error('findCatalogObjectNumber: невалиден /Root формат');
  return parseInt(m[1], 10);
}

/**
 * Подготвя incremental update, който добавя НОВ /Sig подпис (+ Widget) към
 * вече подписан PDF — append-only, не пипа съществуващи байтове.
 *
 * Стъпки:
 *   1. Catalog → AcroForm ref + Pages ref → целева страница (pageIndex-ти Kid)
 *   2. REDEFINE AcroForm obj (същия номер, нов offset) с добавен нов field ref
 *   3. REDEFINE Page obj (същия номер, нов offset) с добавен нов Annot ref
 *   4. Нов Widget obj + нов Sig obj (с /Contents, /ByteRange placeholders)
 *   5. Нов xref block (по едно subsection на пипнат/нов обект) + trailer /Prev
 *
 * След това — computeByteRanges/patchByteRangeInPlace/hashByteRanges (вече
 * общи функции, работят непроменени) + подпис + injectIncrementalSignature().
 */
export async function prepareIncrementalSignature(
  pdfBytes: Uint8Array,
  signerName: string,
  signingDate: Date,
  options: IncrementalSignOptions,
): Promise<PreparedIncrementalSignature> {
  const { markerX, markerY, pageIndex, fieldName, fontBytes, markerWidth: MARKER_W = 200, markerHeight: MARKER_H = 50 } = options;

  // ── 0. CID font subset (кирилица за маркера) — виж cidFont.ts ──────────
  const titleText = 'Подписан цифрово';
  const algoText  = 'ECDSA P-256';
  const dateText  = formatDisplayDate(signingDate);
  const cidFont   = await buildCidFontSubset(fontBytes, `${titleText}${signerName}${dateText}${algoText}`);

  // ── 1. Catalog → AcroForm + Pages → целева страница ────────────────────
  const catalogNum  = findCatalogObjectNumber(pdfBytes);
  const catalogDict = findLastObjectDict(pdfBytes, catalogNum);
  const acroFormNum  = extractRefNumber(catalogDict.text, 'AcroForm');
  const pagesRootNum = extractRefNumber(catalogDict.text, 'Pages');

  const pagesDict = findLastObjectDict(pdfBytes, pagesRootNum);
  const kidsMatch = pagesDict.text.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kidsMatch) throw new Error('prepareIncrementalSignature: /Kids не е намерен');
  const kidRefs = [...kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map(m => parseInt(m[1], 10));
  if (pageIndex >= kidRefs.length) {
    throw new Error(`prepareIncrementalSignature: страница ${pageIndex} не съществува (общо ${kidRefs.length})`);
  }
  const pageNum = kidRefs[pageIndex];

  const acroFormDict = findLastObjectDict(pdfBytes, acroFormNum);
  const pageDict      = findLastObjectDict(pdfBytes, pageNum);

  // ── 2. Нови object номера (следват последния наличен) ──────────────────
  const nextObjNum   = findHighestObjectNumber(pdfBytes) + 1;
  const sigObjNum      = nextObjNum;
  const widgetObjNum   = nextObjNum + 1;
  const formObjNum     = nextObjNum + 2; // /AP appearance stream (рамка + кирилица текст)
  const fontFileObjNum = nextObjNum + 3; // FontFile2 (subset TTF бинарни данни)
  const fontDescObjNum = nextObjNum + 4; // FontDescriptor
  const cidFontObjNum  = nextObjNum + 5; // CIDFontType2 (descendant font)
  const type0FontObjNum = nextObjNum + 6; // Type0 (composite font, /Encoding /Identity-H)

  // ── 3. Redefine AcroForm: добавяме widgetObjNum във /Fields ─────────────
  const fieldsMatch = acroFormDict.text.match(/\/Fields\s*\[([^\]]*)\]/);
  if (!fieldsMatch) throw new Error('prepareIncrementalSignature: /Fields не е намерен в AcroForm');
  const newFieldsArray  = `/Fields [${fieldsMatch[1]}${widgetObjNum} 0 R ]`;
  const newAcroFormText = acroFormDict.text.replace(/\/Fields\s*\[[^\]]*\]/, newFieldsArray);

  // ── 4. Redefine Page: добавяме widgetObjNum в /Annots (или го създаваме) ──
  const annotsMatch = pageDict.text.match(/\/Annots\s*\[([^\]]*)\]/);
  let newPageText: string;
  if (annotsMatch) {
    const newAnnotsArray = `/Annots [${annotsMatch[1]}${widgetObjNum} 0 R ]`;
    newPageText = pageDict.text.replace(/\/Annots\s*\[[^\]]*\]/, newAnnotsArray);
  } else {
    // няма /Annots още — добавяме преди затварящото '>>'
    newPageText = `${pageDict.text.slice(0, -2)}/Annots [${widgetObjNum} 0 R ]\n>>`;
  }

  // ── 5. Unicode-safe metadata (виж bugfix 2026-07-19: PDFHexString.fromText) ──
  const reasonHex      = PDFHexString.fromText('SignShield Digital Signature').toString();
  const nameHex        = PDFHexString.fromText(signerName).toString();
  const locationHex    = PDFHexString.fromText('SignShield Platform').toString();
  const contactInfoHex = PDFHexString.fromText('psiholog.pages.dev').toString();

  // ── 6. Построяваме новите обекти като raw PDF текст, offset-ите се       ──
  // ── следят аритметично (без re-scan) — по модела на buildPqIncrementalUpdate.
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = pdfBytes.length;
  const push = (s: string) => { const b = enc.encode(s); parts.push(b); offset += b.length; };
  // Raw байтове (FontFile2 stream съдържание) — НЕ през TextEncoder (UTF-8 би
  // счупил байтове >0x7F в бинарните TTF данни).
  const pushBytes = (b: Uint8Array) => { parts.push(b); offset += b.length; };

  const acroFormOffset = offset + 1; // +1 прескача водещото '\n'
  push(`\n${acroFormNum} 0 obj\n${newAcroFormText}\nendobj\n`);

  const pageOffset = offset + 1;
  push(`\n${pageNum} 0 obj\n${newPageText}\nendobj\n`);

  const widgetOffset = offset + 1;
  push(
    `\n${widgetObjNum} 0 obj\n<<\n/Type /Annot\n/Subtype /Widget\n/FT /Sig\n` +
    `/V ${sigObjNum} 0 R\n/Rect [${markerX} ${markerY} ${markerX + MARKER_W} ${markerY + MARKER_H}]\n` +
    `/P ${pageNum} 0 R\n/T (${fieldName})\n/F 4\n/AP << /N ${formObjNum} 0 R >>\n>>\nendobj\n`,
  );

  // ── 6б. CID font обекти (FontFile2 → FontDescriptor → CIDFont → Type0) ──
  // Ред: FontFile2 (RAW бинарни данни — pushBytes, не push!) → FontDescriptor
  // → CIDFontType2 (descendant) → Type0 (composite, /Encoding /Identity-H).
  // /CIDToGIDMap /Identity е валидно ТУК именно защото subset.includeGlyph()
  // връща новите (compact) glyph ID-та на subset шрифта — CID-ът, който
  // пишем в текстовите низове (encodeCidHexString), директно СЪВПАДА с GID-а
  // в subset FontFile2 данните.
  const fontFileOffset = offset + 1;
  push(`\n${fontFileObjNum} 0 obj\n<<\n/Length ${cidFont.fontFileBytes.length}\n/Length1 ${cidFont.fontFileBytes.length}\n>>\nstream\n`);
  pushBytes(cidFont.fontFileBytes);
  push('\nendstream\nendobj\n');

  const fontDescOffset = offset + 1;
  const [bx0, by0, bx1, by1] = cidFont.bbox;
  push(
    `\n${fontDescObjNum} 0 obj\n<<\n/Type /FontDescriptor\n/FontName /${cidFont.subsetTag}+${cidFont.postscriptName}\n` +
    `/Flags 4\n/FontBBox [${bx0} ${by0} ${bx1} ${by1}]\n/ItalicAngle ${cidFont.italicAngle}\n` +
    `/Ascent ${cidFont.ascent}\n/Descent ${cidFont.descent}\n/CapHeight ${cidFont.capHeight}\n/StemV 80\n` +
    `/FontFile2 ${fontFileObjNum} 0 R\n>>\nendobj\n`,
  );

  const cidFontOffset = offset + 1;
  push(
    `\n${cidFontObjNum} 0 obj\n<<\n/Type /Font\n/Subtype /CIDFontType2\n/BaseFont /${cidFont.subsetTag}+${cidFont.postscriptName}\n` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>\n` +
    `/FontDescriptor ${fontDescObjNum} 0 R\n/DW 0\n/W [ ${buildWidthsArray(cidFont.glyphs)} ]\n` +
    `/CIDToGIDMap /Identity\n>>\nendobj\n`,
  );

  const type0FontOffset = offset + 1;
  push(
    `\n${type0FontObjNum} 0 obj\n<<\n/Type /Font\n/Subtype /Type0\n/BaseFont /${cidFont.subsetTag}+${cidFont.postscriptName}\n` +
    `/Encoding /Identity-H\n/DescendantFonts [${cidFontObjNum} 0 R]\n>>\nendobj\n`,
  );

  // Appearance stream: рамка/фон + текст с вградения CID шрифт (пълна
  // кирилица, идентично на owner-ския маркер в preparePdfForSigning).
  // Координати спрямо собствения /BBox на формата (0,0)-(MARKER_W,MARKER_H),
  // Widget-ният /Rect позиционира формата на страницата.
  // Текстовите редове са закотвени към ГОРНИЯ край на маркера (не долния) —
  // ако MARKER_H > 50 (auto-layout с по-голяма зона), остава празно място
  // ОТДОЛУ, не се разтяга/чупи layout-ът на 4-те реда.
  const formOffset = offset + 1;
  const apStreamContent =
    'q\n0.94 0.94 0.98 rg\n0.25 0.25 0.70 RG\n0.5 w\n' +
    `0.25 0.25 ${MARKER_W - 0.5} ${MARKER_H - 0.5} re\nB\nQ\n` +
    'BT\n' +
    `/F1 8 Tf 0.15 0.15 0.60 rg 5 ${MARKER_H - 13} Td ${encodeCidHexString(titleText, cidFont.glyphs)} Tj\n` +
    `0 -12 Td /F1 8 Tf 0 0 0 rg ${encodeCidHexString(signerName, cidFont.glyphs)} Tj\n` +
    `0 -12 Td /F1 7 Tf 0.3 0.3 0.3 rg ${encodeCidHexString(dateText, cidFont.glyphs)} Tj\n` +
    `0 -10 Td /F1 6 Tf 0.5 0.5 0.5 rg ${encodeCidHexString(algoText, cidFont.glyphs)} Tj\n` +
    'ET\n';
  const apStreamBytes = enc.encode(apStreamContent);
  push(
    `\n${formObjNum} 0 obj\n<<\n/Type /XObject\n/Subtype /Form\n` +
    `/BBox [0 0 ${MARKER_W} ${MARKER_H}]\n` +
    `/Resources << /Font << /F1 ${type0FontObjNum} 0 R >> >>\n` +
    `/Length ${apStreamBytes.length}\n>>\n` +
    `stream\n${apStreamContent}endstream\nendobj\n`,
  );

  const sigOffset = offset + 1;
  push(`\n${sigObjNum} 0 obj\n<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /adbe.pkcs7.detached\n/ByteRange [`);
  const byteRangeNumOffset = offset; // веднага след '['
  push('0 999999999 999999999 999999999]\n/Contents <');
  const contentsOffset = offset - 1; // offset на '<' самия (последният push-нат символ)
  push('0'.repeat(CONTENTS_HEX_LENGTH));
  push(
    `>\n/Reason ${reasonHex}\n/M (${formatPdfDate(signingDate)})\n/Name ${nameHex}\n` +
    `/Location ${locationHex}\n/ContactInfo ${contactInfoHex}\n>>\nendobj\n`,
  );

  // ── 7. xref block: по едно subsection на пипнат/нов обект (сортирано) ───
  const xrefEntries = [
    { num: acroFormNum,    off: acroFormOffset },
    { num: pageNum,        off: pageOffset },
    { num: widgetObjNum,   off: widgetOffset },
    { num: fontFileObjNum, off: fontFileOffset },
    { num: fontDescObjNum, off: fontDescOffset },
    { num: cidFontObjNum,  off: cidFontOffset },
    { num: type0FontObjNum,off: type0FontOffset },
    { num: formObjNum,     off: formOffset },
    { num: sigObjNum,      off: sigOffset },
  ].sort((a, b) => a.num - b.num);

  const xrefBlockStart = offset;
  let xref = '\nxref\n';
  for (const e of xrefEntries) {
    xref += `${e.num} 1\n${String(e.off).padStart(10, '0')} 00000 n \n`;
  }
  const xrefKeyword = xrefBlockStart + 1; // +1 за водещото '\n'
  push(xref);

  const prevXref = findStartXref(pdfBytes);
  const newSize  = type0FontObjNum + 1; // Size = (най-високият object number в тази ревизия) + 1
  push(`trailer\n<< /Size ${newSize} /Root ${findCatalogRef(pdfBytes)} /Prev ${prevXref} >>\nstartxref\n${xrefKeyword}\n%%EOF\n`);

  // ── 8. Сглобяваме финалните bytes ────────────────────────────────────────
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const combined = new Uint8Array(pdfBytes.length + totalLen);
  combined.set(pdfBytes, 0);
  let pos = pdfBytes.length;
  for (const p of parts) { combined.set(p, pos); pos += p.length; }

  return { bytes: combined, contentsOffset, byteRangeNumOffset };
}

/**
 * Инжектира CMS DER в /Contents placeholder-а на incremental подпис (Стъпка 5)
 * + опционален /PostQuantumSignature incremental block (ML-DSA-65 за
 * recipient-и — Ден 6 hotfix v5, per заданието "потребителят трябва да има
 * И двата типа ключове преди да може да подписва"). Reuse-ва
 * buildPqIncrementalUpdate() — вече генерична функция, независима от това
 * дали PDF-ът идва от preparePdfForSigning (owner) или тук (recipient); виж
 * extractAllPqStreams() в pdfVerifier.ts, вече проектирана да чете N streams.
 */
export function injectIncrementalSignature(
  prepared: PreparedIncrementalSignature,
  cmsDer: Uint8Array,
  pqData?: PqSignatureData | null,
): Uint8Array {
  const result = new Uint8Array(prepared.bytes);
  fillContentsPlaceholder(result, prepared.contentsOffset, cmsDer);
  if (!pqData) return result;

  const pqJsonBytes = new TextEncoder().encode(JSON.stringify(pqData));
  const pqUpdate = buildPqIncrementalUpdate(result, pqJsonBytes);
  const finalPdf = new Uint8Array(result.length + pqUpdate.length);
  finalPdf.set(result, 0);
  finalPdf.set(pqUpdate, result.length);
  return finalPdf;
}

// ─── Публично помощно API ─────────────────────────────────────────────────────

/** Конвертира Uint8Array → base64url за PQ JSON payload. */
export function encodeBase64url(bytes: Uint8Array): string {
  return toBase64url(bytes);
}
