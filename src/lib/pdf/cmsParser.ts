/**
 * cmsParser.ts
 * Мини DER/ASN.1 walker за извличане на данни от CMS SignedData.
 *
 * Имплементира само subset от ASN.1 DER, достатъчен за парсиране на
 * структурата произведена от buildCmsDetached() в cmsBuilder.ts.
 *
 * ─── ASN.1 схема на нашия CMS (за справка при бъдеща поддръжка) ────────────
 *
 * ContentInfo ::= SEQUENCE {
 *   contentType  OBJECT IDENTIFIER,           -- 1.2.840.113549.1.7.2 (signedData)
 *   content [0] EXPLICIT SignedData
 * }
 *
 * SignedData ::= SEQUENCE {
 *   version          INTEGER,                  -- 1
 *   digestAlgorithms SET OF AlgorithmIdentifier,
 *   encapContentInfo EncapsulatedContentInfo,  -- { eContentType: id-data } (detached)
 *   certificates [0] IMPLICIT CertificateSet, -- leaf cert + Root CA cert
 *   signerInfos      SET OF SignerInfo
 * }
 *
 * CertificateSet ::= SEQUENCE OF Certificate  -- embedded as raw DER; tag 0xA0 (IMPLICIT)
 *   -- certificates[0] = leaf cert (подписващият)
 *   -- certificates[1] = Root CA cert (верификационна верига)
 *
 * SignerInfo ::= SEQUENCE {
 *   version                INTEGER,            -- 1
 *   sid                    IssuerAndSerialNumber,
 *   digestAlgorithm        AlgorithmIdentifier,-- SHA-256
 *   signedAttrs [0] IMPLICIT SET OF Attribute, -- messageDigest + contentType
 *   signatureAlgorithm     AlgorithmIdentifier,-- ecdsa-with-SHA256
 *   signature              OCTET STRING        -- DER SEQUENCE { r INTEGER, s INTEGER }
 * }
 *
 * signedAttrs Attributes:
 *   contentType   ::= SEQUENCE { OID, SET { OID id-data } }
 *   messageDigest ::= SEQUENCE { OID, SET { OCTET STRING (SHA-256, 32 bytes) } }
 *
 * Критично за верификация:
 *   - signedAttrs се съхраняват с tag 0xA0 ([0] IMPLICIT) в SignerInfo
 *   - При верификация tagът се сменя обратно на 0x31 (SET) преди подаване към ECDSA
 *   - ECDSA подписва hash(signedAttrs_as_SET), не hash(PDF bytes) директно
 *   - PDF bytes hash → messageDigest attr → signedAttrs → ECDSA подпис
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── DER TLV primitives ───────────────────────────────────────────────────────

interface TLV {
  tag: number;
  value: Uint8Array;  // само value bytes (без tag и length)
  next: number;       // offset в оригиналния буфер след края на TLV
}

/**
 * Чете един DER TLV от bytes[offset].
 * Поддържа: single-byte tag, 1/2/3-byte length (definite form).
 */
function readTlv(bytes: Uint8Array, offset: number): TLV {
  const tag = bytes[offset];
  let pos = offset + 1;

  // Length decoding
  const firstLen = bytes[pos++];
  let len: number;
  if (firstLen < 0x80) {
    len = firstLen;
  } else {
    const numBytes = firstLen & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) {
      len = (len << 8) | bytes[pos++];
    }
  }

  return {
    tag,
    value: bytes.subarray(pos, pos + len),
    next: pos + len,
  };
}

/**
 * Итерира последователно TLV-та вътре в value bytes.
 * Удобно за обхождане на SEQUENCE и SET съдържание.
 */
function* iterTlvs(bytes: Uint8Array): Generator<TLV & { offset: number }> {
  let pos = 0;
  while (pos < bytes.length) {
    const tlv = readTlv(bytes, pos);
    yield { ...tlv, offset: pos };
    pos = tlv.next - 0; // next е absolute в оригиналния bytes
    // Тъй като bytes е subarray, next е относително спрямо оригиналния буфер.
    // readTlv работи с offset в bytes, next = pos_in_bytes + len
    // Трябва да го нормализираме:
    break; // readTlv.next е в пространството на bytes, не subarray
  }
  // NOTE: горната имплементация е неправилна за вложени subarray.
  // Коригираме с локален offset:
}

/**
 * Итерира TLV-та вътре в bytes с ЛОКАЛЕН offset (0-based в bytes).
 */
function iterChildren(bytes: Uint8Array): TLV[] {
  const result: TLV[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes[pos] === 0x00) break; // DER не позволява tag 0x00 (padding в BER, не DER)
    const tag = bytes[pos];
    let lenPos = pos + 1;
    const firstLen = bytes[lenPos++];
    let len: number;
    if (firstLen < 0x80) {
      len = firstLen;
    } else {
      const nb = firstLen & 0x7f;
      len = 0;
      for (let i = 0; i < nb; i++) len = (len << 8) | bytes[lenPos++];
    }
    const valueStart = lenPos;
    const valueEnd   = valueStart + len;
    result.push({
      tag,
      value: bytes.subarray(valueStart, valueEnd),
      next: valueEnd,
    });
    pos = valueEnd;
  }
  return result;
}

// ─── OID bytes (за разпознаване на атрибути) ──────────────────────────────────

// messageDigest: 1.2.840.113549.1.9.4
const OID_MESSAGE_DIGEST = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x09,0x04]);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ─── DER ECDSA signature conversion ──────────────────────────────────────────

/**
 * Конвертира DER SEQUENCE { r INTEGER, s INTEGER } → P1363 (r||s, по 32 байта).
 *
 * CMS съхранява ECDSA подписа в DER формат (RFC 3279 §2.2.3).
 * WebCrypto verify() очаква P1363 (IEEE 1363) формат.
 * DER INTEGER може да има водещ 0x00 byte (sign bit); P1363 е unsigned, fixed-length.
 */
export function derToP1363(derSig: Uint8Array): Uint8Array {
  const [seq] = iterChildren(derSig);               // outer SEQUENCE (tag 0x30)
  if (!seq || seq.tag !== 0x30) throw new Error('Невалиден DER ECDSA подпис: очакван SEQUENCE');
  const [rTlv, sTlv] = iterChildren(seq.value);     // r INTEGER, s INTEGER
  if (!rTlv || !sTlv) throw new Error('Невалиден DER ECDSA подпис: липсват r/s');

  // Премахваме водещ 0x00 padding (DER signed → P1363 unsigned)
  let r = rTlv.value;
  let s = sTlv.value;
  if (r[0] === 0x00) r = r.subarray(1);
  if (s[0] === 0x00) s = s.subarray(1);

  // P1363: r и s са с дължина 32 байта за P-256 (padding с нули вляво)
  const p1363 = new Uint8Array(64);
  p1363.set(r, 32 - r.length);
  p1363.set(s, 64 - s.length);
  return p1363;
}

// ─── Публично API ─────────────────────────────────────────────────────────────

export interface ParsedCms {
  /** DER на leaf сертификата (първият в certificates [0] IMPLICIT). */
  leafCertDer: Uint8Array;
  /**
   * signedAttrs bytes с оригинален tag 0xA0 ([0] IMPLICIT от SignerInfo).
   * За верификация: сменете 0xA0 → 0x31 (SET) — вижте makeSignedAttrsSet().
   */
  signedAttrsImplicit: Uint8Array;
  /** SHA-256 хеш на PDF byte range (32 bytes) — от messageDigest атрибут. */
  messageDigest: Uint8Array;
  /**
   * ECDSA подпис в P1363 формат (64 bytes r||s) — готов за crypto.subtle.verify().
   * Конвертиран от DER SEQUENCE вътрешно.
   */
  ecdsaSigP1363: Uint8Array;
}

/**
 * Конвертира signedAttrs от [0] IMPLICIT (0xA0) → SET (0x31) за верификация.
 *
 * CMS изисква: при подписване подписваме SET-tagged signedAttrs.
 * При съхранение в SignerInfo тагът се сменя на [0] IMPLICIT (0xA0).
 * При верификация трябва да го върнем обратно на 0x31.
 */
export function makeSignedAttrsSet(signedAttrsImplicit: Uint8Array): Uint8Array {
  const result = new Uint8Array(signedAttrsImplicit);
  result[0] = 0x31; // 0xA0 → SET
  return result;
}

/**
 * Парсира CMS DER и извлича данните нужни за верификация на ECDSA подпис.
 *
 * Навигационен path (вижте ASN.1 схемата по-горе):
 *   ContentInfo SEQUENCE
 *     → OID (пропускаме)
 *     → [0] EXPLICIT (tag 0xA0) → SignedData SEQUENCE
 *         → version INTEGER (пропускаме)
 *         → digestAlgorithms SET (пропускаме)
 *         → encapContentInfo SEQUENCE (пропускаме)
 *         → certificates [0] IMPLICIT (tag 0xA0)
 *             → first SEQUENCE = leaf cert DER
 *         → signerInfos SET
 *             → first SEQUENCE = SignerInfo
 *                 → version INTEGER (пропускаме)
 *                 → IssuerAndSerialNumber SEQUENCE (пропускаме)
 *                 → digestAlgorithmID SEQUENCE (пропускаме)
 *                 → signedAttrs [0] IMPLICIT (tag 0xA0)
 *                 → signatureAlgorithmID SEQUENCE (пропускаме)
 *                 → signature OCTET STRING
 */
export function parseCms(cmsBytes: Uint8Array): ParsedCms {
  // ── ContentInfo: outer SEQUENCE ──
  const contentInfo = readTlv(cmsBytes, 0);
  if (contentInfo.tag !== 0x30) throw new Error('Невалиден CMS: очакван SEQUENCE');

  const contentInfoChildren = iterChildren(contentInfo.value);
  // [0] = OID (signedData), [1] = [0] EXPLICIT (tag 0xA0 за explicit wrap)
  const explicitWrap = contentInfoChildren[1];
  if (!explicitWrap || explicitWrap.tag !== 0xa0) throw new Error('Невалиден CMS: липсва [0] EXPLICIT');

  // ── SignedData: SEQUENCE вътре в [0] EXPLICIT ──
  const signedDataTlv = readTlv(explicitWrap.value, 0);
  if (signedDataTlv.tag !== 0x30) throw new Error('Невалиден CMS: очакван SignedData SEQUENCE');

  const sdChildren = iterChildren(signedDataTlv.value);
  // Очакваме: [0]=version, [1]=digestAlgorithms, [2]=encapContentInfo,
  //           [3]=certificates [0xA0], [4]=signerInfos SET [0x31]
  // Но [3] и [4] имат специфични тагове — намираме ги по tag:

  let certificatesNode: TLV | undefined;
  let signerInfosNode: TLV | undefined;

  for (const child of sdChildren) {
    if (child.tag === 0xa0 && !certificatesNode) certificatesNode = child;
    // digestAlgorithms SET (0x31) идва преди signerInfos SET (0x31) →
    // взимаме последния 0x31, който е signerInfos
    if (child.tag === 0x31) signerInfosNode = child;
  }

  if (!certificatesNode) throw new Error('Невалиден CMS: липсват certificates [0] IMPLICIT');
  if (!signerInfosNode)  throw new Error('Невалиден CMS: липсват signerInfos SET');

  // ── Leaf cert: first SEQUENCE в certificates [0xA0] ──
  const certChildren = iterChildren(certificatesNode.value);
  const leafCertTlv  = certChildren[0];
  if (!leafCertTlv || leafCertTlv.tag !== 0x30) throw new Error('Невалиден CMS: липсва leaf cert');

  // Реконструираме пълния DER на leaf cert (tag + len + value)
  const leafCertFullLen = leafCertTlv.next; // next = end offset in certificatesNode.value
  const leafCertDer = certificatesNode.value.subarray(0, leafCertFullLen);

  // ── SignerInfo: first SEQUENCE в signerInfos SET ──
  const signerInfoChildren = iterChildren(signerInfosNode.value);
  const signerInfoTlv      = signerInfoChildren[0];
  if (!signerInfoTlv || signerInfoTlv.tag !== 0x30) throw new Error('Невалиден CMS: липсва SignerInfo');

  const siChildren = iterChildren(signerInfoTlv.value);
  // [0]=version, [1]=issuerAndSerialNumber, [2]=digestAlgID,
  // [3]=signedAttrs [0xA0], [4]=signatureAlgID, [5]=signature OCTET STRING

  let signedAttrsNode: TLV | undefined;
  let signatureNode: TLV  | undefined;

  // signedAttrs е [0] IMPLICIT (0xA0) — в SignerInfo context
  // signature е OCTET STRING (0x04)
  // Разграничаваме двете 0xA0 (certificates и signedAttrs) по контекст:
  // тук сме вътре в SignerInfo, така 0xA0 е signedAttrs
  for (const child of siChildren) {
    if (child.tag === 0xa0) signedAttrsNode = child;
    if (child.tag === 0x04) signatureNode   = child;
  }

  if (!signedAttrsNode) throw new Error('Невалиден CMS: липсват signedAttrs [0] IMPLICIT');
  if (!signatureNode)   throw new Error('Невалиден CMS: липсва signature OCTET STRING');

  // ── signedAttrsImplicit: реконструираме пълните байтове (tag + len + value) ──
  // Нужни за makeSignedAttrsSet() → верификация
  const signedAttrsStart = signerInfoTlv.value.indexOf(signedAttrsNode.tag as never);
  // По-надеждно: намираме offset на signedAttrsNode в siChildren
  // Всъщност iterChildren ни дава value без оригиналния offset.
  // Трябва да реконструираме tag+len+value:
  const signedAttrsImplicit = rebuildTlv(0xa0, signedAttrsNode.value);

  // ── messageDigest: извлича се от signedAttrs ──
  const messageDigest = extractMessageDigest(signedAttrsNode.value);

  // ── ECDSA sig: OCTET STRING съдържа DER SEQUENCE{r,s} ──
  const ecdsaSigP1363 = derToP1363(signatureNode.value);

  return { leafCertDer, signedAttrsImplicit, messageDigest, ecdsaSigP1363 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Реконструира пълен TLV (tag + encoded length + value) от отделните части.
 * Нужно когато имаме само value bytes и искаме пълния DER запис.
 */
function rebuildTlv(tag: number, value: Uint8Array): Uint8Array {
  const lenBytes = encLen(value.length);
  const result   = new Uint8Array(1 + lenBytes.length + value.length);
  result[0] = tag;
  result.set(lenBytes, 1);
  result.set(value, 1 + lenBytes.length);
  return result;
}

function encLen(n: number): Uint8Array {
  if (n < 0x80)    return new Uint8Array([n]);
  if (n < 0x100)   return new Uint8Array([0x81, n]);
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  return new Uint8Array([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/**
 * Извлича messageDigest OCTET STRING от signedAttrs value bytes.
 *
 * signedAttrs съдържа Attribute SEQUENCE-и. Намираме тази с OID messageDigest
 * и извличаме OCTET STRING вътре.
 * Очакваме SHA-256 → 32 bytes.
 */
function extractMessageDigest(signedAttrsValue: Uint8Array): Uint8Array {
  const attrs = iterChildren(signedAttrsValue);
  for (const attr of attrs) {
    if (attr.tag !== 0x30) continue;
    const attrChildren = iterChildren(attr.value);
    const oidTlv = attrChildren[0];
    if (!oidTlv || oidTlv.tag !== 0x06) continue;
    if (!bytesEqual(oidTlv.value, OID_MESSAGE_DIGEST)) continue;

    // Намерихме messageDigest attr: SET { OCTET STRING }
    const setTlv = attrChildren[1];
    if (!setTlv || setTlv.tag !== 0x31) continue;
    const octChildren = iterChildren(setTlv.value);
    const octTlv = octChildren[0];
    if (!octTlv || octTlv.tag !== 0x04) continue;
    if (octTlv.value.length !== 32) {
      throw new Error(`Неподдържан hash algorithm: очакван SHA-256 (32 bytes), получен ${octTlv.value.length} bytes`);
    }
    return octTlv.value;
  }
  throw new Error('Невалиден CMS: липсва messageDigest атрибут');
}
