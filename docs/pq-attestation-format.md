# ML-DSA-65 Post-Quantum Attestation Format

## Защо не X.509?

`@peculiar/x509` не поддържа ML-DSA-65 (FIPS 204, OID `2.16.840.1.101.3.4.3.18`) нативно.
Ръчното ASN.1 кодиране е рисково (един грешен байт = невалидна структура).
ML-DSA-65 подписите живеят в custom PDF namespace `/PostQuantumSignature`, не в стандартния
PAdES signature dictionary. Adobe Reader не ги чете — само нашият верификатор.
Следователно X.509 не носи добавена стойност за ML-DSA-65 в нашия use case.

Вместо X.509 използваме **custom signed attestation** — JSON документ, подписан с Root CA Ed25519 ключ.
Криптографски еквивалентно: Root CA удостоверява публичния ML-DSA-65 ключ на потребителя.

---

## Структура на JSON attestation

```json
{
  "version": 1,
  "algorithm": "ml-dsa-65",
  "oid": "2.16.840.1.101.3.4.3.18",
  "publicKey": "<base64url, 1952 байта>",
  "subject": {
    "userId": "<UUID на потребителя>",
    "displayName": "<имe от profiles.display_name>"
  },
  "issuedAt": "<ISO 8601 UTC>",
  "expiresAt": "<ISO 8601 UTC, 2 години след issuedAt>",
  "issuer": "SignShield Root CA v1",
  "caSignature": "<base64url, Ed25519 подпис на Root CA>"
}
```

---

## Изчисляване на `caSignature`

Подписва се `canonical` — JSON stringify на обекта **без** `caSignature` поле, с фиксиран ред на ключовете:

```
canonical = JSON.stringify({
  version, algorithm, oid, publicKey, subject, issuedAt, expiresAt, issuer
})
```

Алгоритъм: `Ed25519.sign(UTF8(canonical), rootCaPrivateKey)` → raw 64-byte подпис → base64url.

**Редът на ключовете в canonical JSON е фиксиран** (по-горе). При верификация трябва да се
реконструира точно в същия ред, преди да се верифицира подписа.

---

## Верификация (Фаза 5)

```
1. Прочети attestation JSON от PDF /PostQuantumSignature metadata
2. Декодирай caSignature (base64url → 64 байта)
3. Реконструирай canonical JSON (без caSignature, фиксиран ред на ключовете)
4. Ed25519.verify(caSignature, UTF8(canonical), rootCaPublicKey) → OK/FAIL
5. Провери expiresAt > signedAt (времето на подписване, от PDF metadata)
6. Декодирай publicKey (base64url → 1952 байта)
7. ML-DSA-65.verify(pdfSignature, documentHash, publicKey) → OK/FAIL
```

Стъпки 4 и 7 трябва да са и двете OK за валиден пост-квантов подпис.

---

## Съхранение в DB и PDF

- В `signing_keys.certificate`: JSON attestation като UTF-8 байтове в BYTEA колона
- В PDF `/PostQuantumSignature` речник (Фаза 4): embedded attestation JSON + ML-DSA-65 подпис

---

## OID референция

| Алгоритъм  | OID                         | Стандарт |
|------------|-----------------------------|----------|
| ML-DSA-44  | 2.16.840.1.101.3.4.3.17     | FIPS 204 / RFC 9629 |
| ML-DSA-65  | 2.16.840.1.101.3.4.3.18     | FIPS 204 / RFC 9629 |
| ML-DSA-87  | 2.16.840.1.101.3.4.3.19     | FIPS 204 / RFC 9629 |

Ние ползваме ML-DSA-65 (NIST security level 3).

---

## Ограничения (документирани за README)

- Форматът е **нестандартен** — не е X.509, не се разчита от OpenSSL / Adobe Reader / browser TLS
- Само SignShield верификаторът разбира `/PostQuantumSignature`
- Без CRL/OCSP — отзоваването е на application ниво (soft-delete на ключа в DB)
- При изтекъл сертификат: верификаторът показва „Валиден подпис, но с изтекъл сертификат"
