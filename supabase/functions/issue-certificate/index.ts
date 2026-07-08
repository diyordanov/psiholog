// Edge Function: issue-certificate
//
// Издава X.509 сертификат (Ed25519) или custom JSON attestation (ML-DSA-65)
// за подписващ ключ на текущо автентикирания потребител.
//
// Сигурност:
//   - user_id се взима от JWT (не от request body) — не може да се подправи
//   - public key се чете от DB (не от request body) — не може да се подправи
//   - Идемпотентност: ако certificate вече е попълнен → 200 без re-issue
//   - Rate limit: max 10 certificate_issued events / минута / потребител
//   - service_role key никога не излиза от функцията

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as x509 from 'npm:@peculiar/x509';
import { Crypto as PeculiarCrypto } from 'npm:@peculiar/webcrypto';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://psiholog.pages.dev';

// Ползваме @peculiar/webcrypto за Ed25519 operации — гарантирана съвместимост с @peculiar/x509
const pkiCrypto = new PeculiarCrypto();
x509.cryptoProvider.set(pkiCrypto);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('Missing or invalid Authorization header', 401);
  }
  const jwt = authHeader.slice(7);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 1. Автентикация
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) return jsonError('Invalid or expired token', 401);

  // 2. Rate limit: max 10 certificate_issued / минута / потребител
  const withinLimit = await checkRateLimit(supabase, user.id);
  if (!withinLimit) return jsonError('Too many requests. Изчакайте минута.', 429);

  // 3. Parse body
  let signingKeyId: string;
  try {
    const body = await req.json();
    signingKeyId = body?.signingKeyId;
    if (!signingKeyId || typeof signingKeyId !== 'string') throw new Error();
  } catch {
    return jsonError('Невалидно тяло: нужно е { signingKeyId: string }', 400);
  }

  // 4. Зареждаме ключа от DB — потвърждава ownership (user_id check)
  const { data: keyRow, error: keyError } = await supabase
    .from('signing_keys')
    .select('id, algorithm, public_key, certificate, user_id')
    .eq('id', signingKeyId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single();

  if (keyError || !keyRow) return jsonError('Ключът не е намерен или нямате достъп.', 404);

  // 5. Идемпотентност — ако сертификатът вече е издаден, връщаме 200 без re-issue
  if (keyRow.certificate !== null) {
    return json({ ok: true, alreadyIssued: true });
  }

  // 6. Зареждаме Root CA private key от Supabase Secret
  const caPrivKeyB64 = Deno.env.get('ROOT_CA_PRIVATE_KEY_B64');
  const caCertPem = Deno.env.get('ROOT_CA_CERT_PEM');
  if (!caPrivKeyB64 || !caCertPem) {
    console.error('Липсват ROOT_CA_PRIVATE_KEY_B64 / ROOT_CA_CERT_PEM Secrets');
    return jsonError('CA не е конфигуриран. Свържете се с администратора.', 503);
  }

  let caPrivKey: CryptoKey;
  let caCert: x509.X509Certificate;
  try {
    const pkcs8Bytes = Uint8Array.from(atob(caPrivKeyB64), (c) => c.charCodeAt(0));
    caPrivKey = await pkiCrypto.subtle.importKey(
      'pkcs8',
      pkcs8Bytes.buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    caCert = new x509.X509Certificate(caCertPem);
  } catch (e) {
    console.error('Грешка при зареждане на CA ключ/cert:', e);
    return jsonError('CA конфигурация грешка.', 503);
  }

  // 7. Декодираме публичния ключ от bytea hex (\xdeadbeef → Uint8Array)
  const pubKeyHex = (keyRow.public_key as string).startsWith('\\x')
    ? (keyRow.public_key as string).slice(2)
    : (keyRow.public_key as string);
  const publicKeyBytes = new Uint8Array(
    pubKeyHex.match(/.{2}/g)!.map((h: string) => parseInt(h, 16)),
  );

  // 8. Display name за subject на сертификата
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .single();
  const displayName = profile?.display_name ?? (user.email ?? 'Unknown User');

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 2 * 365.25 * 24 * 3600 * 1000);

  // 9. Издаване на сертификат според алгоритъма
  let certBytes: Uint8Array;

  if (keyRow.algorithm === 'ed25519') {
    certBytes = await issueEd25519Cert({
      publicKeyBytes,
      caPrivKey,
      caCert,
      displayName,
      userId: user.id,
      notBefore,
      notAfter,
      signingKeyId,
    });
  } else {
    // ML-DSA-65: custom JSON attestation, подписана с Root CA Ed25519 ключ
    certBytes = await issueMlDsaAttestation({
      publicKeyBytes,
      caPrivKey,
      displayName,
      userId: user.id,
      notBefore,
      notAfter,
    });
  }

  // 10. Записваме в DB
  const certHex = '\\x' + Array.from(certBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  const { error: updateError } = await supabase
    .from('signing_keys')
    .update({
      certificate: certHex,
      certificate_expires_at: notAfter.toISOString(),
    })
    .eq('id', signingKeyId)
    .eq('user_id', user.id);

  if (updateError) {
    console.error('DB update грешка:', updateError);
    return jsonError('Грешка при записване на сертификата.', 500);
  }

  // 11. Audit log
  await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'certificate_issued',
    resource_id: signingKeyId,
  });

  return json({ ok: true });
});

// ─── Ed25519 X.509 leaf certificate ────────────────────────────────────────

async function issueEd25519Cert(params: {
  publicKeyBytes: Uint8Array;
  caPrivKey: CryptoKey;
  caCert: x509.X509Certificate;
  displayName: string;
  userId: string;
  notBefore: Date;
  notAfter: Date;
  signingKeyId: string;
}): Promise<Uint8Array> {
  const { publicKeyBytes, caPrivKey, caCert, displayName, userId, notBefore, notAfter, signingKeyId } = params;

  // Импортираме Ed25519 публичния ключ (32 байта raw)
  const subjectPublicKey = await pkiCrypto.subtle.importKey(
    'raw',
    publicKeyBytes.buffer as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['verify'],
  );

  // Serial number: първите 16 hex символа от UUID на ключа
  const serialNumber = signingKeyId.replace(/-/g, '').slice(0, 16);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    issuer: caCert.subject,
    subject: `CN=${displayName}, UID=${userId}, O=SignShield`,
    notBefore,
    notAfter,
    signingAlgorithm: { name: 'Ed25519' },
    publicKey: subjectPublicKey,
    signingKey: caPrivKey,
    extensions: [
      new x509.BasicConstraintsExtension(false /* isCA */, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    ],
  });

  return new Uint8Array(cert.rawData);
}

// ─── ML-DSA-65 custom JSON attestation ─────────────────────────────────────

async function issueMlDsaAttestation(params: {
  publicKeyBytes: Uint8Array;
  caPrivKey: CryptoKey;
  displayName: string;
  userId: string;
  notBefore: Date;
  notAfter: Date;
}): Promise<Uint8Array> {
  const { publicKeyBytes, caPrivKey, displayName, userId, notBefore, notAfter } = params;

  // base64url кодиране на публичния ключ (1952 байта)
  const publicKeyB64url = btoa(String.fromCharCode(...publicKeyBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Canonical JSON (без caSignature) — редът на ключовете е фиксиран
  const attestationData = {
    version: 1,
    algorithm: 'ml-dsa-65',
    oid: '2.16.840.1.101.3.4.3.18',
    publicKey: publicKeyB64url,
    subject: { userId, displayName },
    issuedAt: notBefore.toISOString(),
    expiresAt: notAfter.toISOString(),
    issuer: 'SignShield Root CA v1',
  };

  const canonical = JSON.stringify(attestationData);
  const canonicalBytes = new TextEncoder().encode(canonical);

  // Подписваме canonical JSON с Root CA Ed25519 ключ
  const signatureBuffer = await pkiCrypto.subtle.sign(
    { name: 'Ed25519' },
    caPrivKey,
    canonicalBytes,
  );

  const caSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const finalAttestation = { ...attestationData, caSignature };
  return new TextEncoder().encode(JSON.stringify(finalAttestation));
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
): Promise<boolean> {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action', 'certificate_issued')
    .gte('created_at', oneMinuteAgo);
  return (count ?? 0) < 10;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
