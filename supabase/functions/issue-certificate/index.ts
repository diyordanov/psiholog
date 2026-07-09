// Edge Function: issue-certificate
//
// Издава ECDSA P-256 X.509 сертификат (raw DER, без npm зависимости) или
// ML-DSA-65 JSON attestation. Ползва нативния globalThis.crypto на Deno.
//
// Зависимости: само @supabase/supabase-js (без @peculiar/x509, без @peculiar/webcrypto).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://psiholog.pages.dev';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') return jsonError('Method not allowed', 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return jsonError('Unauthorized', 401);
  const jwt = authHeader.slice(7);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) return jsonError('Invalid token', 401);

  if (!(await checkRateLimit(supabase, user.id))) {
    return jsonError('Too many requests. Изчакайте минута.', 429);
  }

  let signingKeyId: string;
  try {
    const body = await req.json();
    signingKeyId = body?.signingKeyId;
    if (!signingKeyId || typeof signingKeyId !== 'string') throw new Error();
  } catch {
    return jsonError('Невалидно тяло: нужно е { signingKeyId: string }', 400);
  }

  const { data: keyRow, error: keyError } = await supabase
    .from('signing_keys')
    .select('id, algorithm, public_key, certificate, user_id')
    .eq('id', signingKeyId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single();

  if (keyError || !keyRow) return jsonError('Ключът не е намерен.', 404);
  if (keyRow.certificate !== null) return json({ ok: true, alreadyIssued: true });

  const caPrivKeyB64 = Deno.env.get('ROOT_CA_PRIVATE_KEY_B64');
  const caCertPem    = Deno.env.get('ROOT_CA_CERT_PEM');
  if (!caPrivKeyB64 || !caCertPem) {
    console.error('[issue-cert] Липсват ROOT_CA_PRIVATE_KEY_B64 / ROOT_CA_CERT_PEM Secrets');
    return jsonError('CA не е конфигуриран.', 503);
  }

  let caPrivKey: CryptoKey;
  let issuerDN: Uint8Array;
  try {
    // ROOT_CA_PRIVATE_KEY_B64 е чист base64 (не PEM) — PKCS8 на CA private key (ECDSA P-256)
    const pkcs8Bytes = b64ToBytes(caPrivKeyB64);
    caPrivKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8Bytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    // ROOT_CA_CERT_PEM е PEM формат — извличаме issuer DN от DER байтовете
    const caCertDer = pemToDer(caCertPem);
    issuerDN = extractIssuerDN(caCertDer);
    console.log('[issue-cert] CA ключ и сертификат заредени успешно');
  } catch (e) {
    console.error('[issue-cert] CA key/cert грешка:', e);
    return jsonError('CA конфигурация грешка.', 503);
  }

  // Декодираме публичния ключ от bytea hex (\xdeadbeef → Uint8Array)
  const pubKeyHex = (keyRow.public_key as string).startsWith('\\x')
    ? (keyRow.public_key as string).slice(2)
    : (keyRow.public_key as string);
  const publicKeyBytes = hexToBytes(pubKeyHex);

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .single();
  const displayName = profile?.display_name ?? (user.email ?? 'Unknown');

  const notBefore = new Date();
  const notAfter  = new Date(notBefore.getTime() + 2 * 365.25 * 24 * 3600_000);
  const serialHex = signingKeyId.replace(/-/g, '').slice(0, 16);

  let certBytes: Uint8Array;
  try {
    if (keyRow.algorithm === 'ecdsa-p256') {
      certBytes = await buildEcdsaP256Cert({
        publicKeyBytes, caPrivKey, issuerDN,
        displayName, userId: user.id,
        notBefore, notAfter, serialHex,
      });
    } else if (keyRow.algorithm === 'ed25519') {
      certBytes = await buildEd25519Cert({
        publicKeyBytes, caPrivKey, issuerDN,
        displayName, userId: user.id,
        notBefore, notAfter, serialHex,
      });
    } else {
      certBytes = await buildAttestation({
        publicKeyBytes, caPrivKey,
        algorithm: keyRow.algorithm as string,
        displayName, userId: user.id,
        notBefore, notAfter,
      });
    }
  } catch (e) {
    console.error('[issue-cert] Грешка при генериране на сертификат:', e);
    return jsonError('Грешка при генериране на сертификат.', 500);
  }

  // Записваме в DB като bytea hex
  const certHex = '\\x' + Array.from(certBytes)
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  const { error: updateError } = await supabase
    .from('signing_keys')
    .update({ certificate: certHex, certificate_expires_at: notAfter.toISOString() })
    .eq('id', signingKeyId)
    .eq('user_id', user.id);

  if (updateError) {
    console.error('[issue-cert] DB update грешка:', updateError);
    return jsonError('Грешка при записване.', 500);
  }

  await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'certificate_issued',
    resource_id: signingKeyId,
  });

  console.log(`[issue-cert] Сертификат издаден за ${signingKeyId} (${keyRow.algorithm})`);
  return json({ ok: true });
});

// ─── ECDSA P-256 X.509 (DER, без npm зависимости) ───────────────────────────

async function buildEcdsaP256Cert(params: {
  publicKeyBytes: Uint8Array;
  caPrivKey: CryptoKey;
  issuerDN: Uint8Array;
  displayName: string;
  userId: string;
  notBefore: Date;
  notAfter: Date;
  serialHex: string;
}): Promise<Uint8Array> {
  const { publicKeyBytes, caPrivKey, issuerDN, displayName, userId, notBefore, notAfter, serialHex } = params;

  // signatureAlgorithm = ecdsa-with-SHA256, параметри ABSENT (RFC 5480)
  const sigAlgId = derSeq(derOid(OID_ECDSA_SHA256));

  const subjectDN = derSeq(cat(
    rdnUtf8(OID_CN, displayName),
    rdnUtf8(OID_UID, userId),
    rdnUtf8(OID_O, 'SignShield'),
  ));

  const validity = derSeq(cat(derGTime(notBefore), derGTime(notAfter)));
  const spki     = ecdsaP256Spki(publicKeyBytes);
  const exts     = buildExtensions();

  const tbs = derSeq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),   // [0] version: v3
    encodeSerial(serialHex),
    sigAlgId,
    issuerDN,
    validity,
    subjectDN,
    spki,
    exts,
  ));

  // CA подписва TBS с ECDSA P-256 / SHA-256; WebCrypto връща P1363 (64 байта r||s)
  const sigP1363 = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, caPrivKey, tbs);
  // X.509 BIT STRING изисква DER SEQUENCE { r INTEGER, s INTEGER }
  const sigDer   = p1363ToDer(new Uint8Array(sigP1363));
  const sigBits  = tlv(0x03, cat(new Uint8Array([0x00]), sigDer));

  return derSeq(cat(tbs, sigAlgId, sigBits));
}

// ─── Ed25519 X.509 (запазен за обратна съвместимост на стари ключове) ────────

async function buildEd25519Cert(params: {
  publicKeyBytes: Uint8Array;
  caPrivKey: CryptoKey;
  issuerDN: Uint8Array;
  displayName: string;
  userId: string;
  notBefore: Date;
  notAfter: Date;
  serialHex: string;
}): Promise<Uint8Array> {
  const { publicKeyBytes, caPrivKey, issuerDN, displayName, userId, notBefore, notAfter, serialHex } = params;

  // Leaf SPKI: Ed25519 key; CA подписва с ECDSA P-256 → sigAlgId = ecdsa-with-SHA256
  const sigAlgId = derSeq(derOid(OID_ECDSA_SHA256));

  const subjectDN = derSeq(cat(
    rdnUtf8(OID_CN, displayName),
    rdnUtf8(OID_UID, userId),
    rdnUtf8(OID_O, 'SignShield'),
  ));

  const validity = derSeq(cat(derGTime(notBefore), derGTime(notAfter)));
  const spki     = edSpki(publicKeyBytes);
  const exts     = buildExtensions();

  const tbs = derSeq(cat(
    tlv(0xa0, derInt(new Uint8Array([0x02]))),   // [0] version: v3
    encodeSerial(serialHex),
    sigAlgId,
    issuerDN,
    validity,
    subjectDN,
    spki,
    exts,
  ));

  const sigP1363 = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, caPrivKey, tbs);
  const sigDer   = p1363ToDer(new Uint8Array(sigP1363));
  const sigBits  = tlv(0x03, cat(new Uint8Array([0x00]), sigDer));

  return derSeq(cat(tbs, sigAlgId, sigBits));
}

// ─── ML-DSA-65 JSON attestation ──────────────────────────────────────────────

async function buildAttestation(params: {
  publicKeyBytes: Uint8Array;
  caPrivKey: CryptoKey;
  algorithm: string;
  displayName: string;
  userId: string;
  notBefore: Date;
  notAfter: Date;
}): Promise<Uint8Array> {
  const { publicKeyBytes, caPrivKey, algorithm, displayName, userId, notBefore, notAfter } = params;

  let raw = '';
  for (let i = 0; i < publicKeyBytes.length; i++) raw += String.fromCharCode(publicKeyBytes[i]);
  const pubKeyB64url = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const oidMap: Record<string, string> = { 'ml-dsa-65': '2.16.840.1.101.3.4.3.18' };

  const attestationData = {
    version:   1,
    algorithm,
    oid:       oidMap[algorithm] ?? 'unknown',
    publicKey: pubKeyB64url,
    subject:   { userId, displayName },
    issuedAt:  notBefore.toISOString(),
    expiresAt: notAfter.toISOString(),
    issuer:    'SignShield Root CA v1',
  };

  const canonical = JSON.stringify(attestationData);
  const sigBuf    = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    caPrivKey,
    new TextEncoder().encode(canonical),
  );

  let sigRaw = '';
  const sigBytes = new Uint8Array(sigBuf);
  for (let i = 0; i < sigBytes.length; i++) sigRaw += String.fromCharCode(sigBytes[i]);
  const caSignature = btoa(sigRaw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return new TextEncoder().encode(JSON.stringify({ ...attestationData, caSignature }));
}

// ─── ASN.1 DER primitives ────────────────────────────────────────────────────

function cat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let   pos   = 0;
  for (const a of arrs) { out.set(a, pos); pos += a.length; }
  return out;
}

function encLen(n: number): Uint8Array {
  if (n < 0x80)  return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function tlv(tag: number, val: Uint8Array): Uint8Array {
  return cat(new Uint8Array([tag]), encLen(val.length), val);
}

const derSeq   = (v: Uint8Array) => tlv(0x30, v);
const derSet   = (v: Uint8Array) => tlv(0x31, v);
const derInt   = (v: Uint8Array) => tlv(0x02, v);
const derOid   = (v: Uint8Array) => tlv(0x06, v);
const derOcts  = (v: Uint8Array) => tlv(0x04, v);
const derUtf8  = (s: string)     => tlv(0x0c, new TextEncoder().encode(s));

function derGTime(d: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

// OIDs (content bytes, без tag/len)
const OID_ED25519      = new Uint8Array([0x2b, 0x65, 0x70]);                                  // 1.3.101.112
const OID_EC_PUB_KEY   = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x02,0x01]);               // 1.2.840.10045.2.1
const OID_SECP256R1    = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07]);          // 1.2.840.10045.3.1.7
const OID_ECDSA_SHA256 = new Uint8Array([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]);          // 1.2.840.10045.4.3.2
const OID_CN           = new Uint8Array([0x55, 0x04, 0x03]);                                   // 2.5.4.3
const OID_O            = new Uint8Array([0x55, 0x04, 0x0a]);                                   // 2.5.4.10
const OID_UID          = new Uint8Array([0x09,0x92,0x26,0x89,0x93,0xf2,0x2c,0x64,0x01,0x01]);// 0.9.2342.19200300.100.1.1
const OID_BC           = new Uint8Array([0x55, 0x1d, 0x13]);                                   // 2.5.29.19
const OID_KU           = new Uint8Array([0x55, 0x1d, 0x0f]);                                   // 2.5.29.15

const BOOL_TRUE  = new Uint8Array([0x01, 0x01, 0xff]);

const rdnUtf8 = (oid: Uint8Array, val: string) =>
  derSet(derSeq(cat(derOid(oid), derUtf8(val))));

// SPKI за ECDSA P-256: publicKeyBytes = 65-байта uncompressed point (0x04 || x || y)
function ecdsaP256Spki(publicKeyBytes: Uint8Array): Uint8Array {
  const algId = derSeq(cat(derOid(OID_EC_PUB_KEY), derOid(OID_SECP256R1)));
  return derSeq(cat(algId, tlv(0x03, cat(new Uint8Array([0x00]), publicKeyBytes))));
}

// SPKI за Ed25519 (запазен за обратна съвместимост)
function edSpki(pubKey: Uint8Array): Uint8Array {
  return derSeq(cat(
    derSeq(derOid(OID_ED25519)),
    tlv(0x03, cat(new Uint8Array([0x00]), pubKey)),
  ));
}

// P1363 (64 байта r||s) → DER SEQUENCE { r INTEGER, s INTEGER }
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const r = p1363.slice(0, 32);
  const s = p1363.slice(32, 64);
  const encInt = (b: Uint8Array) =>
    derInt(b[0] & 0x80 ? cat(new Uint8Array([0x00]), b) : b);
  return tlv(0x30, cat(encInt(r), encInt(s)));
}

function encodeSerial(hex: string): Uint8Array {
  const bytes = Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
  if (bytes.length > 0 && (bytes[0] & 0x80)) bytes.unshift(0x00);
  return derInt(new Uint8Array(bytes));
}

function buildExtensions(): Uint8Array {
  const bcExt = derSeq(cat(derOid(OID_BC), BOOL_TRUE, derOcts(derSeq(new Uint8Array(0)))));
  const kuBits = tlv(0x03, new Uint8Array([0x07, 0x80]));
  const kuExt  = derSeq(cat(derOid(OID_KU), BOOL_TRUE, derOcts(kuBits)));
  return tlv(0xa3, derSeq(cat(bcExt, kuExt)));
}

// ─── DER parser helpers ───────────────────────────────────────────────────────

function readLen(buf: Uint8Array, pos: number): { len: number; next: number } {
  const first = buf[pos];
  if (first < 0x80) return { len: first, next: pos + 1 };
  const nb = first & 0x7f;
  let len = 0;
  for (let i = 0; i < nb; i++) len = (len << 8) | buf[pos + 1 + i];
  return { len, next: pos + 1 + nb };
}

function skipTlv(buf: Uint8Array, pos: number): number {
  pos++;
  const { len, next } = readLen(buf, pos);
  return next + len;
}

function extractIssuerDN(certDer: Uint8Array): Uint8Array {
  let pos = 0;
  pos++;
  pos = readLen(certDer, pos).next;
  pos++;
  pos = readLen(certDer, pos).next;
  if (certDer[pos] === 0xa0) pos = skipTlv(certDer, pos);
  pos = skipTlv(certDer, pos);
  pos = skipTlv(certDer, pos);
  const start = pos;
  pos = skipTlv(certDer, pos);
  return certDer.slice(start, pos);
}

// ─── Помощни функции ─────────────────────────────────────────────────────────

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  return new Uint8Array(clean.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function checkRateLimit(supabase: any, userId: string): Promise<boolean> {
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action', 'certificate_issued')
    .gte('created_at', oneMinAgo);
  return (count ?? 0) < 10;
}

// ─── CORS + response helpers ──────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-client-info, apikey',
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
