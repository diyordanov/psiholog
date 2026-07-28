/**
 * usePrfCeremony.ts
 * Споделена PRF ceremony логика (Ден 6 extraction) — до Ден 6 беше copy-paste-
 * ната между SignDocumentModal.tsx и InviteRecipientsModal.tsx.
 *
 * "Capture-once" pattern: изпълнява PRF ceremony(ies) ВЕДНЪЖ (single tap за
 * dual-PRF ключове от един credential, или два отделни tap-а иначе), после
 * връща MOCK extractors, които reuse-ват captured резултата — signDocument()/
 * signAsOwner() могат да го викат вътрешно без нов биометричен prompt.
 *
 * ВАЖНО за retry-able flows (signAsRecipient(), до 3 опита с race retry):
 * НЕ ползвай този hook — всеки retry там изисква ГЕНУИНЕН нов ceremony
 * (message digest-ът се сменя), затова RecipientSigningModal подава
 * browserPrfExtractor/browserDualPrfExtractor директно, не mock.
 *
 * iOS-safe ordering: PRF ceremony-те се изпълняват ПРЕДИ всякакви мрежови
 * await-ове в извикващия компонент (font fetch, signDocument DB calls) —
 * iOS Safari губи "user gesture context" за navigator.credentials.get() след
 * await към мрежата. Затова тази функция трябва да е ПЪРВОТО нещо, което се
 * await-ва след клик на "Подпиши".
 */
import { useCallback } from 'react';
import {
  browserPrfExtractor, browserDualPrfExtractor,
  type PrfExtractor, type DualPrfExtractor, type PrfResult, type DualPrfResult,
} from '../lib/crypto/keyProtection';
import type { ResolvedKeys } from '../lib/signingService';

/** Байт-по-байт сравнение на два PRF salt-а — за разпознаване кой mock extractor резултат да върне. */
function saltsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface PrfCeremonyResult {
  /** Mock single-PRF extractor (reuse captured резултат) — undefined ако ceremony-то е било чисто dual. */
  extractPrf?: PrfExtractor;
  /** Mock dual-PRF extractor — undefined ако ceremony-то е било с единичен/два отделни tap-а. */
  extractDualPrf?: DualPrfExtractor;
}

export function usePrfCeremony() {
  /**
   * Изпълнява PRF ceremony(ies) за дадените ключове и връща mock extractors.
   * Хвърля при отказ/грешка на биометрията (WebAuthn exception) — извикващият
   * трябва да го хване и покаже ясно съобщение (виж SignDocumentModal/
   * InviteRecipientsModal handleSign).
   */
  const performCeremony = useCallback(async (
    preflightKeys: ResolvedKeys,
    rpId: string,
  ): Promise<PrfCeremonyResult> => {
    let capturedPrf: PrfResult | null = null;
    let capturedPrfMlDsa: PrfResult | null = null;
    let capturedDualPrf: DualPrfResult | null = null;

    if (preflightKeys.singlePrf && preflightKeys.mlDsaData) {
      // Един биометричен tap → два ключа
      capturedDualPrf = await browserDualPrfExtractor(
        preflightKeys.ecdsaData.prfSalt,
        preflightKeys.mlDsaData.prfSalt,
        rpId,
        preflightKeys.ecdsaData.credentialId,
      );
    } else if (preflightKeys.mlDsaData) {
      // Два отделни credential-а → два tap-а
      capturedPrf = await browserPrfExtractor(
        preflightKeys.ecdsaData.prfSalt, rpId, preflightKeys.ecdsaData.credentialId,
      );
      capturedPrfMlDsa = await browserPrfExtractor(
        preflightKeys.mlDsaData.prfSalt, rpId, preflightKeys.mlDsaData.credentialId,
      );
    } else {
      // Само ECDSA
      capturedPrf = await browserPrfExtractor(
        preflightKeys.ecdsaData.prfSalt, rpId, preflightKeys.ecdsaData.credentialId,
      );
    }

    const mlDsaSalt = preflightKeys.mlDsaData?.prfSalt;
    const extractPrf: PrfExtractor | undefined = (capturedPrf || capturedPrfMlDsa)
      ? async (salt) => {
          if (capturedPrfMlDsa && mlDsaSalt && saltsEqual(salt, mlDsaSalt)) return capturedPrfMlDsa;
          return capturedPrf!;
        }
      : undefined;
    const extractDualPrf: DualPrfExtractor | undefined = capturedDualPrf
      ? async () => capturedDualPrf!
      : undefined;

    return { extractPrf, extractDualPrf };
  }, []);

  return { performCeremony };
}
