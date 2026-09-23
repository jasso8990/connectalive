-- (Aplicada en la base el 2026-09-22 como `connectalive_codigo_alumnos`; se
-- trae al repo el 2026-09-23 porque nunca se guardó aquí.)
-- Dos códigos por sala: `codigo` (oyentes) y `codigo_alumnos` (alumnos).
alter table connectalive.salas
  add column if not exists codigo_alumnos text unique;

drop function if exists connectalive.buscar_sala_por_codigo(text);

create or replace function connectalive.buscar_sala_por_codigo(p_codigo text)
returns table (id uuid, nombre text, abierta_a_oyentes boolean, cerrada boolean, rol_asignado text)
language sql
security definer
set search_path to 'connectalive'
as $$
  select s.id, s.nombre, s.abierta_a_oyentes, (s.cerrada_en is not null) as cerrada,
    case
      when s.codigo_alumnos = upper(trim(p_codigo)) then 'alumno'
      when s.codigo = upper(trim(p_codigo)) then 'oyente'
      else null
    end as rol_asignado
  from connectalive.salas s
  where s.codigo = upper(trim(p_codigo))
     or s.codigo_alumnos = upper(trim(p_codigo))
  limit 1;
$$;

revoke all on function connectalive.buscar_sala_por_codigo(text) from public;
grant execute on function connectalive.buscar_sala_por_codigo(text) to anon, authenticated;
