-- Funciones para el patrón Stripe "sin webhook" (mismo que Cancha/Smartagent):
--   1) plan_estatus() lo llama el frente y las Edge Functions para saber
--      si el usuario ya tiene un customer de Stripe amarrado y qué plan trae.
--   2) plan_amarrar_stripe() la llama SOLO la Edge Function `cl-revisar-
--      suscripcion` (con service_role) al volver del Checkout, para escribir
--      el plan+vencimiento+customer_id en connectalive.autorizados.
--
-- Sale del navegador: nunca. Es una función service_role.

create or replace function connectalive.plan_estatus()
returns table (
  plan_slug text,
  vence_en timestamptz,
  con_stripe boolean,
  stripe_customer_id text
)
language sql
stable
security definer
set search_path to 'connectalive', 'pg_temp'
as $$
  select
    a.plan_slug,
    a.vence_en,
    a.stripe_customer_id is not null as con_stripe,
    a.stripe_customer_id
  from connectalive.autorizados a
  where a.user_id = auth.uid()
  limit 1;
$$;

revoke all on function connectalive.plan_estatus() from public;
grant execute on function connectalive.plan_estatus() to authenticated;

create or replace function connectalive.plan_amarrar_stripe(
  p_user_id uuid,
  p_customer text,
  p_sub text,
  p_plan text,
  p_vence_en timestamptz
)
returns void
language plpgsql
security definer
set search_path to 'connectalive', 'pg_temp'
as $$
begin
  insert into connectalive.autorizados (
    user_id, plan_slug, vence_en, stripe_customer_id, stripe_subscription_id, notas
  ) values (
    p_user_id, p_plan, p_vence_en, p_customer, p_sub, 'Alta por Stripe Checkout'
  )
  on conflict (user_id) do update
    set plan_slug = excluded.plan_slug,
        vence_en = excluded.vence_en,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id;
end;
$$;

-- Sólo service_role escribe: un navegador no puede subirse el plan solo.
revoke all on function connectalive.plan_amarrar_stripe(uuid, text, text, text, timestamptz) from public;
revoke all on function connectalive.plan_amarrar_stripe(uuid, text, text, text, timestamptz) from anon, authenticated;
grant execute on function connectalive.plan_amarrar_stripe(uuid, text, text, text, timestamptz) to service_role;
