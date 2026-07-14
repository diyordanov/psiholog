# PROGRESS — Уеб приложение за подписване на PDF

> Прочита се след `PROJECT_BRIEF.md` в началото на всяка сесия.

## Статус: Фаза 0 ✅ · Фаза 1 ✅ · Фаза 2 ✅ · Фаза 3 ✅ (superseded) · Фаза 3.5-pre ✅ · Фаза 3.5 ✅ · Фаза 4 Ден 1 ✅ · Фаза 4 Ден 2 ✅ · Фаза 4 Ден 3 ✅ · Фаза 4 Ден 4 ✅ · **Фаза 5 ✅ COMPLETE** (Ден 1–4) · **Фаза 6 ✅ COMPLETE** (Ден 1–3 + Hotfixes). **Проектът е завършен.**

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
