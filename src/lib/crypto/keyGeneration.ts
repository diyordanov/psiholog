import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

/** Универсален формат за keypair, връщан от двата генератора по-долу (ECDSA и ML-DSA). */
export interface Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Генерира ECDSA P-256 keypair чрез WebCrypto.
 * publicKey  = 65 байта, uncompressed point (0x04 || x || y) — пази се в DB
 * secretKey  = PKCS8 DER байтове — криптират се с AES-GCM преди пазене
 */
export async function generateEcdsaKeypair(): Promise<Keypair> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const raw   = await crypto.subtle.exportKey('raw',   publicKey);
  return {
    publicKey: new Uint8Array(raw),   // 65 байта
    secretKey: new Uint8Array(pkcs8), // ~138 байта PKCS8 DER
  };
}

/**
 * Генерира ML-DSA-65 (Dilithium) keypair — синхронно.
 * В браузъра извиквай само от Web Worker, за да не блокираш UI.
 */
export function generateMlDsaKeypair(): Keypair {
  const { publicKey, secretKey } = ml_dsa65.keygen();
  return { publicKey, secretKey };
}
