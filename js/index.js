// Portada: entrar, registrarse o pegar un código para unirse a una clase.

import { entrar, registrar, currentUser } from "./auth.js";
import { mostrarMensaje, rutaSegura } from "./util.js";

const $ = (s) => document.querySelector(s);
const destino = () => rutaSegura(new URLSearchParams(location.search).get("volver"));

// Con sesión abierta no hay nada que hacer aquí.
if (await currentUser()) location.replace(destino());

// --- Login ---
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-entrar");
  btn.disabled = true;
  try {
    await entrar($("#email").value.trim(), $("#password").value);
    location.replace(destino());
  } catch (err) {
    const texto = /invalid login/i.test(err.message || "") ? "Correo o contraseña incorrectos." : err.message;
    mostrarMensaje($("#mensaje"), texto || "No se pudo entrar");
    btn.disabled = false;
  }
});

// --- Registro ---
$("#form-registro").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-registro");
  const msg = $("#mensaje-reg");
  btn.disabled = true;
  try {
    await registrar($("#reg-email").value.trim(), $("#reg-password").value, $("#reg-nombre").value.trim());
    // Con confirmación de correo encendida no hay sesión todavía.
    if (await currentUser()) return location.replace(destino());
    mostrarMensaje(msg, "Cuenta creada. Te mandamos un correo: abre el enlace para confirmarla y luego entra aquí.", "ok");
  } catch (err) {
    mostrarMensaje(msg, err.message || "No se pudo crear la cuenta");
  } finally {
    btn.disabled = false;
  }
});

// --- Unirse por enlace o código ---
$("#form-codigo").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#codigo").value.trim();
  if (!raw) return;
  const m = raw.match(/\/s\/([A-Za-z0-9]+)(?:\?a=([A-Za-z0-9]+))?/);
  if (m) return (location.href = `/s/${m[1].toUpperCase()}${m[2] ? `?a=${m[2].toUpperCase()}` : ""}`);
  const codigo = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (codigo) location.href = `/s/${encodeURIComponent(codigo)}`;
});
