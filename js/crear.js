// Crear una sala. El usuario autenticado queda como dirigente.

import { sb } from "./supabase.js";
import { requireUser, nombreDe, salir } from "./auth.js";

const $ = (s) => document.querySelector(s);

const user = await requireUser();

$("#btn-salir").addEventListener("click", async () => {
  await salir();
  location.replace("/");
});

// Si el usuario vuelve del Checkout, preguntarle a Stripe qué pasó ANTES de
// medir autorización (así, si acaba de pagar, ya sale con plan vigente).
{
  const params = new URLSearchParams(location.search);
  const marca = params.get("stripe");
  if (marca === "ok") {
    try {
      await sb.functions.invoke("cl-revisar-suscripcion", { body: {} });
    } catch { /* si falla, la pantalla de "no autorizado" invita a reintentar */ }
    // Quita el ?stripe=ok del URL para que un F5 no vuelva a disparar.
    history.replaceState({}, "", "/crear");
  } else if (marca === "cancel") {
    history.replaceState({}, "", "/crear");
  }
}

// Sólo cuentas con plan vigente crean sala (consume minutos de LiveKit). El
// resto puede unirse a salas de otros y usar pizarra/presentaciones gratis.
{
  const { data: autorizado, error } = await sb.rpc("puede_crear_sala");
  if (error || !autorizado) {
    $("#paso-crear").classList.add("oculto");
    $("#paso-no-autorizado").classList.remove("oculto");
    $("#no-autorizado-correo").textContent = user.email || "tu cuenta";

    // Pinta los planes que hay en la base para que el usuario contrate.
    const { data: planes } = await sb
      .from("planes")
      .select("slug,nombre,precio_usd,minutos_participante_mes")
      .order("orden");
    const cont = $("#planes-lista");
    for (const p of planes || []) {
      const horasAprox = Math.round(p.minutos_participante_mes / 20 / 60);
      const tarjeta = document.createElement("div");
      tarjeta.className = "codigo-caja";
      tarjeta.innerHTML = `
        <div style="min-width:0">
          <div style="font-weight:600; font-size:17px">${p.nombre} — $${p.precio_usd}/mes</div>
          <div class="pista" style="margin-top:4px">Hasta <strong>${p.minutos_participante_mes.toLocaleString("es-MX")}</strong> minutos-participante al mes (≈ ${horasAprox} h de clase con 20 personas).</div>
        </div>
        <button type="button" class="btn btn-primario" style="flex-shrink:0" data-plan="${p.slug}">Contratar</button>
      `;
      const btn = tarjeta.querySelector("button");
      btn.addEventListener("click", async () => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Abriendo…";
        try {
          const { data, error: e } = await sb.functions.invoke("cl-crear-checkout", {
            body: { plan: p.slug },
          });
          if (e || data?.error) throw new Error(data?.error || e?.message || "Stripe no respondió");
          if (!data?.url) throw new Error("Stripe no devolvió URL");
          location.href = data.url;
        } catch (err) {
          btn.disabled = false;
          btn.textContent = original;
          alert(err.message || "No se pudo abrir el checkout");
        }
      });
      cont.appendChild(tarjeta);
    }
  }
}

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
