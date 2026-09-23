// Sincroniza un tablero libre (pizarra o presentación sin sala) entre
// dispositivos.
//
//   • Lo vivo viaja por Supabase Realtime BROADCAST (no toca la base).
//   • Lo que debe sobrevivir a un F5 o a quien llega tarde se guarda con
//     `tablero_guardar` (con retraso corto, para no escribir en cada trazo).
//   • Sólo un dispositivo controla a la vez: `tablero_tomar_control` le da
//     un token que se renueva con un latido cada 30 s. Si ese dispositivo
//     se apaga, a los 2 minutos otro puede tomarlo (o forzarlo).

import { sb } from "./supabase.js";
import { STORAGE_BUCKET } from "./config.js";

const claveToken = (c) => `cl_control_${c}`;
const leerToken = (c) => { try { return localStorage.getItem(claveToken(c)); } catch { return null; } };
const guardarToken = (c, t) => { try { t ? localStorage.setItem(claveToken(c), t) : localStorage.removeItem(claveToken(c)); } catch {} };

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

export function conectarTablero(codigo, eventos = {}) {
  let token = leerToken(codigo);
  let latido = null;
  let pendiente = {};
  let temporizador = null;

  const canal = sb.channel(`cl-tablero-${codigo}`, { config: { broadcast: { self: false } } });
  for (const ev of ["trazo", "trazos", "vista", "pagina", "cerrado", "hola"]) {
    canal.on("broadcast", { event: ev }, ({ payload }) => eventos[ev]?.(payload));
  }
  canal.subscribe((estado) => eventos.conexion?.(estado === "SUBSCRIBED"));

  // Al volver de segundo plano (celular bloqueado, pestaña oculta) el
  // broadcast pudo perder mensajes: se relee lo guardado.
  const alVolver = () => { if (document.visibilityState === "visible") eventos.volver?.(); };
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
    if (error) eventos.error?.(error);
  }

  function guardar(cambios, retraso = 600) {
    Object.assign(pendiente, cambios);
    if (temporizador) clearTimeout(temporizador);
    temporizador = setTimeout(volcar, retraso);
  }

  function arrancarLatido() {
    clearInterval(latido);
    latido = setInterval(async () => {
      if (!token) return;
      const { data } = await sb.rpc("tablero_latido", { p_codigo: codigo, p_token: token });
      if (data === false) { token = null; guardarToken(codigo, null); eventos.controlPerdido?.(); }
    }, 30_000);
  }

  return {
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
      clearInterval(latido);
      if (temporizador) { clearTimeout(temporizador); volcar(); }
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("online", alVolver);
      sb.removeChannel(canal);
    },
  };
}
