// Mi plan y equipo.
//
//   • Titular (quien paga): ve su plan, los minutos usados en el mes, da de
//     alta o quita maestros hasta el tope de su plan, y abre el portal de
//     Stripe para cambiar tarjeta, plan o cancelar.
//   • Maestro de otra cuenta: ve con qué plan da clases.
//   • Sin plan: ve los planes y contrata.
//
// Un mismo panel sirve para Premium e Institucional; sólo cambia el tope
// de maestros (`planes.max_maestros`).

import { sb } from "./supabase.js";
import { requireUser } from "./auth.js";
import { resumenDelPlan, revisarStripe, fechaCorta } from "./plan.js";
import { escapar, mostrarMensaje } from "./util.js";

const $ = (s) => document.querySelector(s);
await requireUser();

const params = new URLSearchParams(location.search);
if (params.get("stripe") === "ok") {
  mostrarMensaje($("#mensaje"), "Confirmando tu pago con Stripe…", "ok");
  await revisarStripe();
  history.replaceState({}, "", "/panel");
  mostrarMensaje($("#mensaje"), "¡Listo! Tu plan ya está activo. Ya puedes crear clases.", "ok");
} else if (params.get("stripe") === "cancel") {
  history.replaceState({}, "", "/panel");
  mostrarMensaje($("#mensaje"), "No se hizo ningún cobro. Puedes elegir un plan cuando quieras.");
}

let resumen = null;

async function cargar() {
  resumen = await resumenDelPlan();
  $("#cargando").classList.add("oculto");
  pintarPlan();
  pintarEquipo();
  pintarSoyMaestro();
  await pintarPlanes();
}

function pintarPlan() {
  const t = resumen.titular;
  $("#mi-plan").classList.toggle("oculto", !t);
  if (!t) return;
  $("#plan-nombre").textContent = `${t.plan_nombre} · $${t.precio_usd}/mes`;
  const est = $("#plan-estado");
  est.textContent = t.vigente ? "Vigente" : "Vencido";
  est.className = `chip-mini ${t.vigente ? "verde" : "rojo"}`;
  const vence = t.vence_en && new Date(t.vence_en).getFullYear() < 2090
    ? (t.vigente ? `Se renueva o vence el ${fechaCorta(t.vence_en)}.` : `Venció el ${fechaCorta(t.vence_en)}.`)
    : "Sin fecha de vencimiento.";
  const gente = t.max_maestros > 1 ? `Hasta ${t.max_maestros} maestros contándote a ti.` : "Una sola persona da las clases.";
  $("#plan-detalle").textContent = `${gente} ${vence}`;

  const pct = Math.min(100, Math.round((t.uso_mes / t.minutos_mes) * 100));
  $("#uso-texto").textContent = `${t.uso_mes.toLocaleString("es-MX")} de ${t.minutos_mes.toLocaleString("es-MX")}`;
  $("#uso-barra").style.width = `${pct}%`;
  $("#uso-barra").classList.toggle("alto", pct >= 80);

  $("#btn-portal").classList.toggle("oculto", !t.con_stripe);
  $("#btn-ver-planes").classList.toggle("oculto", t.con_stripe && t.vigente);
}

function pintarEquipo() {
  const t = resumen.titular;
  $("#equipo").classList.toggle("oculto", !t);
  if (!t) return;
  const basico = t.max_maestros <= 1;
  $("#equipo-basico").classList.toggle("oculto", !basico);
  $("#form-maestro").classList.toggle("oculto", basico || !t.vigente);

  const lugares = t.max_maestros - 1;
  const usados = t.maestros.length;
  $("#equipo-cupo").textContent = basico
    ? "Tu plan no incluye maestros adicionales."
    : `${usados} de ${lugares} lugares ocupados (más tú).`;
  if (!basico && usados >= lugares) $("#form-maestro").classList.add("oculto");

  $("#lista-maestros").innerHTML = t.maestros.map((m) => {
    const estado = !m.activo ? '<span class="chip-mini rojo">En pausa: no cabe en el plan</span>'
      : m.tiene_cuenta ? '<span class="chip-mini verde">Activo</span>'
      : '<span class="chip-mini">Falta que se registre</span>';
    return `
      <li>
        <div>
          <div class="gente-nombre">${escapar(m.nombre || m.correo)}</div>
          <div class="arch-meta">${escapar(m.correo)}</div>
          ${estado}
        </div>
        <button class="btn-mini" type="button" data-quitar="${m.id}">Quitar</button>
      </li>`;
  }).join("") || (basico ? "" : '<li class="vacio">Todavía no das de alta a nadie.</li>');

  document.querySelectorAll("[data-quitar]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("¿Quitar a este maestro? Ya no podrá crear clases con tu plan.")) return;
    const { error } = await sb.rpc("equipo_quitar", { p_id: b.dataset.quitar });
    if (error) return mostrarMensaje($("#mensaje"), error.message);
    await cargar();
  }));

  const uso = t.uso_por_dirigente || [];
  $("#uso-maestros").classList.toggle("oculto", uso.length === 0);
  $("#lista-uso").innerHTML = uso.map((u) => `
    <li><span>${escapar(u.correo || "—")}</span><strong>${u.minutos.toLocaleString("es-MX")} min</strong></li>`).join("");
}

$("#form-maestro").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("#btn-agregar");
  b.disabled = true;
  const { data, error } = await sb.rpc("equipo_agregar", {
    p_correo: $("#m-correo").value.trim(),
    p_nombre: $("#m-nombre").value.trim() || null,
  });
  b.disabled = false;
  if (error) return mostrarMensaje($("#mensaje"), error.message);
  $("#m-correo").value = "";
  $("#m-nombre").value = "";
  mostrarMensaje($("#mensaje"), data.tiene_cuenta
    ? `${data.correo} ya puede crear clases con tu plan.`
    : `Listo. Pídele a ${data.correo} que se registre en Connectalive con ese correo.`, "ok");
  await cargar();
});

function pintarSoyMaestro() {
  const lista = resumen.maestro_de || [];
  $("#soy-maestro").classList.toggle("oculto", lista.length === 0);
  $("#lista-soy-maestro").innerHTML = lista.map((m) => `
    <li>
      <div>
        <div class="gente-nombre">${escapar(m.titular_correo)}</div>
        <div class="arch-meta">Plan ${escapar(m.plan_nombre || "—")}</div>
      </div>
      ${m.vigente && m.activo ? '<span class="chip-mini verde">Puedes dar clases</span>'
        : '<span class="chip-mini rojo">Plan vencido o sin lugar</span>'}
    </li>`).join("");
}

async function pintarPlanes() {
  const t = resumen.titular;
  // Con un plan de Stripe vigente, el cambio se hace desde el portal (así
  // Stripe prorratea y no se cobran dos suscripciones): la lista sólo sale
  // sin plan, con el plan vencido, o si se pide con "Ver otros planes".
  const mostrar = !t || !t.vigente || !!$("#planes").dataset.forzar;
  $("#planes").classList.toggle("oculto", !mostrar);
  if (!mostrar) return;
  $("#planes-titulo").textContent = t?.vigente ? "Otros planes" : "Elige un plan para dar clases";

  const { data: planes } = await sb.from("planes")
    .select("slug,nombre,precio_usd,minutos_participante_mes,max_maestros,descripcion")
    .order("orden");
  $("#planes-lista").innerHTML = (planes || []).map((p) => {
    const horas = Math.round(p.minutos_participante_mes / 20 / 60);
    const actual = t?.plan_slug === p.slug && t?.vigente;
    return `
      <article class="plan ${p.slug === "grupo" ? "plan-destacado" : ""}">
        <h3>${escapar(p.nombre)}</h3>
        <div class="plan-precio">$${p.precio_usd}<span>/mes</span></div>
        <p class="pista">${escapar(p.descripcion || "")}</p>
        <ul>
          <li>${p.max_maestros === 1 ? "1 persona da clases" : `Hasta ${p.max_maestros} maestros`}</li>
          <li>${p.minutos_participante_mes.toLocaleString("es-MX")} minutos-participante al mes (≈ ${horas} h de clase con 20 personas)</li>
          <li>Alumnos y oyentes ilimitados que se unen gratis</li>
          <li>Pizarra, diapositivas y archivos dentro de la clase</li>
        </ul>
        <button class="btn ${actual ? "btn-secundario" : "btn-primario"}" type="button" data-plan="${p.slug}" ${actual ? "disabled" : ""}>
          ${actual ? "Tu plan actual" : "Contratar"}
        </button>
      </article>`;
  }).join("");

  document.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", async () => {
    const original = b.textContent;
    b.disabled = true;
    b.textContent = "Abriendo…";
    try {
      const { data, error } = await sb.functions.invoke("cl-crear-checkout", { body: { plan: b.dataset.plan } });
      if (error || data?.error) throw new Error(data?.error || error?.message || "Stripe no respondió");
      if (!data?.url) throw new Error("Stripe no devolvió la página de pago");
      location.href = data.url;
    } catch (err) {
      b.disabled = false;
      b.textContent = original;
      mostrarMensaje($("#mensaje"), err.message || "No se pudo abrir el pago");
    }
  }));
}

$("#btn-ver-planes").addEventListener("click", async () => {
  $("#planes").dataset.forzar = "1";
  await pintarPlanes();
  $("#planes").scrollIntoView({ behavior: "smooth" });
});

$("#btn-portal").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const { data, error } = await sb.functions.invoke("cl-portal-cliente", { body: {} });
    if (error || data?.error) throw new Error(data?.error || error?.message);
    location.href = data.url;
  } catch (err) {
    b.disabled = false;
    mostrarMensaje($("#mensaje"), err.message || "No se pudo abrir el portal de pagos");
  }
});

try {
  await cargar();
} catch (err) {
  $("#cargando").classList.add("oculto");
  mostrarMensaje($("#mensaje"), err.message || "No se pudo cargar tu plan");
}
