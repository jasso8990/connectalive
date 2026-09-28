-- ConnectaLive en el Panel General de smrt-app.org/admin.
-- La llama sólo la Edge Function `panel-resumen` del proyecto compartido (repo `ventas`) con
-- service_role; ni anon ni authenticated la ejecutan. Sólo conteos, sin datos personales.

create or replace function public.connectalive_panel_resumen() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'titulares', (select count(*) from connectalive.autorizados),
    'titulares_vigentes', (select count(*) from connectalive.autorizados
        where vence_en is null or vence_en > now()),
    'pagando_stripe', (select count(*) from connectalive.autorizados
        where stripe_subscription_id is not null and (vence_en is null or vence_en > now())),
    'titulares_por_plan', (select coalesce(jsonb_object_agg(plan_slug, n), '{}'::jsonb) from (
        select coalesce(plan_slug, 'sin plan') as plan_slug, count(*) as n
          from connectalive.autorizados
         where vence_en is null or vence_en > now()
         group by 1) t),
    'total_maestros', (select count(*) from connectalive.maestros),
    'total_salas', (select count(*) from connectalive.salas),
    'salas_abiertas', (select count(*) from connectalive.salas where cerrada_en is null),
    'salas_7d', (select count(*) from connectalive.salas where creada_en >= now() - interval '7 days'),
    'en_vivo_ahora', (select count(*) from connectalive.participantes
        where salido_en is null and ultimo_latido >= now() - interval '2 minutes'),
    'minutos_mes', (select coalesce(sum(minutos), 0) from connectalive.uso_minutos
        where mes = date_trunc('month', now())::date),
    'total_tableros', (select count(*) from connectalive.tableros)
  )
$$;

revoke all on function public.connectalive_panel_resumen() from public, anon, authenticated;
grant execute on function public.connectalive_panel_resumen() to service_role;
