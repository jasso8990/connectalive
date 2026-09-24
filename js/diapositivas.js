// Diapositivas: abre un PDF con pdf.js y pinta una página ajustada a su
// contenedor (cabe completa, a lo ancho y a lo alto).
//
// Se usa pdf.js 3.x (build UMD) a propósito: la 4.x/5.x pide APIs que
// Chrome 131 de las tabletas Android todavía no trae (Uint8Array#toHex,
// Map#getOrInsertComputed) y era justo lo que tronaba en Pizarra en Vivo.

const PDFJS_VER = "3.11.174";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.js`;
const WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.js`;

let _cargando = null;
function cargarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_cargando) return _cargando;
  _cargando = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL; s.async = true;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      res(window.pdfjsLib);
    };
    s.onerror = () => { _cargando = null; rej(new Error("No se pudo cargar el lector de PDF")); };
    document.head.appendChild(s);
  });
  return _cargando;
}

/** Cuenta las páginas de un archivo local sin subirlo. */
export async function contarPaginas(archivo) {
  const pdfjs = await cargarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()) }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/**
 * Crea un visor. `canvas` es donde se pinta; `contenedor` es la caja que
 * manda el tamaño. `alMedir({ancho, alto})` avisa el tamaño CSS con que
 * quedó la página (para empatar encima el lienzo de anotaciones).
 */
export async function crearVisor({ fuente, canvas, contenedor, alMedir }) {
  const pdfjs = await cargarPdfjs();
  // Se le pasan los bytes, no la URL: algunos navegadores de tableta no
  // dejan que el worker lea una URL firmada de otro dominio.
  let datos = fuente;
  if (typeof fuente === "string") {
    const r = await fetch(fuente);
    if (!r.ok) throw new Error("No se pudo descargar el PDF");
    datos = new Uint8Array(await r.arrayBuffer());
  }
  const doc = await pdfjs.getDocument({ data: datos }).promise;
  const ctx = canvas.getContext("2d");
  let pagina = 1;
  let tarea = null;
  let turno = 0;

  async function pintar() {
    const mio = ++turno;
    if (tarea) { try { tarea.cancel(); } catch {} tarea = null; }
    const p = await doc.getPage(pagina);
    if (mio !== turno) return;
    const anchoCaja = contenedor.clientWidth || 800;
    const altoCaja = contenedor.clientHeight || 450;
    const base = p.getViewport({ scale: 1 });
    const escala = Math.max(0.1, Math.min(anchoCaja / base.width, altoCaja / base.height));
    const v = p.getViewport({ scale: escala });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(v.width * dpr);
    canvas.height = Math.round(v.height * dpr);
    canvas.style.width = `${Math.round(v.width)}px`;
    canvas.style.height = `${Math.round(v.height)}px`;
    alMedir?.({ ancho: Math.round(v.width), alto: Math.round(v.height) });
    tarea = p.render({ canvasContext: ctx, viewport: v, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] });
    try { await tarea.promise; }
    catch (e) { if (e?.name !== "RenderingCancelledException") throw e; }
  }

  // Miniaturas para la tira de quien presenta. Se pintan en su propio canvas
  // (no en el grande) y se guardan ya hechas: pasar la tira no vuelve a
  // trabajar. Van de una en una para no pelearse con la página grande.
  const minis = new Map();
  let cola = Promise.resolve();
  function miniatura(n, ancho = 220) {
    if (minis.has(n)) return Promise.resolve(minis.get(n));
    cola = cola.then(async () => {
      if (minis.has(n)) return minis.get(n);
      const p = await doc.getPage(n);
      const base = p.getViewport({ scale: 1 });
      const v = p.getViewport({ scale: ancho / base.width });
      const c = document.createElement("canvas");
      c.width = Math.round(v.width);
      c.height = Math.round(v.height);
      await p.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
      const url = c.toDataURL("image/jpeg", 0.72);
      minis.set(n, url);
      return url;
    }).catch(() => null);
    return cola;
  }

  let espera = null;
  const observador = new ResizeObserver(() => {
    clearTimeout(espera);
    espera = setTimeout(() => pintar().catch(() => {}), 80);
  });
  observador.observe(contenedor);

  return {
    get pagina() { return pagina; },
    get total() { return doc.numPages; },
    miniatura,
    async ir(n) {
      pagina = Math.max(1, Math.min(n || 1, doc.numPages));
      await pintar();
    },
    async destruir() {
      observador.disconnect();
      clearTimeout(espera);
      try { tarea?.cancel(); } catch {}
      try { await doc.destroy(); } catch {}
    },
  };
}
