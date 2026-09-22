-- Planes de suscripción y cupo mensual de min-participante por dirigente.
-- Costo real de LiveKit Ship: $50 / 150000 min = $0.000333/min-participante.
-- Regla: cliente paga ≥ 2× lo que le cuesta a Juan.
--   Clase   $4.99  → costo tope $2.50 → 7500  min-participante/mes
--   Grupo   $19.99 → costo tope $10   → 30000 min-participante/mes
--   Escuela $49.99 → costo tope $25   → 75000 min-participante/mes

create table if not exists connectalive.planes (
  slug text primary key,
  nombre text not null,
  precio_usd numeric(6,2) not null,
  minutos_participante_mes int not null,
  orden int not null
);

insert into connectalive.planes (slug, nombre, precio_usd, minutos_participante_mes, orden) values
  ('clase',   'Clase',    4.99,   7500,  1),
  ('grupo',   'Grupo',   19.99,  30000,  2),
  ('escuela', 'Escuela', 49.99,  75000,  3)
on conflict (slug) do update set
  nombre = excluded.nombre,
  precio_usd = excluded.precio_usd,
  minutos_participante_mes = excluded.minutos_participante_mes,
  orden = excluded.orden;

-- Los planes son públicos (los pinta la pantalla de "no autorizado").
alter table connectalive.planes enable row level security;
drop policy if exists planes_leer on connectalive.planes;
create policy planes_leer on connectalive.planes for select using (true);
grant select on connectalive.planes to anon, authenticated;

-- La tabla autorizados ahora guarda plan contratado y vencimiento.
alter table connectalive.autorizados
  add column if not exists plan_slug text references connectalive.planes(slug),
  add column if not exists vence_en timestamptz,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

-- Al dueño (Juan) se le pone plan "escuela" con vencimiento lejano.
update connectalive.autorizados
set plan_slug = 'escuela',
    vence_en = '2099-12-31'::timestamptz
where user_id = (select id from auth.users where email = 'jasso8990@gmail.com')
  and plan_slug is null;

-- La función `puede_crear_sala` ahora también exige suscripción vigente.
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
      and a.plan_slug is not null
      and (a.vence_en is null or a.vence_en > now())
  );
$$;

grant execute on function connectalive.puede_crear_sala() to authenticated;
