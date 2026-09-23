-- ============================================================
-- CIERRE · se aplica DESPUÉS de que el código del 2026-09-23 esté
-- publicado en Netlify (el código viejo usa las vías que esto quita).
-- ------------------------------------------------------------
-- 1. Nadie inserta ni edita su propio renglón de `participantes` desde el
--    navegador. Antes, con sólo el enlace de oyentes, cualquiera podía
--    insertarse como alumno (o editar su renglón y darse voz). Ahora se
--    entra con `unirse_a_sala` (el rol lo decide el código) y se sale con
--    `salir_de_sala`. El dirigente sigue cambiando roles y voz
--    (`part_actualizar_dirigente`).
-- 2. La columna `salas.codigo_alumnos` deja de ser legible para los
--    participantes: un oyente la leía de la tabla (o del Realtime) y se
--    subía solo a alumno. El dirigente la pide con `sala_codigo_alumnos`.
-- ============================================================

drop policy if exists part_insertar on connectalive.participantes;
drop policy if exists part_actualizar_propio on connectalive.participantes;

revoke select on connectalive.salas from anon, authenticated;
grant select (id, codigo, nombre, descripcion, dirigente_id, creada_en, cerrada_en,
              abierta_a_oyentes, pizarra_abierta, pizarra_controlador_id,
              presentacion_storage_path, presentacion_nombre, presentacion_paginas,
              presentacion_pagina_actual, presentacion_presentador_id, cuenta_id)
  on connectalive.salas to authenticated;
