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
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { nombre_mostrar: nombre } },
  });
  if (error) throw error;
  return data.user;
}

/** Cerrar sesión. */
export async function salir() {
  await sb.auth.signOut();
}

/** Nombre para mostrar (del user_metadata, o el correo antes del @). */
export function nombreDe(user) {
  const meta = user?.user_metadata || {};
  return meta.nombre_mostrar || meta.name || (user?.email || "").split("@")[0] || "Invitado";
}
