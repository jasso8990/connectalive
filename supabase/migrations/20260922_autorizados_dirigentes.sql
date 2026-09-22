-- Cerrar la creación de salas a cuentas autorizadas.
--
-- Motivo: cada sala consume minutos-participante de LiveKit (cuenta de Juan).
-- Cualquiera que se registra puede *unirse* a una sala y usar pizarra /
-- presentaciones (esas no cuestan), pero sólo quienes compraron el servicio
-- crean sala.
--
-- Sigue el patrón de Cancha: una tabla lista los usuarios autorizados y
-- una función SECURITY DEFINER contesta sí/no. La política de INSERT en
-- `salas` la usa; el navegador la usa para pintar el formulario o el aviso.

create table if not exists connectalive.autorizados (
  user_id uuid primary key references auth.users(id) on delete cascade,
  autorizado_en timestamptz not null default now(),
  notas text
);

alter table connectalive.autorizados enable row level security;

-- Nadie lee esta tabla desde el navegador. La verdad se consulta con la
-- función de abajo, que no filtra otros correos.
drop policy if exists autorizados_nadie on connectalive.autorizados;
create policy autorizados_nadie on connectalive.autorizados
  for select using (false);

create or replace function connectalive.puede_crear_sala()
returns boolean
language sql
stable
security definer
set search_path to 'connectalive', 'pg_temp'
as $$
  select exists (
    select 1 from connectalive.autorizados a
    where a.user_id = auth.uid()
  );
$$;

revoke all on function connectalive.puede_crear_sala() from public;
grant execute on function connectalive.puede_crear_sala() to authenticated;

-- La política de INSERT ahora exige, además de ser tú mismo el dirigente,
-- estar en la lista de autorizados.
drop policy if exists salas_crear on connectalive.salas;
create policy salas_crear on connectalive.salas
  for insert with check (
    dirigente_id = auth.uid()
    and connectalive.puede_crear_sala()
  );

-- Semilla: Juan (jasso8990@gmail.com) autorizado.
insert into connectalive.autorizados (user_id, notas)
select id, 'Dueño del servicio'
from auth.users
where email = 'jasso8990@gmail.com'
on conflict (user_id) do nothing;
