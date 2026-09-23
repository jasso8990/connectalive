// Cliente LiveKit por CDN. El SDK expone `LivekitClient` global (UMD).
// El bundle carga chico; no compilamos nada.

import { TOKEN_ENDPOINT } from "./config.js";

const CDN = "https://cdn.jsdelivr.net/npm/livekit-client@2.9.6/dist/livekit-client.umd.min.js";

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
  const { sb } = await import("./supabase.js");
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("sin sesión");
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ salaId, participanteId }),
  });
  if (!r.ok) {
    let cuerpo = null;
    try { cuerpo = await r.json(); } catch { /* no era JSON */ }
    // 402: clase terminada, plan vencido o sin minutos. El mensaje ya viene
    // escrito para la persona.
    if (r.status === 402 && cuerpo?.error) throw new Error(cuerpo.error);
    throw new Error(`No se pudo conectar el video (${r.status}${cuerpo?.error ? ` — ${cuerpo.error}` : ""})`);
  }
  return r.json();
}

/** Conecta a la sala LiveKit y devuelve la instancia de Room ya conectada. */
export async function conectarSala({ salaId, participanteId }) {
  const LK = await cargarLivekit();
  const { token, url } = await pedirToken({ salaId, participanteId });
  const room = new LK.Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution },
  });
  await room.connect(url, token);
  return { room, LK };
}
