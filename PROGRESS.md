# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 ✅ · Фаза 1 ✅ · Фаза 2 ✅ · Фаза 3 ✅ завършени. Следва: Фаза 4 (подписване на PDF).

---

## Фаза 3: Криптографски модул — ЗАВЪРШЕНА ✅ (2026-07-06)

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

### Тествано (vitest)

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

**Резултат: 13/13 тестове ✅ · `npm run build` ✅**

### Технически дълг

1. **Ключова парола vs WebAuthn PRF**: В момента използваме парола → PBKDF2 (Approach B). Ако ръководителят реши да мигрираме към PRF extension (Approach A), само `keyProtection.ts` се сменя.
2. **`fetchKeyDecryptData()` не е тествано в браузъра** — ще се тества при Фаза 4 при реално подписване.
3. **ML-DSA-65 performance на мобилно** — Worker не е тестван на реален mobile device.

---

## Фаза 2: Качване на PDF + Визуализация — ЗАВЪРШЕНА ✅ (2026-07-05)

### Какво е реализирано

**Библиотеки / нови файлове:**
- `pdfjs-dist` инсталирана (legacy build — задължително за iOS Safari)
- `src/lib/pdfSanitizer.ts` — сканира raw PDF байтове (chunked, 8 KB) за опасни елементи: `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/SubmitForm`, `/ImportData`
- `src/lib/documentUpload.ts` — SHA-256 хеш (Web Crypto API), XHR upload с onProgress callback, DB insert, `softDeleteDocument`, `fetchUserDocuments`, `getDocumentSignedUrl`
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

## За следващата сесия: Фаза 4 — Подписване на PDF

**Цел:** потребителят избира качен документ + активен ключ → въвежда ключова парола → подписва PDF → signed PDF се качва в `signed-documents` → статусът на документа се сменя на "Подписан".

**Прочети преди да започнеш:**
- `PROJECT_BRIEF.md` Section 3.4 (PAdES-inspired подход) и Section 4 (схема на `signatures` таблицата)
- `src/lib/signingKeyStore.ts` — `fetchKeyDecryptData()` е готова за Фаза 4
- `src/lib/crypto/` — всички signing функции са готови
- `pdf-lib` трябва да се инсталира (за incremental update на PDF)

**Зависимости (вече готови):**
- `signing_keys` таблица е попълваема (Фаза 3 ✅)
- `documents.status` поддържа `'uploaded' | 'signed'`
- `signatures` таблицата съществува от 0001 миграция
