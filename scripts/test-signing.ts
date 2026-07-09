/**
 * scripts/test-signing.ts
 * Integration тест: генерира реален подписан PDF за проверка в Adobe Reader.
 * ECDSA P-256 версия — използва Node.js crypto (гарантирано коректен DER).
 *
 * РЕЖИМИ:
 *   (а) Self-signed ECDSA P-256:
 *         npx tsx scripts/test-signing.ts
 *
 *   (б) Root CA chain (leaf ECDSA P-256 ← Root CA Ed25519):
 *         $env:ROOT_CA_PRIVATE_KEY_B64="paste-key-here"; npx tsx scripts/test-signing.ts
 *
 * ВАЖНО: production кодът (src/lib/) НЕ е модифициран.
 */

import { writeFileSync }                                    from 'node:fs';
import { join, dirname }                                    from 'node:path';
import { fileURLToPath }                                    from 'node:url';
import {
  generateKeyPairSync,
  sign as nodeSign,
  createPrivateKey,
  KeyObject,
}                                                           from 'node:crypto';
import { PDFDocument, rgb, StandardFonts }                  from 'pdf-lib';

import { buildSignedAttrs, extractCertInfo }                from '../src/lib/pdf/cmsBuilder';
import {
  preparePdfForSigning,
  computeByteRanges,
  patchByteRangeInPlace,
  hashByteRanges,
  injectSignatureAndPQ,
  encodeBase64url,
  type PqSignatureData,
}                                                           from '../src/lib/pdf/pdfSigner';
import { ROOT_CA_CERT_PEM }                                 from '../src/lib/crypto/rootCaCert';

// ─── OIDs ─────────────────────────────────────────────────────────────────────
// id-ecPublicKey  1.2.840.10045.2.1
const OID_EC_PUB_KEY   = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x02,0x01]);
// secp256r1  1.2.840.10045.3.1.7
const OID_SECP256R1    = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07]);
// ecdsa-with-SHA256  1.2.840.10045.4.3.2
const OID_ECDSA_SHA256 = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]);
// SHA-256  2.16.840.1.101.3.4.2.1
const OID_SHA256       = new Uint8Array([0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01]);
// id-data  1.2.840.113549.1.7.1
const OID_DATA         = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x07,0x01]);
// signedData  1.2.840.113549.1.7.2
const OID_SIGNED_DATA  = new Uint8Array([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x07,0x02]);
// id-Ed25519  1.3.101.112
const OID_ED25519      = new Uint8Array([0x2b,0x65,0x70]);
// id-at-commonName  2.5.4.3
const OID_CN           = new Uint8Array([0x55,0x04,0x03]);

// ─── Изходен файл ─────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = join(__dirname, '..', `test-signed-${Date.now()}.pdf`);

// ═══════════════════════════════════════════════════════════════════════════════
// ASN.1 DER helpers
// ═══════════════════════════════════════════════════════════════════════════════

function cat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total); let pos = 0;
  for (const a of arrs) { out.set(a, pos); pos += a.length; }
  return out;
}
function encLen(n: number): Uint8Array {
  if (n < 0x80)    return new Uint8Array([n]);
  if (n < 0x100)   return new Uint8Array([0x81, n]);
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  return new Uint8Array([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
const tlv     = (tag: number, v: Uint8Array) => cat(new Uint8Array([tag]), encLen(v.length), v);
const derSeq  = (v: Uint8Array) => tlv(0x30, v);
const derSet  = (v: Uint8Array) => tlv(0x31, v);
const derInt  = (v: Uint8Array) => tlv(0x02, v);
const derOid  = (v: Uint8Array) => tlv(0x06, v);
const derOcts = (v: Uint8Array) => tlv(0x04, v);
const derUtf8 = (s: string)     => tlv(0x0c, new TextEncoder().encode(s));
const derBits = (v: Uint8Array) => tlv(0x03, cat(new Uint8Array([0x00]), v));
const derGTime = (d: Date): Uint8Array => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}` +
            `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function pemToDer(pem: string): Uint8Array {
  return new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'));
}

// ─── ECDSA P-256 SubjectPublicKeyInfo (взима SPKI директно от Node.js KeyObject) ──

/**
 * Извлича SubjectPublicKeyInfo DER от Node.js EC public key.
 * Node.js гарантира коректно DER кодиране на SPKI.
 */
function getSpkiDer(pubKey: KeyObject): Uint8Array {
  return new Uint8Array(pubKey.export({ type: 'spki', format: 'der' }));
}

/**
 * Извлича raw 65-byte uncompressed point от Node.js EC SPKI DER.
 * P-256 SPKI = 91 bytes: fixed 26-byte header + 65-byte point.
 */
function getEcPubKeyPoint(pubKey: KeyObject): Uint8Array {
  const spki = getSpkiDer(pubKey);
  // P-256 SPKI е 91 байта: 30 59 30 13 [алг ID] 03 42 00 [65 bytes]
  // Последните 65 байта са uncompressed EC point
  return spki.slice(spki.length - 65);
}

// ─── Self-signed ECDSA P-256 X.509 ───────────────────────────────────────────

function buildSelfSignedEcdsaCert(ecPrivKey: KeyObject, ecPubKey: KeyObject): Uint8Array {
  const sigAlgId  = derSeq(derOid(OID_ECDSA_SHA256));   // parameters ABSENT (RFC 5480)
  const spkiDer   = getSpkiDer(ecPubKey);                // Node.js гарантирано коректен SPKI
  const name      = derSeq(derSet(derSeq(cat(derOid(OID_CN), derUtf8('SignShield ECDSA P-256 Test')))));
  const notBefore = new Date();
  const notAfter  = new Date(notBefore.getTime() + 365 * 24 * 3600_000);

  const tbs = derSeq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),   // version: v3
    derInt(new Uint8Array([0x01])),               // serialNumber: 1
    sigAlgId,                                     // signatureAlgorithm in TBS
    name,                                         // issuer
    derSeq(cat(derGTime(notBefore), derGTime(notAfter))),
    name,                                         // subject (same as issuer for self-signed)
    spkiDer,                                      // subjectPublicKeyInfo (от Node.js)
  ));

  // Node.js подписва TBS с ECDSA SHA-256 → DER-кодиран подпис
  const certSigDer = new Uint8Array(nodeSign('SHA256', tbs, ecPrivKey));
  return derSeq(cat(tbs, sigAlgId, derBits(certSigDer)));
}

// ─── Root CA-signed X.509 за ECDSA P-256 leaf ────────────────────────────────

function buildCaSignedEcdsaCert(
  ecPubKey: KeyObject,
  caPrivKey: KeyObject,
  issuerDN: Uint8Array,
): Uint8Array {
  // Root CA е ECDSA P-256 — cert signatureAlgorithm = ecdsa-with-SHA256
  const caSignAlgId = derSeq(derOid(OID_ECDSA_SHA256));
  const spkiDer     = getSpkiDer(ecPubKey);
  const subjectName = derSeq(derSet(derSeq(cat(derOid(OID_CN), derUtf8('SignShield ECDSA P-256 Test')))));
  const notBefore   = new Date();
  const notAfter    = new Date(notBefore.getTime() + 365 * 24 * 3600_000);

  const tbs = derSeq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),
    derInt(new Uint8Array([0x01])),
    caSignAlgId,
    issuerDN,
    derSeq(cat(derGTime(notBefore), derGTime(notAfter))),
    subjectName,
    spkiDer,
  ));

  // nodeSign('SHA256', ..., EC key) → DER-кодиран ECDSA-Sig-Value (SEQUENCE { r, s })
  const certSigDer = new Uint8Array(nodeSign('SHA256', tbs, caPrivKey));
  return derSeq(cat(tbs, caSignAlgId, derBits(certSigDer)));
}

// ─── Локален CMS builder (ECDSA P-256) ───────────────────────────────────────

function buildCmsEcdsaDetached(
  messageDigest: Uint8Array,
  ecdsaSigDer: Uint8Array,        // DER SEQUENCE { r, s } — директно от Node.js
  certDer: Uint8Array,            // Leaf cert
  caCertDer?: Uint8Array,         // Root CA cert (включва се за chain visibility)
): Uint8Array {
  const { issuerDN, serialNumberDer } = extractCertInfo(certDer);

  const sha256AlgId      = derSeq(derOid(OID_SHA256));
  const ecdsaSha256AlgId = derSeq(derOid(OID_ECDSA_SHA256));

  const signedAttrsDer      = buildSignedAttrs(messageDigest);
  const signedAttrsImplicit = cat(new Uint8Array([0xa0]), signedAttrsDer.slice(1));

  const issuerAndSerial = derSeq(cat(issuerDN, serialNumberDer));

  const signerInfo = derSeq(cat(
    derInt(new Uint8Array([0x01])),
    issuerAndSerial,
    sha256AlgId,
    signedAttrsImplicit,
    ecdsaSha256AlgId,
    derOcts(ecdsaSigDer),
  ));

  // Включваме leaf + CA cert (ако е подаден) за пълен chain в Adobe Reader
  const certsBuf = caCertDer ? cat(certDer, caCertDer) : certDer;

  const signedData = derSeq(cat(
    derInt(new Uint8Array([0x01])),
    derSet(sha256AlgId),
    derSeq(derOid(OID_DATA)),
    tlv(0xa0, certsBuf),
    derSet(signerInfo),
  ));

  return derSeq(cat(derOid(OID_SIGNED_DATA), tlv(0xa0, signedData)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const caKeyB64  = process.env['ROOT_CA_PRIVATE_KEY_B64'] ?? '';
const useRootCa = caKeyB64.length > 0;

console.log(useRootCa
  ? '🔒 Режим: ROOT CA-signed (leaf ECDSA P-256 ← Root CA ECDSA P-256)'
  : '⚠️  Режим: self-signed ECDSA P-256\n' +
    '   За реален chain: $env:ROOT_CA_PRIVATE_KEY_B64="..."; npx tsx scripts/test-signing.ts',
);

// ─── 1. ECDSA P-256 keypair с Node.js crypto ──────────────────────────────────

console.log('\n🔑 Генерираме ECDSA P-256 keypair (Node.js crypto)…');
const { privateKey: ecPrivKey, publicKey: ecPubKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPubPoint = getEcPubKeyPoint(ecPubKey);
console.log(`   Pub key (uncompressed): 0x04 ${toHex(ecPubPoint.slice(1, 5))}… (${ecPubPoint.length} bytes)`);

// ─── 2. X.509 сертификат ─────────────────────────────────────────────────────

let certDer: Uint8Array;

let caCertDer: Uint8Array | undefined;

if (useRootCa) {
  console.log('📜 Издаваме CA-signed X.509 за ECDSA P-256 key…');
  const caPrivKey = createPrivateKey({
    key: Buffer.from(caKeyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  caCertDer = pemToDer(ROOT_CA_CERT_PEM);
  const { issuerDN } = extractCertInfo(caCertDer);
  certDer = buildCaSignedEcdsaCert(ecPubKey, caPrivKey, issuerDN);
  console.log(`   Leaf cert DER: ${certDer.length} bytes`);
  console.log(`   Root CA cert:  ${caCertDer.length} bytes (вграден в CMS за chain visibility)`);
} else {
  console.log('📜 Строим self-signed ECDSA P-256 X.509…');
  certDer = buildSelfSignedEcdsaCert(ecPrivKey, ecPubKey);
  console.log(`   Cert DER: ${certDer.length} bytes  (самоподписан, Node.js crypto)`);
}

// ─── 3. Тест PDF ─────────────────────────────────────────────────────────────

console.log('📄 Създаваме тест PDF…');
const pdfDoc    = await PDFDocument.create();
const page      = pdfDoc.addPage([595, 842]);
const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

page.drawText('SignShield - ECDSA P-256 Integration Test', {
  x: 50, y: 780, size: 18, font: helvetica, color: rgb(0.1, 0.1, 0.6),
});
page.drawText('Algorithm: ECDSA P-256 / SHA-256 (adbe.pkcs7.detached)', {
  x: 50, y: 750, size: 12, font: helvetica, color: rgb(0.2, 0.2, 0.2),
});
page.drawText('Signed with Node.js crypto (standard DER encoding).', {
  x: 50, y: 730, size: 9, font: helvetica, color: rgb(0.4, 0.4, 0.4),
});
page.drawText(`Generated: ${new Date().toISOString()}`, {
  x: 50, y: 710, size: 9, font: helvetica, color: rgb(0.5, 0.5, 0.5),
});

const testPdfBytes = new Uint8Array(await pdfDoc.save());
console.log(`   PDF размер: ${testPdfBytes.length} bytes`);

// ─── 4. preparePdfForSigning ──────────────────────────────────────────────────

console.log('📝 preparePdfForSigning…');
const prepared = await preparePdfForSigning(
  testPdfBytes, 'SignShield ECDSA P-256 Test', new Date(), 30, 40,
);
console.log(`   PDF с placeholder: ${prepared.bytes.length} bytes`);
console.log(`   contentsOffset:    ${prepared.contentsOffset}`);
console.log(`   byteRangeNumOffset:${prepared.byteRangeNumOffset}`);

// ─── 5. ByteRange + hash ──────────────────────────────────────────────────────

const byteRange = computeByteRanges(prepared);
console.log(`   ByteRange:   [${byteRange.join(', ')}]`);
patchByteRangeInPlace(prepared, byteRange);

const messageDigest = hashByteRanges(prepared.bytes, byteRange);
console.log(`   SHA-256:     ${toHex(messageDigest)}`);

// ─── 6. buildSignedAttrs → ECDSA sign (Node.js crypto) ───────────────────────

console.log('✍️  Подписваме signedAttrs с ECDSA P-256 (Node.js crypto)…');
const signedAttrsDer = buildSignedAttrs(messageDigest);
console.log(`   signedAttrs: ${signedAttrsDer.length} bytes (tag: 0x${signedAttrsDer[0].toString(16)})`);

// Node.js createSign('SHA256') с EC ключ → ECDSA-with-SHA256, DER изход
// sign(algorithm, data, key) → DER-кодиран ECDSA-Sig-Value (SEQUENCE { r, s })
const ecdsaSigDer = new Uint8Array(nodeSign('SHA256', signedAttrsDer, ecPrivKey));
console.log(`   ECDSA sig DER: ${toHex(ecdsaSigDer).slice(0, 32)}… (${ecdsaSigDer.length} bytes, tag 0x${ecdsaSigDer[0].toString(16)})`);

// ─── 7. CMS ──────────────────────────────────────────────────────────────────

console.log('🔐 buildCmsEcdsaDetached…');
const cmsDer = buildCmsEcdsaDetached(messageDigest, ecdsaSigDer, certDer, caCertDer);
console.log(`   CMS DER: ${cmsDer.length} bytes (limit: 8192)`);
if (cmsDer.length > 8192) throw new Error(`CMS ${cmsDer.length}b надвишава placeholder!`);

// ─── 8. Mock PQ ──────────────────────────────────────────────────────────────

const pqData: PqSignatureData = {
  algorithm:       'ml-dsa-65',
  signedHash:      encodeBase64url(messageDigest),
  signatureB64url: encodeBase64url(new Uint8Array(32).fill(0xee)),
  publicKeyB64url: encodeBase64url(new Uint8Array(32).fill(0xdd)),
  attestation:     { note: 'MOCK — integration test only' },
  byteRange:       [...byteRange],
};

// ─── 9. inject ───────────────────────────────────────────────────────────────

console.log('💉 injectSignatureAndPQ…');
const signedPdfBytes = injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
console.log(`   Финален PDF: ${signedPdfBytes.length} bytes`);

// ─── 10. Записваме ───────────────────────────────────────────────────────────

writeFileSync(OUT_PATH, signedPdfBytes);
console.log(`\n✅ ЗАПИСАН: ${OUT_PATH}`);
console.log('\nСтруктурна проверка:');
console.log(`  CMS tag:       0x${cmsDer[0].toString(16).toUpperCase()} (очаква се 0x30)`);
console.log(`  Sig DER tag:   0x${ecdsaSigDer[0].toString(16).toUpperCase()} (очаква се 0x30)`);
console.log(`  Sig DER length: ${ecdsaSigDer.length} bytes (ECDSA DER: 70-72 bytes типично)`);
console.log('\nОтвори файла в Adobe Reader.');
if (useRootCa) {
  console.log('Очаквай: chain "SignShield ECDSA P-256 Test <- SignShield Root CA v1".');
  console.log('Adobe трябва да покаже 2 сертификата в панела (leaf + Root CA).');
  console.log('"Signature validity UNKNOWN" е нормално (Root CA не е в trusted store).');
} else {
  console.log('Очаквай: "Signature validity UNKNOWN" (self-signed).');
  console.log('НЕ трябва да има "Document has been altered" или "Unsupported algorithm".');
}
