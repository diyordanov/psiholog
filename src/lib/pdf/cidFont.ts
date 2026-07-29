/**
 * cidFont.ts
 * Subset Unicode (Type0/CIDFontType2) font embedding за recipient маркерите
 * в incremental PDF updates (Ден 6 hotfix v2 — пълна кирилица, вместо
 * латиница транслитерация).
 *
 * За разлика от owner-ския маркер (preparePdfForSigning), който минава през
 * нормален pdf-lib `embedFont()`/`drawText()` round-trip, incremental update-ът
 * се строи ръчно байт-по-байт (виж бележката в началото на Стъпка 5 в
 * pdfSigner.ts) — не можем да ползваме pdf-lib директно за font embedding
 * там. Вместо да реимплементираме subsetting логиката, ползваме fontkit
 * (същата библиотека, която pdf-lib ползва вътрешно за embedFont) директно,
 * и ръчно строим само 4-те нужни PDF обекта (Type0, CIDFont, FontDescriptor,
 * FontFile2) като raw байтове/текст — по същия "raw template" стил, който
 * вече се ползва за Sig/Widget обектите в prepareIncrementalSignature().
 *
 * Съзнателно НЕ строим /ToUnicode CMap (нужен само за text search/copy-paste
 * в PDF viewer-и, не за визуално рендиране) — намалява scope/риск; документ.
 * като известно ограничение.
 */
import fontkit from '@pdf-lib/fontkit';

export interface CidGlyphInfo {
  cid: number;           // subset glyph ID (= CID, защото CIDToGIDMap=/Identity)
  widthPer1000: number;  // advance width, скалирана до 1000 units/em (PDF glyph space)
}

export interface EmbeddedCidFont {
  fontFileBytes: Uint8Array;         // subset TTF бинарни данни (FontFile2 stream съдържание)
  postscriptName: string;
  ascent: number;                    // вече скалирани до 1000 units/em
  descent: number;
  capHeight: number;
  italicAngle: number;
  bbox: [number, number, number, number];
  glyphs: Map<number, CidGlyphInfo>; // Unicode codepoint → glyph info
  subsetTag: string;                 // 6 главни латински букви, конвенция за subset BaseFont ("ABCDEF+PostscriptName")
}

/** Генерира случаен 6-буквен subset tag (PDF конвенция за embedded subset шрифтове). */
function generateSubsetTag(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}

/** Събира `Subset.encodeStream()` (event-based) в единичен Uint8Array. */
function encodeSubsetStream(subset: ReturnType<ReturnType<typeof fontkit.create>['createSubset']>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    subset.encodeStream()
      .on('data', (chunk: Uint8Array) => chunks.push(chunk))
      .on('end', () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) { out.set(c, pos); pos += c.length; }
        resolve(out);
      });
    // encodeStream няма документиран 'error' event в типовете — ако fontkit
    // хвърли синхронно (невалиден font buffer), Promise-ът остава pending;
    // приемливо за MVP (fontBytes идва от собствен статичен /fonts/ asset,
    // не от user input).
    void reject;
  });
}

/**
 * Строи subset на подадения TTF шрифт, съдържащ ТОЧНО глифите нужни за
 * `sampleText` (комбинация от всички низове, които ще се рисуват в маркера —
 * фиксирани labels + динамичното signerName + датата).
 */
export async function buildCidFontSubset(fontBytes: Uint8Array, sampleText: string): Promise<EmbeddedCidFont> {
  const font = fontkit.create(fontBytes);
  const subset = font.createSubset();
  const scale = 1000 / font.unitsPerEm;

  const glyphs = new Map<number, CidGlyphInfo>();
  const codepoints = new Set<number>();
  for (const ch of sampleText) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) codepoints.add(cp);
  }

  for (const cp of codepoints) {
    const glyphList = font.glyphsForString(String.fromCodePoint(cp));
    const g = glyphList[0];
    if (!g) continue; // липсващ глиф (напр. непокрит от шрифта символ) — пропускаме, encodeCidHexString fallback-ва на 0
    const newId = subset.includeGlyph(g.id);
    glyphs.set(cp, { cid: newId, widthPer1000: Math.round(g.advanceWidth * scale) });
  }

  const fontFileBytes = await encodeSubsetStream(subset);
  const [minX, minY, maxX, maxY] = [font.bbox.minX, font.bbox.minY, font.bbox.maxX, font.bbox.maxY];

  return {
    fontFileBytes,
    postscriptName: font.postscriptName ?? 'EmbeddedFont',
    ascent: Math.round(font.ascent * scale),
    descent: Math.round(font.descent * scale),
    capHeight: Math.round((font.capHeight || font.ascent) * scale),
    italicAngle: font.italicAngle || 0,
    bbox: [Math.round(minX * scale), Math.round(minY * scale), Math.round(maxX * scale), Math.round(maxY * scale)],
    glyphs,
    subsetTag: generateSubsetTag(),
  };
}

/**
 * Кодира текст в PDF hex string литерал (`<XXXX...>`, 2 байта/глиф, big-endian
 * CID) за `Tj` оператор с /Encoding /Identity-H. Липсващ глиф → CID 0
 * (.notdef, рендира като празно/box placeholder вместо да чупи низа).
 */
export function encodeCidHexString(text: string, glyphs: Map<number, CidGlyphInfo>): string {
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const cid = (cp !== undefined ? glyphs.get(cp)?.cid : undefined) ?? 0;
    hex += cid.toString(16).padStart(4, '0');
  }
  return `<${hex}>`;
}

/** Построява /W (widths) масив съдържанието: "cid1 [w1] cid2 [w2] ...". */
export function buildWidthsArray(glyphs: Map<number, CidGlyphInfo>): string {
  return Array.from(glyphs.values()).map(g => `${g.cid} [${g.widthPer1000}]`).join(' ');
}
