-- Presentación libre: pasarle el control a OTRA cuenta.
--
-- Antes sólo la cuenta que abrió la presentación podía controlarla, así que
-- «Liberar control» sólo servía entre celulares de esa misma cuenta.
--
-- Ahora el celular de otra cuenta entra con el código y PIDE el control
-- (`tablero_pedir_control`). La PC dueña ve quién lo pide y decide
-- (`tablero_responder_pedido`). Si acepta, esa cuenta queda como
-- `delegado_id`, se suelta el control que hubiera y el delegado entra.
--   • No basta tener el código: se proyecta frente a todos.
--   • «Liberar control» desde la PC (cuenta dueña) quita también al delegado:
--     para volver a controlar tendrá que pedirlo otra vez.
--   • Si el delegado toca «Dejar el control», deja de ser delegado.
--   • Sólo en la PRESENTACIÓN; la pizarra sigue siendo de la cuenta dueña.

alter table connectalive.tableros
  add column if not exists delegado_id uuid references auth.users(id) on delete set null,
  add column if not exists delegado_nombre text,
  add column if not exists pedido_id uuid references auth.users(id) on delete set null,
  add column if not exists pedido_nombre text,
  add column if not exists pedido_en timestamptz;

create or replace function connectalive.tablero_publico(t connectalive.tableros)
returns jsonb language sql stable
set search_path to 'connectalive', 'pg_temp' as $$
  select jsonb_build_object(
    'codigo', t.codigo, 'tipo', t.tipo, 'trazos', t.trazos,
    'pagina', t.pagina, 'paginas', t.paginas,
    'zoom', t.zoom, 'pan_x', t.pan_x, 'pan_y', t.pan_y,
    'pdf_path', t.pdf_path, 'pdf_nombre', t.pdf_nombre,
    'soy_dueno', t.dueno_id = auth.uid(),
    'soy_delegado', t.delegado_id is not null and t.delegado_id = auth.uid(),
    'controlado', t.control_token is not null and t.control_visto > now() - interval '3 hours',
    -- Sólo la cuenta dueña ve quién pide el control (vence a los 10 min).
    'pedido', case when t.dueno_id = auth.uid() and t.pedido_id is not null
                    and t.pedido_en > now() - interval '10 minutes'
               then jsonb_build_object('id', t.pedido_id, 'nombre', t.pedido_nombre) end,
    'delegado_nombre', case when t.dueno_id = auth.uid() then t.delegado_nombre end
  );
$$;

create or replace function connectalive.tablero_tomar_control(p_codigo text, p_token uuid default null, p_forzar boolean default false)
returns uuid language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros; nuevo uuid;
begin
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo)) for update;
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  if auth.uid() is distinct from t.dueno_id
     and not (t.tipo = 'presentacion' and t.delegado_id is not null and t.delegado_id = auth.uid()) then
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

-- Soltar: el dispositivo que lo tiene (con su token) o la cuenta dueña. Si
-- suelta la dueña o el propio delegado, el delegado deja de serlo.
create or replace function connectalive.tablero_soltar_control(p_codigo text, p_token uuid default null)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  update connectalive.tableros set
    control_token = null, control_visto = null,
    delegado_id = case when dueno_id = auth.uid() or delegado_id = auth.uid() then null else delegado_id end,
    delegado_nombre = case when dueno_id = auth.uid() or delegado_id = auth.uid() then null else delegado_nombre end
   where codigo = upper(btrim(p_codigo))
     and ((p_token is not null and control_token = p_token) or dueno_id = auth.uid());
end $$;

-- Otra cuenta pide el control. Un pedido nuevo pisa al anterior.
create or replace function connectalive.tablero_pedir_control(p_codigo text)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros; nombre text;
begin
  if auth.uid() is null then raise exception 'Hace falta iniciar sesión' using errcode = '42501'; end if;
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo));
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  if t.tipo <> 'presentacion' then raise exception 'Sólo se puede pedir el control de una presentación.'; end if;
  if t.dueno_id = auth.uid() or t.delegado_id = auth.uid() then return; end if;
  select coalesce(nullif(btrim(u.raw_user_meta_data->>'nombre_mostrar'), ''), split_part(u.email, '@', 1))
    into nombre from auth.users u where u.id = auth.uid();
  update connectalive.tableros
     set pedido_id = auth.uid(), pedido_nombre = left(coalesce(nombre, 'Alguien'), 60), pedido_en = now()
   where codigo = t.codigo;
end $$;

-- La cuenta dueña acepta o rechaza el pedido. Aceptar suelta el control que
-- hubiera para que el delegado entre.
create or replace function connectalive.tablero_responder_pedido(p_codigo text, p_user uuid, p_aceptar boolean)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros;
begin
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo)) for update;
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  if t.dueno_id is distinct from auth.uid() then
    raise exception 'Sólo la cuenta que abrió la presentación puede dar el control.' using errcode = '42501';
  end if;
  if t.pedido_id is distinct from p_user then
    raise exception 'Ese pedido ya no está vigente.';
  end if;
  if p_aceptar then
    update connectalive.tableros set
      delegado_id = t.pedido_id, delegado_nombre = t.pedido_nombre,
      control_token = null, control_visto = null,
      pedido_id = null, pedido_nombre = null, pedido_en = null
     where codigo = t.codigo;
  else
    update connectalive.tableros set pedido_id = null, pedido_nombre = null, pedido_en = null
     where codigo = t.codigo;
  end if;
end $$;

revoke all on function connectalive.tablero_pedir_control(text) from public, anon;
grant execute on function connectalive.tablero_pedir_control(text) to authenticated, service_role;
revoke all on function connectalive.tablero_responder_pedido(text, uuid, boolean) from public, anon;
grant execute on function connectalive.tablero_responder_pedido(text, uuid, boolean) to authenticated, service_role;
