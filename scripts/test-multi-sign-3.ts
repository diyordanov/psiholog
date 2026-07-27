/**
 * test-multi-sign-3.ts — Фаза 8, Ден 2 Стъпка 2: generalize incremental
 * signing primitive-а за N подписа (N=3).
 *
 * Подписва тестов PDF ТРИ ПЪТИ с различни ключове/сертификати (owner +
 * recipient1 + recipient2), над РЕАЛЕН Root CA chain, за ръчна проверка в
 * Adobe Reader. Разширява scripts/test-multi-sign.ts (2 подписа) с трети
 * append, потвърждавайки, че prepareIncrementalSignature() е N-агностична
 * (не хардкодва "втори подпис") — намира ПОСЛЕДНАТА ревизия на Catalog/
 * AcroForm/Page чрез findLastObjectDict, независимо от броя предходни подписи.
 *
 * НЕ включва /PostQuantumSignature — извън scope (виж бележка в pdfSigner.ts,
 * Стъпка 5).
 *
 * Изисквания:
 *   ROOT_CA_PRIVATE_KEY_B64 в .env.local (същия като test-e2e-signing.ts)
 *
 * Стартиране:
 *   npx tsx --env-file=.env.local scripts/test-multi-sign-3.ts
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
import { extractCmsDer as extractLastCmsDer } from '../src/lib/pdf/pdfVerifier';
import { parseCms, makeSignedAttrsSet } from '../src/lib/pdf/cmsParser';
import { ROOT_CA_CERT_PEM } from '../src/lib/crypto/rootCaCert';

// ─── DER helpers (копие от test-multi-sign.ts) ─────────────────────────────

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

/** Извлича Root CA subject DN директно от cert DER. */
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

/** Верифицира един CMS DER (извлечен ръчно за конкретния подпис) срещу изчисления hash. */
async function verifyExtractedSignature(
  label: string,
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
  cmsDer: Uint8Array,
): Promise<boolean> {
  const computedHash = hashByteRanges(pdfBytes, byteRange);
  const { leafCertDer, signedAttrsImplicit, messageDigest, ecdsaSigP1363 } = parseCms(cmsDer);

  const hashMatches = Array.from(messageDigest).every((b, i) => b === computedHash[i]);
  if (!hashMatches) {
    console.log(`   ${label}: ❌ messageDigest не съвпада с изчисления hash (документът е модифициран?)`);
    return false;
  }

  // leafCertDer идва от CMS-а — извличаме публичния ключ raw (P-256, uncompressed point)
  // чрез @peculiar/x509, както прави verifyEcdsaSignature() в verifyService.ts.
  const x509 = await import('@peculiar/x509');
  const leaf = new x509.X509Certificate(leafCertDer as unknown as Uint8Array<ArrayBuffer>);
  const publicKey = await leaf.publicKey.export();
  const signedAttrsSet = makeSignedAttrsSet(signedAttrsImplicit);

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    ecdsaSigP1363 as unknown as Uint8Array<ArrayBuffer>,
    signedAttrsSet as unknown as Uint8Array<ArrayBuffer>,
  );
  console.log(`   ${label}: ${valid ? '✅ valid' : '❌ invalid'} (signer: ${leaf.subject})`);
  return valid;
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

  // ── 1. Owner + recipient1 + recipient2 ключове + certs ─────────────────
  const signers = [
    { name: 'Дима Йорданов', serial: 20 },
    { name: 'Мария Тупарова', serial: 21 },
    { name: 'Иван Петров', serial: 22 },
  ];
  const signerKeys: CryptoKeyPair[] = [];
  const signerCerts: Uint8Array[] = [];
  for (const s of signers) {
    console.log(`\n🔑 ${s.name}: генериране на ECDSA P-256 ключ + leaf cert...`);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const certDer = await buildLeafCert(rawPub, caPrivKey, s.name, s.serial, now);
    signerKeys.push(kp);
    signerCerts.push(certDer);
    console.log(`   ✓ ${certDer.length} байта cert`);
  }

  // ── 2. Тестов PDF ────────────────────────────────────────────────────
  console.log('\n📝 Създаване на тестов PDF...');
  const testPdf = await PDFDocument.create();
  testPdf.registerFontkit(fontkit);
  const testFont = await testPdf.embedFont(fontBytes);
  const page = testPdf.addPage([595, 842]);
  page.drawText('Multi-signer тест: 3 подписа — SignShield (Ден 2 Стъпка 2)', { x: 50, y: 780, size: 14, font: testFont });
  signers.forEach((s, i) => {
    page.drawText(`Signer ${i + 1}: ${s.name}`, { x: 50, y: 748 - i * 20, size: 11, font: testFont });
  });
  page.drawText('Очаквано в Adobe Reader Signature Panel:', { x: 50, y: 680, size: 11, font: testFont });
  page.drawText('✓ 3 signatures, и трите "Signed and valid"', { x: 65, y: 660, size: 10, font: testFont });
  page.drawText('✓ "Document has not been modified"', { x: 65, y: 642, size: 10, font: testFont });
  const rawPdfBytes = new Uint8Array(await testPdf.save());
  console.log(`   PDF: ${rawPdfBytes.length.toLocaleString()} байта`);

  // ── 3. Signature 1 (owner) — стандартен single-signer flow, БЕЗ PQ ─────
  console.log(`\n✍️  Signature 1 (${signers[0].name})...`);
  const prepared1 = await preparePdfForSigning(rawPdfBytes, signers[0].name, now, {
    markerX: 30, markerY: 30, pageIndex: 0, fontBytes,
  });
  const byteRange1 = computeByteRanges(prepared1);
  patchByteRangeInPlace(prepared1, byteRange1);
  const digest1 = hashByteRanges(prepared1.bytes, byteRange1);
  const signedAttrs1 = buildSignedAttrs(digest1);
  const sigP1363_1 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signerKeys[0].privateKey, signedAttrs1));
  const cmsDer1 = buildCmsDetached(digest1, sigP1363_1, signerCerts[0], caCertDer);
  const signedOnce = injectSignatureAndPQ(prepared1, byteRange1, cmsDer1, null);
  console.log(`   ByteRange 1: [0, ${byteRange1[1]}, ${byteRange1[2]}, ${byteRange1[3]}]`);
  console.log(`   ✓ ${signedOnce.length.toLocaleString()} байта след signature 1`);

  // ── 4. Signature 2 (recipient1) — incremental primitive ─────────────────
  console.log(`\n✍️  Signature 2 (${signers[1].name}, incremental update)...`);
  const prepared2 = await prepareIncrementalSignature(signedOnce, signers[1].name, now, {
    markerX: 300, markerY: 30, pageIndex: 0, fieldName: 'Signature2',
  });
  const byteRange2 = computeByteRanges(prepared2);
  patchByteRangeInPlace(prepared2, byteRange2);
  const digest2 = hashByteRanges(prepared2.bytes, byteRange2);
  const signedAttrs2 = buildSignedAttrs(digest2);
  const sigP1363_2 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signerKeys[1].privateKey, signedAttrs2));
  const cmsDer2 = buildCmsDetached(digest2, sigP1363_2, signerCerts[1], caCertDer);
  const signedTwice = injectIncrementalSignature(prepared2, cmsDer2);
  console.log(`   ByteRange 2: [0, ${byteRange2[1]}, ${byteRange2[2]}, ${byteRange2[3]}]`);
  console.log(`   ✓ ${signedTwice.length.toLocaleString()} байта след signature 2`);

  // ── 5. Signature 3 (recipient2) — incremental primitive (append над 2-пъти подписан PDF) ──
  console.log(`\n✍️  Signature 3 (${signers[2].name}, incremental update)...`);
  const prepared3 = await prepareIncrementalSignature(signedTwice, signers[2].name, now, {
    markerX: 30, markerY: 90, pageIndex: 0, fieldName: 'Signature3',
  });
  const byteRange3 = computeByteRanges(prepared3);
  patchByteRangeInPlace(prepared3, byteRange3);
  const digest3 = hashByteRanges(prepared3.bytes, byteRange3);
  const signedAttrs3 = buildSignedAttrs(digest3);
  const sigP1363_3 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signerKeys[2].privateKey, signedAttrs3));
  const cmsDer3 = buildCmsDetached(digest3, sigP1363_3, signerCerts[2], caCertDer);
  const signedThrice = injectIncrementalSignature(prepared3, cmsDer3);
  console.log(`   ByteRange 3: [0, ${byteRange3[1]}, ${byteRange3[2]}, ${byteRange3[3]}]`);
  console.log(`   ✓ ${signedThrice.length.toLocaleString()} байта след signature 3`);

  // ── 6. Sanity checks: hash-ове на подпис 1 и 2 непроменени след append на 3 ──
  console.log('\n🔍 Sanity checks (hash непроменяемост)...');
  const recomputedDigest1 = hashByteRanges(signedThrice, byteRange1);
  const digest1Matches = Array.from(recomputedDigest1).every((b, i) => b === digest1[i]);
  console.log(`   Signature 1 hash непроменен след append на 2 и 3: ${digest1Matches ? '✅' : '❌ FAIL'}`);

  const recomputedDigest2 = hashByteRanges(signedThrice, byteRange2);
  const digest2Matches = Array.from(recomputedDigest2).every((b, i) => b === digest2[i]);
  console.log(`   Signature 2 hash непроменен след append на 3: ${digest2Matches ? '✅' : '❌ FAIL'}`);

  if (!digest1Matches || !digest2Matches) {
    console.error('❌ По-стар подпис е инвалидиран — спри и debug-вай преди Adobe тест!');
    process.exit(1);
  }

  const sigTypeMarker = new TextEncoder().encode('/Type /Sig');
  let sigCount = 0;
  let pos = findPattern(signedThrice, sigTypeMarker, 0);
  while (pos !== -1) { sigCount++; pos = findPattern(signedThrice, sigTypeMarker, pos + 1); }
  console.log(`   Брой /Type /Sig обекта: ${sigCount} ${sigCount === 3 ? '✅' : '❌ очаквано 3'}`);

  // ── 7. Верификация чрез extraction: signature 1, 2, 3 поотделно ──────────
  // pdfVerifier.extractCmsDer() е single-signature (взима ПОСЛЕДНИЯ /Contents,
  // виж бележка там — generalize за verify pipeline е Ден 3, не тук). За тази
  // проверка ползваме byteRange/cmsDer, вече известни от signing flow-а
  // по-горе (еквивалент на "extraction" за всеки подпис поотделно), плюс
  // потвърждаваме, че pdfVerifier намира последния (signature 3) коректно.
  console.log('\n🔍 Верификация на подписите поотделно (извлечени CMS данни)...');
  const valid1 = await verifyExtractedSignature('Signature 1', signedThrice, byteRange1, cmsDer1);
  const valid2 = await verifyExtractedSignature('Signature 2', signedThrice, byteRange2, cmsDer2);
  const valid3 = await verifyExtractedSignature('Signature 3', signedThrice, byteRange3, cmsDer3);

  const lastExtractedCms = extractLastCmsDer(signedThrice);
  const lastMatchesSig3 = !!lastExtractedCms
    && lastExtractedCms.length === cmsDer3.length
    && Array.from(lastExtractedCms).every((b, i) => b === cmsDer3[i]);
  console.log(`   pdfVerifier.extractCmsDer() намира ПОСЛЕДНИЯ подпис (signature 3): ${lastMatchesSig3 ? '✅' : '❌ FAIL'}`);

  if (!valid1 || !valid2 || !valid3 || !lastMatchesSig3) {
    console.error('❌ Верификацията провали — спри и debug-вай преди Adobe тест!');
    process.exit(1);
  }

  // ── 8. Запис ─────────────────────────────────────────────────────────
  mkdirSync('scripts/output', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `scripts/output/multi-signed-3-${ts}.pdf`;
  writeFileSync(outPath, signedThrice);

  console.log(`\n📁 Запазен: ${outPath}`);
  console.log('\n🔍 Провери в Adobe Reader:');
  console.log('   1. Отвори файла → Signature Panel (ляво)');
  console.log('   2. Показва ли 3 signatures?');
  signers.forEach((s, i) => console.log(`   ${3 + i}. Signature ${i + 1} (${s.name}) — "Signed and valid"?`));
  console.log('   6. "The document has not been modified since this signature was applied" за ВСИЧКИ 3?');
  console.log('   7. Chain build за трите (ако SignShield Root CA v1 е в trusted certificates)?');
  console.log('   8. Screenshot на Signature Panel + всеки от трите подписа — за PROGRESS.md.');
}

main().catch(e => {
  console.error('❌ Грешка:', e);
  process.exit(1);
});
