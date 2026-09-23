// Motor de dibujo. Lo usan la pizarra libre, las anotaciones sobre las
// diapositivas y la pizarra dentro de la clase.
//
// Un trazo es un objeto chico y serializable:
//   { id, g, c, w, d?, p: [[x, y], …] }
//     g  herramienta: "lapiz" | "rect" | "circulo" | "borrador"
//     c  color
//     w  grosor en milésimas del ancho del lienzo (así se ve igual en la
//        tableta que en el proyector)
//     d  diapositiva a la que pertenece (sólo en presentaciones)
//     p  puntos en 0..1 del ancho y alto del lienzo
//
// El lienzo NO sabe de red: avisa con `alTrazar` (mientras se dibuja y al
// soltar) y con `alCambiar` (deshacer, limpiar, fin de trazo). La vista
// (zoom y desplazamiento) se aplica como transform CSS sobre `envoltura`.

const redondear = (n) => Math.round(n * 10000) / 10000;

export function crearLienzo({ canvas, envoltura = null, transparente = false, alTrazar, alCambiar, alVista }) {
  const ctx = canvas.getContext("2d");
  let trazos = [];
  let editable = false;
  let herramienta = "lapiz";
  let color = "#18212f";
  let grosor = 5;
  let diapositiva = null;          // si no es null, sólo se pintan los trazos de esa diapo
  let actual = null;
  let ultimoEnvio = 0;
  const vista = { zoom: 100, x: 0, y: 0 };
  const dedos = new Map();
  let gesto = null;

  function tamano() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w, h };
  }

  function pintarTrazo(t, w, h) {
    if (!t.p?.length) return;
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
      pintarTrazo(t, w, h);
    }
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

  // --- Puntero ---------------------------------------------------------------
  function bajar(e) {
    if (!editable) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    if (herramienta === "zoom") {
      dedos.set(e.pointerId, [e.clientX, e.clientY]);
      const v = [...dedos.values()];
      gesto = v.length >= 2
        ? { dist: Math.hypot(v[1][0] - v[0][0], v[1][1] - v[0][1]), ...vista }
        : { ax: e.clientX, ay: e.clientY, ...vista };
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
    setTrazos(lista) { trazos = Array.isArray(lista) ? lista.slice() : []; redibujar(); },
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
      canvas.classList.toggle("lienzo-editable", editable);
      canvas.classList.toggle("lienzo-zoom", editable && herramienta === "zoom");
    },
    setHerramienta(h) {
      herramienta = h;
      canvas.classList.toggle("lienzo-zoom", editable && h === "zoom");
    },
    get herramienta() { return herramienta; },
    setColor(c) { color = c; },
    setGrosor(g) { grosor = +g || 5; },
    setDiapositiva(n) { diapositiva = n; redibujar(); },
    setVista(v, avisar = false) { fijarVista(v.zoom ?? 100, v.x ?? 0, v.y ?? 0, avisar); },
    redibujar,
    destruir() {
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
  const marcar = () => {
    raiz.querySelectorAll("[data-herr]").forEach((b) =>
      b.classList.toggle("activo", b.dataset.herr === lienzo.herramienta));
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
  raiz.querySelector("[data-grosor]")?.addEventListener("input", (e) => lienzo.setGrosor(e.target.value));
  raiz.querySelector('[data-accion="deshacer"]')?.addEventListener("click", () => lienzo.deshacer());
  raiz.querySelector('[data-accion="limpiar"]')?.addEventListener("click", () => {
    if (!confirm("¿Borrar todo lo que está escrito?")) return;
    lienzo.limpiar();
    alLimpiar?.();
  });
  marcar();
}
