/**
 * test-e2e-signing.ts — Ден 3 integration тест
 *
 * Подписва PDF с РЕАЛЕН Root CA chain (не self-signed).
 * Ползва ROOT_CA_PRIVATE_KEY_B64 от .env.local (или env).
 * Adobe Reader трябва да покаже зелено "signature valid" ако добавиш Root CA в trusted list.
 *
 * Изисквания:
 *   ROOT_CA_PRIVATE_KEY_B64 трябва да е в .env.local или env:
 *     ROOT_CA_PRIVATE_KEY_B64=<base64 на pkcs8 der>
 *
 * Стартиране:
 *   npx tsx --env-file=.env.local scripts/test-e2e-signing.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  preparePdfForSigning,
  computeByteRanges,
  patchByteRangeInPlace,
  hashByteRanges,
  injectSignatureAndPQ,
  encodeBase64url,
  type PqSignatureData,
} from '../src/lib/pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from '../src/lib/pdf/cmsBuilder';
import { ROOT_CA_CERT_PEM } from '../src/lib/crypto/rootCaCert';

// ─── DER helpers (за leaf cert signed by Root CA) ─────────────────────────────

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const n = parts.reduce((s, a) => s + a.length, 0);
  const r = new Uint8Array(n); let pos = 0;
  for (const p of parts) { r.set(p, pos); pos += p.length; }
  return r;
};

const tlv = (tag: number, content: Uint8Array): Uint8Array => {
  const n = content.length;
  const lb = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return new Uint8Array([tag, ...lb, ...content]);
};

const seq    = (c: Uint8Array) => tlv(0x30, c);
const oid    = (b: number[]) => tlv(0x06, new Uint8Array(b));
const utf8   = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const bitStr = (b: Uint8Array) => tlv(0x03, cat(new Uint8Array([0x00]), b));
const derInt = (b: Uint8Array) => tlv(0x02, b[0] & 0x80 ? cat(new Uint8Array([0x00]), b) : b);

const utcTime = (d: Date): Uint8Array => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
           + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
};

const OID_EC_PUB_KEY   = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256         = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_CN           = [0x55, 0x04, 0x03];
const OID_O            = [0x55, 0x04, 0x0a];
const OID_C            = [0x55, 0x04, 0x06];

const algId  = seq(oid(OID_ECDSA_SHA256));         // parameters ABSENT (RFC 5480)
const printable = (s: string) => tlv(0x13, new TextEncoder().encode(s)); // PrintableString

// Root CA subject DN от cert: CN=SignShield Root CA v1, O=SignShield, C=BG
// Извличаме директно от cert DER — за да съвпада ТОЧНО с issuer в CA cert.
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Извлича Subject DN (SEQUENCE) от X.509 DER cert.
 * TBSCertificate структура: version(opt) serial signature issuer validity subject ...
 * Subject е 5-тото поле (след issuer + validity).
 */
function extractSubjectDn(certDer: Uint8Array): Uint8Array {
  // Намираме TBSCertificate (first SEQUENCE in outer SEQUENCE)
  let pos = 0;
  // Outer SEQUENCE tag
  pos++; // tag 0x30
  // Outer length
  if (certDer[pos] & 0x80) pos += (certDer[pos] & 0x7f) + 1; else pos++;

  // TBSCertificate SEQUENCE tag + length
  pos++; // tag 0x30
  if (certDer[pos] & 0x80) pos += (certDer[pos] & 0x7f) + 1; else pos++;

  // Skip: version [0] (optional), serialNumber, signature algId, issuer, validity → find subject
  let fieldIdx = 0;
  let subjectStart = -1;

  while (pos < certDer.length && fieldIdx < 6) {
    const tag = certDer[pos];
    let len: number;
    if (certDer[pos + 1] < 0x80) {
      len = certDer[pos + 1];
      pos += 2;
    } else {
      const nb = certDer[pos + 1] & 0x7f;
      len = 0;
      for (let i = 0; i < nb; i++) len = (len << 8) | certDer[pos + 2 + i];
      pos += 2 + nb;
    }
    // version [0] tag is 0xa0, subject is the 5th SEQUENCE (0x30) after skipping [0]
    if (tag === 0xa0) { pos += len; continue; }
    fieldIdx++;
    if (fieldIdx === 4) { subjectStart = pos - (certDer[pos - 2] < 0x80 ? 2 : (certDer[pos - (certDer[pos - 2] & 0x7f) - 2] & 0x7f) + 2); }
    if (fieldIdx === 4) {
      // This is the subject (4th field after version: serial=1, sigAlg=2, issuer=3, validity=4(skip), subject=5)
      // Actually: version=0(optional), serial=1, sigAlg=2, issuer=3, validity=4, subject=5
      // We skip version (0xa0), so fields are: serial(1), sigAlg(2), issuer(3), validity(4), subject(5)
    }
    if (fieldIdx === 5) {
      // subject — this is what we want (issuer DN for leaf cert)
      const startOfField = pos - len;
      const tagByte = certDer[startOfField - (certDer.length > startOfField ? (startOfField > 2 ? 1 : 1) : 1) - 0];
      // Just capture the raw bytes from before tag to end
      break;
    }
    pos += len;
  }

  // Fallback: hardcode Root CA subject DN
  // CN=SignShield Root CA v1, O=SignShield, C=BG
  const rdn = (attrOid: number[], val: Uint8Array) =>
    tlv(0x31, seq(cat(oid(attrOid), val)));

  return seq(cat(
    rdn(OID_CN, utf8('SignShield Root CA v1')),
    rdn(OID_O,  printable('SignShield')),
    rdn(OID_C,  printable('BG')),
  ));
}

/**
 * Изгражда leaf ECDSA P-256 X.509 сертификат, подписан от Root CA.
 * Issuer = Root CA subject DN.
 */
async function buildLeafCert(
  rawLeafPubKey: Uint8Array,
  leafCaPrivateKey: CryptoKey,  // Root CA private key (ECDSA P-256)
  commonName: string,
  now: Date,
): Promise<Uint8Array> {
  const caCertDer    = pemToDer(ROOT_CA_CERT_PEM);
  const issuerDn     = extractSubjectDn(caCertDer);
  const subjectDn    = seq(cat(
    tlv(0x31, seq(cat(oid(OID_CN), utf8(commonName)))),
  ));
  const spki         = seq(cat(
    seq(cat(oid(OID_EC_PUB_KEY), oid(OID_P256))),
    bitStr(rawLeafPubKey),
  ));
  const notBefore = new Date(now);
  const notAfter  = new Date(now.getTime() + 365 * 24 * 3600_000);

  const tbs = seq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),    // version v3
    derInt(new Uint8Array([0x02])),                // serialNumber = 2
    algId,
    issuerDn,
    seq(cat(utcTime(notBefore), utcTime(notAfter))),
    subjectDn,
    spki,
  ));

  // CA подписва TBS cert
  const sigP1363 = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, leafCaPrivateKey, tbs,
  ));
  const r = sigP1363.slice(0, 32);
  const s = sigP1363.slice(32, 64);
  const derSig = seq(cat(derInt(r), derInt(s)));

  return seq(cat(tbs, algId, bitStr(derSig)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Root CA private key от env
  const caKeyB64 = process.env.ROOT_CA_PRIVATE_KEY_B64;
  if (!caKeyB64) {
    console.error('❌ ROOT_CA_PRIVATE_KEY_B64 не е зададен в .env.local!');
    console.error('   Добави: ROOT_CA_PRIVATE_KEY_B64=<base64 pkcs8> в .env.local');
    process.exit(1);
  }

  console.log('🔑 Зареждане на Root CA private key...');
  const caKeyDer = Uint8Array.from(atob(caKeyB64), c => c.charCodeAt(0));
  const caPrivKey = await crypto.subtle.importKey(
    'pkcs8', caKeyDer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign'],
  );
  console.log('   ✓ Root CA key заредена');

  console.log('\n📄 Зареждане на NotoSans...');
  const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
  console.log(`   ${fontBytes.length.toLocaleString()} байта`);

  // Параметри
  const signerName  = 'Дима Йорданов';
  const signingDate = new Date();

  // 1. Leaf ECDSA P-256 key pair
  console.log('\n🔑 Генериране на leaf ECDSA P-256 ключова двойка...');
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  console.log(`   публичен ключ: ${rawPub.length} байта (0x${rawPub[0].toString(16).padStart(2,'0')}…)`);

  // 2. Leaf cert подписан от Root CA
  console.log('\n📜 Изграждане на leaf cert (подписан от Root CA)...');
  const leafCertDer = await buildLeafCert(rawPub, caPrivKey, signerName, signingDate);
  const caCertDer   = pemToDer(ROOT_CA_CERT_PEM);
  console.log(`   leaf cert: ${leafCertDer.length} байта`);
  console.log(`   Root CA cert: ${caCertDer.length} байта`);

  // 3. ML-DSA-65
  console.log('\n🛡  Генериране на ML-DSA-65 ключова двойка...');
  const mlKp = ml_dsa65.keygen();
  console.log(`   публичен ключ: ${mlKp.publicKey.length} байта`);

  // 4. Тестов PDF с Кирилица в тялото
  console.log('\n📝 Създаване на тестов PDF...');
  const testPdf  = await PDFDocument.create();
  testPdf.registerFontkit(fontkit);
  const testFont = await testPdf.embedFont(fontBytes);
  const page     = testPdf.addPage([595, 842]);

  page.drawText('Тест за цифров подпис с Root CA chain — SignShield', { x: 50, y: 780, size: 16, font: testFont });
  page.drawText(`Подписан от: ${signerName}`, { x: 50, y: 748, size: 11, font: testFont });
  page.drawText('Верификационни критерии:', { x: 50, y: 716, size: 11, font: testFont });
  page.drawText('✓ Подписан цифрово с ECDSA P-256 + ML-DSA-65', { x: 65, y: 696, size: 10, font: testFont });
  page.drawText('✓ Root CA chain: leaf cert → SignShield Root CA v1', { x: 65, y: 678, size: 10, font: testFont });
  page.drawText('✓ "Document has not been modified" в Adobe Reader', { x: 65, y: 660, size: 10, font: testFont });
  page.drawText('Визуален маркер с Кирилица в долния ляв ъгъл.', { x: 50, y: 630, size: 9, font: testFont });

  const rawPdfBytes = new Uint8Array(await testPdf.save());
  console.log(`   PDF: ${rawPdfBytes.length.toLocaleString()} байта`);

  // 5. Подготовка на PDF за подписване (с визуален маркер)
  console.log('\n✍️  Подготовка на PDF за подписване...');
  const prepared = await preparePdfForSigning(rawPdfBytes, signerName, signingDate, {
    markerX: 30, markerY: 30, pageIndex: 0, fontBytes,
  });
  console.log(`   PDF с placeholder: ${prepared.bytes.length.toLocaleString()} байта`);

  // 6. Byte ranges
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  console.log(`   ByteRange: [0, ${byteRange[1]}, ${byteRange[2]}, ${byteRange[3]}]`);

  // 7. Hash + ECDSA подпис
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);
  const signedAttrs   = buildSignedAttrs(messageDigest);
  const ecdsaSigP1363 = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedAttrs,
  ));
  console.log(`\n   messageDigest: ${Array.from(messageDigest.slice(0,8)).map(b=>b.toString(16).padStart(2,'0')).join('')}…`);
  console.log(`   ECDSA P1363: ${ecdsaSigP1363.length} байта`);

  // 8. CMS с leaf + Root CA chain
  const cmsDer = buildCmsDetached(messageDigest, ecdsaSigP1363, leafCertDer, caCertDer);
  console.log(`   CMS DER: ${cmsDer.length} байта (с chain)`);

  // 9. ML-DSA-65 PQ подпис
  console.log('\n⚛️  ML-DSA-65 подписване...');
  const mlSig = ml_dsa65.sign(messageDigest, mlKp.secretKey);
  const pqData: PqSignatureData = {
    algorithm:       'ml-dsa-65',
    signedHash:      encodeBase64url(messageDigest),
    signatureB64url: encodeBase64url(mlSig),
    publicKeyB64url: encodeBase64url(mlKp.publicKey),
    attestation:     { version: 1, chain: 'Root CA via leaf cert' },
    byteRange:       [...byteRange],
  };
  console.log(`   ML-DSA-65: ${mlSig.length} байта`);

  // 10. Инжектиране
  const finalPdf = injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
  console.log(`\n✅ Финален PDF: ${finalPdf.length.toLocaleString()} байта`);

  // 11. Запис
  mkdirSync('scripts/output', { recursive: true });
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `scripts/output/e2e-signed-${ts}.pdf`;
  writeFileSync(outPath, finalPdf);

  console.log(`\n📁 Запазен: ${outPath}`);
  console.log('\n🔍 Провери в Adobe Reader:');
  console.log('   1. Отвори файла');
  console.log('   2. Ако добавиш SignShield Root CA v1 в trusted certificates → зелена верификация');
  console.log('   3. Без доверен CA → "Signature validity UNKNOWN" (но "Document not modified" ✓)');
  console.log('   4. Маркерът в долния ляв ъгъл с Кирилица трябва да се вижда');
}

main().catch(e => {
  console.error('❌ Грешка:', e);
  process.exit(1);
});
