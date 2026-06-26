# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 завършена ✅. Фаза 1 (Passkey автентикация) — код готов, чака тест в браузър.

## Фаза 1: Passkey автентикация

### Готово (от Claude Code)

- [x] `src/lib/supabase.ts` — добавен `auth.experimental.passkey: true` (без това passkey методите гърмят грешка).
- [x] `supabase/migrations/0002_update_profile_trigger.sql` — поправка на тригъра от Фаза 0: `display_name` се чете от `raw_user_meta_data`, с fallback на email.
- [x] `src/lib/webauthnSupport.ts` — проверка дали браузърът поддържа WebAuthn.
- [x] `src/lib/auditLog.ts` — helper за запис в `audit_log`.
- [x] `src/contexts/AuthContext.tsx` — следи текущата сесия за цялото приложение.
- [x] `src/components/auth/SignUpForm.tsx` — регистрация в 2 стъпки: `signInWithOtp()` (email + display name) → `verifyOtp()` (6-цифрен код от email).
- [x] `src/components/auth/RegisterPasskeyStep.tsx` — финална стъпка: `registerPasskey()` + audit log 'signup'.
- [x] `src/components/auth/SignInForm.tsx` — вход чрез `signInWithPasskey()` (непроменено).
- [x] `src/components/auth/UnsupportedBrowserNotice.tsx` + проверка преди показване на формите.
- [x] `src/components/UserMenu.tsx` — показва име + "Изход".
- [x] `src/App.tsx` — показва: AuthScreen (email/код/вход) / RegisterPasskeyStep / "логнат" изглед — решението кой екран се показва минава през `supabase.auth.passkey.list()`, не през local state, затова работи коректно дори ако потребителят презареди страницата по средата на регистрацията.
- [x] `npm run typecheck` и `npm run lint` минават чисто (2 безвредни warning-а, 0 грешки).
- [x] `npm run dev` стартира без грешки в конзолата.

### Архитектурна корекция #2 (важна) — анонимна регистрация се отхвърля от Supabase

При реален тест Supabase сървърът отговори с `"Anonymous user not allowed to perform these actions"` при опит да закачим passkey към анонимна сесия — твърдо правило на backend-а, не bug в нашия код. Затова сменихме подхода:

**Нов flow:** `signInWithOtp()` (праща 6-цифрен код на email) → `verifyOtp()` (потребителят въвежда кода → вече има **реална**, не анонимна сесия) → `registerPasskey()`. Email се ползва само еднократно, при регистрация. Всеки следващ вход е чист passkey, без email. Това де факто потвърждава оригиналната идея в brief-а ("email + passkey registration"), просто конкретизирано като OTP код, не парола.

### Чака потребителя

#### 1. Пусни втората SQL миграция в Supabase (ако още не си)

1. Supabase Dashboard → **SQL Editor** → New query.
2. Копирай съдържанието на `supabase/migrations/0002_update_profile_trigger.sql` → Paste → **Run**.
3. Очакван резултат: "Success. No rows returned."

#### 2. Тествай в браузъра

1. `npm run dev`, отвори показания localhost адрес (внимавай — може да имаш стари dev сървъри от по-рано на портове 5173-5175; виж в твоя терминал кой порт точно показва).
2. Таб "Регистрация" → въведи име + **истински email, до който имаш достъп**.
3. "Изпрати код за потвърждение" → провери пощата си (включи и Spam).
4. Въведи 6-цифрения код → "Потвърди код".
5. Очаквано: екран "Последна стъпка" → "Регистрирай passkey" → системен Windows prompt → потвърждаваш с биометрия/PIN (или телефон/security key, ако нямаш Windows Hello настроен).
6. След успех → виждаш "логнат" изглед с твоето име и бутон "Изход".
7. "Изход" → презареди → таб "Вход" → "Влез с passkey" → би трябвало да те разпознае без email/код.
8. Кажи ми резултата на всяка стъпка, или прати screenshot/текст на грешка, ако нещо засече.

### Известно ограничение (приемливо за курсова работа)

Ако потребител потвърди email кода, но след това откаже/прекъсне passkey ceremony-то и затвори страницата — акаунтът остава "недовършен" (има реален email акаунт, но без passkey). Това **се самопочиства**: при следващ опит за регистрация със същия email, Supabase разпознава съществуващия акаунт, праща нов код, и нашата `passkey.list()` проверка автоматично показва екрана "Регистрирай passkey" отново — без дублиране на акаунти.

### Следваща стъпка (Фаза 2)

След успешен тест на регистрация + login + logout — преминаваме към Фаза 2: качване на PDF, визуализация, `<UploadDocument/>`, `<DocumentList/>`, `<PdfViewer/>`.

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
