# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 ✅ · Фаза 1 ✅ · Фаза 2 ✅ · Фаза 3 ✅ (superseded) · Фаза 3.5-pre ✅ · Фаза 3.5 ✅ · Фаза 4 Ден 1 ✅ · Фаза 4 Ден 2 ✅ · Фаза 4 Ден 3 ✅ · Фаза 4 Ден 4 ✅ · **Фаза 5 ✅ COMPLETE** (Ден 1–4) · **Фаза 6 ✅ COMPLETE** (Ден 1–3 + Hotfixes) · **Фаза 7 ⏳ NOT STARTED** (Документация + подготовка за защита).

> Функционалната имплементация е завършена. Остава документация и подготовка за защита.

---

## Фаза 8: Multi-signer workflow (DocuSign-style) — Ден 1 ✅, Ден 2 Стъпка 1 ✅, Ден 2 Стъпка 2 ✅, Ден 3 ✅, Ден 4 ✅, Ден 5 ✅, Ден 6 ⏳ (код готов, чака live UI потвърждение + screenshots), Ден 7 (email покани) ✅ реализирано по-рано от плана

### Ден 7 (изтеглен по-рано, преди финалните Ден 6 screenshots): реални email покани (2026-07-28)

Причина да се изтегли напред: тестването на Ден 6 (recipient флоу) изискваше
покана до НЕрегистриран email адрес (`fanimefrenzyy@gmail.com`) — без реален
email доставяне единственият начин да се тества е ръчно копиране на
`/invite/:id` линка, което е недостатъчно за пълен E2E цикъл.

**Първи опит (отхвърлен от потребителя):** отделен `send-invitation-email`
Edge Function, викащ директно Resend HTTP API с нов, самостоятелен
`RESEND_API_KEY` secret. Проблем: Resend sandbox режим (без верифициран
домейн) изпраща само до собствения email на Resend акаунта — не до
произволни адреси, точно каквото трябваше да се тества. Deploy-нат и после
изтрит (`supabase functions delete send-invitation-email`) след обратна
връзка от потребителя.

**Финален подход:** reuse на СЪЩИЯ механизъм, който вече праща signup/recovery
имейлите (Фаза 1) — `supabase.auth.signInWithOtp()`. Няма нов Edge Function,
няма нов Resend API key, няма sandbox ограничение (доказано работи с
произволни адреси в production още от Фаза 1 тестването).
- `src/lib/signingRequestService.ts` — `sendInvitationEmail(recipientId, invitedEmail)`
  вика `signInWithOtp({ email: invitedEmail, options: { shouldCreateUser: true,
  emailRedirectTo: '<origin>/invite/<recipientId>' } })`. `shouldCreateUser: true`
  — идентично на нормалния signup за нерегистриран email; за вече регистриран
  recipient просто го логва през magic link. `sendAllInvitationEmails()` —
  Promise.allSettled batch wrapper, връща брой успешно изпратени за UI feedback.
- `src/components/documents/InviteRecipientsModal.tsx` — след успешен
  `signAsOwner()`, fetch-ва новосъздадените recipient редове
  (`getSigningRequestDetails`) и праща покани best-effort (неуспех не отменя
  вече създадената заявка). Success екранът показва "Изпратени X от Y покани
  по email" (или "останалите получатели може да получат линка ръчно" при
  partial failure).
- **`src/App.tsx` критичен routing fix:** `/invite/:recipientId` вече НЕ е
  early-return преди passkey gate-а (за разлика от `/verify`) — преместен е
  СЛЕД `needsPasskeySetup` проверката. Причина: нов recipient, кликнал
  magic link имейла, получава РЕАЛНА сесия директно (не anonymous) — ако
  `/invite/` route-ът бе early-return преди passkey проверката, нов recipient
  без passkey би кацнал направо на `InvitationLandingPage` без възможност да
  регистрира passkey, и всеки опит за подпис би fail-нал с "Няма активен
  ECDSA P-256 ключ" без изход. Сега: нов recipient → `RegisterPasskeyStep`
  първо → чак после `InvitationLandingPage`. Вече регистриран recipient
  (има passkey) минава директно.

**Known limitation (документирано, не блокира):** email темплейтът е
Supabase-related default "magic link" (на английски — виж Фаза 1 known issue
#2), не custom-brand-иран "X ви покани да подпишете Y" — reuse-ването на
`signInWithOtp` жертва custom съдържание за сигурна, вече доказана доставка.
Custom Bulgarian template за тази конкретна операция е future work (изисква
custom SMTP template в Supabase Dashboard, не код).

**Статус на тестовете:** `npx tsc --build --force` чист, **189/189 unit
теста** (без нови — чисто integration промяна, разчита на съществуващото
`signInWithOtp` покритие от Фаза 1).

### Ден 6 hotfix v4: overflow fix (auto-layout маркери) + пълна кирилица + in-app нотификации (2026-07-29)

Live тестване разкри 4 отделни проблема след hotfix v1-v3: (1) дълги имена
на файлове преливат извън контейнера в InvitationLandingPage, (2) recipient
маркерите ("hotfix v2", виж по-долу) са четими, но твърде малки — с 3
подписа третият излизаше извън страницата, (3) искане текстът в тях да е
пълна кирилица (не латиница транслитерация), (4) искане за in-app
нотификации при всеки подпис.

**#1 fix:** `InvitationLandingPage.tsx` — липсваше `min-w-0 flex-1` на
flex-child div-овете, `truncate` не можеше да ограничи ширината им (класически
Tailwind flex-overflow капан).

**#2/#3 (заедно, по-голяма промяна) — пълна кирилица + auto-layout:**
- `src/lib/pdf/cidFont.ts` (нов) — subset Unicode (Type0/CIDFontType2) font
  embedding директно през `fontkit` (не пълен pdf-lib `PDFDocument`
  round-trip, който би преизчислил вече подписаните байтове от предходния
  signer) — ръчно построени Type0/CIDFontType2/FontDescriptor/FontFile2 PDF
  обекти (raw byte templates, същия стил като останалата част от
  `prepareIncrementalSignature`). Съзнателно без `/ToUnicode` CMap (нужен
  само за text search/copy-paste, не за рендиране) — намалява scope/риск.
  Замества по-ранната `transliterateToLatin()` (изтрита изцяло, вкл. тестове)
  от hotfix v2 — recipient маркерите вече показват пълна кирилица, идентично
  на owner-ския маркер. Потвърдено визуално от потребителя в Adobe Reader.
- `src/lib/pdf/markerLayout.ts` (нов) — `computeAutoLayoutSlots()`/
  `validateMarkerZone()`. Замества click-to-position-за-всеки-участник UI-я:
  owner очертава ЕДНА обща зона (drag правоъгълник) върху документа,
  функцията я разделя на N равни хоризонтални слота — по дефиниция не могат
  да излязат извън зоната → не могат да излязат извън страницата (решава
  overflow бъга директно, не само козметично). Кумулативно закръгляне на
  границите на слотовете (не независимо на всяка ширина) — иначе последният
  слот "изтича" с 1pt при half-integer division.
- Marker размерът е динамичен навсякъде по веригата: `SignOptions`/
  `IncrementalSignOptions` (`markerWidth`/`markerHeight`, default 200×50,
  backward compat), нови DB колони `marker_width`/`marker_height`
  (migration 0017, DEFAULT 200/50 за стари редове), текстът в маркера е
  закотвен към ГОРНИЯ край (не долния) — ако зоната е по-висока от 50pt,
  остава празно място отдолу вместо да се чупи 4-редовият layout.
- `InviteRecipientsModal.tsx` StepPositions — пълен UI rewrite:
  mousedown/mousemove/mouseup drag overlay върху PDF thumbnail-а вместо
  click-per-participant; преглед на финализираните слотове (цветни
  правоъгълници с номера) directly върху документа.
- 8 нови unit теста (`markerLayout.test.ts`) + 1 обновен структурен тест за
  CID/Type0 обектите (`pdfMultiSign.test.ts`).

**#4 in-app нотификации:**
- Migration 0018 — таблица `notifications` + SECURITY DEFINER RPC
  `notify_signing_participants(signing_request_id, type, message,
  exclude_user_id)`. RPC вместо директен INSERT policy — insert-ващият
  (текущият signer) трябва да пише редове за ДРУГИ потребители
  (owner + sibling recipients), което не е изразимо с проста row-level
  policy без да отвори произволен insert достъп (същия принцип като
  `claim_recipient_invitation`, migration 0010).
- `src/lib/notificationService.ts` (нов) + `src/hooks/useNotifications.ts` —
  explicit refetch pattern (не realtime, виж `usePendingInvitationsCount`
  за същата обосновка).
- `src/components/NotificationBell.tsx` (нов) — bell икона с unread badge +
  dropdown списък, вградена в `MainApp` header-а до `UserMenu`.
- Тригер точки в `signingService.ts`: `signAsOwner()` (ако има recipients)
  → `type='owner_signed'`; `attemptRecipientSign()` (винаги) →
  `type='recipient_signed'`; при `allSigned` — допълнително
  `type='request_completed'`. И трите best-effort (грешка тук не отменя
  вече записания подпис).

**Статус на тестовете:** `npx tsc --build --force` чист, **194/194 unit
теста** (186 + 8 нови markerLayout).

**ВАЖНО: migrations 0017 и 0018 трябва да се приложат ръчно в Supabase SQL
Editor** преди следващия live тест.

### Ден 6 hotfix: критичен RLS bug (преждевременно "completed") + латиница в recipient маркерите (2026-07-28)

Открито при първия реален live E2E тест (2 recipients: 1 регистриран, 1 не):
след като подписа само ЕДИНИЯТ recipient, заявката премина в `completed` и
документът в `signed`, въпреки че вторият recipient изобщо не беше подписал
(нито дори claim-нал поканата).

**Root cause:** `attemptRecipientSign()` (`signingService.ts`) проверява дали
ВСИЧКИ recipients са подписали чрез SELECT към `signing_request_recipients`,
изпълнен от СЕСИЯТА НА RECIPIENT-А (не owner). Съществуващите RLS policies
(migration 0010) позволяват на recipient да вижда само СОБСТВЕНИЯ си ред —
никаква policy не позволяваше да види redовете на другите recipients на
същата заявка. Заявката тихо връщаше 1 ред (своя, `signed`) →
`.every(r => r.status === 'signed')` на единичен елемент → тривиално `true`
→ преждевременно завършване. Класически RLS "тих филтър вместо грешка" бъг,
от същото семейство като migrations 0013/0014.

**Fix:**
- `supabase/migrations/0016_recipient_select_sibling_recipients.sql` — нов
  SELECT policy `recipients_select_siblings`, ползващ съществуващия
  `is_signing_request_recipient()` helper (migration 0011) — claim-нат
  recipient вижда ВСИЧКИ redове на заявката, на която е участник (не само
  своя). Мигрецията включва и data-repair UPDATE за вече повредени тестови
  заявки (връща `completed`→`awaiting_recipients`, `signed`→`uploaded`,
  запазвайки реалния файл/version непроменени — само DB статус полетата
  бяха грешни).

Отделно, тестването разкри че recipient-ските визуални маркери (за разлика
от owner-ския) са напълно празни (само рамка, без текст) — това е
съзнателно Ден 2 архитектурно решение (append-only incremental update,
ръчна PDF byte manipulation, без CID Unicode font embedding), но изглежда
недовършено визуално. Решено (по избор на потребителя, cost/risk trade-off):
- `src/lib/pdf/pdfSigner.ts` — `prepareIncrementalSignature()` вече рисува
  текст в appearance stream-а чрез base-14 Helvetica/WinAnsiEncoding (БЕЗ
  font embedding — Helvetica е винаги наличен, не изисква FontFile2/
  CIDToGIDMap/ToUnicode graft). `signerName` минава през нов
  `transliterateToLatin()` helper (официална българска транслитерация,
  кирилица→латиница, + strip на всичко извън printable ASCII като safety
  net) — recipient маркерите са на латиница ("Digitally signed" / транслит.
  име / дата / "ECDSA P-256"), за разлика от owner-ския маркер (пълна
  кирилица, през нормален pdf-lib `embedFont`). Пълно кирилица CID font
  embedding в raw incremental update е документирано като future work
  (значително по-скъп/рисков подход — нов helper модул + graft на font
  object graph с renumbering в крехкия append-only pipeline).
- 4 нови unit теста в `pdfMultiSign.test.ts`: `transliterateToLatin()`
  (транслитерация, ASCII passthrough, non-ASCII strip) + appearance stream
  съдържа транслитерираното име и `/BaseFont /Helvetica`, без кирилица в
  новите байтове.

**Статус на тестовете:** `npx tsc --build --force` чист, **189/189 unit
теста** (185 + 4 нови).

**ВАЖНО: migration 0016 трябва да се приложи ръчно в Supabase SQL Editor**
преди следващия E2E тест — иначе бъгът с преждевременното завършване ще се
повтори.

### Ден 6: Recipient UI — InvitationLandingPage + PendingInvitationsPage + RecipientSigningModal — код готов (2026-07-28)

Recipient-ската страна на multi-signer flow-а — огледален на Ден 5 (owner UI), но
без избор на позиция (фиксирана от owner-а при поканата) и с public route за
непознати посетители. Реални email-и (Ден 7) остават извън scope тук.

**Ред на работа (по изрична инструкция):** първо `usePrfCeremony` extraction
(deduplication на PRF ceremony логиката между `SignDocumentModal` и
`InviteRecipientsModal`, извикана от двата преди новия recipient код), после
трите нови компонента.

**`src/hooks/usePrfCeremony.ts` (нов)** — споделен hook за single-vs-dual PRF
ceremony + iOS-safe ordering (captured веднъж — extractors се "запомнят" при
първо извикване). Извлечен от идентичния inline код в `SignDocumentModal.tsx`
и `InviteRecipientsModal.tsx` (вкл. локалния `saltsEqual` helper); и двата
рефакторирани да ползват `performCeremony()` вместо дублирана логика.
**Забележка:** `RecipientSigningModal` НЕ ползва този hook — виж по-долу.

**Нови файлове:**
- `src/components/invitations/InvitationLandingPage.tsx` — публичен route
  `/invite/:recipientId` (регистриран в `App.tsx` ПРЕДИ auth-gate-а, по същия
  модел като `/verify`). State machine:
  - `not_logged_in` — генерично съобщение + вграден `<AuthScreen/>` НА СЪЩАТА
    страница (без redirect round-trip) — след успешен login/signup
    компонентът реактивно преминава в следващото състояние (auth state се
    следи през `useAuth()`).
  - `checking` → `claimInvitation(recipientId)` (SECURITY DEFINER RPC,
    migration 0010) → `getInvitationDetails(recipientId)`.
  - `wrong_email` — RPC грешката съдържа "друг email" → специфичен UI с
    „Излез и влез с правилен акаунт" (`supabase.auth.signOut()`).
  - `error` — catch-all за всичко друго (невалиден token, вече claim-нат от
    друг акаунт) — показва директно RPC съобщението (вече е ясно на
    български, не се remap-ва в отделни enum стойности).
  - `cancelled` — `request.status === 'cancelled'`.
  - `details` — успешен claim → owner, документ, позиция + бутон „Подпиши"
    → отваря `RecipientSigningModal`.
- `src/components/invitations/PendingInvitationsPage.tsx` — recipient
  dashboard (5-ти таб). `listMyInvitations(email)` (auto-claim на всички
  все още unclaimed покани при зареждане + пълни детайли за всички),
  филтрирани през `isInvitationPending()` за списъка. Empty state „Нямате
  чакащи покани". Всеки ред → „Подпиши" отваря `RecipientSigningModal`.
- `src/components/documents/RecipientSigningModal.tsx` — 2-стъпков модал
  (не 3, за разлика от `SignDocumentModal`/`InviteRecipientsModal`):
  Стъпка 1 „Потвърждение" (read-only preview с маркер на ФИКСИРАНАТА от
  owner-а позиция — без клик-за-позициониране), Стъпка 2 „Подписване"
  (progress checkpoints 5/15/35/55/75/100, по-малко от owner-ските
  5/15/35/55/70/85/100 — incremental flow няма ML-DSA-65 стъпка). Reuse на
  `ModalHeader`/`ModalFooter`/`InfoRow`/`usePdfThumbnail` от
  `SignDocumentModal.tsx` (вече `export`-нати от Ден 5). `ModalHeader`
  разширен с опционален `totalSteps` проп (default 3) — recipient модалът
  подава `totalSteps={2}`.
  **Ключова разлика от `usePrfCeremony`:** НЕ capture-ва PRF резултата
  предварително — `signAsRecipient()` подава `undefined` за
  `extractPrf`/`extractDualPrf`, което кара `signingService.ts` да ползва
  default-ите си (`browserPrfExtractor`/`browserDualPrfExtractor` директно) —
  тези правят НОВ WebAuthn prompt при всяко извикване, нужно защото
  `signAsRecipient()` retry-ва до 3 пъти при race с друг recipient
  (`ConcurrentSignError`, виж Ден 4) и всеки retry сменя message digest-а
  (старият PRF резултат вече не е валиден). UI-я показва каквото label подаде
  retry loop-ът вътрешно (напр. „Друг участник подписа междувременно —
  повторен опит (2/3)...") — не е нужна отделна retry логика в компонента.

**Обновени файлове:**
- `src/lib/signingRequestService.ts` — нови функции за recipient страната:
  `claimInvitation()`, `getInvitationDetails()` (ИЗИСКВА recipient вече
  claim-нат — RLS на `signing_requests`/`documents`/`profiles` блокира
  четенето преди това), `listMyInvitations()` (auto-claim + bulk детайли по
  email), `isInvitationPending()`.
- `src/hooks/usePendingInvitationsCount.ts` (нов) — брой pending покани за
  badge-а в главната навигация. Explicit `refresh()` (не Supabase Realtime —
  няма realtime инфраструктура другаде в проекта) — вика се след claim/sign
  действия, за да обнови badge-а веднага.
- `src/App.tsx` — route `/invite/:recipientId` (regex match върху
  `pathname`, ПРЕДИ auth-gate-а, като `/verify`); 5-ти таб „Покани" в
  `MainApp` навигацията (badge с брой pending, скрит при 0); нов
  `PendingInvitationsPage` таб.
- `supabase/migrations/0015_recipient_select_owner_profile.sql` (нов) —
  RLS: recipient (claim-нат) може да чете `profiles.display_name` на
  owner-а на своята заявка (SECURITY DEFINER helper
  `is_signing_owner_of_recipient()`, същия pattern като migrations
  0011/0013/0014). За разлика от 0012-0014 (открити reactively при E2E
  провал), тази е добавена ПРОАКТИВНО преди UI имплементацията — приложен
  урок от Ден 4-5 сесията. **ВАЖНО: не е приложена още в Supabase** — трябва
  да се пусне ръчно в SQL Editor преди recipient страницата да работи live.
- `src/components/documents/SignDocumentModal.tsx` — refactor към
  `usePrfCeremony`; `ModalHeader` разширен с `totalSteps` проп.
- `src/components/documents/InviteRecipientsModal.tsx` — refactor към
  `usePrfCeremony` (без промяна на поведение).

**Future work (документирано тук по изрична молба):** expiry механизъм за
покани (напр. изтичане след N дни) е пропуснат за MVP scope — покана остава
валидна безсрочно, докато не бъде приета или заявката отменена от owner-а.
Тема за заключението на курсовата работа.

**Статус на тестовете:** `npx tsc --build --force` чист, **185/185 unit
теста** (непроменени спрямо Ден 5 — Ден 6 добавя нов UI код без нови unit
тестове в плана; refactor-ът към `usePrfCeremony` потвърден да не чупи
съществуващите тестове за `SignDocumentModal`/`InviteRecipientsModal`).
Ръчен UI тест (screenshots) — чака се преди commit, виж gate-а по-долу.

**Commit gate (изрична инструкция):** НЕ се commit-ва преди screenshots от:
InvitationLandingPage (4 състояния: logged_out, logged_in_correct,
logged_in_wrong, invalid_token), PendingInvitationsPage с 2 покани в списъка,
badge indicator в главната навигация (с брой), RecipientSigningModal Стъпка 1
(потвърждение), RecipientSigningModal Стъпка 2 (прогрес — може mid-progress),
full completion state в owner-ския dashboard (Routing 3/3).

### Ден 5: Owner UI — InviteRecipientsModal + SigningRequestStatus + CancelSigningRequestButton — код готов (2026-07-28)

5 нови/обновени компонента за owner-ската страна на multi-signer flow-а.
Recipient UI (Ден 6) и реални email-и (Ден 7) остават извън scope тук.

**Нови файлове:**
- `src/components/documents/InviteRecipientsModal.tsx` — 3-стъпков модал
  (`recipients → positions → confirm → signing → success|error`):
  - Стъпка 1: email input, валидация (format, duplicate, own-email, max 2
    recipients за MVP), list с "Премахни".
  - Стъпка 2: PDF thumbnail (преизползва `usePdfThumbnail`/`clickToMarkerPos`
    от `SignDocumentModal.tsx`, вече export-нати), цветни participant badges
    (indigo=owner, emerald/amber=recipients), click-to-select participant →
    click-on-PDF поставя неговия маркер; "Напред" disabled докато не всички
    имат позиция.
  - Стъпка 3: преглед + „Подпиши като собственик" — PRF ceremony ПРЕДИ
    мрежовите извиквания (същия iOS-safe pattern като `SignDocumentModal`),
    вика `signAsOwner(..., recipients: NewRecipientInput[], ...)`. Success:
    „Документът е подписан. Изпратени са N покани." (само UI текст — реални
    email-и са Ден 7), auto-close след 2 сек.
- `src/components/documents/SigningRequestStatus.tsx` — status ред
  ("Routing (X/Y)") + expand с owner + всеки recipient (✅/⏳ + дата).
- `src/components/documents/CancelSigningRequestButton.tsx` — inline
  confirmation dialog (не native `confirm()`, по модел на soft-delete
  patterns другаде в проекта) → `signing_requests.status='cancelled'` +
  audit log `signing_request_cancelled`.
- `src/lib/signingRequestService.ts` (нов) — `listSigningRequests()`
  (owner-ските заявки + join-нати recipients, за DocumentList state),
  `getSigningRequestDetails()`, `cancelSigningRequest()`.
- `src/hooks/useMultiSignerActions.ts` (нов) — тънък hook около горното;
  връща `useMemo`-нат обект (не plain literal всеки render — иначе
  callers, ползващи го като `useCallback`/`useEffect` dependency, влизат в
  infinite loop, тъй като нов object reference на всеки render винаги
  "се променя").

**Обновени файлове:**
- `src/components/documents/DocumentList.tsx` — 4 състояния на документ:
  - **State A** (`uploaded`, без активна заявка) — „Подпиши" (single-signer,
    непроменено) + нов „Изпрати за подписване" бутон.
  - **State B** (`awaiting_recipients`) — action бутоните се крият,
    `SigningRequestStatus` + `CancelSigningRequestButton` вместо тях.
  - **State C** (`signed`) — непроменено „Свали подписан"; добавен hint
    „Подписан от N лица" ако `1 + recipients.length > 1`.
  - **State D** (`cancelled`, документът остава `uploaded`) — badge
    „Отменено" ДОПЪЛНИТЕЛНО към нормалните State A бутони (позволява
    повторен опит — `signAsOwner()`-овият active-request guard проверява
    само `draft`/`owner_signing`/`awaiting_recipients`, не `cancelled`).
  - Latest signing_request per документ се определя client-side
    (`listSigningRequests()` вече е сортиран `created_at DESC`, взима се
    първото съвпадение по `document_id`).
- `src/components/documents/SignDocumentModal.tsx` — `usePdfThumbnail`,
  `ModalHeader`, `ModalFooter`, `InfoRow` вече `export`-нати (бяха
  file-private) — преизползвани от `InviteRecipientsModal.tsx` вместо
  дублиране.
- `src/lib/auditLog.ts` — нов `AuditAction`: `'signing_request_cancelled'`.

**Дизайн решения:**
- Owner-ски recipients лимит (MAX 2) е enforced само в UI-я
  (`InviteRecipientsModal`) — backend (`signAsOwner()`) технически поддържа
  N recipients (Ден 2-4 доказаха N-signer pipeline-а), продуктовото
  ограничение е съзнателно UI-only за защита пред комисията.
- Reuse вместо duplication: `usePdfThumbnail`/`clickToMarkerPos`/
  `ModalHeader`/`ModalFooter`/`InfoRow` от `SignDocumentModal.tsx` — не
  копие-паст на PDF thumbnail логиката за втори път.
- `useMultiSignerActions` connection towards `useMemo` (не голо връщане на
  literal обект) — предотвратява subtle infinite-loop бъг, забелязан преди
  runtime тестване (не при реален run — code review discipline).

**Статус на тестовете:** `tsc --noEmit` чист, **185/185 unit теста**
(непроменени — Ден 5 е чисто UI, без нови unit тестове поискани в плана).
Ръчен UI тест (7 сценария screenshots) — виж по-долу.

**Критичен methodology gap, открит от Cloudflare build failure (2026-07-28):**
Първият push (`f9c1ef3`) провали Cloudflare build-а с 4 грешки, които
локалният `npx tsc --noEmit` НЕ хвана нито веднъж през цялата Фаза 8 сесия.
Причина: `tsconfig.json` в проекта има `"files": []` + `"references"` (към
`tsconfig.app.json`/`tsconfig.node.json`) — стандартен TS project-references
setup. Plain `tsc --noEmit` (без `-b`) **не следва references** — с
`files: []` и без `include`, той type-check-ва **нула файла** и връща exit
0 мълчаливо (`--listFiles` потвърди: празен output). Всяко „tsc чист" твърдение
в тази сесия (Ден 3, 4, 5) е било невярно увереност — командата никога не е
проверявала нищо. `npm run build` (реалната команда, която Cloudflare вика)
използва `tsc -b`, което ПРАВИЛНО следва references и type-check-ва всичко.

**Поправка занапред:** от тук нататък type-check се прави с `npx tsc -b`
(или директно `npm run build`), НЕ с bare `npx tsc --noEmit`.

**4-те реални грешки, останали скрити:**
1. `InviteRecipientsModal.tsx` — неизползван `X` import от lucide-react.
2. `InviteRecipientsModal.tsx` — reference към несъществуващ `setError` (leftover
   от рефакторинг, който премести error state-а в родителския компонент).
3. `signingService.ts` — неизползван `fontBytes` параметър в
   `attemptRecipientSign()`/`signAsRecipient()` (recipient маркерите никога
   не са рисували текст — Ден 2 архитектурно решение — параметърът просто
   не е бил нужен; премахнат изцяло от сигнатурата, вместо `void` hack).
4. `supabase.ts` — директна `process.env` референция (добавена вчера за
   Node script съвместимост) чупи browser build-а, защото
   `tsconfig.app.json` няма `@types/node`. Fix: достъп през `globalThis`
   с inline type cast, вместо bare `process` идентификатор — работи и в
   браузъра (undefined → fallback към `import.meta.env`), и в Node.

Всички 4 поправени, `npx tsc -b --force` и `npm run build` (пълния
Cloudflare build) потвърдени чисти локално преди повторен push.

### Ден 4: signingService.ts refactor — signAsOwner() / signAsRecipient() — ЗАВЪРШЕНА ✅ (2026-07-27)

Backend logic за multi-signer signing flow, преди UI (Ден 5-6) и email (Ден 7).

**`src/lib/signingService.ts` — нови функции:**
- `signAsOwner(documentId, userId, signerName, position, recipients, rpId, ...)` —
  създава `signing_requests` (status='draft'), insert-ва `signing_request_recipients`
  редове (ако има поканени), подписва PDF стандартно (`preparePdfForSigning` —
  owner е ВИНАГИ signer #1 във файла), качва `v1.pdf`, финален статус:
  `recipients.length === 0` → `completed` + `documents.status='signed'`
  (backward-compat single-signer случай); иначе → `awaiting_recipients`.
- `signAsRecipient(recipientId, userId, signerName, rpId, ...)` — валидира
  security (`recipient.user_id === userId`) и статус (`!== 'signed'`), сваля
  последната версия, подписва INCREMENTALLY (`prepareIncrementalSignature` от
  Ден 2), качва нова версия, optimistic-concurrency UPDATE на `version`, при
  последен recipient → `signing_requests.status='completed'` +
  `documents.status='signed'`.
- `signDocument()` (backward compat) — тънък wrapper: `signAsOwner(...,
  recipients: [], ...)`, връща същия `SignDocumentResult` shape. UI
  (`SignDocumentModal.tsx`) работи БЕЗ промяна.
- Storage path конвенция сменена от `<userId>/<documentId>_signed.pdf` на
  `<signing_request_id>/v<version>.pdf` — важи за ВСИЧКИ подписвания вече
  (вкл. backward-compat single-signer), не само multi-signer. Изисква нов
  RLS модел (виж migrations 0012-0014 по-долу).

**Retry logic — optimistic concurrency (задължително обяснение преди commit):**

Проблем: двама recipients могат да подпишат "едновременно" (overlapping
requests). И двамата четат `signing_requests.version = N`, сваля същия PDF,
подписват го incrementally, но само ЕДИН може да "спечели" — вторият трябва
да разбере, че версията вече е сменена, да свали НАЙ-НОВАТА версия, и да
подпише НАНОВО (различен message digest → старият му подпис вече е невалиден
за новия byte range).

Detection — две независими "сигнатури" за race, и двете хвърлят вътрешен
`ConcurrentSignError` (никога не излиза извън `signAsRecipient()`):
  1. **Storage upload conflict** — качването на `v{N+1}.pdf` е с `upsert:
     false`; ако друг recipient вече е качил същия version номер, upload-ът
     се проваля с "resource already exists".
  2. **DB version mismatch** — `UPDATE signing_requests SET version=N+1, ...
     WHERE id=X AND version=N` — ако version вече не е N (друг спечели
     междувременно), `UPDATE` засяга 0 реда.

И двата случая се хващат в `attemptRecipientSign()` (ЕДИН опит) и мятат
`ConcurrentSignError`. `signAsRecipient()` обвива това в retry loop (max 3
опита, `MAX_RECIPIENT_SIGN_RETRIES`): при `ConcurrentSignError` — целият
`attemptRecipientSign()` се извиква НАНОВО от нулата (re-fetch на
`signing_request` + `recipient` ред, re-download на най-новата версия, НОВ
PRF ceremony — биометричен tap се повтаря, защото message digest-ът се е
сменил и старият подпис е невалиден). Всяка друга грешка (validation, PRF
cancel, липсващи ключове) излиза ВЕДНАГА, без retry — retry-ва се само
конкретно "race с друг подписващ". След 3 неуспешни опита — ясно съобщение
с инструкция да презаредят страницата (акцептирано ниво за MVP; при истински
edge case с 3+ едновременни recipients в рамките на секунди, ръчен retry от
потребителя решава проблема).

**Открити и поправени RLS gaps по време на реалния E2E тест (важно):**
Планът предполагаше, че само `optimistic concurrency` ще проявява "race"
поведение, но реалният тест показа, че `signAsRecipient()` винаги хвърляше
"друг участник подписа" ДОРИ БЕЗ никаква конкуренция — истинската причина
беше липсваща RLS, не race:
- `signing_requests` имаше UPDATE policy само за owner-а (migration 0010) —
  recipient-ският optimistic-concurrency UPDATE винаги засягаше 0 реда (RLS
  филтрира тихо, без грешка) → погрешно тълкувано като version mismatch.
  **Fix:** `migration 0013` — нов `signing_requests_update_recipient` policy.
- `documents` имаше UPDATE policy само за owner-а (migration 0001) —
  recipient (последен подписващ) не можеше да сложи `status='signed'`.
  **По-опасно от горното:** RLS-блокирано UPDATE НЕ хвърля грешка от
  PostgREST — просто засяга 0 реда тихо; кодът първоначално не проверяваше
  rows-affected на тази UPDATE и би "успял" мълчаливо БЕЗ документът
  действително да мине в `signed`. **Fix:** `migration 0013` — нов
  `documents_update_signing_recipient` policy (+ `is_document_signing_recipient()`
  SECURITY DEFINER helper) + код промяна: и двете completion UPDATE-и вече
  ползват `.select('id')` и explicit проверка на `rows.length === 0` (fail
  loud вместо silent no-op).
- След `migration 0013`, "complete document" UPDATE-ът ВСЕ ОЩЕ връщаше 0 реда
  — причината: PostgREST `RETURNING` (от `.select()` след `.update()`) минава
  през SELECT RLS, не само UPDATE RLS; `documents_select_own` позволява
  SELECT само на owner-а. **Fix:** `migration 0014` — нов
  `documents_select_signing_recipient` policy (огледален на 0013, ползва
  същия helper). `signing_requests` нямаше този проблем — вече си имаше
  `signing_requests_select_recipient` от migration 0010/0011.

**Storage RLS (multi-signer path):** `migration 0012` — recipient не може да
чете/пише в `signed-documents` bucket под owner-ската `<userId>/` папка
(folder-prefix-per-uploader RLS от migration 0001). Нова конвенция
`<signing_request_id>/v<version>.pdf` + нови storage policies през
`is_signing_request_owner()`/`is_signing_request_recipient()` (вече
съществуващи helper функции от migration 0011). Старите `*_own` policies
остават непроменени (permissive OR) — legacy single-signer файлове
продължават да работят.

**`src/lib/supabase.ts` — малка добавка:** `import.meta.env` е Vite-специфично
и е `undefined` под plain `tsx` Node изпълнение (нужно за integration test
скрипта) — добавен `process.env` fallback (`?? process.env.VITE_SUPABASE_URL`),
не променя браузърното поведение (import.meta.env винаги е приоритет там).

**Тестове:**
- `src/__tests__/signingService.test.ts` + `src/__tests__/signing.test.ts` —
  обновени mock-ове за новия `signing_requests` DB път (documents SELECT вече
  има `.eq('user_id')`, storage path форматът се смени) — всички стари тестове
  минават непроменени в логиката си.
- `src/__tests__/signAsOwnerRecipient.test.ts` (нов) — 10 теста: signAsOwner
  с 0/1/2 recipients, active-request guard; signAsRecipient success path,
  last-recipient completion, invalid recipient (security), already-signed
  guard, concurrent race → retry success, изчерпани retries → ясна грешка.
- **185/185 общо unit теста**, `tsc --noEmit` чист.

**Integration test (реален Supabase, 2026-07-27) — ✅ УСПЕШЕН:**
`scripts/test-multi-signer-e2e.ts` — изисква `SUPABASE_SERVICE_ROLE_KEY` (admin
API за temp test акаунти) + `ROOT_CA_PRIVATE_KEY_B64`. Създава 2 temp Supabase
Auth акаунта (owner + recipient), реален ECDSA keypair + leaf cert (подписан
от реалния Root CA) за всеки, mock PRF ceremony (WebAuthn не се automate-ва),
реален `documents`/`storage` upload, пълен `signAsOwner()` → `claim_recipient_
invitation` RPC → `signAsRecipient()` flow. Резултат:
```
signing_requests.status = completed ✅
documents.status = signed ✅
```
Финален PDF свален локално (`scripts/output/multi-signer-e2e-*.pdf`) — ръчна
проверка в Adobe Reader (2 signature entries, valid) остава на потребителя,
без screenshot gate тук (по план). Cleanup: temp акаунтите се изтриват в
`finally` блок (cascade delete чисти всички свързани редове).

**Live регресионна проверка (2026-07-27, psiholog.pages.dev, след push на
`e24a5e0`) — ✅:** Backward-compat single-signer flow (без recipients, UI-то
все още няма избор на recipients — Ден 5-6) — качване → подписване → сваляне
→ `/verify` (1 лице, валиден). Потвърждава, че новата `signAsOwner()`-базирана
`signDocument()` реализация (нов signing_requests ред + нов storage path
формат за ВСЯКО подписване) не чупи съществуващия production flow.

### Ден 4 — RLS regression safety net (допълнение, 2026-07-27)

По искане: липсваше automated safety net за RLS policies (само ръчен E2E run
преди). Добавено:

**`scripts/rls-test-0012-0014.sql`** — по модела на `rls-test-0010.sql`, 7
номерирани теста (SETUP + role simulation през `set local request.jwt.claims`):
recipient SELECT/UPDATE на своя signing_request (Gap 1/2/3 fix-овете) +
negative guardrails (чужда заявка, нелинкнат recipient, anon default-deny).

**`scripts/generate-rls-test-0012-0014-data.ts`** (нов helper) — създава
реалните test записи (2 документа на owner + 2 recipient акаунта) през
service role и генерира ПОПЪЛНЕН SQL файл (плейсхолдърите заменени с реални
UUID/email) в `scripts/output/`, готов за paste в SQL Editor — избягва ръчно
търсене на UUID-и от потребителя.

**Резултат от реалния SQL run — 6/7 директно потвърдени, 1 first-look "провал"
разрешен:**
- Тестове 2 (чужда заявка → блокиран), 3 (собствена version UPDATE → успешен,
  потвърдено директно в DB: `version` реално стана 2), 4 (нелинкнат recipient
  → 0 реда), 5/6 (documents UPDATE+SELECT → `status='signed'` потвърдено) —
  верифицирани точно, включително чрез директна admin-client проверка на
  реалните DB стойности (не само SQL Editor текстов изход).
- Тест 1 първоначално показа `should_be_1: 0` — **изглеждаше като провал на
  Gap 1 fix-а**, но директна проверка (`select name, path_tokens,
  storage.foldername(name) from storage.objects`) разкри истинската причина:
  SETUP блокът в SQL скрипта никога реално не вкара двата симулирани
  `storage.objects` реда (raw `insert into storage.objects (bucket_id, name)`
  очевидно не се е изпълнил като очаквано/не е persist-нал) — **пропуск в
  моя test setup, не бъг в migration 0012**. Пренаписан verification подход:
  качени РЕАЛНИ dummy файлове през `admin.storage.upload()` + опит за
  `download()` като signed-in recipient през истинския Storage API (същия
  механизъм, който `signAsRecipient()` реално ползва) — резултат: recipient
  X сваля собствения си файл ✅, чужд файл ❌ (блокиран), recipient Y
  (нелинкнат) ❌, anon ❌. Всичките 4 сценария коректни.
- **Обща поука:** SQL Editor role-simulation тестовете са ценни, но директна
  admin-client проверка на реалните DB/Storage стойности е по-надеждният
  източник на истина — copy-paste-нати текстови резултати от SQL Editor могат
  да се объркат в реда/labeling при ръчно compile-ване в чат съобщение.

**`scripts/test-multi-signer-e2e.ts` разширен** — нов `runSingleSignerScenario()`
(отделен от `runMultiSignerScenario()`, извикват се последователно от `main()`,
всеки с независим try/finally cleanup): `signAsOwner()` с `recipients: []`,
проверява `status='completed'` ВЕДНАГА, `documents.status='signed'`, точно 1
`signatures` ред (id съвпада с `result.signatureId`), 0 `signing_request_
recipients` редове. И двата сценария (`multi-signer` + `single-signer`)
изпълнени успешно на реален run.

Всички test акаунти + storage artifacts от днешната сесия почистени (service
role `deleteUser` + `storage.remove()`).

**Следваща стъпка (Ден 5-6):** UI wiring — Owner flow (InviteRecipientsModal,
покана на до 2 recipients за MVP), Recipient flow (InvitationLandingPage,
SigningRequestStatus), `<CancelSigningRequestButton>`.

### Ден 3: Verify pipeline update за N подписа — ЗАВЪРШЕНА ✅ (2026-07-27)

`pdfVerifier.ts`/`verifyService.ts` преди тази стъпка поддържаха само ПОСЛЕДНИЯ
`/Sig` обект (single-signer). Генерализирано за N подписа, N-агностично.

**`src/lib/pdf/pdfVerifier.ts` — нови функции (старите остават непроменени):**
- `extractAllSignatures()` — намира ВСИЧКИ `/Type /Sig` обекта (файлов ред =
  ред на подписване), за всеки локализира dict границите (backward до
  най-близкото предхождащо `<<`, forward чрез `findDictEnd` — балансиран
  `<< >>` scan, споделен с `pdfSigner.ts`) и extract-ва `/ByteRange`,
  `/Contents`, `/M` bounded в рамките на своя dict. Никога не пропуска
  намерен marker — при повреден dict връща запис с `null` полета, вместо
  тихо да го изпусне.
- `extractAllPqStreams()` — намира ВСИЧКИ `/PostQuantumSignature` streams,
  асоциирани по `signerIndex` (explicit поле в JSON payload-а, или позиционен
  fallback за текущия single-PQ случай).
- `countSignatureMarkers()` — разграничава "наистина unsigned" (0 marker-а) от
  "поврежден подпис" (marker намерен, но extraction неуспешна).
- `findDictEnd()` в `pdfSigner.ts` — export-нат (беше private), споделен между
  incremental signing и verify extraction.
- `PqSignatureData.signerIndex?` — нов опционален field (forward-compat).

**`src/lib/verify/types.ts` — нова схема (breaking change, съзнателно):**
- `VerifyResult.ecdsa`/`.mlDsa` премахнати → заменени с `signers: SignerResult[]`
  + `totalSigners`. `SignerResult` = `{ signerIndex, ecdsa, mlDsa, signerName, signedAt }`.
  N=1 е частен случай: `signers.length === 1`.
- Нов `OverallStatus`: `authentic_with_warnings` — изтекъл сертификат ИЛИ
  "смесена" PQ защита (един signer има валиден ML-DSA, друг няма PQ слот).
- `EcdsaVerifyResult.tampered?` — explicit флаг (hash mismatch), отделен от
  `status:'invalid'` (sig/chain failure) — пази прецизното tampered/invalid
  разграничение от single-signer версията.

**`src/lib/verify/verifyService.ts` — orchestrator preписан:**
- `verifySingleSigner()` — верифицира ЕДИН `/Sig` обект, НИКОГА не хвърля;
  при повредена CMS структура връща `SignerResult` с `ecdsa.status='invalid'`
  вместо да прекъсва целия flow — останалите N-1 подписа продължават да се
  верифицират коректно (ключов инвариант: "corrupt one signature от N — само
  тя се показва invalid").
- `determineOverall()` приоритет: `tampered` (hash mismatch) > `invalid`
  (sig/chain/ML-DSA fail) > `authentic_with_warnings` (expired cert ИЛИ
  смесена PQ защита) > `authentic`. Съзнателно НЕ следва буквално "any ECDSA
  invalid → tampered" от плана — пази старото по-прецизно tampered/invalid
  разграничение (потвърдено от modified-body/modified-signature fixtures).
- `documentHash`/`byteRange` на резултата = последния `/Sig` (покрива целия
  файл, вкл. всички предходни подписи).

**`src/lib/verify/reportGenerator.ts`:** секция за всеки signer (роля +
ECDSA + ML-DSA + верижна визуализация) + автоматична пагинация (`Ctx` state
машина, `ensureSpace()`/`newPage()`) вместо фиксиран 1-page layout. Footer на
всяка страница.

**`src/components/verify/TechnicalDetails.tsx`:** по един collapsible за
всеки signer (роля + име в заглавието), плюс общи "Цялост на документа" и
"Byte range" секции. Cert modal state вече индексиран по signer, не глобален.

**`src/components/verify/VerifyResult.tsx`:** Layer 1 показва "Подписан от N
лица" + списък signer redове (икона + име + роля + дата). `getKind`/`getHeading`
опростени да четат `overall` директно (вкл. `authentic_with_warnings`),
вместо да ровят в `ecdsa.certStatus`.

**Тестове:**
- `src/__tests__/verifyService.test.ts` — 10-те стари single-signer fixture
  сценария преминаха на новата схема (`r.signers[0].ecdsa` вместо `r.ecdsa`);
  expired-cert сега очаква `authentic_with_warnings` (не голо `authentic`).
  Добавени: N=2 (owner + 1 recipient), N=3 (owner + 2 recipients),
  corrupt-one-of-N (recipient ECDSA sig корумпиран КОНСТРУКЦИОННО — по модела
  на `makeModifiedSignaturePdf`, не post-hoc byte flip във файла, защото
  post-hoc flip в произволен CMS offset не гарантира детерминирано счупване).
- `src/__tests__/reportGenerator.test.ts` — обновени fixtures към `signers[]`
  схемата + нов N=3 smoke тест + `getPages()` добавен в pdf-lib мока
  (нужен за per-page footer пагинацията).
- `src/__tests__/edgeCases.test.ts` — 2 теста обновени: garbage-CMS фикстурата
  сега коректно се категоризира като `invalid` (сигнатура е намерена, но
  счупена) вместо generic `error`; unsigned тестът чете `signers`/`totalSigners`
  вместо премахнатите `ecdsa`/`mlDsa` top-level полета.
- **175/175 общо unit теста** (стабилно при 2 последователни пълни run-а),
  `tsc --noEmit` чист.

**Забележка за нестабилност при разработка:** един-единствен run показа
флейки failure на expired-cert теста (несвързан с моя код — race при
паралелно изпълнение на describe blocks в същия файл); не се възпроизведе
при 2 последващи пълни run-а. Ако се появи отново — да се разследва
`initTestKeys()` singleton кеша в `signingFixtures.ts` за race condition.

**Live UI верификация (2026-07-27, psiholog.pages.dev/verify, 4 screenshot) — ✅:**
- Dual-signed PDF: „Подписан от 2 лица" — Дима Йорданов (собственик) + Мария
  Тупарова (получател 1), и двамата зелени/валидни; „Пост-квантов подпис: не
  е приложен (стар документ)" (коректно — нито един от двамата няма ML-DSA в
  тази fixture → overall `authentic`, не `authentic_with_warnings`, защото
  липсата е uniform, не смесена). 2 collapsible-а в Technical Details + общи
  Цялост/Byte range секции.
- Triple-signed PDF: „Подписан от 3 лица" — Дима Йорданов, Мария Тупарова,
  Иван Петров, всичките зелени/валидни. 3 collapsible-а.
- Single-signed PDF (backward compat): „Подписан от 1 лице" — вижда се и
  ML-DSA-65 статус (валиден) — старият N=1 формат работи непроменено.
- PDF verification report (triple-signed, 2 страници): секция „ПОДПИСВАЩ
  1/2/3" за всеки — ECDSA статус, алгоритъм, дата, издател, cert expiry,
  верижна визуализация (Подписал → Root CA → trust anchor), cert/sig
  fingerprints, ML-DSA-65 статус („Няма PQ слот за този подписващ"). Footer +
  page numbers на всяка страница — пагинацията работи коректно.

**Странична поправка по време на сесията:** `RecoveryFlow.tsx` показваше
generic грешка при всеки provider failure на `signInWithOtp()` без да логва
причината в конзолата (за разлика от установения patterns другаде в проекта
— виж Фаза 6 Ден 1). Добавен `console.error()`. Реалната причина за
съобщения ото „Не можахме да изпратим линка" при тестването се оказа
паузирана Supabase база (free tier auto-pause при неактивност) — нищо общо
с Ден 3 кода; клиентката активира базата ръчно и login проработи отново.

### Ден 2 Стъпка 1: Incremental-update signing primitive (2 подписа) — ЗАВЪРШЕНА ✅ (2026-07-27)

Най-рисковата задача от целия план (виж бележка в оригиналния план: `preparePdfForSigning()`
не може да се preизползва за recipient — pdf-lib пре-сериализира целия файл при
`.save()`, което би счупило вече вградения подпис на owner-а).

**Нови функции в [`pdfSigner.ts`](src/lib/pdf/pdfSigner.ts):**
- `prepareIncrementalSignature()` — чист append-only incremental update: намира
  Catalog → AcroForm → Pages → целева страница (raw byte parsing, без pdf-lib),
  redefine-ва AcroForm (`/Fields`) и Page (`/Annots`) обектите (нова ревизия,
  същия object number, нов offset — НЕ мутация на стари байтове), добавя нов
  `/Sig` obj + `/Widget` obj + `/AP` appearance stream (рамка без текст).
- `injectIncrementalSignature()` — инжектира CMS DER в новия `/Contents`
  placeholder (без `/PostQuantumSignature` — извън scope на тази стъпка).
- Рефакторинг: `fillContentsPlaceholder()` изведена от `injectSignatureAndPQ()`
  за преизползване (identical behavior, unit тестовете минават непроменени).
- `computeByteRanges()`/`patchByteRangeInPlace()`/`hashByteRanges()` останаха
  **напълно непроменени** — вече бяха generic спрямо `contentsOffset`/
  `byteRangeNumOffset`, работят коректно и за N-тия подпис без промяна.

**Съзнателен scope decision:** appearance stream-ът на recipient-ския marker е
само фон+рамка, БЕЗ текст — рисуването на кирилица в raw incremental update
изисква ръчно CID/Identity-H font encoding (Type0 font + FontFile2 embed),
значителен допълнителен обем крехък код за визуален detail. Owner-ският
маркер (рисуван от pdf-lib ПРЕДИ първия подпис) остава с пълен текст.
Text-in-appearance за recipient е flagged като future enhancement.

**Тестове:**
- `src/__tests__/pdfMultiSign.test.ts` — 7/7 ✅: signature 1 hash непроменен
  след append на signature 2, signature 1 CMS bytes непроменени, signature 2
  хешира правилно (покрива и signature 1), и двата ECDSA подписа
  крипто-верифицират с WebCrypto, AcroForm `/Fields` съдържа 2 field refs,
  2 отделни `/Type /Sig` обекта, ясна грешка при несъществуваща страница.
- `scripts/test-multi-sign.ts` — E2E: 2 различни leaf certs (owner + recipient)
  подписани от реален Root CA chain.
- **154/154 общо unit теста** (без регресии), `tsc --noEmit` чист.

**Adobe Reader верификация (2026-07-27, 2 screenshot сесии) — ✅:**
- "Signed and all signatures are valid."
- Rev. 1: Signed by Дима Йорданов — valid, document not modified
- Rev. 2: Signed by Мария Тупарова — valid, document not modified
- И двата визуални маркера видими на страницата (owner: пълен текст; recipient: рамка)

**Следваща стъпка:** Ден 2 Стъпка 2 — generalize primitive-а за N подписа
(рекурсивно приложение на `prepareIncrementalSignature()` върху вече
multi-signed PDF), Adobe тест с 3+ подписа преди Ден 3 (verify pipeline update:
`pdfVerifier.ts`/`verifyService.ts` в момента поддържат само 1 `/Sig` обект).

Изисквано от ръководителя (2026-07-19): parallel signing — owner подписва пръв,
всички recipients получават покана едновременно, подписват независимо в
произволен ред, финален документ при последния подпис. Пълен план (data model,
sequence, UI, email, time estimate) одобрен от ръководителя без промени, с 3
уточнения: (1) incremental-update signing се разработва стъпаловидно с Adobe
Reader тест след всяка стъпка, не само в края; (2) pg_cron reminder emails са
**future work**, НЕ част от MVP (спестява ~0.5 ден); (3) `<CancelSigningRequestButton>`
е задължителна част от Ден 6 (Owner UI), не опция.

**Future work (извън MVP scope, за заключението на курсовата):**
- Reminder emails (pg_cron + `send-reminders` Edge Function) — ако recipient не
  подпише в рамките на N дни. Изисква `pg_cron` extension в Supabase.
- Резервен домейн за Resend (демо ползва `onboarding@resend.dev`, ограничен
  до собствения имейл на подателя — виж Е. Resend setup в плана).
- Column-level RLS hardening на `signing_request_recipients` (в момента recipient
  технически може да PATCH-не marker_x/marker_y на собствения си ред през
  PostgREST — приемливо за MVP, тъй като реалният signing flow пише само
  конкретни полета през кода).
- Auto-soft-delete на orphaned `signing_keys` след passkey recovery (предсъществуващ
  gap, засяга и single-signer owner flow, не само multi-signer).

### Ден 2 Стъпка 2: Generalize incremental primitive за N подписа (тествано с N=3) — ЗАВЪРШЕНА ✅ (2026-07-27)

Разшири инвариантите от Стъпка 1 (2 подписа) до N=3, потвърждавайки че
`prepareIncrementalSignature()`/`injectIncrementalSignature()` вече са
N-агностични без промяна в кода — `findLastObjectDict()` намира ПОСЛЕДНАТА
ревизия на Catalog/AcroForm/Page независимо от броя предходни append-и, така
че подпис 3 се append-ва върху подпис 2 по абсолютно същия начин, по който
подпис 2 се append-ва върху подпис 1.

**Нови тестове:**
- `src/__tests__/pdfMultiSign.test.ts` — нов `describe` блок „N=3 подписа":
  6 теста (13 общо във файла, бяха 7). Покрива: hash на signature 1 И 2
  непроменен след append на 3; CMS bytes на signature 1 И 2 offset-ите
  непроменени; signature 3 хешира правилно (A3 > A2 > A1); и трите ECDSA
  подписа крипто-верифицират; AcroForm `/Fields` съдържа 3 field refs; 3
  отделни `/Type /Sig` обекта.
- `scripts/test-multi-sign-3.ts` — E2E: sign owner → recipient1 → recipient2
  (3 различни leaf certs от реален Root CA chain), sanity checks (hash
  непроменяемост на по-старите подписи), явна верификация „чрез extraction"
  на всеки от трите подписа поотделно (`parseCms` + `crypto.subtle.verify`
  срещу съответния leaf public key) + потвърждение, че
  `pdfVerifier.extractCmsDer()` намира коректно ПОСЛЕДНИЯ подпис (signature 3)
  — очаквано поведение за текущия single-latest-signature verifier (генерализация
  за N подписа във verify pipeline-а е Ден 3 scope, не пипната тук).

**Резултати:**
- **160/160 общо unit теста** (154 + 6 нови), `tsc --noEmit` чист.
- E2E скрипт run (2026-07-27): 3 подписа успешно append-нати, всички sanity
  checks и extraction верификации ✅ (виж лог по-долу).
  ```
  Signature 1 hash непроменен след append на 2 и 3: ✅
  Signature 2 hash непроменен след append на 3: ✅
  Брой /Type /Sig обекта: 3 ✅
  Signature 1: ✅ valid (signer: CN=Дима Йорданов)
  Signature 2: ✅ valid (signer: CN=Мария Тупарова)
  Signature 3: ✅ valid (signer: CN=Иван Петров)
  pdfVerifier.extractCmsDer() намира ПОСЛЕДНИЯ подпис (signature 3): ✅
  ```
  Изходен файл: `scripts/output/multi-signed-3-2026-07-27T09-47-02.pdf`
  (gitignored — не е commit-нат).

**Adobe Reader верификация (2026-07-27, screenshot) — ✅:**
- „Signed and all signatures are valid." (синя лента)
- Signature Panel: Rev. 1: Signed by Дима Йорданов ✅ · Rev. 2: Signed by
  Мария Тупарова ✅ · Rev. 3: Signed by Иван Петров ✅ — и трите със зелена
  отметка, кирилицата се показва коректно.

**Следваща стъпка (Ден 3):** verify pipeline update — `pdfVerifier.ts`/
`verifyService.ts` в момента поддържат само 1 `/Sig` обект (последния);
UI ще ограничи до max 2 recipients (owner + 1) за MVP, но pipeline-ът трябва
технически да поддържа N за защита пред комисията.

### Ден 1: Data model + migrations + RLS + claim RPC — ⏳ ГОТОВО ЗА REVIEW

- `supabase/migrations/0010_multi_signer_requests.sql` — нови таблици
  `signing_requests`, `signing_request_recipients`, `email_notifications` +
  `signatures.signing_request_id` (nullable) + RLS policies + `claim_recipient_invitation()`
  SECURITY DEFINER функция. **НЕ приложена в Supabase още — чака review.**
- `src/lib/types.ts` (нов файл) — `SigningRequestRow`, `SigningRequestRecipientRow`,
  `EmailNotificationRow` + discriminated union статус типове + UI-composed
  helper типове (`SigningRequestWithRecipients`, `NewRecipientInput`).
- `scripts/rls-test-0010.sql` — manual RLS test script (5 сценария: owner
  isolation, recipient row-level isolation, anon deny, email_notifications
  service_role-only write) — за пускане в Supabase SQL Editor СЛЕД прилагане
  на миграцията.
- `npx tsc --noEmit` ✅ чисто.
- **Дизайн решение:** `documents.status` enum НЕ се пипа — целият multi-signer
  progress живее в `signing_requests.status`. Избягва `ALTER TYPE ... ADD VALUE`
  transaction gotchas и запазва съществуващия single-signer код непроменен.
- **Дизайн решение:** линкване на recipient → `user_id` е token-scoped
  (`claim_recipient_invitation(recipient_id)`), не automatic email match при
  всеки signup — по-безопасно (избягва случайно линкване при несвързана
  регистрация със същия email).

**Бъг открит при ръчно RLS тестване (2026-07-19) и поправен:**
`supabase/migrations/0011_fix_signing_requests_rls_recursion.sql` —
`ERROR 42P17: infinite recursion detected in policy for relation "signing_requests"`.
Причина: `signing_requests_select_recipient` policy-то прави `EXISTS` заявка
към `signing_request_recipients`, а `recipients_select_owner`/`insert`/`update`
policies на `signing_request_recipients` правят `EXISTS` обратно към
`signing_requests` — circular RLS dependency между двете таблици. Fix: два
`SECURITY DEFINER` helper функции (`is_signing_request_owner()`,
`is_signing_request_recipient()`), които заобикалят RLS при собственото си
вътрешно четене и по този начин прекъсват цикъла.

**RLS тест резултати (2026-07-19, `scripts/rls-test-0010-filled.sql` + fix):**
Owner isolation (Тест 1/2) ✅ · Recipient row-level isolation + claim (Тест 3а/3б) ✅ ·
Anon default-deny (Тест 4) ✅ · `email_notifications` service_role-only write,
owner read-only (Тест 5) ✅. Всички 5 сценария потвърдени успешно след 0011 fix-а.

**Ден 1 завършен ✅.**

---

## Фаза 7: Документация + Подготовка за защита — ⏳ NOT STARTED

### Bugfix (2026-07-19): /Name кирилица encoding + Adobe metadata

Ръководителят провери signature dictionary metadata (PROGRESS.md checkpoint) и откри, че `/Name` полето е нечетимо в Adobe signature panel при кирилски имена.

- **Bug:** `PDFString.of(signerName)` в [`pdfSigner.ts`](src/lib/pdf/pdfSigner.ts) ползва PDFDocEncoding (латиница-базирано) — кирилица излиза mojibake (`8<0 >@40=>2` вместо „Дима Йорданов"). Визуалният маркер на страницата беше OK (рисуван с embedded NotoSans font), но текстовото `/Name` metadata поле — не.
- **Fix:** заменено с `PDFHexString.fromText()` — вградена pdf-lib utility, кодира UTF-16BE + BOM (`FEFF` prefix, PDF spec 1.7 §7.9.2.2). Не написахме custom encoding функция — вече съществуваше в библиотеката.
- **Добавени полета:** `/Location` (`"SignShield Platform"`) и `/ContactInfo` (`"psiholog.pages.dev"`), също с `PDFHexString.fromText()`.
- `/M` (дата) остава `PDFString.of()` — не е Unicode текст, не се нуждае от промяна.
- Верифицирано: hex dump на нов подписан тестов PDF (`scripts/output/e2e-signed-2026-07-19T06-56-22.pdf`) — `/Name <FEFF0414043804...>` декодира точно до „Дима Йорданов".
- 147/147 vitest теста ✅ (без регресии). `npx tsx --env-file=.env.local scripts/test-e2e-signing.ts` ✅.
- **Ръчна проверка в Adobe Reader (2026-07-19) — ЗАВЪРШЕНА ✅:**
  - „Signature is VALID, signed by Дима Йорданов" — кирилица правилно показана
  - Reason: „SignShield Digital Signature" ✅ · Location: „SignShield Platform" ✅
  - „The document has not been modified since this signature was applied"
  - Chain build: leaf → SignShield Root CA v1, „The selected certificate path is valid"
- **Multi-signer flow:** ⏳ отделен scope въпрос, чака отговор от ръководителя — НЕ имплементиран в тази сесия.

### Задачи

- [ ] Курсова работа (текстов документ) — чака структура/шаблон от университета
- [ ] Демо сценарий — точна последователност за показване пред комисия
- [ ] Тестов акаунт за комисията (отделен от личния)
- [ ] Screenshots backup (при live demo провал)
- [ ] Anticipated questions + защитими отговори
- [ ] Layman обяснение „Как работи SignShield" — за клиентката (`docs/как-работи-signshield.md`)

### Чака от клиентката

- Структура/шаблон на университета за курсовата работа
- Кой пише текста (студентът или AI-assisted)
- Deadline

---

## Фаза 6: Ден 3 — A11y WCAG AA + README — ЗАВЪРШЕН ✅ (2026-07-14)

### Резултати

- ✅ **Lighthouse Accessibility: 90/100** (цел ≥ 90) — axe-core 4.11.4
- ✅ 18 WCAG AA fixes в 10 компонента (виж `docs/accessibility-audit.md`)
- ✅ `README.md` на Български — пълна документация за защита

### Ключови A11y промени

- `role="alert"` на всички error messages (3 auth + 1 modal)
- `role="status"` на progress/done/toast messages
- `role="progressbar" aria-valuenow/min/max` на signing progress bar
- `role="dialog" aria-modal aria-labelledby` на SignDocumentModal + CertificateModal
- `aria-expanded` + `aria-controls` на TechnicalDetails Section бутони
- `role="status" aria-label` на VerifyPage spinner; `aria-live` на stage текст
- `aria-label` на icon-only бутони (Close × 2, Trash, Copy)
- `aria-hidden="true"` на декоративни Lucide икони (Shield, Fingerprint, Chevron и др.)

### README секции

1. Какво е SignShield (summary)
2. Основни функции
3. Ключови архитектурни решения (ECDSA, ML-DSA, PRF, hybrid, Root CA)
4. Privacy и Security таблица
5. Технологичен стек
6. Инсталация и Deploy (env, Supabase, Root CA, Cloudflare Pages)
7. Как работи — Signing / Verification / Recovery flow (text diagrams)
8. Browser поддръжка + линк към compat matrix
9. Ограничения и Future Work
10. Лиценз (MIT)

### Нови файлове

- `docs/accessibility-audit.md` — Lighthouse резултат + WCAG AA coverage таблица

### Performance забележка

Lighthouse Performance score 41 е от Chrome extensions на тестовата машина (MetaMask, Wappalyzer — виждат се в bootup-time данните). В incognito без extensions ще е значително по-добър. Server response time: 50 ms ✅, CLS: 0 ✅.

---

## Фаза 6: Hotfixes — ЗАВЪРШЕН ✅ (2026-07-14)

### Критични бъгове оправени

- ✅ **Stack overflow при верификация** — `extractCmsDer()`: търсеше ПЪРВИЯ `/Contents <` (може да е в binary data на PDF), а трябваше ПОСЛЕДНИЯ; `String.fromCharCode(...largeArray)` spread → RangeError. Fix: намиране на последния `/Contents <` + директно nibble декодиране без spread (commit `7445527`)
- ✅ **Грешно файлово ime при "Свали подписан"** — Supabase signed URL прави cross-origin redirect → браузърът игнорира `a.download` и ползва UUID от storage path. Fix: fetch blob локално → blob URL → `a.download` работи (commit `019fdde`)
- ✅ **PDF верификационен доклад отваря в нов таб** — `window.open('', '_blank')` вика се СИНХРОННО преди `await`, иначе popup blocker го блокира; fallback към download ако е блокиран (commit `019fdde`)
- ✅ **iOS passkey не се появяваше при подписване** — iOS Safari губи "transient user gesture context" при `await` преди `navigator.credentials.get()`. Fix: PRF ceremony(ies) се викат ПРЕДИ всякакви мрежови `await`-ове, резултатите се инжектират като mock-ове в `signDocument()` (commit `41aeb27`)
- ✅ **TypeScript build грешка на Cloudflare Pages** — `signDocument(fontBytes: Uint8Array)` не приемаше `undefined`; разширено до `Uint8Array | undefined` (commit `9d13b54`)

### Забележка за iPhone + signing keys

Ако signing ключовете са генерирани на Windows/Chrome (Google Password Manager), при подписване на iPhone се появява cross-device flow вместо Face ID. Решение: потребителят трябва да регенерира ключовете НА iPhone — тогава iCloud Keychain passkey ще е достъпна на всички Apple устройства. Не изисква код.

---

## Фаза 6: Ден 2 — Browser Compat + Performance — ЗАВЪРШЕН ✅ (2026-07-14)

### Резултати

- ✅ Bundle size анализ (source map): 870 KB gzipped — приемливо за PDF signing app
  - Top: fontkit 185 KB, pdfjs 171 KB, pdf-lib 131 KB — неизбежни за core функционалността
  - `@noble/post-quantum` само 9 KB gzip (tree-shaking optimal)
- ✅ Browser compat matrix: `docs/browser-compat.md` с legend ✅ tested / ⚠️ needs-test
- ✅ Firefox 148+ — login, keygen, sign, verify — всичко работи ✅; dual PRF: 1 tap (singlePrf) ✅
- ✅ iPhone — "Виж верификационен доклад" — отваря в нов таб ✅
- ✅ iPhone — ML-DSA keygen — бързо (приемливо) ✅

### Чакат ръчни тестове (ниски приоритет, не блокират)

- [ ] Safari macOS — full flow
- [ ] Edge — full flow

### Нови файлове

- `docs/browser-compat.md` — compat matrix + bundle breakdown (source map анализ)

### Обновени файлове

- `src/components/verify/VerifyResult.tsx` — iOS PDF download fix + new-tab report

---

## Фаза 6: Ден 1 — Security + Audit Log — ЗАВЪРШЕН ✅ (2026-07-13)

### Резултати

- ✅ Audit log: `logout` — добавено в `UserMenu.tsx`
- ✅ Audit log: `signup` — добавено в `RegisterPasskeyStep.tsx` (само за нови потребители, не при recovery)
- ✅ Audit log: `document_downloaded` за "Свали подписан" бутон — добавено в `DocumentList.tsx`
- ✅ Error message sanitization: 8 места в `signingService.ts`, `documentUpload.ts`, `signingKeyStore.ts` — Supabase вътрешни съобщения вече само в `console.error`, потребителят вижда generic BG съобщение
- ✅ Input validation: `display_name` maxLength=50 в `SignUpForm.tsx`
- ✅ XSS audit: няма `dangerouslySetInnerHTML` / `innerHTML` в цялото приложение
- ✅ RLS audit: `documents` UPDATE policy вече има `AND deleted_at IS NULL` (от migration 0003) — OK

### Пълно покритие на audit events

| Action | Логва се? | Файл |
|--------|-----------|------|
| `login` | ✅ | `SignInForm.tsx:27` |
| `signup` | ✅ | `RegisterPasskeyStep.tsx` (ново) |
| `logout` | ✅ | `UserMenu.tsx` (ново) |
| `recovery_otp_verified` | ✅ | `App.tsx:100` |
| `old_passkeys_deleted` | ✅ | `App.tsx:110` |
| `new_passkey_registered` | ✅ | `RegisterPasskeyStep.tsx` |
| `document_uploaded` | ✅ | `documentUpload.ts` |
| `document_signed` | ✅ | `signingService.ts` |
| `document_downloaded` | ✅ | `documentUpload.ts` + `DocumentList.tsx` (ново) |
| `document_deleted` | ✅ | `documentUpload.ts` |
| `signing_key_generated` | ✅ | `signingKeyStore.ts` |
| `signing_key_deleted` | ✅ | `signingKeyStore.ts` |
| `certificate_issued` | ✅ | `issue-certificate` Edge Function |
| `signature_verified` | N/A | Verify е публична страница (без user_id) |

### Обновени файлове

- `src/components/UserMenu.tsx` — logout audit event
- `src/App.tsx` — isNewUser state → различаване на signup vs recovery
- `src/components/auth/RegisterPasskeyStep.tsx` — isNewUser prop + signup audit event
- `src/components/documents/DocumentList.tsx` — document_downloaded за signed PDF
- `src/lib/signingService.ts` — 5 error message sanitizations
- `src/lib/documentUpload.ts` — 2 error message sanitizations
- `src/lib/signingKeyStore.ts` — 2 error message sanitizations
- `src/components/auth/SignUpForm.tsx` — maxLength=50 за display_name

---

## Фаза 5: Ден 4 — Финализация + Edge Cases + Mobile — ЗАВЪРШЕН ✅ (2026-07-13)

### Резултати

- ✅ Edge cases: 10 нови теста — corrupt PDF, empty buffer, 49 MB, PDF/A, multiple ByteRange
- ✅ Performance: pdfSanitizer 49 MB: 6.5s → 0.47s (TextDecoder оптимизация)
- ✅ Mobile responsive: тествано на live устройство — всичко работи
- ✅ Adobe compare: SignShield Verify съгласуван с Adobe Reader за valid + modified сценарии
- ✅ DB чисто: 0 test artifacts в production

### Нови файлове

- `src/__tests__/edgeCases.test.ts` — 10 edge case теста за verifyDocument()
- `docs/adobe-vs-signshield-verify.md` — semantic mapping table (Adobe ↔ SignShield)

### Обновени файлове

- `src/lib/pdfSanitizer.ts` — `TextDecoder('latin1').decode()` заменя string concat (13× по-бързо)
- `src/components/verify/CertificateModal.tsx` — `max-h-[85vh]` + `overflow-y-auto` + 44px close button
- `src/components/verify/VerifyResult.tsx` — 44px touch targets (Download + Reset бутони)
- `src/components/verify/UploadZone.tsx` — responsive текст (mobile: „Докоснете за избор")

### Пропуснато (документирано)

- Root CA rotation: accepted risk за курсова среда — future work преди production deployment
- Test data cleanup: DB вече чисто, не беше нужна акция

---

## Фаза 5: Ден 3 — PDF верификационен доклад — ЗАВЪРШЕН ✅ (2026-07-11)

### Резултати

- ✅ Бутон „Свали верификационен доклад" в VerifyResult (индиго, само за authentic/tampered/invalid)
- ✅ A4 PDF с кирилица — рендира се в Adobe Reader без проблем
- ✅ 15.3 KB размер (font subsetting работи: само ползваните glyphs)
- ✅ Всички секции: ECDSA P-256, ML-DSA-65, SHA-256 хеш, byte range
- ✅ SHA-256 fingerprints за подпис и сертификат (първите 16 hex chars)
- ✅ Верижна визуализация: Подписал → Root CA → trust anchor статус
- ✅ Цветен status банер (зелен/жълт/червен/неутрален)

### Нови файлове

- `src/lib/verify/reportGenerator.ts` — `generateVerificationReport(result, fileName): Promise<Uint8Array>`; A4 layout с pdf-lib + NotoSans fontkit subsetting; `reportFileName()` helper
- `src/__tests__/reportGenerator.test.ts` — 7 теста: 4 smoke за OverallStatus варианти + 3 filename тестa

### Обновени файлове

- `src/components/verify/VerifyResult.tsx` — download бутон с spinner loading state
- `src/lib/verify/types.ts` — `sigBytes: Uint8Array | null` в EcdsaVerifyResult; `sigBytes?: Uint8Array` в MlDsaVerifyResult
- `src/lib/verify/verifyService.ts` — `sigBytes` попълнен в ECDSA и ML-DSA резултати

---

## Фаза 5: Ден 2 — Verify UI — ЗАВЪРШЕН ✅ (2026-07-11)

### Резултати

- ✅ Публична страница `/verify` (без login) — `psiholog.pages.dev/verify`
- ✅ Таб „Провери документ" в главното меню за логнати потребители
- ✅ Верифициран в production: зелен банер, подписал, дата, издател, верига доверена
- ✅ Стари документи (без ML-DSA): „PQ: не е приложен" без фалшива грешка

### Нови компоненти (5 файла)

- `src/components/verify/UploadZone.tsx` — drag & drop, 50 MB лимит, privacy notice „файловете не се изпращат никъде"
- `src/components/verify/VerifyPage.tsx` — state machine (idle → verifying → done → fileerror), 5-стъпкова прогрес анимация (350 ms/стъпка)
- `src/components/verify/VerifyResult.tsx` — Layer 1 hero банер (зелен/жълт/червен/неутрален) с иконка, подписал, дата
- `src/components/verify/TechnicalDetails.tsx` — Layer 2 collapsible секции (ECDSA P-256, ML-DSA-65, SHA-256 хеш + copy, byte range)
- `src/components/verify/CertificateModal.tsx` — X.509 детайли modal (subject, issuer, serial, дати, алгоритъм, DER размер)

### Обновени файлове

- `src/App.tsx` — `/verify` public route (без auth) + таб „Провери документ" за логнати
- `src/lib/verify/types.ts` — `certIssuer: string | null`, `certDer: Uint8Array | null` в `EcdsaVerifyResult`
- `src/lib/verify/verifyService.ts` — `issuerName` в `verifyCertChain` резултата
- `public/_redirects` — Cloudflare Pages SPA routing (`/* /index.html 200`)

### Бъгове оправени

- 10 TypeScript грешки блокираха Cloudflare build: duplicate identifier, unused imports, `Uint8Array<ArrayBufferLike>` → `Uint8Array<ArrayBuffer>` casts (TS 5.5 strict typing), липсващо `publicKey: null` в test mock обекти
- ML-DSA „Грешка" label скрит за `not_included` статус (информационен, не грешка)

---

## Фаза 5: Ден 1 — Core verification service — ЗАВЪРШЕН ✅ (2026-07-11)

### Резултати

- ✅ 130/130 теста (нула регресии)
- ✅ 92% code coverage на verify code paths
- ✅ Детерминистичен fixture generator (верифициран с 3 последователни runs)
- ✅ Всички 10 сценария покрити

### Нови файлове

- `src/lib/verify/types.ts` — `OverallStatus`, `SignatureStatus`, `CertChainStatus`, `EcdsaVerifyResult`, `MlDsaVerifyResult`, `VerifyResult`
- `src/lib/verify/verifyService.ts` — оркестратор `verifyDocument(pdfBytes, { rootCaCertDer? })` с injectable test Root CA; sub-functions: `verifyCertChain`, `verifyEcdsaSignature`, `verifyMlDsaSignature`
- `src/lib/pdf/cmsParser.ts` — мини ASN.1 DER walker: `parseCms`, `derToP1363`, `makeSignedAttrsSet`, `iterChildren`, `rebuildTlv`
- `src/lib/pdf/pdfVerifier.ts` — `extractByteRange`, `extractCmsDer`, `extractPqStream`, `extractSigningDate`, `computeSignedHash`, `decodeBase64url`
- `src/__tests__/verifyService.test.ts` — 33 теста × 10 fixture сценария
- `src/__tests__/pdfVerifier.test.ts` — unit тестове за extraction функции
- `src/__tests__/cmsParser.test.ts` — unit тестове за DER парсер
- `src/__tests__/helpers/signingFixtures.ts` — детерминистичен fixture generator (10 PDF сценария)

### Обновени файлове

- `src/lib/signingKeyStore.ts` — `fetchKeyDecryptData()` включва `public_key` в SELECT
- `src/lib/signingService.ts` — `ResolvedKeyData` с `publicKey`, embed на ML-DSA public key в подписани документи
- `package.json` — `@peculiar/x509` преместен от devDependencies → dependencies

### Fixture матрица (10 сценария)

| Fixture | Overall | ECDSA | ML-DSA | Cert |
|---|---|---|---|---|
| valid-hybrid | authentic | valid | valid | ok |
| valid-ecdsa-only | authentic | valid | not_included | ok |
| modified-body | tampered | invalid | — | — |
| modified-signature | invalid | invalid | — | ok |
| expired-cert | authentic | valid | not_included | expired |
| untrusted-ca | invalid | valid | not_included | chain_invalid |
| unsigned | unsigned | — | — | — |
| malicious (/JavaScript) | error | — | — | — |
| old-format (empty pubkey) | authentic | valid | not_included | ok |
| ml-dsa-invalid | invalid | valid | invalid | ok |

### Бъгове намерени и оправени

- `@noble/post-quantum/ml-dsa` без `.js` — не се резолвира в Node/Vitest; всички import пътища сега с `.js`
- `parseCms`: `digestAlgorithms SET (0x31)` се вземаше вместо `signerInfos SET (0x31)` (и двата са `0x31` в SignedData); фиксирано да взима последния `0x31`
- `determineOverall`: `chain_invalid` не се映射ваше към `'invalid'`; добавен explicit check
- `makeModifiedSignaturePdf`: hex flip в DER struct → parse error; преписан да корумпира P1363 bytes при construction
- `makeMlDsaInvalidPdf`: TextDecoder/TextEncoder roundtrip на бинарен PDF → корупция; преписан да вгражда corrupted PQ sig при construction

### Reusable за Фаза 5 Ден 2 (Verify UI)

```typescript
import { verifyDocument } from '@/lib/verify/verifyService';
const result = await verifyDocument(pdfBytes); // работи offline, без backend
// result.overall: 'authentic' | 'tampered' | 'invalid' | 'unsigned' | 'error'
// result.ecdsa, result.mlDsa, result.documentHash, result.byteRange
```

---

## Фаза 4: Ден 4 — SignDocumentModal UI — ЗАВЪРШЕН ✅ (2026-07-10)

### E2E верифициран в Adobe Reader (2026-07-10)

- ✅ „Signed and all signatures are valid" (зелена лента)
- ✅ „Signature is VALID, signed by Dimo."
- ✅ „The document has not been modified since this signature was applied."
- ✅ Визуален маркер долу вляво (кирилица, NotoSans)

### Нови/обновени файлове

- `src/components/documents/SignDocumentModal.tsx` (~400 реда) — 3-стъпков модал:
  - **Step 1 (StepPosition):** PDF thumbnail 300 px, click-to-place маркер, page buttons (първите 3 + поле „Отиди към страница" при >3), бутон „Позиция по подразбиране"
  - **Step 2 (StepConfirm):** Preflight — предупреждение при липса на ML-DSA, блокер при липса на cert
  - **Step 3 (StepSigning):** Progress bar + 7-стъпков чеклист, done-state с „Свали подписания документ" + „Затвори", error-state с retry
  - Exported: `clickToMarkerPos()` (pure function), `DEFAULT_MARKER = { page: 0, x: 30, y: 30 }`
  - `usePdfThumbnail` hook — session-level JPEG кеш `Map<${docId}:${page}, dataURL>`
- `src/components/documents/DocumentList.tsx` — обновен:
  - Pre-flight ECDSA key check преди отваряне на модала (inline грешка ако липсва)
  - Бутон „Подпиши" (indigo) за неподписани документи
  - Бутон „Свали подписан" (emerald) за `status='signed' && signed_storage_path IS NOT NULL`
  - Зелена `CheckCircle` икона за подписани документи
  - Toast (fixed bottom-center, auto-dismiss 3 сек) при успех
  - `onDone` callback: `load()` + `showToast()`
- `src/lib/documentUpload.ts` — добавено `signed_storage_path: string | null` в `DocumentRow` и SELECT
- `src/lib/signingService.ts` — добавен `onProgress?: (pct: number, label: string) => void` (9-ти параметър), 6 progress точки (5%→15%→35%→55%→70%→85%)
- `src/__tests__/signing.test.ts` — 8 нови теста: `clickToMarkerPos` (5), `DEFAULT_MARKER` (1), `signDocument onProgress` (2)

### Архитектурни решения

- **Coordinate mapping:** `x = round(clickX/W * pageWidthPt)`, `y = round((1 - clickY/H) * pageHeightPt)` — CSS Y=0 горе, PDF Y=0 долу
- **pdfjs-dist legacy build:** За iOS Safari (липсва `Map.getOrInsertComputed`) — следва паттерна на PdfViewer
- **Pre-flight без биометрия:** `resolveSigningKeys()` се вика при mount на модала — валидира ключове и cert ПРЕДИ Step 1; PRF ceremony се стартира само при „Подпиши" в Step 3
- **Thumbnail кеш:** session-level `Map<string, string>`, ключ `${docId}:${page}`, споделен между отваряния

### Тестове — 73/73 ✅

| Нови тестове (Ден 4) | Покрива |
|---|---|
| clickToMarkerPos: CSS горен-ляв → PDF горе (Y=842) | Y-ос инверсия |
| clickToMarkerPos: CSS долен-ляв → PDF долу (Y=0) | Y=0 долно-ляво |
| clickToMarkerPos: CSS център → PDF център (X=298, Y=421) | Math.round детерминизъм |
| clickToMarkerPos: CSS десен-долен → PDF дясно-долу | граничен случай |
| clickToMarkerPos: X и Y са цели числа | Number.isInteger |
| DEFAULT_MARKER: page=0, x=30, y=30 | константа |
| signDocument onProgress: строго нарастващи %, първи=5%, последен≥85% | progress ред |
| signDocument onProgress: работи без callback (undefined) | опционален параметър |

---

## Фаза 4: Ден 3 — Signing orchestration service — ЗАВЪРШЕН ✅ (2026-07-10)

### E2E верифициран в Adobe Reader (2026-07-10)

- ✅ „Signed and all signatures are valid" (зелена валидация)
- ✅ Chain: leaf cert → SignShield Root CA v1 (успешно построен)
- ✅ „Document has not been modified"
- ✅ Кирилски визуален маркер долу вляво (NotoSans, ECDSA P-256 · ML-DSA-65)
- ✅ Hybrid signature: ECDSA в PAdES/CMS + ML-DSA-65 в /PostQuantumSignature stream

### Нови файлове

- `src/lib/signingService.ts` — Оркестрация на пълния signing flow в 5 стъпки (вижте по-долу). Включва `resolveSigningKeys()` и `getSignedDownloadUrl()`.
- `src/__tests__/signingService.test.ts` — 12/12 unit теста (Vitest).
- `supabase/migrations/0009_hybrid_signatures.sql` — Hybrid schema: `ecdsa_key_id`, `ml_dsa_key_id`, `signed_storage_path` с backfill, NOT NULL, CHECK constraint (signed_at), UNIQUE index.
- `scripts/test-e2e-signing.ts` — E2E интеграционен тест с реален Root CA chain (изисква `ROOT_CA_PRIVATE_KEY_B64` в `.env.local`).

### Архитектурни решения

**Ред на операциите в `signDocument()` (гарантира UX коректност):**
1. Fetch документа → `status === 'signed'` → throw (ПРЕДИ биометрия)
2. Grace period: `signatures WHERE signed_at >= now() - 30s` → throw (ПРЕДИ биометрия)
3. `resolveSigningKeys()` → fetchBestKeyId × 2 → fetchKeyDecryptData × 2 → cert validation
4. PRF ceremony (единичен tap ако credential_id съвпадат, иначе два)
5. Sign ECDSA + ML-DSA → CMS inject → upload → DB update

**`resolveSigningKeys()` → `ResolvedKeys`:** Връща пълните данни на двата ключа (encryptedSecretKey, prfSalt, wrappedKeyIv, credentialId, certificateDer). Хвърля ако ECDSA cert е NULL. Единична PRF detection чрез bytesEqual на credential_id.

**Тестов принцип:** Early-stage throw тестове (status=signed, grace period) не mock-ват key lookup — потвърдено с `expect(fetchBestKeyId).not.toHaveBeenCalled()`.

**Migration 0009:** `signed_at` (не `created_at`) е timestamp колоната в signatures. CHECK constraint позволява NULL за стари редове (signed_at < 2026-07-10).

### Тестове — 12/12 ✅

| Тест | Покрива |
|---|---|
| resolveSigningKeys: хвърля без ECDSA ключ | fetchBestKeyId → null |
| resolveSigningKeys: хвърля без ECDSA cert | certificateDer: null |
| resolveSigningKeys: singlePrf=true | credential_id съвпадат |
| resolveSigningKeys: singlePrf=false | credential_id се различават |
| resolveSigningKeys: mlDsaKeyId=null | без ML-DSA-65 |
| signDocument: хвърля status=signed БЕЗ key lookup | стъпка 1 |
| signDocument: хвърля grace period БЕЗ key lookup | стъпка 2 |
| signDocument: хвърля без ECDSA cert | стъпка 3 |
| signDocument: pqSkipped=false (ECDSA + ML-DSA) | стъпка 9 |
| signDocument: pqSkipped=true (само ECDSA) | стъпка 9 |
| signDocument: единичен PRF ceremony | deriveDualAesKeysFromPRF × 1 |
| signDocument: двоен PRF ceremony | deriveAesKeyFromPRF × 2 |

---

## Фаза 4: Ден 2 — Cyrillic visual marker — ЗАВЪРШЕН ✅ (2026-07-09)

### Верифициран в Adobe Reader (2026-07-09)

- ✅ Кирилица се вижда правилно (NotoSans-Regular.ttf, не „??????")
- ✅ „Document has not been modified"
- ✅ Визуален маркер: 4 реда текст (Подписано от / Дима Йорданов / Дата / Алгоритъм)

### Нови/обновени файлове

- `public/fonts/NotoSans-Regular.ttf` (569 208 байта) — зарежда се on-demand при подписване
- `src/lib/pdf/pdfSigner.ts` — добавени: `SignOptions` интерфейс, fontkit регистрация, `formatDisplayDate()`, visual marker rendering (background rect + 4 text lines)
- `package.json` — добавен `@pdf-lib/fontkit`

---

## Фаза 4: Хибридно подписване на PDF — Ден 1 ЗАВЪРШЕН ✅ (2026-07-09)

### Какво е реализирано (2026-07-09)

**Нови файлове:**
- `src/lib/pdf/cmsBuilder.ts` — Чисто CMS DER строене (PKCS#7 / PAdES-B-Basic) без npm ASN.1 зависимости. Функции: `extractCertInfo()`, `buildSignedAttrs()`, `buildCmsDetached()`.
- `src/lib/pdf/pdfSigner.ts` — PDF подготовка, byte range математика, инжектиране. Функции: `preparePdfForSigning()`, `computeByteRanges()`, `hashByteRanges()`, `injectSignatureAndPQ()`, + helpers.
- `src/__tests__/pdfSigning.test.ts` — 29 Vitest unit теста (DER структура, byte range, SHA-256 изолация).

**Инсталирани пакети:**
- `pdf-lib` — PDF манипулация с `useObjectStreams: false` за searchable обекти
- `@noble/hashes` — вече беше; ползваме `sha2.js` субмодул (синхронен SHA-256)

**Архитектурни решения:**
- PAdES-B-Basic: `adbe.pkcs7.detached` SubFilter, byte range signing (НЕ хеш на целия файл)
- Placeholder: `/Contents <000...>` = 8192 нулеви байта = 16384 hex символа в PDF
- /ByteRange placeholder: `0 999999999 999999999 999999999` (31 chars), патчва се in-place
- CMS: ръчно ASN.1 DER — IssuerAndSerialNumber, signedAttrs SET→[0]IMPLICIT, Ed25519 OCTET STRING
- /PostQuantumSignature: JSON stream в PDF incremental update (ML-DSA-65 данни)
- Import fix: `@noble/hashes/sha2.js` (с .js разширение) заради package exports в тази версия

**Тестове:**
- 29/29 vitest ✅ (нови) + 22/22 стари = 51 total
- Покрити: extractCertInfo, buildSignedAttrs, buildCmsDetached, findPattern, computeByteRanges, hashByteRanges, formatPdfDate

**Следващи стъпки (Ден 2):**
- Cyrillic visual marker: вгради NotoSans-Regular.ttf в PDF (pdf-lib font embedding)
- Покажи timestamp + signer name в подписното поле на страница 1

---

## Фаза 3.5: Mini-CA — ЗАВЪРШЕНА ✅ (2026-07-08)

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
