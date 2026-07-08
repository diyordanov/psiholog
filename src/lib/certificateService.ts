/**
 * certificateService.ts
 * Frontend helper за издаване на сертификати чрез Edge Function issue-certificate.
 *
 * issueCertificate   — издава сертификат за един ключ
 * retrofitMissingCerts — batch retrofit за ключове без сертификат (silent, при page load)
 */
import { supabase } from './supabase';

/**
 * Вика Edge Function issue-certificate за даден ключ.
 * Функцията е идемпотентна — ако сертификатът вече е издаден, връща 200.
 *
 * @throws Error при мрежова грешка или грешка от функцията
 */
export async function issueCertificate(signingKeyId: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Сесията е изтекла. Влезте отново.');

  const { error } = await supabase.functions.invoke('issue-certificate', {
    body: { signingKeyId },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) {
    throw new Error(`Грешка при издаване на сертификат: ${error.message}`);
  }
}

/**
 * Тихо retrofit-ва всички ключове без сертификат.
 * Вика се при зареждане на KeyManagement — потребителят не вижда отделна стъпка.
 * Partial failure e ОК — провалените ключове показват ⚠️ в KeyCard.
 *
 * @param keyIds UUID-та на ключовете с certStatus === 'missing'
 * @returns Map: keyId → 'ok' | 'error'
 */
export async function retrofitMissingCerts(
  keyIds: string[],
): Promise<Map<string, 'ok' | 'error'>> {
  const results = new Map<string, 'ok' | 'error'>();
  if (keyIds.length === 0) return results;

  await Promise.allSettled(
    keyIds.map(async (id) => {
      try {
        await issueCertificate(id);
        results.set(id, 'ok');
      } catch (err) {
        console.warn(`Retrofit на сертификат за ${id} неуспешен:`, err);
        results.set(id, 'error');
      }
    }),
  );

  return results;
}
