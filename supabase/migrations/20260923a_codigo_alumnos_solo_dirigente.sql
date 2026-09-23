-- El código de alumnos se lo da la base sólo al dirigente (botón «Invitar»
-- de la sala). Aditiva: el cierre de la columna para los demás va en
-- 20260923b_cerrar_participantes.sql, después del push.
create or replace function connectalive.sala_codigo_alumnos(p_sala uuid)
returns text language plpgsql stable security definer
set search_path to 'connectalive', 'pg_temp' as $$
begin
  if not connectalive.es_dirigente_de(p_sala) then
    raise exception 'Sólo el dirigente ve el código de alumnos' using errcode = '42501';
  end if;
  return (select codigo_alumnos from connectalive.salas where id = p_sala);
end $$;

revoke all on function connectalive.sala_codigo_alumnos(uuid) from public, anon;
grant execute on function connectalive.sala_codigo_alumnos(uuid) to authenticated, service_role;
