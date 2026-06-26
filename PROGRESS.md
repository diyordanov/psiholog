# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 ✅ и Фаза 1 ✅ завършени (2026-06-26). Следва Фаза 2.

## Фаза 1: Passkey автентикация — ЗАВЪРШЕНА ✅ (2026-06-26)

### Какво е реализирано

- **Регистрация** (само веднъж, при нов потребител): `signInWithOtp()` праща линк за потвърждение на email (display name отива в `user_metadata`) → потребителят кликва линка → реална (не анонимна) сесия → `registerPasskey()` закача WebAuthn passkey към профила.
- **Вход** (всеки следващ път): чист `signInWithPasskey()` — без email, без код, само биометрия/PIN на устройството.
- **Audit log**: `signup` и `login` действия се записват в `audit_log` таблицата (`src/lib/auditLog.ts`).
- **Fallback за browsers без WebAuthn**: `src/lib/webauthnSupport.ts` проверява `PublicKeyCredential`/`navigator.credentials`, при липса показва `UnsupportedBrowserNotice` вместо формите.
- **Routing логика** (`src/App.tsx`): кой екран се показва (auth форма / "довърши passkey" / dashboard) минава през `supabase.auth.passkey.list()` — реална проверка дали потребителят има regisтриран passkey, не локален флаг. Работи коректно дори при презареждане на страницата по средата на регистрацията.
- Файлове: `src/lib/supabase.ts`, `src/contexts/AuthContext.tsx`, `src/components/auth/{SignUpForm,SignInForm,RegisterPasskeyStep,UnsupportedBrowserNotice,AuthScreen}.tsx`, `src/components/UserMenu.tsx`, `supabase/migrations/0002_update_profile_trigger.sql`.

### Архитектурни корекции спрямо първоначалния brief (Section 6.1)

1. **Анонимна регистрация е забранена от Supabase** — сървърът връща `"Anonymous user not allowed to perform these actions"` при опит да закачим passkey към анонимна сесия. Затова регистрацията минава през реален email (OTP/линк), не анонимна сесия — потвърждава оригиналната идея в brief-а ("email + passkey"), просто през линк за потвърждение, не парола.
2. **RP ID / Site URL е единствен домейн наведнъж** — виж "Важно за следващата сесия" по-долу.

### Тествано успешно

- **Браузъри:** Chrome, Firefox, Safari/Edge.
- **Устройства/методи:** Windows Hello PIN (лаптоп), мобилен телефон (face recognition + cross-device QR passkey flow).
- **Среди:** локално (`localhost:3000`) и production (`https://psiholog.pages.dev`) — отделно, с превключване на Supabase конфигурация между тях (виж по-долу).
- Пълен цикъл: регистрация → passkey ceremony → "логнат" изглед → Изход → презареждане → Вход с passkey.

### НЕ е тествано / известни огранияения

- **Стар браузър без WebAuthn** — `UnsupportedBrowserNotice` компонентът съществува и логиката е проверена с код ревю, но не е реално тествано в браузър без WebAuthn поддръжка.
- **Security key (USB)** — не е тествано (нужен е реален FIDO2 хардуер, напр. YubiKey; обикновена USB флашка не работи — няма криптографски чип).
- **Audit log записите** не са визуално проверени в Supabase Table Editor (логиката е написана и викана, но не сме отворили таблицата да потвърдим редовете реално кацат).
- **Display name** в `profiles` таблицата (от `raw_user_meta_data`) не е визуално потвърдено в Table Editor — само косвено, чрез `UserMenu` показващ име в браузъра.

### ВАЖНО за следващата сесия — RP ID / Site URL gotcha

Supabase Passkeys конфигурация (Authentication → Passkeys) има **Relying Party ID**, което поддържа само **един** домейн (или поддомейни на него) наведнъж — в момента е сетнато на `psiholog.pages.dev` (production), след днешните live тестове.

**Ако искаш да тестваш passkey локално (`localhost:3000`) следващата сесия:**
1. Supabase Dashboard → Authentication → Passkeys → смени **Relying Party ID** обратно на `localhost`.
2. Authentication → URL Configuration → Site URL → обратно на `http://localhost:3000`.
3. (Vite вече е фиксиран на порт 3000 в `vite.config.ts` — не пипай това, то трябва точно да съвпада.)

Ако забравиш да го смениш — passkey ще гърми с грешка от типа `"RP ID 'X' is invalid for this domain"` или `webauthn_verification_failed`. Това коства часове дебъгване днес, затова го пиша тук изрично.

### Технически дълг (направено набързо, за поправка по-късно)

1. **Resend email е в test режим** — `onboarding@resend.dev` подателят може да праща **само** до email-а на собственика на Resend акаунта. Никой друг (преподавател, тестов потребител) не може да се регистрира на production засега. Нужно: верифициран собствен домейн в Resend (изисква DNS достъп до домейн, който потребителят все още няма).
2. **`needsPasskeySetup` проверката не е origin-aware** — гледа "има ли потребителят изобщо passkey" (през `passkey.list()`), не "има ли passkey **за текущия domain**". На практика няма проблем за реални потребители (един production домейн), но създаде объркване при нашите localhost/live тестове днес. `PasskeyListItem` от Supabase не носи domain информация, така че няма лесен fix без промяна в подхода.
3. **Множество тестови акаунти** в Supabase `auth.users` от дебъгването днес (анонимни тестови потребители, недовършени регистрации) — безвредни (cascade delete е настроен), но може да се изчистят по желание през Authentication → Users.
4. **Множество запазени passkey-та** в Windows Hello / Chrome Password Manager на тестовата машина от повторните опити — чисто тидиност, не е грешка.

### Следваща стъпка: Фаза 2 — Качване на PDF + визуализация

`<UploadDocument/>` (drag&drop, валидация на размер/MIME, PDF sanitization), SHA-256 hash в браузъра, качване в `documents` bucket, `<DocumentList/>`, `<PdfViewer/>` с `pdfjs-dist`.

---

## Архив: Фаза 0 (Setup) — завършена

### Готово (от Claude Code)

- [x] Инсталиран `@supabase/supabase-js`.
- [x] Създаден `src/lib/supabase.ts` — Supabase клиент, чете URL/key от env vars.
- [x] Създаден `.env.local` (gitignored, не е в repo) с реалните `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.
- [x] Добавени TypeScript типове за `import.meta.env` в `src/vite-env.d.ts`.
- [x] Написана SQL миграция `supabase/migrations/0001_initial_schema.sql`:
  - Таблици: `profiles`, `signing_keys`, `documents`, `signatures`, `audit_log` (по Section 4 на brief-а).
  - Trigger, който автоматично създава `profiles` ред при регистрация на нов потребител.
  - RLS policies на всяка таблица (`auth.uid() = user_id`).
  - **Отклонение от brief-а, флагнато тук съзнателно:** `signatures` и `audit_log` имат само SELECT + INSERT policies (без UPDATE/DELETE) — за да не може потребител да изтрие/промени следа от вече направен подпис или audit запис. Останалите таблици следват буквално "auth.uid() = user_id за SELECT/INSERT/UPDATE/DELETE".
  - Storage buckets `documents` и `signed-documents` (private), + RLS policies на `storage.objects` по конвенция за пътя `<user_id>/<filename>`.
- [x] `npm run typecheck` минава чисто.

### Чака потребителя (ръчни стъпки в dashboard-и — Claude Code няма достъп дотам)

#### 1. Пусни SQL миграцията в Supabase

1. Отвори https://supabase.com/dashboard/project/dwrcpsdmoeiughxyaxvz
2. Ляво меню → **SQL Editor** → **New query**.
3. Отвори файла `supabase/migrations/0001_initial_schema.sql` от проекта, копирай **цялото съдържание**.
4. Paste в SQL Editor → бутон **Run**.
5. Очакван резултат: "Success. No rows returned." Ако видиш грешка — копирай я и ми я пратù.
6. Провери: ляво меню → **Table Editor** → трябва да видиш 5-те таблици (`profiles`, `signing_keys`, `documents`, `signatures`, `audit_log`).
7. Провери: ляво меню → **Storage** → трябва да видиш 2 bucket-а (`documents`, `signed-documents`), и двата маркирани като **Private**.

#### 2. Включи Passkeys

1. Същия Supabase проект → ляво меню → **Authentication** → **Sign In / Providers** (или **Passkeys**, в зависимост от версията на dashboard-а).
2. Намери секция **Passkeys (WebAuthn)** → enable toggle.
3. Запази.

#### 3. Свържи repo с Cloudflare Pages

1. https://dash.cloudflare.com → избери акаунта си → ляво меню **Workers & Pages** → **Create** → таб **Pages** → **Connect to Git**.
2. Избери GitHub → авторизирай Cloudflare (ако за първи път) → избери repo `psiholog`.
3. Настройки за build:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Environment variables (важно!) — добави същите две от `.env.local`:
   - `VITE_SUPABASE_URL` = `https://dwrcpsdmoeiughxyaxvz.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = (anon key-я, същия като в `.env.local`)
5. **Save and Deploy**.
6. След deploy — провери дали сайтът се отваря на даденото `*.pages.dev` URL.
