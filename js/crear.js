// Crear una sala. El usuario autenticado queda como dirigente.

import { sb } from "./supabase.js";
import { requireUser, nombreDe, salir } from "./auth.js";

const $ = (s) => document.querySelector(s);

const user = await requireUser();

$("#btn-salir").addEventListener("click", async () => {
  await salir();
  location.replace("/");
});

// Genera un código corto legible: 8 caracteres sin ambigüedades (sin 0/O/1/I).
function codigoCorto() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 8; i++) s += abc[buf[i] % abc.length];
  return s;
}

$("#form-crear").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-crear");
  const msg = $("#mensaje");
  msg.classList.add("oculto");
  btn.disabled = true;

  const nombre = $("#nombre").value.trim();
  const descripcion = $("#descripcion").value.trim() || null;
  const abierta = $("#abierta").checked;

  try {
    // Reintentar si por casualidad alguno de los códigos ya existía.
    // Necesitamos DOS códigos distintos: uno para oyentes, otro para alumnos.
    let sala = null;
    for (let intento = 0; intento < 5 && !sala; intento++) {
      const codigo = codigoCorto();
      const codigoAlumnos = codigoCorto();
      if (codigo === codigoAlumnos) continue;
      const { data, error } = await sb
        .from("salas")
        .insert({
          codigo,
          codigo_alumnos: codigoAlumnos,
          nombre,
          descripcion,
          dirigente_id: user.id,
          abierta_a_oyentes: abierta,
        })
        .select()
        .single();
      if (!error) { sala = data; break; }
      if (error.code !== "23505") throw error; // 23505 = unique violation
    }
    if (!sala) throw new Error("No fue posible generar códigos únicos, intenta otra vez");

    // El dirigente también se inserta como participante de la sala.
    const { error: errP } = await sb
      .from("participantes")
      .insert({
        sala_id: sala.id,
        user_id: user.id,
        nombre_mostrar: nombreDe(user),
        rol: "dirigente",
      });
    if (errP && errP.code !== "23505") throw errP;

    // Un enlace público (con el código de sala) + un código privado de alumnos.
    $("#paso-crear").classList.add("oculto");
    $("#paso-lista").classList.remove("oculto");

    const formato = (c) => c.replace(/(.{4})/, "$1 ").trim();
    const enlace = `${location.origin}/s/${sala.codigo}`;
    $("#enlace-mostrar").textContent = enlace;
    $("#codigo-alumnos-mostrar").textContent = formato(sala.codigo_alumnos);
    $("#btn-ir-sala").href = `/sala/${sala.id}`;

    function copiarA(btn, texto, msgOk) {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(texto);
          const original = btn.textContent;
          btn.textContent = msgOk;
          setTimeout(() => (btn.textContent = original), 1500);
        } catch { /* sin permiso, ni modo */ }
      });
    }
    copiarA($("#btn-copiar-enlace"), enlace, "Copiado");
    copiarA($("#btn-copiar-codigo"), sala.codigo_alumnos, "Copiado");
  } catch (err) {
    msg.textContent = err.message || "No se pudo crear la sala";
    msg.className = "mensaje error";
    btn.disabled = false;
  }
});
