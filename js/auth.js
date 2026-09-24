// Helpers de sesión.
//
// La cuenta es la que ya usan las otras apps del mismo Supabase (Smartagent,
// Cancha, Market). Un usuario nuevo se registra aquí y queda ligado al mismo
// auth.users; su rol dentro de una sala se decide sala por sala, no en el
// perfil global.

import { sb } from "./supabase.js";

/** Devuelve el user autenticado o null. */
export async function currentUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user ?? null;
}

/** Redirige a /entrar si no hay sesión. */
export async function requireUser() {
  const user = await currentUser();
  if (!user) {
    const volver = encodeURIComponent(location.pathname + location.search);
    location.replace(`/entrar?volver=${volver}`);
    throw new Error("sin sesión");
  }
  return user;
}

/** Entrar con correo/contraseña. */
export async function entrar(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

/** Crear cuenta con correo/contraseña y nombre para mostrar. */
export async function registrar(email, password, nombre) {
  // `emailRedirectTo` es CRÍTICO: el proyecto Supabase es compartido entre
  // Cancha, Smartagent, Market y ConnectaLive. Sin este campo, el link de
  // confirmación usa el Site URL global del proyecto (LigaBC) y el usuario
  // aterriza en la app equivocada. El dominio también tiene que estar en
  // Supabase → Authentication → URL Configuration → Redirect URLs.
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { nombre_mostrar: nombre },
      emailRedirectTo: location.origin,
    },
  });
  if (error) throw error;
  return data.user;
}

/** Cerrar sesión sólo en ESTE navegador.
 *
 * `scope: "local"` es a propósito. El `signOut()` de fábrica es *global*:
 * revoca la sesión del usuario en todas sus ventanas, en sus otros aparatos y
 * en las apps hermanas del mismo Supabase (Smartagent, Cancha, Market).
 * Quien salía de una clase dejaba muerta la sesión de su otra ventana, y esa
 * ventana seguía pintando la clase —PostgREST y Realtime sólo miran la firma
 * del JWT, no si la sesión existe— pero el video moría con "401 — sesión
 * inválida", porque la función del token sí pregunta por ella en
 * `/auth/v1/user`.
 */
export async function salir() {
  await sb.auth.signOut({ scope: "local" });
}

/** POST a una función del servidor, firmado con la sesión del usuario.
 *
 * Un 401 casi siempre significa que el token guardado viene de una sesión ya
 * revocada (ver `salir`). Se renueva una vez y se reintenta; si tampoco pasa,
 * el error lleva `sesionCaducada` para que quien llama mande a entrar de nuevo
 * en vez de enseñar un número.
 */
export async function postConSesion(url, cuerpo) {
  const enviar = async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw sesionCaducada();
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(cuerpo),
    });
  };

  let r = await enviar();
  if (r.status === 401) {
    const { data, error } = await sb.auth.refreshSession();
    if (error || !data?.session) throw sesionCaducada();
    r = await enviar();
    if (r.status === 401) throw sesionCaducada();
  }
  return r;
}

/** A dónde mandar a quien se quedó sin sesión, para que vuelva a esta página. */
export function rutaDeEntrada() {
  return `/entrar?volver=${encodeURIComponent(location.pathname + location.search)}`;
}

function sesionCaducada() {
  const e = new Error("Tu sesión caducó. Vuelve a entrar para seguir.");
  e.sesionCaducada = true;
  return e;
}

/** Nombre para mostrar (del user_metadata, o el correo antes del @). */
export function nombreDe(user) {
  const meta = user?.user_metadata || {};
  return meta.nombre_mostrar || meta.name || (user?.email || "").split("@")[0] || "Invitado";
}
