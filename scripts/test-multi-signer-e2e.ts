/**
 * test-multi-signer-e2e.ts — Фаза 8, Ден 4: пълен multi-signer integration тест
 *
 * За разлика от test-e2e-signing.ts / test-multi-sign*.ts (чист PDF/крипто
 * pipeline, без DB), този скрипт минава през РЕАЛНИЯ signAsOwner()/
 * signAsRecipient() orchestration от signingService.ts — реален Supabase DB
 * (signing_requests/signing_request_recipients/documents/signatures), реален
 * Storage upload/download, реален Root CA chain. PRF ceremony-те са mock-нати
 * (WebAuthn не може да се automate от скрипт) чрез injectable PrfExtractor —
 * същия механизъм, ползван от unit тестовете.
 *
 * Flow:
 *   1. Admin (service role) създава 2 временни test потребителя (owner + recipient)
 *   2. Owner: signing_keys ред (ECDSA P-256 + leaf cert от реалния Root CA)
 *   3. Owner: качва тестов PDF в 'documents' bucket + documents ред
 *   4. Owner: signAsOwner(documentId, ..., recipients: [{email: recipient}], ...)
 *      → очаква signing_requests.status = 'awaiting_recipients'
 *   5. Recipient: claim_recipient_invitation RPC (линква user_id към поканата)
 *   6. Recipient: signing_keys ред (собствен ECDSA P-256 + leaf cert)
 *   7. Recipient: signAsRecipient(recipientId, ...)
 *      → очаква signing_requests.status = 'completed', documents.status = 'signed'
 *   8. Сваля финалния PDF локално — РЪЧНА проверка в Adobe Reader (без
 *      screenshot заявка тук, виж Ден 4 план): 2 signature entries, и двата valid.
 *   9. Cleanup: admin.deleteUser() за двата test акаунта (cascade изтрива
 *      всички свързани редове — documents/signing_keys/signatures/
 *      signing_requests/signing_request_recipients имат ON DELETE CASCADE
 *      към auth.users).
 *
 * Изисквания (.env.local):
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   — вече изисквани от приложението
 *   SUPABASE_SERVICE_ROLE_KEY                    — Dashboard → Settings → API →
 *                                                   service_role key (НЕ commit-вай!)
 *   ROOT_CA_PRIVATE_KEY_B64                      — същия като другите e2e скриптове
 *
 * Стартиране:
 *   npx tsx --env-file=.env.local scripts/test-multi-signer-e2e.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { ROOT_CA_CERT_PEM } from '../src/lib/crypto/rootCaCert';
import { encryptPrivateKey, deriveAesKeyFromPRF, type PrfExtractor } from '../src/lib/crypto/keyProtection';
import { signAsOwner, signAsRecipient } from '../src/lib/signingService';
import { supabase } from '../src/lib/supabase'; // singleton — signAsOwner/signAsRecipient го ползват вътрешно

// ─── DER helpers (копие от test-multi-sign.ts — leaf cert подписан от Root CA) ──

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
const OID_CN = [0x55, 0x04, 0x03], OID_O = [0x55, 0x04, 0x0a], OID_C = [0x55, 0x04, 0x06];
const algId = seq(oid(OID_ECDSA_SHA256));

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function rootCaSubjectDn(): Uint8Array {
  const printable = (s: string) => tlv(0x13, new TextEncoder().encode(s));
  const rdn = (attrOid: number[], val: Uint8Array) => tlv(0x31, seq(cat(oid(attrOid), val)));
  return seq(cat(
    rdn(OID_CN, utf8('SignShield Root CA v1')),
    rdn(OID_O,  printable('SignShield')),
    rdn(OID_C,  printable('BG')),
  ));
}
async function buildLeafCert(
  rawLeafPubKey: Uint8Array, caPrivateKey: CryptoKey, commonName: string, serial: number, now: Date,
): Promise<Uint8Array> {
  const issuerDn  = rootCaSubjectDn();
  const subjectDn = seq(cat(tlv(0x31, seq(cat(oid(OID_CN), utf8(commonName))))));
  const spki      = seq(cat(seq(cat(oid(OID_EC_PUB_KEY), oid(OID_P256))), bitStr(rawLeafPubKey)));
  const notBefore = new Date(now);
  const notAfter  = new Date(now.getTime() + 365 * 24 * 3600_000);
  const tbs = seq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))), derInt(new Uint8Array([serial])), algId, issuerDn,
    seq(cat(utcTime(notBefore), utcTime(notAfter))), subjectDn, spki,
  ));
  const sigP1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, caPrivateKey, tbs));
  const derSig = seq(cat(derInt(sigP1363.slice(0, 32)), derInt(sigP1363.slice(32, 64))));
  return seq(cat(tbs, algId, bitStr(derSig)));
}

// ─── Bytea helpers ────────────────────────────────────────────────────────────

function toByteaHex(bytes: Uint8Array): string {
  return '\\x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Mock PRF (WebAuthn не може да се automate от Node скрипт) ────────────────
//
// Използваме prfSalt-а самия него като "PRF output" — детерминирано, същото
// на setup (encrypt) и sign (decrypt) време, единственото важно свойство за
// теста. rpId не се проверява от mock-а (реален PRF extractor го подава на
// navigator.credentials.get({rpId}), тук просто го игнорираме).
function makeMockPrfExtractor(fixedCredentialId: Uint8Array): PrfExtractor {
  return async (prfSalt: Uint8Array, _rpId: string, credentialId?: Uint8Array) => ({
    prfOutput: prfSalt.slice().buffer,
    credentialId: credentialId ?? fixedCredentialId,
  });
}

interface TestSigner {
  userId: string;
  email: string;
  password: string;
  credentialId: Uint8Array;
  extractPrf: PrfExtractor;
}

/** Създава temp Supabase Auth потребител (admin API) + ECDSA signing_keys ред + leaf cert. */
async function setupTestSigner(
  admin: ReturnType<typeof createClient>,
  caPrivKey: CryptoKey,
  label: string,
  serial: number,
): Promise<TestSigner> {
  const email = `e2e-multisigner-${label}-${Date.now()}@test.signshield.invalid`;
  const password = `E2eTest!${Math.random().toString(36).slice(2)}`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr || !created.user) throw new Error(`createUser(${label}) failed: ${createErr?.message}`);
  const userId = created.user.id;

  // Сигнатура на сесията ТУК, за да можем веднага да insert-нем signing_keys
  // ред като този потребител (RLS: auth.uid() = user_id).
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(${label}) failed: ${signInErr.message}`);

  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const extractPrf = makeMockPrfExtractor(credentialId);

  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const rawPub  = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const pkcs8   = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  const leafCertDer = await buildLeafCert(rawPub, caPrivKey, `E2E ${label}`, serial, new Date());

  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKeyIv = crypto.getRandomValues(new Uint8Array(12));
  const { aesKey } = await deriveAesKeyFromPRF(prfSalt, 'localhost', credentialId, extractPrf);
  const encryptedSecretKey = await encryptPrivateKey(pkcs8, aesKey, wrappedKeyIv);

  const credentialIdBase64 = Buffer.from(credentialId).toString('base64url');

  const { error: keyErr } = await supabase.from('signing_keys').insert({
    user_id: userId,
    algorithm: 'ecdsa-p256',
    public_key: toByteaHex(rawPub),
    encrypted_private_key: toByteaHex(encryptedSecretKey),
    prf_salt: toByteaHex(prfSalt),
    wrapped_key_iv: toByteaHex(wrappedKeyIv),
    credential_id: credentialIdBase64,
    certificate: toByteaHex(leafCertDer),
    certificate_expires_at: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
  });
  if (keyErr) throw new Error(`insert signing_keys(${label}) failed: ${keyErr.message}`);

  await supabase.auth.signOut();

  return { userId, email, password, credentialId, extractPrf };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/** Тестов минимален PDF (споделен между двата сценария). */
function makeTestPdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n191\n%%EOF\n',
  );
}

/** Качва тестов PDF под owner-ската storage папка + insert documents ред. Изисква активна owner сесия. */
async function uploadTestDocument(ownerUserId: string, filename: string): Promise<string> {
  const storagePath = `${ownerUserId}/${filename}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(storagePath, makeTestPdfBytes(), {
    contentType: 'application/pdf', upsert: true,
  });
  if (upErr) throw new Error(`upload original PDF failed: ${upErr.message}`);

  const { data: docRow, error: docErr } = await supabase.from('documents').insert({
    user_id: ownerUserId,
    original_filename: filename,
    storage_path: storagePath,
    original_hash_sha256: toByteaHex(new Uint8Array(32)), // не се верифицира тук
    status: 'uploaded',
  }).select('id').single();
  if (docErr || !docRow) throw new Error(`insert documents failed: ${docErr?.message}`);
  return docRow.id as string;
}

/**
 * Сценарий 1: owner + 1 recipient — пълен multi-signer flow.
 * Връща пътя на финалния PDF (за ръчна Adobe Reader проверка).
 */
async function runMultiSignerScenario(
  admin: ReturnType<typeof createClient>, caPrivKey: CryptoKey, fontBytes: Uint8Array,
): Promise<string> {
  console.log('\n═══ Сценарий 1: multi-signer (owner + 1 recipient) ═══');
  let ownerUserId: string | undefined;
  let recipientUserId: string | undefined;

  try {
    console.log('\n👤 Създаване на owner test акаунт...');
    const owner = await setupTestSigner(admin, caPrivKey, 'owner', 20);
    ownerUserId = owner.userId;
    console.log(`   ✓ ${owner.email}`);

    console.log('\n👤 Създаване на recipient test акаунт...');
    const recipient = await setupTestSigner(admin, caPrivKey, 'recipient', 21);
    recipientUserId = recipient.userId;
    console.log(`   ✓ ${recipient.email}`);

    console.log('\n📝 Owner: качване на тестов PDF...');
    await supabase.auth.signInWithPassword({ email: owner.email, password: owner.password });
    const documentId = await uploadTestDocument(owner.userId, 'e2e-multisigner-test.pdf');
    console.log(`   ✓ documents.id = ${documentId}`);

    console.log('\n✍️  Owner: signAsOwner() (с покана към recipient)...');
    const ownerResult = await signAsOwner(
      documentId, owner.userId, 'E2E Owner', { page: 0, x: 30, y: 30 },
      [{ email: recipient.email, position: { page: 0, x: 260, y: 30 } }],
      'localhost', fontBytes, owner.extractPrf,
    );
    console.log(`   ✓ signing_requests.id = ${ownerResult.signingRequestId}, status = ${ownerResult.status}`);
    if (ownerResult.status !== 'awaiting_recipients') {
      throw new Error(`❌ Очаквано status='awaiting_recipients', получено '${ownerResult.status}'`);
    }

    const { data: recipientRow, error: recFetchErr } = await supabase
      .from('signing_request_recipients')
      .select('id')
      .eq('signing_request_id', ownerResult.signingRequestId)
      .eq('invited_email', recipient.email.toLowerCase())
      .single();
    if (recFetchErr || !recipientRow) throw new Error(`fetch recipient row failed: ${recFetchErr?.message}`);
    const recipientRowId = recipientRow.id as string;
    console.log(`   ✓ signing_request_recipients.id = ${recipientRowId}`);

    await supabase.auth.signOut();

    console.log('\n🔗 Recipient: claim_recipient_invitation()...');
    await supabase.auth.signInWithPassword({ email: recipient.email, password: recipient.password });
    const { error: claimErr } = await supabase.rpc('claim_recipient_invitation', { p_recipient_id: recipientRowId });
    if (claimErr) throw new Error(`claim_recipient_invitation failed: ${claimErr.message}`);
    console.log('   ✓ claimed');

    console.log('\n✍️  Recipient: signAsRecipient()...');
    const recipientResult = await signAsRecipient(
      recipientRowId, recipient.userId, 'E2E Recipient', 'localhost', recipient.extractPrf,
    );
    console.log(`   ✓ version = ${recipientResult.version}, allSigned = ${recipientResult.allSigned}, status = ${recipientResult.status}`);
    if (!recipientResult.allSigned || recipientResult.status !== 'completed') {
      throw new Error(`❌ Очаквано allSigned=true, status='completed', получено allSigned=${recipientResult.allSigned}, status='${recipientResult.status}'`);
    }

    await supabase.auth.signOut();

    console.log('\n🔍 Финална проверка (admin client)...');
    const { data: finalSr } = await admin.from('signing_requests').select('status, version').eq('id', ownerResult.signingRequestId).single();
    const { data: finalDoc } = await admin.from('documents').select('status, signed_storage_path').eq('id', documentId).single();
    console.log(`   signing_requests.status = ${finalSr?.status} (очаквано 'completed') ${finalSr?.status === 'completed' ? '✅' : '❌'}`);
    console.log(`   documents.status = ${finalDoc?.status} (очаквано 'signed') ${finalDoc?.status === 'signed' ? '✅' : '❌'}`);

    if (finalSr?.status !== 'completed' || finalDoc?.status !== 'signed') {
      throw new Error('❌ Финалният DB статус не съответства на очакваното.');
    }

    const { data: pdfBlob, error: dlErr } = await admin.storage
      .from('signed-documents')
      .download(finalDoc.signed_storage_path as string);
    if (dlErr || !pdfBlob) throw new Error(`download final PDF failed: ${dlErr?.message}`);

    mkdirSync('scripts/output', { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = `scripts/output/multi-signer-e2e-${ts}.pdf`;
    writeFileSync(outPath, new Uint8Array(await pdfBlob.arrayBuffer()));

    console.log(`\n📁 Финален PDF запазен: ${outPath}`);
    console.log('   Провери РЪЧНО в Adobe Reader: 2 signature entries (E2E Owner, E2E Recipient), и двата valid.');
    console.log('\n✅ Сценарий 1 (multi-signer) УСПЕШЕН.');
    return outPath;

  } finally {
    console.log('\n🧹 Cleanup (Сценарий 1): изтриване на test акаунти...');
    if (ownerUserId)     await admin.auth.admin.deleteUser(ownerUserId).catch(e => console.error('   ⚠ delete owner failed:', e.message));
    if (recipientUserId) await admin.auth.admin.deleteUser(recipientUserId).catch(e => console.error('   ⚠ delete recipient failed:', e.message));
    console.log('   ✓ готово');
  }
}

/**
 * Сценарий 2: backward compat — signAsOwner() с 0 recipients (empty array).
 * Гарантира, че бъдещи refactor-и на signAsOwner()/signAsRecipient() не
 * чупят single-signer path-а (signDocument() wrapper-ът минава ТОЧНО оттук).
 *
 * Проверява:
 *   - signing_requests.status = 'completed' ВЕДНАГА (без да чака recipients)
 *   - documents.status = 'signed'
 *   - signatures ред е създаден
 *   - НЯМА нито един signing_request_recipients ред за тази заявка
 */
async function runSingleSignerScenario(
  admin: ReturnType<typeof createClient>, caPrivKey: CryptoKey, fontBytes: Uint8Array,
): Promise<void> {
  console.log('\n═══ Сценарий 2: single-signer backward compat (0 recipients) ═══');
  let ownerUserId: string | undefined;

  try {
    console.log('\n👤 Създаване на owner test акаунт...');
    const owner = await setupTestSigner(admin, caPrivKey, 'solo-owner', 22);
    ownerUserId = owner.userId;
    console.log(`   ✓ ${owner.email}`);

    console.log('\n📝 Owner: качване на тестов PDF...');
    await supabase.auth.signInWithPassword({ email: owner.email, password: owner.password });
    const documentId = await uploadTestDocument(owner.userId, 'e2e-singlesigner-test.pdf');
    console.log(`   ✓ documents.id = ${documentId}`);

    console.log('\n✍️  Owner: signAsOwner() с recipients=[] (backward compat)...');
    const result = await signAsOwner(
      documentId, owner.userId, 'E2E Solo Owner', { page: 0, x: 30, y: 30 },
      [], // 0 recipients — backward compat
      'localhost', fontBytes, owner.extractPrf,
    );
    console.log(`   ✓ signing_requests.id = ${result.signingRequestId}, status = ${result.status}, version = ${result.version}`);

    if (result.status !== 'completed') {
      throw new Error(`❌ Очаквано status='completed' ВЕДНАГА (0 recipients), получено '${result.status}'`);
    }

    await supabase.auth.signOut();

    console.log('\n🔍 Финална проверка (admin client)...');
    const { data: finalDoc } = await admin.from('documents').select('status, signed_storage_path').eq('id', documentId).single();
    console.log(`   documents.status = ${finalDoc?.status} (очаквано 'signed') ${finalDoc?.status === 'signed' ? '✅' : '❌'}`);
    if (finalDoc?.status !== 'signed') {
      throw new Error(`❌ Очаквано documents.status='signed', получено '${finalDoc?.status}'`);
    }

    const { data: sigRows } = await admin.from('signatures').select('id').eq('signing_request_id', result.signingRequestId);
    console.log(`   signatures records = ${sigRows?.length ?? 0} (очаквано 1) ${sigRows?.length === 1 ? '✅' : '❌'}`);
    if (!sigRows || sigRows.length !== 1) {
      throw new Error(`❌ Очаквано точно 1 signatures ред, получено ${sigRows?.length ?? 0}`);
    }
    if (sigRows[0].id !== result.signatureId) {
      throw new Error(`❌ signatures.id (${sigRows[0].id}) не съвпада с result.signatureId (${result.signatureId})`);
    }

    const { data: recRows } = await admin.from('signing_request_recipients').select('id').eq('signing_request_id', result.signingRequestId);
    console.log(`   signing_request_recipients records = ${recRows?.length ?? 0} (очаквано 0) ${(recRows?.length ?? 0) === 0 ? '✅' : '❌'}`);
    if (recRows && recRows.length > 0) {
      throw new Error(`❌ Очаквано 0 signing_request_recipients редове, получено ${recRows.length}`);
    }

    console.log('\n✅ Сценарий 2 (single-signer backward compat) УСПЕШЕН.');

  } finally {
    console.log('\n🧹 Cleanup (Сценарий 2): изтриване на test акаунт...');
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(e => console.error('   ⚠ delete solo-owner failed:', e.message));
    console.log('   ✓ готово');
  }
}

async function main() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey     = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const caKeyB64    = process.env.ROOT_CA_PRIVATE_KEY_B64;

  if (!supabaseUrl || !anonKey) {
    console.error('❌ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY липсват в .env.local!');
    process.exit(1);
  }
  if (!serviceKey) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY липсва в .env.local!');
    console.error('   Supabase Dashboard → Settings → API → "service_role" secret.');
    console.error('   НИКОГА не commit-вай тази стойност — само локален .env.local (вече gitignored).');
    process.exit(1);
  }
  if (!caKeyB64) {
    console.error('❌ ROOT_CA_PRIVATE_KEY_B64 не е зададен в .env.local!');
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log('🔑 Зареждане на Root CA private key...');
  const caKeyDer  = Uint8Array.from(atob(caKeyB64), c => c.charCodeAt(0));
  const caPrivKey = await crypto.subtle.importKey('pkcs8', caKeyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  console.log('   ✓ заредена');

  const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));

  await runMultiSignerScenario(admin, caPrivKey, fontBytes);
  await runSingleSignerScenario(admin, caPrivKey, fontBytes);

  console.log('\n✅✅ И ДВАТА сценария УСПЕШНИ.');
}

main().catch(e => {
  console.error('\n❌ Грешка:', e);
  process.exit(1);
});
