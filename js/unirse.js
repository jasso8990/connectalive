// Unirse a una clase.
//
// Todos entran con cuenta (correo/contraseña). El rol lo decide la base
// (`unirse_a_sala`) según el código con que se entra:
//
//   • Código de la sala (enlace público)   → OYENTE (ve y escucha).
//   • Código de alumnos (enlace ?a=…)      → ALUMNO (habla, interactúa).
//
// Sin sesión, esta pantalla manda a /entrar?volver=<url actual>.

import { sb } from "./supabase.js";
import { currentUser, nombreDe } from "./auth.js";
import { mostrarMensaje } from "./util.js";

const $ = (s) => document.querySelector(s);

let sala = null;       // { id, nombre, abierta_a_oyentes, cerrada, rol_asignado }
let codigoSala = "";   // el código con el que se encontró la sala

function codigoDeUrl() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get("codigo");
  return q ? q.toUpperCase() : "";
}
const codigoAlumno = (new URLSearchParams(location.search).get("a") || "").toUpperCase();

function mostrar(id) {
  ["paso-codigo-sala", "paso-cargando", "paso-eleccion"].forEach((x) =>
    document.getElementById(x).classList.toggle("oculto", x !== id));
}

async function buscarSala(codigo) {
  const { data, error } = await sb.rpc("buscar_sala_por_codigo", { p_codigo: codigo });
  if (error) throw error;
  const s = data && data[0];
  if (!s) throw new Error("Ese código no existe. Revisa las letras.");
  if (s.cerrada) throw new Error("Esta clase ya terminó.");
  return s;
}

function extraerCodigo(texto) {
  const m = texto.trim().match(/\/s\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : texto.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function irALogin() {
  const volver = encodeURIComponent(location.pathname + location.search);
  location.replace(`/entrar?volver=${volver}`);
}

async function entrar(codigo) {
  const msg = $("#mensaje");
  msg.classList.add("oculto");
  if (!(await currentUser())) return irALogin();
  const { data, error } = await sb.rpc("unirse_a_sala", { p_codigo: codigo });
  if (error) return mostrarMensaje(msg, error.message || "No se pudo entrar");
  location.replace(`/sala/${data.sala_id}`);
}

async function prepararEleccion() {
  const u = await currentUser();
  if (!u) return irALogin();

  // Pegaron directamente el código de alumnos: no hay nada que elegir.
  if (sala.rol_asignado === "alumno") return entrar(codigoSala);

  $("#sala-nombre").textContent = sala.nombre;
  $("#nombre-vis").textContent = nombreDe(u);

  if (!sala.abierta_a_oyentes) {
    $("#btn-invitado").classList.add("oculto");
    $("#det-codigo").setAttribute("open", "");
    const nota = document.createElement("p");
    nota.className = "pista";
    nota.textContent = "Esta clase es sólo para alumnos con código.";
    $("#det-codigo").before(nota);
  }
  if (codigoAlumno) {
    $("#codigo-alumno").value = codigoAlumno;
    $("#det-codigo").setAttribute("open", "");
  }
  mostrar("paso-eleccion");
}

async function abrir(codigo) {
  mostrar("paso-cargando");
  try {
    sala = await buscarSala(codigo);
    codigoSala = codigo;
    await prepararEleccion();
    // Enlace de alumnos (`?a=`): entra directo, sin pasar por la elección.
    if (codigoAlumno && sala.rol_asignado !== "alumno") $("#btn-alumno").click();
  } catch (err) {
    mostrar("paso-codigo-sala");
    mostrarMensaje($("#mensaje-buscar"), err.message);
  }
}

const inicial = codigoDeUrl();
if (inicial) await abrir(inicial);
else mostrar("paso-codigo-sala");

$("#form-buscar").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = extraerCodigo($("#entrada-sala").value);
  if (c) abrir(c);
});

$("#btn-invitado").addEventListener("click", () => entrar(codigoSala));

$("#btn-alumno").addEventListener("click", async () => {
  const codigo = $("#codigo-alumno").value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!codigo) return mostrarMensaje($("#mensaje"), "Escribe el código de alumno.");
  try {
    const s2 = await buscarSala(codigo);
    if (s2.id !== sala.id || s2.rol_asignado !== "alumno") {
      return mostrarMensaje($("#mensaje"), "Ese código no es de alumno de esta clase.");
    }
    await entrar(codigo);
  } catch (err) {
    mostrarMensaje($("#mensaje"), err.message);
  }
});
