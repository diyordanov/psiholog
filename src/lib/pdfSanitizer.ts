/**
 * pdfSanitizer.ts
 * Сканира raw байтовете на PDF файл за опасни елементи преди качване.
 *
 * Подход: търсим ASCII ключови думи директно в байтовете на файла.
 * PDF структурата е ASCII-базирана — опасните оператори като /JavaScript
 * се появяват като буквален текст в незашифрован поток.
 *
 * Ограничение (документирано съзнателно): не хваща елементи в компресирани
 * object streams (FlateDecode/DEFLATE). Malicious PDF, в който /JavaScript е
 * компресиран, ще мине тази проверка. За пълна защита е нужно сървърно
 * декомпресиране и повторен scan. За текущия scope е достатъчно.
 */

export interface SanitizationResult {
  safe: boolean;
  threats: string[];  // human-readable описания на намерените заплахи
}

/**
 * Двойки: [ASCII pattern в PDF байтовете, описание за потребителя].
 * Референция: PDF 1.7 спецификация, Section 12.6 (Interactive Features).
 */
const DANGEROUS_PATTERNS: [string, string][] = [
  ['/JavaScript', 'вграден JavaScript (/JavaScript)'],
  ['/JS ',        'вграден JavaScript (/JS)'],   // кратка форма с интервал след нея
  ['/JS\r',       'вграден JavaScript (/JS)'],   // кратка форма с CR
  ['/JS\n',       'вграден JavaScript (/JS)'],   // кратка форма с LF
  ['/Launch',     'Launch action — стартира външна програма'],
  ['/EmbeddedFile', 'вграден файл (/EmbeddedFile)'],
  ['/SubmitForm', 'Submit-form action — изпраща данни към URL'],
  ['/ImportData', 'ImportData action'],
];

/**
 * Сканира PDF буфер за опасни елементи.
 *
 * @param buffer  Пълното съдържание на PDF файла като ArrayBuffer.
 * @returns       { safe: true } ако не са открити заплахи, иначе { safe: false, threats: [...] }.
 *
 * Производителност: TextDecoder('latin1') е единична нативна операция (~5 ms/50 MB)
 * — много по-бърза от String.fromCharCode итерации. Latin-1 = 1:1 byte→char, без загуба.
 */
export function scanPdf(buffer: ArrayBuffer): SanitizationResult {
  // TextDecoder('latin1') е native и обработва 50 MB за ~5-10 ms.
  // 'latin1' = ISO-8859-1: байт 0x00-0xFF → char 0x0000-0x00FF (1:1).
  const text = new TextDecoder('latin1').decode(buffer);

  const foundThreats: string[] = [];
  const seen = new Set<string>();

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (!seen.has(description) && text.includes(pattern)) {
      foundThreats.push(description);
      seen.add(description);
    }
  }

  return {
    safe: foundThreats.length === 0,
    threats: foundThreats,
  };
}
