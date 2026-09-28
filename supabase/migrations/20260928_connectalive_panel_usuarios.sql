-- Usuarios de ConnectaLive para su página en smrt-app.org/admin (como la de Planora).
-- Toda cuenta que aparece en la app: titulares (con plan), maestros de un titular, quien dirigió una
-- sala y quien entró como alumno. La llama sólo la Edge Function `panel-resumen` del proyecto
-- compartido (repo `ventas`) con service_role.

create or replace function public.connectalive_panel_usuarios() returns jsonb
language sql stable security definer set search_path = '' as $$
  with ids as (
    select user_id as id from connectalive.autorizados
    union select dirigente_id from connectalive.salas
    union select user_id from connectalive.participantes
    union select dueno_id from connectalive.tableros
    union select au.id from connectalive.maestros m join auth.users au on lower(au.email) = lower(m.correo)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'correo', lower(au.email),
           'nombre', coalesce(
              (select m.nombre from connectalive.maestros m where lower(m.correo) = lower(au.email) limit 1),
              (select p.nombre_mostrar from connectalive.participantes p where p.user_id = au.id
                order by p.unido_en desc limit 1),
              au.raw_user_meta_data->>'nombre_mostrar', ''),
           'tipo', case when a.user_id is not null then 'titular'
                        when exists (select 1 from connectalive.maestros m where lower(m.correo) = lower(au.email)) then 'maestro'
                        when exists (select 1 from connectalive.salas s where s.dirigente_id = au.id) then 'dirigente'
                        else 'alumno' end,
           'plan', a.plan_slug,
           'vence', a.vence_en,
           'salas', (select count(*) from connectalive.salas s where s.dirigente_id = au.id),
           'alta', au.created_at,
           'ultimo_acceso', au.last_sign_in_at) order by au.created_at desc), '[]'::jsonb)
    from ids
    join auth.users au on au.id = ids.id
    left join connectalive.autorizados a on a.user_id = au.id
$$;

revoke all on function public.connectalive_panel_usuarios() from public, anon, authenticated;
grant execute on function public.connectalive_panel_usuarios() to service_role;
