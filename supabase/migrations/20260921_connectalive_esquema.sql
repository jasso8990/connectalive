-- ConnectaLive — clase/taller en vivo con roles (dirigente, alumno, oyente).
-- Vive en su propio esquema para no chocar con Smartagent (public), Cancha
-- (cancha) ni SMRT-APP Market (articulos) en este mismo proyecto compartido.
--
-- Reglas de oro:
--  - El ROL nunca lo decide el navegador. El dirigente es quien creó la sala;
--    los demás entran como oyente por defecto y el dirigente los promueve.
--  - Sólo el dirigente aprueba solicitudes, cambia roles, deja pasar archivos
--    y elige a quién le llega cada material.
--  - RLS: nadie ve las salas donde no está; nadie inserta un participante que
--    no sea el suyo; nadie edita solicitudes/archivos ajenos.

create schema if not exists connectalive;

-- ----------------------------------------------------------------------------
-- SALAS
-- ----------------------------------------------------------------------------
create table if not exists connectalive.salas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null,
  nombre text not null,
  descripcion text,
  dirigente_id uuid not null references auth.users(id) on delete cascade,
  creada_en timestamptz not null default now(),
  cerrada_en timestamptz,
  -- Cuando está true, cualquiera con el código entra directo como oyente.
  -- Si es false, sólo entran los que el dirigente ya invitó/promovió.
  abierta_a_oyentes boolean not null default true
);
create index if not exists salas_dirigente_idx on connectalive.salas(dirigente_id);

-- ----------------------------------------------------------------------------
-- PARTICIPANTES
-- Un renglón por usuario en cada sala. El rol se guarda aquí; LiveKit sólo
-- refleja el permiso técnico (canPublish) que sale de este rol.
-- ----------------------------------------------------------------------------
create table if not exists connectalive.participantes (
  id uuid primary key default gen_random_uuid(),
  sala_id uuid not null references connectalive.salas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre_mostrar text not null,
  rol text not null default 'oyente' check (rol in ('dirigente','alumno','oyente')),
  -- Cuando el dirigente le da voz temporal a un oyente, esta marca se enciende.
  -- Al quitarle voz vuelve a false. Es el estado; el token de LiveKit se rehace
  -- cuando esto cambia (netlify/functions/permiso.js).
  voz_activa boolean not null default false,
  unido_en timestamptz not null default now(),
  salido_en timestamptz,
  unique (sala_id, user_id)
);
create index if not exists part_sala_idx on connectalive.participantes(sala_id);

-- ----------------------------------------------------------------------------
-- SOLICITUDES
-- Mano alzada de oyentes, o petición de compartir pantalla/enviar archivo.
-- El dirigente las resuelve una por una.
-- ----------------------------------------------------------------------------
create table if not exists connectalive.solicitudes (
  id uuid primary key default gen_random_uuid(),
  sala_id uuid not null references connectalive.salas(id) on delete cascade,
  participante_id uuid not null references connectalive.participantes(id) on delete cascade,
  tipo text not null check (tipo in ('mano','compartir','archivo')),
  mensaje text,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','revocada')),
  creada_en timestamptz not null default now(),
  resuelta_en timestamptz
);
create index if not exists sol_sala_estado_idx on connectalive.solicitudes(sala_id, estado);

-- ----------------------------------------------------------------------------
-- ARCHIVOS
-- Metadatos. El binario vive en Storage (bucket "connectalive"). El dirigente
-- decide destinatarios ('solo_dirigente','alumnos','todos'). Sin aprobación,
-- ni alumnos ni oyentes lo ven.
-- ----------------------------------------------------------------------------
create table if not exists connectalive.archivos (
  id uuid primary key default gen_random_uuid(),
  sala_id uuid not null references connectalive.salas(id) on delete cascade,
  remitente_id uuid not null references connectalive.participantes(id) on delete cascade,
  nombre text not null,
  storage_path text not null,
  tamano_bytes bigint,
  destinatarios text not null default 'solo_dirigente'
    check (destinatarios in ('solo_dirigente','alumnos','todos')),
  aprobado boolean not null default false,
  aprobado_por uuid references connectalive.participantes(id),
  enviado_en timestamptz not null default now(),
  aprobado_en timestamptz
);
create index if not exists arch_sala_idx on connectalive.archivos(sala_id);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table connectalive.salas enable row level security;
alter table connectalive.participantes enable row level security;
alter table connectalive.solicitudes enable row level security;
alter table connectalive.archivos enable row level security;

-- SALAS: leer la que dirijo o donde estoy dentro.
drop policy if exists salas_leer on connectalive.salas;
create policy salas_leer on connectalive.salas
  for select using (
    dirigente_id = auth.uid()
    or exists (
      select 1 from connectalive.participantes p
      where p.sala_id = salas.id and p.user_id = auth.uid()
    )
  );

drop policy if exists salas_crear on connectalive.salas;
create policy salas_crear on connectalive.salas
  for insert with check (dirigente_id = auth.uid());

drop policy if exists salas_actualizar on connectalive.salas;
create policy salas_actualizar on connectalive.salas
  for update using (dirigente_id = auth.uid());

-- Para poder unirse con el código sin ver toda la sala, hay una función abajo
-- (buscar_sala_por_codigo) que devuelve sólo lo mínimo.

-- PARTICIPANTES
drop policy if exists part_leer on connectalive.participantes;
create policy part_leer on connectalive.participantes
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from connectalive.salas s
      where s.id = participantes.sala_id and s.dirigente_id = auth.uid()
    )
    or exists (
      select 1 from connectalive.participantes p2
      where p2.sala_id = participantes.sala_id and p2.user_id = auth.uid()
    )
  );

drop policy if exists part_insertar on connectalive.participantes;
create policy part_insertar on connectalive.participantes
  for insert with check (user_id = auth.uid());

drop policy if exists part_actualizar_propio on connectalive.participantes;
create policy part_actualizar_propio on connectalive.participantes
  for update using (user_id = auth.uid());

drop policy if exists part_actualizar_dirigente on connectalive.participantes;
create policy part_actualizar_dirigente on connectalive.participantes
  for update using (
    exists (
      select 1 from connectalive.salas s
      where s.id = participantes.sala_id and s.dirigente_id = auth.uid()
    )
  );

-- SOLICITUDES
drop policy if exists sol_leer on connectalive.solicitudes;
create policy sol_leer on connectalive.solicitudes
  for select using (
    exists (
      select 1 from connectalive.participantes p
      where p.sala_id = solicitudes.sala_id and p.user_id = auth.uid()
    )
  );

drop policy if exists sol_crear on connectalive.solicitudes;
create policy sol_crear on connectalive.solicitudes
  for insert with check (
    exists (
      select 1 from connectalive.participantes p
      where p.id = solicitudes.participante_id and p.user_id = auth.uid()
    )
  );

drop policy if exists sol_actualizar_dirigente on connectalive.solicitudes;
create policy sol_actualizar_dirigente on connectalive.solicitudes
  for update using (
    exists (
      select 1 from connectalive.salas s
      where s.id = solicitudes.sala_id and s.dirigente_id = auth.uid()
    )
  );

-- ARCHIVOS
drop policy if exists arch_leer on connectalive.archivos;
create policy arch_leer on connectalive.archivos
  for select using (
    exists (
      select 1 from connectalive.participantes p
      where p.sala_id = archivos.sala_id and p.user_id = auth.uid()
    )
  );

drop policy if exists arch_crear on connectalive.archivos;
create policy arch_crear on connectalive.archivos
  for insert with check (
    exists (
      select 1 from connectalive.participantes p
      where p.id = archivos.remitente_id and p.user_id = auth.uid()
    )
  );

drop policy if exists arch_actualizar_dirigente on connectalive.archivos;
create policy arch_actualizar_dirigente on connectalive.archivos
  for update using (
    exists (
      select 1 from connectalive.salas s
      where s.id = archivos.sala_id and s.dirigente_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- Buscar sala por código (sin dar la sala entera)
-- Se llama desde /unirse: devuelve sólo id, nombre y si está abierta a oyentes.
-- ----------------------------------------------------------------------------
create or replace function connectalive.buscar_sala_por_codigo(p_codigo text)
returns table (id uuid, nombre text, abierta_a_oyentes boolean, cerrada boolean)
language sql
security definer
set search_path to 'connectalive'
as $$
  select s.id, s.nombre, s.abierta_a_oyentes, (s.cerrada_en is not null)
  from connectalive.salas s
  where s.codigo = upper(trim(p_codigo))
  limit 1;
$$;

-- La función es pública por diseño (para unirse). Que el rol final se decida
-- en la INSERT de participantes con RLS.
revoke all on function connectalive.buscar_sala_por_codigo(text) from public;
grant execute on function connectalive.buscar_sala_por_codigo(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Realtime: refrescar solo la lista de participantes, la cola de solicitudes
-- y la bandeja de archivos.
-- ----------------------------------------------------------------------------
do $$
begin
  perform 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'connectalive'
      and tablename = 'participantes';
  if not found then
    alter publication supabase_realtime add table connectalive.participantes;
  end if;
end $$;

do $$
begin
  perform 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'connectalive'
      and tablename = 'solicitudes';
  if not found then
    alter publication supabase_realtime add table connectalive.solicitudes;
  end if;
end $$;

do $$
begin
  perform 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'connectalive'
      and tablename = 'archivos';
  if not found then
    alter publication supabase_realtime add table connectalive.archivos;
  end if;
end $$;

-- Exponer el esquema para PostgREST (la API que usa @supabase/supabase-js).
-- En el panel: Settings → API → Exposed schemas debe incluir "connectalive".
-- Esto lo deja armado a nivel de permisos aunque la lista del panel se toque
-- aparte.
grant usage on schema connectalive to anon, authenticated;
grant select, insert, update on all tables in schema connectalive to authenticated;
grant execute on all functions in schema connectalive to anon, authenticated;
alter default privileges in schema connectalive
  grant select, insert, update on tables to authenticated;
