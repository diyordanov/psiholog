-- ============================================================
-- Миграция 0002: поправка на handle_new_user() за анонимна регистрация
--
-- Във Фаза 1 потребителят се регистрира през auth.signInAnonymously(),
-- а не през email. При анонимен потребител new.email е null, затова
-- display_name трябва да дойде от raw_user_meta_data (където signInAnonymously
-- го записва, ако подадем { options: { data: { display_name } } }).
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  );
  return new;
end;
$$;
