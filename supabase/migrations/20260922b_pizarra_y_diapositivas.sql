-- (Aplicadas en la base el 2026-09-22 como `connectalive_pizarra` y
-- `connectalive_diapositivas`; se traen al repo el 2026-09-23.)
alter table connectalive.salas
  add column if not exists pizarra_abierta boolean not null default false,
  add column if not exists pizarra_controlador_id uuid
    references connectalive.participantes(id) on delete set null,
  add column if not exists presentacion_storage_path text,
  add column if not exists presentacion_nombre text,
  add column if not exists presentacion_paginas int,
  add column if not exists presentacion_pagina_actual int not null default 1,
  add column if not exists presentacion_presentador_id uuid
    references connectalive.participantes(id) on delete set null;

alter table connectalive.solicitudes drop constraint if exists solicitudes_tipo_check;
alter table connectalive.solicitudes add constraint solicitudes_tipo_check
  check (tipo in ('mano','compartir','archivo','pizarra','presentar'));
