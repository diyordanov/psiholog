/// <reference lib="webworker" />
/**
 * mlDsaKeygen.worker.ts
 * Web Worker за ML-DSA-65 keypair generation без блокиране на UI thread.
 *
 * ML-DSA-65 keygen е CPU-bound и отнема 2–15 сек на мобилни/low-end устройства.
 * Изпълнен в Worker, main thread остава отзивчив и показва спинер + "Отмени" бутон.
 *
 * Протокол (main → worker):
 *   postMessage(null)                              — стартирай генерирането
 *   terminate()                                    — анулирай при клик "Отмени"
 *
 * Протокол (worker → main):
 *   { ok: true,  publicKey: Uint8Array, secretKey: Uint8Array }  — успех
 *   { ok: false, error: string }                                  — грешка
 *
 * Buffers се ПРЕХВЪРЛЯТ (не копират) за ефективност.
 * След transfer, worker-ският буфер е detached — достъпен само в main thread.
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

self.onmessage = () => {
  try {
    const { publicKey, secretKey } = ml_dsa65.keygen();
    self.postMessage(
      { ok: true, publicKey, secretKey },
      [publicKey.buffer, secretKey.buffer],
    );
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : 'Worker грешка' });
  }
};
