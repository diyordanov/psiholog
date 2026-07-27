/**
 * reportGenerator.ts
 * Генерира PDF доклад за верификация на подписан документ.
 *
 * Всичко е client-side — без upload, без сървър.
 * NotoSans се subset-ва автоматично от fontkit (само използваните glyphs).
 *
 * Layout (A4, 595 × 842 pt, с автоматична пагинация при N подписа):
 *   Header     → indigo лента с „SignShield · Доклад за верификация"
 *   Status     → цветен банер (зелен/жълт/червен/неутрален) + брой подписващи
 *   Секция за ВСЕКИ подписващ → ECDSA + ML-DSA + верижна визуализация
 *   Цялост на документа       → SHA-256 хеш (общо, покрива всички подписи)
 *   Покрити байтове           → byte range (последния /Sig, покрива целия файл)
 *   Footer     → URL + disclaimer + страница
 *
 * Ден 3 (Фаза 8): генерализирано за N подписа — секция за всеки signer в
 * `result.signers`, вместо единствен ECDSA/ML-DSA блок.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { sha256 } from '@noble/hashes/sha2.js';
import type { VerifyResult, SignerResult } from './types';

// ─── Константи ────────────────────────────────────────────────────────────────

const PAGE_W   = 595.28;
const PAGE_H   = 841.89;
const MARGIN   = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
/** Ако остане по-малко пространство от това — нова страница преди следваща секция. */
const MIN_SPACE_BEFORE_SECTION = 100;

// Цветове (RGB 0–1)
const C_INDIGO   = rgb(0.310, 0.275, 0.898);
const C_GREEN    = rgb(0.086, 0.639, 0.290);
const C_YELLOW   = rgb(0.784, 0.490, 0.000);
const C_RED      = rgb(0.863, 0.149, 0.149);
const C_NEUTRAL  = rgb(0.400, 0.400, 0.400);
const C_BLACK    = rgb(0.067, 0.094, 0.153);
const C_GREY     = rgb(0.550, 0.550, 0.550);
const C_DIVIDER  = rgb(0.878, 0.878, 0.878);
const C_SECTION_BG = rgb(0.969, 0.969, 0.969);
const C_WHITE    = rgb(1, 1, 1);

// Размери
const HEADER_H  = 48;
const BANNER_H  = 72;
const SECTION_TITLE_H = 24;
const ROW_H     = 16;
const GAP       = 8;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** SHA-256 на bytes → first 16 hex chars (32-bit fingerprint display). */
function fingerprint(bytes: Uint8Array): string {
  const h = sha256(bytes);
  return Array.from(h.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} г.`;
}

function fmtDateTime(d: Date | null): string {
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fmtDate(d).replace(' г.', '')} г., ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function statusColor(result: VerifyResult): RGB {
  if (result.overall === 'authentic') return C_GREEN;
  if (result.overall === 'authentic_with_warnings') return C_YELLOW;
  if (result.overall === 'tampered' || result.overall === 'invalid') return C_RED;
  return C_NEUTRAL;
}

function statusText(result: VerifyResult): string {
  switch (result.overall) {
    case 'authentic':                return 'ДОКУМЕНТЪТ Е АВТЕНТИЧЕН И НЕПРОМЕНЕН';
    case 'authentic_with_warnings':  return 'ДОКУМЕНТЪТ Е АВТЕНТИЧЕН — С ПРЕДУПРЕЖДЕНИЯ';
    case 'tampered':                 return 'ДОКУМЕНТЪТ Е МОДИФИЦИРАН СЛЕД ПОДПИСВАНЕ';
    case 'invalid': {
      const anyChainInvalid = result.signers.some(s => s.ecdsa.certStatus === 'chain_invalid');
      return anyChainInvalid ? 'ПОДПИСЪТ Е ОТ НЕИЗВЕСТЕН ИЗДАТЕЛ' : 'ПОДПИСЪТ Е НЕВАЛИДЕН';
    }
    case 'unsigned':  return 'ДОКУМЕНТЪТ НЕ СЪДЪРЖА ЦИФРОВ ПОДПИС';
    default:          return 'ГРЕШКА ПРИ ВЕРИФИКАЦИЯ';
  }
}

/** Роля по подразбиране за signerIndex — owner е първият подписал, останалите получатели. */
function roleLabel(signerIndex: number): string {
  return signerIndex === 0 ? 'собственик' : `получател ${signerIndex}`;
}

// ─── Pagination context ───────────────────────────────────────────────────────

interface Ctx {
  pdfDoc: PDFDocument;
  font: PDFFont;
  page: PDFPage;
  y: number;
  pageCount: number;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.pdfDoc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
  ctx.pageCount++;
}

/** Ако остава по-малко от `needed` пространство до долния марджин — нова страница. */
function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN + 20) newPage(ctx);
}

// ─── Drawing primitives ───────────────────────────────────────────────────────

function drawText(ctx: Ctx, text: string, x: number, y: number, size: number, color: RGB = C_BLACK) {
  ctx.page.drawText(text, { x, y, size, font: ctx.font, color });
}

function drawRect(ctx: Ctx, x: number, y: number, w: number, h: number, color: RGB) {
  ctx.page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawLine(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, color: RGB = C_DIVIDER, thickness = 0.5) {
  ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

// ─── Секции ───────────────────────────────────────────────────────────────────

interface Field { label: string; value: string }

/** Рисува секция с title + редове label:value. Пагинира автоматично при нужда. */
function drawSection(ctx: Ctx, title: string, fields: Field[]): void {
  ensureSpace(ctx, SECTION_TITLE_H + fields.length * ROW_H + GAP);

  drawRect(ctx, MARGIN, ctx.y - SECTION_TITLE_H + 4, CONTENT_W, SECTION_TITLE_H, C_SECTION_BG);
  drawText(ctx, title, MARGIN + 6, ctx.y - 10, 8.5, C_INDIGO);
  ctx.y -= SECTION_TITLE_H;

  for (const { label, value } of fields) {
    ensureSpace(ctx, ROW_H);
    const labelX = MARGIN + 6;
    const valueX = MARGIN + 140;
    drawText(ctx, label, labelX, ctx.y - 12, 8, C_GREY);
    const display = value.length > 72 ? value.slice(0, 69) + '…' : value;
    drawText(ctx, display, valueX, ctx.y - 12, 8, C_BLACK);
    ctx.y -= ROW_H;
  }

  drawLine(ctx, MARGIN, ctx.y, MARGIN + CONTENT_W, ctx.y);
  ctx.y -= GAP;
}

/** Секция за ЕДИН подписващ: ECDSA + ML-DSA + верижна визуализация. */
function drawSignerSection(ctx: Ctx, signer: SignerResult, signerNumber: number): void {
  const { ecdsa, mlDsa } = signer;
  const roleTitle = `ПОДПИСВАЩ ${signerNumber} (${roleLabel(signer.signerIndex).toUpperCase()}): ${ecdsa.signerName || '—'}`;

  const ecdsaFields: Field[] = [
    { label: 'ECDSA статус',  value: ecdsa.status === 'valid' ? '✓ Валиден' : '✗ Невалиден' },
    { label: 'Алгоритъм',     value: 'ECDSA P-256 / SHA-256' },
    { label: 'Подписано на',  value: fmtDateTime(ecdsa.signedAt) },
    { label: 'Издател',       value: ecdsa.certIssuer || '—' },
    { label: 'Cert изтича',   value: fmtDate(ecdsa.certExpiry) },
    { label: 'Верига',        value: ecdsa.certStatus === 'ok'
        ? '✓ Доверена (SignShield Root CA v1)'
        : ecdsa.certStatus === 'expired'
        ? '⚠ Изтекъл сертификат'
        : ecdsa.certStatus === 'chain_invalid'
        ? '✗ Непозната CA'
        : '—' },
    ...(ecdsa.certDer ? [{ label: 'Cert fingerprint', value: `sha256:${fingerprint(ecdsa.certDer)}…` }] : []),
    ...(ecdsa.sigBytes ? [{ label: 'Sig fingerprint', value: `sha256:${fingerprint(ecdsa.sigBytes)}…` }] : []),
    ...(ecdsa.errorMessage ? [{ label: 'Грешка', value: ecdsa.errorMessage }] : []),
    { label: 'ML-DSA-65 статус', value:
        mlDsa === null                  ? '— Няма PQ слот за този подписващ'
      : mlDsa.status === 'valid'        ? '✓ Валиден'
      : mlDsa.status === 'not_included' ? '— Не е приложен (стар документ)'
      : '✗ Невалиден' },
    ...(mlDsa?.sigBytes ? [{ label: 'PQ sig fingerprint', value: `sha256:${fingerprint(mlDsa.sigBytes)}…` }] : []),
  ];

  drawSection(ctx, roleTitle, ecdsaFields);

  // Верижна визуализация (само ако имаме cert данни)
  if (ecdsa.certDer && ecdsa.certStatus) {
    ensureSpace(ctx, 52 + GAP);
    drawRect(ctx, MARGIN, ctx.y - 52, CONTENT_W, 52, rgb(0.98, 0.98, 0.98));
    const cx = MARGIN + 14;
    drawText(ctx, `Подписал:  ${ecdsa.signerName}`, cx, ctx.y - 14, 7.5, C_BLACK);
    drawText(ctx, '     ↓ подписан от', cx, ctx.y - 26, 7.5, C_GREY);
    drawText(ctx, `Root CA:   ${ecdsa.certIssuer ?? 'SignShield Root CA v1'}`, cx, ctx.y - 38, 7.5, C_BLACK);
    const chainOk = ecdsa.certStatus === 'ok' || ecdsa.certStatus === 'expired';
    drawText(
      ctx, `     ↓ trust anchor  ${chainOk ? '✓ Верига валидна' : '✗ Верига невалидна'}`,
      cx, ctx.y - 50, 7.5, chainOk ? C_GREEN : C_RED,
    );
    drawLine(ctx, MARGIN, ctx.y - 52, MARGIN + CONTENT_W, ctx.y - 52);
    ctx.y -= 52 + GAP;
  }
}

// ─── Главна функция ───────────────────────────────────────────────────────────

/**
 * Генерира PDF доклад за резултата от верификация.
 *
 * @param result    Резултатът от verifyDocument() — N подписа (Ден 3)
 * @param fileName  Оригиналното file name на качения PDF
 * @returns         Байтовете на генерирания PDF доклад
 */
export async function generateVerificationReport(
  result: VerifyResult,
  fileName: string,
): Promise<Uint8Array> {
  // ── 1. Зареждаме NotoSans (subset — само ползваните glyphs) ──────────────────
  const fontRes = await fetch('/fonts/NotoSans-Regular.ttf');
  const fontBytes = await fontRes.arrayBuffer();

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });

  const ctx: Ctx = { pdfDoc, font, page: pdfDoc.addPage([PAGE_W, PAGE_H]), y: PAGE_H, pageCount: 1 };

  // ── 2. Header ─────────────────────────────────────────────────────────────────
  drawRect(ctx, 0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, C_INDIGO);
  drawText(ctx, 'SignShield', MARGIN, PAGE_H - 20, 13, C_WHITE);
  drawText(ctx, 'Доклад за верификация', MARGIN, PAGE_H - 36, 9, rgb(0.8, 0.8, 1));
  const verifyUrl = 'psiholog.pages.dev/verify';
  const urlW = font.widthOfTextAtSize(verifyUrl, 8);
  drawText(ctx, verifyUrl, PAGE_W - MARGIN - urlW, PAGE_H - 28, 8, rgb(0.7, 0.7, 1));
  ctx.y = PAGE_H - HEADER_H;

  // ── 3. Status banner ─────────────────────────────────────────────────────────
  const sColor = statusColor(result);
  drawRect(ctx, MARGIN, ctx.y - BANNER_H, 4, BANNER_H, sColor);
  drawRect(ctx, MARGIN + 4, ctx.y - BANNER_H, CONTENT_W - 4, BANNER_H, rgb(0.97, 0.97, 0.97));

  drawText(ctx, statusText(result), MARGIN + 14, ctx.y - 20, 10.5, sColor);

  const signersCountLabel = result.totalSigners === 1
    ? 'Подписан от 1 лице'
    : `Подписан от ${result.totalSigners} лица`;
  drawText(ctx, signersCountLabel, MARGIN + 14, ctx.y - 36, 8.5, C_BLACK);

  const fileDisplay = fileName.length > 60 ? fileName.slice(0, 57) + '…' : fileName;
  drawText(ctx, `Файл: ${fileDisplay}`, MARGIN + 14, ctx.y - 52, 8, C_GREY);
  drawText(ctx, `Верифициран на: ${fmtDateTime(new Date())}`, MARGIN + 14, ctx.y - 64, 8, C_GREY);

  ctx.y -= BANNER_H + GAP;

  // ── 4. Секция за всеки подписващ ─────────────────────────────────────────────
  result.signers.forEach((signer, i) => {
    ensureSpace(ctx, MIN_SPACE_BEFORE_SECTION);
    drawSignerSection(ctx, signer, i + 1);
  });

  // ── 5. Цялост на документа ────────────────────────────────────────────────────
  const hashDisplay = result.documentHash
    ? result.documentHash.slice(0, 32) + '…' + result.documentHash.slice(-8)
    : '—';
  ensureSpace(ctx, MIN_SPACE_BEFORE_SECTION);
  drawSection(ctx, 'ЦЯЛОСТ НА ДОКУМЕНТА', [
    { label: 'Алгоритъм', value: 'SHA-256 (ByteRange, покрива всички подписи)' },
    { label: 'Хеш',       value: hashDisplay },
  ]);

  // ── 6. Byte range ──────────────────────────────────────────────────────────
  const br = result.byteRange;
  ensureSpace(ctx, MIN_SPACE_BEFORE_SECTION);
  drawSection(ctx, 'ПОКРИТИ БАЙТОВЕ (BYTE RANGE)', br ? [
    { label: 'Диапазон 1', value: `[0 … ${br[1].toLocaleString('bg-BG')}]` },
    { label: 'Диапазон 2', value: `[${br[2].toLocaleString('bg-BG')} … ${(br[2] + br[3]).toLocaleString('bg-BG')}]` },
    { label: 'Общо',       value: `${(br[1] + br[3]).toLocaleString('bg-BG')} байта подписани` },
  ] : [{ label: 'Диапазон', value: 'Не е намерен byte range' }]);

  // ── 7. Footer на ВСЯКА страница ────────────────────────────────────────────
  const pages = pdfDoc.getPages();
  pages.forEach((p, i) => {
    const footerY = 38;
    p.drawLine({ start: { x: MARGIN, y: footerY + 20 }, end: { x: MARGIN + CONTENT_W, y: footerY + 20 }, thickness: 0.5, color: C_DIVIDER });
    p.drawText(`Генериран от SignShield Verify · psiholog.pages.dev/verify`, { x: MARGIN, y: footerY + 10, size: 7, font, color: C_GREY });
    p.drawText('За актуална верификация качете оригиналния PDF на psiholog.pages.dev/verify', { x: MARGIN, y: footerY - 2, size: 6.5, font, color: C_GREY });
    p.drawText('Този доклад е за информационни цели. SignShield е академичен проект.', { x: MARGIN, y: footerY - 14, size: 6.5, font, color: C_GREY });
    p.drawText(`${i + 1} / ${pages.length}`, { x: PAGE_W - MARGIN - 30, y: footerY + 10, size: 7, font, color: C_GREY });
  });

  // ── 8. Сериализираме ────────────────────────────────────────────────────────
  const bytes = await pdfDoc.save();
  return bytes;
}

/**
 * Генерира filename за доклада.
 * Формат: verification-report_{originalname-без-ext}_{timestamp}.pdf
 */
export function reportFileName(originalFileName: string): string {
  const base = originalFileName
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '_')
    .slice(0, 40);
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
  return base ? `verification-report_${base}_${ts}.pdf` : `verification-report_${ts}.pdf`;
}
