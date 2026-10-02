// Cliente LiveKit por CDN. El SDK expone `LivekitClient` global (UMD).
// El bundle carga chico; no compilamos nada.

import { TOKEN_ENDPOINT } from "./config.js";

const CDN = "https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.min.js";

let _cargando = null;

/** Carga el SDK una sola vez y devuelve el namespace `LivekitClient`. */
export function cargarLivekit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (_cargando) return _cargando;
  _cargando = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = CDN;
    s.async = true;
    s.onload = () => res(window.LivekitClient);
    s.onerror = () => { _cargando = null; rej(new Error("No se pudo cargar el video (LiveKit)")); };
    document.head.appendChild(s);
  });
  return _cargando;
}

/** Pide token al backend y devuelve { token, url }. */
async function pedirToken({ salaId, participanteId }) {
  const { postConSesion } = await import("./auth.js");
  const r = await postConSesion(TOKEN_ENDPOINT, { salaId, participanteId });
  if (!r.ok) {
    let cuerpo = null;
    try { cuerpo = await r.json(); } catch { /* no era JSON */ }
    // 402: clase terminada, plan vencido o sin minutos. El mensaje ya viene
    // escrito para la persona.
    if (r.status === 402 && cuerpo?.error) {
      const e = new Error(cuerpo.error);
      e.sinPlan = true;
      throw e;
    }
    throw new Error(`No se pudo conectar el video (${r.status}${cuerpo?.error ? ` — ${cuerpo.error}` : ""})`);
  }
  return r.json();
}

// Micrófono, cámara y bocina que eligió esta persona (de este navegador).
// Van como preferencia, no como exigencia: si ese aparato ya no está
// conectado, el navegador usa el de siempre en vez de fallar.
const CLAVE_APARATOS = "cl-aparatos";
export function aparatosGuardados() {
  try { return JSON.parse(localStorage.getItem(CLAVE_APARATOS)) || {}; } catch { return {}; }
}
export function guardarAparato(kind, deviceId) {
  try { localStorage.setItem(CLAVE_APARATOS, JSON.stringify({ ...aparatosGuardados(), [kind]: deviceId })); } catch {}
}

/**
 * Conecta a la sala LiveKit y devuelve la instancia de Room ya conectada.
 * `alConfigurar(room)` corre antes de conectar, para colgar los eventos sin
 * perderse los primeros.
 */
export async function conectarSala({ salaId, participanteId, dirigente = false, alConfigurar }) {
  const LK = await cargarLivekit();
  const { token, url } = await pedirToken({ salaId, participanteId });
  const ap = aparatosGuardados();
  const room = new LK.Room({
    // Cada quien recibe la calidad del tamaño en que ve el video (y nada si
    // no lo ve), y quien transmite deja de mandar las capas que nadie pide.
    adaptiveStream: true,
    dynacast: true,
    // El dirigente casi siempre es el cuadro grande: 720p. Los demás, 540p.
    // La capa alta sólo viaja a quien lo ve en grande.
    videoCaptureDefaults: {
      resolution: (dirigente ? LK.VideoPresets.h720 : LK.VideoPresets.h540).resolution,
      ...(ap.videoinput ? { deviceId: ap.videoinput } : {}),
    },
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(ap.audioinput ? { deviceId: ap.audioinput } : {}),
    },
    publishDefaults: {
      // Voz: corta los silencios y manda redundancia para aguantar pérdidas.
      dtx: true,
      red: true,
      // Pantalla compartida a 1080p; las diapositivas y el texto mandan.
      screenShareEncoding: LK.ScreenSharePresets.h1080fps15.encoding,
    },
  });
  alConfigurar?.(room);
  await room.connect(url, token);
  // La bocina se aplica ya conectados y sólo si sigue enchufada: un id de
  // salida que ya no existe hace fallar el audio en vez de caer al de siempre.
  if (ap.audiooutput) {
    try {
      const salidas = await LK.Room.getLocalDevices("audiooutput", false);
      if (salidas.some((d) => d.deviceId === ap.audiooutput)) await room.switchActiveDevice("audiooutput", ap.audiooutput);
    } catch { /* este navegador no deja elegir bocina */ }
  }
  return { room, LK };
}

/** Opciones para compartir pantalla: nítido para texto y diapositivas. */
export const OPCIONES_PANTALLA = {
  contentHint: "detail",
  audio: false,
  selfBrowserSurface: "exclude",   // que no se comparta la misma pestaña de la clase
  surfaceSwitching: "include",
};
