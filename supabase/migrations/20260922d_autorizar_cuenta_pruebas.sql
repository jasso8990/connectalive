-- (Aplicada en la base el 2026-09-22; se trae al repo el 2026-09-23.)
insert into connectalive.autorizados (user_id, plan_slug, vence_en, notas)
select id, 'escuela', '2099-12-31'::timestamptz, 'Cuenta de pruebas del dueño'
from auth.users where email = 'jasso-juan@hotmail.com'
on conflict (user_id) do update
set plan_slug = excluded.plan_slug, vence_en = excluded.vence_en, notas = excluded.notas;
