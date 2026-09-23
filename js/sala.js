// Sala en vivo.
//
// Junta tres piezas:
//   1) Supabase — estado (participantes, solicitudes, archivos) y realtime.
//   2) LiveKit — audio/video/pantalla en vivo.
//   3) Netlify Functions — emite el JWT de LiveKit y sube/baja permisos.
//
// El rol del navegador NO decide nada por sí solo: se lee de la base. Cada
// vez que el dirigente cambia un rol o da/quita voz, se llama a la función
// `permiso` para reflejarlo en LiveKit en caliente (sin reconectar).

import { sb } from "./supabase.js";
import { requireUser, nombreDe, salir } from "./auth.js";
import { conectarSala, pedirToken, cargarLivekit } from "./livekit.js";
import { STORAGE_BUCKET, PERMISO_ENDPOINT } from "./config.js";
import { crearPizarra } from "./pizarra.js";
import { crearVisorDiapositivas, cargarPdfjs } from "./diapositivas.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const salaId = location.pathname.split("/").pop();
if (!salaId || salaId.length < 10) location.replace("/");

const user = await requireUser();

// --- Estado en memoria -----------------------------------------------------
let sala = null;
let miParticipante = null;
let participantes = new Map();   // id → { id, user_id, rol, nombre_mostrar, voz_activa }
let solicitudes = [];
let archivos = [];
let room = null;                 // LiveKit Room
let LK = null;                   // namespace LivekitClient
let miTokenRol = null;           // el "rol técnico" con el que se firmó el token actual
let pizarra = null;              // instancia del módulo pizarra.js (null si está cerrada)
let visorDiapo = null;           // instancia del visor de diapositivas (null si no hay)
let ultimoStorageDiapo = null;   // ruta cargada, para no recargar en cada tick de realtime

// --- Carga inicial ---------------------------------------------------------
async function cargarTodo() {
  const { data: s, error: eS } = await sb.from("salas").select("*").eq("id", salaId).single();
  if (eS) return abortar(eS.message);
  sala = s;
  $("#sala-nombre").textContent = s.nombre;
  $("#sala-codigo").textContent = "Código " + s.codigo;

  const { data: parts, error: eP } = await sb.from("participantes")
    .select("id, user_id, rol, nombre_mostrar, voz_activa, salido_en")
    .eq("sala_id", salaId);
  if (eP) return abortar(eP.message);
  participantes = new Map(parts.map((p) => [p.id, p]));

  miParticipante = parts.find((p) => p.user_id === user.id) || null;
  if (!miParticipante) return abortar("No estás en esta sala. Vuelve a entrar con el código.");

  const { data: sols } = await sb.from("solicitudes")
    .select("*")
    .eq("sala_id", salaId)
    .in("estado", ["pendiente", "aprobada"]);
  solicitudes = sols || [];

  const { data: archs } = await sb.from("archivos")
    .select("*")
    .eq("sala_id", salaId)
    .order("enviado_en", { ascending: false });
  archivos = archs || [];

  aplicarMiRol();
  pintar();
  refrescarPizarra();
  refrescarDiapositivas();
}

function abortar(msg) {
  document.body.innerHTML = `<main class="portada"><section class="tarjeta"><h1>Uy…</h1><p>${msg}</p><p><a href="/">Volver al inicio</a></p></section></main>`;
}

function aplicarMiRol() {
  $("#mi-rol").textContent = { dirigente: "Dirigente", alumno: "Alumno", oyente: "Oyente" }[miParticipante.rol];
  $("#mi-rol").dataset.rol = miParticipante.rol;

  // Los oyentes sin voz no ven la subida de archivos ni el botón de cámara/mic.
  const puedeHablar = miParticipante.rol !== "oyente" || miParticipante.voz_activa;
  $("#btn-mic").classList.toggle("oculto", !puedeHablar);
  $("#btn-cam").classList.toggle("oculto", !puedeHablar);
  $("#btn-pantalla").classList.toggle("oculto", miParticipante.rol === "oyente" && !miParticipante.voz_activa);

  // La mano alzada sólo la ven oyentes.
  $("#btn-mano").classList.toggle("oculto", miParticipante.rol !== "oyente");

  // Subir archivo: alumnos y dirigente. Oyentes con voz, también.
  $("#zona-subir").classList.toggle("oculto", miParticipante.rol === "oyente" && !miParticipante.voz_activa);
  if (miParticipante.rol === "dirigente") {
    $("#zona-subir-pista").textContent = "Se comparte con la sala. Tú eliges destinatarios.";
  }
}

// --- Pintar UI -------------------------------------------------------------
function pintar() {
  pintarGente();
  pintarSolicitudes();
  pintarArchivos();
}

function pintarGente() {
  const dirigentes = [], alumnos = [], oyentes = [];
  for (const p of participantes.values()) {
    if (p.salido_en) continue;
    if (p.rol === "dirigente") dirigentes.push(p);
    else if (p.rol === "alumno") alumnos.push(p);
    else oyentes.push(p);
  }

  $("#lista-dirigente").innerHTML = dirigentes.map(fila).join("");
  $("#lista-alumnos").innerHTML = alumnos.map(fila).join("");
  $("#lista-oyentes").innerHTML = oyentes.map(fila).join("");
  $("#conteo-alumnos").textContent = `(${alumnos.length})`;
  $("#conteo-oyentes").textContent = `(${oyentes.length})`;

  // Al dirigente le enseñamos los botones para cambiar el rol.
  if (miParticipante.rol === "dirigente") {
    $$(".btn-rol").forEach((b) => b.addEventListener("click", onCambiarRol));
    $$(".btn-voz").forEach((b) => b.addEventListener("click", onDarQuitarVoz));
  }
}

function fila(p) {
  const eresTu = p.user_id === user.id ? '<span class="chip-mini">tú</span>' : '';
  const soyDir = miParticipante.rol === "dirigente";
  let acciones = "";
  if (soyDir && p.user_id !== user.id) {
    if (p.rol === "oyente") {
      acciones = `
        <button class="btn-mini btn-rol" data-id="${p.id}" data-nuevo="alumno">Promover a alumno</button>
        <button class="btn-mini btn-voz" data-id="${p.id}" data-voz="${p.voz_activa ? "0" : "1"}">${p.voz_activa ? "Quitar voz" : "Dar voz"}</button>
      `;
    } else if (p.rol === "alumno") {
      acciones = `<button class="btn-mini btn-rol" data-id="${p.id}" data-nuevo="oyente">Bajar a oyente</button>`;
    }
  }
  const marca = p.voz_activa && p.rol === "oyente" ? '<span class="chip-mini verde">con voz</span>' : '';
  return `
    <li>
      <div class="gente-nombre">${escapar(p.nombre_mostrar)} ${eresTu} ${marca}</div>
      ${acciones ? `<div class="gente-acciones">${acciones}</div>` : ""}
    </li>
  `;
}

function pintarSolicitudes() {
  const pendientes = solicitudes.filter((s) => s.estado === "pendiente");
  $("#badge-sol").textContent = pendientes.length;
  $("#badge-sol").classList.toggle("oculto", pendientes.length === 0);
  $("#sol-vacio").classList.toggle("oculto", pendientes.length > 0);

  if (miParticipante.rol !== "dirigente") {
    // Los no-dirigentes sólo ven "esperando respuesta" de sus propias solicitudes.
    const mias = solicitudes.filter((s) => s.participante_id === miParticipante.id);
    $("#lista-solicitudes").innerHTML = mias.map((s) => `
      <li><div class="sol-nombre">Tu petición (${etiquetaTipo(s.tipo)})</div>
          <div class="sol-estado">${etiquetaEstado(s.estado)}</div></li>
    `).join("");
    return;
  }

  $("#lista-solicitudes").innerHTML = pendientes.map((s) => {
    const p = participantes.get(s.participante_id);
    if (!p) return "";
    return `
      <li>
        <div class="sol-nombre">${escapar(p.nombre_mostrar)} — ${etiquetaTipo(s.tipo)}</div>
        <div class="sol-acciones">
          <button class="btn-mini verde" data-sol="${s.id}" data-accion="aprobar">Aprobar</button>
          <button class="btn-mini" data-sol="${s.id}" data-accion="rechazar">Rechazar</button>
        </div>
      </li>
    `;
  }).join("");
  $$("[data-sol]").forEach((b) => b.addEventListener("click", onResolverSolicitud));
}

function pintarArchivos() {
  const esDir = miParticipante.rol === "dirigente";
  const visibles = archivos.filter((a) => {
    if (esDir) return true;                                    // el dirigente ve todo
    if (a.remitente_id === miParticipante.id) return true;      // los tuyos siempre
    if (!a.aprobado) return false;
    if (a.destinatarios === "todos") return true;
    if (a.destinatarios === "alumnos" && miParticipante.rol !== "oyente") return true;
    return false;
  });
  $("#lista-archivos").innerHTML = visibles.map((a) => {
    const rem = participantes.get(a.remitente_id);
    const nombreRem = rem ? escapar(rem.nombre_mostrar) : "—";
    const mio = a.remitente_id === miParticipante.id;
    let etiquetaEstado = "";
    if (mio && !a.aprobado) etiquetaEstado = '<span class="chip-mini">esperando al dirigente</span>';
    if (a.aprobado) etiquetaEstado = `<span class="chip-mini verde">visible: ${a.destinatarios}</span>`;
    let acciones = "";
    if (esDir && !a.aprobado) {
      acciones = `<button class="btn-mini verde" data-arch="${a.id}" data-accion="autorizar">Autorizar…</button>
                  <button class="btn-mini" data-arch="${a.id}" data-accion="descartar">Descartar</button>`;
    }
    return `
      <li>
        <div>
          <div class="arch-nombre">${escapar(a.nombre)}</div>
          <div class="arch-meta">de ${nombreRem} · ${(a.tamano_bytes || 0) > 0 ? formatoTamano(a.tamano_bytes) : ""}</div>
          ${etiquetaEstado}
        </div>
        <div class="arch-acciones">
          ${a.aprobado ? `<button class="btn-mini" data-descargar="${a.id}">Descargar</button>` : ""}
          ${acciones}
        </div>
      </li>
    `;
  }).join("");
  $$("[data-arch]").forEach((b) => b.addEventListener("click", onArchivoAccion));
  $$("[data-descargar]").forEach((b) => b.addEventListener("click", onDescargar));
}

function escapar(t) { return String(t || "").replace(/[<>&"']/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"}[c])); }
function etiquetaTipo(t) { return { mano: "levanta la mano", compartir: "quiere compartir pantalla", archivo: "quiere pasar archivo", pizarra: "quiere tomar la pizarra", presentar: "quiere presentar diapositivas" }[t] || t; }
function etiquetaEstado(e) { return { pendiente: "En espera", aprobada: "Autorizada", rechazada: "Rechazada", revocada: "Cerrada" }[e] || e; }
function formatoTamano(b) { if (b < 1024) return `${b} B`; if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`; return `${(b/1024/1024).toFixed(1)} MB`; }

// --- Handlers --------------------------------------------------------------
async function onCambiarRol(e) {
  const id = e.currentTarget.dataset.id;
  const nuevo = e.currentTarget.dataset.nuevo;
  const { error } = await sb.from("participantes").update({ rol: nuevo, voz_activa: false }).eq("id", id);
  if (error) return alert(error.message);
  await sincronizarPermisosLiveKit(id, nuevo === "oyente" ? "oyente" : "alumno", false);
}

async function onDarQuitarVoz(e) {
  const id = e.currentTarget.dataset.id;
  const nueva = e.currentTarget.dataset.voz === "1";
  const { error } = await sb.from("participantes").update({ voz_activa: nueva }).eq("id", id);
  if (error) return alert(error.message);
  await sincronizarPermisosLiveKit(id, "oyente", nueva);
}

async function onResolverSolicitud(e) {
  const solId = e.currentTarget.dataset.sol;
  const accion = e.currentTarget.dataset.accion;
  const sol = solicitudes.find((s) => s.id === solId);
  if (!sol) return;

  if (accion === "aprobar") {
    const nuevoEstado = { estado: "aprobada", resuelta_en: new Date().toISOString() };
    const { error } = await sb.from("solicitudes").update(nuevoEstado).eq("id", solId);
    if (error) return alert(error.message);

    // Efecto: mano/compartir dan voz al oyente; archivo abre el diálogo;
    // pizarra pasa el control al que la pidió.
    if (sol.tipo === "mano" || sol.tipo === "compartir") {
      await sb.from("participantes").update({ voz_activa: true }).eq("id", sol.participante_id);
      await sincronizarPermisosLiveKit(sol.participante_id, "oyente", true);
    } else if (sol.tipo === "pizarra") {
      await sb.from("salas").update({
        pizarra_abierta: true,
        pizarra_controlador_id: sol.participante_id,
      }).eq("id", salaId);
    } else if (sol.tipo === "presentar") {
      await sb.from("salas").update({
        presentacion_presentador_id: sol.participante_id,
      }).eq("id", salaId);
    }
  } else {
    await sb.from("solicitudes").update({ estado: "rechazada", resuelta_en: new Date().toISOString() }).eq("id", solId);
  }
}

async function sincronizarPermisosLiveKit(participanteId, rolBase, vozActiva) {
  const puedePublicar = rolBase !== "oyente" || vozActiva;
  try {
    const { data: { session } } = await sb.auth.getSession();
    await fetch(PERMISO_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ salaId, participanteId, puedePublicar }),
    });
  } catch (err) {
    console.warn("no se pudo mover permiso en LiveKit", err);
  }
}

// --- Subir/aprobar/descargar archivos --------------------------------------
$("#input-archivo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  e.target.value = "";

  const nombreLimpio = f.name.replace(/[^\w.\-]+/g, "_");
  const ruta = `${salaId}/${miParticipante.id}/${Date.now()}_${nombreLimpio}`;

  const { error: eUp } = await sb.storage.from(STORAGE_BUCKET).upload(ruta, f, { upsert: false });
  if (eUp) return alert("No se pudo subir: " + eUp.message);

  const esDir = miParticipante.rol === "dirigente";
  if (esDir) {
    // El dirigente elige destinatarios antes de insertar.
    $("#dlg-archivo-nombre").textContent = f.name;
    const dlg = $("#dlg-destinatarios");
    dlg.returnValue = "";
    dlg.showModal();
    dlg.addEventListener("close", async function finalizar() {
      dlg.removeEventListener("close", finalizar);
      if (dlg.returnValue !== "ok") {
        await sb.storage.from(STORAGE_BUCKET).remove([ruta]);
        return;
      }
      const dest = dlg.querySelector('input[name="dest"]:checked').value;
      await sb.from("archivos").insert({
        sala_id: salaId,
        remitente_id: miParticipante.id,
        nombre: f.name,
        storage_path: ruta,
        tamano_bytes: f.size,
        destinatarios: dest,
        aprobado: true,
        aprobado_por: miParticipante.id,
        aprobado_en: new Date().toISOString(),
      });
    }, { once: true });
    return;
  }

  // Cualquiera que no es dirigente: queda como no aprobado. El dirigente autoriza.
  await sb.from("archivos").insert({
    sala_id: salaId,
    remitente_id: miParticipante.id,
    nombre: f.name,
    storage_path: ruta,
    tamano_bytes: f.size,
    destinatarios: "solo_dirigente",
    aprobado: false,
  });
});

async function onArchivoAccion(e) {
  const id = e.currentTarget.dataset.arch;
  const accion = e.currentTarget.dataset.accion;
  const a = archivos.find((x) => x.id === id);
  if (!a) return;
  if (accion === "descartar") {
    await sb.storage.from(STORAGE_BUCKET).remove([a.storage_path]);
    await sb.from("archivos").delete().eq("id", id);
    return;
  }
  if (accion === "autorizar") {
    $("#dlg-archivo-nombre").textContent = a.nombre;
    const dlg = $("#dlg-destinatarios");
    dlg.returnValue = "";
    dlg.showModal();
    dlg.addEventListener("close", async function fin() {
      dlg.removeEventListener("close", fin);
      if (dlg.returnValue !== "ok") return;
      const dest = dlg.querySelector('input[name="dest"]:checked').value;
      await sb.from("archivos").update({
        aprobado: true,
        destinatarios: dest,
        aprobado_por: miParticipante.id,
        aprobado_en: new Date().toISOString(),
      }).eq("id", id);
    }, { once: true });
  }
}

async function onDescargar(e) {
  const id = e.currentTarget.dataset.descargar;
  const a = archivos.find((x) => x.id === id);
  if (!a) return;
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(a.storage_path, 300);
  if (error) return alert(error.message);
  window.open(data.signedUrl, "_blank");
}

// --- Mano alzada -----------------------------------------------------------
$("#btn-mano").addEventListener("click", async () => {
  const existe = solicitudes.find((s) => s.participante_id === miParticipante.id && s.tipo === "mano" && s.estado === "pendiente");
  if (existe) {
    await sb.from("solicitudes").update({ estado: "revocada", resuelta_en: new Date().toISOString() }).eq("id", existe.id);
    $("#btn-mano").classList.remove("pulsando");
    return;
  }
  const { error } = await sb.from("solicitudes").insert({
    sala_id: salaId,
    participante_id: miParticipante.id,
    tipo: "mano",
  });
  if (error) return alert(error.message);
  $("#btn-mano").classList.add("pulsando");
});

// --- Controles de mic/cámara/pantalla en LiveKit ---------------------------
$("#btn-mic").addEventListener("click", async () => {
  if (!room) return;
  const activo = room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(!activo);
  $("#btn-mic").dataset.estado = !activo ? "on" : "off";
});
$("#btn-cam").addEventListener("click", async () => {
  if (!room) return;
  const activo = room.localParticipant.isCameraEnabled;
  await room.localParticipant.setCameraEnabled(!activo);
  $("#btn-cam").dataset.estado = !activo ? "on" : "off";
});
$("#btn-pantalla").addEventListener("click", async () => {
  if (!room) return;
  if (miParticipante.rol !== "dirigente") {
    // Alumno / oyente con voz: pide permiso al dirigente antes de compartir.
    const yaPide = solicitudes.find((s) => s.participante_id === miParticipante.id && s.tipo === "compartir" && s.estado === "pendiente");
    if (!yaPide) {
      await sb.from("solicitudes").insert({ sala_id: salaId, participante_id: miParticipante.id, tipo: "compartir" });
      alert("Le pedí permiso al dirigente para compartir tu pantalla.");
      return;
    }
    return;
  }
  // El dirigente comparte directo.
  await toggleCompartirPantalla();
});

async function toggleCompartirPantalla() {
  const yaComparte = room.localParticipant.isScreenShareEnabled;
  await room.localParticipant.setScreenShareEnabled(!yaComparte);
  $("#btn-pantalla").dataset.estado = !yaComparte ? "on" : "off";
}

// --- Pizarra ---------------------------------------------------------------
$("#btn-pizarra").addEventListener("click", async () => {
  // Dirigente: la abre/cierra directo y él toma el control por defecto.
  if (miParticipante.rol === "dirigente") {
    const abrir = !sala.pizarra_abierta;
    const actualizacion = abrir
      ? { pizarra_abierta: true, pizarra_controlador_id: miParticipante.id }
      : { pizarra_abierta: false, pizarra_controlador_id: null };
    const { error } = await sb.from("salas").update(actualizacion).eq("id", salaId);
    if (error) return alert(error.message);
    return;
  }
  // Alumno con la pizarra ya abierta: pide el control.
  if (miParticipante.rol === "alumno" && sala.pizarra_abierta) {
    const yaPide = solicitudes.find((s) =>
      s.participante_id === miParticipante.id && s.tipo === "pizarra" && s.estado === "pendiente");
    if (yaPide) return;
    await sb.from("solicitudes").insert({
      sala_id: salaId, participante_id: miParticipante.id, tipo: "pizarra",
    });
    alert("Le pedí permiso al dirigente para tomar la pizarra.");
    return;
  }
  // Oyentes: nada; el botón está oculto para ellos.
});

function refrescarPizarra() {
  const abierta = !!sala.pizarra_abierta;
  const soyControlador = sala.pizarra_controlador_id === miParticipante.id;
  const soyDirigente = miParticipante.rol === "dirigente";

  $("#tarima").classList.toggle("oculto", abierta);
  $("#pizarra").classList.toggle("oculto", !abierta);
  $("#btn-pizarra").dataset.estado = abierta ? "on" : "off";

  if (abierta && !pizarra) {
    pizarra = crearPizarra({
      salaId, sb,
      participanteId: miParticipante.id,
      esControlador: soyControlador,
      esDirigente: soyDirigente,
    });
  } else if (abierta && pizarra) {
    pizarra.setControlador(soyControlador);
    pizarra.setDirigente(soyDirigente);
  } else if (!abierta && pizarra) {
    pizarra.limpiar();
    pizarra = null;
  }

  // Etiqueta de estado en la toolbar.
  const estadoLbl = $("#pz-estado-control");
  if (estadoLbl && abierta) {
    if (soyControlador) estadoLbl.textContent = "Tú controlas";
    else {
      const c = participantes.get(sala.pizarra_controlador_id);
      estadoLbl.textContent = c ? `Controla: ${c.nombre_mostrar}` : "Nadie controla";
    }
  }

  // Ocultar el botón de pizarra a los oyentes.
  $("#btn-pizarra").classList.toggle("oculto", miParticipante.rol === "oyente");

  // Repintar los videos en el destino correcto (tarima o tira).
  if (window.__repintarVideos) window.__repintarVideos();
}

// --- Diapositivas ----------------------------------------------------------
$("#btn-diapositivas").addEventListener("click", async () => {
  const hay = !!sala.presentacion_storage_path;
  const soyDir = miParticipante.rol === "dirigente";

  if (!hay && soyDir) {
    // Sin presentación cargada — abre el "vacío" con botón de subir.
    await sb.from("salas").update({
      pizarra_abierta: false,          // no puedes tener las dos abiertas
      presentacion_storage_path: null, // se abrirá al subir
    }).eq("id", salaId);
    // Truquillo: para forzar mostrar la vista vacía sin sub-presentación aún,
    // marcamos una "sesión de subida" cambiando la página a -1.
    // Más simple: sólo abrimos el input.
    $("#dp-input").click();
    return;
  }
  if (!hay && !soyDir) {
    alert("El dirigente todavía no ha cargado una presentación.");
    return;
  }
  // Ya hay presentación — el botón la abre/cierra la VISTA (no borra la
  // presentación cargada). Sólo el dirigente cierra del todo.
  const abierta = document.getElementById("diapositivas") && !$("#diapositivas").classList.contains("oculto");
  if (soyDir && abierta) {
    await sb.from("salas").update({
      presentacion_storage_path: null,
      presentacion_nombre: null,
      presentacion_paginas: null,
      presentacion_pagina_actual: 1,
      presentacion_presentador_id: null,
    }).eq("id", salaId);
    // Y borra el archivo de Storage
    if (sala.presentacion_storage_path) {
      sb.storage.from(STORAGE_BUCKET).remove([sala.presentacion_storage_path]).catch(() => {});
    }
    return;
  }
  // Alumno: pide presentar
  if (miParticipante.rol === "alumno" && hay && sala.presentacion_presentador_id !== miParticipante.id) {
    const yaPide = solicitudes.find((s) =>
      s.participante_id === miParticipante.id && s.tipo === "presentar" && s.estado === "pendiente");
    if (yaPide) return;
    await sb.from("solicitudes").insert({
      sala_id: salaId, participante_id: miParticipante.id, tipo: "presentar",
    });
    alert("Le pedí permiso al dirigente para tomar el control de las diapositivas.");
  }
});

$("#dp-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  e.target.value = "";
  if (f.type !== "application/pdf") { alert("Debe ser un PDF."); return; }

  const ruta = `presentaciones/${salaId}/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, "_")}`;
  const { error: eUp } = await sb.storage.from(STORAGE_BUCKET).upload(ruta, f, { upsert: false });
  if (eUp) return alert("No se pudo subir: " + eUp.message);

  // Contamos páginas cargando el PDF localmente antes de anunciar la subida.
  const pdfjs = await cargarPdfjs();
  const arr = await f.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: arr }).promise;
  const paginas = doc.numPages;
  await doc.destroy();

  await sb.from("salas").update({
    presentacion_storage_path: ruta,
    presentacion_nombre: f.name,
    presentacion_paginas: paginas,
    presentacion_pagina_actual: 1,
    presentacion_presentador_id: miParticipante.id,
    pizarra_abierta: false,
  }).eq("id", salaId);
});

async function urlFirmadaPresentacion() {
  if (!sala.presentacion_storage_path) return null;
  const { data, error } = await sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(sala.presentacion_storage_path, 60 * 60 * 3);
  if (error) return null;
  return data.signedUrl;
}

async function refrescarDiapositivas() {
  const hay = !!sala.presentacion_storage_path;
  const dp = $("#diapositivas");

  // Mostrar/ocultar la sección
  dp.classList.toggle("oculto", !hay);
  $("#btn-diapositivas").dataset.estado = hay ? "on" : "off";
  $("#btn-diapositivas").classList.toggle("oculto", miParticipante.rol === "oyente" && !hay);

  // Si la pizarra está abierta y las diapos también, la pizarra manda.
  if (hay) {
    $("#tarima").classList.add("oculto");
    if (pizarra) $("#pizarra").classList.add("oculto");
  }

  if (!hay) {
    if (visorDiapo) { await visorDiapo.destruir().catch(() => {}); visorDiapo = null; ultimoStorageDiapo = null; }
    return;
  }

  // Cargar el PDF si cambió (o si aún no hay visor)
  if (!visorDiapo || ultimoStorageDiapo !== sala.presentacion_storage_path) {
    if (visorDiapo) { try { await visorDiapo.destruir(); } catch {} visorDiapo = null; }
    const url = await urlFirmadaPresentacion();
    if (!url) return;
    visorDiapo = await crearVisorDiapositivas({
      url,
      contenedorCanvas: $("#dp-canvas"),
    });
    ultimoStorageDiapo = sala.presentacion_storage_path;
    await visorDiapo.ir(sala.presentacion_pagina_actual || 1);
  } else {
    // Sólo cambió la página
    if (visorDiapo.pagina !== sala.presentacion_pagina_actual) {
      await visorDiapo.ir(sala.presentacion_pagina_actual);
    }
  }

  // Toolbar
  $("#dp-pagina").textContent = `${sala.presentacion_pagina_actual} / ${sala.presentacion_paginas}`;
  $("#dp-nombre").textContent = sala.presentacion_nombre || "";
  const soyPresentador = sala.presentacion_presentador_id === miParticipante.id;
  const soyDir = miParticipante.rol === "dirigente";
  $("#dp-anterior").disabled = !soyPresentador || sala.presentacion_pagina_actual <= 1;
  $("#dp-siguiente").disabled = !soyPresentador || sala.presentacion_pagina_actual >= (sala.presentacion_paginas || 1);
  $("#dp-cerrar").classList.toggle("oculto", !soyDir);
  const presentador = participantes.get(sala.presentacion_presentador_id);
  $("#dp-estado").textContent = soyPresentador ? "Tú presentas" : (presentador ? `Presenta: ${presentador.nombre_mostrar}` : "Nadie presenta");

  if (window.__repintarVideos) window.__repintarVideos();
}

async function cambiarPagina(delta) {
  if (sala.presentacion_presentador_id !== miParticipante.id) return;
  const nueva = Math.max(1, Math.min((sala.presentacion_pagina_actual || 1) + delta, sala.presentacion_paginas || 1));
  if (nueva === sala.presentacion_pagina_actual) return;
  await sb.from("salas").update({ presentacion_pagina_actual: nueva }).eq("id", salaId);
}

$("#dp-anterior").addEventListener("click", () => cambiarPagina(-1));
$("#dp-siguiente").addEventListener("click", () => cambiarPagina(1));
$("#dp-cerrar").addEventListener("click", () => $("#btn-diapositivas").click());

// Teclado: flechas ←/→/PageUp/PageDown para el presentador
document.addEventListener("keydown", (e) => {
  if (!sala || sala.presentacion_presentador_id !== miParticipante?.id) return;
  if (["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) return;
  if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); cambiarPagina(-1); }
  else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); cambiarPagina(1); }
});

// Pantalla completa (pizarra y diapositivas)
function pedirFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
}
$("#pz-fullscreen").addEventListener("click", () => pedirFullscreen($("#pizarra")));
$("#dp-fullscreen").addEventListener("click", () => pedirFullscreen($("#diapositivas")));

// --- Tabs del panel lateral ------------------------------------------------
$$(".panel-tabs .tab").forEach((t) => t.addEventListener("click", () => {
  $$(".panel-tabs .tab").forEach((x) => x.classList.remove("activo"));
  t.classList.add("activo");
  const name = t.dataset.tab;
  $$(".tab-contenido").forEach((c) => c.classList.toggle("activo", c.dataset.tab === name));
}));

$("#btn-salir").addEventListener("click", async () => {
  try { if (room) await room.disconnect(); } catch {}
  await sb.from("participantes").update({ salido_en: new Date().toISOString() }).eq("id", miParticipante.id);
  // Si el dirigente sale, cierra la sala.
  if (miParticipante.rol === "dirigente") {
    await sb.from("salas").update({ cerrada_en: new Date().toISOString() }).eq("id", salaId);
  }
  await salir();
  location.replace("/");
});

// --- Realtime --------------------------------------------------------------
function suscribir() {
  sb.channel(`sala-${salaId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "connectalive", table: "salas", filter: `id=eq.${salaId}` },
      (payload) => {
        const antes = sala;
        sala = payload.new;
        $("#sala-nombre").textContent = sala.nombre;
        if (antes.pizarra_abierta !== sala.pizarra_abierta
          || antes.pizarra_controlador_id !== sala.pizarra_controlador_id) {
          refrescarPizarra();
        }
        if (antes.presentacion_storage_path !== sala.presentacion_storage_path
          || antes.presentacion_pagina_actual !== sala.presentacion_pagina_actual
          || antes.presentacion_presentador_id !== sala.presentacion_presentador_id) {
          refrescarDiapositivas();
        }
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "participantes", filter: `sala_id=eq.${salaId}` },
      async (payload) => {
        if (payload.eventType === "DELETE") {
          participantes.delete(payload.old.id);
        } else {
          participantes.set(payload.new.id, payload.new);
          if (payload.new.user_id === user.id) {
            const yo = miParticipante;
            miParticipante = payload.new;
            // Si me cambió el rol o me dieron/quitaron voz, revisar mi token.
            if (yo.rol !== payload.new.rol || yo.voz_activa !== payload.new.voz_activa) {
              aplicarMiRol();
              await revisarMiToken();
            }
          }
        }
        pintar();
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "solicitudes", filter: `sala_id=eq.${salaId}` },
      (payload) => {
        if (payload.eventType === "DELETE") {
          solicitudes = solicitudes.filter((s) => s.id !== payload.old.id);
        } else {
          const i = solicitudes.findIndex((s) => s.id === payload.new.id);
          if (i >= 0) solicitudes[i] = payload.new; else solicitudes.push(payload.new);
        }
        pintar();
      })
    .on("postgres_changes", { event: "*", schema: "connectalive", table: "archivos", filter: `sala_id=eq.${salaId}` },
      (payload) => {
        if (payload.eventType === "DELETE") {
          archivos = archivos.filter((a) => a.id !== payload.old.id);
        } else {
          const i = archivos.findIndex((a) => a.id === payload.new.id);
          if (i >= 0) archivos[i] = payload.new; else archivos.unshift(payload.new);
        }
        pintar();
      })
    .subscribe();
}

async function revisarMiToken() {
  // Con `permiso.js` el servidor ya movió los permisos en LiveKit; no necesito
  // reconectar. Aún así, si en algún caso el SDK no reaplica solo, sería aquí.
}

// --- LiveKit ---------------------------------------------------------------
async function conectarLK() {
  const rolTecnico = miParticipante.rol === "oyente" && !miParticipante.voz_activa ? "oyente" :
                     miParticipante.rol === "dirigente" ? "dirigente" : "alumno";
  miTokenRol = rolTecnico;
  const { room: r, LK: lk } = await conectarSala({
    salaId,
    participanteId: miParticipante.id,
    rol: rolTecnico,
  });
  room = r; LK = lk;

  const pintarTarima = () => {
    // Cuando pizarra o diapositivas están abiertas, los videos se van a su
    // tira lateral. Si ninguna, van a la tarima principal.
    const dpAbierta = !!sala?.presentacion_storage_path;
    const pzAbierta = !!sala?.pizarra_abierta && !dpAbierta;
    let destino;
    if (dpAbierta) destino = $("#tira-videos-dp");
    else if (pzAbierta) destino = $("#tira-videos");
    else destino = $("#tarima");
    // Limpiar los otros dos para no dejar duplicados
    [$("#tarima"), $("#tira-videos"), $("#tira-videos-dp")].forEach((n) => {
      if (n && n !== destino) n.innerHTML = "";
    });
    destino.innerHTML = "";
    const remotos = Array.from(room.remoteParticipants.values());
    const todos = [room.localParticipant, ...remotos];
    for (const p of todos) {
      const box = document.createElement("div");
      box.className = "video-box";
      box.dataset.identity = p.identity;
      const label = document.createElement("div");
      label.className = "video-label";
      label.textContent = p.name || p.identity;
      box.appendChild(label);

      for (const pub of p.trackPublications.values()) {
        if (pub.track && pub.kind === "video") {
          // Screen share: `contain` (se ve toda la pantalla, sin recorte) y
          // la caja ocupa toda la fila del grid para que se lea. Cámara:
          // `cover` como antes.
          const esScreen = pub.source === "screen_share" || pub.track?.source === "screen_share";
          const el = pub.track.attach();
          el.classList.add("video-media");
          if (esScreen) {
            el.classList.add("video-screen");
            box.classList.add("es-screen");
          }
          box.appendChild(el);
        }
        if (pub.track && pub.kind === "audio" && p !== room.localParticipant) {
          const el = pub.track.attach();
          el.style.display = "none";
          box.appendChild(el);
        }
      }
      destino.appendChild(box);
    }
    if (destino.children.length === 0 && destino.id === "tarima") {
      destino.innerHTML = '<div class="tarima-vacia">Nadie está transmitiendo todavía.</div>';
    }
  };
  // Exponer para poder repintar cuando la pizarra se abre o cierra.
  window.__repintarVideos = pintarTarima;

  const eventos = [LK.RoomEvent.TrackSubscribed, LK.RoomEvent.TrackUnsubscribed,
                   LK.RoomEvent.ParticipantConnected, LK.RoomEvent.ParticipantDisconnected,
                   LK.RoomEvent.LocalTrackPublished, LK.RoomEvent.LocalTrackUnpublished,
                   LK.RoomEvent.TrackMuted, LK.RoomEvent.TrackUnmuted];
  for (const e of eventos) room.on(e, pintarTarima);
  pintarTarima();
}

// --- Arranque --------------------------------------------------------------
try {
  await cargarLivekit();          // precarga el SDK mientras hacemos consultas
  await cargarTodo();
  suscribir();
  await conectarLK();
} catch (err) {
  console.error(err);
  abortar(err.message || "Falló el arranque de la sala");
}
