-- Control exclusivo de la presentación libre (y de la pizarra).
--
-- Antes: el control vencía a los 2 minutos sin latido y otro dispositivo de
-- la misma cuenta podía quitarlo con «¿Controlarla desde aquí?». Pero un
-- celular con la pantalla apagada o la app en segundo plano deja de latir
-- (Android congela la pestaña), así que a media presentación el control se
-- caía o se lo llevaba otro.
--
-- Ahora:
--   • El control dura mientras el dispositivo que lo tiene no lo suelte
--     (`tablero_soltar_control`). Sólo vence tras 3 horas sin latido, para
--     que un celular perdido no deje la sesión trabada para siempre.
--   • En la PRESENTACIÓN nadie lo quita forzando: tiene que soltarse. La
--     PC que proyecta (cuenta dueña) puede soltarlo con «Liberar control».
--   • En la PIZARRA se conserva «Escribir desde aquí» (forzar), que es como
--   la PC que proyecta recupera el plumón.

create or replace function connectalive.tablero_publico(t connectalive.tableros)
returns jsonb language sql stable
set search_path to 'connectalive', 'pg_temp' as $$
  select jsonb_build_object(
    'codigo', t.codigo, 'tipo', t.tipo, 'trazos', t.trazos,
    'pagina', t.pagina, 'paginas', t.paginas,
    'zoom', t.zoom, 'pan_x', t.pan_x, 'pan_y', t.pan_y,
    'pdf_path', t.pdf_path, 'pdf_nombre', t.pdf_nombre,
    'soy_dueno', t.dueno_id = auth.uid(),
    'controlado', t.control_token is not null and t.control_visto > now() - interval '3 hours'
  );
$$;

create or replace function connectalive.tablero_tomar_control(p_codigo text, p_token uuid default null, p_forzar boolean default false)
returns uuid language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros; nuevo uuid;
begin
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo)) for update;
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  if t.dueno_id <> auth.uid() then
    raise exception 'Sólo la cuenta que abrió esta sesión puede controlarla. Entra con esa misma cuenta.'
      using errcode = '42501';
  end if;
  if t.control_token is not null and t.control_visto > now() - interval '3 hours'
     and p_token is distinct from t.control_token
     and not (p_forzar and t.tipo = 'pizarra') then
    raise exception 'OCUPADO: esta sesión ya se está controlando desde otro dispositivo.';
  end if;
  nuevo := case when p_token is not null and p_token = t.control_token then p_token else gen_random_uuid() end;
  update connectalive.tableros set control_token = nuevo, control_visto = now() where codigo = t.codigo;
  return nuevo;
end $$;

-- Soltar el control: lo hace el dispositivo que lo tiene (con su token) o
-- la cuenta dueña desde la PC que proyecta.
create or replace function connectalive.tablero_soltar_control(p_codigo text, p_token uuid default null)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  update connectalive.tableros set control_token = null, control_visto = null
   where codigo = upper(btrim(p_codigo))
     and ((p_token is not null and control_token = p_token) or dueno_id = auth.uid());
end $$;

create or replace function connectalive.tablero_guardar(
  p_codigo text, p_token uuid,
  p_trazos jsonb default null, p_pagina int default null, p_paginas int default null,
  p_zoom int default null, p_pan_x int default null, p_pan_y int default null,
  p_pdf_path text default null)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros;
begin
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo));
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  if not ((p_token is not null and p_token = t.control_token)
          or (t.dueno_id = auth.uid()
              and (t.control_token is null or t.control_visto < now() - interval '3 hours'))) then
    raise exception 'OCUPADO: otro dispositivo tiene el control.' using errcode = '42501';
  end if;
  if p_trazos is not null and length(p_trazos::text) > 900000 then
    raise exception 'La pizarra está llena. Bórrala para seguir.';
  end if;
  if p_pdf_path is not null and p_pdf_path not like 'libres/' || t.dueno_id::text || '/' || t.codigo || '/%' then
    raise exception 'Ruta de PDF inválida';
  end if;
  update connectalive.tableros set
    trazos  = coalesce(p_trazos, trazos),
    paginas = coalesce(p_paginas, paginas),
    pagina  = greatest(1, least(coalesce(p_pagina, pagina), coalesce(p_paginas, paginas, 9999))),
    zoom    = greatest(100, least(300, coalesce(p_zoom, zoom))),
    pan_x   = greatest(-40, least(40, coalesce(p_pan_x, pan_x))),
    pan_y   = greatest(-40, least(40, coalesce(p_pan_y, pan_y))),
    pdf_path = coalesce(p_pdf_path, pdf_path),
    actualizado_en = now()
  where codigo = t.codigo;
end $$;

-- El latido también mantiene vivo el tablero (la limpieza de 2 días mira
-- `actualizado_en`), así una presentación larga sin cambiar de página no
-- se toma por vieja.
create or replace function connectalive.tablero_latido(p_codigo text, p_token uuid)
returns boolean language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  update connectalive.tableros set control_visto = now(), actualizado_en = now()
   where codigo = upper(btrim(p_codigo)) and control_token = p_token;
  return found;
end $$;

revoke all on function connectalive.tablero_soltar_control(text, uuid) from public, anon;
grant execute on function connectalive.tablero_soltar_control(text, uuid) to authenticated, service_role;
