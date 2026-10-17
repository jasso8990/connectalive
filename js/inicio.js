// Inicio: la persona elige qué usar. Pizarra y presentación son gratis para
// cualquier cuenta; dar una clase en vivo pide plan (propio o de la escuela
// o empresa que la dio de alta como maestro).

import { sb } from "./supabase.js";
import { requireUser, nombreDe, salir } from "./auth.js";
import { resumenDelPlan } from "./plan.js";
import { crearTablero, limpiarCodigo, leerTablero, conectarTablero, leerUltima, olvidarUltima } from "./tablero.js";
import { escapar } from "./util.js";

const $ = (s) => document.querySelector(s);
const user = await requireUser();
$("#nombre").textContent = nombreDe(user);

$("#btn-salir").addEventListener("click", async () => { await salir(); location.replace("/"); });

// --- ¿Seguir donde te quedaste? ---------------------------------------------
// Si la app se cerró (o el celular la mató) a media presentación o pizarra,
// se pregunta si se vuelve ahí, con el mismo control que se tenía.
{
  const u = leerUltima();
  if (u) {
    leerTablero(u.codigo).then((t) => {
      if (t.tipo !== u.tipo) return olvidarUltima(u.codigo);
      const que = {
        control: `Estabas controlando «${u.nombre}» (código ${u.codigo}), en la diapositiva ${t.pagina} de ${t.paginas || "?"}.`,
        proyector: `Estabas proyectando «${u.nombre}» (código ${u.codigo}).`,
        escribir: `Estabas escribiendo en la pizarra ${u.codigo}.`,
        ver: `Estabas viendo la pizarra ${u.codigo}.`,
      }[u.modo] || `Código ${u.codigo}.`;
      $("#seguir-texto").textContent = que;
      $("#seguir-ir").href = u.url;
      $("#seguir").classList.remove("oculto");
    }).catch((err) => { if (/no existe/.test(err.message)) olvidarUltima(u.codigo); });
  }
  // «No, gracias» con el control en la mano lo suelta: si no, ningún otro
  // celular podría entrar hasta liberarlo desde la PC.
  $("#seguir-no").addEventListener("click", async () => {
    $("#seguir").classList.add("oculto");
    olvidarUltima();
    if (u?.modo === "control" || u?.modo === "escribir") {
      const s = conectarTablero(u.codigo);
      if (s.tengoControl) await s.soltarControl().catch(() => {});
      s.desconectar();
    }
  });
}

// --- Pizarra ---------------------------------------------------------------
$("#btn-pizarra-escribir").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const t = await crearTablero("pizarra");
    location.href = `/pizarra?c=${t.codigo}&modo=escribir`;
  } catch (err) {
    alert(err.message || "No se pudo abrir la pizarra");
    b.disabled = false;
  }
});
$("#form-pizarra-ver").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = limpiarCodigo($("#pizarra-codigo").value);
  if (c.length === 6) location.href = `/pizarra?c=${c}`;
});

// --- Presentación ----------------------------------------------------------
$("#form-presentacion-control").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = limpiarCodigo($("#presentacion-codigo").value);
  if (c.length === 6) location.href = `/presentacion?c=${c}&modo=control`;
});

// --- Clase -----------------------------------------------------------------
$("#form-unirse").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#clase-codigo").value.trim();
  const m = raw.match(/\/s\/([A-Za-z0-9]+)(?:\?a=([A-Za-z0-9]+))?/);
  if (m) return (location.href = `/s/${m[1].toUpperCase()}${m[2] ? `?a=${m[2].toUpperCase()}` : ""}`);
  const codigo = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (codigo) location.href = `/s/${codigo}`;
});

try {
  const r = await resumenDelPlan();
  if (r.puede_crear) {
    $("#btn-crear-clase").classList.remove("oculto");
    const deOtro = !r.titular?.vigente && r.maestro_de?.find((m) => m.vigente && m.activo);
    $("#chip-clase").textContent = deOtro ? `Maestro · ${deOtro.titular_correo}` : `Plan ${r.titular?.plan_nombre || ""}`;
    $("#chip-clase").classList.add("verde");
  } else {
    $("#btn-ver-planes").classList.remove("oculto");
    $("#chip-clase").textContent = "Con plan";
  }
  if (!r.titular) $("#lnk-panel").textContent = "Planes";
} catch {
  $("#btn-ver-planes").classList.remove("oculto");
  $("#chip-clase").textContent = "Con plan";
}

// Clases abiertas donde estoy (las que dirijo y a las que me uní).
{
  const { data } = await sb
    .from("participantes")
    .select("rol, salas!participantes_sala_id_fkey(id, nombre, codigo, cerrada_en, creada_en)")
    .eq("user_id", user.id)
    .order("unido_en", { ascending: false })
    .limit(20);
  const abiertas = (data || []).filter((p) => p.salas && !p.salas.cerrada_en);
  if (abiertas.length) {
    $("#mis-clases").classList.remove("oculto");
    const etiqueta = { dirigente: "Diriges", alumno: "Alumno", oyente: "Oyente" };
    $("#lista-clases").innerHTML = abiertas.map((p) => `
      <li>
        <div>
          <div class="gente-nombre">${escapar(p.salas.nombre)}</div>
          <div class="arch-meta">${etiqueta[p.rol] || p.rol} · código ${escapar(p.salas.codigo)}</div>
        </div>
        <div class="linea">
          ${p.rol === "dirigente" ? `<a class="btn btn-lineal btn-chico" href="/sala/${p.salas.id}?control=1" title="Pizarra y diapositivas sin cámara: para la tableta">Como control</a>` : ""}
          <a class="btn btn-secundario btn-chico" href="/sala/${p.salas.id}">Entrar</a>
        </div>
      </li>`).join("");
  }
}
