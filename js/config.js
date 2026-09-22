// Configuración pública.
//
// La "publishable key" es pública por diseño; la seguridad real vive en las
// políticas RLS del esquema `connectalive` (ver supabase/migrations/).
// Comparte proyecto con Smartagent, Cancha y Market: cada app en su esquema.

export const SUPABASE_URL = "https://bckgumchkzlvbgcxjpwi.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_KGkAIOF6DhAK_O-YhA6phw_neDlCsBm";

// Nombre del esquema donde vive TODO lo de esta app.
export const APP_SCHEMA = "connectalive";

// Bucket de Storage donde caen los archivos que se pasan entre participantes.
// Se crea a mano en Supabase → Storage → New bucket (privado).
export const STORAGE_BUCKET = "connectalive";

// Endpoint local de la función que emite el JWT de LiveKit.
export const TOKEN_ENDPOINT = "/.netlify/functions/token";

// Endpoint local de la función que sube/baja permisos en LiveKit al vuelo.
// (dar/quitar voz a un oyente sin que se reconecte).
export const PERMISO_ENDPOINT = "/.netlify/functions/permiso";
