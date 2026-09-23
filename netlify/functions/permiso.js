// El dirigente cambió el rol o le dio/quitó voz a alguien.
//
// Además de escribir en la base (eso ya lo hizo el navegador con RLS), hay
// que mover el permiso en LiveKit *sin* pedirle a esa persona que se
// reconecte. Eso se hace con `RoomServiceClient.updateParticipant`, que
// requiere la API secret y por eso vive aquí, en el servidor.

import { RoomServiceClient } from "livekit-server-sdk";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bckgumchkzlvbgcxjpwi.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;

export default async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  if (!LK_KEY || !LK_SECRET || !LIVEKIT_URL) return json({ error: "faltan variables de LiveKit" }, 500);
  if (!SERVICE_KEY) return json({ error: "falta SUPABASE_SERVICE_ROLE_KEY" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const { salaId, participanteId } = body || {};
  if (!salaId || !participanteId) return json({ error: "faltan datos" }, 400);

  // Solo el dirigente de la sala puede mover permisos.
  const authHeader = req.headers.get("authorization") || "";
  const tokenSup = authHeader.replace(/^Bearer\s+/i, "");
  if (!tokenSup) return json({ error: "sin sesión" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: eU } = await admin.auth.getUser(tokenSup);
  if (eU || !userData?.user) return json({ error: "sesión inválida" }, 401);
  const userId = userData.user.id;

  const { data: sala } = await admin
    .schema("connectalive")
    .from("salas")
    .select("id, dirigente_id")
    .eq("id", salaId)
    .single();
  if (!sala) return json({ error: "sala no existe" }, 404);

  // El permiso sale de la base (lo que el dirigente ya grabó), no de lo que
  // diga el navegador.
  const { data: p } = await admin
    .schema("connectalive")
    .from("participantes")
    .select("id, sala_id, user_id, rol, voz_activa")
    .eq("id", participanteId)
    .single();
  if (!p || p.sala_id !== salaId) return json({ error: "ese participante no es de esta sala" }, 404);
  // El dirigente mueve a cualquiera; cada quien puede reflejar lo suyo (el
  // oyente que suelta la palabra). Como se aplica lo que dice la base, pedirlo
  // uno mismo no le da nada que la base no le haya dado.
  if (sala.dirigente_id !== userId && p.user_id !== userId) {
    return json({ error: "sólo el dirigente cambia permisos" }, 403);
  }
  const puedePublicar = p.rol !== "oyente" || p.voz_activa;

  // Ahora sí, mover en LiveKit.
  const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, "https://");
  const svc = new RoomServiceClient(httpUrl, LK_KEY, LK_SECRET);

  try {
    await svc.updateParticipant(salaId, participanteId, /* metadata */ undefined, {
      canPublish: puedePublicar,
      canPublishData: puedePublicar,
      canSubscribe: true,
    });
    // Si le acabas de quitar voz, además silencia los tracks publicados.
    if (!puedePublicar) {
      try {
        const p = await svc.getParticipant(salaId, participanteId);
        for (const tr of p.tracks || []) {
          await svc.mutePublishedTrack(salaId, participanteId, tr.sid, true).catch(() => {});
        }
      } catch { /* nadie conectado con ese identity aún: no pasa nada */ }
    }
  } catch {
    // Si el participante todavía no está conectado a LiveKit, updateParticipant
    // devuelve error. No es fatal: cuando se conecte va a pedir un token nuevo
    // (token.js) que ya lleva los permisos actualizados.
    return json({ ok: true, aviso: "no había participante en LiveKit; el próximo token traerá los permisos nuevos" });
  }

  return json({ ok: true });
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });
}
