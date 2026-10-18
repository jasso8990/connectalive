// Sincroniza un tablero libre (pizarra o presentación sin sala) entre
// dispositivos.
//
//   • Lo vivo viaja por Supabase Realtime BROADCAST (no toca la base).
//   • Lo que debe sobrevivir a un F5 o a quien llega tarde se guarda con
//     `tablero_guardar` (con retraso corto, para no escribir en cada trazo).
//   • Sólo un dispositivo controla a la vez: `tablero_tomar_control` le da
//     un token que se renueva con un latido cada 30 s. El control es suyo
//     hasta que lo suelte (`soltarControl`); sólo vence tras 3 horas sin
//     latido. El token se guarda en localStorage: si la app se cierra o el
//     celular se bloquea, al volver se recupera el mismo control.
//   • Tras horas abierto (pantalla apagada, Wi-Fi que se cae) el canal de
//     Realtime puede morir sin avisar: al volver al frente y cada 20 s se
//     revisa y, si hace falta, se abre de nuevo.

import { sb } from "./supabase.js";
import { STORAGE_BUCKET } from "./config.js";

const claveToken = (c) => `cl_control_${c}`;
const leerToken = (c) => { try { return localStorage.getItem(claveToken(c)); } catch { return null; } };
const guardarToken = (c, t) => { try { t ? localStorage.setItem(claveToken(c), t) : localStorage.removeItem(claveToken(c)); } catch {} };

// --- Dónde me quedé --------------------------------------------------------
// Si la app se cierra a media presentación, Inicio ofrece volver.
const CLAVE_ULTIMA = "cl-ultima";
export function recordarUltima(u) {
  try { localStorage.setItem(CLAVE_ULTIMA, JSON.stringify({ ...u, ts: Date.now() })); } catch {}
}
export function leerUltima() {
  try {
    const u = JSON.parse(localStorage.getItem(CLAVE_ULTIMA) || "null");
    if (!u?.codigo || !u.url?.startsWith("/") || Date.now() - u.ts > 24 * 3600 * 1000) return null;
    return u;
  } catch { return null; }
}
export function olvidarUltima(codigo) {
  try {
    const u = JSON.parse(localStorage.getItem(CLAVE_ULTIMA) || "null");
    if (!codigo || u?.codigo === codigo) localStorage.removeItem(CLAVE_ULTIMA);
  } catch {}
}

export function limpiarCodigo(texto) {
  const t = String(texto || "").trim().toUpperCase();
  const m = t.match(/[?&]C=([A-Z0-9]{6})/);
  return (m ? m[1] : t.replace(/[^A-Z0-9]/g, "")).slice(0, 6);
}

export async function crearTablero(tipo, pdfNombre = null) {
  const { data, error } = await sb.rpc("tablero_crear", { p_tipo: tipo, p_pdf_nombre: pdfNombre });
  if (error) throw error;
  // Limpieza de los PDF de sesiones viejas que la base ya olvidó.
  const viejos = data.pdfs_viejos || [];
  if (viejos.length) sb.storage.from(STORAGE_BUCKET).remove(viejos).catch(() => {});
  return data;
}

export async function leerTablero(codigo) {
  const { data, error } = await sb.rpc("tablero_leer", { p_codigo: codigo });
  if (error) throw error;
  return data;
}

// Un error de red (sin respuesta de la base) se reintenta; uno de la base no.
const esDeRed = (e) => !e?.code && /fetch|network|load failed|timeout/i.test(String(e?.message));

export function conectarTablero(codigo, eventos = {}) {
  let token = leerToken(codigo);
  let latido = null;
  let pendiente = {};
  let temporizador = null;
  let reintentos = 0;
  let canal = null;
  let unido = false;
  let yaSeUnio = false;
  let cerrado = false;

  function abrirCanal() {
    if (canal) sb.removeChannel(canal);
    unido = false;
    const este = sb.channel(`cl-tablero-${codigo}`, { config: { broadcast: { self: false } } });
    canal = este;
    for (const ev of ["trazo", "trazos", "vista", "pagina", "cerrado", "hola", "pide"]) {
      este.on("broadcast", { event: ev }, ({ payload }) => eventos[ev]?.(payload));
    }
    // Alguien soltó el control (o la PC se lo dio a otra cuenta). Si era el
    // mío, el latido lo confirma y avisa con `controlPerdido`.
    for (const ev of ["suelto", "respuesta"]) {
      este.on("broadcast", { event: ev }, async ({ payload }) => {
        if (token) await latir();
        eventos[ev]?.(payload);
      });
    }
    este.subscribe((estado) => {
      if (este !== canal) return;
      const ok = estado === "SUBSCRIBED";
      // Al reconectarse se relee lo guardado: pudo perderse algo.
      if (ok && !unido && yaSeUnio) eventos.volver?.();
      if (ok) yaSeUnio = true;
      unido = ok;
      eventos.conexion?.(ok);
    });
  }
  abrirCanal();

  // Si el canal quedó cerrado o con error y no se repuso solo, se abre de nuevo.
  function revisarCanal() {
    if (cerrado || !navigator.onLine) return;
    if (!unido && ["closed", "errored"].includes(canal.state)) abrirCanal();
  }
  const vigilante = setInterval(revisarCanal, 20_000);

  // Al volver de segundo plano (celular bloqueado, pestaña oculta) el
  // broadcast pudo perder mensajes: se revisa el canal, se late de
  // inmediato (sin esperar los 30 s) y se relee lo guardado.
  const alVolver = async () => {
    if (document.visibilityState !== "visible" || cerrado) return;
    revisarCanal();
    if (token) await latir();
    eventos.volver?.();
  };
  document.addEventListener("visibilitychange", alVolver);
  window.addEventListener("online", alVolver);

  function enviar(event, payload) {
    canal.send({ type: "broadcast", event, payload }).catch(() => {});
  }

  async function volcar() {
    temporizador = null;
    const cambios = pendiente;
    pendiente = {};
    if (!Object.keys(cambios).length) return;
    const { error } = await sb.rpc("tablero_guardar", { p_codigo: codigo, p_token: token, ...cambios });
    if (!error) { reintentos = 0; return; }
    // Sin red: se guarda en cuanto vuelva (lo nuevo pisa lo viejo).
    if (esDeRed(error) && reintentos < 20) {
      reintentos++;
      pendiente = { ...cambios, ...pendiente };
      temporizador = setTimeout(volcar, 3000);
      return;
    }
    reintentos = 0;
    eventos.error?.(error);
  }

  function guardar(cambios, retraso = 600) {
    Object.assign(pendiente, cambios);
    if (temporizador) clearTimeout(temporizador);
    temporizador = setTimeout(volcar, retraso);
  }

  async function latir() {
    if (!token) return;
    const { data, error } = await sb.rpc("tablero_latido", { p_codigo: codigo, p_token: token });
    if (error) return;               // sin red: se intenta en el próximo
    if (data === false) {
      token = null;
      guardarToken(codigo, null);
      clearInterval(latido);
      eventos.controlPerdido?.();
    }
  }

  function arrancarLatido() {
    clearInterval(latido);
    latido = setInterval(latir, 30_000);
  }

  return {
    get tengoControl() { return !!token; },
    async tomarControl(forzar = false) {
      const { data, error } = await sb.rpc("tablero_tomar_control", {
        p_codigo: codigo, p_token: token, p_forzar: forzar,
      });
      if (error) throw error;
      token = data;
      guardarToken(codigo, token);
      arrancarLatido();
      return token;
    },
    // Deja el control para que otro dispositivo pueda entrar. Desde la PC
    // dueña (sin token) libera el de cualquier celular.
    async soltarControl() {
      clearInterval(latido);
      if (temporizador) { clearTimeout(temporizador); await volcar(); }
      const { error } = await sb.rpc("tablero_soltar_control", { p_codigo: codigo, p_token: token });
      if (error) throw error;
      token = null;
      guardarToken(codigo, null);
      enviar("suelto", {});
    },
    // Otra cuenta pide el control; la PC dueña lo ve y decide.
    async pedirControl() {
      const { error } = await sb.rpc("tablero_pedir_control", { p_codigo: codigo });
      if (error) throw error;
      enviar("pide", {});
    },
    async responderPedido(usuario, aceptar) {
      const { error } = await sb.rpc("tablero_responder_pedido", {
        p_codigo: codigo, p_user: usuario, p_aceptar: aceptar,
      });
      if (error) throw error;
      enviar("respuesta", { para: usuario, ok: aceptar });
    },
    trazo(t, terminado) { enviar("trazo", { t, fin: terminado }); },
    trazos(lista) { enviar("trazos", { lista }); guardar({ p_trazos: lista }); },
    guardarTrazos(lista) { guardar({ p_trazos: lista }); },
    vista(v) { enviar("vista", v); guardar({ p_zoom: v.zoom, p_pan_x: v.x, p_pan_y: v.y }, 300); },
    pagina(n) {
      enviar("pagina", { pagina: n });
      // Al cambiar de diapositiva la vista vuelve al 100 %.
      guardar({ p_pagina: n, p_zoom: 100, p_pan_x: 0, p_pan_y: 0 }, 150);
    },
    // El control avisa que llegó (la PC deja de enseñar el código gigante).
    hola() { enviar("hola", {}); },
    async cerrar() {
      enviar("cerrado", {});
      await volcar();
      clearInterval(latido);
      guardarToken(codigo, null);
    },
    desconectar() {
      cerrado = true;
      clearInterval(latido);
      clearInterval(vigilante);
      if (temporizador) { clearTimeout(temporizador); volcar(); }
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("online", alVolver);
      sb.removeChannel(canal);
    },
  };
}
