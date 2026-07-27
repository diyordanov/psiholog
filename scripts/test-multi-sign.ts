/**
 * test-multi-sign.ts — Фаза 8, Ден 2 Стъпка 1: multi-signer incremental primitive
 *
 * Подписва тестов PDF ДВА ПЪТИ с различни ключове/сертификати (owner +
 * recipient), над РЕАЛЕН Root CA chain, за ръчна проверка в Adobe Reader.
 *
 * НЕ включва /PostQuantumSignature — извън scope на Ден 2 Стъпка 1 (виж
 * бележка в pdfSigner.ts, Стъпка 5). Чист ECDSA/CMS incremental primitive тест.
 *
 * Изисквания:
 *   ROOT_CA_PRIVATE_KEY_B64 в .env.local (същия като test-e2e-signing.ts)
 *
 * Стартиране:
 *   npx tsx --env-file=.env.local scripts/test-multi-sign.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  preparePdfForSigning,
  computeByteRanges,
  patchByteRangeInPlace,
  hashByteRanges,
  injectSignatureAndPQ,
  prepareIncrementalSignature,
  injectIncrementalSignature,
  findPattern,
} from '../src/lib/pdf/pdfSigner';
import { buildSignedAttrs, buildCmsDetached } from '../src/lib/pdf/cmsBuilder';
import { ROOT_CA_CERT_PEM } from '../src/lib/crypto/rootCaCert';

// ─── DER helpers (копие от test-e2e-signing.ts — leaf cert подписан от Root CA) ──

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

const algId = seq(oid(OID_ECDSA_SHA256)); // parameters ABSENT (RFC 5480)

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** Извлича Root CA subject DN директно от cert DER (fallback: hardcoded, виж test-e2e-signing.ts). */
function rootCaSubjectDn(): Uint8Array {
  const printable = (s: string) => tlv(0x13, new TextEncoder().encode(s));
  const rdn = (attrOid: number[], val: Uint8Array) => tlv(0x31, seq(cat(oid(attrOid), val)));
  return seq(cat(
    rdn(OID_CN, utf8('SignShield Root CA v1')),
    rdn(OID_O,  printable('SignShield')),
    rdn(OID_C,  printable('BG')),
  ));
}

/** Изгражда leaf ECDSA P-256 X.509 сертификат, подписан от Root CA. */
async function buildLeafCert(
  rawLeafPubKey: Uint8Array,
  caPrivateKey: CryptoKey,
  commonName: string,
  serial: number,
  now: Date,
): Promise<Uint8Array> {
  const issuerDn  = rootCaSubjectDn();
  const subjectDn = seq(cat(tlv(0x31, seq(cat(oid(OID_CN), utf8(commonName))))));
  const spki      = seq(cat(seq(cat(oid(OID_EC_PUB_KEY), oid(OID_P256))), bitStr(rawLeafPubKey)));
  const notBefore = new Date(now);
  const notAfter  = new Date(now.getTime() + 365 * 24 * 3600_000);

  const tbs = seq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),
    derInt(new Uint8Array([serial])),
    algId,
    issuerDn,
    seq(cat(utcTime(notBefore), utcTime(notAfter))),
    subjectDn,
    spki,
  ));

  const sigP1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, caPrivateKey, tbs));
  const r = sigP1363.slice(0, 32);
  const s = sigP1363.slice(32, 64);
  const derSig = seq(cat(derInt(r), derInt(s)));

  return seq(cat(tbs, algId, bitStr(derSig)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const caKeyB64 = process.env.ROOT_CA_PRIVATE_KEY_B64;
  if (!caKeyB64) {
    console.error('❌ ROOT_CA_PRIVATE_KEY_B64 не е зададен в .env.local!');
    process.exit(1);
  }

  console.log('🔑 Зареждане на Root CA private key...');
  const caKeyDer  = Uint8Array.from(atob(caKeyB64), c => c.charCodeAt(0));
  const caPrivKey = await crypto.subtle.importKey('pkcs8', caKeyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const caCertDer = pemToDer(ROOT_CA_CERT_PEM);
  console.log('   ✓ Root CA key заредена');

  const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
  const now = new Date();

  // ── 1. Owner ключ + cert ──────────────────────────────────────────────
  console.log('\n🔑 Owner: генериране на ECDSA P-256 ключ + leaf cert...');
  const ownerName = 'Дима Йорданов';
  const ownerKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ownerRawPub = new Uint8Array(await crypto.subtle.exportKey('raw', ownerKp.publicKey));
  const ownerCertDer = await buildLeafCert(ownerRawPub, caPrivKey, ownerName, 10, now);
  console.log(`   ✓ ${ownerCertDer.length} байта cert`);

  // ── 2. Recipient ключ + cert ───────────────────────────────────────────
  console.log('\n🔑 Recipient: генериране на ECDSA P-256 ключ + leaf cert...');
  const recipientName = 'Мария Тупарова';
  const recipientKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const recipientRawPub = new Uint8Array(await crypto.subtle.exportKey('raw', recipientKp.publicKey));
  const recipientCertDer = await buildLeafCert(recipientRawPub, caPrivKey, recipientName, 11, now);
  console.log(`   ✓ ${recipientCertDer.length} байта cert`);

  // ── 3. Тестов PDF ────────────────────────────────────────────────────
  console.log('\n📝 Създаване на тестов PDF...');
  const testPdf = await PDFDocument.create();
  testPdf.registerFontkit(fontkit);
  const testFont = await testPdf.embedFont(fontBytes);
  const page = testPdf.addPage([595, 842]);
  page.drawText('Multi-signer тест: 2 подписа (owner + recipient) — SignShield', { x: 50, y: 780, size: 14, font: testFont });
  page.drawText(`Owner: ${ownerName}`, { x: 50, y: 748, size: 11, font: testFont });
  page.drawText(`Recipient: ${recipientName}`, { x: 50, y: 728, size: 11, font: testFont });
  page.drawText('Очаквано в Adobe Reader Signature Panel:', { x: 50, y: 696, size: 11, font: testFont });
  page.drawText('✓ 2 signatures, и двата "Signed and valid"', { x: 65, y: 676, size: 10, font: testFont });
  page.drawText('✓ "Document has not been modified"', { x: 65, y: 658, size: 10, font: testFont });
  const rawPdfBytes = new Uint8Array(await testPdf.save());
  console.log(`   PDF: ${rawPdfBytes.length.toLocaleString()} байта`);

  // ── 4. Signature 1 (owner) — стандартен single-signer flow, БЕЗ PQ ─────
  console.log('\n✍️  Signature 1 (owner)...');
  const prepared1 = await preparePdfForSigning(rawPdfBytes, ownerName, now, {
    markerX: 30, markerY: 30, pageIndex: 0, fontBytes,
  });
  const byteRange1 = computeByteRanges(prepared1);
  patchByteRangeInPlace(prepared1, byteRange1);
  const digest1 = hashByteRanges(prepared1.bytes, byteRange1);
  const signedAttrs1 = buildSignedAttrs(digest1);
  const sigP1363_1 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ownerKp.privateKey, signedAttrs1));
  const cmsDer1 = buildCmsDetached(digest1, sigP1363_1, ownerCertDer, caCertDer);
  const signedOnce = injectSignatureAndPQ(prepared1, byteRange1, cmsDer1, null);
  console.log(`   ByteRange 1: [0, ${byteRange1[1]}, ${byteRange1[2]}, ${byteRange1[3]}]`);
  console.log(`   ✓ ${signedOnce.length.toLocaleString()} байта след signature 1`);

  // ── 5. Signature 2 (recipient) — incremental primitive ─────────────────
  console.log('\n✍️  Signature 2 (recipient, incremental update)...');
  const prepared2 = await prepareIncrementalSignature(signedOnce, recipientName, now, {
    markerX: 300, markerY: 30, pageIndex: 0, fieldName: 'Signature2',
  });
  const byteRange2 = computeByteRanges(prepared2);
  patchByteRangeInPlace(prepared2, byteRange2);
  const digest2 = hashByteRanges(prepared2.bytes, byteRange2);
  const signedAttrs2 = buildSignedAttrs(digest2);
  const sigP1363_2 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, recipientKp.privateKey, signedAttrs2));
  const cmsDer2 = buildCmsDetached(digest2, sigP1363_2, recipientCertDer, caCertDer);
  const signedTwice = injectIncrementalSignature(prepared2, cmsDer2);
  console.log(`   ByteRange 2: [0, ${byteRange2[1]}, ${byteRange2[2]}, ${byteRange2[3]}]`);
  console.log(`   ✓ ${signedTwice.length.toLocaleString()} байта след signature 2`);

  // ── 6. Sanity checks преди запис ────────────────────────────────────────
  console.log('\n🔍 Sanity checks...');
  const recomputedDigest1 = hashByteRanges(signedTwice, byteRange1);
  const digest1Matches = Array.from(recomputedDigest1).every((b, i) => b === digest1[i]);
  console.log(`   Signature 1 hash непроменен след append на signature 2: ${digest1Matches ? '✅' : '❌ FAIL'}`);
  if (!digest1Matches) { console.error('❌ Signature 1 е инвалидиран — спри и debug-вай преди Adobe тест!'); process.exit(1); }

  const sigTypeMarker = new TextEncoder().encode('/Type /Sig');
  let sigCount = 0;
  let pos = findPattern(signedTwice, sigTypeMarker, 0);
  while (pos !== -1) { sigCount++; pos = findPattern(signedTwice, sigTypeMarker, pos + 1); }
  console.log(`   Брой /Type /Sig обекта: ${sigCount} ${sigCount === 2 ? '✅' : '❌ очаквано 2'}`);

  // ── 7. Запис ─────────────────────────────────────────────────────────
  mkdirSync('scripts/output', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `scripts/output/multi-signed-${ts}.pdf`;
  writeFileSync(outPath, signedTwice);

  console.log(`\n📁 Запазен: ${outPath}`);
  console.log('\n🔍 Провери в Adobe Reader:');
  console.log('   1. Отвори файла → Signature Panel (ляво)');
  console.log('   2. Показва ли 2 signatures?');
  console.log(`   3. Signature 1 (${ownerName}) — "Signed and valid"?`);
  console.log(`   4. Signature 2 (${recipientName}) — "Signed and valid"?`);
  console.log('   5. "The document has not been modified since this signature was applied" за ОБА?');
  console.log('   6. Chain build за двата (ако SignShield Root CA v1 е в trusted certificates)?');
}

main().catch(e => {
  console.error('❌ Грешка:', e);
  process.exit(1);
});