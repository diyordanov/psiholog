/**
 * generate-rls-test-0012-0014-data.ts
 *
 * Помощен скрипт — създава реалните test записи (2 документа на един owner +
 * 2 recipient акаунта), нужни за scripts/rls-test-0012-0014.sql, и генерира
 * ПОПЪЛНЕН вариант на SQL файла (плейсхолдърите заменени с реални UUID/email),
 * готов за copy-paste в Supabase SQL Editor.
 *
 * НЕ трие създадените записи автоматично — SQL тестът трябва да ги ползва
 * СЛЕД това. Cleanup инструкции се печатат накрая.
 *
 * Изисквания (.env.local): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (същите като scripts/test-multi-signer-e2e.ts).
 *
 * Стартиране:
 *   npx tsx --env-file=.env.local scripts/generate-rls-test-0012-0014-data.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function toByteaHex(bytes: Uint8Array): string {
  return '\\x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('❌ VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY липсват в .env.local!');
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log('👤 Създаване на test потребители...');
  const ts = Date.now();

  async function createTestUser(label: string) {
    const email = `rls-test-${label}-${ts}@test.signshield.invalid`;
    const password = `RlsTest!${Math.random().toString(36).slice(2)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser(${label}) failed: ${error?.message}`);
    console.log(`   ✓ ${label}: ${email} (${data.user.id})`);
    return { id: data.user.id, email };
  }

  const ownerA      = await createTestUser('owner-a');
  const recipientX  = await createTestUser('recipient-x');
  const recipientY  = await createTestUser('recipient-y');

  console.log('\n📄 Създаване на 2 тестови документа (owner A)...');
  async function createTestDocument(filename: string) {
    const { data, error } = await admin.from('documents').insert({
      user_id: ownerA.id,
      original_filename: filename,
      storage_path: `${ownerA.id}/${filename}`,
      original_hash_sha256: toByteaHex(new Uint8Array(32)),
      status: 'uploaded',
    }).select('id').single();
    if (error || !data) throw new Error(`insert documents(${filename}) failed: ${error?.message}`);
    console.log(`   ✓ ${filename}: ${data.id}`);
    return data.id as string;
  }

  const doc1Id = await createTestDocument('rls-test-doc1.pdf');
  const doc2Id = await createTestDocument('rls-test-doc2.pdf');

  console.log('\n📝 Генериране на попълнен SQL файл...');
  const template = readFileSync('scripts/rls-test-0012-0014.sql', 'utf-8');
  const filled = template
    .replaceAll('<OWNER_A_UUID>', ownerA.id)
    .replaceAll('<DOC1_UUID>', doc1Id)
    .replaceAll('<DOC2_UUID>', doc2Id)
    .replaceAll('<RECIPIENT_X_UUID>', recipientX.id)
    .replaceAll('<RECIPIENT_X_EMAIL>', recipientX.email)
    .replaceAll('<RECIPIENT_Y_UUID>', recipientY.id)
    .replaceAll('<RECIPIENT_Y_EMAIL>', recipientY.email);

  mkdirSync('scripts/output', { recursive: true });
  const outPath = 'scripts/output/rls-test-0012-0014-filled.sql';
  writeFileSync(outPath, filled);

  console.log(`\n📁 Готов файл: ${outPath}`);
  console.log('\n📋 Инструкции:');
  console.log('   1. Отвори файла, копирай SETUP блока → paste в Supabase SQL Editor → Run');
  console.log('   2. Копирай ВСЕКИ номериран Тест (1-7) ПООТДЕЛНО → paste → Run (не целия файл наведнъж!)');
  console.log('   3. Прати ми резултатите от всеки Тест');
  console.log('\n🧹 Cleanup СЛЕД като приключиш тестването (кажи ми — ще пусна автоматично):');
  console.log(`   admin.auth.admin.deleteUser за: ${ownerA.id}, ${recipientX.id}, ${recipientY.id}`);
  console.log('   (cascade изтрива documents/signing_requests/recipients автоматично)');
}

main().catch(e => {
  console.error('\n❌ Грешка:', e);
  process.exit(1);
});
