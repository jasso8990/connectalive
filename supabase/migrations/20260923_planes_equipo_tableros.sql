-- ============================================================
-- 2026-09-23 · Planes con equipo, medición de minutos, pizarra y
-- presentación gratis, y arreglos de seguridad de la sala.
-- ------------------------------------------------------------
-- Esta migración SÓLO AGREGA: el código publicado antes de hoy sigue
-- funcionando con ella puesta. Lo que CIERRA vías viejas (insertar o
-- editar tu propio renglón de `participantes`) vive aparte en
-- 20260923b_cerrar_participantes.sql y va DESPUÉS del push.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PLANES: nombres de cara al cliente y tope de maestros
-- ------------------------------------------------------------
-- Los slugs (clase/grupo/escuela) NO cambian: las Edge Functions de Stripe
-- los mapean contra los secrets Connect_Price_*.
alter table connectalive.planes
  add column if not exists max_maestros int not null default 1,
  add column if not exists descripcion text;

update connectalive.planes set nombre = 'Básico', max_maestros = 1,
  descripcion = 'Una sola persona da las clases o talleres.'
where slug = 'clase';
update connectalive.planes set nombre = 'Premium', max_maestros = 5,
  descripcion = 'Tú y hasta 4 maestros o instructores más.'
where slug = 'grupo';
update connectalive.planes set nombre = 'Institucional', max_maestros = 30,
  descripcion = 'Para escuelas y empresas: tú y hasta 29 maestros, instructores o supervisores.'
where slug = 'escuela';


-- ------------------------------------------------------------
-- 2. EQUIPO: maestros que da de alta el titular del plan
-- ------------------------------------------------------------
-- El titular es el renglón de `autorizados` (quien paga). Da de alta
-- maestros por CORREO: si la persona ya tiene cuenta, entra hoy; si no,
-- en cuanto se registre con ese correo. `max_maestros` cuenta al titular,
-- así que el plan Básico (1) no admite a nadie más.
create table if not exists connectalive.maestros (
  id uuid primary key default gen_random_uuid(),
  titular_id uuid not null references connectalive.autorizados(user_id) on delete cascade,
  correo text not null,
  nombre text,
  creado_en timestamptz not null default now()
);
create unique index if not exists maestros_titular_correo
  on connectalive.maestros (titular_id, lower(correo));
create index if not exists maestros_correo on connectalive.maestros (lower(correo));

-- RLS prendido y sin políticas: todo pasa por las funciones de abajo.
alter table connectalive.maestros enable row level security;

create or replace function connectalive.mi_correo()
returns text language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select lower(email) from auth.users where id = auth.uid();
$$;

create or replace function connectalive.plan_vigente(p_titular uuid)
returns boolean language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select exists (
    select 1 from connectalive.autorizados a
    where a.user_id = p_titular and a.plan_slug is not null
      and (a.vence_en is null or a.vence_en > now())
  );
$$;

-- Maestros que caben en el plan: los primeros (max_maestros - 1) por fecha
-- de alta. Si el titular baja de plan, los últimos quedan en pausa en vez
-- de borrarse.
create or replace function connectalive.maestros_activos(p_titular uuid)
returns setof connectalive.maestros language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select m.id, m.titular_id, m.correo, m.nombre, m.creado_en from (
    select m.*, row_number() over (order by m.creado_en, m.id) as n
    from connectalive.maestros m where m.titular_id = p_titular
  ) m
  join connectalive.autorizados a on a.user_id = p_titular
  join connectalive.planes p on p.slug = a.plan_slug
  where m.n <= p.max_maestros - 1;
$$;

-- La cuenta (titular) con la que el usuario actual da clases: la suya si
-- tiene plan vigente; si no, la del primer titular que lo tenga de maestro.
create or replace function connectalive.mi_cuenta()
returns uuid language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select coalesce(
    (select auth.uid() where connectalive.plan_vigente(auth.uid())),
    (select m.titular_id
       from connectalive.maestros m
      where lower(m.correo) = connectalive.mi_correo()
        and connectalive.plan_vigente(m.titular_id)
        and m.id in (select id from connectalive.maestros_activos(m.titular_id))
      order by m.creado_en
      limit 1)
  );
$$;

create or replace function connectalive.puede_crear_sala()
returns boolean language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select auth.uid() is not null and connectalive.mi_cuenta() is not null;
$$;


-- ------------------------------------------------------------
-- 3. SALAS: se amarran a la cuenta que paga
-- ------------------------------------------------------------
alter table connectalive.salas
  add column if not exists cuenta_id uuid references connectalive.autorizados(user_id) on delete set null;
create index if not exists salas_cuenta_idx on connectalive.salas(cuenta_id);

-- Salas viejas: la cuenta es el propio dirigente (hoy sólo las de Juan).
update connectalive.salas s set cuenta_id = s.dirigente_id
where s.cuenta_id is null
  and exists (select 1 from connectalive.autorizados a where a.user_id = s.dirigente_id);

-- Al crear: la cuenta la pone la base, no el navegador.
create or replace function connectalive.salas_al_crear()
returns trigger language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  new.cuenta_id := connectalive.mi_cuenta();
  return new;
end $$;
drop trigger if exists salas_al_crear on connectalive.salas;
create trigger salas_al_crear before insert on connectalive.salas
  for each row execute function connectalive.salas_al_crear();

-- El dirigente entra como participante en el mismo acto (antes lo hacía
-- el navegador en un segundo paso que podía fallar a medias).
create or replace function connectalive.salas_dirigente_participa()
returns trigger language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  insert into connectalive.participantes (sala_id, user_id, nombre_mostrar, rol)
  select new.id, new.dirigente_id,
         coalesce(nullif(u.raw_user_meta_data->>'nombre_mostrar', ''),
                  split_part(u.email, '@', 1), 'Dirigente'),
         'dirigente'
  from auth.users u where u.id = new.dirigente_id
  on conflict (sala_id, user_id) do nothing;
  return new;
end $$;
drop trigger if exists salas_dirigente_participa on connectalive.salas;
create trigger salas_dirigente_participa after insert on connectalive.salas
  for each row execute function connectalive.salas_dirigente_participa();

-- Lo que el dirigente NO puede cambiar desde el navegador: de quién es la
-- sala, qué cuenta paga y los códigos.
create or replace function connectalive.salas_proteger()
returns trigger language plpgsql
set search_path to 'connectalive', 'pg_temp' as $$
begin
  new.dirigente_id := old.dirigente_id;
  new.cuenta_id := old.cuenta_id;
  new.codigo := old.codigo;
  new.codigo_alumnos := old.codigo_alumnos;
  new.creada_en := old.creada_en;
  return new;
end $$;
drop trigger if exists salas_proteger on connectalive.salas;
create trigger salas_proteger before update on connectalive.salas
  for each row execute function connectalive.salas_proteger();

-- Realtime de `salas`: sin esto NADIE veía abrir la pizarra, cambiar de
-- diapositiva ni cerrar la clase (sólo quien hacía el cambio).
do $$
begin
  perform 1 from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'connectalive' and tablename = 'salas';
  if not found then
    alter publication supabase_realtime add table connectalive.salas;
  end if;
end $$;


-- ------------------------------------------------------------
-- 4. PARTICIPANTES: entrar y salir por función
-- ------------------------------------------------------------
-- `rol_fijado`: el dirigente decidió el rol a mano. Si bajó a oyente a un
-- colado, volver a abrir el enlace de alumnos ya no lo sube.
alter table connectalive.participantes
  add column if not exists rol_fijado boolean not null default false,
  add column if not exists ultimo_latido timestamptz;

-- Nadie se vuelve dirigente ni deja de serlo por un UPDATE/INSERT.
create or replace function connectalive.participantes_proteger()
returns trigger language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare dueno uuid;
begin
  select dirigente_id into dueno from connectalive.salas where id = new.sala_id;
  if tg_op = 'INSERT' then
    if new.rol = 'dirigente' and new.user_id is distinct from dueno then
      raise exception 'Sólo quien creó la sala es dirigente' using errcode = '42501';
    end if;
  else
    new.sala_id := old.sala_id;
    new.user_id := old.user_id;
    if (new.rol = 'dirigente') <> (old.rol = 'dirigente') then
      raise exception 'El papel de dirigente no se cambia' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists participantes_proteger on connectalive.participantes;
create trigger participantes_proteger before insert or update on connectalive.participantes
  for each row execute function connectalive.participantes_proteger();

-- Entrar con cualquiera de los dos códigos. El rol lo decide la base.
create or replace function connectalive.unirse_a_sala(p_codigo text, p_nombre text default null)
returns jsonb language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare s connectalive.salas; rol_nuevo text; p connectalive.participantes; nombre_final text;
begin
  if auth.uid() is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '42501';
  end if;
  select * into s from connectalive.salas
   where codigo = upper(btrim(p_codigo)) or codigo_alumnos = upper(btrim(p_codigo)) limit 1;
  if s.id is null then raise exception 'Ese código no existe. Revisa las letras.'; end if;
  if s.cerrada_en is not null then raise exception 'Esta clase ya terminó.'; end if;

  if s.dirigente_id = auth.uid() then
    rol_nuevo := 'dirigente';
  elsif s.codigo_alumnos = upper(btrim(p_codigo)) then
    rol_nuevo := 'alumno';
  else
    rol_nuevo := 'oyente';
  end if;

  select * into p from connectalive.participantes where sala_id = s.id and user_id = auth.uid();

  if p.id is null then
    if rol_nuevo = 'oyente' and not s.abierta_a_oyentes then
      raise exception 'Esta clase es sólo para alumnos con código.';
    end if;
    select coalesce(nullif(btrim(p_nombre), ''),
                    nullif(u.raw_user_meta_data->>'nombre_mostrar', ''),
                    split_part(u.email, '@', 1))
      into nombre_final from auth.users u where u.id = auth.uid();
    insert into connectalive.participantes (sala_id, user_id, nombre_mostrar, rol)
    values (s.id, auth.uid(), left(nombre_final, 60), rol_nuevo)
    returning * into p;
  else
    update connectalive.participantes
       set salido_en = null,
           rol = case when p.rol = 'oyente' and rol_nuevo = 'alumno' and not p.rol_fijado
                      then 'alumno' else p.rol end
     where id = p.id
    returning * into p;
  end if;

  return jsonb_build_object('sala_id', s.id, 'participante_id', p.id, 'rol', p.rol);
end $$;

-- Salir; el dirigente además puede terminar la clase para todos.
create or replace function connectalive.salir_de_sala(p_sala uuid, p_terminar boolean default false)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  update connectalive.participantes set salido_en = now()
   where sala_id = p_sala and user_id = auth.uid();
  if p_terminar and connectalive.es_dirigente_de(p_sala) then
    update connectalive.salas set cerrada_en = now(), pizarra_abierta = false
     where id = p_sala and cerrada_en is null;
  end if;
end $$;

create or replace function connectalive.mi_rol_en(p_sala uuid)
returns text language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select rol from connectalive.participantes where sala_id = p_sala and user_id = auth.uid();
$$;

create or replace function connectalive.mi_participante_en(p_sala uuid)
returns uuid language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select id from connectalive.participantes where sala_id = p_sala and user_id = auth.uid();
$$;


-- ------------------------------------------------------------
-- 5. MINUTOS: medir el uso y cortar al pasarse
-- ------------------------------------------------------------
-- Cada navegador conectado a LiveKit manda un latido por minuto. Cuenta
-- como mucho uno cada 55 s por participante. El total por mes y cuenta es
-- lo que `token.js` compara contra `planes.minutos_participante_mes`.
create table if not exists connectalive.uso_minutos (
  cuenta_id uuid not null references connectalive.autorizados(user_id) on delete cascade,
  mes date not null,
  dirigente_id uuid not null,
  minutos int not null default 0,
  primary key (cuenta_id, mes, dirigente_id)
);
alter table connectalive.uso_minutos enable row level security;

create or replace function connectalive.latido(p_sala uuid)
returns jsonb language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare s connectalive.salas; p connectalive.participantes;
begin
  select * into s from connectalive.salas where id = p_sala;
  if s.id is null or s.cerrada_en is not null then
    return jsonb_build_object('ok', false, 'cerrada', true);
  end if;
  select * into p from connectalive.participantes where sala_id = p_sala and user_id = auth.uid();
  if p.id is null then return jsonb_build_object('ok', false); end if;
  if p.ultimo_latido is not null and p.ultimo_latido > now() - interval '55 seconds' then
    return jsonb_build_object('ok', true, 'contado', false);
  end if;
  update connectalive.participantes set ultimo_latido = now() where id = p.id;
  if s.cuenta_id is not null then
    insert into connectalive.uso_minutos (cuenta_id, mes, dirigente_id, minutos)
    values (s.cuenta_id, date_trunc('month', now())::date, s.dirigente_id, 1)
    on conflict (cuenta_id, mes, dirigente_id) do update set minutos = uso_minutos.minutos + 1;
  end if;
  return jsonb_build_object('ok', true, 'contado', true);
end $$;

-- Para token.js (service_role): ¿se puede entrar a esta sala hoy?
create or replace function connectalive.sala_puede_transmitir(p_sala uuid)
returns jsonb language plpgsql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare s connectalive.salas; tope int; usados int;
begin
  select * into s from connectalive.salas where id = p_sala;
  if s.id is null then return jsonb_build_object('ok', false, 'motivo', 'La sala no existe'); end if;
  if s.cerrada_en is not null then return jsonb_build_object('ok', false, 'motivo', 'Esta clase ya terminó'); end if;
  if s.cuenta_id is null or not connectalive.plan_vigente(s.cuenta_id) then
    return jsonb_build_object('ok', false, 'motivo', 'El plan de quien dirige esta clase no está vigente');
  end if;
  select p.minutos_participante_mes into tope
    from connectalive.autorizados a join connectalive.planes p on p.slug = a.plan_slug
   where a.user_id = s.cuenta_id;
  select coalesce(sum(minutos), 0) into usados from connectalive.uso_minutos
   where cuenta_id = s.cuenta_id and mes = date_trunc('month', now())::date;
  if usados >= tope then
    return jsonb_build_object('ok', false, 'motivo',
      'Esta cuenta ya usó sus minutos del mes. Quien la contrató puede subir de plan.');
  end if;
  return jsonb_build_object('ok', true, 'restantes', tope - usados);
end $$;


-- ------------------------------------------------------------
-- 6. PANEL: resumen del plan, uso y equipo
-- ------------------------------------------------------------
create or replace function connectalive.panel_resumen()
returns jsonb language plpgsql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare a connectalive.autorizados; pl connectalive.planes; v_mes date := date_trunc('month', now())::date;
        titular jsonb := null; yo uuid := auth.uid();
begin
  if yo is null then raise exception 'Hace falta iniciar sesión' using errcode = '42501'; end if;

  select * into a from connectalive.autorizados where user_id = yo;
  if a.user_id is not null and a.plan_slug is not null then
    select * into pl from connectalive.planes where slug = a.plan_slug;
    titular := jsonb_build_object(
      'plan_slug', pl.slug, 'plan_nombre', pl.nombre, 'precio_usd', pl.precio_usd,
      'max_maestros', pl.max_maestros, 'minutos_mes', pl.minutos_participante_mes,
      'vence_en', a.vence_en, 'vigente', connectalive.plan_vigente(yo),
      'con_stripe', a.stripe_customer_id is not null,
      'uso_mes', coalesce((select sum(minutos) from connectalive.uso_minutos
                            where cuenta_id = yo and mes = v_mes), 0),
      'uso_por_dirigente', coalesce((
        select jsonb_agg(jsonb_build_object('correo', u.email, 'minutos', um.minutos) order by um.minutos desc)
          from connectalive.uso_minutos um left join auth.users u on u.id = um.dirigente_id
         where um.cuenta_id = yo and um.mes = v_mes), '[]'::jsonb),
      'maestros', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', m.id, 'correo', m.correo, 'nombre', m.nombre, 'creado_en', m.creado_en,
                 'tiene_cuenta', exists (select 1 from auth.users u where lower(u.email) = lower(m.correo)),
                 'activo', m.id in (select id from connectalive.maestros_activos(yo)))
               order by m.creado_en)
          from connectalive.maestros m where m.titular_id = yo), '[]'::jsonb)
    );
  end if;

  return jsonb_build_object(
    'correo', connectalive.mi_correo(),
    'puede_crear', connectalive.puede_crear_sala(),
    'titular', titular,
    'maestro_de', coalesce((
      select jsonb_agg(jsonb_build_object(
               'titular_correo', u.email, 'plan_nombre', p.nombre,
               'vigente', connectalive.plan_vigente(m.titular_id),
               'activo', m.id in (select id from connectalive.maestros_activos(m.titular_id))))
        from connectalive.maestros m
        join auth.users u on u.id = m.titular_id
        join connectalive.autorizados au on au.user_id = m.titular_id
        left join connectalive.planes p on p.slug = au.plan_slug
       where lower(m.correo) = connectalive.mi_correo() and m.titular_id <> yo), '[]'::jsonb)
  );
end $$;

create or replace function connectalive.equipo_agregar(p_correo text, p_nombre text default null)
returns jsonb language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare pl connectalive.planes; correo_limpio text; ya int;
begin
  if not connectalive.plan_vigente(auth.uid()) then
    raise exception 'Necesitas un plan vigente para agregar maestros' using errcode = '42501';
  end if;
  select p.* into pl from connectalive.autorizados a join connectalive.planes p on p.slug = a.plan_slug
   where a.user_id = auth.uid();
  if pl.max_maestros <= 1 then
    raise exception 'El plan % es para una sola persona. Cambia a Premium o Institucional para agregar maestros.', pl.nombre;
  end if;

  correo_limpio := lower(btrim(coalesce(p_correo, '')));
  if correo_limpio !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Ese correo no se ve bien escrito';
  end if;
  if correo_limpio = connectalive.mi_correo() then
    raise exception 'Tú ya cuentas como el primer maestro de tu plan';
  end if;

  select count(*) into ya from connectalive.maestros where titular_id = auth.uid();
  if ya >= pl.max_maestros - 1
     and not exists (select 1 from connectalive.maestros
                      where titular_id = auth.uid() and lower(correo) = correo_limpio) then
    raise exception 'Tu plan % permite % maestros contándote a ti. Quita a alguien o sube de plan.',
      pl.nombre, pl.max_maestros;
  end if;

  insert into connectalive.maestros (titular_id, correo, nombre)
  values (auth.uid(), correo_limpio, nullif(btrim(coalesce(p_nombre, '')), ''))
  on conflict (titular_id, lower(correo)) do update
    set nombre = coalesce(excluded.nombre, connectalive.maestros.nombre);

  return jsonb_build_object('ok', true, 'correo', correo_limpio,
    'tiene_cuenta', exists (select 1 from auth.users where lower(email) = correo_limpio));
end $$;

create or replace function connectalive.equipo_quitar(p_id uuid)
returns void language sql security definer
set search_path to 'connectalive', 'pg_temp' as $$
  delete from connectalive.maestros where id = p_id and titular_id = auth.uid();
$$;


-- ------------------------------------------------------------
-- 7. PIZARRA Y DIAPOSITIVAS DENTRO DE LA SALA
-- ------------------------------------------------------------
-- Los trazos de la pizarra de la sala se guardan (en vectores, no en PNG)
-- para que quien llega tarde la vea completa. El vivo viaja por broadcast.
create table if not exists connectalive.sala_pizarras (
  sala_id uuid primary key references connectalive.salas(id) on delete cascade,
  trazos jsonb not null default '[]'::jsonb,
  actualizado_en timestamptz not null default now()
);
alter table connectalive.sala_pizarras enable row level security;
drop policy if exists sala_pizarras_leer on connectalive.sala_pizarras;
create policy sala_pizarras_leer on connectalive.sala_pizarras
  for select using (connectalive.es_participante_de(sala_id));

create or replace function connectalive.sala_pizarra_guardar(p_sala uuid, p_trazos jsonb)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  if not (connectalive.es_dirigente_de(p_sala)
          or exists (select 1 from connectalive.salas s
                      where s.id = p_sala
                        and s.pizarra_controlador_id = connectalive.mi_participante_en(p_sala))) then
    raise exception 'No tienes el control de la pizarra' using errcode = '42501';
  end if;
  if length(p_trazos::text) > 900000 then
    raise exception 'La pizarra está llena. Bórrala para seguir.';
  end if;
  insert into connectalive.sala_pizarras (sala_id, trazos, actualizado_en)
  values (p_sala, p_trazos, now())
  on conflict (sala_id) do update set trazos = excluded.trazos, actualizado_en = now();
end $$;

-- Cambiar de diapositiva: el presentador puede ser un alumno, y la política
-- de UPDATE de `salas` sólo deja al dirigente. Antes el alumno "cambiaba"
-- y no pasaba nada.
create or replace function connectalive.sala_ir_a_pagina(p_sala uuid, p_pagina int)
returns void language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  if not (connectalive.es_dirigente_de(p_sala)
          or exists (select 1 from connectalive.salas s
                      where s.id = p_sala
                        and s.presentacion_presentador_id = connectalive.mi_participante_en(p_sala))) then
    raise exception 'No estás presentando' using errcode = '42501';
  end if;
  update connectalive.salas
     set presentacion_pagina_actual = greatest(1, least(p_pagina, coalesce(presentacion_paginas, 1)))
   where id = p_sala;
end $$;


-- ------------------------------------------------------------
-- 8. SOLICITUDES Y ARCHIVOS: huecos de permisos
-- ------------------------------------------------------------
-- Pedir sólo en TU sala y sólo como pendiente.
drop policy if exists sol_crear on connectalive.solicitudes;
create policy sol_crear on connectalive.solicitudes
  for insert with check (
    estado = 'pendiente'
    and exists (select 1 from connectalive.participantes p
                 where p.id = solicitudes.participante_id
                   and p.user_id = auth.uid()
                   and p.sala_id = solicitudes.sala_id)
  );

-- Bajar tu propia mano (antes sólo el dirigente podía y el botón no hacía nada).
drop policy if exists sol_revocar_propia on connectalive.solicitudes;
create policy sol_revocar_propia on connectalive.solicitudes
  for update using (
    exists (select 1 from connectalive.participantes p
             where p.id = solicitudes.participante_id and p.user_id = auth.uid())
  ) with check (estado = 'revocada');

-- ¿Puedo ver este archivo? El dirigente todo; el remitente lo suyo; los
-- demás sólo lo aprobado para ellos. Antes cualquier oyente leía los
-- archivos sin aprobar (y los podía descargar de Storage).
create or replace function connectalive.puedo_ver_archivo(p_sala uuid, p_remitente uuid, p_aprobado boolean, p_dest text)
returns boolean language sql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
  select connectalive.es_dirigente_de(p_sala)
      or p_remitente = connectalive.mi_participante_en(p_sala)
      or (p_aprobado and (p_dest = 'todos'
                          or (p_dest = 'alumnos' and connectalive.mi_rol_en(p_sala) = 'alumno')));
$$;

drop policy if exists arch_leer on connectalive.archivos;
create policy arch_leer on connectalive.archivos
  for select using (connectalive.puedo_ver_archivo(sala_id, remitente_id, aprobado, destinatarios));

-- Quien no es dirigente sólo manda archivos SIN aprobar (antes se podía
-- insertar ya aprobado para "todos" y saltarse al dirigente).
drop policy if exists arch_crear on connectalive.archivos;
create policy arch_crear on connectalive.archivos
  for insert with check (
    exists (select 1 from connectalive.participantes p
             where p.id = archivos.remitente_id and p.user_id = auth.uid()
               and p.sala_id = archivos.sala_id)
    and (connectalive.es_dirigente_de(sala_id) or (aprobado = false and aprobado_por is null))
  );

-- Descartar un archivo (antes no había política ni GRANT de DELETE: el
-- botón borraba el binario pero el renglón se quedaba).
grant delete on connectalive.archivos to authenticated;
drop policy if exists arch_borrar_dirigente on connectalive.archivos;
create policy arch_borrar_dirigente on connectalive.archivos
  for delete using (connectalive.es_dirigente_de(sala_id));

-- Storage: el binario de un archivo de la sala se lee con la misma regla
-- que su renglón. Las presentaciones siguen abiertas a toda la sala.
drop policy if exists "connectalive_leer" on storage.objects;
create policy "connectalive_leer" on storage.objects
  for select using (
    bucket_id = 'connectalive'
    and objects.name not like 'presentaciones/%'
    and objects.name not like 'libres/%'
    and (
      exists (select 1 from connectalive.salas s
               where s.dirigente_id = auth.uid()
                 and split_part(objects.name, '/', 1) = s.id::text)
      or exists (select 1 from connectalive.archivos a
                  where a.storage_path = objects.name
                    and connectalive.puedo_ver_archivo(a.sala_id, a.remitente_id, a.aprobado, a.destinatarios))
    )
  );


-- ------------------------------------------------------------
-- 9. PIZARRA Y PRESENTACIÓN LIBRES (gratis, sin sala)
-- ------------------------------------------------------------
-- Lo que hacía Pizarra en Vivo: escribir en la tableta y proyectar en la
-- PC; o proyectar un PDF en la PC y controlarlo desde el celular. No usa
-- LiveKit, así que no cuesta: cualquiera con cuenta lo usa.
create table if not exists connectalive.tableros (
  codigo text primary key check (codigo ~ '^[A-Z0-9]{6}$'),
  tipo text not null check (tipo in ('pizarra','presentacion')),
  dueno_id uuid not null references auth.users(id) on delete cascade,
  trazos jsonb not null default '[]'::jsonb,
  pagina int not null default 1,
  paginas int,
  zoom int not null default 100,
  pan_x int not null default 0,
  pan_y int not null default 0,
  pdf_path text,
  pdf_nombre text,
  control_token uuid,
  control_visto timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists tableros_dueno on connectalive.tableros(dueno_id);
alter table connectalive.tableros enable row level security;

-- Quién ha abierto cada tablero: el PDF de una presentación sólo lo lee
-- quien ya se sabe el código (así, listar el bucket no revela nada).
create table if not exists connectalive.tablero_vistas (
  codigo text not null references connectalive.tableros(codigo) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (codigo, user_id)
);
alter table connectalive.tablero_vistas enable row level security;

create or replace function connectalive.tablero_publico(t connectalive.tableros)
returns jsonb language sql stable
set search_path to 'connectalive', 'pg_temp' as $$
  select jsonb_build_object(
    'codigo', t.codigo, 'tipo', t.tipo, 'trazos', t.trazos,
    'pagina', t.pagina, 'paginas', t.paginas,
    'zoom', t.zoom, 'pan_x', t.pan_x, 'pan_y', t.pan_y,
    'pdf_path', t.pdf_path, 'pdf_nombre', t.pdf_nombre,
    'soy_dueno', t.dueno_id = auth.uid(),
    'controlado', t.control_token is not null and t.control_visto > now() - interval '2 minutes'
  );
$$;

create or replace function connectalive.tablero_crear(p_tipo text, p_pdf_nombre text default null)
returns jsonb language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; i int; viejos jsonb; t connectalive.tableros;
begin
  if auth.uid() is null then raise exception 'Hace falta iniciar sesión' using errcode = '42501'; end if;
  if p_tipo not in ('pizarra','presentacion') then raise exception 'Tipo inválido'; end if;

  -- Limpieza: los tableros propios de más de 2 días se van. Se devuelven
  -- sus PDF para que el navegador los borre de Storage.
  select coalesce(jsonb_agg(pdf_path) filter (where pdf_path is not null), '[]'::jsonb) into viejos
    from connectalive.tableros where dueno_id = auth.uid() and actualizado_en < now() - interval '2 days';
  delete from connectalive.tableros where dueno_id = auth.uid() and actualizado_en < now() - interval '2 days';

  for intento in 1..20 loop
    c := '';
    for i in 1..6 loop c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    begin
      insert into connectalive.tableros (codigo, tipo, dueno_id, pdf_nombre)
      values (c, p_tipo, auth.uid(), left(p_pdf_nombre, 200)) returning * into t;
      exit;
    exception when unique_violation then c := null;
    end;
  end loop;
  if c is null then raise exception 'No se pudo generar un código, intenta otra vez'; end if;

  insert into connectalive.tablero_vistas (codigo, user_id) values (c, auth.uid()) on conflict do nothing;
  return connectalive.tablero_publico(t) || jsonb_build_object('pdfs_viejos', viejos);
end $$;

create or replace function connectalive.tablero_leer(p_codigo text)
returns jsonb language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
declare t connectalive.tableros;
begin
  if auth.uid() is null then raise exception 'Hace falta iniciar sesión' using errcode = '42501'; end if;
  select * into t from connectalive.tableros where codigo = upper(btrim(p_codigo));
  if t.codigo is null then raise exception 'Ese código no existe o ya se cerró.'; end if;
  insert into connectalive.tablero_vistas (codigo, user_id) values (t.codigo, auth.uid()) on conflict do nothing;
  return connectalive.tablero_publico(t);
end $$;

-- Tomar el control (escribir en la pizarra o mover la presentación). Sólo
-- la cuenta dueña: el código se proyecta frente a todos y no se quiere que
-- alguien del público lo agarre. Un dispositivo a la vez; si el otro dejó
-- de latir 2 minutos, o se fuerza, se lo quita.
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
  if t.control_token is not null and t.control_visto > now() - interval '2 minutes'
     and p_token is distinct from t.control_token and not p_forzar then
    raise exception 'OCUPADO: esta sesión ya se está controlando desde otro dispositivo.';
  end if;
  nuevo := case when p_token is not null and p_token = t.control_token then p_token else gen_random_uuid() end;
  update connectalive.tableros set control_token = nuevo, control_visto = now() where codigo = t.codigo;
  return nuevo;
end $$;

create or replace function connectalive.tablero_latido(p_codigo text, p_token uuid)
returns boolean language plpgsql security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  update connectalive.tableros set control_visto = now()
   where codigo = upper(btrim(p_codigo)) and control_token = p_token;
  return found;
end $$;

-- Guardar. Lo que venga en null se deja como estaba. Vale con el token de
-- control, o siendo el dueño cuando nadie más controla (la PC que proyecta
-- la presentación puede cambiar de página con el teclado).
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
              and (t.control_token is null or t.control_visto < now() - interval '2 minutes'))) then
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

create or replace function connectalive.tablero_cerrar(p_codigo text)
returns void language sql security definer
set search_path to 'connectalive', 'pg_temp' as $$
  delete from connectalive.tableros where codigo = upper(btrim(p_codigo)) and dueno_id = auth.uid();
$$;

-- Storage de los PDF libres: libres/<dueño>/<código>/<archivo>.pdf
drop policy if exists "connectalive_libres_subir" on storage.objects;
create policy "connectalive_libres_subir" on storage.objects
  for insert with check (
    bucket_id = 'connectalive' and objects.name like 'libres/%'
    and split_part(objects.name, '/', 2) = auth.uid()::text
  );
drop policy if exists "connectalive_libres_borrar" on storage.objects;
create policy "connectalive_libres_borrar" on storage.objects
  for delete using (
    bucket_id = 'connectalive' and objects.name like 'libres/%'
    and split_part(objects.name, '/', 2) = auth.uid()::text
  );
drop policy if exists "connectalive_libres_leer" on storage.objects;
create policy "connectalive_libres_leer" on storage.objects
  for select using (
    bucket_id = 'connectalive' and objects.name like 'libres/%'
    and (split_part(objects.name, '/', 2) = auth.uid()::text
         or exists (select 1 from connectalive.tablero_vistas v
                     where v.user_id = auth.uid() and v.codigo = split_part(objects.name, '/', 3)))
  );


-- ------------------------------------------------------------
-- 10. PERMISOS DE EJECUCIÓN
-- ------------------------------------------------------------
-- EXECUTE se hereda de PUBLIC: se quita de ahí y se da sólo a quien toca.
do $$
declare f text;
begin
  foreach f in array array[
    'connectalive.mi_correo()',
    'connectalive.plan_vigente(uuid)',
    'connectalive.maestros_activos(uuid)',
    'connectalive.mi_cuenta()',
    'connectalive.puede_crear_sala()',
    'connectalive.unirse_a_sala(text, text)',
    'connectalive.salir_de_sala(uuid, boolean)',
    'connectalive.mi_rol_en(uuid)',
    'connectalive.mi_participante_en(uuid)',
    'connectalive.latido(uuid)',
    'connectalive.panel_resumen()',
    'connectalive.equipo_agregar(text, text)',
    'connectalive.equipo_quitar(uuid)',
    'connectalive.sala_pizarra_guardar(uuid, jsonb)',
    'connectalive.sala_ir_a_pagina(uuid, int)',
    'connectalive.puedo_ver_archivo(uuid, uuid, boolean, text)',
    'connectalive.tablero_crear(text, text)',
    'connectalive.tablero_leer(text)',
    'connectalive.tablero_tomar_control(text, uuid, boolean)',
    'connectalive.tablero_latido(text, uuid)',
    'connectalive.tablero_guardar(text, uuid, jsonb, int, int, int, int, int, text)',
    'connectalive.tablero_cerrar(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- Sólo el servidor (token.js) pregunta si una sala puede transmitir.
revoke all on function connectalive.sala_puede_transmitir(uuid) from public, anon, authenticated;
grant execute on function connectalive.sala_puede_transmitir(uuid) to service_role;

-- Las funciones de trigger no se llaman a mano.
revoke all on function connectalive.salas_al_crear() from public, anon, authenticated;
revoke all on function connectalive.salas_dirigente_participa() from public, anon, authenticated;
revoke all on function connectalive.participantes_proteger() from public, anon, authenticated;
revoke all on function connectalive.salas_proteger() from public, anon, authenticated;

grant select on connectalive.sala_pizarras to authenticated;
grant all on connectalive.maestros, connectalive.uso_minutos, connectalive.sala_pizarras,
             connectalive.tableros, connectalive.tablero_vistas to service_role;
