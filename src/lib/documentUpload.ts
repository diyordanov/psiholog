/**
 * documentUpload.ts
 * Всички операции с документи: качване, изтриване, зареждане от базата.
 *
 * Поток при качване на нов документ:
 *   1. SHA-256 хеш на съдържанието (Web Crypto API — без зависимости)
 *   2. XHR upload в Supabase Storage bucket 'documents' с прогрес callback
 *   3. INSERT запис в таблица 'documents' с хеша и metadata
 *   4. При DB грешка — изтриваме физическия файл от Storage (rollback)
 */
import { supabase } from './supabase';
import { logAuditEvent } from './auditLog';

/** Резултат от успешно качване. */
export interface UploadResult {
  documentId: string;
  storagePath: string;
  hashHex: string;
}

/** Един ред от таблицата `documents`, върнат от базата. */
export interface DocumentRow {
  id: string;
  original_filename: string;
  storage_path: string;
  status: 'uploaded' | 'signed';
  created_at: string;
  signed_at: string | null;
  signed_storage_path: string | null;
}

/**
 * Изчислява SHA-256 хеш на буфера чрез Web Crypto API (вградено в браузъра).
 * Резултатът е форматиран като `\x<hex>` — Postgres bytea литерален формат.
 *
 * Хешът се записва в DB при качване и се верифицира при подписване,
 * за да се гарантира, че документът не е модифициран между двете операции.
 */
async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `\\x${hex}`;
}

/**
 * Качва файл в Supabase Storage чрез XHR (не fetch) за да може да репортира прогрес.
 * Supabase JS клиентът използва fetch вътрешно и не излага upload progress events.
 *
 * @param url           Storage REST API URL за файла
 * @param file          File обектът за качване
 * @param accessToken   JWT токенът на текущия потребител (взет от сесията)
 * @param onProgress    Callback с процент (0–100), извикван при всеки XHR прогрес event
 */
function uploadWithProgress(
  url: string,
  file: File,
  accessToken: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('x-upsert', 'false'); // отказваме презаписване на съществуващ файл
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Грешка при качване: ${xhr.status} ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Мрежова грешка при качване.'));
    xhr.send(file);
  });
}

/**
 * Качва PDF документ: изчислява хеш, записва в Storage и в базата.
 *
 * @param file        File обектът избран от потребителя
 * @param buffer      Съдържанието на файла (четено преди да дойде тук за PDF scan)
 * @param userId      UUID на текущия потребител
 * @param onProgress  Опционален callback за прогрес на upload-а (0–100%)
 */
export async function uploadDocument(
  file: File,
  buffer: ArrayBuffer,
  userId: string,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  // 1. Изчисляваме SHA-256 хеш преди качване — гарантира целостта на файла.
  const hashHex = await computeSha256Hex(buffer);

  // 2. Генерираме уникален path: {user_id}/{timestamp}-{sanitized_filename}
  // Timestamp предотвратява колизии при качване на файл с еднакво име.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${Date.now()}-${safeName}`;

  // 3. Взимаме access token от активната сесия за XHR автентикация.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Не сте логнат.');

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/documents/${storagePath}`;

  await uploadWithProgress(uploadUrl, file, session.access_token, onProgress ?? (() => {}));

  // 4. Записваме метаданните в DB.
  // При грешка изтриваме файла от Storage за да не останат "сираци" (файл без DB ред).
  const { data, error: dbError } = await supabase
    .from('documents')
    .insert({
      user_id: userId,
      original_filename: file.name,
      storage_path: storagePath,
      original_hash_sha256: hashHex,
      status: 'uploaded',
    })
    .select('id')
    .single();

  if (dbError || !data) {
    console.error('uploadDocument: DB insert failed:', dbError?.message);
    await supabase.storage.from('documents').remove([storagePath]);
    throw new Error('Грешка при записване на документа. Опитайте отново.');
  }

  await logAuditEvent(userId, 'document_uploaded', data.id as string);
  return { documentId: data.id as string, storagePath, hashHex };
}

/**
 * Генерира временен signed URL за четене на документ от Storage.
 * TTL е 300 секунди (5 минути) — достатъчно за преглед, но не за постоянно споделяне.
 *
 * Signed URL съдържа криптографски токен в query string-а — не изисква
 * допълнителни auth headers при fetch-ване (подходящо за XHR и pdf.js).
 */
export async function getDocumentSignedUrl(
  storagePath: string,
  userId: string,
  documentId: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, 300);

  if (error || !data) {
    console.error('getDocumentSignedUrl failed:', error?.message);
    throw new Error('Неуспешно генериране на URL за документа. Опитайте отново.');
  }

  await logAuditEvent(userId, 'document_downloaded', documentId);
  return data.signedUrl;
}

/**
 * Soft-изтрива документ — поставя `deleted_at` timestamp.
 * Физическият файл в Storage и DB редът остават (за одит и евентуално възстановяване).
 * RLS SELECT политиките филтрират `deleted_at IS NULL`, така документът изчезва от списъка.
 */
export async function softDeleteDocument(documentId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', documentId);

  if (error) {
    console.error('softDeleteDocument failed:', error.message);
    throw new Error('Грешка при изтриване на документа. Опитайте отново.');
  }

  await logAuditEvent(userId, 'document_deleted', documentId);
}

/**
 * Зарежда всички документи на текущия потребител, сортирани от най-нов към най-стар.
 * Soft-изтритите документи са автоматично изключени от RLS политиката,
 * но добавяме `is('deleted_at', null)` и на клиентско ниво за по-явна семантика.
 */
export async function fetchUserDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, original_filename, storage_path, status, created_at, signed_at, signed_storage_path')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as DocumentRow[];
}
