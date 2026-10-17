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

// Que la pantalla no se apague mientras se proyecta o se controla (en la PC
// y en el celular). El navegador suelta el candado cada vez que la pestaña
// se oculta, así que se vuelve a pedir al regresar.
export function mantenerDespierta() {
  if (!("wakeLock" in navigator)) return;
  let candado = null;
  const pedir = async () => {
    if (document.visibilityState !== "visible" || (candado && !candado.released)) return;
    try { candado = await navigator.wakeLock.request("screen"); } catch {}
  };
  pedir();
  document.addEventListener("visibilitychange", pedir);
  // Algunos navegadores sólo lo dan tras tocar la pantalla.
  document.addEventListener("pointerdown", pedir, { passive: true });
}
