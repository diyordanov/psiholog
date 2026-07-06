/**
 * keyGeneration.ts
 * Keypair generation за Ed25519 и ML-DSA-65 (Dilithium / FIPS-204).
 *
 * Ed25519:   32-byte secretKey → 32-byte publicKey, async (ползва crypto.subtle вътрешно)
 * ML-DSA-65: 4032-byte secretKey → 1952-byte publicKey, sync (CRYSTALS-Dilithium level 3)
 *
 * ⚠ ML-DSA-65 в браузъра: keygen е CPU-bound и замразява UI thread за 2–15 сек.
 *   В UI контексти ползвайте mlDsaKeygen.worker.ts.
 *   Тук функцията е достъпна директно за тестове и server-side употреба.
 */
import { keygenAsync } from '@noble/ed25519';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

export interface Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Генерира Ed25519 keypair.
 * Async защото getPublicKey ползва crypto.subtle SHA-512 вътрешно.
 */
export async function generateEd25519Keypair(): Promise<Keypair> {
  return keygenAsync();
}

/**
 * Генерира ML-DSA-65 (Dilithium) keypair — синхронно.
 * В браузъра извиквай само от Web Worker, за да не блокираш UI.
 */
export function generateMlDsaKeypair(): Keypair {
  const { publicKey, secretKey } = ml_dsa65.keygen();
  return { publicKey, secretKey };
}
