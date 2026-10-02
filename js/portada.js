// Portada pública (/): qué es Connectalive. Quien ya tiene sesión se va
// directo a /inicio, como antes cuando esta dirección era el login.

import { currentUser } from "./auth.js";
import { sb } from "./supabase.js";

const $ = (s) => document.querySelector(s);
const raiz = document.documentElement;

// --- Con sesión, a la app (también al volver del correo de confirmación) ---
try {
  if (await currentUser()) {
    location.replace("/inicio");
  } else {
    raiz.classList.remove("comprobando");
  }
} catch {
  raiz.classList.remove("comprobando");
}

// --- Unirse por enlace o código (misma regla que /entrar e /inicio) ---
$("#form-codigo").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#codigo").value.trim();
  if (!raw) return;
  const m = raw.match(/\/s\/([A-Za-z0-9]+)(?:\?a=([A-Za-z0-9]+))?/);
  if (m) return (location.href = `/s/${m[1].toUpperCase()}${m[2] ? `?a=${m[2].toUpperCase()}` : ""}`);
  const codigo = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (codigo) location.href = `/s/${encodeURIComponent(codigo)}`;
});

// --- Precios: el HTML trae los de hoy; si la base dice otra cosa, manda la base ---
const miles = new Intl.NumberFormat("es-MX");
sb.from("planes").select("slug,nombre,precio_usd,descripcion,minutos_participante_mes").then(({ data }) => {
  for (const p of data || []) {
    const caja = document.querySelector(`[data-plan="${p.slug}"]`);
    if (!caja) continue;
    if (p.nombre) caja.querySelector("[data-nombre]").textContent = p.nombre;
    if (p.precio_usd != null) caja.querySelector("[data-precio]").textContent = `$${Number(p.precio_usd).toFixed(2)}`;
    if (p.descripcion) caja.querySelector("[data-desc]").textContent = p.descripcion;
    if (p.minutos_participante_mes) caja.querySelector("[data-minutos]").textContent = `${miles.format(p.minutos_participante_mes)} minutos-participante al mes`;
  }
});

// --- Entrada suave al bajar ---
// La clase que esconde la pone este JS (si falla, todo se ve) y a los 2 s se
// destapa todo pase lo que pase.
const piezas = [...document.querySelectorAll(".revelar")];
if ("IntersectionObserver" in window && piezas.length) {
  raiz.classList.add("js-revelar");
  const obs = new IntersectionObserver((entradas) => {
    for (const en of entradas) if (en.isIntersecting) { en.target.classList.add("visible"); obs.unobserve(en.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  piezas.forEach((p) => obs.observe(p));
  setTimeout(() => piezas.forEach((p) => p.classList.add("visible")), 2000);
}
