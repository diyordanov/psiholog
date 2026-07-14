# SignShield

SignShield е уеб приложение за хибридно цифрово подписване на PDF документи, разработено като курсова работа по Информационна Сигурност. Комбинира класически ECDSA P-256 подпис (съвместим с Adobe Acrobat) с пост-квантов ML-DSA-65 подпис (FIPS 204), защитен чрез WebAuthn passkey PRF — без парола, без съхранение на частни ключове в plaintext.

## Основни функции

- **Хибридно PDF подписване** — ECDSA P-256 (PAdES-B-Basic) + ML-DSA-65 в едно PDF
- **Верификация на подписи** — изцяло в браузъра, файловете не се качват никъде
- **Passkey автентикация** — вход само с биометрия (Face ID, Windows Hello, Touch ID)
- **Верификационен доклад** — PDF доклад с технически детайли (A4, кирилица)
- **Публична /verify страница** — проверка на подписан документ без акаунт

---

## Ключови архитектурни решения

### ECDSA P-256 — защо не Ed25519?

Adobe Acrobat и повечето PDF viewer-и поддържат ECDSA P-256 и RSA, но **не** Ed25519. За PDF подписи съвместими с Adobe е задължително да се ползва алгоритъм от стандарта PKIX (RFC 5480) — P-256 е най-компактният от тях. Ed25519 е технически превъзходен, но не е в профила на PDF/PAdES стандарта.

### ML-DSA-65 — пост-квантова готовност

Класическите алгоритми (ECDSA, RSA) са уязвими към квантов компютър с алгоритъм на Shоr. NIST стандартизира **ML-DSA (CRYSTALS-Dilithium)** като FIPS 204 — lattice-базиран алгоритъм, устойчив на квантови атаки. SignShield вгражда ML-DSA-65 подпис в допълнителен `/PostQuantumSignature` stream в PDF — "crypto-agility": документът е валиден и с класически инструменти днес, и с PQ-aware инструменти в бъдеще.

### Passkey PRF — защо не парола?

Паролите са слабото звено: ползват се повторно, подлежат на phishing, трудно се пазят сигурно. WebAuthn **PRF extension** (RFC 9578 §3.2) позволява получаване на детерминиран 32-байтов secret от passkey + per-key salt — без изнасяне на биометрия или частния ключ от устройството. SignShield ползва тези байтове за HKDF-SHA256 → AES-256-GCM ключ за обвиване на signing ключовете. Частните ключове никога не са в plaintext нито на сървъра, нито в мрежата.

### Хибриден подпис — crypto-agility

Съхраняването и на двата подписа в един PDF осигурява **crypto-agility**: ако ECDSA бъде компрометиран (от квантов компютър след 2030-те), ML-DSA гарантира дългосрочна валидност. Ако ML-DSA стандартът бъде преразгледан, ECDSA остава валиден за класически сценарии. Нито един алгоритъм не е единствена точка на провал.

### Custom Root CA — in-house PKI

За курсова работа е неоправдано да се ползва публична CA (GlobalSign, DigiCert — скъпо, бавно, изисква верификация на организация). SignShield генерира **Root CA с Ed25519** (10 г. валидност), издава X.509 leaf cert за всеки ECDSA ключ. Частният ключ на Root CA никога не се commit-ва — пази се в **Supabase Secret** (`ROOT_CA_PRIVATE_KEY_B64`) и се достъпва само от Edge Function при издаване на сертификат.

---

## Privacy и Security

| Аспект | Подход |
|--------|--------|
| Файлове при верификация | Изцяло в браузъра — нулев upload |
| Passkey биометрия | Не напуска устройството (WebAuthn гарантира) |
| Частни signing ключове | AES-256-GCM криптирани на сървъра; plaintext само в JS heap при подписване |
| Root CA private key | Само в Supabase Secret — никога в repo или frontend |
| Audit log | Всяко действие (login, sign, download, keygen) логвано с user_id + timestamp |

---

## Технологичен стек

| Слой | Технология |
|------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| PDF | pdf-lib (манипулация), pdfjs-dist legacy (визуализация) |
| Крипто | @noble/post-quantum 0.6.1 (ML-DSA-65), Web Crypto API (ECDSA, AES-GCM, HKDF) |
| Auth | Supabase Auth (WebAuthn passkeys) |
| БД | Supabase (PostgreSQL + RLS) |
| Storage | Supabase Storage (private buckets) |
| Deploy | Cloudflare Pages (auto-deploy от GitHub main) |
| Edge Functions | Supabase Edge Functions (Deno) — издаване на сертификати |

---

## Инсталация и Deploy

### 1. Изисквания

- Node.js 20+
- Supabase проект (free tier е достатъчен)
- Cloudflare Pages акаунт

### 2. Env vars

Създай `.env.local` (не се commit-ва):

```env
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 3. Supabase setup

```bash
# Прилагане на всички миграции
supabase db push

# Deploy на Edge Function за сертификати
supabase functions deploy issue-certificate

# Задай Root CA private key (виж секция Root CA по-долу)
supabase secrets set ROOT_CA_PRIVATE_KEY_B64=<base64-encoded-pkcs8>
```

Supabase Auth → Settings → Passkeys:
- Relying Party ID: `psiholog.pages.dev` (или твоя домейн)
- Enable WebAuthn

### 4. Root CA генериране

```bash
node scripts/generate-root-ca.mjs
```

Скриптът извежда:
- `supabase/root-ca/root-ca-cert.pem` — публичен cert (commit-ва се)
- `ROOT_CA_PRIVATE_KEY_B64` в stdout — **не commit-вай**, постави в Supabase Secret

### 5. Cloudflare Pages

- Repository: GitHub main branch
- Build command: `npm run build`
- Output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Файлът `public/_redirects` настройва SPA routing автоматично.

---

## Как работи (за разработчик)

### Signing flow

```
Потребител кликва „Подпиши"
  → preflight: resolveSigningKeys() — зарежда ключове + cert от DB (без биометрия)
  → PRF ceremony(ies): navigator.credentials.get() с PRF extension
      → HKDF-SHA256(PRF output, prf_salt) → AES-256-GCM ключ
      → AES-GCM decrypt → ECDSA P-256 private key (и ML-DSA-65 ако има)
  → pdf-lib: подготвя PDF placeholder (/ByteRange + /Contents)
  → ECDSA P-256: SHA-256 хеш на byte ranges → подпис → CMS DER → inject в /Contents
  → ML-DSA-65: подпис на същите byte ranges → JSON stream → inject в /PostQuantumSignature
  → Supabase Storage: upload на подписания PDF
  → DB update: documents.status = 'signed', signed_storage_path, signatures row
```

### Verification flow

```
Потребител качва PDF (drag & drop, без upload)
  → extractCmsDer(): намиране на ПОСЛЕДНИЯ /Contents < в PDF байтовете
  → extractByteRange(): намиране на ПОСЛЕДНИЯ /ByteRange
  → computeSignedHash(): SHA-256 на byte ranges (без /Contents данните)
  → parseCms(): ASN.1 DER walker → signedAttrs, signature, cert
  → verifyCertChain(): leaf cert → Root CA → trust anchor
  → verifyEcdsaSignature(): Web Crypto API ECDSA verify
  → extractPqStream(): /PostQuantumSignature stream → ML-DSA-65 verify
  → VerifyResult: overall status (authentic / tampered / invalid / unsigned / error)
```

### Recovery flow

```
„Забравих passkey"
  → signInWithOtp() — email magic link
  → Edge Function: изтрива webauthn_credentials в auth schema (SECURITY DEFINER)
  → RegisterPasskeyStep: registerPasskey() — нов passkey за устройството
  Забележка: signing ключовете са обвити с СТАРИЯ credential_id → след recovery
  трябва ново генериране на signing ключове.
```

---

## Browser поддръжка

| Браузър | Минимална версия | Забележка |
|---------|-----------------|-----------|
| Chrome/Chromium | 108+ | PRF extension поддържан |
| Firefox | 148+ | PRF extension от Firefox 148 |
| Safari (macOS/iOS) | 18+ | PRF extension от Safari 18 |
| Edge | 108+ | Като Chromium |
| Samsung Internet | — | Не тестван |

Пълна compat matrix: [`docs/browser-compat.md`](docs/browser-compat.md)

---

## Ограничения и Future Work

| Ограничение | Статус |
|-------------|--------|
| Root CA rotation | Manual — нов сертификат + ре-издаване на всички leaf certs |
| AATL integration | Future work — за производствено ползване нужен признат CA |
| LTV (Long-Term Validation) signatures | Не е поддържано — липсва timestamp authority (TSA) |
| Multiple signatures на един документ | Не е поддържано — само един подпис |
| Revocation (CRL/OCSP) | Не е поддържано — сертификатите нямат CRL/OCSP URL |
| Email templates (BG) | Supabase праща email само до акаунта на собственика без custom SMTP |
| Signing keys re-wrap след recovery | Manual — потребителят трябва да регенерира ключовете |

---

## Лиценз

MIT
