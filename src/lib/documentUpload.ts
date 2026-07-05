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

export async function uploadDocument(
  file: File,
  buffer: ArrayBuffer,
  userId: string
): Promise<UploadResult> {
  // 1. SHA-256 хеш
  const hashHex = await computeSha256Hex(buffer);

  // 2. Генерираме уникален път в Storage: {user_id}/{timestamp}-{filename}
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${Date.now()}-${safeName}`;

  const { error: storageError } = await supabase.storage
    .from('documents')
    .upload(storagePath, file, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (storageError) {
    throw new Error(`Грешка при качване: ${storageError.message}`);
  }

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
