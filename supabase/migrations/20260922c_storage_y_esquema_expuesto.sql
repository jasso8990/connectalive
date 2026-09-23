-- (Aplicadas en la base el 2026-09-22 como `connectalive_storage_bucket` y
-- `connectalive_exposed_schema`; se traen al repo el 2026-09-23.)

-- Bucket "connectalive" (privado) + políticas de acceso por sala.
insert into storage.buckets (id, name, public, file_size_limit)
values ('connectalive', 'connectalive', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "connectalive_leer" on storage.objects;
create policy "connectalive_leer" on storage.objects
  for select using (
    bucket_id = 'connectalive'
    and exists (select 1 from connectalive.participantes p
                where p.user_id = auth.uid()
                  and split_part(objects.name, '/', 1) = p.sala_id::text)
  );

drop policy if exists "connectalive_leer_presentaciones" on storage.objects;
create policy "connectalive_leer_presentaciones" on storage.objects
  for select using (
    bucket_id = 'connectalive'
    and objects.name like 'presentaciones/%'
    and exists (select 1 from connectalive.participantes p
                where p.user_id = auth.uid()
                  and split_part(objects.name, '/', 2) = p.sala_id::text)
  );

drop policy if exists "connectalive_subir" on storage.objects;
create policy "connectalive_subir" on storage.objects
  for insert with check (
    bucket_id = 'connectalive'
    and exists (select 1 from connectalive.participantes p
                where p.user_id = auth.uid()
                  and (split_part(objects.name, '/', 1) = p.sala_id::text
                       or (objects.name like 'presentaciones/%'
                           and split_part(objects.name, '/', 2) = p.sala_id::text)))
  );

drop policy if exists "connectalive_borrar_dirigente" on storage.objects;
create policy "connectalive_borrar_dirigente" on storage.objects
  for delete using (
    bucket_id = 'connectalive'
    and exists (select 1 from connectalive.salas s
                where s.dirigente_id = auth.uid()
                  and (split_part(objects.name, '/', 1) = s.id::text
                       or (objects.name like 'presentaciones/%'
                           and split_part(objects.name, '/', 2) = s.id::text)))
  );

-- Exponer el esquema en PostgREST. Si alguien guarda la lista desde el panel
-- (Settings → API → Exposed schemas) se puede sobrescribir: volver a correr.
alter role authenticator set pgrst.db_schemas to 'public,connectalive,storage,graphql_public';
notify pgrst, 'reload config';
