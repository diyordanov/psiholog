# Раздел 6. Програмна реализация

## 6.1 Криптографски модул

Криптографският модул на SignShield се дели на две ясно разграничени отговорности: извеждане на симетричен ключ от биометрията на потребителя (HKDF-SHA256 [17]) и самото подписване/верификация с двата асиметрични алгоритъма (ECDSA P-256, ML-DSA-65 [23]). И четирите операции живеят в `src/lib/crypto/` и, с изключение на ML-DSA-65, се изпълняват директно чрез вградения браузърен Web Crypto API — без external крипто библиотека, без риск от bundle-size разход и с достъп до хардуерно ускорение, когато е налично.

**HKDF-SHA256 деривация от PRF output.** WebAuthn PRF extension-ът връща 32 сурови байта — недетерминиран поток, неподходящ за директна употреба като AES ключ без допълнителна обработка. `deriveAesKeyFromPRF()` изпълнява самата PRF ceremony (`navigator.credentials.get()` с `prf.eval.first`), после подава резултата през HKDF с известна сол (`prf_salt`, уникална за всеки ключ) и контекстен `info` низ, за да получи детерминиран, non-extractable AES-256-GCM ключ:

```typescript
export async function deriveAesKeyFromPRF(
  prfSalt: Uint8Array,
  rpId: string,
  credentialId?: Uint8Array,
  extractPrf: PrfExtractor = browserPrfExtractor,
): Promise<{ aesKey: CryptoKey; credentialId: Uint8Array }> {
  const { prfOutput, credentialId: returnedCredentialId } =
    await extractPrf(prfSalt, rpId, credentialId);

  const hkdfKey = await crypto.subtle.importKey(
    'raw', prfOutput, 'HKDF', false, ['deriveKey'],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: prfSalt as unknown as Uint8Array<ArrayBuffer>,
      info: new TextEncoder().encode('signshield-signing-key-v1'),
    },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );

  return { aesKey, credentialId: credentialId ?? returnedCredentialId };
}
```

Параметърът `extractPrf` е инжектиран (dependency injection) с production по подразбиране `browserPrfExtractor` — това позволява unit тестовете да подават mock ceremony без реален WebAuthn достъп (виж Раздел 7). Важна детайл е `false` в четвъртия аргумент на `deriveKey()`: AES ключът е маркиран **non-extractable** — веднъж изведен, не може да бъде прочетен обратно като суров байтов масив дори от собствения ни код, само ползван за encrypt/decrypt операции в рамките на текущата сесия.

**AES-256-GCM encrypt/decrypt на частни ключове.** Самото криптиране е тънка обвивка над `crypto.subtle.encrypt`/`decrypt` с режим GCM (authenticated encryption) — избран специално защото грешен ключ или подправен ciphertext хвърля `OperationError` вместо тихо да върне безсмислени байтове:

```typescript
export async function decryptPrivateKey(
  encryptedKey: Uint8Array,
  derivedKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as Uint8Array<ArrayBuffer> },
    derivedKey,
    encryptedKey as unknown as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(decrypted);
}
```

**ECDSA P-256 подписване.** Ключовете се пазят в PKCS8 DER формат (изходния формат на `crypto.subtle.exportKey('pkcs8', ...)`), затова подписването първо ги импортира обратно като `CryptoKey`, после подписва с SHA-256 хеширане, вградено в самата `sign()` операция:

```typescript
export async function signWithEcdsaP256(
  secretKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'pkcs8', new Uint8Array(secretKey),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(data),
  );
  return new Uint8Array(sigBuf); // P1363: 64 байта (r||s)
}
```

Резултатът е в P1363 формат (WebCrypto native — просто конкатенация на `r` и `s`, всеки padнат до 32 байта), различен от DER SEQUENCE формата, който CMS стандартът изисква — конверсията между двата е задача на `cmsBuilder.ts` (6.2).

**ML-DSA-65 подписване.** За разлика от ECDSA, ML-DSA-65 няма native браузърна имплементация — извиква се директно библиотеката `@noble/post-quantum` [20], чийто API е синхронен и приема аргументите в обратен ред спрямо интуитивното очакване (съобщението първо, ключът втори при подписване; подписът първи при верификация):

```typescript
export async function signWithMlDsa(
  secretKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return Promise.resolve(ml_dsa65.sign(data, secretKey));
}

export async function verifyMlDsa(
  publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array,
): Promise<boolean> {
  try {
    return Promise.resolve(ml_dsa65.verify(signature, data, publicKey));
  } catch {
    return false; // невалиден подпис — никога не хвърля навън
  }
}
```

И двете верификационни функции (`verifyEcdsaP256`, `verifyMlDsa`) следват еднакъв защитен принцип: никога не хвърлят изключение при невалиден вход — връщат `false`, обвити в `try/catch`. Това е съзнателен избор — верификационният модул (6.3) обработва произволни, непотвърдени PDF файлове от анонимни потребители; изключение при парсиране на злонамерено конструиран подпис би прекъснало целия verify процес вместо просто да отчете "невалиден".

## 6.2 PDF подписване

Ядрото на подписващата логика живее в `pdfSigner.ts` (raw PDF байтова манипулация) и `cmsBuilder.ts` (ASN.1 DER кодиране на CMS структурата). За разлика от повечето операции в приложението, тук не се ползва високо-нивовата документна модификация на `pdf-lib` [1] за втория и следващите подписи — единствено първият (owner-ският) подпис минава през пълно pdf-lib зареждане/запис; всеки следващ е ръчно построен append-only incremental update (детайли по-долу).

**Structure на PAdES [12] подпис.** Подписаният PDF съдържа стандартен `/Type /Sig` речник с четири ключови полета: `/ByteRange` — четири числа `[0, A, B, C]`, определящи кои байтове от файла участват в хеша; `/Contents` — hex-кодиран CMS ContentInfo, поставен в предварително резервирано място (placeholder) с фиксирана дължина; `/Filter /Adobe.PPKLite` и `/SubFilter /adbe.pkcs7.detached` — идентификатори, разпознавани от Adobe Acrobat. Диапазонът `[A, B)` е **изключен** от хеша именно защото там живее самия `/Contents` — той не може да участва в собствения си хеш (класически проблем на всяка схема с вграден подпис).

**`preparePdfForSigning()` — placeholder механика.** Функцията рисува визуалния маркер върху страницата чрез pdf-lib, изгражда `/Sig` речника с placeholder стойности (`999999999` за `/ByteRange`, 16384 нулеви hex символа за `/Contents` — буфер от ~8 KB, ~5× повече от типичния размер на CMS структурата), сериализира документа и после **намира собствения си обект по номер**, а не по първо текстово съвпадение:

```typescript
const sigObjMarker = new TextEncoder().encode(
  `\n${sigDictRef.objectNumber} 0 obj`,
);
const sigObjPos = findPattern(bytes, sigObjMarker);
if (sigObjPos === -1) {
  throw new Error('sig обектът не е намерен след serialize');
}

const contentsMarker = new TextEncoder().encode('/Contents <');
const contentsMarkerPos = findPattern(bytes, contentsMarker, sigObjPos);
const contentsOffset = contentsMarkerPos + contentsMarker.length - 1;
```

Последният детайл е резултат от реален производствен инцидент: ако оригиналният, качен от потребителя PDF вече съдържа собствен, недовършен `/Contents`/`/ByteRange` placeholder (например артефакт от предишно, прекъснато подписване в Adobe Acrobat Reader), наивно търсене от началото на файла намира **чуждия** placeholder първи — новият подпис остава незапълнен, а чуждият обект бива тихо презаписан. Търсенето, ограничено да започва от byte позицията на собствения `/Sig` обект (идентифициран по неговия pdf-lib `objectNumber`), елиминира този клас грешки напълно.

**Двустъпков PQ flow.** Най-нетривиалната архитектурна особеност на модула е редът, в който се изчисляват двата подписа — обяснена подробно в Раздел 5.3.3. Кодовата реализация на този принцип е разделена между `pdfSigner.ts` (приема готов `pqData` и го вгражда като реален обект) и `signingService.ts` (оркестрира двете извиквания):

```typescript
// Стъпка 1: подготовка БЕЗ PQ данни → pre-digest
const preDigestPrepared = await preparePdfForSigning(
  originalPdfBytes, signerName, signingDate, signOptions,
);
const pqPreDigest = sha256(preDigestPrepared.bytes);

// Стъпка 2: ML-DSA-65 подписва pre-digest-а (различен от ECDSA хеша!)
const mlDsaSig = await signWithMlDsa(mlDsaSecretKey, pqPreDigest);
const pqData: PqSignatureData = {
  algorithm: 'ml-dsa-65',
  signedHash: encodeBase64url(pqPreDigest),
  signatureB64url: encodeBase64url(mlDsaSig),
  publicKeyB64url: encodeBase64url(keys.mlDsaData.publicKey),
  attestation: { hasCert: true },
};

// Стъпка 3: подготовка ПАК, този път с готовия pqData — вгражда се РЕАЛНО
const prepared = await preparePdfForSigning(
  originalPdfBytes, signerName, signingDate, signOptions, pqData,
);
```

Едва след тази втора подготовка се изчислява финалният `/ByteRange` (тесен, обхващащ само `/Contents`) и се подписва с ECDSA P-256 — вграждайки транзитивна защита на целия постквантов обект в рамките на класическия подпис.

**CMS builder (ASN.1 DER структура).** `cmsBuilder.ts` изгражда CMS `SignedData` изцяло на ръка, без библиотека — приложението не се нуждае от пълноценен ASN.1 encoder, само от точно определена, фиксирана структура. Двата ключови компонента са `signedAttrs` (какво реално се подписва) и обвивката, която ги превръща във валиден `SignerInfo`:

```typescript
export function buildSignedAttrs(messageDigest: Uint8Array): Uint8Array {
  const ctAttr = derSeq(cat(
    derOid(OID_CONTENT_TYPE), derSet(derOid(OID_DATA)),
  ));
  const mdAttr = derSeq(cat(
    derOid(OID_MESSAGE_DIGEST), derSet(derOcts(messageDigest)),
  ));
  // DER SET — каноничен ред: contentType преди messageDigest
  return derSet(cat(ctAttr, mdAttr));
}
```

Забележителна детайл е разминаването между тага, използван за подписване (`0x31`, стандартен ASN.1 `SET`), и тага, използван при вграждане в `SignerInfo` (`0xA0`, `[0] IMPLICIT`) — CMS стандартът [15] изисква полето да бъде префиксирано с контекстно-специфичен таг в самата структура, но подписваната стойност трябва да остане каноничен `SET`. При верификация (`cmsParser.ts`) тагът се сменя обратно преди подаване към `crypto.subtle.verify()`.

**Incremental update за multi-signer.** Всеки подпис след първия не пресъздава документа — добавя нови обекти (`/Sig`, `Widget` annotation, CID шрифт за кирилица) и **преиздава** (redefine) съществуващите `AcroForm` и `Page` обекти на нови позиции във файла, без да пипа старите байтове:

```typescript
const fieldsMatch = acroFormDict.text.match(/\/Fields\s*\[([^\]]*)\]/);
const newFieldsArray = `/Fields [${fieldsMatch[1]}${widgetObjNum} 0 R ]`;
const newAcroFormText = acroFormDict.text.replace(
  /\/Fields\s*\[[^\]]*\]/, newFieldsArray,
);
// ... построяваме нов "N 0 obj" блок на СЪЩИЯ acroFormNum, нов offset
push(`\n${acroFormNum} 0 obj\n${newAcroFormText}\nendobj\n`);
```

Тъй като предишният подпис вече е хеширал byte диапазон, включващ старата версия на `AcroForm` обекта, всяка промяна там би скъсала неговата валидност — новата ревизия затова живее на нова позиция във файла, с нов запис в xref таблицата, сочещ към нея; PDF четци разпознават последната ревизия на всеки обект по последния xref запис, докато математически по-ранните подписи продължават да хешират точно същите байтове, каквито са били при собственото им подписване.

## 6.3 Верификация

Верификационният модул (`pdfVerifier.ts` + `verifyService.ts`) е изграден да поддържа произволен брой подписващи в един документ, без специален случай за N = 1. Първата стъпка е **извличане** — намиране на всички `/Type /Sig` обекти във файла, по реда на появяването им (файловият ред съответства на реда на подписване):

```typescript
export function extractAllSignatures(pdfBytes: Uint8Array): ExtractedSignature[] {
  const positions = findAllOccurrences(pdfBytes, enc.encode('/Type /Sig'));
  const results: ExtractedSignature[] = [];
  let prevDictEnd = 0;

  positions.forEach((sigPos, index) => {
    const dictStart = findLastBefore(pdfBytes, enc.encode('<<'), sigPos);
    const dictEnd = findDictEnd(pdfBytes, dictStart);
    results.push({
      index,
      byteRange: extractByteRangeBounded(pdfBytes, dictStart, dictEnd),
      cmsDer: extractCmsDerBounded(pdfBytes, dictStart, dictEnd),
      signedAt: extractSigningDateBounded(pdfBytes, dictStart, dictEnd),
      pqData: extractPqDataBounded(pdfBytes, prevDictEnd, dictStart),
    });
    prevDictEnd = dictEnd;
  });
  return results;
}
```

Асоциирането на постквантовия обект с "неговия" ECDSA подпис е по **файлов прозорец** (байтовете между края на предишния `/Sig` речник и началото на текущия), не по индекс, съхранен в самите данни — устойчиво на произволен брой подписващи, без нужда от координация между тях.

**Chain validation.** За всеки leaf сертификат, извлечен от CMS структурата, `verifyCertChain()` проверява дали е издаден и подписан от вградения Root CA сертификат (статично компилиран в JavaScript bundle-а), и дали периодът му на валидност все още тече:

```typescript
export async function verifyCertChain(
  leafCertDer: Uint8Array, rootCaCertDer: Uint8Array,
): Promise<{ status: CertChainStatus; expiry: Date; signerName: string }> {
  const leaf = new x509.X509Certificate(leafCertDer);
  const rootCa = new x509.X509Certificate(rootCaCertDer);

  if (new Date() > leaf.notAfter) {
    return { status: 'expired', expiry: leaf.notAfter, signerName: extractCn(leaf.subject) };
  }
  const chainValid = await leaf.verify({ publicKey: await rootCa.publicKey.export() });
  return {
    status: chainValid ? 'ok' : 'chain_invalid',
    expiry: leaf.notAfter, signerName: extractCn(leaf.subject),
  };
}
```

**Overall status логика.** Резултатите от отделните подписващи се комбинират в един обобщен статус по строго дефиниран приоритет — най-тежкото условие "печели":

```typescript
function determineOverall(signers: SignerResult[]): VerifyResult['overall'] {
  if (signers.some(s => s.ecdsa.tampered)) return 'tampered';
  if (signers.some(s => s.ecdsa.status === 'invalid')) return 'invalid';
  if (signers.some(s => s.ecdsa.certStatus === 'chain_invalid')) return 'invalid';
  if (signers.some(s => s.mlDsa?.status === 'invalid')) return 'invalid';

  const anyExpired    = signers.some(s => s.ecdsa.certStatus === 'expired');
  const anyValidMlDsa = signers.some(s => s.mlDsa?.status === 'valid');
  const anyMissingMlDsa = signers.some(s => !s.mlDsa || s.mlDsa.status === 'not_included');
  if (anyExpired || (anyValidMlDsa && anyMissingMlDsa)) return 'authentic_with_warnings';

  return 'authentic';
}
```

Разграничението между `tampered` (хешът на документа не съвпада с подписания — реална манипулация) и `invalid` (самата криптографска верификация се проваля, но съдържанието не е променено — например изтекъл сертификат или счупена сертификатна верига) е съзнателно запазено отделно през целия проект, защото двете носят различна семантика за крайния потребител: първото означава "документът е бил редактиран след подписване", второто — "подписът/сертификатът има проблем, но самото съдържание изглежда непроменено".

## 6.4 Passkey PRF integration

Реалната WebAuthn [33] PRF ceremony се изпълнява само веднъж на подписваща операция чрез споделения hook `usePrfCeremony()` — преди Ден 6 логиката за нея беше copy-paste-вана между модала за единично подписване и модала за покана на съвместни подписващи. Hook-ът съществува основно заради т.нар. "capture-once" pattern: изпълнява истинската биометрична церемония веднъж, после връща **mock extractor-и**, които `signAsOwner()` може да извиква вътрешно, без нов prompt към потребителя.

**Single vs dual PRF ceremony.** Ако ECDSA и ML-DSA-65 ключовете на потребителя произхождат от един и същ WebAuthn credential (типичният случай — потребителят генерира и двата с една и съща passkey сесия), WebAuthn PRF extension-ът позволява **един** биометричен тап да върне **два** независими PRF резултата чрез `eval.first`/`eval.second`. Ако ключовете идват от различни credential-и, се налагат два отделни tap-а:

```typescript
const performCeremony = useCallback(async (
  preflightKeys: ResolvedKeys, rpId: string,
): Promise<PrfCeremonyResult> => {
  if (preflightKeys.singlePrf && preflightKeys.mlDsaData) {
    // Един tap → два ключа (eval.first + eval.second)
    const dual = await browserDualPrfExtractor(
      preflightKeys.ecdsaData.prfSalt,
      preflightKeys.mlDsaData.prfSalt,
      rpId, preflightKeys.ecdsaData.credentialId,
    );
    return { extractDualPrf: async () => dual };
  }
  // Два отделни credential-а → два tap-а, capture-нати последователно
  const prf = await browserPrfExtractor(
    preflightKeys.ecdsaData.prfSalt, rpId, preflightKeys.ecdsaData.credentialId,
  );
  return { extractPrf: async () => prf };
}, []);
```

**iOS-safe ordering.** Критично, недокументирано в официалната WebAuthn спецификация ограничение на Safari iOS: браузърът губи "user gesture context" (изисквания контекст, потвърждаващ че действието произхожда от реален клик на потребителя, не от скрипт) веднага след първия `await` към мрежата. Ако PRF ceremony-то се извика след, примерно, зареждане на шрифт файл от сървъра, iOS отхвърля `navigator.credentials.get()` мълчаливо. Затова `usePrfCeremony()` е проектиран да бъде **първото** нещо, извикано веднага след клик на бутона "Подпиши" — преди всякакви други асинхронни операции, включително downloads на документа или на шрифт ресурси.

## 6.5 Mini-CA Edge Function

Единствената сървърна операция в цялото приложение с достъп до чувствителна тайна е `issue-certificate` — Supabase Edge Function, изпълнявана в Deno runtime [6]. Функцията приема `signingKeyId`, проверява собствеността му спрямо JWT токена на заявителя, и издава X.509 [5] leaf сертификат (ECDSA P-256) или JSON attestation (ML-DSA-65), подписани с частния ключ на вътрешния Root CA.

**JWT validation + ownership check.** Заявката е неоторизирана, ако Authorization header-ът липсва или токенът е невалиден; ключът е недостъпен, ако не принадлежи на автентикирания потребител — заявката филтрира изрично по `user_id`, не разчита единствено на RLS:

```typescript
const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
if (authError || !user) return jsonError('Invalid token', 401);

const { data: keyRow, error: keyError } = await supabase
  .from('signing_keys')
  .select('id, algorithm, public_key, certificate, user_id')
  .eq('id', signingKeyId)
  .eq('user_id', user.id)
  .is('deleted_at', null)
  .single();

if (keyError || !keyRow) return jsonError('Ключът не е намерен.', 404);
if (keyRow.certificate !== null) return json({ ok: true, alreadyIssued: true });
```

Последният ред прави операцията идемпотентна — повторна заявка за вече издаден сертификат не хвърля грешка, просто съобщава, че вече съществува.

**Rate limiting.** Вместо отделна инфраструктура (Redis, персистентен брояч), rate limit-ът брои редове в `audit_log` — операцията "издаване на сертификат" вече оставя одиторски запис, така че лимитът е просто заявка към данни, които и без това се записват:

```typescript
async function checkRateLimit(supabase, userId: string): Promise<boolean> {
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action', 'certificate_issued')
    .gte('created_at', oneMinAgo);
  return (count ?? 0) < 10;
}
```

**Изграждане на сертификата.** За разлика от повечето Node.js базирани решения, функцията НЕ използва библиотека като `@peculiar/x509` [27] — Deno edge runtime средата няма нативен Node crypto слой, а добавянето на пълноценна X.509 библиотека само за издаването на прости leaf сертификати би увеличило bundle размера ненужно. Вместо това `buildEcdsaP256Cert()` изгражда TBSCertificate структурата ръчно, чрез същите минималистични ASN.1 DER помощни функции като `cmsBuilder.ts`, и я подписва директно чрез `crypto.subtle.sign()` с CA частния ключ (внесен от Supabase Secret в PKCS8 формат):

```typescript
const tbs = derSeq(cat(
  tlv(0xa0, derInt(new Uint8Array([0x02]))), // [0] version: v3
  encodeSerial(serialHex), sigAlgId, issuerDN,
  validity, subjectDN, spki, exts,
));
const sigP1363 = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' }, caPrivKey, tbs,
);
const sigDer = p1363ToDer(new Uint8Array(sigP1363));
return derSeq(cat(tbs, sigAlgId, tlv(0x03, cat(new Uint8Array([0x00]), sigDer))));
```

Издадените сертификати носят твърдо зададени extension-и (`basicConstraints CA:FALSE`, `keyUsage: digitalSignature` единствено) — гаранция, дори при теоретична компрометация на клиентски ключ, че той не може да бъде използван за издаване на нови сертификати от чуждо име.

## 6.6 Multi-signer orchestration

Оркестрацията на многоучастниковия workflow живее изцяло в `signingService.ts`, разделена на две функции с различна отговорност и различен модел на грешки: `signAsOwner()` изпълнява се точно веднъж на заявка, докато `attemptRecipientSign()` (обвита в retry loop от `signAsRecipient()`) може да бъде извикана многократно от произволен брой независими получатели.

**Разделение signAsOwner() / signAsRecipient().** Собственикът винаги подписва през стандартния (single-signer) `preparePdfForSigning()` път, тъй като е гарантирано първият подписващ — документът все още не съществува в подписан вид. Всеки получател подписва инкрементално, върху последната налична версия — функциите споделят помощни стъпки (`resolveSigningKeys()`, PRF декриптиране), но самата PDF подготовка минава през различни примитиви (`preparePdfForSigning` срещу `prepareIncrementalSignature`).

**Optimistic concurrency retry loop.** Тъй като получателите могат да подписват в произволен, непредвидим ред — потенциално почти едновременно — всеки опит за подпис може да се провали заради състезателно условие. Retry логиката повтаря **целия** опит (включително нова биометрична церемония, защото byte диапазонът вече се е сменил), не само неуспелия запис:

```typescript
export async function signAsRecipient(
  recipientId: string, userId: string, signerName: string, rpId: string,
  fontBytes: Uint8Array, extractPrf?: PrfExtractor,
  extractDualPrf?: DualPrfExtractor,
  onProgress?: (pct: number, label: string) => void,
): Promise<RecipientSignResult> {
  for (let attempt = 1; attempt <= MAX_RECIPIENT_SIGN_RETRIES; attempt++) {
    try {
      return await attemptRecipientSign(
        recipientId, userId, signerName, rpId, fontBytes,
        extractPrf, extractDualPrf, onProgress,
      );
    } catch (e) {
      if (!(e instanceof ConcurrentSignError)) throw e;
      if (attempt === MAX_RECIPIENT_SIGN_RETRIES) {
        throw new Error(`Опитахме ${MAX_RECIPIENT_SIGN_RETRIES} пъти без успех.`);
      }
    }
  }
  throw new Error('Неочаквана грешка при подписване.');
}
```

Самото засичане на race условие става на две независими места: неуспешен `upload` на файла с `upsert: false` (друг получател вече е качил същия version номер) или условен `UPDATE ... WHERE version = <прочетена стойност>`, засегнал нула редове (друг получател вече е инкрементирал брояча). И двете хвърлят `ConcurrentSignError` — вътрешен, немаркиран за потребителя тип грешка, разпознаваем само от самия retry loop.

**Storage path конвенция.** Всяка версия на подписания документ се пази под `<signing_request_id>/v<version>.pdf` — папката представлява заявката, не потребителя, тъй като документът логически принадлежи на целия процес, не на отделен участник. Комбинацията от `upsert: false` (забранява презаписване на съществуващ path) и нарастващия `version` номер прави storage слоя самостоятелна втора линия на защита срещу дублирано подписване — дори ако проверката на ниво база данни по някаква причина пропусне race условие, опитът за качване на вече съществуващ файлов път ще се провали атомарно.

---

## Използвана литература (раздел 6)

Номерацията следва консолидираната библиография — виж Раздел 10.

[1] Aaditya Agrawal et al. *pdf-lib: Create and modify PDF documents in any JavaScript environment* (Създаване и модификация на PDF документи в JavaScript). https://pdf-lib.js.org. 2024.

[5] Cooper, D., Santesson, S., Farrell, S., Boeyen, S., Housley, R., Polk, W. *Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile* (X.509 профил на сертификати и списъци за отмяна). RFC 5280. https://datatracker.ietf.org/doc/html/rfc5280. Май 2008.

[6] Deno Land Inc. *Deno — A modern runtime for JavaScript and TypeScript* (Съвременна среда за изпълнение на JavaScript и TypeScript). https://deno.com. 2024.

[12] European Telecommunications Standards Institute. *PDF Advanced Electronic Signatures (PAdES). Part 1: Building blocks and PAdES baseline signatures* (Усъвършенствани електронни подписи за PDF. Част 1). ETSI EN 319 142-1. https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/. 2016.

[15] Housley, R. *Cryptographic Message Syntax (CMS)* (Криптографски синтаксис на съобщения). RFC 5652. https://datatracker.ietf.org/doc/html/rfc5652. Септември 2009.

[17] Krawczyk, H., Eronen, P. *HMAC-based Extract-and-Expand Key Derivation Function (HKDF)* (HMAC-базирана функция за деривация на ключове). RFC 5869. https://datatracker.ietf.org/doc/html/rfc5869. Май 2010.

[20] Miller, P. *noble-post-quantum: Audited & minimal JS implementation of post-quantum algorithms* (Одитирана минималистична JS имплементация на постквантови алгоритми). https://github.com/paulmillr/noble-post-quantum. 2024.

[23] National Institute of Standards and Technology. *Module-Lattice-Based Digital Signature Standard* (Стандарт за цифров подпис, базиран на модулни решетки). FIPS 204. https://csrc.nist.gov/pubs/fips/204/final. Август 2024.

[27] Peculiar Ventures. *@peculiar/x509 — X.509 certificate library for Node.js and browser* (Библиотека за X.509 сертификати). https://github.com/PeculiarVentures/x509. 2024.

[33] World Wide Web Consortium. *Web Authentication: An API for accessing Public Key Credentials, Level 3* (Уеб автентикация: API за достъп до публични ключови идентификатори, ниво 3). https://www.w3.org/TR/webauthn-3/. 2023.
