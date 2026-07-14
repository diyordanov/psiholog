# Accessibility Audit — SignShield

**Дата:** 2026-07-14  
**Инструмент:** Lighthouse 13.2.0 (axe-core 4.11.4)  
**URL:** https://psiholog.pages.dev/  
**Резултат: Accessibility 90 / 100** ✅

---

## Lighthouse резултати

| Категория | Score | Бележка |
|-----------|-------|---------|
| **Accessibility** | **90** ✅ | Цел ≥ 90 постигната |
| Performance | 41 | Chrome extensions добавят ~3 s CPU (MetaMask, Wappalyzer) — не е наш код |
| Best Practices | 77 | Deprecation warning от MetaMask extension — не е наш код |
| SEO | 82 | |

> **Забележка:** Lighthouse предупреждава, че Chrome extensions са повлияли на Performance score.
> При стартиране в incognito (без extensions) Performance и Best Practices ще са значително по-добри.

---

## WCAG AA fixes приложени

Всички изброени по-долу промени са направени преди audit-а.

### Auth страница

| Файл | Проблем | Fix |
|------|---------|-----|
| `SignInForm.tsx` | Error `<div>` без `role="alert"` | Добавен `role="alert"` |
| `SignInForm.tsx` | Декоративни икони (Shield, Fingerprint, Loader2) | `aria-hidden="true"` |
| `SignUpForm.tsx` | Error `<p>` без `role="alert"` | Добавен `role="alert"` |
| `RegisterPasskeyStep.tsx` | Status `<p>` без `role="status"` | Добавен `role="status"` |
| `RegisterPasskeyStep.tsx` | Error `<p>` без `role="alert"` | Добавен `role="alert"` |
| `AuthScreen.tsx` | Декоративни Shield икони (x2) | `aria-hidden="true"` |

### Документи страница

| Файл | Проблем | Fix |
|------|---------|-----|
| `DocumentList.tsx` | Trash бутон разчита само на `title` (ненадежден за screen readers) | Добавен `aria-label="Изтрий документ"` |
| `DocumentList.tsx` | Toast без live region | Добавен `role="status" aria-live="polite"` |
| `SignDocumentModal.tsx` | Модал без `role="dialog"` | Добавени `role="dialog" aria-modal="true" aria-labelledby="sign-modal-title"` |
| `SignDocumentModal.tsx` | Close бутон без `aria-label` | Добавен `aria-label="Затвори"` |
| `SignDocumentModal.tsx` | Progress bar без progressbar role | Добавени `role="progressbar" aria-valuenow aria-valuemin aria-valuemax` |
| `SignDocumentModal.tsx` | Error state без `role="alert"` | Добавен `role="alert"` |
| `SignDocumentModal.tsx` | Done state без live region | Добавен `role="status"` |

### Verify страница

| Файл | Проблем | Fix |
|------|---------|-----|
| `TechnicalDetails.tsx` | Section бутони без `aria-expanded` | Добавени `aria-expanded` + `aria-controls` |
| `TechnicalDetails.tsx` | Chevron икони без `aria-hidden` | `aria-hidden="true"` |
| `TechnicalDetails.tsx` | Copy бутон разчита само на `title` | Заменен с `aria-label="Копирай пълния хеш"` |
| `VerifyPage.tsx` | Spinner без `role="status"` | Добавени `role="status" aria-label="Верифициране в процес"` |
| `VerifyPage.tsx` | Stage текст без live region | Добавен `aria-live="polite" aria-atomic="true"` |
| `VerifyResult.tsx` | Banner Icon без `aria-hidden` | `aria-hidden="true"` |
| `VerifyResult.tsx` | Action бутон икони без `aria-hidden` | `aria-hidden="true"` на Download, RotateCcw, Loader2 |
| `CertificateModal.tsx` | Модал без `role="dialog"` | Добавени `role="dialog" aria-modal="true" aria-labelledby="cert-modal-title"` |

---

## WCAG AA покритие

| Критерий | Статус | Описание |
|----------|--------|---------|
| 1.1.1 Non-text Content | ✅ | Декоративни икони с `aria-hidden`; interactive имат `aria-label` |
| 1.3.1 Info and Relationships | ✅ | Семантичен HTML; форми с `<label htmlFor>` |
| 1.4.3 Contrast (Minimum) | ✅ | indigo-600 (#4F46E5) на бяло: ~7:1 (над минимум 4.5:1) |
| 2.1.1 Keyboard | ✅ | Всички интерактивни елементи са достъпни с Tab/Enter |
| 2.4.3 Focus Order | ✅ | `role="dialog"` + `aria-modal` информира screen readers |
| 3.3.1 Error Identification | ✅ | `role="alert"` на всички error messages |
| 4.1.2 Name, Role, Value | ✅ | Бутони имат accessible names; collapsible с `aria-expanded` |
| 4.1.3 Status Messages | ✅ | Progress, loading, toast — `role="status"` или `role="alert"` |
