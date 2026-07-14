# Browser Compatibility Matrix — SignShield

> Последна актуализация: 2026-07-13  
> Ключ:
> - ✅ tested — реално кликнато в браузър
> - ✅ static — верифицирано от код/MDN (не тествано)
> - ⚠️ needs-test — неизвестен статус, изисква ръчен тест
> - ❌ broken — потвърдено не работи

---

## Compatibility Matrix

| Функционалност | Chrome 116+ | Firefox 148+ | Safari 18+ macOS | Safari iOS 18+ | Edge 116+ |
|----------------|:-----------:|:------------:|:----------------:|:--------------:|:---------:|
| WebAuthn login | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test |
| WebAuthn PRF extension | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test |
| PRF fallback съобщение | ✅ static | ✅ static | ✅ static | ✅ static | ✅ static |
| ECDSA P-256 keygen | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test |
| ML-DSA-65 keygen (Worker) | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test |
| PDF upload | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ✅ tested (live) | ⚠️ needs-test |
| PDF sign flow | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test |
| PDF viewer (pdfjs) | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ✅ tested (live) | ⚠️ needs-test |
| PDF verify | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ✅ tested (live) | ⚠️ needs-test |
| Верификационен доклад DL | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ⚠️ needs-test (fix applied) | ⚠️ needs-test |
| Recovery flow | ✅ tested | ⚠️ needs-test | ⚠️ needs-test | ✅ tested (live) | ⚠️ needs-test |

> „tested (live)" = тествано на реален iPhone по-рано в проекта.

---

## Бележки по браузъри

### Chrome / Edge (Chromium) — Reference browser
- Пълна поддръжка, всичко тествано ✅
- PRF налично от Chrome 116 / Edge 116

### Firefox 148+
- PRF добавен в Firefox 148 (март 2025) — ⚠️ нетестван
- **Потенциален проблем:** `dual PRF eval.second` (един tap → два ключа) — статусът в Firefox е неизвестен. При неподдръжка signing flow ще изисква два биометрични tap-а вместо един — functionally OK, UX degraded

### Safari 18+ (macOS + iOS)
- PRF добавен в Safari 18 (септември 2024) — ⚠️ нетестван
- **PDF доклад download (fix приложен):** `URL.revokeObjectURL` се вика след `setTimeout(150ms)` + `appendChild` за надеждност на iOS. Fix е стандартен cross-browser pattern, но **не е тестван на реален iOS устройство**.

---

## Bundle Size — точен анализ

**Метод:** source map анализ (5114 KB total source → 2250 KB minified → 870 KB gzipped)

### Top 10 contributors (gzip оценка ≈ source × 0.17)

| # | Пакет | Source | ~Gzip | Защо е включен |
|---|-------|--------|-------|----------------|
| 1 | `@pdf-lib/fontkit` | 1087 KB (21%) | ~185 KB | Font subsetting за Кирилица в PDF доклади |
| 2 | `pdfjs-dist` (main thread) | 1004 KB (20%) | ~171 KB | PDF viewer API (worker-ът е отделен) |
| 3 | `pdf-lib` | 768 KB (15%) | ~131 KB | PDF modification — подписване и доклади |
| 4 | `@supabase/auth-js` | 396 KB (8%) | ~67 KB | Auth SDK — login, passkeys, sessions |
| 5 | `@peculiar/x509` + asn1 libs | ~417 KB (8%) | ~71 KB | X.509 cert parsing за верификация |
| 6 | app-code | 264 KB (5%) | ~45 KB | Нашият код |
| 7 | `pako` | 214 KB (4%) | ~36 KB | zlib — вградена зависимост на pdf-lib |
| 8 | `@supabase/postgrest-js` | 132 KB (3%) | ~22 KB | DB queries |
| 9 | `react-dom` | 131 KB (3%) | ~22 KB | React rendering |
| 10 | `@noble/hashes` | 66 KB (1%) | ~11 KB | SHA-256 за PDF fingerprints |

> **Изненадващо малко:** `@noble/post-quantum` = само 51 KB source / ~9 KB gzip — tree-shaking е много ефективен. ML-DSA keygen е в отделен Worker, в main bundle остават само sign/verify функции.

### Заключение
60% от bundle-а е PDF стек (pdf-lib + fontkit + pako + pdfjs). Всичко е задължително за core функционалността. За production оптимизация: lazy load с `dynamic import()` за `-300 KB` — **backlog**.

---

## Identified Issues

| Приоритет | Проблем | Статус |
|-----------|---------|--------|
| Fix (приложен, нетестван) | iOS PDF report download: sync `revokeObjectURL` | Applied, needs-test |
| Backlog | Bundle 870 KB > 500 KB — lazy load PDF stack | Backlog |
| Needs-test | Firefox 148 dual PRF `eval.second` | ⚠️ нужен тест |
| Needs-test | Safari/iOS: верификационен доклад download | ⚠️ нужен тест след fix |
| Needs-test | ML-DSA keygen timing на iPhone | ⚠️ нужен тест |
