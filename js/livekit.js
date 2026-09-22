// Cliente LiveKit por CDN. El SDK expone `LivekitClient` global (UMD).
// El bundle carga chico; no compilamos nada.

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
    s.onerror = () => rej(new Error("no se pudo cargar LiveKit"));
    document.head.appendChild(s);
  });
  return _cargando;
}

/** Pide token al backend y devuelve { token, url }. */
export async function pedirToken({ salaId, participanteId, rol }) {
  const { sb } = await import("./supabase.js");
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("sin sesión");
  const r = await fetch("/.netlify/functions/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ salaId, participanteId, rol }),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return r.json();
}

/** Conecta a la sala LiveKit y devuelve la instancia de Room ya conectada. */
export async function conectarSala({ salaId, participanteId, rol }) {
  const LK = await cargarLivekit();
  const { token, url } = await pedirToken({ salaId, participanteId, rol });
  const room = new LK.Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution },
  });
  await room.connect(url, token);
  return { room, LK };
}
