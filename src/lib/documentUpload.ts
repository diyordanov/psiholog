// Качване на PDF документ:
//   1. SHA-256 хеш на файла (Web Crypto API — без зависимости)
//   2. Upload в Supabase Storage bucket 'documents'
//   3. INSERT в таблица 'documents'

import { supabase } from './supabase';

export interface UploadResult {
  documentId: string;
  storagePath: string;
  hashHex: string;
}

// Изчислява SHA-256 хеш и го връща като \x-prefixed hex string (Postgres bytea формат)
async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `\\x${hex}`;
}

// Качва файл директно през XHR за да може да репортира прогрес.
// Supabase JS клиентът не излага upload progress (ползва fetch вътрешно).
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
    xhr.setRequestHeader('x-upsert', 'false');
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

export async function uploadDocument(
  file: File,
  buffer: ArrayBuffer,
  userId: string,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  // 1. SHA-256 хеш
  const hashHex = await computeSha256Hex(buffer);

  // 2. Генерираме уникален път в Storage: {user_id}/{timestamp}-{filename}
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${Date.now()}-${safeName}`;

  // 3. Взимаме access token за XHR upload
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Не сте логнат.');

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/documents/${storagePath}`;

  await uploadWithProgress(uploadUrl, file, session.access_token, onProgress ?? (() => {}));


  // 3. INSERT в documents таблица
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
    // Изтриваме файла от Storage ако DB insert е неуспешен
    await supabase.storage.from('documents').remove([storagePath]);
    throw new Error(`Грешка при записване: ${dbError?.message ?? 'неизвестна'}`);
  }

  return { documentId: data.id as string, storagePath, hashHex };
}

// Генерира временен signed URL за преглед (TTL: 5 минути)
export async function getDocumentSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, 300);

  if (error || !data) {
    throw new Error(`Неуспешно генериране на URL: ${error?.message ?? 'неизвестна'}`);
  }

  return data.signedUrl;
}

export interface DocumentRow {
  id: string;
  original_filename: string;
  storage_path: string;
  status: 'uploaded' | 'signed';
  created_at: string;
  signed_at: string | null;
}

// Soft-изтрива документ — поставя deleted_at, не трие физически
export async function softDeleteDocument(documentId: string): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', documentId);

  if (error) throw new Error(`Грешка при изтриване: ${error.message}`);
}

// Зарежда всички документи на текущия потребител
export async function fetchUserDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, original_filename, storage_path, status, created_at, signed_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as DocumentRow[];
}
