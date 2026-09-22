// Pizarra colaborativa en la sala.
//
// Origen: repo `pizarra-en-vivo` (dibujar en tableta, proyectar en pantalla).
// Aquí vive dentro de la sala. Las diferencias importantes con el original:
//
//   • Sincronización por Supabase Realtime BROADCAST, no BroadcastChannel:
//     los mensajes viajan entre dispositivos reales, no sólo pestañas del
//     mismo navegador. Broadcast NO toca la base — es efímero, como un
//     WebSocket con temas.
//   • Se manda trazo por trazo (segmentos), no la imagen entera del canvas.
//     El original hacía toDataURL() en cada `mousemove` — con 30 alumnos
//     colapsaba. Aquí un trazo es ~40 bytes.
//   • Control: sólo dibuja quien es "controlador" (guardado en
//     `salas.pizarra_controlador_id`). El dirigente empieza controlando;
//     puede pasar el control a un alumno cuando quiera. Los oyentes ven.
//   • Al entrar tarde, quien llega pide un snapshot al controlador via
//     broadcast; el controlador contesta con el dataURL una sola vez.

export function crearPizarra({ salaId, sb, participanteId, esControlador, esDirigente }) {
  const canvas = document.getElementById("pz-canvas");
  const ctx = canvas.getContext("2d");
  const barra = document.getElementById("pz-toolbar");
  let color = "#111827";
  let grosor = 5;
  let dibujando = false;
  let ultimo = null;

  function fondo() {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function trazar(x0, y0, x1, y1, col, gr) {
    ctx.strokeStyle = col;
    ctx.lineWidth = gr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function coordDe(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return [
      ((p.clientX - r.left) * canvas.width) / r.width,
      ((p.clientY - r.top) * canvas.height) / r.height,
    ];
  }

  // --- Realtime broadcast ---
  const canal = sb.channel(`pizarra-${salaId}`, { config: { broadcast: { self: false } } });

  canal.on("broadcast", { event: "trazo" }, ({ payload }) => {
    trazar(payload.x0, payload.y0, payload.x1, payload.y1, payload.color, payload.grosor);
  });
  canal.on("broadcast", { event: "borrar" }, () => fondo());
  canal.on("broadcast", { event: "pedir_snapshot" }, ({ payload }) => {
    // Sólo contesta quien está controlando (evita 30 respuestas por 1 pregunta).
    if (!estadoActual.esControlador) return;
    canal.send({
      type: "broadcast",
      event: "snapshot",
      payload: { para: payload.de, imagen: canvas.toDataURL("image/png") },
    });
  });
  canal.on("broadcast", { event: "snapshot" }, ({ payload }) => {
    if (payload.para !== participanteId) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = payload.imagen;
  });

  canal.subscribe(async (status) => {
    if (status === "SUBSCRIBED" && !estadoActual.esControlador) {
      // Le pido a quien esté controlando que me mande su imagen.
      canal.send({
        type: "broadcast",
        event: "pedir_snapshot",
        payload: { de: participanteId },
      });
    }
  });

  // --- Dibujo local del controlador -----------------------------------------
  function iniciarDibujo(e) {
    if (!estadoActual.esControlador) return;
    e.preventDefault();
    dibujando = true;
    ultimo = coordDe(e);
  }

  function mover(e) {
    if (!dibujando) return;
    e.preventDefault();
    const [x, y] = coordDe(e);
    const [x0, y0] = ultimo;
    trazar(x0, y0, x, y, color, grosor);
    canal.send({
      type: "broadcast",
      event: "trazo",
      payload: { x0, y0, x1: x, y1: y, color, grosor },
    });
    ultimo = [x, y];
  }

  function soltar() { dibujando = false; ultimo = null; }

  canvas.addEventListener("pointerdown", iniciarDibujo);
  canvas.addEventListener("pointermove", mover);
  canvas.addEventListener("pointerup", soltar);
  canvas.addEventListener("pointerleave", soltar);

  document.getElementById("pz-color").addEventListener("input", (e) => (color = e.target.value));
  document.getElementById("pz-grosor").addEventListener("input", (e) => (grosor = +e.target.value));
  document.getElementById("pz-borrar").addEventListener("click", () => {
    if (!estadoActual.esControlador) return;
    fondo();
    canal.send({ type: "broadcast", event: "borrar", payload: {} });
  });

  fondo();

  // --- Estado y API pública -------------------------------------------------
  const estadoActual = { esControlador, esDirigente };
  aplicarPermisos();

  function aplicarPermisos() {
    canvas.style.cursor = estadoActual.esControlador ? "crosshair" : "not-allowed";
    barra.classList.toggle("oculto", !estadoActual.esControlador);
  }

  return {
    setControlador(nuevo) {
      estadoActual.esControlador = nuevo;
      aplicarPermisos();
    },
    setDirigente(nuevo) { estadoActual.esDirigente = nuevo; },
    limpiar() {
      try { sb.removeChannel(canal); } catch {}
    },
  };
}
