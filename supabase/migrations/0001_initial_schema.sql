-- ============================================================
-- Миграция 0001: начална схема за приложението за подписване на PDF
-- Виж PROJECT_BRIEF.md, Section 4, за пълния дизайн на данните.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- ENUM типове ----------

create type signing_algorithm as enum ('ed25519', 'ml-dsa-65');
create type document_status as enum ('uploaded', 'signed');

-- ============================================================
-- Таблици
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.signing_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  algorithm signing_algorithm not null,
  public_key bytea not null,
  -- частният ключ НЕ се пази тук — стои в IndexedDB на клиента (виж PROJECT_BRIEF.md 3.2)
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  original_filename text not null,
  storage_path text not null,
  signed_storage_path text,
  original_hash_sha256 bytea not null,
  status document_status not null default 'uploaded',
  created_at timestamptz not null default now(),
  signed_at timestamptz
);

create table public.signatures (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  signing_key_id uuid not null references public.signing_keys (id),
  algorithm signing_algorithm not null,
  signature_bytes bytea not null,
  signed_at timestamptz not null default now(),
  visual_marker_page int not null,
  visual_marker_x numeric not null,
  visual_marker_y numeric not null
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  resource_id uuid,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Индекси на foreign keys, за бързи заявки тип "own записи"
create index documents_user_id_idx on public.documents (user_id);
create index signing_keys_user_id_idx on public.signing_keys (user_id);
create index signatures_document_id_idx on public.signatures (document_id);
create index signatures_user_id_idx on public.signatures (user_id);
create index audit_log_user_id_idx on public.audit_log (user_id);

-- ============================================================
-- Автоматично създаване на profiles ред при регистрация
-- Стандартен Supabase pattern: trigger на auth.users -> public.profiles
-- ============================================================

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

alter table public.profiles enable row level security;
alter table public.signing_keys enable row level security;
alter table public.documents enable row level security;
alter table public.signatures enable row level security;
alter table public.audit_log enable row level security;

-- profiles: потребителят вижда и редактира само себе си.
-- Без INSERT policy — редът се създава само през тригъра по-горе.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- signing_keys: потребителят вижда и създава само свои ключове.
-- Без UPDATE (публичният ключ е неизменим след създаване).
create policy "signing_keys_select_own" on public.signing_keys
  for select using (auth.uid() = user_id);
create policy "signing_keys_insert_own" on public.signing_keys
  for insert with check (auth.uid() = user_id);
create policy "signing_keys_delete_own" on public.signing_keys
  for delete using (auth.uid() = user_id);

-- documents: пълен CRUD върху собствени документи.
create policy "documents_select_own" on public.documents
  for select using (auth.uid() = user_id);
create policy "documents_insert_own" on public.documents
  for insert with check (auth.uid() = user_id);
create policy "documents_update_own" on public.documents
  for update using (auth.uid() = user_id);
create policy "documents_delete_own" on public.documents
  for delete using (auth.uid() = user_id);

-- signatures: само SELECT и INSERT — без UPDATE/DELETE.
-- Целенасочено отклонение от "auth.uid() = user_id за всички операции" в Section 4 на brief-а:
-- подписът е доказателство, че документ е бил подписан в даден момент.
-- Ако позволим UPDATE/DELETE, потребител може да изтрие следа от вече направен подпис.
create policy "signatures_select_own" on public.signatures
  for select using (auth.uid() = user_id);
create policy "signatures_insert_own" on public.signatures
  for insert with check (auth.uid() = user_id);

-- audit_log: само SELECT и INSERT — без UPDATE/DELETE, по същата логика
-- (audit log трябва да е immutable, за да има смисъл от него, виж Section 5).
create policy "audit_log_select_own" on public.audit_log
  for select using (auth.uid() = user_id);
create policy "audit_log_insert_own" on public.audit_log
  for insert with check (auth.uid() = user_id);

-- ============================================================
-- Storage buckets (виж PROJECT_BRIEF.md 3.5 и Фаза 0)
-- ============================================================

insert into storage.buckets (id, name, public)
values
  ('documents', 'documents', false),
  ('signed-documents', 'signed-documents', false)
on conflict (id) do nothing;

-- Конвенция за пътя на файловете: '<user_id>/<filename>'.
-- (storage.foldername(name))[1] извлича '<user_id>' от пътя, за да го сравним с auth.uid().

create policy "documents_bucket_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "documents_bucket_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "documents_bucket_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "signed_documents_bucket_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'signed-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "signed_documents_bucket_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'signed-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "signed_documents_bucket_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'signed-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
