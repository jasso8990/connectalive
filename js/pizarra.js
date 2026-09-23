// Pizarra dentro de la clase.
//
// Mismo motor que la pizarra libre (js/lienzo.js). Diferencias:
//   • Quién escribe lo dice `salas.pizarra_controlador_id` (el dirigente al
//     abrirla; un alumno si el dirigente le aprueba la petición).
//   • Lo vivo viaja por broadcast en `pizarra-<sala>`; lo escrito se guarda
//     en `sala_pizarras` (vectores, no PNG) para quien llega tarde o
//     recarga. Antes se pedía una foto PNG al controlador por broadcast, que
//     pasaba del límite de tamaño de Realtime y llegaba en blanco.

import { crearLienzo, conectarBarra, ajustarMarco } from "./lienzo.js";

export function crearPizarra({ sb, salaId, alError }) {
  const barra = document.getElementById("pz-toolbar");
  const soltarMarco = ajustarMarco(document.getElementById("pz-caja"), document.getElementById("pz-marco"));
  let controlo = false;
  let ultimoFueTrazo = false;
  let espera = null;

  const canal = sb.channel(`pizarra-${salaId}`, { config: { broadcast: { self: false } } });
  const enviar = (event, payload) => canal.send({ type: "broadcast", event, payload }).catch(() => {});

  function guardar(lista) {
    clearTimeout(espera);
    espera = setTimeout(async () => {
      const { error } = await sb.rpc("sala_pizarra_guardar", { p_sala: salaId, p_trazos: lista });
      if (error) alError?.(error.message);
    }, 700);
  }

  const lienzo = crearLienzo({
    canvas: document.getElementById("pz-canvas"),
    envoltura: document.getElementById("pz-envoltura"),
    alTrazar(t, fin) { enviar("trazo", { t }); if (fin) ultimoFueTrazo = true; },
    alCambiar(lista) {
      if (!ultimoFueTrazo) enviar("trazos", { lista });
      ultimoFueTrazo = false;
      guardar(lista);
    },
  });
  conectarBarra(barra, lienzo);

  canal.on("broadcast", { event: "trazo" }, ({ payload }) => lienzo.recibirTrazo(payload.t));
  canal.on("broadcast", { event: "trazos" }, ({ payload }) => lienzo.setTrazos(payload.lista));
  canal.subscribe();

  async function recargar() {
    const { data } = await sb.from("sala_pizarras").select("trazos").eq("sala_id", salaId).maybeSingle();
    if (!controlo) lienzo.setTrazos(data?.trazos || []);
    else if (!lienzo.trazos.length && data?.trazos?.length) lienzo.setTrazos(data.trazos);
  }
  const alVolver = () => { if (document.visibilityState === "visible") recargar(); };
  document.addEventListener("visibilitychange", alVolver);
  recargar();

  return {
    setControlador(si) {
      controlo = !!si;
      lienzo.setEditable(controlo);
      barra.classList.toggle("oculto", !controlo);
    },
    limpiar() {
      clearTimeout(espera);
      document.removeEventListener("visibilitychange", alVolver);
      soltarMarco();
      lienzo.destruir();
      try { sb.removeChannel(canal); } catch {}
    },
  };
}
