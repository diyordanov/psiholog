/**
 * generate-root-ca.mjs
 * Еднократен скрипт за генериране на Root CA keypair + self-signed X.509 сертификат.
 *
 * Изисква Node.js 18+ (нативен WebCrypto с Ed25519 поддръжка).
 *
 * Използване:
 *   npm run generate-root-ca
 *   (или: node scripts/generate-root-ca.mjs)
 *
 * Изход:
 *   supabase/root-ca/root-ca-cert.pem  — публичен сертификат (commit-ва се в repo)
 *   Конзолата показва ROOT_CA_PRIVATE_KEY_B64 и ROOT_CA_CERT_PEM → paste в Supabase Secrets
 *
 * ВАЖНО: Частният ключ (ROOT_CA_PRIVATE_KEY_B64) НЕ се записва в никакъв файл в repo-то.
 *        Копирай го САМО в Supabase Dashboard → Edge Functions → Secrets.
 *        Запази резервно копие в личен password manager (1Password / Bitwarden).
 */

import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Използваме @peculiar/webcrypto за гарантирана съвместимост
const nodeCrypto = new Crypto();
x509.cryptoProvider.set(nodeCrypto);

console.log('🔑 Генерираме Root CA Ed25519 keypair…');

const keys = await nodeCrypto.subtle.generateKey(
  { name: 'Ed25519' },
  true,       // extractable = true, за да можем да exportKey
  ['sign', 'verify'],
);

// 10-годишен срок за Root CA
const notBefore = new Date();
const notAfter = new Date(notBefore.getTime() + 10 * 365.25 * 24 * 3600 * 1000);

console.log('📜 Генерираме self-signed X.509 сертификат…');

const caCert = await x509.X509CertificateGenerator.createSelfSigned({
  serialNumber: '00',
  name: 'CN=SignShield Root CA v1, O=SignShield, C=BG',
  notBefore,
  notAfter,
  signingAlgorithm: { name: 'Ed25519' },
  keys,
  extensions: [
    new x509.BasicConstraintsExtension(true /* isCA */, 0 /* pathLen */, true /* critical */),
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
      true,
    ),
  ],
});

// Експортиране на private key като PKCS8 DER → base64
const privateKeyPkcs8 = await nodeCrypto.subtle.exportKey('pkcs8', keys.privateKey);
const privateKeyB64 = Buffer.from(privateKeyPkcs8).toString('base64');

// PEM на сертификата
const certPem = caCert.toString('pem');

// Записваме PEM в repo (публичен — не е тайна)
const certDir = join(projectRoot, 'supabase', 'root-ca');
mkdirSync(certDir, { recursive: true });
writeFileSync(join(certDir, 'root-ca-cert.pem'), certPem);

// Записваме PEM в src/ за frontend използване (Phase 5 верификация)
const srcCertPath = join(projectRoot, 'src', 'lib', 'crypto', 'rootCaCert.ts');
const tsContent = `/**
 * rootCaCert.ts
 * Root CA сертификат — генериран от scripts/generate-root-ca.mjs
 * Публичен: може да се commit-ва в repo.
 * Ползва се при Фаза 5 (верификация на подпис).
 */
export const ROOT_CA_CERT_PEM = \`${certPem.trim()}\`;
`;
writeFileSync(srcCertPath, tsContent);

// ─── Изходна информация ────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('✅ Root CA генериран успешно!');
console.log('═'.repeat(70));
console.log('\n📁 Файлове записани:');
console.log('   supabase/root-ca/root-ca-cert.pem  → commit в repo');
console.log('   src/lib/crypto/rootCaCert.ts       → commit в repo');
console.log('\n⚠️  СЛЕДВАЩА СТЪПКА: Добави тези 2 Supabase Secrets:');
console.log('   Dashboard → Edge Functions → Manage secrets\n');

console.log('─'.repeat(70));
console.log('Secret 1:  ROOT_CA_PRIVATE_KEY_B64');
console.log('Value:\n');
console.log(privateKeyB64);
console.log('\n' + '─'.repeat(70));
console.log('Secret 2:  ROOT_CA_CERT_PEM');
console.log('Value:\n');
console.log(certPem);
console.log('─'.repeat(70));

console.log('\n💾 Запази ROOT_CA_PRIVATE_KEY_B64 в password manager като backup!');
console.log('   (Загубен ключ = всички сертификати стават неверифицируеми)\n');
