// Presentación remota (gratis): la PC proyecta un PDF y el celular la
// controla — cambiar de diapositiva, mirar la anterior/siguiente en
// privado, subrayar encima y hacer zoom.
//
//   /presentacion                    la PC elige el PDF (queda como proyector)
//   /presentacion?c=CODIGO           proyector (p. ej. otra PC o tras un F5)
//   /presentacion?c=CODIGO&modo=control   el celular que controla

import { requireUser } from "./auth.js";
import { sb } from "./supabase.js";
import { crearLienzo, conectarBarra } from "./lienzo.js";
import { crearTablero, leerTablero, conectarTablero, limpiarCodigo } from "./tablero.js";
import { crearVisor, contarPaginas } from "./diapositivas.js";
import { pantallaCompleta, mostrarMensaje } from "./util.js";
import { STORAGE_BUCKET } from "./config.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const user = await requireUser();

const params = new URLSearchParams(location.search);
let codigo = limpiarCodigo(params.get("c"));
const esControl = params.get("modo") === "control";

let datos = null;
let visor = null;
let lienzo = null;
let sync = null;
let pagina = 1;
let privada = null;                 // diapositiva que el control mira sin proyectar
let vistaPantalla = { zoom: 100, x: 0, y: 0 };
let ultimoFueTrazo = false;
let pestana = "diapos";             // pestaña del control: diapos | subrayar | zoom

function estado(texto, ok) {
  $("#estado-texto").textContent = texto;
  $("#estado-punto").classList.toggle("ok", !!ok);
}
function aviso(texto, fijo = false) {
  const n = $("#aviso");
  n.textContent = texto;
  n.classList.remove("oculto");
  clearTimeout(aviso._t);
  if (!fijo) aviso._t = setTimeout(() => n.classList.add("oculto"), 4000);
}
function fallo(titulo, detalle) {
  $("#paso-diapo").classList.add("oculto");
  const p = $("#paso-subir");
  p.classList.remove("oculto");
  p.innerHTML = `<section class="tarjeta tarjeta-media"><h1>${titulo}</h1><p class="pista">${detalle || ""}</p><a class="btn btn-primario" href="/inicio">Volver al inicio</a></section>`;
}

// --- Paso 1: la PC elige el PDF --------------------------------------------
if (!codigo) {
  estado("Sin presentación", false);
  $("#paso-subir").classList.remove("oculto");
  $("#input-pdf").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const msg = $("#msg-subir");
    msg.classList.add("oculto");
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      return mostrarMensaje(msg, "Tiene que ser un archivo PDF.");
    }
    if (f.size > 50 * 1024 * 1024) return mostrarMensaje(msg, "El PDF debe pesar menos de 50 MB.");
    $("#lbl-pdf").textContent = "Preparando…";
    $("#lbl-pdf").classList.add("deshabilitado");
    try {
      const paginas = await contarPaginas(f);
      const t = await crearTablero("presentacion", f.name);
      codigo = t.codigo;
      const ruta = `libres/${user.id}/${codigo}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, "_")}`;
      const { error: eUp } = await sb.storage.from(STORAGE_BUCKET).upload(ruta, f, { contentType: "application/pdf" });
      if (eUp) throw eUp;
      const { error: eG } = await sb.rpc("tablero_guardar", {
        p_codigo: codigo, p_token: null, p_pdf_path: ruta, p_paginas: paginas, p_pagina: 1,
      });
      if (eG) throw eG;
      history.replaceState({}, "", `/presentacion?c=${codigo}`);
      $("#paso-subir").classList.add("oculto");
      await iniciar();
    } catch (err) {
      mostrarMensaje(msg, err.message || "No se pudo preparar la presentación.");
      $("#lbl-pdf").textContent = "Elegir PDF";
      $("#lbl-pdf").classList.remove("deshabilitado");
    }
  });
} else {
  await iniciar();
}

// --- Paso 2: presentación --------------------------------------------------
async function iniciar() {
  try {
    datos = await leerTablero(codigo);
  } catch (err) {
    return fallo("No encontramos esa presentación", err.message);
  }
  if (datos.tipo !== "presentacion") return fallo("Ese código es de una pizarra", "Ábrelo desde Pizarra → Proyectar.");
  if (!datos.pdf_path) return fallo("La presentación aún no tiene PDF", "Espera a que la PC termine de subirlo y vuelve a intentar.");

  $("#paso-diapo").classList.remove("oculto");
  $("#chip-codigo").classList.remove("oculto");
  $("#chip-pagina").classList.remove("oculto");
  $("#codigo").textContent = codigo;
  $("#titulo").textContent = datos.pdf_nombre || "Presentación";
  document.title = `Connectalive — ${datos.pdf_nombre || "Presentación"}`;
  if (datos.soy_dueno) $("#btn-cerrar").classList.remove("oculto");
  document.body.classList.toggle("modo-control", esControl);

  sync = conectarTablero(codigo, {
    pagina: ({ pagina: n }) => { if (n !== pagina) irA(n, false); },
    trazo: ({ t }) => lienzo.recibirTrazo(t),
    trazos: ({ lista }) => lienzo.setTrazos(lista),
    vista: (v) => { vistaPantalla = v; if (privada == null) lienzo.setVista(v); pintarZoom(); },
    hola: () => $("#codigo-proyector").classList.add("oculto"),
    cerrado: () => { aviso("La presentación se cerró.", true); estado("Cerrada", false); },
    conexion: (ok) => estado(ok ? (esControl ? "Controlando" : "En vivo") : "Reconectando…", ok),
    volver: releer,
    controlPerdido: () => { aviso("Otro dispositivo tomó el control."); estado("Sin control", false); },
    error: (e) => {
      if (String(e.message).startsWith("OCUPADO")) { aviso("La presentación se está controlando desde un celular."); releer(); }
      else aviso(e.message || "No se pudo guardar");
    },
  });

  lienzo = crearLienzo({
    canvas: $("#notas"),
    envoltura: $("#envoltura"),
    transparente: true,
    alTrazar(t, fin) { sync.trazo(t, fin); if (fin) ultimoFueTrazo = true; },
    alCambiar(lista) {
      if (ultimoFueTrazo) sync.guardarTrazos(lista); else sync.trazos(lista);
      ultimoFueTrazo = false;
    },
    alVista(v) { vistaPantalla = v; sync.vista(v); pintarZoom(); },
  });
  lienzo.setTrazos(datos.trazos);
  pagina = datos.pagina || 1;
  lienzo.setDiapositiva(pagina);
  vistaPantalla = { zoom: datos.zoom, x: datos.pan_x, y: datos.pan_y };
  lienzo.setVista(vistaPantalla);

  const { data: firmada, error: eF } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(datos.pdf_path, 60 * 60 * 6);
  if (eF) return fallo("No se pudo abrir el PDF", eF.message);
  try {
    visor = await crearVisor({
      fuente: firmada.signedUrl,
      canvas: $("#pdf"),
      contenedor: $("#caja"),
      alMedir: ({ ancho, alto }) => {
        const n = $("#notas");
        n.style.width = `${ancho}px`;
        n.style.height = `${alto}px`;
        lienzo.redibujar();
      },
    });
  } catch (err) {
    return fallo("No se pudo abrir el PDF", err.message);
  }
  await visor.ir(pagina);
  pintarPagina();

  if (esControl) await arrancarControl();
  else arrancarProyector();
}

async function releer() {
  try {
    const d = await leerTablero(codigo);
    lienzo.setTrazos(d.trazos);
    vistaPantalla = { zoom: d.zoom, x: d.pan_x, y: d.pan_y };
    if (d.pagina !== pagina) await irA(d.pagina, false);
    else if (privada == null) lienzo.setVista(vistaPantalla);
  } catch (err) {
    aviso(err.message, true);
  }
}

async function irA(n, avisar) {
  n = Math.max(1, Math.min(n, visor.total));
  pagina = n;
  privada = null;
  vistaPantalla = { zoom: 100, x: 0, y: 0 };
  lienzo.setDiapositiva(n);
  lienzo.setVista(vistaPantalla);
  if (avisar) sync.pagina(n);
  await visor.ir(n);
  pintarPagina();
  pintarZoom();
  if (esControl) aplicarPestana();
}

/** La diapositiva que mira este dispositivo (la previa, si la hay). */
function vistaActual() { return privada ?? pagina; }

function pintarPagina() {
  $("#chip-pagina").textContent = `${vistaActual()} / ${visor.total}`;
  if (!esControl) return;
  pintarMinis();
}

// En lugar de flechas: la anterior y la siguiente en miniatura. El botón de
// proyectar vive encima de la diapositiva, no aquí abajo.
function pintarMinis() {
  const vista = vistaActual();
  for (const [sel, n] of [["#mini-ant", vista - 1], ["#mini-sig", vista + 1]]) {
    const b = $(sel);
    if (!b) continue;
    const hay = n >= 1 && n <= visor.total;
    b.classList.toggle("oculto", !hay);
    if (!hay) continue;
    b.classList.toggle("en-pantalla", n === pagina);
    b.querySelector(".dp-mini-num").textContent = n;
    const lamina = b.querySelector(".dp-mini-lamina");
    if (lamina.dataset.pagina !== String(n)) {
      lamina.dataset.pagina = String(n);
      lamina.style.backgroundImage = "";
      lamina.classList.remove("lista");
      visor.miniatura(n).then((url) => {
        if (!url || lamina.dataset.pagina !== String(n)) return;
        lamina.style.backgroundImage = `url("${url}")`;
        lamina.classList.add("lista");
      });
    }
  }
  $("#dp-mando").classList.toggle("oculto", privada == null);
  $("#dp-en-pantalla").classList.toggle("oculto", privada != null);
  $("#vp-volver").textContent = `Volver a la ${pagina}`;
}
function pintarZoom() {
  const z = $("#zoom-valor");
  if (z) z.textContent = `${vistaPantalla.zoom}%`;
}

// --- Proyector (PC) --------------------------------------------------------
function arrancarProyector() {
  estado("En vivo", true);
  $("#btn-completa").classList.remove("oculto");
  $("#codigo-grande").textContent = codigo;
  if (!datos.controlado) $("#codigo-proyector").classList.remove("oculto");
  $("#codigo-proyector").addEventListener("click", () => $("#codigo-proyector").classList.add("oculto"));

  $("#btn-completa").addEventListener("click", () => pantallaCompleta($("#caja")));
  $("#caja").addEventListener("dblclick", () => { if (document.fullscreenElement) document.exitFullscreen(); });

  // Teclado o control de presentación (clicker): sólo la cuenta dueña y
  // mientras ningún celular tenga el control.
  document.addEventListener("keydown", (e) => {
    if (!datos.soy_dueno) return;
    if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); irA(pagina + 1, true); }
    else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); irA(pagina - 1, true); }
  });
}

// --- Control (celular) -----------------------------------------------------
function aplicarPestana() {
  $$(".control-pestanas button").forEach((b) => b.classList.toggle("activo", b.dataset.pestana === pestana));
  $$(".control-panel").forEach((p) => p.classList.toggle("oculto", p.dataset.panel !== pestana));
  const dibuja = privada == null && (pestana === "subrayar" || pestana === "zoom");
  lienzo.setEditable(dibuja);
  if (pestana === "zoom") lienzo.setHerramienta("zoom");
  else if (lienzo.herramienta === "zoom") lienzo.setHerramienta("lapiz");
}

// Mirar primero: las flechas mueven esta vista y la pantalla no se entera.
async function mirarPrivada(n) {
  if (n < 1 || n > visor.total) return;
  if (n === pagina) return salirPrivada();
  privada = n;
  lienzo.setDiapositiva(n);
  lienzo.setVista({ zoom: 100, x: 0, y: 0 });
  await visor.ir(n);
  pintarPagina();
  aplicarPestana();
}
async function salirPrivada() {
  privada = null;
  lienzo.setDiapositiva(pagina);
  lienzo.setVista(vistaPantalla);
  await visor.ir(pagina);
  pintarPagina();
  aplicarPestana();
}

async function arrancarControl() {
  if (!datos.soy_dueno) {
    return fallo("Esta presentación es de otra cuenta",
      "Para controlarla, entra en tu celular con la misma cuenta con la que se abrió en la PC.");
  }
  try {
    await sync.tomarControl(false);
  } catch (err) {
    if (!String(err.message).startsWith("OCUPADO")) return fallo("No se pudo conectar el control", err.message);
    if (!confirm("Esta presentación ya se controla desde otro dispositivo. ¿Controlarla desde aquí?")) {
      return fallo("La presentación ya tiene control", "Ciérrala en el otro dispositivo o vuelve a intentar.");
    }
    await sync.tomarControl(true);
  }
  sync.hola();
  estado("Controlando", true);
  $("#control").classList.remove("oculto");
  conectarBarra($("#barra"), lienzo);
  lienzo.setColor("#dc2626");
  $('#barra [data-color="#dc2626"]').classList.add("activo");

  $("#mini-ant").addEventListener("click", () => mirarPrivada(vistaActual() - 1));
  $("#mini-sig").addEventListener("click", () => mirarPrivada(vistaActual() + 1));

  $(".control-pestanas button").forEach((b) => b.addEventListener("click", () => {
    pestana = b.dataset.pestana;
    if (privada != null && pestana !== "diapos") salirPrivada();
    aplicarPestana();
  }));
  aplicarPestana();

  $("#vp-volver").addEventListener("click", salirPrivada);
  $("#vp-mostrar").addEventListener("click", () => irA(privada, true));

  $$("[data-z]").forEach((b) => b.addEventListener("click", () => {
    lienzo.setVista({ ...vistaPantalla, zoom: vistaPantalla.zoom + Number(b.dataset.z) }, true);
  }));
  $$("[data-mover]").forEach((b) => b.addEventListener("click", () => {
    const [dx, dy] = b.dataset.mover.split(",").map(Number);
    lienzo.setVista({ zoom: vistaPantalla.zoom, x: vistaPantalla.x + dx, y: vistaPantalla.y + dy }, true);
  }));
  $("#btn-z-centrar").addEventListener("click", () => lienzo.setVista({ zoom: 100, x: 0, y: 0 }, true));
}

// --- Cerrar ----------------------------------------------------------------
$("#btn-cerrar").addEventListener("click", async () => {
  if (!confirm("¿Cerrar la presentación? La PC deja de mostrarla y se borra el PDF.")) return;
  await sync?.cerrar();
  if (datos?.pdf_path) await sb.storage.from(STORAGE_BUCKET).remove([datos.pdf_path]).catch(() => {});
  await sb.rpc("tablero_cerrar", { p_codigo: codigo });
  location.replace("/inicio");
});

window.addEventListener("pagehide", () => { visor?.destruir(); sync?.desconectar(); });
