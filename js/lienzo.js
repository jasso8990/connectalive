// Motor de dibujo. Lo usan la pizarra libre, las anotaciones sobre las
// diapositivas y la pizarra dentro de la clase.
//
// Un trazo es un objeto chico y serializable:
//   { id, g, c, w, d?, p: [[x, y], …] }
//     g  herramienta: "lapiz" | "rect" | "circulo" | "borrador" | "texto"
//     c  color
//     w  grosor en milésimas del ancho del lienzo (así se ve igual en la
//        tableta que en el proyector)
//     d  diapositiva a la que pertenece (sólo en presentaciones)
//     p  puntos en 0..1 del ancho y alto del lienzo
//
// El lienzo NO sabe de red: avisa con `alTrazar` (mientras se dibuja y al
// soltar) y con `alCambiar` (deshacer, limpiar, fin de trazo). La vista
// (zoom y desplazamiento) se aplica como transform CSS sobre `envoltura`.

// El texto es un trazo más: `g: "texto"`, con `t` (lo escrito) y `s` (tamaño
// en milésimas del ancho, como `w`); `p` son las dos esquinas del recuadro.
// Igual que en Paint: se marca el recuadro, se escribe con el teclado y el
// texto se acomoda solo dentro de ese ancho. Se escribe en un <textarea> de
// encima —así el teclado del celular y los acentos funcionan como siempre— y
// al terminar se guarda como un trazo cualquiera: viaja, se deshace y se
// borra igual que una raya.

const redondear = (n) => Math.round(n * 10000) / 10000;

const FUENTE = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ALTURA_LINEA = 1.25;
const TAM_TEXTO = 30;             // milésimas del ancho (~3%)
const CAJA_MINIMA = 0.06;         // arrastrar menos que esto cuenta como toque
const CAJA_POR_TOQUE = 0.45;      // ancho del recuadro cuando sólo se toca

export function crearLienzo({ canvas, envoltura = null, transparente = false, alTrazar, alCambiar, alVista }) {
  const ctx = canvas.getContext("2d");
  let trazos = [];
  let editable = false;
  let herramienta = "lapiz";
  let color = "#18212f";
  let grosor = 5;
  let tamanoTexto = TAM_TEXTO;
  let diapositiva = null;          // si no es null, sólo se pintan los trazos de esa diapo
  let actual = null;
  let ultimoEnvio = 0;
  const vista = { zoom: 100, x: 0, y: 0 };
  const dedos = new Map();
  let gesto = null;
  let cajaTexto = null;            // recuadro que se está marcando con el dedo
  let editor = null;               // <textarea> abierto encima del lienzo
  let editando = null;             // { t, nuevo, antes } del texto en edición

  function tamano() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w, h };
  }

  // Acomoda el texto dentro del ancho del recuadro, palabra por palabra.
  function medirTexto(t, w) {
    const px = Math.max(6, ((t.s || TAM_TEXTO) * w) / 1000);
    ctx.font = `600 ${px}px ${FUENTE}`;
    const ancho = Math.max(0.04, Math.abs((t.p[1]?.[0] ?? t.p[0][0]) - t.p[0][0])) * w;
    const lineas = [];
    for (const parrafo of String(t.t || "").split("\n")) {
      let linea = "";
      for (const palabra of parrafo.split(" ")) {
        const prueba = linea ? `${linea} ${palabra}` : palabra;
        if (linea && ctx.measureText(prueba).width > ancho) { lineas.push(linea); linea = palabra; }
        else linea = prueba;
      }
      lineas.push(linea);
    }
    return { lineas, px };
  }

  function pintarGuia(w, h) {
    const [x0, y0] = cajaTexto.p0, [x1, y1] = cajaTexto.p1;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = Math.max(1, w / 900);
    ctx.setLineDash([w / 120, w / 120]);
    ctx.strokeRect(Math.min(x0, x1) * w, Math.min(y0, y1) * h,
                   Math.abs(x1 - x0) * w, Math.abs(y1 - y0) * h);
    ctx.restore();
  }

  function pintarTrazo(t, w, h) {
    if (!t.p?.length) return;
    if (t.g === "texto") {
      if (!t.t) return;
      const { lineas, px } = medirTexto(t, w);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = t.c || "#18212f";
      ctx.textBaseline = "top";
      const x = Math.min(t.p[0][0], t.p[1]?.[0] ?? 1) * w;
      const y = Math.min(t.p[0][1], t.p[1]?.[1] ?? 1) * h;
      lineas.forEach((l, i) => ctx.fillText(l, x, y + i * px * ALTURA_LINEA));
      return;
    }
    ctx.globalCompositeOperation = t.g === "borrador" ? "destination-out" : "source-over";
    ctx.strokeStyle = t.c || "#18212f";
    ctx.lineWidth = Math.max(1, ((t.w || 5) * w) / 1000);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const [x0, y0] = t.p[0];
    if ((t.g === "rect" || t.g === "circulo") && t.p.length > 1) {
      const [x1, y1] = t.p[t.p.length - 1];
      const X = x0 * w, Y = y0 * h, W = (x1 - x0) * w, H = (y1 - y0) * h;
      if (t.g === "rect") ctx.rect(X, Y, W, H);
      else ctx.ellipse(X + W / 2, Y + H / 2, Math.abs(W / 2), Math.abs(H / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    ctx.moveTo(x0 * w, y0 * h);
    if (t.p.length === 1) ctx.lineTo(x0 * w + 0.1, y0 * h + 0.1);
    for (let i = 1; i < t.p.length; i++) ctx.lineTo(t.p[i][0] * w, t.p[i][1] * h);
    ctx.stroke();
  }

  function redibujar() {
    const { w, h } = tamano();
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    if (!transparente) { ctx.fillStyle = "#fffefb"; ctx.fillRect(0, 0, w, h); }
    for (const t of trazos) {
      if (diapositiva != null && t.d !== diapositiva) continue;
      // Lo que se está escribiendo lo dibuja el <textarea> de encima; pintarlo
      // aquí también se vería doble.
      if (editando && t.id === editando.t.id) continue;
      pintarTrazo(t, w, h);
    }
    if (cajaTexto) pintarGuia(w, h);
    // El borrador en un lienzo con fondo deja hoyos transparentes: se
    // vuelve a poner el fondo detrás.
    if (!transparente) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fffefb";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function punto(e) {
    const r = canvas.getBoundingClientRect();
    return [
      redondear(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))),
      redondear(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))),
    ];
  }

  function aplicarVista() {
    if (!envoltura) return;
    envoltura.style.transform = `translate(${vista.x}%, ${vista.y}%) scale(${vista.zoom / 100})`;
  }

  function fijarVista(z, x, y, avisar) {
    vista.zoom = Math.round(Math.max(100, Math.min(300, z)));
    vista.x = vista.zoom === 100 ? 0 : Math.round(Math.max(-40, Math.min(40, x)));
    vista.y = vista.zoom === 100 ? 0 : Math.round(Math.max(-40, Math.min(40, y)));
    aplicarVista();
    if (avisar) alVista?.({ ...vista });
  }

  // --- Texto -----------------------------------------------------------------
  function altoTexto(t) {
    const { w, h } = tamano();
    const { lineas, px } = medirTexto(t, w);
    return (lineas.length * px * ALTURA_LINEA) / h;
  }

  /** Texto que cae bajo el dedo (para corregir uno ya escrito). */
  function textoEn(p) {
    for (let i = trazos.length - 1; i >= 0; i--) {
      const t = trazos[i];
      if (t.g !== "texto" || !(t.p?.length >= 2)) continue;
      if (diapositiva != null && t.d !== diapositiva) continue;
      const x0 = Math.min(t.p[0][0], t.p[1][0]), x1 = Math.max(t.p[0][0], t.p[1][0]);
      const y0 = Math.min(t.p[0][1], t.p[1][1]);
      if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y0 + Math.max(altoTexto(t), 0.03)) return t;
    }
    return null;
  }

  function colocarEditor() {
    if (!editor || !editando) return;
    const { t } = editando;
    const r = canvas.getBoundingClientRect();
    editor.style.left = `${Math.min(t.p[0][0], t.p[1][0]) * 100}%`;
    editor.style.top = `${Math.min(t.p[0][1], t.p[1][1]) * 100}%`;
    editor.style.width = `${Math.abs(t.p[1][0] - t.p[0][0]) * 100}%`;
    editor.style.fontSize = `${Math.max(6, ((t.s || TAM_TEXTO) * r.width) / 1000)}px`;
    editor.style.color = t.c || "#18212f";
    editor.style.height = "auto";
    editor.style.height = `${editor.scrollHeight}px`;
  }

  function abrirEditor(t, nuevo) {
    if (editor) cerrarEditor(true);
    editando = { t, nuevo, antes: t.t || "" };
    const ta = document.createElement("textarea");
    ta.className = "lienzo-texto";
    ta.value = t.t || "";
    ta.rows = 1;
    ta.spellcheck = false;
    ta.placeholder = "Escribe…";
    ta.setAttribute("aria-label", "Texto");
    editor = ta;
    (canvas.parentElement || canvas).appendChild(ta);
    colocarEditor();
    redibujar();

    ta.addEventListener("input", () => {
      t.t = ta.value;
      colocarEditor();
      const ahora = performance.now();
      // Se va mandando mientras se escribe: en el proyector la frase aparece
      // sola, como cuando se dibuja.
      if (ahora - ultimoEnvio > 200) { ultimoEnvio = ahora; alTrazar?.(t, false); }
    });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();  // la clase escucha flechas y espacio para las diapositivas
      if (e.key === "Escape") { e.preventDefault(); cerrarEditor(false); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cerrarEditor(true); }
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.addEventListener("blur", () => cerrarEditor(true));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  /** Cierra el recuadro: guarda lo escrito, o lo deja como estaba. */
  function cerrarEditor(guardar) {
    if (!editor || !editando) return;
    const { t, antes } = editando;
    const ta = editor;
    editor = null;
    editando = null;
    ta.remove();
    t.t = (guardar ? ta.value : antes).replace(/\s+$/, "");
    const vacio = !t.t;
    if (vacio) {
      const i = trazos.indexOf(t);
      if (i >= 0) trazos.splice(i, 1);
    }
    redibujar();
    // Con texto va como cualquier trazo terminado; si quedó vacío se manda la
    // lista entera para que los demás lo quiten de su pizarra.
    if (!vacio) alTrazar?.(t, true);
    alCambiar?.(trazos);
  }

  /** Quita el recuadro sin avisar a nadie (lo de afuera manda). */
  function descartarEditor() {
    if (!editor) return;
    const ta = editor;
    editor = null;
    editando = null;
    ta.remove();
  }

  // --- Puntero ---------------------------------------------------------------
  function bajar(e) {
    if (!editable) return;
    e.preventDefault();
    // Con un recuadro abierto, el primer toque afuera es para terminarlo.
    if (editor) { cerrarEditor(true); return; }
    canvas.setPointerCapture?.(e.pointerId);
    if (herramienta === "zoom") {
      dedos.set(e.pointerId, [e.clientX, e.clientY]);
      const v = [...dedos.values()];
      gesto = v.length >= 2
        ? { dist: Math.hypot(v[1][0] - v[0][0], v[1][1] - v[0][1]), ...vista }
        : { ax: e.clientX, ay: e.clientY, ...vista };
      return;
    }
    if (herramienta === "texto") {
      const p = punto(e);
      const existente = textoEn(p);
      if (existente) { abrirEditor(existente, false); return; }
      cajaTexto = { p0: p, p1: p };
      return;
    }
    actual = {
      id: crypto.randomUUID().slice(0, 12),
      g: herramienta,
      c: color,
      w: herramienta === "borrador" ? Math.max(18, grosor * 3) : grosor,
      p: [punto(e)],
    };
    if (diapositiva != null) actual.d = diapositiva;
    trazos.push(actual);
    redibujar();
  }

  function mover(e) {
    if (herramienta === "zoom" && dedos.has(e.pointerId)) {
      e.preventDefault();
      dedos.set(e.pointerId, [e.clientX, e.clientY]);
      const v = [...dedos.values()];
      const r = canvas.getBoundingClientRect();
      if (v.length >= 2 && gesto?.dist) {
        const d = Math.hypot(v[1][0] - v[0][0], v[1][1] - v[0][1]);
        fijarVista(gesto.zoom * d / gesto.dist, gesto.x, gesto.y, true);
      } else if (v.length === 1 && gesto?.ax != null) {
        fijarVista(gesto.zoom, gesto.x + ((v[0][0] - gesto.ax) / r.width) * 100,
                   gesto.y + ((v[0][1] - gesto.ay) / r.height) * 100, true);
      }
      return;
    }
    if (cajaTexto) {
      e.preventDefault();
      cajaTexto.p1 = punto(e);
      redibujar();
      return;
    }
    if (!actual) return;
    e.preventDefault();
    const p = punto(e);
    if (actual.g === "rect" || actual.g === "circulo") actual.p = [actual.p[0], p];
    else actual.p.push(p);
    redibujar();
    const ahora = performance.now();
    if (ahora - ultimoEnvio > 40) { ultimoEnvio = ahora; alTrazar?.(actual, false); }
  }

  function soltar(e) {
    if (herramienta === "zoom") {
      dedos.delete(e.pointerId);
      const v = [...dedos.values()];
      gesto = v.length === 1 ? { ax: v[0][0], ay: v[0][1], ...vista } : null;
      return;
    }
    if (cajaTexto) {
      const { p0, p1 } = cajaTexto;
      cajaTexto = null;
      let x0 = Math.min(p0[0], p1[0]);
      let x1 = Math.max(p0[0], p1[0]);
      const y0 = Math.min(p0[1], p1[1]);
      // Un toque sin arrastrar abre un recuadro cómodo, como en Paint.
      if (x1 - x0 < CAJA_MINIMA) {
        x1 = Math.min(1, x0 + CAJA_POR_TOQUE);
        if (x1 - x0 < 0.2) x0 = Math.max(0, x1 - 0.2);
      }
      const t = {
        id: crypto.randomUUID().slice(0, 12),
        g: "texto",
        c: color,
        s: tamanoTexto,
        t: "",
        p: [[redondear(x0), redondear(y0)],
            [redondear(x1), redondear(Math.max(y0 + 0.08, Math.max(p0[1], p1[1])))]],
      };
      if (diapositiva != null) t.d = diapositiva;
      trazos.push(t);
      abrirEditor(t, true);
      return;
    }
    if (!actual) return;
    const t = actual;
    actual = null;
    alTrazar?.(t, true);
    alCambiar?.(trazos);
  }

  canvas.addEventListener("pointerdown", bajar);
  canvas.addEventListener("pointermove", mover);
  canvas.addEventListener("pointerup", soltar);
  canvas.addEventListener("pointercancel", soltar);
  canvas.style.touchAction = "none";

  const observador = new ResizeObserver(() => redibujar());
  observador.observe(canvas);
  redibujar();

  return {
    get trazos() { return trazos; },
    get vista() { return { ...vista }; },
    setTrazos(lista) { descartarEditor(); trazos = Array.isArray(lista) ? lista.slice() : []; redibujar(); },
    // Llega un trazo de otro dispositivo: si ya existe (se está dibujando), se reemplaza.
    recibirTrazo(t) {
      if (!t?.id) return;
      const i = trazos.findIndex((x) => x.id === t.id);
      if (i >= 0) trazos[i] = t; else trazos.push(t);
      redibujar();
    },
    deshacer() {
      for (let i = trazos.length - 1; i >= 0; i--) {
        if (diapositiva == null || trazos[i].d === diapositiva) { trazos.splice(i, 1); break; }
      }
      redibujar();
      alCambiar?.(trazos);
    },
    limpiar() {
      trazos = diapositiva == null ? [] : trazos.filter((t) => t.d !== diapositiva);
      redibujar();
      alCambiar?.(trazos);
    },
    setEditable(v) {
      editable = !!v;
      if (!editable) cerrarEditor(true);
      canvas.classList.toggle("lienzo-editable", editable);
      canvas.classList.toggle("lienzo-zoom", editable && herramienta === "zoom");
      canvas.classList.toggle("lienzo-texto-activo", editable && herramienta === "texto");
    },
    setHerramienta(h) {
      if (h !== "texto") cerrarEditor(true);
      herramienta = h;
      canvas.classList.toggle("lienzo-zoom", editable && h === "zoom");
      canvas.classList.toggle("lienzo-texto-activo", editable && h === "texto");
    },
    get herramienta() { return herramienta; },
    setColor(c) { color = c; },
    setGrosor(g) { grosor = +g || 5; },
    setTamanoTexto(s) { tamanoTexto = Math.max(8, Math.min(200, +s || TAM_TEXTO)); },
    setDiapositiva(n) { cerrarEditor(true); diapositiva = n; redibujar(); },
    setVista(v, avisar = false) { fijarVista(v.zoom ?? 100, v.x ?? 0, v.y ?? 0, avisar); },
    redibujar,
    destruir() {
      descartarEditor();
      observador.disconnect();
      canvas.removeEventListener("pointerdown", bajar);
      canvas.removeEventListener("pointermove", mover);
      canvas.removeEventListener("pointerup", soltar);
      canvas.removeEventListener("pointercancel", soltar);
    },
  };
}

// Mantiene `marco` en proporción fija (16:9 por defecto) y lo más grande que
// quepa en `caja`. La tableta y el proyector ven así la misma forma de
// pizarra aunque sus pantallas sean distintas.
export function ajustarMarco(caja, marco, proporcion = 16 / 9) {
  const ajustar = () => {
    const w = caja.clientWidth, h = caja.clientHeight;
    if (!w || !h) return;
    const ancho = Math.min(w, h * proporcion);
    marco.style.width = `${Math.floor(ancho)}px`;
    marco.style.height = `${Math.floor(ancho / proporcion)}px`;
  };
  const o = new ResizeObserver(ajustar);
  o.observe(caja);
  ajustar();
  return () => o.disconnect();
}

// Barra de herramientas estándar (la misma en pizarra libre y en la clase).
// `raiz` debe tener botones con data-herr, data-color, un input[type=range]
// con data-grosor y botones data-accion="deshacer" / "limpiar".
export function conectarBarra(raiz, lienzo, { alLimpiar } = {}) {
  const control = raiz.querySelector("[data-grosor]");
  const marcar = () => {
    raiz.querySelectorAll("[data-herr]").forEach((b) =>
      b.classList.toggle("activo", b.dataset.herr === lienzo.herramienta));
    // El mismo deslizador sirve para el grosor de la raya y para el tamaño
    // de la letra; lo que cambia es el nombre.
    if (control) {
      const que = lienzo.herramienta === "texto" ? "Tamaño del texto" : "Grosor";
      control.setAttribute("aria-label", que);
      control.closest(".barra-grosor")?.setAttribute("title", que);
    }
  };
  raiz.querySelectorAll("[data-herr]").forEach((b) => b.addEventListener("click", () => {
    lienzo.setHerramienta(b.dataset.herr);
    marcar();
  }));
  raiz.querySelectorAll("[data-color]").forEach((b) => {
    b.style.background = b.dataset.color;
    b.addEventListener("click", () => {
      lienzo.setColor(b.dataset.color);
      raiz.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("activo", x === b));
      if (lienzo.herramienta === "borrador" || lienzo.herramienta === "zoom") {
        lienzo.setHerramienta("lapiz");
        marcar();
      }
    });
  });
  control?.addEventListener("input", (e) => {
    lienzo.setGrosor(e.target.value);
    lienzo.setTamanoTexto(e.target.value * 6);
  });
  raiz.querySelector('[data-accion="deshacer"]')?.addEventListener("click", () => lienzo.deshacer());
  raiz.querySelector('[data-accion="limpiar"]')?.addEventListener("click", () => {
    if (!confirm("¿Borrar todo lo que está escrito?")) return;
    lienzo.limpiar();
    alLimpiar?.();
  });
  marcar();
}
