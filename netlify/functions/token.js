// Emite un JWT de LiveKit para el participante que lo pide.
//
// El navegador NUNCA firma su propio token: ese JWT lleva los permisos
// técnicos (canPublish, canSubscribe, roomAdmin) y si el usuario lo firmara,
// se los podría dar solo. Aquí se leen del estado real en Supabase y se
// firman con la API secret que sólo vive en el servidor.
//
// Variables de entorno (Netlify → Site → Environment variables):
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { AccessToken } from "livekit-server-sdk";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bckgumchkzlvbgcxjpwi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;

export default async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  if (!LK_KEY || !LK_SECRET || !LIVEKIT_URL) {
    return json({ error: "Falta configurar LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET en Netlify" }, 500);
  }
  if (!SERVICE_KEY) {
    return json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY en Netlify" }, 500);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const { salaId, participanteId } = body || {};
  if (!salaId || !participanteId) return json({ error: "faltan salaId o participanteId" }, 400);

  // Sacar el user_id de la sesión Supabase (el navegador manda el access token).
  const authHeader = req.headers.get("authorization") || "";
  const tokenSup = authHeader.replace(/^Bearer\s+/i, "");
  if (!tokenSup) return json({ error: "sin sesión" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: eU } = await admin.auth.getUser(tokenSup);
  if (eU || !userData?.user) return json({ error: "sesión inválida" }, 401);
  const userId = userData.user.id;

  // Confirmar que ese user_id es el dueño del participante en esa sala.
  const { data: p, error: eP } = await admin
    .schema("connectalive")
    .from("participantes")
    .select("id, sala_id, user_id, rol, voz_activa, nombre_mostrar")
    .eq("id", participanteId)
    .single();
  if (eP) return json({ error: `buscando participante: ${eP.message}`, code: eP.code }, 500);
  if (!p) return json({ error: `participante ${participanteId} no encontrado` }, 404);
  if (p.sala_id !== salaId) return json({ error: "sala equivocada" }, 400);
  if (p.user_id !== userId) return json({ error: "no eres ese participante" }, 403);

  const puedePublicar = p.rol !== "oyente" || p.voz_activa;

  const at = new AccessToken(LK_KEY, LK_SECRET, {
    identity: p.id,
    name: p.nombre_mostrar,
    ttl: 60 * 60 * 6, // 6 horas: alcanza para una sesión larga
  });
  at.addGrant({
    room: salaId,
    roomJoin: true,
    roomAdmin: p.rol === "dirigente",
    canPublish: puedePublicar,
    canPublishData: puedePublicar,
    canSubscribe: true,
  });

  const jwt = await at.toJwt();
  return json({ token: jwt, url: LIVEKIT_URL });
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });
}
