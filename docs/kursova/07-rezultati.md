# Раздел 7. Резултати

Този раздел представя какво реално е тествано и измерено в SignShield — не какво е планирано или очаквано. Всички числа по-долу са или директно измерени (unit тестове, bundle размер, крипто операции), или взети от съществуваща одиторска документация в `docs/`.

## 7.1 Функционална верификация

Този раздел документира как приложението отговаря на функционалните изисквания от Раздел 4.2, включително съвместимостта с Adobe Reader.

Основната функционална проверка е дали PDF, подписан от SignShield, се разпознава като валиден от **независим, широко използван инструмент** — Adobe Acrobat Reader — а не само от собствения верификационен модул на приложението. Сравнителният тест (`docs/adobe-vs-signshield-verify.md`, 2026-07-13) съпоставя двата инструмента върху реален подписан документ в два сценария:

| Сценарий | Adobe Reader | SignShield Verify | Съгласие |
|---|---|---|---|
| Валиден документ (оригинал) | Signatures panel зелено — подписът е валиден | „Документът е автентичен и непроменен" · Верига: доверена | Пълно |
| Модифициран документ (1 байт променен) | „At least one signature is invalid" — червено | „Документът е модифициран след подписване" | Пълно |

И двата инструмента се съгласяват както за валидност, така и за детекция на манипулация — разминаването е нула. Единствената семантична разлика е в trust anchor-а: Adobe валидира спрямо Adobe Approved Trust List (AATL), докато SignShield Verify валидира спрямо вградения `rootCaCert.ts` (собствения Root CA на приложението) — очаквано за академичен, а не публично сертифициран CA.

**Multi-signer документи.** Signature Properties panel-ът на Adobe показва всеки подпис в multi-signer PDF (2–3 подписващи, виж Раздел 5.3.4) като отделна ревизия (`Rev. 1`, `Rev. 2`, ...), всяка със собствен статус, име на подписващия (коректно изобразено на кирилица чрез `PDFHexString.fromText()`, виж 6.2), Reason, Location и ContactInfo полета. Постигането на този резултат за multi-signer документи изисква архитектурна поправка, описана в детайл в Раздел 5.3.3/6.2 — редът, в който ECDSA и ML-DSA-65 подписите се изчисляват спрямо `/ByteRange`, е точно това, което определя дали Adobe приема или отхвърля резултата.

*[FIG 1: Screenshot от Adobe Reader Signature Properties panel — multi-signer документ, всички подписи валидни]*

## 7.2 Тестове

**Unit тестове.** 204 теста в 13 файла (Vitest), **всички успешни** (`npx vitest run`, `npx tsc --build --force` чист). Покритието обхваща четири основни области:

| Област | Файлове (`src/__tests__/`) | Какво покрива |
|---|---|---|
| Криптографски примитиви | `crypto.test.ts`, `certificate.test.ts` | HKDF деривация, AES-256-GCM encrypt/decrypt, ECDSA/ML-DSA sign-verify roundtrip, X.509 сертификатна структура |
| CMS структура | `cmsParser.test.ts` | ASN.1 DER encode/decode roundtrip, P1363↔DER конверсия, извличане на messageDigest/signedAttrs |
| PDF подписване | `pdfSigning.test.ts`, `pdfMultiSign.test.ts`, `markerLayout.test.ts` | Placeholder механика, byte range изчисление, incremental update за N подписа, auto-layout на маркери |
| Верификация | `pdfVerifier.test.ts`, `verifyService.test.ts`, `edgeCases.test.ts`, `reportGenerator.test.ts` | Извличане на подписи от PDF, chain validation, tampered/invalid/expired сценарии, PDF доклад генериране |
| Multi-signer orchestration | `signing.test.ts`, `signingService.test.ts`, `signAsOwnerRecipient.test.ts` | `signAsOwner()`/`signAsRecipient()` разделение, retry logic при race condition, 0-recipient backward compat |

**E2E скриптове (ръчно изпълнявани, извън `npm test`).** Тъй като реален WebAuthn ceremony не може да бъде automate-нат от скрипт, следните integration тестове ползват инжектиран mock PRF extractor (същия механизъм като unit тестовете), но минават през **истински** Supabase проект, Storage и Root CA verификационна верига:

- `test-e2e-signing.ts` — единичен подпис с реален Root CA chain, за ръчна проверка в Adobe Reader.
- `test-multi-sign.ts` / `test-multi-sign-3.ts` — чист ECDSA/CMS incremental primitive тест с 2, съответно 3 подписа (без ML-DSA-65 — изолира конкретно incremental update механизма от 6.2).
- `test-multi-signer-e2e.ts` — пълен цикъл през реалния `signAsOwner()`/`signAsRecipient()` orchestration: временни test потребители, реален DB запис, `claim_recipient_invitation` RPC, инкрементален подпис на получател.

**RLS regression тестове (ръчно изпълнявани в Supabase SQL Editor).** Row Level Security политиките (Раздел 5.4) са проверени чрез SQL скриптове, симулиращи конкретен `auth.uid()` за всеки сценарий:

- `rls-test-0010.sql` — 5 сценария около multi-signer таблиците: owner вижда собствената заявка, друг owner не вижда чужда, recipient вижда собствения ред преди/след `claim`, анонимен потребител е блокиран по подразбиране, `email_notifications` не е директно записваем от `authenticated`.
- `rls-test-0012-0014.sql` — 7 сценария около storage bucket и cross-table RLS: recipient чете/пише собствената версия на файла, не може да чете чужда заявка, `documents`/`signing_requests` политиките коректно разграничават собственик от получател.

## 7.3 Browser compatibility

Матрицата по-долу (`docs/browser-compat.md`, последна актуализация 2026-07-13) разграничава реално **тествано в браузър** от **очаквано по спецификация, но непотвърдено** — разграничение, запазено умишлено, защото WebAuthn PRF extension е сравнително нова функционалност (Chrome/Edge от версия 116, Firefox от 148, Safari от 18) с известни разлики в implementation детайли между доставчици (например `dual PRF eval.second` — единичен tap за два ключа, виж 6.4).

| Функционалност | Chrome 116+ | Firefox 148+ | Safari 18+ | Edge 116+ |
|---|:---:|:---:|:---:|:---:|
| WebAuthn login | тествано | очаква се | очаква се | очаква се |
| WebAuthn PRF extension | тествано | очаква се | очаква се | очаква се |
| ECDSA P-256 keygen | тествано | очаква се | очаква се | очаква се |
| ML-DSA-65 keygen (Worker) | тествано | очаква се | очаква се | очаква се |
| PDF sign / verify flow | тествано | очаква се | тествано на iOS (live) | очаква се |
| Recovery flow | тествано | очаква се | тествано на iOS (live) | очаква се |

Chrome/Edge (Chromium) служи като референтен браузър за разработката — всичко изброено е реално кликнато и потвърдено там. Safari iOS има частично живо тестване (upload, viewer, verify, recovery — потвърдени на реално устройство), но пълният sign flow с dual PRF не е верифициран. Firefox 148+ остава напълно нетестван към момента на write-up-а — известен риск е дали Firefox поддържа `eval.second` за единичен-tap dual PRF; при липса на поддръжка приложението деградира елегантно до два отделни tap-а (функционално коректно, но с влошено UX), тъй като `usePrfCeremony()` (6.4) вече разграничава двата случая explicit.

## 7.4 Accessibility

Lighthouse 13.2.0 (axe-core 4.11.4) audit на публичния production URL отчита:

| Категория | Резултат |
|---|---|
| **Accessibility** | **90 / 100** (цел ≥ 90 постигната) |
| Performance | 41 / 100 — повлиян от браузърни разширения по време на измерването (виж 7.5) |
| Best Practices | 77 / 100 |
| SEO | 82 / 100 |

Постигнатият Accessibility резултат е следствие от 18 конкретни WCAG 2.1 AA поправки в 10 компонента (пълен списък в `docs/accessibility-audit.md`) — `role="alert"` на всички съобщения за грешка, `role="status"`/`aria-live` на асинхронни състояния (progress bar по време на подписване, verify spinner), `role="dialog"`/`aria-modal` на модалните диалози, `aria-label` на бутони, ползващи само икона. Проверени WCAG критерии включват 1.1.1 (Non-text Content), 1.4.3 (Contrast — indigo-600 акцентният цвят достига ~7:1 контраст на бял фон, над изисквания минимум 4.5:1), 2.1.1 (Keyboard — всички интерактивни елементи достъпни с Tab/Enter) и 4.1.3 (Status Messages).

Screen reader тестване с VoiceOver/NVDA не е формално документирано с конкретни резултати към момента на write-up-а — Lighthouse/axe-core одитът покрива статичен и семантичен анализ на DOM структурата (роли, имена, контраст), но не заменя реално ръчно преминаване през приложението със screen reader.

## 7.5 Performance

Следните стойности са реално измерени (не са цели от спецификацията), с изричен коментар за средата на измерване, тъй като разликата между Node.js desktop среда и мобилен браузър може да е съществена за постквантовите операции.

**Крипто операции** (Node.js 22, desktop CPU, среден резултат от 5–10 повторения):

| Операция | Средно време |
|---|---|
| ML-DSA-65 генериране на ключ | ~35 ms |
| ML-DSA-65 подписване | ~63 ms |
| ML-DSA-65 верификация | ~10 ms |
| ECDSA P-256 подписване (Web Crypto, хардуерно ускорено) | <1 ms |
| ECDSA P-256 верификация | <1 ms |
| `verifyDocument()` — цял multi-signer документ (2 подписа, хибридни, 513 KB PDF) | ~149 ms |

ML-DSA-65 операциите остават на порядък по-бавни от ECDSA (десетки милисекунди срещу под 1 ms) — очаквано за lattice-базиран алгоритъм, но все още далеч под прага, при който потребителят би възприел забавяне като проблем, дори при генериране на ключ в Web Worker (изнесено извън главната нишка именно с оглед на по-слаби мобилни устройства, виж Раздел 4.3). Измерените стойности на desktop среда са значително по-ниски от първоначалната консервативна оценка от ~400 ms в проектната спецификация (обосноваваща решението за Worker) — реалната стойност на мобилно устройство остава непроверена директно.

**Bundle размер** (production build, `npm run build`, Vite 5.4, актуален към write-up-а):

| Артефакт | Размер (minified) | Размер (gzip) |
|---|---|---|
| Главен JS bundle | 2 342 KB | 894 KB |
| CSS | 39 KB | 7 KB |
| PDF.js worker (зареждан отделно, при отваряне на документ) | 1 305 KB | — |
| ML-DSA-65 keygen Web Worker | 19 KB | — |

Общият gzip трансфер за първоначално зареждане на приложението (без PDF worker-а, зареждан лениво) е **~901 KB** — над препоръчителния праг от 500 KB за бърз мобилен load, документирано в `docs/browser-compat.md` като известен backlog елемент (~60% от bundle-а е самия PDF стек: `pdf-lib` + `@pdf-lib/fontkit` + `pdfjs-dist`, всичко необходимо за core функционалността; lazy loading чрез `dynamic import()` е идентифициран, но нереализиран в текущия обхват).

**Time to Interactive.** Не е налична чиста измерена стойност — единственият наличен Lighthouse Performance резултат (41/100) е изрично документиран като повлиян от активни браузърни разширения по време на измерването (MetaMask, Wappalyzer), не от кода на приложението; чист incognito замер не е бил проведен към момента на write-up-а. Отчита се като известен пропуск, не като постигнат резултат.

---

## Използвана литература (раздел 7)

Номерацията следва консолидираната библиография — виж Раздел 10.

[2] Adobe Inc. *Adobe Acrobat Reader — Digital Signature Verification* (Верификация на цифрови подписи). https://helpx.adobe.com/acrobat/using/digital-signatures.html. 2024.

[7] Deque Systems. *axe-core — Accessibility testing engine* (Двигател за тестване на достъпност). https://github.com/dequelabs/axe-core. 2024.

[14] Google LLC. *Lighthouse — Automated auditing for web quality* (Автоматизиран одит на качеството на уеб приложения). https://developer.chrome.com/docs/lighthouse. 2024.

[34] World Wide Web Consortium. *Web Content Accessibility Guidelines (WCAG) 2.1* (Насоки за достъпност на уеб съдържание). https://www.w3.org/TR/WCAG21/. 2018.
