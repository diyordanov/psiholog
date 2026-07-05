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

### 3.2 Подписни ключове (Ed25519 / Dilithium) — два възможни подхода

Има два валидни подхода. **Подразбиращ се за този проект — Подход A (client-side):**

- **Подход A (препоръчителен):** Подписващите ключове се генерират и пазят **в клиента**, в `IndexedDB`, криптирани със симетричен ключ, който се извежда от passkey ceremony (PRF extension на WebAuthn, ако е наличен в браузъра — fallback на парола за encryption, която потребителят задава отделно). Този подход е по-чист криптографски — частният ключ не вижда сървъра никога.
- **Подход B (fallback):** Ако PRF extension не е наличен — ключовете се пазят в Supabase, криптирани с AES-GCM, като ключът за криптиране е изведен от парола на потребителя през PBKDF2. Това е по-слабо, но работещо.

Документирай в README какъв подход е избран и защо.

### 3.3 PDF Sanitization при качване

Преди да приемеш PDF, провери за:
- Вграден JavaScript (`/JavaScript`, `/JS` action dictionaries)
- Launch actions (`/Launch`)
- Embedded files (`/EmbeddedFile`) — освен ако не е известен safe тип
- Submit-form actions към външни URL

Отхвърли файла с ясно съобщение, ако намериш такива елементи. Размер: максимум 25 MB.

### 3.4 PAdES — приближение, не пълна имплементация

Пълен PAdES стандарт изисква CMS обвивка, qualified timestamps и др. — извън обхвата на курсова работа. Имплементираме **"PAdES-inspired"** подход:

- Подписът се вгражда в PDF като incremental update с signature dictionary.
- Подписват се: SHA-256 хеш на оригиналния документ + метаданни (потребител, време, алгоритъм).
- При проверка — извличаме оригиналния PDF (без последния update), хешираме, сравняваме.
- Документирай в README какво е реализирано и какво не (пълен PAdES не).

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
  -- Подход B (fallback): ако PRF не е наличен, частният ключ се пази в БД криптиран
  encrypted_private_key (bytea, nullable)
  kdf_salt (bytea, nullable)
  kdf_iterations (int, default 600000, nullable)
  aes_iv (bytea, nullable)
  certificate (bytea, nullable)
  -- private key по подразбиране се пази в клиента (IndexedDB) — виж Section 3.2
  created_at
  deleted_at (timestamptz, nullable)

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

**Бележка:** Само email OTP recovery. Без резервни passkey-и и без „добави втори passkey" в settings.

### Фаза 2: Качване на PDF + визуализация

- [ ] `<UploadDocument/>` — drag & drop, валидация на размер (max 25 MB) и MIME
- [ ] PDF sanitization (виж 3.3) — отхвърли с детайлно съобщение
- [ ] Изчисли SHA-256 hash в браузъра преди качване
- [ ] Качи в `documents` bucket, запиши в `documents` таблица
- [ ] `<DocumentList/>` — списък на own документи
- [ ] `<PdfViewer/>` — рендер с pdfjs-dist

### Фаза 3: Криптографски модул

> **⚠️ ЧАКА ОТГОВОР ОТ РЪКОВОДИТЕЛЯ:** Има отворени архитектурни въпроси за подписването (PAdES обхват, съхранение на подписните ключове, Dilithium съвместимост). НЕ започвай тези фази до получаване на решения. Виж `FOLLOWUP_QUESTIONS.md`.

- [ ] `<KeyManagement/>` — потребителят генерира ключ (Ed25519 по default)
- [ ] Опция за генериране на ML-DSA-65 ключ (по-голям, дълга бутон секунди)
- [ ] Запази public key в `signing_keys`, private key в IndexedDB (виж 3.2 за обяснение)
- [ ] Helper функции: `signWithEd25519()`, `signWithMlDsa()`, `verifyEd25519()`, `verifyMlDsa()`
- [ ] Unit тестове на helper-ите (vitest)

### Фаза 4: Подписване на PDF

> **⚠️ ЧАКА ОТГОВОР ОТ РЪКОВОДИТЕЛЯ:** Има отворени архитектурни въпроси за подписването (PAdES обхват, съхранение на подписните ключове, Dilithium съвместимост). НЕ започвай тези фази до получаване на решения. Виж `FOLLOWUP_QUESTIONS.md`.

- [ ] UI: избор на алгоритъм + клик върху страница за позиция на визуалния маркер
- [ ] Изчисли финален хеш = SHA-256(оригинал + metadata JSON)
- [ ] Подпиши с избрания ключ
- [ ] С `pdf-lib`:
  - Добави incremental update със signature dictionary
  - Embed metadata: подписващ user_id, време, алгоритъм, signature (base64), public_key (base64)
  - Добави визуален маркер (текст: "Подписано от {name} на {date}")
- [ ] Качи signed PDF в `signed-documents` bucket
- [ ] Update `documents.signed_storage_path`, insert в `signatures`

### Фаза 5: Проверка на подпис

> **⚠️ ЧАКА ОТГОВОР ОТ РЪКОВОДИТЕЛЯ:** Има отворени архитектурни въпроси за подписването (PAdES обхват, съхранение на подписните ключове, Dilithium съвместимост). НЕ започвай тези фази до получаване на решения. Виж `FOLLOWUP_QUESTIONS.md`.

- [ ] `<VerifyDocument/>` — качване на подписан PDF (без login изискване — публичен инструмент)
- [ ] Извлечи embedded metadata + signature
- [ ] Реконструирай оригиналния hash
- [ ] Верифицирай signature с embedded public key
- [ ] UI индикация: ✅ Валиден / ❌ Невалиден / ⚠️ Документът е променян след подписване
- [ ] Покажи: кой е подписал, кога, с какъв алгоритъм

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
