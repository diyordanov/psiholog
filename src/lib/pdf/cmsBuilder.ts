/**
 * cmsBuilder.ts
 * Изгражда CMS SignedData структура (PKCS#7) за PDF подписване (adbe.pkcs7.detached).
 *
 * Реализирано с ръчно ASN.1 DER кодиране — без npm зависимости за ASN.1 / CMS.
 * Форматът е съвместим с Adobe Reader (adbe.pkcs7.detached, SubFilter).
 *
 * Процес на подписване:
 *   1. SHA-256 хеш на PDF byte range → messageDigest
 *   2. buildSignedAttrs(messageDigest) → signedAttrsDer (SET, tag 0x31) — това подписваме
 *   3. crypto.subtle.sign(ECDSA P-256) → P1363 (64 байта r||s)
 *   4. buildCmsDetached(messageDigest, p1363Sig, certDer, caCertDer?) → пълен CMS ContentInfo DER
 */

// ─── ASN.1 DER primitives ────────────────────────────────────────────────────

function cat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}

function encLen(n: number): Uint8Array {
  if (n < 0x80)  return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  return new Uint8Array([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function tlv(tag: number, val: Uint8Array): Uint8Array {
  return cat(new Uint8Array([tag]), encLen(val.length), val);
}

const derSeq  = (v: Uint8Array) => tlv(0x30, v);
const derSet  = (v: Uint8Array) => tlv(0x31, v);
const derOid  = (v: Uint8Array) => tlv(0x06, v);
const derOcts = (v: Uint8Array) => tlv(0x04, v);
const derInt  = (v: Uint8Array) => tlv(0x02, v);

// ─── OID content bytes (without tag+len) ─────────────────────────────────────

// SHA-256: 2.16.840.1.101.3.4.2.1
const OID_SHA256          = new Uint8Array([0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01]);
// SignedData: 1.2.840.113549.1.7.2
const OID_SIGNED_DATA     = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x07,0x02]);
// id-data: 1.2.840.113549.1.7.1
const OID_DATA            = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x07,0x01]);
// contentType attr: 1.2.840.113549.1.9.3
const OID_CONTENT_TYPE    = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x09,0x03]);
// messageDigest attr: 1.2.840.113549.1.9.4
const OID_MESSAGE_DIGEST  = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x09,0x04]);
// ecdsa-with-SHA256: 1.2.840.10045.4.3.2
const OID_ECDSA_SHA256    = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]);

// AlgorithmIdentifiers
// SHA-256 без параметри (RFC 5754 §2: parameters MUST be absent)
const SHA256_ALG       = derSeq(derOid(OID_SHA256));
// ecdsa-with-SHA256 без параметри (RFC 5480 §2.1: parameters MUST be absent)
const ECDSA_SHA256_ALG = derSeq(derOid(OID_ECDSA_SHA256));

// ─── P1363 → DER конверсия за ECDSA подпис ───────────────────────────────────

/**
 * Конвертира WebCrypto P1363 подпис (64 байта r||s) в DER SEQUENCE { r INTEGER, s INTEGER }.
 * Нужно: WebCrypto връща P1363; CMS изисква DER (RFC 3279 §2.2.3).
 * Слага 0x00 prefix ако high bit на r/s е 1 (DER INTEGER е signed).
 */
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const r = p1363.slice(0, 32);
  const s = p1363.slice(32, 64);
  const encInt = (b: Uint8Array) =>
    derInt(b[0] & 0x80 ? cat(new Uint8Array([0x00]), b) : b);
  return tlv(0x30, cat(encInt(r), encInt(s)));
}

// ─── DER parser helpers (за извличане на issuer+serial от X.509) ──────────────

function readLen(buf: Uint8Array, pos: number): { len: number; next: number } {
  const first = buf[pos];
  if (first < 0x80) return { len: first, next: pos + 1 };
  const nb = first & 0x7f;
  let len = 0;
  for (let i = 0; i < nb; i++) len = (len << 8) | buf[pos + 1 + i];
  return { len, next: pos + 1 + nb };
}

function skipTlv(buf: Uint8Array, pos: number): number {
  pos++; // skip tag
  const { len, next } = readLen(buf, pos);
  return next + len;
}

/**
 * Извлича issuer DN и serialNumber INTEGER от X.509 сертификат (DER).
 * Нужно за IssuerAndSerialNumber поле в SignerInfo.
 */
export function extractCertInfo(certDer: Uint8Array): {
  issuerDN: Uint8Array;        // пълен DER на issuer SEQUENCE
  serialNumberDer: Uint8Array; // пълен DER на serial INTEGER (включва tag + len)
} {
  let pos = 0;
  // Outer Certificate SEQUENCE
  pos++; pos = readLen(certDer, pos).next;
  // TBSCertificate SEQUENCE
  pos++; pos = readLen(certDer, pos).next;
  // [0] version (опционален, tag 0xa0)
  if (certDer[pos] === 0xa0) pos = skipTlv(certDer, pos);
  // INTEGER serialNumber
  const snStart = pos;
  pos = skipTlv(certDer, pos);
  const serialNumberDer = certDer.slice(snStart, pos);
  // SEQUENCE signatureAlgorithm
  pos = skipTlv(certDer, pos);
  // SEQUENCE issuer DN
  const issuerStart = pos;
  pos = skipTlv(certDer, pos);
  return {
    issuerDN:      certDer.slice(issuerStart, pos),
    serialNumberDer,
  };
}

// ─── SignedAttrs ──────────────────────────────────────────────────────────────

/**
 * Изгражда signedAttrs като DER SET (tag 0x31).
 * Подписват се ТОЧНО тези байтове (ECDSA P-256 / SHA-256).
 * В SignerInfo се съхраняват с tag 0xa0 ([0] IMPLICIT) — виж buildCmsDetached.
 *
 * Съдържа два задължителни атрибута:
 *   - contentType: id-data (1.2.840.113549.1.7.1)
 *   - messageDigest: SHA-256 хеш на PDF byte range
 */
export function buildSignedAttrs(messageDigest: Uint8Array): Uint8Array {
  // Attribute: contentType = id-data
  const ctAttr = derSeq(cat(
    derOid(OID_CONTENT_TYPE),
    derSet(derOid(OID_DATA)),
  ));

  // Attribute: messageDigest = SHA-256 (32 bytes) като OCTET STRING
  const mdAttr = derSeq(cat(
    derOid(OID_MESSAGE_DIGEST),
    derSet(derOcts(messageDigest)),
  ));

  // DER SET — каноничен ред: contentType OID завършва на 0x03, messageDigest на 0x04
  return derSet(cat(ctAttr, mdAttr));
}

// ─── CMS SignedData ───────────────────────────────────────────────────────────

/**
 * Изгражда пълен CMS ContentInfo (SignedData) за adbe.pkcs7.detached.
 *
 * @param messageDigest   SHA-256 на PDF byte range (32 bytes)
 * @param ecdsaSigP1363   ECDSA P-256 подпис на buildSignedAttrs() — P1363 (64 байта r||s)
 *                        от crypto.subtle.sign(); конвертира се до DER вътрешно
 * @param certDer         DER-кодиран X.509 leaf сертификат
 * @param caCertDer       (опционален) DER-кодиран Root CA сертификат за chain
 * @returns               DER байтове на ContentInfo — вграждат се в /Contents на PDF
 */
export function buildCmsDetached(
  messageDigest: Uint8Array,
  ecdsaSigP1363: Uint8Array,
  certDer: Uint8Array,
  caCertDer?: Uint8Array,
): Uint8Array {
  const { issuerDN, serialNumberDer } = extractCertInfo(certDer);

  // P1363 → DER: WebCrypto връща r||s (64 байта); CMS изисква DER SEQUENCE { r, s }
  const ecdsaSigDer = p1363ToDer(ecdsaSigP1363);

  // EncapsulatedContentInfo: само eContentType (без eContent — detached)
  const encapContentInfo = derSeq(derOid(OID_DATA));

  // IssuerAndSerialNumber: SEQUENCE { issuer, serialNumber }
  const issuerAndSerial = derSeq(cat(issuerDN, serialNumberDer));

  // signedAttrs за вграждане в SignerInfo: съдържание е същото като buildSignedAttrs,
  // но тагът се сменя от 0x31 (SET) на 0xa0 ([0] IMPLICIT) за съхранение
  const signedAttrsDer = buildSignedAttrs(messageDigest);
  const signedAttrsImplicit = cat(
    new Uint8Array([0xa0]),        // сменяме тага
    signedAttrsDer.slice(1),       // запазваме length + content
  );

  // SignerInfo
  const signerInfo = derSeq(cat(
    derInt(new Uint8Array([0x01])),  // version: 1
    issuerAndSerial,
    SHA256_ALG,                       // digestAlgorithm: SHA-256 (без NULL — RFC 5754)
    signedAttrsImplicit,              // [0] IMPLICIT signedAttrs
    ECDSA_SHA256_ALG,                 // signatureAlgorithm: ecdsa-with-SHA256 (без параметри — RFC 5480)
    derOcts(ecdsaSigDer),             // signature: DER SEQUENCE { r INTEGER, s INTEGER }
  ));

  // Certificates: leaf + CA (ако е подаден) в [0] IMPLICIT CertificateSet
  const certsBuf = caCertDer ? cat(certDer, caCertDer) : certDer;

  // SignedData
  const signedData = derSeq(cat(
    derInt(new Uint8Array([0x01])),  // version: 1
    derSet(SHA256_ALG),               // digestAlgorithms: SET { SHA-256 }
    encapContentInfo,
    tlv(0xa0, certsBuf),              // [0] IMPLICIT certificates (CertificateSet)
    derSet(signerInfo),               // signerInfos: SET { SignerInfo }
  ));

  // ContentInfo: { contentType: signedData, content [0] EXPLICIT: SignedData }
  return derSeq(cat(
    derOid(OID_SIGNED_DATA),
    tlv(0xa0, signedData),
  ));
}
