// Unirse a una sala.
//
// TODOS los participantes están autenticados con correo/contraseña (mismo
// patrón que Vitalia). El enlace `/s/CODIGO` te lleva a la sala; el "código
// de alumno" que sólo el dirigente reparte te sube a rol alumno:
//
//   • Entrar sin código                 → rol OYENTE (ver y escuchar).
//   • Entrar con código de alumno       → rol ALUMNO (habla, interactúa).
//
// Si no hay sesión, esta pantalla manda a /entrar?volver=<url actual>,
// y al volver ya se muestra la elección de rol.

import { sb } from "./supabase.js";
import { currentUser, nombreDe } from "./auth.js";

const $ = (s) => document.querySelector(s);

let sala = null;   // { id, nombre, abierta_a_oyentes, cerrada, rol_asignado }

// El código de la sala puede venir en tres formas:
//   /s/CODIGO           (redirect de netlify.toml, mantiene el path)
//   /unirse?codigo=XX   (compatibilidad)
//   pegado a mano
function codigoDeUrl() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get("codigo");
  return q ? q.toUpperCase() : "";
}

function mostrar(id) {
  ["paso-codigo-sala", "paso-cargando", "paso-eleccion"].forEach((x) => {
    document.getElementById(x).classList.toggle("oculto", x !== id);
  });
}

function error(nodo, msg) {
  nodo.textContent = msg;
  nodo.className = "mensaje error";
  nodo.classList.remove("oculto");
}

async function buscarSala(codigo) {
  const { data, error: err } = await sb.rpc("buscar_sala_por_codigo", { p_codigo: codigo });
  if (err) throw err;
  const s = data && data[0];
  if (!s) throw new Error("Ese código no existe. Revisa las letras.");
  if (s.cerrada) throw new Error("Esta sala ya cerró.");
  // Si el usuario pegó por error el código de alumno como si fuera enlace,
  // igual encontramos la sala — pero preferimos que use el flujo normal.
  return s;
}

function extraerCodigoDeEntrada(texto) {
  const t = texto.trim();
  const m = t.match(/\/s\/([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  return t.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function irALogin() {
  const volver = encodeURIComponent(location.pathname + location.search);
  location.replace(`/entrar?volver=${volver}`);
}

async function prepararEleccion() {
  // Sin sesión, no hay elección: al login.
  const u = await currentUser();
  if (!u) return irALogin();

  $("#sala-nombre").textContent = sala.nombre;
  $("#nombre-vis").textContent = nombreDe(u);

  // Si la sala está cerrada a oyentes, ocultar el botón de invitado.
  if (!sala.abierta_a_oyentes) {
    $("#btn-invitado").classList.add("oculto");
    $("#det-codigo").setAttribute("open", "");
    const nota = document.createElement("p");
    nota.className = "pista";
    nota.style.marginTop = "8px";
    nota.textContent = "Esta clase está cerrada al público. Sólo entran alumnos con código.";
    $("#det-codigo").before(nota);
  }
  mostrar("paso-eleccion");
}

async function entrarConRol(rol) {
  const msg = $("#mensaje");
  msg.classList.add("oculto");

  try {
    const user = await currentUser();
    if (!user) return irALogin();

    // Rejoin: si ya estabas en la sala, respeta tu rol previo (a menos que
    // ahora te promuevas de oyente → alumno con el código correcto).
    const { data: existente } = await sb
      .from("participantes")
      .select("id, rol")
      .eq("sala_id", sala.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existente) {
      // Si venías como oyente y ahora traes el código, subimos a alumno.
      if (existente.rol === "oyente" && rol === "alumno") {
        await sb.from("participantes")
          .update({ rol: "alumno", salido_en: null })
          .eq("id", existente.id);
      } else if (existente.rol !== "dirigente") {
        // Sólo limpiamos salido_en para marcar reingreso.
        await sb.from("participantes").update({ salido_en: null }).eq("id", existente.id);
      }
    } else {
      const { error: e3 } = await sb.from("participantes").insert({
        sala_id: sala.id,
        user_id: user.id,
        nombre_mostrar: nombreDe(user),
        rol,
      });
      if (e3) throw e3;
    }

    location.replace(`/sala/${sala.id}`);
  } catch (err) {
    error(msg, err.message || "No se pudo entrar");
  }
}

// --- Arranque --------------------------------------------------------------
const inicial = codigoDeUrl();
if (inicial) {
  mostrar("paso-cargando");
  try {
    sala = await buscarSala(inicial);
    // Si el usuario pegó accidentalmente el código de alumno en la URL, ya
    // sabemos la sala igual (la RPC busca en ambos). Lo tratamos como si
    // hubieran ido por el flujo normal — se le pregunta si tiene código.
    await prepararEleccion();
  } catch (err) {
    mostrar("paso-codigo-sala");
    error($("#mensaje-buscar"), err.message);
  }
} else {
  mostrar("paso-codigo-sala");
}

$("#form-buscar")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const codigo = extraerCodigoDeEntrada($("#entrada-sala").value);
  if (!codigo) return;
  mostrar("paso-cargando");
  try {
    sala = await buscarSala(codigo);
    await prepararEleccion();
  } catch (err) {
    mostrar("paso-codigo-sala");
    error($("#mensaje-buscar"), err.message);
  }
});

$("#btn-invitado").addEventListener("click", () => entrarConRol("oyente"));

$("#btn-alumno").addEventListener("click", async () => {
  const codigo = $("#codigo-alumno").value.trim().toUpperCase();
  if (!codigo) return error($("#mensaje"), "Escribe el código de alumno.");
  try {
    const s2 = await buscarSala(codigo);
    if (s2.id !== sala.id || s2.rol_asignado !== "alumno") {
      return error($("#mensaje"), "Ese código no es de alumno de esta sala.");
    }
    await entrarConRol("alumno");
  } catch (err) {
    error($("#mensaje"), err.message);
  }
});
