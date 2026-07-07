/**
 * keyProtection.ts
 * Защита на подписващи ключове чрез WebAuthn PRF extension (Section 3.2).
 *
 * Архитектура:
 *   navigator.credentials.get() с PRF extension
 *   → PRF output (32 bytes, детерминиран за дадена passkey + prf_salt)
 *   → HKDF-SHA256 (IKM = PRF output, salt = prf_salt, info = контекстен label)
 *   → AES-256-GCM ключ
 *   → AES-GCM encrypt на signing key → encrypted_private_key в DB
 *
 * Тестване: подай mockPrfExtractor вместо browserPrfExtractor.
 * В тестове никога не се вика реален navigator.credentials.get().
 */

/** Резултат от PRF ceremony: суровите байтове от PRF и credential ID. */
export interface PrfResult {
  prfOutput: ArrayBuffer;
  credentialId: Uint8Array;
}

/**
 * Функция, която изпълнява PRF ceremony и връща PRF output + credential ID.
 * По подразбиране: browserPrfExtractor (реален WebAuthn).
 * При тестове: mock, който връща фиксирани стойности.
 */
export type PrfExtractor = (
  prfSalt: Uint8Array,
  rpId: string,
  credentialId?: Uint8Array,
) => Promise<PrfResult>;

/**
 * Реалната PRF ceremony чрез браузърния WebAuthn API.
 * Не се вика при тестове (vitest environment: 'node' няма navigator).
 */
export const browserPrfExtractor: PrfExtractor = async (prfSalt, rpId, credentialId) => {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      allowCredentials: credentialId
        ? [{ id: credentialId as unknown as Uint8Array<ArrayBuffer>, type: 'public-key' as const }]
        : undefined, // unguided: браузърът показва всички passkeys за rpId
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: prfSalt } },
      } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential;

  const prfOutput = (credential.getClientExtensionResults() as Record<string, unknown> & {
    prf?: { results?: { first?: ArrayBuffer } };
  })?.prf?.results?.first;

  if (!prfOutput) {
    throw new Error(
      'PRF не се поддържа от този браузър или passkey. ' +
      'Използвайте Chrome, Firefox 148+ или Safari 18+.',
    );
  }

  return {
    prfOutput,
    credentialId: new Uint8Array(credential.rawId),
  };
};

/**
 * Извежда AES-256-GCM ключ от WebAuthn PRF output чрез HKDF-SHA256.
 *
 * При генериране на нов ключ: credentialId е undefined → unguided ceremony
 *   (браузърът показва passkey chooser). Credential ID идва от response-а.
 * При декриптиране: credentialId е известен от DB → guided ceremony
 *   (браузърът директно иска биометрия за конкретния passkey).
 *
 * @param prfSalt      32 random bytes, уникален per-key (взима се от DB или се генерира)
 * @param rpId         WebAuthn Relying Party ID (window.location.hostname в браузъра)
 * @param credentialId Опционален — credential ID за guided ceremony
 * @param extractPrf   Injectable за тестове; default: browserPrfExtractor
 */
export async function deriveAesKeyFromPRF(
  prfSalt: Uint8Array,
  rpId: string,
  credentialId?: Uint8Array,
  extractPrf: PrfExtractor = browserPrfExtractor,
): Promise<{ aesKey: CryptoKey; credentialId: Uint8Array }> {
  const { prfOutput, credentialId: returnedCredentialId } =
    await extractPrf(prfSalt, rpId, credentialId);

  // HKDF: IKM = PRF output, salt = prf_salt, info = контекстен label
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveKey'],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: prfSalt as unknown as Uint8Array<ArrayBuffer>,
      info: new TextEncoder().encode('signshield-signing-key-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return { aesKey, credentialId: credentialId ?? returnedCredentialId };
}

/**
 * Криптира secretKey с AES-256-GCM.
 * GCM е authenticated encryption — грешен ключ или IV хвърля OperationError.
 */
export async function encryptPrivateKey(
  secretKey: Uint8Array,
  derivedKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const ivBuf = iv as unknown as Uint8Array<ArrayBuffer>;
  const keyBuf = secretKey as unknown as Uint8Array<ArrayBuffer>;
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, derivedKey, keyBuf);
  return new Uint8Array(encrypted);
}

/**
 * Декриптира secretKey с AES-256-GCM.
 * Хвърля DOMException(OperationError) ако derivedKey е грешен (грешна passkey / wrong prf_salt).
 */
export async function decryptPrivateKey(
  encryptedKey: Uint8Array,
  derivedKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const ivBuf = iv as unknown as Uint8Array<ArrayBuffer>;
  const encBuf = encryptedKey as unknown as Uint8Array<ArrayBuffer>;
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, derivedKey, encBuf);
  return new Uint8Array(decrypted);
}
