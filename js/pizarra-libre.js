// Pizarra libre (gratis): se escribe en la tableta y se proyecta en la PC.
//
//   /pizarra?c=CODIGO&modo=escribir   la tableta que escribe
//   /pizarra?c=CODIGO                 la pantalla que proyecta
//
// La PC que proyecta también puede "Escribir desde aquí" si es la misma
// cuenta que abrió la pizarra (el control pasa a esa pantalla).

import { requireUser } from "./auth.js";
import { crearLienzo, conectarBarra, ajustarMarco } from "./lienzo.js";
import { leerTablero, conectarTablero, limpiarCodigo } from "./tablero.js";
import { copiar, pantallaCompleta } from "./util.js";
import { sb } from "./supabase.js";

const $ = (s) => document.querySelector(s);
await requireUser();

const params = new URLSearchParams(location.search);
const codigo = limpiarCodigo(params.get("c"));
if (codigo.length !== 6) location.replace("/inicio");
const quiereEscribir = params.get("modo") === "escribir";
$("#codigo").textContent = codigo;

ajustarMarco($("#caja"), $("#marco"));

let escribiendo = false;
let ultimoFueTrazo = false;

const lienzo = crearLienzo({
  canvas: $("#lienzo"),
  envoltura: $("#envoltura"),
  alTrazar(t, fin) { sync.trazo(t, fin); if (fin) ultimoFueTrazo = true; },
  alCambiar(lista) {
    // Fin de un trazo: los demás ya lo recibieron entero, sólo se guarda.
    // Deshacer o limpiar: se manda la lista completa.
    if (ultimoFueTrazo) sync.guardarTrazos(lista);
    else sync.trazos(lista);
    ultimoFueTrazo = false;
  },
  alVista(v) {
    sync.vista(v);
    $("#btn-centrar").classList.toggle("oculto", v.zoom === 100);
  },
});

const sync = conectarTablero(codigo, {
  trazo: ({ t }) => lienzo.recibirTrazo(t),
  trazos: ({ lista }) => lienzo.setTrazos(lista),
  vista: (v) => lienzo.setVista(v),
  cerrado: () => aviso("Quien abrió esta pizarra la cerró.", true),
  conexion: (ok) => estado(ok ? "En vivo" : "Reconectando…", ok),
  volver: () => { if (!escribiendo) recargar(); },
  controlPerdido: () => { modoEscribir(false); aviso("Otra pantalla tomó el control de la pizarra."); },
  error: (e) => aviso(e.message || "No se pudo guardar"),
});

conectarBarra($("#barra"), lienzo);
$("#btn-centrar").addEventListener("click", () => {
  lienzo.setVista({ zoom: 100, x: 0, y: 0 }, true);
  $("#btn-centrar").classList.add("oculto");
});

function estado(texto, ok) {
  $("#estado-texto").textContent = texto;
  $("#estado-punto").classList.toggle("ok", !!ok);
}

function aviso(texto, fijo = false) {
  const n = $("#aviso");
  n.textContent = texto;
  n.classList.remove("oculto");
  if (!fijo) setTimeout(() => n.classList.add("oculto"), 4000);
}

function modoEscribir(si) {
  escribiendo = si;
  lienzo.setEditable(si);
  $("#barra").classList.toggle("oculto", !si);
  $("#btn-tomar").classList.toggle("oculto", si || !datos?.soy_dueno);
  document.body.classList.toggle("escribiendo", si);
}

let datos = null;
async function recargar() {
  datos = await leerTablero(codigo);
  lienzo.setTrazos(datos.trazos);
  lienzo.setVista({ zoom: datos.zoom, x: datos.pan_x, y: datos.pan_y });
}

async function tomar(forzar) {
  try {
    await sync.tomarControl(forzar);
    modoEscribir(true);
  } catch (err) {
    if (String(err.message).startsWith("OCUPADO") && !forzar) {
      if (confirm("Esta pizarra se está escribiendo desde otro dispositivo. ¿Quieres escribir desde aquí? El otro dejará de poder escribir.")) {
        return tomar(true);
      }
      modoEscribir(false);
    } else {
      aviso(err.message || "No se pudo tomar el control");
    }
  }
}

try {
  await recargar();
} catch (err) {
  document.querySelector(".herr-cuerpo").innerHTML =
    `<div class="tarjeta centro-pantalla"><h1>No encontramos esa pizarra</h1><p class="pista">${err.message}</p><a class="btn btn-primario" href="/inicio">Volver al inicio</a></div>`;
  throw err;
}

if (datos.soy_dueno) {
  $("#btn-compartir").classList.remove("oculto");
  $("#btn-cerrar").classList.remove("oculto");
}
if (quiereEscribir && datos.soy_dueno) await tomar(false);
else modoEscribir(false);
if (!escribiendo) estado("Viendo", true);

// --- Botones de la barra superior -----------------------------------------
$("#btn-tomar").addEventListener("click", () => tomar(false));
$("#btn-completa").addEventListener("click", () => pantallaCompleta(document.documentElement));

const enlace = `${location.origin}/pizarra?c=${codigo}`;
$("#btn-compartir").addEventListener("click", () => {
  $("#dlg-codigo").textContent = codigo;
  $("#dlg-enlace").textContent = enlace;
  $("#dlg-compartir").showModal();
});
$("#btn-copiar").addEventListener("click", (e) => copiar(e.currentTarget, enlace));
$("#dlg-cerrar").addEventListener("click", () => $("#dlg-compartir").close());
// Al abrir en la tableta por primera vez, se enseña de una vez el código.
if (escribiendo && !lienzo.trazos.length) $("#btn-compartir").click();

$("#btn-cerrar").addEventListener("click", async () => {
  if (!confirm("¿Cerrar la pizarra? Lo escrito se borra y la otra pantalla deja de verla.")) return;
  await sync.cerrar();
  await sb.rpc("tablero_cerrar", { p_codigo: codigo });
  location.replace("/inicio");
});

window.addEventListener("pagehide", () => sync.desconectar());
