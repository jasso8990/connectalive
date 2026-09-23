-- La palabra del oyente es momentánea: el dirigente se la da al aprobar su
-- mano y el propio oyente la suelta al terminar («Ya terminé»), sin esperar a
-- que el dirigente se acuerde de quitársela. Sigue siendo oyente todo el
-- tiempo; subir a alumno es otra cosa (cambio de rol, sólo el dirigente).
--
-- Desde 20260923b nadie edita su propio renglón de `participantes`, por eso
-- va por función. Sólo puede APAGAR la voz propia, nunca prenderla.

create or replace function connectalive.soltar_palabra(p_sala uuid)
returns void language sql volatile security definer
set search_path to 'connectalive', 'pg_temp' as $$
  update connectalive.participantes
     set voz_activa = false
   where sala_id = p_sala and user_id = auth.uid() and rol = 'oyente';

  update connectalive.solicitudes s
     set estado = 'revocada', resuelta_en = now()
   where s.sala_id = p_sala
     and s.tipo = 'mano'
     and s.estado in ('pendiente', 'aprobada')
     and s.participante_id in (select p.id from connectalive.participantes p
                                where p.sala_id = p_sala and p.user_id = auth.uid());
$$;

revoke all on function connectalive.soltar_palabra(uuid) from public, anon;
grant execute on function connectalive.soltar_palabra(uuid) to authenticated;
