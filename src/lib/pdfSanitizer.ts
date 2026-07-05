// PDF Sanitization — сканира raw байтовете на PDF за опасни елементи.
//
// Подход: търсим ASCII ключови думи директно в байтовете на файла.
// Ограничение (документирано в README): не хваща елементи в компресирани
// object streams (FlateDecode). За scope-а на курсовата работа е достатъчно.
//
// Референция: PROJECT_BRIEF.md Section 3.3

export interface SanitizationResult {
  safe: boolean;
  threats: string[];
}

// Двойки: [pattern в PDF, human-readable описание]
const DANGEROUS_PATTERNS: [string, string][] = [
  ['/JavaScript', 'вграден JavaScript (/JavaScript)'],
  ['/JS ',        'вграден JavaScript (/JS)'],
  ['/JS\r',       'вграден JavaScript (/JS)'],
  ['/JS\n',       'вграден JavaScript (/JS)'],
  ['/Launch',     'Launch action — стартира външна програма'],
  ['/EmbeddedFile', 'вграден файл (/EmbeddedFile)'],
  ['/SubmitForm', 'Submit-form action — изпраща данни към URL'],
  ['/ImportData', 'ImportData action'],
];

export function scanPdf(buffer: ArrayBuffer): SanitizationResult {
  // String.fromCharCode(...allBytes) crashes on large files (stack overflow).
  // Build the string in 8 KB chunks instead.
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let text = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  const foundThreats: string[] = [];
  const seen = new Set<string>();

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
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
