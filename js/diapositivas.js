// Diapositivas — renderiza un PDF al canvas usando pdf.js.
//
// El PDF se sube a Storage y todos los participantes lo abren con una URL
// firmada (los buckets son privados). La página actual vive en
// `salas.presentacion_pagina_actual` y se propaga por realtime (que ya
// escuchamos en sala.js). El presentador cambia de página con las flechas
// del teclado o los botones — al hacerlo, actualiza esa columna y todos los
// navegadores se sincronizan al ver el cambio.

const PDFJS_VER = "3.11.174";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.js`;
const WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.js`;

let _cargando = null;
export function cargarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_cargando) return _cargando;
  _cargando = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = PDFJS_URL; s.async = true;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      res(window.pdfjsLib);
    };
    s.onerror = () => rej(new Error("no se pudo cargar pdf.js"));
    document.head.appendChild(s);
  });
  return _cargando;
}

export async function crearVisorDiapositivas({ url, contenedorCanvas }) {
  const pdfjs = await cargarPdfjs();
  const doc = await pdfjs.getDocument(url).promise;
  const canvas = contenedorCanvas;
  const ctx = canvas.getContext("2d");
  let paginaActual = 1;
  let tareaRender = null;

  async function ir(pagina) {
    paginaActual = Math.max(1, Math.min(pagina, doc.numPages));
    if (tareaRender) { try { tareaRender.cancel(); } catch {} }
    const p = await doc.getPage(paginaActual);
    // Escala para que la página quepa en el ancho del contenedor con buena nitidez.
    const anchoDisponible = canvas.clientWidth || 1200;
    const vBase = p.getViewport({ scale: 1 });
    const escala = (anchoDisponible / vBase.width) * (window.devicePixelRatio || 1);
    const v = p.getViewport({ scale: escala });
    canvas.width = v.width;
    canvas.height = v.height;
    tareaRender = p.render({ canvasContext: ctx, viewport: v });
    await tareaRender.promise;
  }

  return {
    ir,
    get pagina() { return paginaActual; },
    get total() { return doc.numPages; },
    async destruir() {
      try { if (tareaRender) tareaRender.cancel(); } catch {}
      try { await doc.destroy(); } catch {}
    },
  };
}
