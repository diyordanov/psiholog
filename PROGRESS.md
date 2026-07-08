# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 ✅ · Фаза 1 ✅ · Фаза 2 ✅ · Фаза 3 ✅ (superseded) · Фаза 3.5-pre ✅ · Фаза 3.5 ИМПЛЕМЕНТИРАНА ⏳. Следва: ръчен тест + Root CA setup.

---

## Фаза 3.5: Mini-CA — ИМПЛЕМЕНТИРАНА, ЧАКА ROOT CA SETUP + РЪЧЕН ТЕСТ ⏳

### Какво е реализирано (2026-07-08)

**Нови файлове:**
- `supabase/migrations/0007_add_certificate_column.sql` — добавя `certificate BYTEA NULL` и `certificate_expires_at TIMESTAMPTZ NULL` към signing_keys
- `scripts/generate-root-ca.mjs` — еднократен скрипт за генериране на Root CA Ed25519 keypair + self-signed X.509 cert (10 години)
- `src/lib/crypto/rootCaCert.ts` — placeholder за Root CA PEM (попълва се от скрипта)
- `supabase/functions/issue-certificate/index.ts` — Edge Function: издава X.509 (Ed25519) или JSON attestation (ML-DSA-65), записва в DB; идемпотентна, rate limited 10/min
- `src/lib/certificateService.ts` — `issueCertificate()` и `retrofitMissingCerts()` за frontend
- `docs/pq-attestation-format.md` — документация на ML-DSA-65 attestation формата

**Обновени файлове:**
- `src/lib/auditLog.ts` — добавен `certificate_issued` action
- `src/lib/signingKeyStore.ts` — `SigningKeyRow` добавя `hasCertificate`, `certificateExpiresAt`, `certStatus`; нов `computeCertStatus()` helper; `fetchUserSigningKeys()` зарежда `certificate_expires_at`
- `src/components/keys/KeyCard.tsx` — cert status badge (ok / expiring-soon / expired / missing)
- `src/components/keys/KeyManagement.tsx` — auto-retrofit при page load за ключове без cert
- `src/components/keys/GenerateKeyModal.tsx` — вика `issueCertificate()` след `saveSigningKey()`
- `package.json` — добавени `@peculiar/x509` + `@peculiar/webcrypto` в devDependencies; нов `generate-root-ca` script
- `src/__tests__/certificate.test.ts` — 8 нови теста (certStatus + attestation format + partial failure)

**Архитектурни решения:**
- Ed25519: стандартен X.509 leaf cert (DER в BYTEA), подписан от Root CA
- ML-DSA-65: custom JSON attestation, подписана с Root CA Ed25519 ключ (виж `docs/pq-attestation-format.md`)
- Root CA private key: PKCS8, base64 → Supabase Secret `ROOT_CA_PRIVATE_KEY_B64`
- Root CA cert: PEM → в repo `supabase/root-ca/root-ca-cert.pem` и `src/lib/crypto/rootCaCert.ts`
- Идемпотентност: Edge Function проверява `certificate IS NULL` преди издаване
- Rate limit: 10 `certificate_issued` events / минута / потребител (audit_log based)
- Auto-retrofit: тих, при провал → ⚠️ badge в KeyCard
- 30-дневно предупреждение: `certStatus === 'expiring-soon'` → amber badge

**Тестове:**
- 22/22 vitest ✅ (14 стари + 8 нови)
- `npm run typecheck` ✅
- `npm run build` ✅

**Чака:**
- Root CA setup (виж секцията по-долу)
- Прилагане на migration 0007 в Supabase
- Deploy на Edge Function: `supabase functions deploy issue-certificate`
- Ръчен тест по чеклист

---

## Фаза 3.5-pre: Миграция от парола към PRF — ЗАВЪРШЕНА ✅ (2026-07-07)

Ръчно тествано (2026-07-07/08): Ed25519 + ML-DSA-65 генериране с PRF ✅ · Migration banner ✅ · DB схема ✅ · Audit log ✅

### Какво е реализирано (2026-07-07)

**Нови/обновени файлове:**
- `supabase/migrations/0006_prf_schema.sql` — добавя `prf_salt` (bytea), `wrapped_key_iv` (bytea), `credential_id` (text); старите колони остават за историята на soft-deleted ключове
- `src/lib/crypto/keyProtection.ts` — пренаписан: PBKDF2 премахнато; нов `deriveAesKeyFromPRF(prfSalt, rpId, credentialId?, extractPrf?)` с injectable `PrfExtractor` за тестове; `browserPrfExtractor` вика `navigator.credentials.get()` с PRF extension
- `src/lib/signingKeyStore.ts` — обновен `SaveKeyParams` (prfSalt, wrappedKeyIv, credentialId); `SigningKeyRow` добавя `isPrfBased: boolean`; нова `softDeleteLegacyPasswordKeys()` за migration banner
- `src/components/keys/GenerateKeyModal.tsx` — пренаписан: без password полета; flow: keypair gen → passkey ceremony → PRF → AES encrypt → DB запис; нови stage-ове (generating-key / awaiting-passkey / encrypting)
- `src/lib/crypto/signing.ts` — добавена `signWithStoredKey(signingKeyId, data, rpId, extractPrf?)` — интегрирана функция за Фаза 4
- `src/components/keys/KeyManagement.tsx` — добавен migration banner за парола-базирани ключове с inline потвърждение
- `src/__tests__/crypto.test.ts` — PBKDF2 тестове заменени с PRF mock тестове (injectable PrfExtractor); общо 14 теста

**Технически решения:**
- Injectable `PrfExtractor` тип: тестовете подават mock, браузърът ползва `browserPrfExtractor`
- `allowCredentials` при генериране е `undefined` (unguided ceremony) — credential_id идва от response
- `allowCredentials` при декриптиране е `[{ id: credentialId }]` (guided ceremony) — директна биометрия
- TypeScript cast: `credentialId as unknown as Uint8Array<ArrayBuffer>` за Web Crypto API
- HKDF info label: `'signshield-signing-key-v1'` — контекстно изолиране на ключовете

**Тестове:**
- 14/14 vitest ✅ (включително 3 нови PRF mock теста)
- `npm run build` ✅

**Чака:**
- Прилагане на migration `0006` в Supabase
- Ръчен тест в браузъра (виж чеклист по-долу)
- Ръчен тест на всички браузъри (Chrome, Firefox 148+, Safari 18+)

**Зависимости:** Фаза 3.5 (Mini-CA) чака края на Фаза 3.5-pre.

---

## Фаза 3.5: Mini-CA — виж секцията по-горе (ИМПЛЕМЕНТИРАНА ⏳)

---

## Фаза 3: Криптографски модул — ЗАВЪРШЕНА ✅ (2026-07-06) · SUPERSEDED от Фаза 3.5-pre

### Какво е реализирано

**Нови пакети:** `@noble/ed25519` v3.1, `@noble/post-quantum` v0.6, `@noble/hashes` v2.2, `vitest` v4.1

**Нови файлове:**
- `src/lib/crypto/keyGeneration.ts` — `generateEd25519Keypair()`, `generateMlDsaKeypair()`
- `src/lib/crypto/keyProtection.ts` — `deriveKeyFromPassword()` (PBKDF2-SHA256, 600 000 iter), `encryptPrivateKey()`, `decryptPrivateKey()` (AES-256-GCM)
- `src/lib/crypto/signing.ts` — `signWithEd25519()`, `verifyEd25519()`, `signWithMlDsa()`, `verifyMlDsa()`
- `src/lib/crypto/thumbprint.ts` — `computePublicKeyThumbprint()` (SHA-256 first 8 bytes, base64url)
- `src/lib/crypto/index.ts` — re-exports
- `src/workers/mlDsaKeygen.worker.ts` — Web Worker за ML-DSA-65 keygen (Vite `?worker` import)
- `src/lib/signingKeyStore.ts` — `saveSigningKey()`, `fetchUserSigningKeys()`, `softDeleteSigningKey()`, `fetchKeyDecryptData()`
- `src/components/keys/KeyCard.tsx` — ред в списъка (badge, thumbprint, дата, soft delete с inline потвърждение)
- `src/components/keys/GenerateKeyModal.tsx` — модал с live password validation, Web Worker за ML-DSA-65, rate limit 5s, warning при дублиран алгоритъм
- `src/components/keys/KeyManagement.tsx` — страница "Мои ключове"
- `src/__tests__/crypto.test.ts` — 13 vitest теста

**Промени в съществуващи файлове:**
- `src/App.tsx` — добавена таб навигация Документи / Ключове
- `src/lib/auditLog.ts` — добавен `signing_key_deleted` action тип
- `vite.config.ts` — добавена vitest конфигурация (`environment: 'node'`)
- `package.json` — добавен `"test": "vitest run"` script

**Технически решения:**
- noble/post-quantum v0.6+ API: `sign(msg, secretKey)` и `verify(sig, msg, publicKey)` — обратен ред от очакваното
- Web Crypto API TypeScript: `Uint8Array<ArrayBufferLike>` изисква `as unknown as Uint8Array<ArrayBuffer>` cast
- ML-DSA-65 в Web Worker: bundled отделно от Vite (`mlDsaKeygen.worker-xxx.js`), прехвърляме buffers с transfer за ефективност
- Ключовата парола НЕ се записва никъде — само при криптиране, след това се изчиства с `.fill(0)`
- `fetchKeyDecryptData()` добавена за Фаза 4 (декриптиране при подписване)

### Тествано (vitest — автоматично)

| Тест | Резултат |
|---|---|
| Ed25519: keygen (размери) | ✅ |
| Ed25519: sign → verify (positive) | ✅ |
| Ed25519: verify с променено съобщение (negative) | ✅ |
| Ed25519: verify с грешен public key (negative) | ✅ |
| ML-DSA-65: keygen (размери: pub 1952, sec 4032) | ✅ |
| ML-DSA-65: sign → verify (positive) | ✅ |
| ML-DSA-65: verify с променено съобщение (negative) | ✅ |
| ML-DSA-65: verify с грешен public key (negative) | ✅ |
| PBKDF2 + AES-GCM roundtrip (правилна парола) | ✅ |
| PBKDF2 + AES-GCM: грешна парола → хвърля | ✅ |
| Thumbprint: deterministic | ✅ |
| Thumbprint: различен за различни ключове | ✅ |
| Thumbprint: format (base64url, ~11 chars) | ✅ |

### Тествано (ръчно от потребителя — production)

| Сценарий | Резултат |
|---|---|
| Ed25519 генериране (позитивен) | ✅ |
| ML-DSA-65 генериране (позитивен) | ✅ |
| ML-DSA-65 генериране — отмяна с бутон | ✅ |
| Password validation — слаба парола (под 12 символа) | ✅ |
| Password validation — несъвпадащи пароли | ✅ |
| Warning при втори ключ от същия алгоритъм | ✅ |
| Rate limiting (double-click защита, 5 сек throttle) | ✅ |
| Soft delete + проверка в DB (deleted_at попълнен) | ✅ |
| RLS изолация — друг акаунт не вижда ключовете | ✅ |
| DB проверка — signing_keys съдържание (bytea полета) | ✅ |
| Парола не изтича (LocalStorage / SessionStorage / Network) | ✅ |
| `npm run build` без грешки | ✅ |
| `npm test` (13/13 vitest) | ✅ |

**Резултат: 13/13 автоматични + 13/13 ръчни теста ✅**

### Бъг открит и оправен по време на тестване

**RLS soft-delete блокировка** (`supabase/migrations/0005_fix_signing_keys_update_rls.sql`):
Миграция 0003 добави UPDATE политика само с `USING (... AND deleted_at IS NULL)` без `WITH CHECK`. PostgreSQL прилага `USING` и върху новия ред след update — след `deleted_at = now()` редът не удовлетворява `IS NULL` и базата отказваше. Fix: разделихме `USING (auth.uid() = user_id)` от `WITH CHECK (auth.uid() = user_id)`.

**Открит API breaking change в noble/post-quantum v0.6:**
`ml_dsa65.sign(msg, secretKey)` — съобщението е ПЪРВО (не secretKey).
`ml_dsa65.verify(signature, msg, publicKey)` — подписът е ПЪРВО.
Документирано в `signing.ts` с коментар.

### Технически дълг (superseded от Фаза 3.5-pre)

1. ~~**Ключова парола vs WebAuthn PRF**~~ — **Решено**: Фаза 3.5-pre ще преработи `keyProtection.ts` изцяло. Паролата се премахва.
2. **`fetchKeyDecryptData()`** — ще се обнови да ползва PRF вместо PBKDF2 в Фаза 3.5-pre.
3. **ML-DSA-65 performance на мобилно** — Worker работи, но не е профилиран на реален mobile device.

---

## Фаза 2: Качване на PDF + Визуализация — ЗАВЪРШЕНА ✅ (2026-07-05)

### Какво е реализирано

**Библиотеки / нови файлове:**
- `pdfjs-dist` инсталирана (legacy build — задължително за iOS Safari)
- `src/lib/pdfSanitizer.ts` — сканира raw PDF байтове (chunked, 8 KB) за опасни елементи: `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/SubmitForm`, `/ImportData`
- `src/lib/documentUpload.ts` — SHA-256 хеш (Web Crypto API), XHR upload с onProgress callback, DB insert, `softDeleteDocument`, `fetchUserDocuments`, `getDocumentSignedUrl`; audit logging за `document_uploaded`, `document_deleted`, `document_downloaded`
- `src/components/documents/UploadDocument.tsx` — drag & drop зона, стъпков прогрес (validating → scanning → hashing → uploading с реален % progress bar → done), грешки с X бутон
- `src/components/documents/DocumentList.tsx` — таблица с документи, двуредов layout (filename на ред 1, дата + статус + действия на ред 2), бутон Преглед, inline soft delete с потвърждение
- `src/components/documents/PdfViewer.tsx` — fullscreen viewer, двустъпков рендер (preview ~80 000 px бързо + quality в background), module-level JPEG кеш (instant при повторно отваряне), ExternalLink бутон за native браузъров PDF viewer, iOS-safe canvas size guard (4 MP), keyboard навигация
- `src/App.tsx` — заменен placeholder с `<DocumentList />`

**Технически решения:**
- Upload прогрес: Supabase JS не излага progress events → директен XHR към Storage REST API
- PDF blank page на iOS: pdfjs-dist стандартен build ползва `Map.prototype.getOrInsertComputed` (няма в iOS Safari) → превключено към legacy build
- Canvas size guard: iOS Safari crash при >16 MP canvas → ограничено до 4 MP
- Fit-width scale: при отваряне PDF се оразмерява автоматично по ширината на екрана
- Render кеш: module-level `Map<key, JPEG dataURL>` — повторното отваряне на документ е мигновено

### Тествано (по чеклист от потребителя)

| Тест | Резултат |
|---|---|
| Качване на нормален PDF (1–2 MB) | ✅ |
| Качване на голям PDF (~19 MB) с прогрес bar | ✅ |
| Качване на PDF над 25 MB | ✅ отказан с ясно съобщение |
| Качване на не-PDF (.docx, .jpg) | ✅ отказан с ясно съобщение |
| Качване на PDF с вграден JavaScript | ✅ отказан от sanitizer |
| Визуализация на PDF (десктоп) | ✅ |
| Визуализация на PDF (мобилно, iOS Safari) | ✅ след legacy build fix |
| SHA-256 hash в documents таблицата | ✅ |
| Файлът е в Supabase Storage bucket `documents` | ✅ |
| RLS изолация — друг потребител не вижда документа | ✅ |
| Soft delete — файлът се скрива, остава в базата с `deleted_at` | ✅ |

### Технически дълг и непокрити edge cases

1. **PDF с компресирани object streams (FlateDecode)** — `pdfSanitizer` сканира само plain-text байтове. Malicious PDF, в който `/JavaScript` е в компресиран stream, ще мине sanitization. Документирано в кода. Приемливо за текущия scope; пълна защита изисква сървърно разкомпресиране и повторен scan.

2. **Signed URLs изтичат след 5 минути** — `getDocumentSignedUrl` ги генерира с 300s TTL. При много дълго разглеждане на документ или зареждане от кеш след >5 мин, viewer-ът ще получи грешка при следващото отваряне. Fix: при reload на viewer генерира нов URL; при кеш запазваме само рендирания JPEG (не URL-а) — вече е така, но потребителят трябва да натисне "Преглед" отново за нов URL.

3. **Голям PDF рендер е бавен на мобилно (>10 MB)** — за 19 MB 1-страничен PDF: preview се показва за ~5 сек, quality рендер в background може да отнеме 1–3 мин (CPU-bound декомпресия). Workaround: бутон ↗ отваря native браузъров PDF viewer (iOS/Android), който е hardware-оптимизиран и зарежда мигновено. Пълното решение изисква server-side PDF → image конвертиране при качване (Фаза 4+).

4. **Няма pagination на DocumentList** — ако потребителят качи >50 документа, списъкът може да стане тежък. Приемливо за текущата фаза.

5. **Storage достъп при soft-deleted документ** — `deleted_at` е в DB, но файлът в Storage остава. Ако потребителят знае точния storage path, може да генерира нов signed URL за изтрит документ (ако RLS на storage.objects го позволява). Проверено само на ниво документна таблица, не storage policies.

6. **Мобилна версия на upload UI** — drag & drop не работи на мобилни браузъри, но натискането на зоната отваря file picker. Функционира коректно.

### Допълнение (2026-07-07): Document audit logging

Добавено след първоначалното завършване на Фаза 2. `documentUpload.ts` вече вика `logAuditEvent` при:
- `document_uploaded` — след успешен DB insert в `uploadDocument()`
- `document_deleted` — след успешен soft delete в `softDeleteDocument()` (добавен `userId` параметър)
- `document_downloaded` — при генериране на signed URL в `getDocumentSignedUrl()` (добавени `userId` и `documentId` параметри)

---

## Фаза 1: Passkey автентикация — ЗАВЪРШЕНА ✅ (2026-07-05)

### Какво е реализирано

- **Регистрация**: `signInWithOtp()` → email линк → реална сесия → `registerPasskey()`
- **Вход**: `signInWithPasskey()` — само биометрия/PIN, без email
- **Recovery flow** ("Забравих passkey"): email → `?recovery=1` redirect → Edge Function изтрива всички `webauthn_credentials` в `auth` schema (през SECURITY DEFINER PostgreSQL функция) → `RegisterPasskeyStep`
- **Audit log**: `signup`, `login`, `recovery_otp_verified`, `old_passkeys_deleted`, `new_passkey_registered`
- **Unsupported browser**: `UnsupportedBrowserNotice` при липса на WebAuthn
- **Split-screen дизайн** (SignShield бранд, indigo палитра)

### Архитектурни бележки

- `auth.webauthn_credentials` (не `auth.mfa_factors`) е правилната таблица за passkeys
- Edge Function ползва SECURITY DEFINER PostgreSQL функция — PostgREST не излага `auth` schema
- `useState(isRecoveryRedirect)` (function reference) инициализира state преди първия render — предотвратява dashboard flash

### Тествано

Chrome, Firefox, Safari, Edge · Windows Hello PIN · Face recognition (mobile) · Cross-device QR passkey flow · Production (`psiholog.pages.dev`) · Recovery flow end-to-end

### Технически дълг

1. **Resend без custom domain** — праща само до акаунта на собственика. За производствено ползване: нужен верифициран домейн в Resend.
2. **Email templates са на английски** — Supabase игнорира Bulgarian templates (вероятно Resend override). Изисква custom SMTP с custom templates или Supabase SMTP template директно.
3. **`needsPasskeySetup` не е origin-aware** — може да създаде объркване при localhost/production превключване.

### ВАЖНО: RP ID gotcha

Supabase Passkeys → Relying Party ID поддържа само **един** домейн наведнъж. В момента: `psiholog.pages.dev`. При локално тестване: смени RP ID + Site URL на `localhost:3000` и обратно.

---

## Фаза 0: Setup — ЗАВЪРШЕНА ✅

- Supabase клиент, `.env.local` (gitignored), TypeScript типове
- SQL миграции: `0001_initial_schema.sql`, `0002_update_profile_trigger.sql`, `0003_soft_delete_and_key_columns.sql`, `0004_delete_webauthn_rpc.sql`
- Storage buckets: `documents`, `signed-documents` (private, RLS)
- Cloudflare Pages: auto-deploy от GitHub `main`

---

## За следващата сесия: Фаза 3.5-pre — Миграция от парола към PRF

**Прочети преди да започнеш:**
- `PROJECT_BRIEF.md` Section 3.2 (PRF архитектура) и Section 6 Фаза 3.5-pre (пълен task list)
- `src/lib/crypto/keyProtection.ts` — ще се пренапише изцяло
- `src/components/keys/GenerateKeyModal.tsx` — password fields се премахват
- `src/lib/signingKeyStore.ts` — `saveSigningKey()` ще приеме `prf_salt`, `credential_id` вместо `kdf_salt`, `aes_iv`

**Ключови въпроси при имплементация:**
- `navigator.credentials.get()` изисква `rpId` — трябва да съвпада с Supabase RP ID (`psiholog.pages.dev`)
- credential_id се вика от `CredentialPublicKeyOptions.allowCredentials` или се взима от response-а при unguided ceremony
- Vitest mock: `vi.stubGlobal('navigator', { credentials: { get: vi.fn() } })`
