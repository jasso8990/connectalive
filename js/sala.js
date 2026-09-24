// Clase en vivo.
//
// Junta tres piezas:
//   1) Supabase — estado (sala, participantes, solicitudes, archivos) y realtime.
//   2) LiveKit — audio/video/pantalla en vivo.
//   3) Netlify Functions — emite el JWT de LiveKit y sube/baja permisos.
//
// El rol del navegador NO decide nada por sí solo: se lee de la base. Cada
// vez que el dirigente cambia un rol o da/quita voz, `permiso` lo refleja en
// LiveKit en caliente (sin reconectar).

import { sb } from "./supabase.js";
import { requireUser, postConSesion, rutaDeEntrada } from "./auth.js";
import { conectarSala, cargarLivekit } from "./livekit.js";
import { STORAGE_BUCKET, PERMISO_ENDPOINT } from "./config.js";
import { crearPizarra } from "./pizarra.js";
import { crearVisor, contarPaginas } from "./diapositivas.js";
import { escapar, copiar, pantallaCompleta } from "./util.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const salaId = location.pathname.split("/").pop();
if (!/^[0-9a-f-]{36}$/i.test(salaId)) location.replace("/inicio");

const user = await requireUser();

// Modo control (`?control=1`): la tableta del dirigente escribe en la pizarra
// o pasa diapositivas mientras la PC transmite la cámara. No se conecta a
// LiveKit: con la misma identidad sacaría a la PC, y así no gasta minutos.
const modoControl = new URLSearchParams(location.search).get("control") === "1";
if (modoControl) document.body.classList.add("modo-tableta");

// Qué ve cada quien cuando hay pizarra o diapositivas: sólo al maestro,
// ambos lado a lado, o sólo el contenido. Es de este navegador nada más.
const VISTAS = ["maestro", "ambos", "contenido"];
let vista = "ambos";
try { if (VISTAS.includes(localStorage.getItem("cl-vista"))) vista = localStorage.getItem("cl-vista"); } catch {}

// Columnas de `salas` que lee el navegador (el código de alumnos NO: ese se
// pide aparte y sólo se lo da la base al dirigente).
const COLS_SALA = "id,codigo,nombre,descripcion,dirigente_id,cerrada_en,abierta_a_oyentes," +
  "pizarra_abierta,pizarra_controlador_id,presentacion_storage_path,presentacion_nombre," +
  "presentacion_paginas,presentacion_pagina_actual,presentacion_presentador_id";

// --- Estado en memoria -----------------------------------------------------
let sala = null;
let yo = null;                      // mi renglón de participantes
let participantes = new Map();      // id → renglón
let solicitudes = [];
let archivos = [];
let room = null;                    // LiveKit Room
let LK = null;                      // namespace LivekitClient
let pizarra = null;                 // módulo pizarra.js (null si está cerrada)
let visor = null;                   // visor de diapositivas (null si no hay)
let dpPrevia = null;                // diapositiva que MIRA quien presenta sin proyectarla
let pdfCargado = null;              // ruta del PDF abierto en el visor
let latido = null;
let terminada = false;              // ya se enseñó la pantalla final: nada más se pinta

const soyDir = () => yo?.rol === "dirigente";

// --- Carga inicial ---------------------------------------------------------
async function cargarTodo() {
  const { data: s, error: eS } = await sb.from("salas").select(COLS_SALA).eq("id", salaId).maybeSingle();
  if (eS) return abortar(eS.message);
  if (!s) return abortar("No estás en esta clase. Vuelve a entrar con el enlace o el código.");
  if (s.cerrada_en) return abortar("Esta clase ya terminó.");
  sala = s;

  // Si habías salido, se marca que volviste (y si no estabas, te dice por qué).
  const { data: mio } = await sb.from("participantes").select("id, salido_en")
    .eq("sala_id", salaId).eq("user_id", user.id).maybeSingle();
  if (!mio) return abortar("No estás en esta clase. Vuelve a entrar con el enlace o el código.");
  if (mio.salido_en) {
    const { error } = await sb.rpc("unirse_a_sala", { p_codigo: s.codigo });
    if (error) return abortar(error.message);
  }

  const { data: parts, error: eP } = await sb.from("participantes")
    .select("id, user_id, rol, nombre_mostrar, voz_activa, salido_en")
    .eq("sala_id", salaId);
  if (eP) return abortar(eP.message);
  participantes = new Map(parts.map((p) => [p.id, p]));
  yo = parts.find((p) => p.user_id === user.id);

  const { data: sols } = await sb.from("solicitudes").select("*")
    .eq("sala_id", salaId).in("estado", ["pendiente", "aprobada"]);
  solicitudes = sols || [];

  const { data: archs } = await sb.from("archivos").select("*")
    .eq("sala_id", salaId).order("enviado_en", { ascending: false });
  archivos = archs || [];

  $("#sala-nombre").textContent = s.nombre;
  $("#sala-codigo").textContent = "Código " + s.codigo;
  document.title = `Connectalive — ${s.nombre}`;
  aplicarMiRol();
  pintar();
  await aplicarVista();
  return true;
}

function abortar(msg) {
  terminada = true;
  try { room?.disconnect(); } catch {}
  clearInterval(latido);
  try { pizarra?.limpiar(); } catch {}
  sb.removeAllChannels();
  document.body.className = "pantalla-luz";
  document.body.innerHTML = `<main class="portada"><section class="tarjeta"><h1>Uy…</h1><p>${escapar(msg)}</p><p><a class="btn btn-primario" href="/inicio">Volver al inicio</a></p></section></main>`;
  return false;
}

function aviso(texto, ms = 4500) {
  if (terminada) return;
  const n = $("#aviso");
  n.textContent = texto;
  n.classList.remove("oculto");
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => n.classList.add("oculto"), ms);
}

function aplicarMiRol() {
  $("#mi-rol").textContent = { dirigente: "Dirigente", alumno: "Alumno", oyente: "Oyente" }[yo.rol];
  $("#mi-rol").dataset.rol = yo.rol;

  const puedeHablar = !modoControl && (yo.rol !== "oyente" || yo.voz_activa);
  $("#btn-mic").classList.toggle("oculto", !puedeHablar);
  $("#btn-cam").classList.toggle("oculto", !puedeHablar);
  $("#btn-pantalla").classList.toggle("oculto", !puedeHablar);
  $("#btn-mano").classList.toggle("oculto", yo.rol !== "oyente" || modoControl);
  $("#btn-pizarra").classList.toggle("oculto", yo.rol === "oyente");
  $("#btn-invitar").classList.toggle("oculto", !soyDir() || modoControl);
  $("#btn-tableta").classList.toggle("oculto", !soyDir() || modoControl);

  $("#zona-subir").classList.toggle("oculto", !puedeHablar);
  $("#zona-subir-pista").textContent = soyDir()
    ? "Se comparte con la clase. Tú eliges a quién le llega."
    : "Se manda al dirigente. Él decide a quién le llega.";
}

// --- Pintar UI -------------------------------------------------------------
function pintar() {
  if (terminada) return;
  pintarGente();
  pintarSolicitudes();
  pintarArchivos();
}

function pintarGente() {
  const grupos = { dirigente: [], alumno: [], oyente: [] };
  for (const p of participantes.values()) if (!p.salido_en) grupos[p.rol]?.push(p);
  $("#lista-dirigente").innerHTML = grupos.dirigente.map(fila).join("");
  $("#lista-alumnos").innerHTML = grupos.alumno.map(fila).join("");
  $("#lista-oyentes").innerHTML = grupos.oyente.map(fila).join("");
  $("#conteo-alumnos").textContent = `(${grupos.alumno.length})`;
  $("#conteo-oyentes").textContent = `(${grupos.oyente.length})`;
  if (soyDir()) {
    $$('[data-tab="gente"] .btn-rol').forEach((b) => b.addEventListener("click", onCambiarRol));
    $$('[data-tab="gente"] .btn-voz').forEach((b) => b.addEventListener("click", onDarQuitarVoz));
  }
}

function fila(p) {
  const eresTu = p.user_id === user.id ? '<span class="chip-mini">tú</span>' : "";
  let acciones = "";
  if (soyDir() && p.user_id !== user.id) {
    // Tres cosas distintas: la palabra (momentánea, sigue de oyente) y los
    // cambios de rol (alumno ↔ oyente, para quien entró con el enlace
    // equivocado). Por eso cada botón dice qué hace.
    if (p.rol === "oyente") {
      acciones = `
        <button class="btn-mini btn-voz${p.voz_activa ? "" : " verde"}" data-id="${p.id}" data-voz="${p.voz_activa ? "0" : "1"}"
          title="${p.voz_activa ? "Vuelve a sólo ver y oír" : "Habla un momento y sigue siendo oyente"}">${p.voz_activa ? "Quitar la palabra" : "Dar la palabra"}</button>
        <button class="btn-mini btn-rol" data-id="${p.id}" data-nuevo="alumno"
          title="Cambia su rol: se queda como alumno toda la clase">Cambiar a alumno</button>`;
    } else if (p.rol === "alumno") {
      acciones = `<button class="btn-mini btn-rol" data-id="${p.id}" data-nuevo="oyente"
        title="Cambia su rol: sólo ve y oye (puede levantar la mano)">Cambiar a oyente</button>`;
    }
  }
  const marca = p.voz_activa && p.rol === "oyente" ? '<span class="chip-mini verde">tiene la palabra</span>' : "";
  return `
    <li>
      <div class="gente-nombre">${escapar(p.nombre_mostrar)} ${eresTu} ${marca}</div>
      ${acciones ? `<div class="gente-acciones">${acciones}</div>` : ""}
    </li>`;
}

const etiquetaTipo = (t) => ({ mano: "levanta la mano", compartir: "quiere compartir pantalla", archivo: "quiere pasar archivo", pizarra: "quiere tomar la pizarra", presentar: "quiere presentar las diapositivas" }[t] || t);
const etiquetaEstado = (e) => ({ pendiente: "En espera", aprobada: "Autorizada", rechazada: "Rechazada", revocada: "Cerrada" }[e] || e);
const formatoTamano = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

function pintarSolicitudes() {
  const pendientes = solicitudes.filter((s) => s.estado === "pendiente");
  const paraMi = soyDir() ? pendientes : solicitudes.filter((s) => s.participante_id === yo.id);
  $("#badge-sol").textContent = soyDir() ? pendientes.length : "";
  $("#badge-sol").classList.toggle("oculto", !soyDir() || pendientes.length === 0);
  $("#sol-vacio").classList.toggle("oculto", paraMi.length > 0);
  $("#sol-vacio").textContent = soyDir() ? "Nadie ha pedido nada." : "No has pedido nada.";

  // La mano del oyente se ve levantada mientras su petición espera.
  const mano = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "mano" && s.estado === "pendiente");
  const conPalabra = yo.rol === "oyente" && yo.voz_activa;
  $("#btn-mano").classList.toggle("pulsando", !!mano && !conPalabra);
  $("#btn-mano").classList.toggle("con-palabra", conPalabra);
  $("#btn-mano").title = conPalabra ? "Ya terminé (soltar la palabra)" : mano ? "Bajar la mano" : "Levantar la mano";
  $("#btn-mano").setAttribute("aria-label", $("#btn-mano").title);

  if (!soyDir()) {
    $("#lista-solicitudes").innerHTML = paraMi.map((s) => `
      <li><div class="sol-nombre">Tu petición: ${etiquetaTipo(s.tipo)}</div>
          <div class="sol-estado">${etiquetaEstado(s.estado)}</div></li>`).join("");
    return;
  }
  // Arriba, los oyentes que tienen la palabra ahora mismo: es momentánea y
  // aquí se ve a quién hay que quitársela.
  const hablando = [...participantes.values()].filter((p) => p.rol === "oyente" && p.voz_activa && !p.salido_en);
  $("#sol-vacio").classList.toggle("oculto", paraMi.length + hablando.length > 0);
  $("#lista-solicitudes").innerHTML = hablando.map((p) => `
      <li class="sol-hablando">
        <div class="sol-nombre">${escapar(p.nombre_mostrar)} tiene la palabra <span class="chip-mini">oyente</span></div>
        <div class="sol-acciones">
          <button class="btn-mini btn-voz" data-id="${p.id}" data-voz="0">Quitar la palabra</button>
        </div>
      </li>`).join("") + pendientes.map((s) => {
    const p = participantes.get(s.participante_id);
    if (!p) return "";
    return `
      <li>
        <div class="sol-nombre">${escapar(p.nombre_mostrar)} ${etiquetaTipo(s.tipo)}</div>
        ${s.tipo === "mano" ? '<div class="sol-estado">Habla un momento y sigue siendo oyente.</div>' : ""}
        <div class="sol-acciones">
          <button class="btn-mini verde" data-sol="${s.id}" data-accion="aprobar">${s.tipo === "mano" ? "Dar la palabra" : "Aprobar"}</button>
          <button class="btn-mini" data-sol="${s.id}" data-accion="rechazar">Rechazar</button>
        </div>
      </li>`;
  }).join("");
  $$("[data-sol]").forEach((b) => b.addEventListener("click", onResolverSolicitud));
  $$("#lista-solicitudes .btn-voz").forEach((b) => b.addEventListener("click", onDarQuitarVoz));
}

function pintarArchivos() {
  // La base ya filtra lo que cada quien puede ver (arch_leer).
  $("#lista-archivos").innerHTML = archivos.map((a) => {
    const rem = participantes.get(a.remitente_id);
    const mio = a.remitente_id === yo.id;
    let estado = "";
    if (mio && !a.aprobado) estado = '<span class="chip-mini">esperando al dirigente</span>';
    if (a.aprobado && soyDir()) estado = `<span class="chip-mini verde">${{ solo_dirigente: "sólo tú", alumnos: "alumnos", todos: "todos" }[a.destinatarios]}</span>`;
    let acciones = "";
    if (soyDir() && !a.aprobado) {
      acciones = `<button class="btn-mini verde" data-arch="${a.id}" data-accion="autorizar">Autorizar…</button>
                  <button class="btn-mini" data-arch="${a.id}" data-accion="descartar">Descartar</button>`;
    } else if (soyDir()) {
      acciones = `<button class="btn-mini" data-arch="${a.id}" data-accion="descartar">Quitar</button>`;
    }
    return `
      <li>
        <div>
          <div class="arch-nombre">${escapar(a.nombre)}</div>
          <div class="arch-meta">de ${rem ? escapar(rem.nombre_mostrar) : "—"}${a.tamano_bytes ? " · " + formatoTamano(a.tamano_bytes) : ""}</div>
          ${estado}
        </div>
        <div class="arch-acciones">
          ${a.aprobado || soyDir() || mio ? `<button class="btn-mini" data-descargar="${a.id}">Descargar</button>` : ""}
          ${acciones}
        </div>
      </li>`;
  }).join("") || '<li class="vacio">Todavía no hay archivos.</li>';
  $$("[data-arch]").forEach((b) => b.addEventListener("click", onArchivoAccion));
  $$("[data-descargar]").forEach((b) => b.addEventListener("click", onDescargar));
}

// --- Roles y solicitudes (dirigente) ---------------------------------------
async function onCambiarRol(e) {
  const { id, nuevo } = e.currentTarget.dataset;
  const { error } = await sb.from("participantes")
    .update({ rol: nuevo, voz_activa: false, rol_fijado: true }).eq("id", id);
  if (error) return aviso(error.message);
  await sincronizarPermisos(id);
}

async function onDarQuitarVoz(e) {
  const { id, voz } = e.currentTarget.dataset;
  const { error } = await sb.from("participantes").update({ voz_activa: voz === "1" }).eq("id", id);
  if (error) return aviso(error.message);
  if (voz === "0") {
    // Si tenía la mano arriba, se cierra.
    await sb.from("solicitudes").update({ estado: "revocada", resuelta_en: new Date().toISOString() })
      .eq("participante_id", id).eq("tipo", "mano").eq("estado", "aprobada");
  }
  await sincronizarPermisos(id);
}

async function onResolverSolicitud(e) {
  const { sol: solId, accion } = e.currentTarget.dataset;
  const sol = solicitudes.find((s) => s.id === solId);
  if (!sol) return;
  const ahora = new Date().toISOString();

  if (accion !== "aprobar") {
    await sb.from("solicitudes").update({ estado: "rechazada", resuelta_en: ahora }).eq("id", solId);
    return;
  }
  const { error } = await sb.from("solicitudes").update({ estado: "aprobada", resuelta_en: ahora }).eq("id", solId);
  if (error) return aviso(error.message);

  const p = participantes.get(sol.participante_id);
  if (sol.tipo === "mano" || (sol.tipo === "compartir" && p?.rol === "oyente")) {
    // Hablar o compartir pantalla pide publicar en LiveKit: al oyente se le da voz.
    await sb.from("participantes").update({ voz_activa: true }).eq("id", sol.participante_id);
    await sincronizarPermisos(sol.participante_id);
  } else if (sol.tipo === "pizarra") {
    await sb.from("salas").update({ pizarra_abierta: true, pizarra_controlador_id: sol.participante_id }).eq("id", salaId);
  } else if (sol.tipo === "presentar") {
    await sb.from("salas").update({ presentacion_presentador_id: sol.participante_id }).eq("id", salaId);
  }
}

async function sincronizarPermisos(participanteId) {
  try {
    const r = await postConSesion(PERMISO_ENDPOINT, { salaId, participanteId });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `permiso ${r.status}`);
  } catch (err) {
    aviso(`El cambio quedó guardado, pero el video no lo reflejó: ${err.message}`);
  }
}

// --- Archivos ----------------------------------------------------------------
function elegirDestinatarios(nombre) {
  return new Promise((res) => {
    $("#dlg-archivo-nombre").textContent = nombre;
    const dlg = $("#dlg-destinatarios");
    dlg.returnValue = "";
    dlg.addEventListener("close", () => {
      res(dlg.returnValue === "ok" ? dlg.querySelector('input[name="dest"]:checked').value : null);
    }, { once: true });
    dlg.showModal();
  });
}

$("#input-archivo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 50 * 1024 * 1024) return aviso("El archivo debe pesar menos de 50 MB.");

  const ruta = `${salaId}/${yo.id}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, "_")}`;
  let dest = "solo_dirigente";
  if (soyDir()) {
    dest = await elegirDestinatarios(f.name);
    if (!dest) return;
  }
  aviso(`Subiendo ${f.name}…`, 60000);
  const { error: eUp } = await sb.storage.from(STORAGE_BUCKET).upload(ruta, f, { upsert: false });
  if (eUp) return aviso("No se pudo subir: " + eUp.message);

  const fila = {
    sala_id: salaId, remitente_id: yo.id, nombre: f.name, storage_path: ruta,
    tamano_bytes: f.size, destinatarios: dest, aprobado: soyDir(),
  };
  if (soyDir()) Object.assign(fila, { aprobado_por: yo.id, aprobado_en: new Date().toISOString() });
  const { error } = await sb.from("archivos").insert(fila);
  if (error) {
    await sb.storage.from(STORAGE_BUCKET).remove([ruta]).catch(() => {});
    return aviso("No se pudo registrar el archivo: " + error.message);
  }
  aviso(soyDir() ? "Archivo compartido." : "Archivo enviado al dirigente.");
});

async function onArchivoAccion(e) {
  const { arch: id, accion } = e.currentTarget.dataset;
  const a = archivos.find((x) => x.id === id);
  if (!a) return;
  if (accion === "descartar") {
    if (!confirm(`¿Quitar «${a.nombre}»?`)) return;
    const { error } = await sb.from("archivos").delete().eq("id", id);
    if (error) return aviso(error.message);
    await sb.storage.from(STORAGE_BUCKET).remove([a.storage_path]).catch(() => {});
    return;
  }
  if (accion === "autorizar") {
    const dest = await elegirDestinatarios(a.nombre);
    if (!dest) return;
    const { error } = await sb.from("archivos").update({
      aprobado: true, destinatarios: dest, aprobado_por: yo.id, aprobado_en: new Date().toISOString(),
    }).eq("id", id);
    if (error) aviso(error.message);
  }
}

async function onDescargar(e) {
  const a = archivos.find((x) => x.id === e.currentTarget.dataset.descargar);
  if (!a) return;
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(a.storage_path, 300, { download: a.nombre });
  if (error) return aviso(error.message);
  window.open(data.signedUrl, "_blank");
}

// --- Mano alzada -------------------------------------------------------------
// La palabra del oyente es momentánea: con la palabra, el mismo botón la
// suelta («Ya terminé»). Sigue siendo oyente; subir a alumno es otra cosa.
$("#btn-mano").addEventListener("click", async () => {
  if (yo.rol === "oyente" && yo.voz_activa) {
    try {
      await room?.localParticipant.setMicrophoneEnabled(false);
      await room?.localParticipant.setCameraEnabled(false);
      await room?.localParticipant.setScreenShareEnabled(false);
    } catch {}
    const { error } = await sb.rpc("soltar_palabra", { p_sala: salaId });
    if (error) return aviso(error.message);
    await sincronizarPermisos(yo.id);
    return aviso("Listo, soltaste la palabra. Si quieres volver a hablar, levanta la mano.");
  }
  const existe = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "mano" && s.estado === "pendiente");
  if (existe) {
    const { error } = await sb.from("solicitudes")
      .update({ estado: "revocada", resuelta_en: new Date().toISOString() }).eq("id", existe.id);
    if (error) aviso(error.message);
    return;
  }
  const { error } = await sb.from("solicitudes").insert({ sala_id: salaId, participante_id: yo.id, tipo: "mano" });
  if (error) return aviso(error.message);
  aviso("Levantaste la mano. El dirigente te dará la palabra.");
});

// --- Micrófono, cámara y pantalla ---------------------------------------------
async function alternar(boton, activo, fn) {
  if (!room) return aviso("El video todavía se está conectando.");
  try {
    await fn(!activo);
    boton.dataset.estado = !activo ? "on" : "off";
  } catch (err) {
    aviso(/permission|denied|NotAllowed/i.test(err.message || err.name)
      ? "El navegador no dio permiso. Revísalo en el candado de la barra de direcciones."
      : err.message || "No se pudo");
  }
}
$("#btn-mic").addEventListener("click", (e) =>
  alternar(e.currentTarget, room?.localParticipant.isMicrophoneEnabled, (v) => room.localParticipant.setMicrophoneEnabled(v)));
$("#btn-cam").addEventListener("click", (e) =>
  alternar(e.currentTarget, room?.localParticipant.isCameraEnabled, (v) => room.localParticipant.setCameraEnabled(v)));

$("#btn-pantalla").addEventListener("click", async (e) => {
  if (!room) return aviso("El video todavía se está conectando.");
  const b = e.currentTarget;
  const comparto = room.localParticipant.isScreenShareEnabled;
  if (!soyDir() && !comparto) {
    // Alumno / oyente con voz: necesita que el dirigente lo apruebe.
    const aprobada = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "compartir" && s.estado === "aprobada");
    if (!aprobada) {
      const pendiente = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "compartir" && s.estado === "pendiente");
      if (pendiente) return aviso("Ya le pediste permiso al dirigente. Espera su respuesta.");
      const { error } = await sb.from("solicitudes").insert({ sala_id: salaId, participante_id: yo.id, tipo: "compartir" });
      if (error) return aviso(error.message);
      return aviso("Le pediste permiso al dirigente para compartir tu pantalla.");
    }
  }
  await alternar(b, comparto, (v) => room.localParticipant.setScreenShareEnabled(v));
  // Al dejar de compartir, el permiso se gasta: la próxima vez se vuelve a pedir.
  if (comparto && !soyDir()) {
    const aprobada = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "compartir" && s.estado === "aprobada");
    if (aprobada) await sb.from("solicitudes").update({ estado: "revocada", resuelta_en: new Date().toISOString() }).eq("id", aprobada.id);
  }
});

// --- Vista principal: video, pizarra o diapositivas ---------------------------
// La pizarra abierta manda sobre las diapositivas; si no, las diapositivas
// (si hay PDF); si no, el video.
async function aplicarVista() {
  if (terminada) return;
  const pz = !!sala.pizarra_abierta;
  const dp = !pz && !!sala.presentacion_storage_path;
  // En la tableta de control siempre se ve el contenido; en los demás manda
  // la vista que eligió cada quien.
  const v = modoControl ? "contenido" : vista;
  const verContenido = (pz || dp) && v !== "maestro";
  $("#pizarra").classList.toggle("oculto", !pz || !verContenido);
  $("#diapositivas").classList.toggle("oculto", !dp || !verContenido);
  $("#tarima").classList.toggle("oculto", verContenido);
  document.body.dataset.vista = v;
  $("#vista-selector").classList.toggle("oculto", modoControl || !(pz || dp));
  $("#vista-contenido").textContent = pz ? "Pizarra" : "Presentación";
  $$("#vista-selector [data-vista]").forEach((b) => b.classList.toggle("activo", b.dataset.vista === vista));
  $("#btn-pizarra").dataset.estado = pz ? "on" : "off";
  $("#btn-diapositivas").dataset.estado = dp ? "on" : "off";
  $("#btn-diapositivas").classList.toggle("oculto", yo.rol === "oyente");
  refrescarPizarra();
  await refrescarDiapositivas(dp && verContenido);
  if (modoControl && !verContenido) {
    $("#tarima").innerHTML = soyDir()
      ? '<div class="tarima-vacia">Modo control: abre la <b>pizarra</b> o sube una <b>presentación</b> con los botones de abajo.<br>Tu cámara sigue en la PC.</div>'
      : '<div class="tarima-vacia">Aquí aparecen la pizarra o las diapositivas cuando se abran.</div>';
  }
  pintarVideos();
}

$$("#vista-selector [data-vista]").forEach((b) => b.addEventListener("click", () => {
  vista = b.dataset.vista;
  try { localStorage.setItem("cl-vista", vista); } catch {}
  aplicarVista();
}));

// --- Pizarra -----------------------------------------------------------------
function refrescarPizarra() {
  const abierta = !!sala.pizarra_abierta;
  const controlo = sala.pizarra_controlador_id === yo.id;
  if (abierta && !pizarra) pizarra = crearPizarra({ sb, salaId, alError: aviso });
  if (!abierta && pizarra) { pizarra.limpiar(); pizarra = null; }
  if (!pizarra) return;
  pizarra.setControlador(controlo);
  const c = participantes.get(sala.pizarra_controlador_id);
  $("#pz-estado-control").textContent = controlo ? "Tú escribes" : c ? `Escribe: ${c.nombre_mostrar}` : "Nadie escribe";
  $("#pz-recuperar").classList.toggle("oculto", !soyDir() || controlo);
  $("#pz-cerrar").classList.toggle("oculto", !soyDir());
}

async function actualizarSala(cambios) {
  const { error } = await sb.from("salas").update(cambios).eq("id", salaId);
  if (error) aviso(error.message);
}

$("#btn-pizarra").addEventListener("click", async () => {
  if (soyDir()) {
    if (!sala.pizarra_abierta) return actualizarSala({ pizarra_abierta: true, pizarra_controlador_id: yo.id });
    if (sala.pizarra_controlador_id !== yo.id) return actualizarSala({ pizarra_controlador_id: yo.id });
    return actualizarSala({ pizarra_abierta: false });
  }
  if (yo.rol !== "alumno") return;
  if (!sala.pizarra_abierta) return aviso("El dirigente todavía no abre la pizarra.");
  if (sala.pizarra_controlador_id === yo.id) return aviso("Ya tienes la pizarra.");
  const yaPide = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "pizarra" && s.estado === "pendiente");
  if (yaPide) return aviso("Ya pediste la pizarra. Espera al dirigente.");
  const { error } = await sb.from("solicitudes").insert({ sala_id: salaId, participante_id: yo.id, tipo: "pizarra" });
  aviso(error ? error.message : "Le pediste la pizarra al dirigente.");
});
$("#pz-recuperar").addEventListener("click", () => actualizarSala({ pizarra_controlador_id: yo.id }));
$("#pz-cerrar").addEventListener("click", () => actualizarSala({ pizarra_abierta: false }));
$("#pz-fullscreen").addEventListener("click", () => pantallaCompleta($("#pizarra")));

// --- Diapositivas --------------------------------------------------------------
async function refrescarDiapositivas(visible) {
  const ruta = sala.presentacion_storage_path;
  if (!ruta && visor) {
    await visor.destruir();
    visor = null; pdfCargado = null;
    dpPrevia = null;
  }
  if (!ruta || !visible) return;

  if (!visor || pdfCargado !== ruta) {
    if (visor) { await visor.destruir(); visor = null; }
    const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(ruta, 60 * 60 * 6);
    if (error) return aviso("No se pudo abrir la presentación: " + error.message);
    try {
      visor = await crearVisor({ fuente: data.signedUrl, canvas: $("#dp-canvas"), contenedor: $("#dp-caja") });
    } catch (err) {
      return aviso(err.message || "No se pudo abrir el PDF");
    }
    pdfCargado = ruta;
  }
  const presento = sala.presentacion_presentador_id === yo.id;
  const total = sala.presentacion_paginas || visor.total;
  const enPantalla = sala.presentacion_pagina_actual || 1;
  // La vista previa es de ESTE navegador (la tableta del que presenta): la
  // clase sigue viendo `presentacion_pagina_actual` hasta "Mostrar a todos".
  if (!presento) dpPrevia = null;
  if (dpPrevia != null) dpPrevia = Math.max(1, Math.min(dpPrevia, total));
  if (dpPrevia === enPantalla) dpPrevia = null;
  const vista = dpPrevia ?? enPantalla;
  await visor.ir(vista);

  $("#dp-pagina").textContent = `${vista} / ${total}`;
  $("#dp-pagina").classList.toggle("dp-pagina-previa", dpPrevia != null);
  $("#dp-nombre").textContent = sala.presentacion_nombre || "";
  pintarMinis(total, presento, enPantalla, vista);
  $("#dp-cerrar").classList.toggle("oculto", !soyDir());
  $("#dp-tomar").classList.toggle("oculto", !soyDir() || presento);
  const pres = participantes.get(sala.presentacion_presentador_id);
  $("#dp-estado").textContent = presento ? "Tú presentas" : pres ? `Presenta: ${pres.nombre_mostrar}` : "Nadie presenta";
}

$("#btn-diapositivas").addEventListener("click", async () => {
  const hay = !!sala.presentacion_storage_path;
  if (soyDir()) {
    if (!hay) return $("#dp-input").click();
    if (sala.pizarra_abierta) return actualizarSala({ pizarra_abierta: false });
    return cerrarPresentacion();
  }
  if (!hay) return aviso("El dirigente todavía no carga una presentación.");
  if (sala.presentacion_presentador_id === yo.id) return aviso("Ya estás presentando: usa las flechas.");
  const yaPide = solicitudes.find((s) => s.participante_id === yo.id && s.tipo === "presentar" && s.estado === "pendiente");
  if (yaPide) return aviso("Ya pediste presentar. Espera al dirigente.");
  const { error } = await sb.from("solicitudes").insert({ sala_id: salaId, participante_id: yo.id, tipo: "presentar" });
  aviso(error ? error.message : "Le pediste al dirigente controlar las diapositivas.");
});

async function cerrarPresentacion() {
  if (!confirm("¿Cerrar la presentación? Se borra el PDF.")) return;
  const ruta = sala.presentacion_storage_path;
  await actualizarSala({
    presentacion_storage_path: null, presentacion_nombre: null, presentacion_paginas: null,
    presentacion_pagina_actual: 1, presentacion_presentador_id: null,
  });
  if (ruta) sb.storage.from(STORAGE_BUCKET).remove([ruta]).catch(() => {});
}

$("#dp-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return aviso("Tiene que ser un PDF.");
  aviso("Subiendo la presentación…", 60000);
  try {
    const paginas = await contarPaginas(f);
    const ruta = `presentaciones/${salaId}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, "_")}`;
    const { error: eUp } = await sb.storage.from(STORAGE_BUCKET).upload(ruta, f, { upsert: false, contentType: "application/pdf" });
    if (eUp) throw eUp;
    const anterior = sala.presentacion_storage_path;
    await actualizarSala({
      presentacion_storage_path: ruta, presentacion_nombre: f.name, presentacion_paginas: paginas,
      presentacion_pagina_actual: 1, presentacion_presentador_id: yo.id, pizarra_abierta: false,
    });
    if (anterior) sb.storage.from(STORAGE_BUCKET).remove([anterior]).catch(() => {});
    aviso("Presentación lista.");
  } catch (err) {
    aviso("No se pudo subir: " + (err.message || err));
  }
});

// En lugar de flechas, quien presenta ve la ANTERIOR y la SIGUIENTE en
// miniatura. Toca una y esa se ve grande en su pantalla; la clase sigue en la
// suya hasta que toque "Mostrar a todos", que vive encima de la diapositiva.
function pintarMinis(total, presento, enPantalla, vista) {
  for (const [sel, n] of [["#dp-mini-ant", vista - 1], ["#dp-mini-sig", vista + 1]]) {
    const b = $(sel);
    const hay = presento && visor && n >= 1 && n <= total;
    b.classList.toggle("oculto", !hay);
    if (!hay) continue;
    b.classList.toggle("en-pantalla", n === enPantalla);
    b.querySelector(".dp-mini-num").textContent = n;
    const lamina = b.querySelector(".dp-mini-lamina");
    // La imagen llega cuando esté; mientras tanto se ve el hueco gris.
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
  $("#dp-mando").classList.toggle("oculto", !presento || dpPrevia == null);
  $("#dp-en-pantalla").classList.toggle("oculto", !presento || dpPrevia != null);
  $("#dp-volver").textContent = `Volver a la ${enPantalla}`;
}

// Mirar la de al lado (miniatura, teclado o clicker) no toca la pantalla de la
// clase; proyectar es siempre un acto aparte.
async function mirar(delta) {
  if (sala.presentacion_presentador_id !== yo.id || !visor) return;
  const total = sala.presentacion_paginas || visor.total || 1;
  const enPantalla = sala.presentacion_pagina_actual || 1;
  const ahora = dpPrevia ?? enPantalla;
  const nueva = Math.max(1, Math.min(ahora + delta, total));
  if (nueva === ahora) return;
  dpPrevia = nueva === enPantalla ? null : nueva;
  await refrescarDiapositivas(true);
}

async function mostrarPrevia() {
  if (dpPrevia == null || sala.presentacion_presentador_id !== yo.id) return;
  const pagina = dpPrevia;
  dpPrevia = null;
  const { error } = await sb.rpc("sala_ir_a_pagina", { p_sala: salaId, p_pagina: pagina });
  if (error) { dpPrevia = pagina; aviso(error.message); }
  await refrescarDiapositivas(true);
}

async function volverDePrevia() {
  dpPrevia = null;
  await refrescarDiapositivas(true);
}

$("#dp-mini-ant").addEventListener("click", () => mirar(-1));
$("#dp-mini-sig").addEventListener("click", () => mirar(1));
$("#dp-mostrar").addEventListener("click", mostrarPrevia);
$("#dp-volver").addEventListener("click", volverDePrevia);
$("#dp-cerrar").addEventListener("click", cerrarPresentacion);
$("#dp-tomar").addEventListener("click", () => actualizarSala({ presentacion_presentador_id: yo.id }));
$("#dp-fullscreen").addEventListener("click", () => pantallaCompleta($("#diapositivas")));

document.addEventListener("keydown", (e) => {
  if (!sala || sala.pizarra_abierta || sala.presentacion_presentador_id !== yo?.id) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); mirar(-1); }
  else if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); mirar(1); }
  // Con un control de presentación: las flechas miran, Enter proyecta.
  else if (e.key === "Enter") { e.preventDefault(); mostrarPrevia(); }
});

// --- Pestañas, invitar y salir ------------------------------------------------
$$(".panel-tabs .tab").forEach((t) => t.addEventListener("click", () => {
  $$(".panel-tabs .tab").forEach((x) => x.classList.toggle("activo", x === t));
  $$(".tab-contenido").forEach((c) => c.classList.toggle("activo", c.dataset.tab === t.dataset.tab));
}));

$("#btn-invitar").addEventListener("click", async () => {
  const { data: codigoAlumnos, error } = await sb.rpc("sala_codigo_alumnos", { p_sala: salaId });
  if (error) return aviso(error.message);
  const publico = `${location.origin}/s/${sala.codigo}`;
  $("#inv-publico").textContent = publico;
  $("#inv-alumnos").textContent = `${publico}?a=${codigoAlumnos}`;
  $("#dlg-invitar").showModal();
});
$$("[data-copiar]").forEach((b) => b.addEventListener("click", () => copiar(b, $("#" + b.dataset.copiar).textContent)));
$("#inv-cerrar").addEventListener("click", () => $("#dlg-invitar").close());

$("#btn-tableta").addEventListener("click", () => {
  $("#tab-enlace").textContent = `${location.origin}/sala/${salaId}?control=1`;
  $("#dlg-tableta").showModal();
});
$("#tab-cerrar").addEventListener("click", () => $("#dlg-tableta").close());

$("#btn-salir").addEventListener("click", () => {
  // La tableta de control comparte el renglón de participante con la PC:
  // si marcara la salida, a la PC también la daría por ida.
  if (modoControl) return location.replace("/inicio");
  $("#btn-terminar").classList.toggle("oculto", !soyDir());
  $("#salir-pista").textContent = soyDir()
    ? "Si sólo sales, la clase sigue abierta y puedes volver desde Inicio. «Terminar para todos» la cierra y borra sus archivos."
    : "Puedes volver a entrar desde Inicio mientras la clase siga abierta.";
  $("#dlg-salir").showModal();
});
$("#dlg-salir").addEventListener("close", async () => {
  const v = $("#dlg-salir").returnValue;
  if (v !== "salir" && v !== "terminar") return;
  try { await room?.disconnect(); } catch {}
  clearInterval(latido);
  if (v === "terminar") {
    // Con la clase cerrada ya nadie puede entrar a bajar nada: se borran los
    // archivos y el PDF para no dejarlos para siempre en Storage.
    const rutas = archivos.map((a) => a.storage_path);
    if (sala.presentacion_storage_path) rutas.push(sala.presentacion_storage_path);
    if (rutas.length) await sb.storage.from(STORAGE_BUCKET).remove(rutas).catch(() => {});
  }
  await sb.rpc("salir_de_sala", { p_sala: salaId, p_terminar: v === "terminar" });
  location.replace("/inicio");
});

// --- Realtime ----------------------------------------------------------------
function suscribir() {
  sb.channel(`sala-${salaId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "connectalive", table: "salas", filter: `id=eq.${salaId}` },
      async ({ new: nueva }) => {
        const antes = sala;
        // Realtime manda el renglón entero; se conserva sólo lo que usamos.
        sala = Object.fromEntries(COLS_SALA.split(",").map((k) => [k, nueva[k]]));
        if (sala.cerrada_en) return abortar("El dirigente terminó la clase. ¡Gracias por venir!");
        $("#sala-nombre").textContent = sala.nombre;
        const cambio = ["pizarra_abierta", "pizarra_controlador_id", "presentacion_storage_path",
          "presentacion_pagina_actual", "presentacion_presentador_id"].some((k) => antes[k] !== sala[k]);
        if (cambio) await aplicarVista();
        if (antes.pizarra_controlador_id !== yo.id && sala.pizarra_controlador_id === yo.id && !soyDir()) {
          aviso("El dirigente te dio la pizarra. Ya puedes escribir.");
        }
        if (antes.presentacion_presentador_id !== yo.id && sala.presentacion_presentador_id === yo.id && !soyDir()) {
          aviso("Ahora tú controlas las diapositivas.");
        }
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "participantes", filter: `sala_id=eq.${salaId}` },
      (payload) => {
        if (payload.eventType === "DELETE") participantes.delete(payload.old.id);
        else {
          const previo = participantes.get(payload.new.id);
          if (soyDir() && previo?.voz_activa && !payload.new.voz_activa && payload.new.rol === "oyente") {
            aviso(`${payload.new.nombre_mostrar} ya no tiene la palabra.`);
          }
          participantes.set(payload.new.id, payload.new);
          if (payload.new.user_id === user.id) {
            const antes = yo;
            yo = payload.new;
            if (antes.rol !== yo.rol || antes.voz_activa !== yo.voz_activa) {
              aplicarMiRol();
              aplicarVista();
              if (yo.rol === "alumno" && antes.rol === "oyente") aviso("El dirigente te subió a alumno: ya puedes hablar.");
              else if (yo.voz_activa && !antes.voz_activa) aviso("Te dieron la palabra: prende tu micrófono.");
              else if (!yo.voz_activa && antes.voz_activa && yo.rol === "oyente") aviso("El dirigente cerró tu micrófono.");
            }
          }
        }
        pintar();
        pintarVideos();
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "solicitudes", filter: `sala_id=eq.${salaId}` },
      (payload) => {
        if (payload.eventType === "DELETE") solicitudes = solicitudes.filter((s) => s.id !== payload.old.id);
        else {
          const i = solicitudes.findIndex((s) => s.id === payload.new.id);
          const antes = i >= 0 ? solicitudes[i] : null;
          if (i >= 0) solicitudes[i] = payload.new; else solicitudes.push(payload.new);
          const s = payload.new;
          if (s.participante_id === yo.id && antes?.estado === "pendiente") {
            if (s.estado === "aprobada" && s.tipo === "compartir") aviso("El dirigente aprobó: toca el botón de pantalla para compartir.");
            else if (s.estado === "rechazada") aviso(`El dirigente no aprobó tu petición (${etiquetaTipo(s.tipo)}).`);
          }
          if (soyDir() && !antes && s.estado === "pendiente") {
            const p = participantes.get(s.participante_id);
            if (p) aviso(`${p.nombre_mostrar} ${etiquetaTipo(s.tipo)}.`);
          }
        }
        pintar();
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "archivos", filter: `sala_id=eq.${salaId}` },
      (payload) => {
        if (payload.eventType === "DELETE") archivos = archivos.filter((a) => a.id !== payload.old.id);
        else {
          const i = archivos.findIndex((a) => a.id === payload.new.id);
          if (i >= 0) archivos[i] = payload.new; else archivos.unshift(payload.new);
        }
        pintar();
      })
    .subscribe();
}

// --- LiveKit -------------------------------------------------------------------
// Se pintan quienes transmiten algo (cámara, micrófono o pantalla) y el
// dirigente; los oyentes callados no llenan la pantalla de cuadros negros.
function pintarVideos() {
  if (!room || terminada) return;
  const destino = !$("#pizarra").classList.contains("oculto") ? $("#tira-videos")
    : !$("#diapositivas").classList.contains("oculto") ? $("#tira-videos-dp")
    : $("#tarima");

  // Soltar los <video>/<audio> anteriores (si no, se acumulan en memoria).
  const todos = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of todos) for (const pub of p.trackPublications.values()) pub.track?.detach();
  for (const n of [$("#tarima"), $("#tira-videos"), $("#tira-videos-dp")]) n.innerHTML = "";

  // El dirigente va primero: en «Ambos» y «Maestro» es el cuadro grande.
  const esDir = (p) => participantes.get(p.identity)?.rol === "dirigente";
  const orden = [...todos].sort((a, b) => esDir(b) - esDir(a));
  for (const p of orden) {
    const pubs = [...p.trackPublications.values()].filter((x) => x.track);
    const part = participantes.get(p.identity);
    const esDirigente = part?.rol === "dirigente";
    if (!pubs.length && !esDirigente) continue;

    const box = document.createElement("div");
    box.className = "video-box";
    const label = document.createElement("div");
    label.className = "video-label";
    label.textContent = (part?.nombre_mostrar || p.name || "—") + (p === room.localParticipant ? " (tú)" : "");
    box.appendChild(label);

    for (const pub of pubs) {
      if (pub.kind === "video") {
        const el = pub.track.attach();
        el.classList.add("video-media");
        if (pub.source === "screen_share") { el.classList.add("video-screen"); box.classList.add("es-screen"); }
        else if (p === room.localParticipant) el.classList.add("video-espejo");
        if (pub.isMuted) el.classList.add("oculto");
        box.appendChild(el);
      } else if (pub.kind === "audio" && p !== room.localParticipant) {
        const el = pub.track.attach();
        el.style.display = "none";
        box.appendChild(el);
      }
    }
    if (!box.querySelector("video:not(.oculto)")) {
      const ini = document.createElement("div");
      ini.className = "video-inicial";
      ini.textContent = (label.textContent.trim()[0] || "?").toUpperCase();
      box.appendChild(ini);
    }
    destino.appendChild(box);
  }
  if (!destino.children.length && destino.id === "tarima") {
    destino.innerHTML = '<div class="tarima-vacia">Nadie está transmitiendo todavía.</div>';
  }
}

async function conectarLK() {
  const r = await conectarSala({ salaId, participanteId: yo.id });
  room = r.room;
  LK = r.LK;
  const E = LK.RoomEvent;
  for (const ev of [E.TrackSubscribed, E.TrackUnsubscribed, E.ParticipantConnected, E.ParticipantDisconnected,
                    E.LocalTrackPublished, E.LocalTrackUnpublished, E.TrackMuted, E.TrackUnmuted]) {
    room.on(ev, pintarVideos);
  }
  // Si el navegador corta la pantalla compartida desde su propia barra.
  room.on(E.LocalTrackUnpublished, () => {
    $("#btn-pantalla").dataset.estado = room.localParticipant.isScreenShareEnabled ? "on" : "off";
    $("#btn-mic").dataset.estado = room.localParticipant.isMicrophoneEnabled ? "on" : "off";
    $("#btn-cam").dataset.estado = room.localParticipant.isCameraEnabled ? "on" : "off";
  });
  room.on(E.Disconnected, () => aviso("Se cortó el video. Recarga la página para volver a entrar.", 60000));
  pintarVideos();

  // Minutos-participante: un latido por minuto mientras hay video.
  const latir = async () => {
    const { data } = await sb.rpc("latido", { p_sala: salaId });
    if (data?.cerrada) abortar("El dirigente terminó la clase. ¡Gracias por venir!");
  };
  latir();
  latido = setInterval(latir, 60_000);
}

// --- Arranque ------------------------------------------------------------------
try {
  if (!modoControl) cargarLivekit().catch(() => {});      // precarga el SDK mientras hacemos consultas
  if (await cargarTodo()) {
    suscribir();
    if (!modoControl) try {
      await conectarLK();
    } catch (err) {
      console.error(err);
      // Sin video (sin minutos, plan vencido, sin red): lo demás de la clase sigue.
      // Si lo que se cayó fue la sesión, no hay nada que reintentar: hay que
      // volver a entrar, y el botón trae de regreso a esta misma sala.
      const volver = err.sesionCaducada
        ? `<br><a class="btn btn-primario" href="${rutaDeEntrada()}">Volver a entrar</a>`
        : "";
      $("#tarima").innerHTML = `<div class="tarima-vacia">No se pudo conectar el video.<br><small>${escapar(err.message)}</small>${volver}</div>`;
    }
  }
} catch (err) {
  console.error(err);
  abortar(err.message || "Falló el arranque de la clase");
}
