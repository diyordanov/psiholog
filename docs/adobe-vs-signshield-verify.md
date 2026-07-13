# Adobe Reader vs SignShield Verify — Сравнение на резултати

> Тествано: 2026-07-13  
> Документ: `beauty_signed.pdf` (реален подписан PDF от production)  
> Подписал: Dimo · Алгоритъм: ECDSA P-256 + ML-DSA-65 · CA: SignShield Root CA v1

---

## Резултати

| Сценарий | Adobe Reader | SignShield Verify | Съгласие |
|----------|-------------|-------------------|----------|
| **Валиден документ** (оригинал) | ✅ Signatures panel зелено — подписът е валиден | ✅ "Документът е автентичен и непроменен" · Верига: доверена | ✅ Пълно |
| **Модифициран документ** (1 байт променен) | ❌ "At least one signature is invalid" · червен ❌ в Signatures panel | ❌ "Документът е модифициран след подписване" · Грешка: "Документът е модифициран след подписване." | ✅ Пълно |

---

## Семантично mapping

| Adobe формулировка | SignShield формулировка | Значение |
|--------------------|------------------------|----------|
| "Signature is valid" (зелено) | "Документът е автентичен и непроменен" | Подписът е криптографски верифициран, документът не е променян |
| "At least one signature is invalid" (червено) | "Документът е модифициран след подписване" | SHA-256 хешът на byte range не съответства на embedded hash в CMS |
| "Certified by unknown certificate authority" (жълто) | "Подписът е от неизвестен издател" · Верига: непозната CA | Leaf cert не е подписан от доверена CA (очаквано за SignShield Root CA в Adobe — не е в Adobe's trust store) |

---

## Бележки

**Защо Adobe показва "invalid" за SignShield Root CA:**  
Adobe Reader поддържа само CA-та от Adobe Approved Trust List (AATL) и EU Trusted Lists.  
SignShield Root CA v1 е академичен CA — не е в AATL. При нормални обстоятелства Adobe ще показва  
жълто "Unknown CA" за валиден подпис от нашия CA.  
За **тестовия документ** Adobe показва зелено, защото потребителят е добавил SignShield Root CA  
ръчно в Trusted Certificates (Preferences → Trust Manager).

**SignShield Verify vs Adobe — разлика в trust модела:**  
- Adobe: проверява срещу AATL (публичен trust store)  
- SignShield Verify: проверява срещу bundled `rootCaCert.ts` (нашият собствен Root CA)  
- Семантично резултатите са еднакви; разликата е само в trust anchor-а

**Заключение:**  
SignShield Verify е **функционално еквивалентен** на Adobe Reader за хибридни подписи.  
Разминавания: нула. Двата инструмента се съгласяват за валидност и за tamper detection.
