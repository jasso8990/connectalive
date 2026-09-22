// Portada: entrar, registrarse o pegar un código para unirse.

import { entrar, registrar, currentUser } from "./auth.js";

const $ = (s) => document.querySelector(s);

function mostrarMensaje(nodo, texto, tipo = "error") {
  nodo.textContent = texto;
  nodo.className = `mensaje ${tipo}`;
  nodo.classList.remove("oculto");
}

// Si ya hay sesión y venía redirigido, mandarlo de vuelta.
(async () => {
  const u = await currentUser();
  const volver = new URLSearchParams(location.search).get("volver");
  if (u && volver) location.replace(volver);
  if (u && !volver) {
    // Ya está en su cuenta: ofrecerle un atajo para ir a crear sala.
    const nota = document.createElement("p");
    nota.className = "pista";
    nota.innerHTML = `Ya estás dentro. <a href="/crear">Crear una sala</a>.`;
    document.querySelector(".portada .tarjeta").prepend(nota);
  }
})();

// --- Login ---
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-entrar");
  const msg = $("#mensaje");
  btn.disabled = true;
  try {
    await entrar($("#email").value.trim(), $("#password").value);
    const volver = new URLSearchParams(location.search).get("volver") || "/crear";
    location.replace(volver);
  } catch (err) {
    mostrarMensaje(msg, err.message || "No se pudo entrar");
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
    await registrar(
      $("#reg-email").value.trim(),
      $("#reg-password").value,
      $("#reg-nombre").value.trim(),
    );
    mostrarMensaje(msg, "Cuenta creada. Revisa tu correo si te llegó un enlace de confirmación.", "ok");
    // Con confirmación desactivada, ya hay sesión y podemos ir a /crear.
    const u = await currentUser();
    if (u) setTimeout(() => location.replace("/crear"), 1200);
  } catch (err) {
    mostrarMensaje(msg, err.message || "No se pudo crear la cuenta");
  } finally {
    btn.disabled = false;
  }
});

// --- Unirse por enlace o código (público) ---
$("#form-codigo").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#codigo").value.trim();
  if (!raw) return;
  // Aceptar enlace pegado (…/s/CODIGO) o el código solo.
  const m = raw.match(/\/s\/([A-Za-z0-9]+)/);
  const codigo = (m ? m[1] : raw.replace(/[^A-Za-z0-9]/g, "")).toUpperCase();
  if (!codigo) return;
  location.href = `/s/${encodeURIComponent(codigo)}`;
});
