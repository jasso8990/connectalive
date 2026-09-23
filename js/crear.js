// Crear una clase. El usuario autenticado queda como dirigente.
//
// Sólo crean clase las cuentas con plan vigente, propio o de la escuela o
// empresa que las dio de alta como maestro (lo decide `puede_crear_sala`
// en la base; la política de INSERT de `salas` lo vuelve a exigir). El
// dirigente queda inscrito como participante por un trigger de la base.

import { sb } from "./supabase.js";
import { requireUser } from "./auth.js";
import { resumenDelPlan } from "./plan.js";
import { copiar } from "./util.js";

const $ = (s) => document.querySelector(s);
const user = await requireUser();

{
  let r = null;
  try { r = await resumenDelPlan(); } catch { /* se trata como sin plan */ }
  if (!r?.puede_crear) {
    $("#paso-crear").classList.add("oculto");
    $("#paso-no-autorizado").classList.remove("oculto");
    $("#no-autorizado-correo").textContent = user.email || "tu cuenta";
  } else {
    const deOtro = !r.titular?.vigente && r.maestro_de?.find((m) => m.vigente && m.activo);
    $("#con-plan").textContent = deOtro
      ? `Con el plan ${deOtro.plan_nombre} de ${deOtro.titular_correo}.`
      : `Con tu plan ${r.titular?.plan_nombre || ""}.`;
    // El botón nace apagado: si se toca antes de saber el plan, el
    // formulario se mandaba como página normal y no creaba nada.
    $("#btn-crear").disabled = false;
  }
}

// Código corto legible: 8 caracteres sin ambigüedades (sin 0/O/1/I).
function codigoCorto() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => abc[n % abc.length]).join("");
}

$("#form-crear").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-crear");
  const msg = $("#mensaje");
  msg.classList.add("oculto");
  btn.disabled = true;

  try {
    // Dos códigos distintos (oyentes y alumnos); se reintenta si alguno ya existía.
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
          nombre: $("#nombre").value.trim(),
          descripcion: $("#descripcion").value.trim() || null,
          dirigente_id: user.id,
          abierta_a_oyentes: $("#abierta").checked,
        })
        .select("id, codigo")
        .single();
      if (!error) { sala = { ...data, codigo_alumnos: codigoAlumnos }; break; }
      if (error.code !== "23505") throw error; // 23505 = código repetido
    }
    if (!sala) throw new Error("No fue posible generar códigos únicos, intenta otra vez");

    $("#paso-crear").classList.add("oculto");
    $("#paso-lista").classList.remove("oculto");

    const enlace = `${location.origin}/s/${sala.codigo}`;
    const enlaceAlumnos = `${enlace}?a=${sala.codigo_alumnos}`;
    $("#enlace-mostrar").textContent = enlace;
    $("#enlace-alumnos-mostrar").textContent = enlaceAlumnos;
    $("#codigo-alumnos-mostrar").textContent = sala.codigo_alumnos.replace(/(.{4})/, "$1 ");
    $("#btn-ir-sala").href = `/sala/${sala.id}`;

    $("#btn-copiar-enlace").addEventListener("click", (ev) => copiar(ev.currentTarget, enlace));
    $("#btn-copiar-enlace-alumnos").addEventListener("click", (ev) => copiar(ev.currentTarget, enlaceAlumnos));
    $("#btn-copiar-codigo").addEventListener("click", (ev) => copiar(ev.currentTarget, sala.codigo_alumnos));
  } catch (err) {
    msg.textContent = /row-level security/i.test(err.message || "")
      ? "Tu plan no está vigente. Revisa «Mi plan»."
      : err.message || "No se pudo crear la clase";
    msg.className = "mensaje error";
    btn.disabled = false;
  }
});
