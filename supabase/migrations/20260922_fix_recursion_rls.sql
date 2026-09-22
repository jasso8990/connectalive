-- Fix: recursión infinita entre las políticas de `salas` y `participantes`.
--
-- Síntoma: al crear una sala, el `.select()` de vuelta rebota con
-- "infinite recursion detected in policy for relation salas". La política
-- `salas_leer` consulta `participantes`, y la de `participantes` consulta
-- `salas` — Postgres se muerde la cola.
--
-- Solución estándar: dos funciones SECURITY DEFINER que responden "¿soy
-- dirigente / participante de esta sala?" — al correr con el rol del owner,
-- las consultas de dentro no vuelven a evaluar RLS. Las políticas usan
-- estas funciones en vez de subselects.

create or replace function connectalive.es_dirigente_de(p_sala uuid)
returns boolean
language sql
stable
security definer
set search_path to 'connectalive', 'pg_temp'
as $$
  select exists (
    select 1 from connectalive.salas s
    where s.id = p_sala and s.dirigente_id = auth.uid()
  );
$$;

create or replace function connectalive.es_participante_de(p_sala uuid)
returns boolean
language sql
stable
security definer
set search_path to 'connectalive', 'pg_temp'
as $$
  select exists (
    select 1 from connectalive.participantes p
    where p.sala_id = p_sala and p.user_id = auth.uid()
  );
$$;

revoke all on function connectalive.es_dirigente_de(uuid) from public;
revoke all on function connectalive.es_participante_de(uuid) from public;
grant execute on function connectalive.es_dirigente_de(uuid) to authenticated;
grant execute on function connectalive.es_participante_de(uuid) to authenticated;

-- SALAS: leer la que dirijo o donde estoy dentro (sin recursión).
drop policy if exists salas_leer on connectalive.salas;
create policy salas_leer on connectalive.salas
  for select using (
    dirigente_id = auth.uid()
    or connectalive.es_participante_de(id)
  );

-- PARTICIPANTES: leer los propios, o los de una sala donde soy dirigente
-- o participante. Sin subselects a salas/participantes (los helpers se
-- encargan).
drop policy if exists part_leer on connectalive.participantes;
create policy part_leer on connectalive.participantes
  for select using (
    user_id = auth.uid()
    or connectalive.es_dirigente_de(sala_id)
    or connectalive.es_participante_de(sala_id)
  );

-- La política de UPDATE de dirigente también tenía subselect a salas.
drop policy if exists part_actualizar_dirigente on connectalive.participantes;
create policy part_actualizar_dirigente on connectalive.participantes
  for update using (connectalive.es_dirigente_de(sala_id));

-- SOLICITUDES y ARCHIVOS también hacen subselects que ahora conviene
-- pasar por los helpers, por consistencia y para no volver a caer en
-- este mismo pozo si mañana se agrega otra política encima.
drop policy if exists sol_leer on connectalive.solicitudes;
create policy sol_leer on connectalive.solicitudes
  for select using (connectalive.es_participante_de(sala_id));

drop policy if exists sol_actualizar_dirigente on connectalive.solicitudes;
create policy sol_actualizar_dirigente on connectalive.solicitudes
  for update using (connectalive.es_dirigente_de(sala_id));

drop policy if exists arch_leer on connectalive.archivos;
create policy arch_leer on connectalive.archivos
  for select using (connectalive.es_participante_de(sala_id));

drop policy if exists arch_actualizar_dirigente on connectalive.archivos;
create policy arch_actualizar_dirigente on connectalive.archivos
  for update using (connectalive.es_dirigente_de(sala_id));
