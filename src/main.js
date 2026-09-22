import "./style.css";

const app = document.querySelector("#app");
const channel = new BroadcastChannel("pizarra-en-vivo");
let room = "", ctx, drawing = false, color = "#111827", width = 5;

function uid() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function paintBackground(canvas) { const c = canvas.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, canvas.width, canvas.height); }
function home() {
  app.innerHTML = `<main class="home"><nav><span class="mark">✦</span><b>Pizarra en Vivo</b></nav><section class="hero"><p class="eyebrow">PIZARRA EN VIVO</p><h1>Escribe en tu tableta.<br><em>Proyecta en tiempo real.</em></h1><p class="lead">Una pizarra limpia para enseñar, explicar ideas y dibujar desde cualquier lugar.</p><div class="cards"><button class="card warm" id="write"><span>✎</span><strong>Escribir</strong><small>Usar esta pantalla como tableta</small><b>Crear una sesión →</b></button><button class="card cool" id="present"><span>▣</span><strong>Proyectar</strong><small>Ver en la PC lo que se está escribiendo</small><b>Unirse con un código →</b></button></div></section><footer>Funciona en tu navegador · Sin instalaciones</footer></main>`;
  document.querySelector("#write").onclick = () => writer(uid());
  document.querySelector("#present").onclick = join;
}
function toolbar() { return `<header><button class="back" id="back">←</button><div><b>Pizarra en Vivo</b><span class="status">● En línea</span></div><code>SALA ${room}</code><button id="share">Copiar enlace</button></header>`; }
function writer(id) {
  room = id;
  app.innerHTML = `<main class="board">${toolbar()}<aside><label>Color <input id="color" type="color" value="${color}"></label><label>Grosor <input id="width" type="range" min="1" max="24" value="${width}"></label><button id="erase">Borrar pizarra</button><p>Comparte el código <b>${room}</b> en la pantalla que vas a proyectar.</p></aside><canvas id="canvas" width="1600" height="900"></canvas><div class="hint">Dibuja con el dedo, lápiz o mouse</div></main>`;
  const canvas = document.querySelector("#canvas"); ctx = canvas.getContext("2d"); paintBackground(canvas); bindCanvas(canvas);
  document.querySelector("#color").oninput = e => color = e.target.value;
  document.querySelector("#width").oninput = e => width = +e.target.value;
  document.querySelector("#erase").onclick = () => { paintBackground(canvas); send(); };
  bindCommon(); send();
}
function bindCanvas(canvas) {
  const pos = e => { const r = canvas.getBoundingClientRect(), p = e.touches?.[0] || e; return [(p.clientX-r.left)*canvas.width/r.width,(p.clientY-r.top)*canvas.height/r.height]; };
  const start = e => { drawing=true; const [x,y]=pos(e); ctx.beginPath();ctx.moveTo(x,y); };
  const move = e => { if(!drawing)return; e.preventDefault(); const [x,y]=pos(e);ctx.lineTo(x,y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap="round";ctx.lineJoin="round";ctx.stroke();send(); };
  canvas.onpointerdown=start; canvas.onpointermove=move; canvas.onpointerup=canvas.onpointerleave=()=>drawing=false;
}
function send(){ if(ctx) channel.postMessage({type:"board", room, image:ctx.canvas.toDataURL()}); }
function join() {
  app.innerHTML = `<main class="join"><button class="back" id="back">← Volver</button><section><p class="eyebrow">PROYECTAR</p><h1>Abre la pizarra<br>en pantalla grande.</h1><p>Ingresa el código que aparece en la tableta.</p><input id="room" maxlength="6" placeholder="CÓDIGO" autofocus><button class="primary" id="open">Proyectar →</button></section></main>`;
  document.querySelector("#open").onclick=()=> viewer(document.querySelector("#room").value.toUpperCase()); document.querySelector("#room").onkeydown=e=>e.key==="Enter"&&document.querySelector("#open").click(); bindCommon();
}
function viewer(id) {
  room=id; app.innerHTML = `<main class="viewer">${toolbar()}<div class="screen"><div class="waiting"><strong>Esperando la tableta</strong><span>La imagen aparecerá automáticamente.</span><small>SALA ${room}</small></div><img id="image" alt="Contenido de la pizarra"></div><p>Abre esta aplicación en la tableta y comparte la sala <b>${room}</b>.</p></main>`; bindCommon();
}
function bindCommon(){ document.querySelector("#back").onclick=home; const s=document.querySelector("#share"); if(s)s.onclick=()=>navigator.clipboard.writeText(`${location.origin}${location.pathname} — Sala ${room}`).then(()=>s.textContent="¡Copiado!"); }
channel.onmessage = e => { if(e.data?.type==="board" && e.data.room===room){ const img=document.querySelector("#image"); if(img) {img.src=e.data.image; document.querySelector(".waiting")?.remove();} } };
home();
