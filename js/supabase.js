// Cliente Supabase apuntando al esquema `connectalive`.
// Todas las tablas de esta app viven ahí; sin `db.schema` habría que anteponer
// el esquema en cada `.from("connectalive.salas")` y romper realtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_SCHEMA } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: APP_SCHEMA },
  auth: { persistSession: true, autoRefreshToken: true },
});

// Un cliente "pelón" (sin esquema fijo) para llamadas al esquema `public` si
// alguna vez hicieran falta (por ejemplo, funciones RPC comunes).
export const sbPublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "sb-connectalive-shared" },
});
