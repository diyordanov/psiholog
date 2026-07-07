# PROJECT BRIEF — Уеб приложение за електронно подписване на PDF документи

> **За Claude Code:** Това е "контрактът" на проекта. Прочитай го в началото на **всяка** нова сесия, преди да правиш каквато и да е промяна. След това чети `PROGRESS.md` за да видиш докъде сме стигнали. Когато приключваш сесия — обнови `PROGRESS.md`.

---

## 1. Цел на проекта

Уеб приложение, в което потребител може:

1. Да се регистрира и влиза **без парола**, само с passkey (WebAuthn / биометрия).
2. Да качва PDF документ.
3. Да го подпише с криптографски подпис (по подразбиране Ed25519, опционално пост-квантов ML-DSA / Dilithium).
4. Да види визуален маркер на подписа върху страницата.
5. Да свали подписания PDF.
6. Да качи подписан PDF за **проверка на валидност** (документът променян ли е след подписване, валиден ли е подписът).

Това е курсова работа по тема "Сигурност и криптография". Кодът трябва да е **изчистен, документиран на български в README**, и да следва принципите от Section 5 на този brief.

---

## 2. Технологичен стек (ФИКСИРАН — не променяй)

- **Frontend:** Vite + React + TypeScript (вече scaffold-нат от bolt.new)
- **Backend / БД / Auth / Storage:** Supabase
  - Postgres за метаданни
  - Supabase Auth (Passkeys / WebAuthn — beta, изисква opt-in)
  - Supabase Storage за PDF файлове
  - Edge Functions (Deno) за чувствителни сървърни операции, когато трябва
- **PDF манипулация:** `pdf-lib` (модификация) + `pdfjs-dist` (визуализация)
- **Криптография:**
  - `@noble/ed25519` — за класически подпис
  - `@noble/post-quantum` — за ML-DSA-65 (Dilithium)
  - `@noble/hashes` — SHA-256, SHA-512
- **Hosting:** Cloudflare Pages (за фронтенда)
- **Език на UI:** Български

**НЕ използвай:** Python, FastAPI, pypdf, PyNaCl, custom Express сървър, JWT auth написан от нула. Spec-ът беше написан с Python в ум, но ние работим на JS/TS стек.

---

## 3. Архитектурни решения и важни корекции на спецификацията

Спецификацията съдържа няколко неточности, които **трябва да коригираш** в имплементацията:

### 3.1 WebAuthn частните ключове НЕ се пазят в БД

Спецификацията на места пише, че частните ключове "се пазят в БД криптирани". Това е грешно за WebAuthn — частните WebAuthn ключове **никога** не напускат устройството на потребителя. Supabase Auth пази само публичния ключ.

### 3.2 Подписни ключове — WebAuthn PRF защита

**Финално архитектурно решение (2026-07-07):** Подписващите ключове се защитават чрез WebAuthn PRF extension, не с парола.

**Архитектура:**

- Частният ключ (Ed25519 или ML-DSA-65) се генерира в браузъра
- AES-256 ключът за криптиране на подписващия ключ се извежда от passkey чрез WebAuthn PRF extension
- Криптираният ключ + PRF salt се записват в `signing_keys` таблицата
- Сървърът никога не вижда криптиращия ключ в plaintext
- При подписване: passkey ceremony (Face ID / Touch ID / PIN) → PRF derived key → декриптира ключа → подписва → изчиства от паметта

**Технически детайли:**

- Използваме `navigator.credentials.get()` директно (не Supabase Passkeys API) — Supabase не експонира PRF extension
- PRF salt = 32 random bytes, per-key (уникален за всеки подписващ ключ), пазен в `signing_keys.prf_salt`
- PRF output (32 bytes) → HKDF-SHA256 → AES-256 ключ + 12-byte IV (`wrapped_key_iv`)
- При генериране: пазим `credential_id` на passkey-а, ползван за PRF — нужен е при декриптиране

**Browser поддръжка (актуална за 2026):**

- Chrome / Edge: пълна поддръжка ✓
- Firefox 148+: пълна поддръжка ✓
- Safari 18+ (macOS 15+): PRF през Touch ID / Face ID / iCloud Keychain ✓
- Android: пълна поддръжка ✓

**Fallback:** Ако браузърът не поддържа PRF, UI показва ясно съобщение „Този браузър не поддържа сигурно съхранение на подписващи ключове. Използвайте Chrome, Firefox 148+ или Safari 18+." — без fallback на парола.

**UI следствие:**

- При генериране на ключ: НЯМА поле за парола. Просто клик „Генерирай" → passkey ceremony → готово.
- При подписване: passkey ceremony (както при login) → подписване. Без парола.
- НЯМА „ключова парола" никъде в UI-a.

**Recovery последствие (важно!):**

- При passkey recovery flow (Фаза 1), всички стари passkeys се изтриват
- Новият passkey има различен PRF output → не може да декриптира старите подписващи ключове
- Всички подписващи ключове на потребителя стават неизползваеми след recovery
- Стари подписи ОСТАВАТ верифицируеми (публичните ключове са embedded в PDF-те)
- Потребителят трябва да генерира нови подписващи ключове след recovery

**Warning UI в recovery flow:** Задължителен confirmation dialog преди recovery:

> ⚠️ Внимание! Ако възстановиш достъп през email, ще загубиш възможността да ползваш съществуващите си подписващи ключове.
> Вече подписани документи → остават валидни завинаги.
> Нови подписи → трябва да генерираш нови ключове след възстановяване.
> Продължаваш ли?

### 3.3 PDF Sanitization при качване

Преди да приемеш PDF, провери за:
- Вграден JavaScript (`/JavaScript`, `/JS` action dictionaries)
- Launch actions (`/Launch`)
- Embedded files (`/EmbeddedFile`) — освен ако не е известен safe тип
- Submit-form actions към външни URL

Отхвърли файла с ясно съобщение, ако намериш такива елементи. Размер: максимум 25 MB.

### 3.4 PAdES-B-Basic + хибридни подписи (Ed25519 + ML-DSA-65)

**Финално решение (2026-07-07):** всеки подписан PDF съдържа два подписа наведнъж.

**Механика:**

1. Изчисляваме SHA-256 хеш на PDF документа
2. Подписваме хеша с Ed25519 → вграждаме в PDF signature dictionary (PAdES-B-Basic формат, `SubFilter: adbe.pkcs7.detached`, X.509 сертификат за Ed25519 ключа)
3. Подписваме същия хеш с ML-DSA-65 → вграждаме като custom metadata в PDF (namespace `/PostQuantumSignature`)
4. Adobe Reader чете само Ed25519 подписа → показва „Signed by [name]"
5. Нашето приложение при верификация чете и двата → показва статус за всеки поотделно

**UI за подписване:**

1. Потребителят избира документ → кликва „Подпиши"
2. Passkey ceremony (отключва двата ключа чрез PRF)
3. Спинер „Подписваме…" (~2–3 сек — Ed25519 е бърз, ML-DSA-65 е бавен)
4. „Документът е подписан хибридно (Ed25519 + пост-квантов)"

**Ключово изискване:** потребителят трябва да има И двата типа ключове (Ed25519 + ML-DSA-65) преди да може да подписва. Ако липсва единият — UI предлага „Първо генерирайте ML-DSA-65 ключ".

**Бележка за пълен PAdES:** пълен стандарт изисква qualified timestamps и др. — извън обхвата. Документирай в README.

### 3.6 Soft deletion

**Решено от ръководителя:** никакви реални DELETE операции за потребителски данни.

- Таблиците `profiles`, `signing_keys`, `documents`, `signatures` имат `deleted_at TIMESTAMPTZ NULL`
- „Изтриване" = `UPDATE ... SET deleted_at = NOW()`
- Всички нормални queries филтрират `WHERE deleted_at IS NULL`
- RLS policies обновени съответно
- `audit_log` е изключение — тя е immutable (без `deleted_at`), записите не се изтриват никога
- Стари подписи остават валидни завинаги — публичният ключ се embed-ва в PDF-а
- При verify, ако подписващият е soft-deleted → показва „Валиден. Акаунтът е закрит на [дата]."

---

### 3.5 Криптиране на файлове

Supabase Storage предоставя server-side encryption at rest по подразбиране. Допълнителен access control:
- Buckets — private (не public).
- RLS policies — всеки потребител вижда само own файлове (`auth.uid() = owner_id`).
- Signed URLs с кратко TTL (5 минути) за download.

Не имплементирай client-side AES-256 криптиране на самите файлове — overkill за този scope и усложнява проверка от външен потребител.

---

## 4. Архитектура на данните (Supabase Postgres)

```
profiles
  id (uuid, FK to auth.users)
  display_name
  created_at
  deleted_at (timestamptz, nullable)

signing_keys
  id (uuid)
  user_id (uuid, FK)
  algorithm ('ed25519' | 'ml-dsa-65')
  public_key (bytea)
  encrypted_private_key (bytea)  -- AES-256-GCM криптиран с PRF-derived key
  prf_salt (bytea, 32 bytes)      -- per-key salt за PRF ceremony
  wrapped_key_iv (bytea, 12 bytes) -- IV за AES-GCM
  credential_id (text)            -- WebAuthn credential ID, ползван при генериране
  certificate (bytea, nullable)   -- X.509 cert (добавя се в Фаза 3.5)
  created_at
  deleted_at (timestamptz, nullable)
  -- Забележка: колоните kdf_salt, kdf_iterations, aes_iv са премахнати в migration 0006

documents
  id (uuid)
  user_id (uuid, FK)
  original_filename (text)
  storage_path (text)            -- в bucket 'documents'
  signed_storage_path (text)     -- в bucket 'signed-documents', nullable
  original_hash_sha256 (bytea)
  status ('uploaded' | 'signed')
  created_at, signed_at
  deleted_at (timestamptz, nullable)

signatures
  id (uuid)
  document_id (uuid, FK)
  user_id (uuid, FK)
  signing_key_id (uuid, FK)
  algorithm ('ed25519' | 'ml-dsa-65')
  signature_bytes (bytea)
  signed_at (timestamptz)
  visual_marker_page (int)
  visual_marker_x (numeric)
  visual_marker_y (numeric)
  deleted_at (timestamptz, nullable)

audit_log
  id, user_id, action, resource_id, ip_address, user_agent, created_at
  -- IMMUTABLE: няма deleted_at — записите не се изтриват никога (виж Section 3.6)
```

**RLS policies:** `auth.uid() = user_id` за SELECT/INSERT/UPDATE/DELETE. SELECT и UPDATE policies добавят `AND deleted_at IS NULL` (виж Section 3.6).

---

## 5. Принципи (zero-trust, минимални привилегии)

- **Всеки backend request** (включително Edge Functions) проверява `auth.uid()`.
- **Никога** не давай service_role ключ на frontend.
- **Audit log** на всички sensitive действия: login, key generation, sign, verify, download.
- **Validate input** на всеки ендпойнт — типове файлове, размери, MIME types.
- **Rate limiting** на критични операции (Supabase има вградено).
- **HTTPS only** (Cloudflare Pages го прави автоматично).

---

## 6. Фази на разработка (work in order)

### Фаза 0: Setup ✅ (frontend scaffold от bolt.new вече е готов)

- [ ] Свържи Vite проекта с Supabase (env vars, supabase-js client)
- [ ] Създай Postgres schema от Section 4 като SQL миграция
- [ ] Настрой RLS policies
- [ ] Създай Storage buckets: `documents`, `signed-documents` (и двата private)
- [ ] Свържи repo с Cloudflare Pages (deploy от main branch)
- [ ] Provision Supabase Passkeys (Dashboard → Authentication → Passkeys → enable)

### Фаза 1: Автентикация (passkey-only)

- [ ] Регистрация: email + passkey registration (Supabase `auth.registerPasskey()`)
- [ ] Login: `auth.signInWithPasskey()`
- [ ] UI компоненти: `<SignUp/>`, `<SignIn/>`, `<UserMenu/>`
- [ ] Fallback съобщение, ако браузърът не поддържа WebAuthn — линк към user guide
- [ ] Audit log за login

#### Recovery flow (забравен/изгубен passkey)

- [ ] „Забравих си passkey" линк на login страница
- [ ] Email OTP recovery: потребителят въвежда email → получава **линк** по email (идентично на регистрацията — `signInWithOtp` с `emailRedirectTo: window.location.origin + '?recovery=1'`)
- [ ] След клик на линка — App.tsx открива `?recovery=1` в URL → извиква Edge Function `delete-user-passkeys` → изтрива **всички** съществуващи passkey-и (задължително: изгубено/откраднато устройство да загуби достъп)
- [ ] След изтриването → показва `<RegisterPasskeyStep/>` за регистрация на нов passkey
- [ ] Edge Function `delete-user-passkeys` — приема user_id от JWT (authenticated context), изтрива всички passkey-и чрез Supabase admin API; използва `service_role` key — **никога не се вика от frontend директно**
- [ ] Audit log записи: `recovery_requested`, `recovery_otp_verified`, `old_passkeys_deleted`, `new_passkey_registered`
- [ ] Rate limit: разчита на Supabase вградения (max 3 опита на час на email)
- [ ] **Warning dialog преди recovery** — задължителен confirmation (виж Section 3.2 за пълния текст)
- [ ] При soft-delete на passkey: свързаните `signing_keys` НЕ се soft-delete автоматично — просто стават неизползваеми, остават в базата за история

**Бележка:** Само email OTP recovery. Без резервни passkey-и и без „добави втори passkey" в settings.

### Фаза 2: Качване на PDF + визуализация

- [ ] `<UploadDocument/>` — drag & drop, валидация на размер (max 25 MB) и MIME
- [ ] PDF sanitization (виж 3.3) — отхвърли с детайлно съобщение
- [ ] Изчисли SHA-256 hash в браузъра преди качване
- [ ] Качи в `documents` bucket, запиши в `documents` таблица
- [ ] `<DocumentList/>` — списък на own документи
- [ ] `<PdfViewer/>` — рендер с pdfjs-dist

### Фаза 3: Криптографски модул — ЗАВЪРШЕНА ✅ (парола-базирано, superseded)

> **⚠️ SUPERSEDED:** Реализирано с PBKDF2 + парола (Approach B). Заменено от Фаза 3.5-pre (PRF-базирано). Кодът остава в историята, но ще бъде преработен. Виж PROGRESS.md.

- [x] `<KeyManagement/>` — генериране на Ed25519 и ML-DSA-65 ключове
- [x] Web Worker за ML-DSA-65 keygen
- [x] Запазване в `signing_keys` (криптиран с парола → ще се мигрира към PRF)
- [x] Helper функции: `signWithEd25519()`, `signWithMlDsa()`, `verifyEd25519()`, `verifyMlDsa()`
- [x] 13 vitest unit теста

### Фаза 3.5-pre: Миграция от парола към PRF

> Трябва да завърши ПРЕДИ Фаза 3.5 (Mini-CA).

- [ ] Обнови `keyProtection.ts`: премахни PBKDF2 логиката, добави `deriveKeyFromPasskeyPRF(credentialId, prfSalt)`
- [ ] Обнови `signing_keys` schema: добави `prf_salt` (bytea, 32 bytes), `wrapped_key_iv` (bytea, 12 bytes), `credential_id` (text); премахни `kdf_salt`, `kdf_iterations`, `aes_iv`
- [ ] Миграция `0006_prf_schema.sql` + soft-delete на всички съществуващи парола-базирани ключове
- [ ] Обнови `GenerateKeyModal.tsx`: без password fields; при клик „Генерирай" → passkey ceremony → PRF → encrypt → save
- [ ] Обнови `signing.ts`: функциите вземат `signingKeyId`, вътрешно правят PRF ceremony → decrypt → sign → clear
- [ ] Vitest тестове с mock `navigator.credentials.get()`
- [ ] Ръчен тест на всички браузъри от Section 3.2

### Фаза 3.5: Mini-CA (X.509 сертификати)

> Зависи от Фаза 3.5-pre (PRF). Да започне след нея.

- [ ] Root CA генериране (script) — Ed25519 root cert, 10-годишен срок
- [ ] Edge Function `issue-certificate` — приема public key + algorithm, издава X.509 leaf cert
  - Ed25519: стандартен X.509 (`@peculiar/x509`)
  - ML-DSA-65: X.509 с custom OID (IETF Dilithium OID, само за нашия verifier)
- [ ] Frontend вика Edge Function при генериране на ключ

### Фаза 4: Подписване на PDF

> Зависи от Фаза 3.5 (Mini-CA). Изисква `pdf-lib`.

- [ ] UI: избор на документ, клик „Подпиши", избор на позиция за визуален маркер
- [ ] Passkey ceremony → PRF → decrypt Ed25519 ключ → SHA-256 на PDF → CMS wrapping → embed в PDF signature dictionary (PAdES-B-Basic)
- [ ] Passkey ceremony → PRF → decrypt ML-DSA-65 ключ → подпис на същия хеш → embed в custom PDF metadata (`/PostQuantumSignature`)
- [ ] Визуален маркер (текст: „Подписано от {name} на {date}")
- [ ] Качи signed PDF в `signed-documents` bucket; update `documents`, insert в `signatures`
- [ ] Проверка: Adobe Reader показва „Signed by [name]" ✅

### Фаза 5: Проверка на подпис

> Публичен модул — без login.

- [ ] `<VerifyDocument/>` — качване на подписан PDF
- [ ] Чете Ed25519 подпис + X.509 cert → валидира срещу Root CA
- [ ] Чете ML-DSA-65 подпис от custom metadata → валидира срещу public key
- [ ] UI показва статус поотделно:
  - „Ed25519 подпис: ✅ валиден / ❌ невалиден"
  - „Пост-квантов подпис (ML-DSA-65): ✅ валиден / ❌ невалиден"
  - „Общ статус: ✅ Документът е автентичен и непроменян"
- [ ] При soft-deleted акаунт: „Валиден. Акаунтът е закрит на [дата]."

### Фаза 6: Полиране и сигурност

- [ ] Преглед на всички RLS policies
- [ ] Audit log за всички sensitive действия
- [ ] Rate limiting на Edge Functions
- [ ] Error handling и user-friendly съобщения
- [ ] Browser compatibility user guide (Firefox + Windows Hello инструкции)
- [ ] README на български — архитектура, инструкции за стартиране, какво е реализирано / какво не

### Фаза 7: Тестове и финал

- [ ] Vitest unit тестове за крипто helper-ите
- [ ] Manual test checklist (signup → upload → sign → download → verify)
- [ ] Deploy на Cloudflare Pages — финална проверка

---

## 7. Convention rules за Claude Code

1. **Никога не commit-вай secrets** — Supabase URL/anon key през `.env.local`, в `.gitignore`.
2. **TypeScript strict mode** — никакъв `any`, освен ако не е документирано защо.
3. **Tailwind** за стилове (вече настроен от bolt.new), без extra CSS framework.
4. **Малки компоненти** — един компонент = един файл, max ~150 реда. Логиката отделена в `/lib`.
5. **Никога не пиши custom crypto** — само noble libraries. Никакво "rolling our own".
6. **Документирай на български в коментарите** за по-сложните части (крипто, PAdES логика).
7. **При несигурност за дизайн решение** — питай в чата с потребителя, не предполагай.
8. **Обновявай `PROGRESS.md`** в края на сесия — какво е готово, blocker-и, следваща стъпка.

---

## 8. Полезни референции

- Supabase Passkeys docs: https://supabase.com/docs/guides/auth/passkeys
- noble libraries: https://paulmillr.com/noble/
- pdf-lib: https://pdf-lib.js.org/
- pdfjs-dist: https://mozilla.github.io/pdf.js/
- ML-DSA / Dilithium (FIPS-204): https://csrc.nist.gov/pubs/fips/204/final

---

## 9. Срок

Финал: **15 септември 2026**. Старт: края на юни 2026. ~12 седмици, средно по 10 часа седмично.
