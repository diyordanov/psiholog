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
 * Важно: String.fromCharCode(...allBytes) гърми при файлове > ~500 KB (stack overflow),
 * затова четем байтовете на парчета от 8 KB.
 */
export function scanPdf(buffer: ArrayBuffer): SanitizationResult {
  // Декодираме байтовете като Latin-1 (1:1 byte → char mapping).
  // Latin-1 е безопасно за ASCII търсене — всеки байт 0–127 се маппва
  // директно към съответния ASCII символ, без трансформация.
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let text = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  const foundThreats: string[] = [];
  const seen = new Set<string>();

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    // Проверяваме дали описанието е добавено (обединяваме /JS /JS\r /JS\n под едно).
    if (text.includes(pattern) && !seen.has(description)) {
      foundThreats.push(description);
      seen.add(description);
    }
  }

  return {
    safe: foundThreats.length === 0,
    threats: foundThreats,
  };
}
