/**
 * reportGenerator.ts
 * Генерира PDF доклад за верификация на подписан документ.
 *
 * Всичко е client-side — без upload, без сървър.
 * NotoSans се subset-ва автоматично от fontkit (само използваните glyphs).
 *
 * Layout (A4, 595 × 842 pt):
 *   Header     → indigo лента с „SignShield · Доклад за верификация"
 *   Status     → цветен банер (зелен/жълт/червен/неутрален)
 *   Section 1  → Класически подпис (ECDSA P-256)
 *   Section 2  → Пост-квантов подпис (ML-DSA-65)
 *   Section 3  → Цялост на документа (SHA-256 хеш)
 *   Section 4  → Покрити байтове (byte range)
 *   Footer     → URL + disclaimer + страница
 */
import { PDFDocument, PDFFont, rgb, RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { sha256 } from '@noble/hashes/sha2.js';
import type { VerifyResult } from './types';

// ─── Константи ────────────────────────────────────────────────────────────────

const PAGE_W   = 595.28;
const PAGE_H   = 841.89;
const MARGIN   = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

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
  if (result.overall === 'authentic') {
    return result.ecdsa?.certStatus === 'expired' ? C_YELLOW : C_GREEN;
  }
  if (result.overall === 'tampered' || result.overall === 'invalid') return C_RED;
  return C_NEUTRAL;
}

function statusText(result: VerifyResult): string {
  switch (result.overall) {
    case 'authentic':
      return result.ecdsa?.certStatus === 'expired'
        ? 'ДОКУМЕНТЪТ Е АВТЕНТИЧЕН — СЕРТИФИКАТЪТ Е ИЗТЕКЪЛ'
        : 'ДОКУМЕНТЪТ Е АВТЕНТИЧЕН И НЕПРОМЕНЕН';
    case 'tampered':  return 'ДОКУМЕНТЪТ Е МОДИФИЦИРАН СЛЕД ПОДПИСВАНЕ';
    case 'invalid':
      return result.ecdsa?.certStatus === 'chain_invalid'
        ? 'ПОДПИСЪТ Е ОТ НЕИЗВЕСТЕН ИЗДАТЕЛ'
        : 'ПОДПИСЪТ Е НЕВАЛИДЕН';
    case 'unsigned':  return 'ДОКУМЕНТЪТ НЕ СЪДЪРЖА ЦИФРОВ ПОДПИС';
    default:          return 'ГРЕШКА ПРИ ВЕРИФИКАЦИЯ';
  }
}

// ─── Drawing primitives ───────────────────────────────────────────────────────

function drawText(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  color: RGB = C_BLACK,
) {
  page.drawText(text, { x, y, size, font, color });
}

function drawRect(
  page: ReturnType<PDFDocument['addPage']>,
  x: number, y: number, w: number, h: number,
  color: RGB,
) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawLine(
  page: ReturnType<PDFDocument['addPage']>,
  x1: number, y1: number, x2: number, y2: number,
  color: RGB = C_DIVIDER,
  thickness = 0.5,
) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

// ─── Секции ───────────────────────────────────────────────────────────────────

interface Field { label: string; value: string; mono?: boolean }

/**
 * Рисува секция с title + редове label:value.
 * Връща новата Y позиция след секцията.
 */
function drawSection(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  title: string,
  fields: Field[],
  y: number,
): number {
  // Сив фон на заглавието
  drawRect(page, MARGIN, y - SECTION_TITLE_H + 4, CONTENT_W, SECTION_TITLE_H, C_SECTION_BG);
  drawText(page, font, title, MARGIN + 6, y - 10, 8.5, C_INDIGO);
  y -= SECTION_TITLE_H;

  // Редове
  for (const { label, value } of fields) {
    const labelX = MARGIN + 6;
    const valueX = MARGIN + 140;
    drawText(page, font, label, labelX, y - 12, 8, C_GREY);
    // Дълги стойности се режат с ellipsis ако > ~70 chars
    const display = value.length > 72 ? value.slice(0, 69) + '…' : value;
    drawText(page, font, display, valueX, y - 12, 8, C_BLACK);
    y -= ROW_H;
  }

  // Долен разделител
  drawLine(page, MARGIN, y, MARGIN + CONTENT_W, y);
  return y - GAP;
}

// ─── Главна функция ───────────────────────────────────────────────────────────

/**
 * Генерира PDF доклад за резултата от верификация.
 *
 * @param result    Резултатът от verifyDocument()
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

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Текуща Y позиция (от горе надолу)
  let y = PAGE_H;

  // ── 2. Header ─────────────────────────────────────────────────────────────────
  drawRect(page, 0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, C_INDIGO);
  drawText(page, font, 'SignShield', MARGIN, PAGE_H - 20, 13, C_WHITE);
  drawText(page, font, 'Доклад за верификация', MARGIN, PAGE_H - 36, 9, rgb(0.8, 0.8, 1));
  const verifyUrl = 'psiholog.pages.dev/verify';
  const urlW = font.widthOfTextAtSize(verifyUrl, 8);
  drawText(page, font, verifyUrl, PAGE_W - MARGIN - urlW, PAGE_H - 28, 8, rgb(0.7, 0.7, 1));
  y = PAGE_H - HEADER_H;

  // ── 3. Status banner ─────────────────────────────────────────────────────────
  const sColor = statusColor(result);
  // Лява цветна лента
  drawRect(page, MARGIN, y - BANNER_H, 4, BANNER_H, sColor);
  // Светъл фон
  drawRect(page, MARGIN + 4, y - BANNER_H, CONTENT_W - 4, BANNER_H, rgb(0.97, 0.97, 0.97));

  const statusLine = statusText(result);
  drawText(page, font, statusLine, MARGIN + 14, y - 20, 10.5, sColor);

  const nameLabel = result.ecdsa?.signerName ? `Подписал: ${result.ecdsa.signerName}` : '';
  const dateLabel = result.ecdsa?.signedAt   ? `Дата: ${fmtDateTime(result.ecdsa.signedAt)}` : '';
  if (nameLabel) drawText(page, font, nameLabel, MARGIN + 14, y - 36, 8.5, C_BLACK);
  if (dateLabel) {
    const dateLabelW = font.widthOfTextAtSize(nameLabel, 8.5);
    drawText(page, font, dateLabel, MARGIN + 14 + dateLabelW + 30, y - 36, 8.5, C_BLACK);
  }

  // Файл + дата на доклада
  const fileDisplay = fileName.length > 60 ? fileName.slice(0, 57) + '…' : fileName;
  drawText(page, font, `Файл: ${fileDisplay}`, MARGIN + 14, y - 52, 8, C_GREY);
  drawText(
    page, font,
    `Верифициран на: ${fmtDateTime(new Date())}`,
    MARGIN + 14, y - 64, 8, C_GREY,
  );

  y -= BANNER_H + GAP;

  // ── 4. ECDSA секция ──────────────────────────────────────────────────────────
  const ecdsa = result.ecdsa;
  const ecdsaFields: Field[] = ecdsa ? [
    { label: 'Статус',        value: ecdsa.status === 'valid' ? '✓ Валиден' : '✗ Невалиден' },
    { label: 'Алгоритъм',    value: 'ECDSA P-256 / SHA-256' },
    { label: 'Подписал',     value: ecdsa.signerName || '—' },
    { label: 'Дата',         value: fmtDateTime(ecdsa.signedAt) },
    { label: 'Издател',      value: ecdsa.certIssuer || '—' },
    { label: 'Cert изтича',  value: fmtDate(ecdsa.certExpiry) },
    { label: 'Верига',       value: ecdsa.certStatus === 'ok'
        ? '✓ Доверена (SignShield Root CA v1)'
        : ecdsa.certStatus === 'expired'
        ? '⚠ Изтекъл сертификат'
        : '✗ Непозната CA' },
    ...(ecdsa.certDer ? [{
      label: 'Cert fingerprint',
      value: `sha256:${fingerprint(ecdsa.certDer)}…`,
    }] : []),
    ...(ecdsa.sigBytes ? [{
      label: 'Sig fingerprint',
      value: `sha256:${fingerprint(ecdsa.sigBytes)}…`,
    }] : []),
  ] : [{ label: 'Статус', value: 'Не е намерен ECDSA подпис' }];

  y = drawSection(page, font, 'КЛАСИЧЕСКИ ПОДПИС (ECDSA P-256)', ecdsaFields, y);

  // ── 5. Верижна визуализация (само при authentic/invalid с cert) ───────────────
  if (ecdsa && ecdsa.certStatus) {
    drawRect(page, MARGIN, y - 52, CONTENT_W, 52, rgb(0.98, 0.98, 0.98));
    const cx = MARGIN + 14;
    drawText(page, font, `Подписал:  ${ecdsa.signerName}`, cx, y - 14, 7.5, C_BLACK);
    drawText(page, font, '     ↓ подписан от', cx, y - 26, 7.5, C_GREY);
    drawText(page, font, `Root CA:   ${ecdsa.certIssuer ?? 'SignShield Root CA v1'}`, cx, y - 38, 7.5, C_BLACK);
    const chainOk = ecdsa.certStatus === 'ok' || ecdsa.certStatus === 'expired';
    drawText(page, font,
      `     ↓ trust anchor  ${chainOk ? '✓ Верига валидна' : '✗ Верига невалидна'}`,
      cx, y - 50, 7.5, chainOk ? C_GREEN : C_RED,
    );
    drawLine(page, MARGIN, y - 52, MARGIN + CONTENT_W, y - 52);
    y -= 52 + GAP;
  }

  // ── 6. ML-DSA секция ────────────────────────────────────────────────────────
  const mlDsa = result.mlDsa;
  const mlFields: Field[] = mlDsa ? [
    { label: 'Статус', value:
        mlDsa.status === 'valid'        ? '✓ Валиден'
      : mlDsa.status === 'not_included' ? '— Не е приложен (стар документ)'
      : '✗ Невалиден' },
    { label: 'Алгоритъм', value: 'ML-DSA-65 (FIPS 204)' },
    ...(mlDsa.sigBytes ? [{
      label: 'Sig fingerprint',
      value: `sha256:${fingerprint(mlDsa.sigBytes)}…`,
    }] : []),
  ] : [{ label: 'Статус', value: 'Не е намерен PQ подпис' }];

  y = drawSection(page, font, 'ПОСТ-КВАНТОВ ПОДПИС (ML-DSA-65)', mlFields, y);

  // ── 7. Цялост ────────────────────────────────────────────────────────────────
  const hashDisplay = result.documentHash
    ? result.documentHash.slice(0, 32) + '…' + result.documentHash.slice(-8)
    : '—';
  y = drawSection(page, font, 'ЦЯЛОСТ НА ДОКУМЕНТА', [
    { label: 'Алгоритъм', value: 'SHA-256 (ByteRange)' },
    { label: 'Хеш',       value: hashDisplay, mono: true },
  ], y);

  // ── 8. Byte range ──────────────────────────────────────────────────────────
  const br = result.byteRange;
  y = drawSection(page, font, 'ПОКРИТИ БАЙТОВЕ (BYTE RANGE)', br ? [
    { label: 'Диапазон 1', value: `[0 … ${br[1].toLocaleString('bg-BG')}]` },
    { label: 'Диапазон 2', value: `[${br[2].toLocaleString('bg-BG')} … ${(br[2] + br[3]).toLocaleString('bg-BG')}]` },
    { label: 'Общо',       value: `${(br[1] + br[3]).toLocaleString('bg-BG')} байта подписани` },
  ] : [{ label: 'Диапазон', value: 'Не е намерен byte range' }], y);

  // ── 9. Footer ─────────────────────────────────────────────────────────────
  const footerY = 38;
  drawLine(page, MARGIN, footerY + 20, MARGIN + CONTENT_W, footerY + 20, C_DIVIDER, 0.5);
  drawText(
    page, font,
    `Генериран от SignShield Verify · psiholog.pages.dev/verify`,
    MARGIN, footerY + 10, 7, C_GREY,
  );
  drawText(
    page, font,
    'За актуална верификация качете оригиналния PDF на psiholog.pages.dev/verify',
    MARGIN, footerY - 2, 6.5, C_GREY,
  );
  drawText(page, font, 'Този доклад е за информационни цели. SignShield е академичен проект.', MARGIN, footerY - 14, 6.5, C_GREY);
  drawText(page, font, '1 / 1', PAGE_W - MARGIN - 20, footerY + 10, 7, C_GREY);

  // ── 10. Сериализираме ────────────────────────────────────────────────────────
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
