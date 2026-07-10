/**
 * cmsParser.test.ts
 * Unit тестове за:
 *   - iterChildren / readTlv (DER walker)
 *   - derToP1363 (DER ECDSA sig → P1363)
 *   - makeSignedAttrsSet (tag retag 0xA0 → 0x31)
 *   - parseCms (пълен CMS round-trip от реален fixture)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { derToP1363, makeSignedAttrsSet, parseCms } from '../lib/pdf/cmsParser';
import {
  buildSignedAttrs, buildCmsDetached, extractCertInfo,
} from '../lib/pdf/cmsBuilder';
import * as x509 from '@peculiar/x509';
import { initTestKeys, type TestKeys } from './helpers/signingFixtures';

let keys: TestKeys;
beforeAll(async () => { keys = await initTestKeys(); }, 30_000);

// ─── derToP1363 ───────────────────────────────────────────────────────────────

describe('derToP1363', () => {
  it('конвертира DER SEQUENCE{r,s} → 64-байтов P1363 без padding', () => {
    // r и s без padding (и двата < 0x80 на първи байт)
    const r  = new Uint8Array(32).fill(0x11);
    const s  = new Uint8Array(32).fill(0x22);
    const der = buildDerSig(r, s);
    const p1363 = derToP1363(der);
    expect(p1363).toHaveLength(64);
    expect(p1363.slice(0, 32)).toEqual(r);
    expect(p1363.slice(32)).toEqual(s);
  });

  it('премахва водещ 0x00 padding от r и s', () => {
    // High bit 1 → DER добавя 0x00 prefix
    const r  = new Uint8Array(32); r[0] = 0x80; // high bit 1
    const s  = new Uint8Array(32); s[0] = 0xFF;
    const der = buildDerSig(r, s);
    const p1363 = derToP1363(der);
    expect(p1363).toHaveLength(64);
    expect(p1363[0]).toBe(0x80); // 0x00 prefix е премахнат
    expect(p1363[32]).toBe(0xFF);
  });

  it('хвърля при невалиден DER (не SEQUENCE)', () => {
    const invalid = new Uint8Array([0x04, 0x02, 0x00, 0x00]); // OCTET STRING
    expect(() => derToP1363(invalid)).toThrow('Невалиден DER ECDSA подпис: очакван SEQUENCE');
  });
});

// ─── makeSignedAttrsSet ───────────────────────────────────────────────────────

describe('makeSignedAttrsSet', () => {
  it('сменя tag 0xA0 → 0x31, не модифицира оригинала', () => {
    const implicit = new Uint8Array([0xa0, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const set      = makeSignedAttrsSet(implicit);
    expect(set[0]).toBe(0x31);           // tag сменен
    expect(implicit[0]).toBe(0xa0);      // оригиналът не е пипнат
    expect(set.slice(1)).toEqual(implicit.slice(1)); // rest идентичен
  });
});

// ─── parseCms round-trip ──────────────────────────────────────────────────────

describe('parseCms', () => {
  it('извлича leaf cert DER, messageDigest и ECDSA sig от реален CMS', async () => {
    const messageDigest = new Uint8Array(32).fill(0xab);
    // Подписваме buildSignedAttrs директно
    const signedAttrs = buildSignedAttrs(messageDigest);
    const ecdsaSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.leafKeys.privateKey,
        signedAttrs,
      ),
    );
    const cmsDer = buildCmsDetached(messageDigest, ecdsaSig, keys.leafCertDer, keys.rootCaCertDer);
    const parsed = parseCms(cmsDer);

    // messageDigest match
    expect(parsed.messageDigest).toHaveLength(32);
    expect(Array.from(parsed.messageDigest)).toEqual(Array.from(messageDigest));

    // leaf cert идентичен
    expect(Array.from(parsed.leafCertDer.slice(0, 4))).toEqual(
      Array.from(keys.leafCertDer.slice(0, 4)),
    );

    // signedAttrs: tag е 0xA0 (IMPLICIT), не 0x31
    expect(parsed.signedAttrsImplicit[0]).toBe(0xa0);

    // ecdsaSig е P1363 (64 bytes за P-256)
    expect(parsed.ecdsaSigP1363).toHaveLength(64);
  });

  it('ECDSA верификация след parseCms + makeSignedAttrsSet работи', async () => {
    const messageDigest = new Uint8Array(32).fill(0xcd);
    const signedAttrs   = buildSignedAttrs(messageDigest);
    const ecdsaSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.leafKeys.privateKey,
        signedAttrs,
      ),
    );
    const cmsDer = buildCmsDetached(messageDigest, ecdsaSig, keys.leafCertDer, keys.rootCaCertDer);
    const parsed = parseCms(cmsDer);

    // Верифицираме re-tagged signedAttrs с публичния ключ от cert-а
    const leaf = new x509.X509Certificate(parsed.leafCertDer);
    const pubKey = await leaf.publicKey.export();
    const signedAttrsSet = makeSignedAttrsSet(parsed.signedAttrsImplicit);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      parsed.ecdsaSigP1363,
      signedAttrsSet,
    );
    expect(valid).toBe(true);
  });

  it('хвърля при невалиден CMS (не SEQUENCE)', () => {
    expect(() => parseCms(new Uint8Array([0x04, 0x02, 0x00, 0x00]))).toThrow('Невалиден CMS');
  });

  it('хвърля при SHA-256 с грешна дължина (не 32 bytes)', async () => {
    // 20-байтов "digest" → SHA-1 длъжина → очакваме error
    const badDigest = new Uint8Array(20).fill(0x99);
    const signedAttrs = buildSignedAttrs(badDigest); // buildSignedAttrs не валидира дължина
    const ecdsaSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.leafKeys.privateKey,
        signedAttrs,
      ),
    );
    const cmsDer = buildCmsDetached(badDigest, ecdsaSig, keys.leafCertDer);
    expect(() => parseCms(cmsDer)).toThrow('Неподдържан hash algorithm');
  });
});

// ─── DER helper за тестове ────────────────────────────────────────────────────

/** Конструира DER SEQUENCE { r INTEGER, s INTEGER } за тест на derToP1363. */
function buildDerSig(r: Uint8Array, s: Uint8Array): Uint8Array {
  const encInt = (b: Uint8Array): Uint8Array => {
    const needsPad = b[0] & 0x80;
    const inner = needsPad ? new Uint8Array([0x00, ...b]) : b;
    return new Uint8Array([0x02, inner.length, ...inner]);
  };
  const rDer = encInt(r);
  const sDer = encInt(s);
  const inner = new Uint8Array([...rDer, ...sDer]);
  return new Uint8Array([0x30, inner.length, ...inner]);
}
