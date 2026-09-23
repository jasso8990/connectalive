// Ayudantes pequeños que usan varias pantallas.

export function escapar(t) {
  return String(t ?? "").replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function mostrarMensaje(nodo, texto, tipo = "error") {
  nodo.textContent = texto;
  nodo.className = `mensaje ${tipo}`;
  nodo.classList.remove("oculto");
}

export async function copiar(boton, texto) {
  try {
    await navigator.clipboard.writeText(texto);
    const original = boton.textContent;
    boton.textContent = "Copiado";
    setTimeout(() => (boton.textContent = original), 1500);
  } catch {
    prompt("Copia este texto:", texto);
  }
}

// Sólo rutas de esta misma app (evita que ?volver= mande a otro sitio).
export function rutaSegura(volver, porDefecto = "/inicio") {
  if (typeof volver !== "string" || !volver.startsWith("/") || volver.startsWith("//") || volver.startsWith("/\\")) {
    return porDefecto;
  }
  return volver;
}

export function pantallaCompleta(el) {
  if (document.fullscreenElement) return document.exitFullscreen();
  const pedir = el.requestFullscreen || el.webkitRequestFullscreen;
  if (pedir) return pedir.call(el);
}
