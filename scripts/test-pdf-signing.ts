/**
 * test-pdf-signing.ts — Ден 2 визуален маркер тест
 *
 * Ползва PRODUCTION pdfSigner.ts + cmsBuilder.ts.
 * Генерира self-signed ECDSA P-256 cert (само за тест — не е от Root CA).
 * Добавя реален ML-DSA-65 PQ подпис.
 *
 * Стартиране:
 *   npx tsx scripts/test-pdf-signing.ts
 *
 * Очакван резултат в Adobe Reader:
 *   ✓ Кирилица се вижда в маркера
 *   ✓ Signature details: "Document has not been modified"
 *   ⚠ Certificate invalid (self-signed — очаквано за тест)
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

// ─── DER helpers (за self-signed test cert) ───────────────────────────────────

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const n = parts.reduce((s, a) => s + a.length, 0);
  const r = new Uint8Array(n);
  let pos = 0;
  for (const p of parts) { r.set(p, pos); pos += p.length; }
  return r;
};

const tlv = (tag: number, content: Uint8Array): Uint8Array => {
  const n = content.length;
  const lb = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return new Uint8Array([tag, ...lb, ...content]);
};

const seq = (c: Uint8Array) => tlv(0x30, c);
const oid = (b: number[])   => tlv(0x06, new Uint8Array(b));
const utf8Str = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const bitStr = (b: Uint8Array) => tlv(0x03, cat(new Uint8Array([0x00]), b));

const derInt = (b: Uint8Array): Uint8Array =>
  tlv(0x02, b[0] & 0x80 ? cat(new Uint8Array([0x00]), b) : b);

const utcTime = (d: Date): Uint8Array => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
           + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
};

// ─── Константи за OID ─────────────────────────────────────────────────────────

const OID_EC_PUB_KEY   = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256         = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_CN           = [0x55, 0x04, 0x03];

// ─── Self-signed ECDSA P-256 X.509 cert (само за тест) ───────────────────────

async function buildTestCert(
  rawPubKey: Uint8Array,
  privateKey: CryptoKey,
  commonName: string,
  now: Date,
): Promise<Uint8Array> {
  const algId   = seq(oid(OID_ECDSA_SHA256));                          // parameters ABSENT
  const spki    = seq(cat(seq(cat(oid(OID_EC_PUB_KEY), oid(OID_P256))), bitStr(rawPubKey)));
  const rdnSeq  = (cn: string) => seq(tlv(0x31, seq(cat(oid(OID_CN), utf8Str(cn)))));

  const notBefore = new Date(now);
  const notAfter  = new Date(now.getTime() + 365 * 24 * 3600_000);    // 1 година

  const tbs = seq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),                          // version v3
    derInt(new Uint8Array([0x01])),                                      // serialNumber = 1
    algId,
    rdnSeq('SignShield Test CA'),
    seq(cat(utcTime(notBefore), utcTime(notAfter))),
    rdnSeq(commonName),
    spki,
  ));

  // Подписваме TBS с ECDSA P-256 SHA-256 → P1363 (64 байта)
  const sigP1363 = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, tbs,
  ));

  // P1363 → DER SEQUENCE { r INTEGER, s INTEGER }
  const r = sigP1363.slice(0, 32);
  const s = sigP1363.slice(32, 64);
  const derSig = seq(cat(derInt(r), derInt(s)));

  return seq(cat(tbs, algId, bitStr(derSig)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📄 Зареждане на NotoSans...');
  const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
  console.log(`   ${fontBytes.length.toLocaleString()} байта`);

  // Параметри за тест
  const signerName  = 'Дима Йорданов';
  const signingDate = new Date();

  // 1. Тестов PDF с Кирилица в тялото
  console.log('\n📝 Създаване на тестов PDF...');
  const testPdf = await PDFDocument.create();
  testPdf.registerFontkit(fontkit);
  const testFont = await testPdf.embedFont(fontBytes);
  const page = testPdf.addPage([595, 842]);  // A4

  page.drawText('Тест за цифров подпис — SignShield', {
    x: 50, y: 780, size: 18, font: testFont,
  });
  page.drawText(`Подписан от: ${signerName}`, {
    x: 50, y: 745, size: 12, font: testFont,
  });
  page.drawText('Това е тестов документ. Ако Adobe Reader показва:', {
    x: 50, y: 715, size: 11, font: testFont,
  });
  page.drawText('✓ "Document has not been modified"', {
    x: 70, y: 695, size: 11, font: testFont,
  });
  page.drawText('— подписването с визуален маркер работи коректно.', {
    x: 50, y: 675, size: 11, font: testFont,
  });
  page.drawText('Визуалният маркер е в долния ляв ъгъл на страницата.', {
    x: 50, y: 645, size: 10, font: testFont,
  });

  const rawPdfBytes = new Uint8Array(await testPdf.save());
  console.log(`   PDF: ${rawPdfBytes.length.toLocaleString()} байта`);

  // 2. ECDSA P-256 ключова двойка (WebCrypto — идентично на production flow)
  console.log('\n🔑 Генериране на ECDSA P-256 ключова двойка...');
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  console.log(`   публичен ключ: ${rawPub.length} байта (0x${rawPub[0].toString(16).padStart(2, '0')}…)`);

  // 3. Self-signed X.509 cert (само за тест)
  console.log('\n📜 Изграждане на self-signed сертификат...');
  const certDer = await buildTestCert(rawPub, privateKey, signerName, signingDate);
  console.log(`   сертификат: ${certDer.length} байта`);

  // 4. ML-DSA-65 ключова двойка за PQ подпис
  console.log('\n🛡  Генериране на ML-DSA-65 ключова двойка...');
  const mlKp = ml_dsa65.keygen();
  console.log(`   публичен ключ: ${mlKp.publicKey.length} байта`);

  // 5. Подготовка на PDF с визуален маркер (Ден 2 главна функция)
  console.log('\n✍️  Подготовка на PDF за подписване (с Кирилски маркер)...');
  const prepared = await preparePdfForSigning(rawPdfBytes, signerName, signingDate, {
    markerX: 30,
    markerY: 30,
    pageIndex: 0,
    fontBytes,
  });
  console.log(`   PDF с placeholder: ${prepared.bytes.length.toLocaleString()} байта`);

  // 6. Byte range математика
  const byteRange = computeByteRanges(prepared);
  patchByteRangeInPlace(prepared, byteRange);
  console.log(`   ByteRange: [0, ${byteRange[1]}, ${byteRange[2]}, ${byteRange[3]}]`);

  // 7. SHA-256 хеш на подписаните байтове
  const messageDigest = hashByteRanges(prepared.bytes, byteRange);
  console.log(`   messageDigest: ${Array.from(messageDigest.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}…`);

  // 8. SignedAttrs + ECDSA P-256 подпис (P1363, 64 байта)
  const signedAttrs   = buildSignedAttrs(messageDigest);
  const ecdsaSigP1363 = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedAttrs,
  ));
  console.log(`   ECDSA P1363 подпис: ${ecdsaSigP1363.length} байта`);

  // 9. CMS ContentInfo DER
  const cmsDer = buildCmsDetached(messageDigest, ecdsaSigP1363, certDer);
  console.log(`   CMS DER: ${cmsDer.length} байта`);

  // 10. ML-DSA-65 PQ подпис
  console.log('\n⚛️  ML-DSA-65 подписване...');
  const mlSig = ml_dsa65.sign(messageDigest, mlKp.secretKey);
  console.log(`   ML-DSA-65 подпис: ${mlSig.length} байта`);

  const pqData: PqSignatureData = {
    algorithm:       'ml-dsa-65',
    signedHash:      encodeBase64url(messageDigest),
    signatureB64url: encodeBase64url(mlSig),
    publicKeyB64url: encodeBase64url(mlKp.publicKey),
    attestation:     { version: 1, note: 'test-only — not from Root CA' },
    byteRange:       [...byteRange],
  };

  // 11. Инжектиране на подписа
  const finalPdf = injectSignatureAndPQ(prepared, byteRange, cmsDer, pqData);
  console.log(`\n✅ Финален PDF: ${finalPdf.length.toLocaleString()} байта`);

  // 12. Запис
  mkdirSync('scripts/output', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `scripts/output/test-signed-${ts}.pdf`;
  writeFileSync(outPath, finalPdf);

  console.log(`\n📁 Запазен: ${outPath}`);
  console.log('\n🔍 Провери в Adobe Reader:');
  console.log('   1. Отвори файла');
  console.log('   2. Виж маркера в долния ляв ъгъл — Кирилицата трябва да се чете');
  console.log('   3. Кликни върху маркера → "Signature Details"');
  console.log('   4. Трябва да пише "Document has not been modified"');
  console.log('   ⚠  Certificate chain ще е невалиден (self-signed тест) — очаквано');
}

main().catch(e => {
  console.error('❌ Грешка:', e);
  process.exit(1);
});
