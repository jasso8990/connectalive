-- El celular no podía abrir el PDF de una presentación libre que subió la
-- PC con otra cuenta: «No se pudo abrir el PDF — Object not found».
--
-- La política `connectalive_libres_leer` preguntaba por `tablero_vistas`
-- con un `exists` directo, pero esa tabla tiene RLS sin políticas: dentro
-- de la política de Storage el usuario no ve NINGUNA fila, así que sólo el
-- dueño (la rama del uid en la ruta) podía leer. Storage contesta 404 en
-- lugar de 403. Se pasa por una función SECURITY DEFINER, como
-- `puedo_ver_archivo` en las salas.

create or replace function connectalive.vi_tablero(p_codigo text)
returns boolean language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select exists (select 1 from connectalive.tablero_vistas v
                  where v.user_id = auth.uid() and v.codigo = p_codigo);
$$;

revoke all on function connectalive.vi_tablero(text) from public, anon;
grant execute on function connectalive.vi_tablero(text) to authenticated, service_role;

alter policy "connectalive_libres_leer" on storage.objects
  using (
    bucket_id = 'connectalive' and objects.name like 'libres/%'
    and (split_part(objects.name, '/', 2) = auth.uid()::text
         or connectalive.vi_tablero(split_part(objects.name, '/', 3)))
  );
