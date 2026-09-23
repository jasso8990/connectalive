# ConnectaLive — notas del proyecto

Tres herramientas en una app. Al entrar (`/inicio`) la persona elige:

1. **Pizarra** (gratis) — escribe en la tableta o el celular y se proyecta en
   la PC en tiempo real. Es lo que era Pizarra en Vivo.
2. **Presentación remota** (gratis) — la PC muestra un PDF y el celular lo
   controla: cambiar, mirar la anterior/siguiente en privado, subrayar, zoom.
3. **Clase o taller en vivo** (con plan) — videollamada tipo Zoom donde el
   papel manda: el **dirigente** conduce, los **alumnos** hablan y comparten,
   los **oyentes** ven y escuchan y pueden pedir la palabra. Dentro de la
   clase también hay pizarra y diapositivas. Todo lo que se pasa —pantalla,
   archivos— llega primero al dirigente y él decide a quién le llega.

Pizarra y presentación NO usan LiveKit (sólo Supabase Realtime), por eso no
cuestan. Sólo **dar** una clase en vivo lleva plan; unirse es gratis.

## Identidad e infra

- **Dominio**: `connectalive.smrt-app.org` (subdominio de la casa).
- **Repo local**: `repos/connectalive`. Rama `main`.
- **Netlify**: sin build. `publish = "."`, la carpeta se publica tal cual.
  Las funciones serverless viven en `netlify/functions/` con `esbuild` como
  bundler (para escribir `import`/`export` sin rollos).
- **Supabase**: comparte el proyecto `bckgumchkzlvbgcxjpwi`
  ("TERRENOS-DEL-VALLE", us-west-1) con Smartagent, Cancha y Market. Aquí
  vive el **esquema `connectalive`** (nadie más lo toca) y se apoya en
  `auth.users` común.
- **Publishable key** (pública, la seguridad la pone RLS):
  `sb_publishable_KGkAIOF6DhAK_O-YhA6phw_neDlCsBm` (misma que Smartagent).
- **LiveKit Cloud**: precios al 2026-09 (WebRTC minutos-participante):
  - **Build (gratis)**: 5 000 min/mes, hasta 100 concurrentes
  - **Ship** $50/mes: 150 000 min, extra $0.0005/min, hasta 1 000 concurrentes
  - **Scale** $500/mes: 1.5M min, extra $0.0004/min, hasta 5 000 concurrentes

  Cuando se cree, tres variables van al panel de Netlify (Site →
  Environment variables):
  - `LIVEKIT_URL` (ej: `wss://xxxxxxx.livekit.cloud`)
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
  Y una para el back-office desde funciones:
  - `SUPABASE_SERVICE_ROLE_KEY` (solo servidor, jamás en el navegador)

## Autenticación

- `signUp` manda `emailRedirectTo: location.origin`. En Supabase → Auth →
  Redirect URLs están (desde 2026-09-23) `https://connectalive.smrt-app.org`,
  `https://connectalive.smrt-app.org/**` y lo mismo para
  `connectalive.netlify.app`. El Site URL del proyecto es LigaBC: si falta
  el dominio en esa lista, el correo de confirmación manda a LigaBC.

**Todos los participantes se autentican con correo/contraseña**, mismo
patrón que Vitalia. No hay ruta de invitado anónimo. La regla vive donde
Juan la pidió: cualquiera con el link puede *intentar* entrar a una sala,
pero primero tiene que loguearse; el "código de alumno" que sólo el
dirigente reparte es lo que sube el rol de oyente → alumno. Si un colado
consigue el código, el dirigente lo baja a oyente desde la lista de gente.

## Quién puede CREAR clase (autorización + plan)

Crear clase consume min-participante de LiveKit (cuenta de Juan). Sólo
cuentas con **plan vigente** crean clase — el plan propio o el de la escuela
o empresa que las dio de alta como maestro.

### Planes (regla ×2 sobre el costo real)

Costo real de LiveKit Ship = $50/150 000 min = **$0.000333/min-participante**.

| Slug | Nombre al cliente | Precio | Maestros (con el titular) | Min-participante/mes | Costo real Juan |
|---|---|---|---|---|---|
| `clase` | **Básico** | $4.99 | 1 | 7 500 | ~$2.50 |
| `grupo` | **Premium** | $19.99 | 5 | 30 000 | ~$10 |
| `escuela` | **Institucional** (escuelas y empresas) | $49.99 | 30 | 75 000 | ~$25 |

- Viven en `connectalive.planes` (`max_maestros`, `descripcion`; lectura
  pública). **Los slugs no cambian** (los usan las Edge Functions de Stripe);
  sólo cambió el nombre que ve el cliente (2026-09-23: "Empresarial" pasó a
  "Institucional" porque aplica a escuelas y a empresas).
- Cambiar un tope = `update connectalive.planes set max_maestros = …`. No
  hay que tocar código.
- Básico = una sola persona. Quien tenga su correo y contraseña también
  puede dar clases con él (es la misma cuenta).
- Los minutos son de TODA la cuenta (titular + maestros), no por maestro.

### Equipo: el titular da de alta maestros (`/panel`)

- Tabla `connectalive.maestros (titular_id, correo, nombre)`. RLS sin
  políticas: todo pasa por funciones.
- Se da de alta **por correo**: si la persona ya tiene cuenta entra hoy; si
  no, en cuanto se registre con ese correo (no hay que reclamar nada:
  `mi_cuenta()` compara contra el correo del usuario en `auth.users`).
- Si el titular baja de plan, los maestros que ya no caben quedan **en
  pausa** (los últimos por fecha de alta), no se borran.
- Funciones: `panel_resumen()` (plan, uso del mes, uso por maestro,
  maestros, de quién soy maestro), `equipo_agregar(correo, nombre)`,
  `equipo_quitar(id)`.

### Cómo funciona el candado

- `autorizados (user_id, plan_slug, vence_en, stripe_*)` = el **titular**.
  RLS niega lectura (`autorizados_nadie`).
- `mi_cuenta()` devuelve el titular con el que das clases (tú si tu plan
  está vigente; si no, el primer titular vigente que te tenga de maestro
  dentro de su tope). `puede_crear_sala()` = `mi_cuenta() is not null`.
- Política `salas_crear` exige `dirigente_id = auth.uid() AND puede_crear_sala()`.
- Trigger `salas_al_crear` pone `salas.cuenta_id = mi_cuenta()` (la base,
  no el navegador) y `salas_dirigente_participa` inscribe al dirigente.
- **Medición de minutos**: cada navegador conectado al video llama
  `latido(sala)` cada minuto (cuenta uno cada ≥55 s por participante) y suma
  en `uso_minutos (cuenta_id, mes, dirigente_id)`. `token.js` pregunta
  `sala_puede_transmitir(sala)` (sólo service_role) y **niega el token (402)**
  si la clase terminó, el plan venció o la cuenta ya gastó sus minutos del
  mes. Sólo bloquea al ENTRAR; quien ya está dentro termina su clase.

### Alta manual (sin Stripe)

```sql
insert into connectalive.autorizados (user_id, plan_slug, vence_en, notas)
select id, 'grupo', now() + interval '1 month', 'contratado por WhatsApp'
from auth.users where email = 'nuevo@correo.com'
on conflict (user_id) do update
set plan_slug = excluded.plan_slug,
    vence_en = excluded.vence_en,
    notas = excluded.notas;
```

Juan (`jasso8990@gmail.com`) y su cuenta de pruebas (`jasso-juan@hotmail.com`)
quedan en plan `escuela` con vencimiento 2099.

### Stripe Checkout (patrón "sin webhook")

Mismo patrón que Cancha, Smartagent, Vitalia: el navegador abre Checkout,
Stripe cobra, devuelve al frente en `/panel?stripe=ok`, y el frente llama
`cl-revisar-suscripcion` que le pregunta a Stripe qué pasó y escribe la
base con `connectalive.plan_amarrar_stripe`. No hay Stripe webhook.

**Renovación mensual**: como nadie escucha a Stripe, `js/plan.js` vuelve a
llamar `cl-revisar-suscripcion` al abrir Inicio, Panel o Crear cuando el
plan viene de Stripe y ya venció (o vence en <24 h). Sin esto el cliente que
sí pagó quedaba bloqueado cada mes.

**Edge Functions** (viven en `supabase/functions/`, prefijo `cl-` porque
el proyecto Supabase es compartido y los slugs de Edge Functions NO se
separan por esquema — antes de desplegar cualquier función aquí,
`list_edge_functions` primero):

- `cl-crear-checkout` — recibe `{ plan: 'clase'|'grupo'|'escuela' }`,
  crea una sesión de Stripe Checkout con el `price_id` correspondiente y
  devuelve `{ url }`. El frente redirige. `verify_jwt=true`.
- `cl-portal-cliente` — abre el Customer Portal de Stripe (cambiar tarjeta,
  cambiar de plan con prorrateo, cancelar). Vuelve a `/panel?stripe=ok`.
  `verify_jwt=true`. Con plan de Stripe vigente, `cl-crear-checkout` se
  niega (409) para no crear una segunda suscripción: el cambio va por aquí.
- `cl-revisar-suscripcion` — sin body. Con el JWT del usuario, busca su
  customer de Stripe, saca la última sub, la mapea a plan por price_id
  y llama `plan_amarrar_stripe` (service_role) para grabar plan+vence_en+
  customer+subscription en `connectalive.autorizados`. `verify_jwt=true`.
  Sólo cuentan subs `active`, `trialing`, `past_due` o `canceled` (ésta,
  hasta el fin del periodo pagado); un pago rechazado ya no da plan.

**Secrets** que las Edge Functions leen de Supabase → Project Settings →
Edge Functions → Secrets:

- `STRIPE_SECRET_KEY`
- `Connect_Price_Basico` → slug interno `clase` ($4.99)
- `Connect_Price_Premium` → slug interno `grupo` ($19.99)
- `Connect_Price_Profecional` → slug interno `escuela` ($49.99)

Ojo: los nombres de secrets NO son los slugs — son los nombres literales
que Juan usó al crear los productos en Stripe (con la 'c' de "Profecional"
adrede para que empate con el secret). El mapeo vive en las dos Edge
Functions; si Juan agrega un plan nuevo hay que tocar ambos archivos.
- `CL_APP_ORIGEN` opcional — el fallback ya apunta a
  `connectalive.smrt-app.org`. La función también acepta el origen del
  request si viene de `connectalive.smrt-app.org` o
  `connectalive.netlify.app` (whitelist).

**Funciones SQL de soporte** (`connectalive`):

- `plan_estatus()` — `SECURITY DEFINER`, devuelve `{ plan_slug, vence_en,
  con_stripe, stripe_customer_id }` del `auth.uid()` actual. La usan la
  UI y las Edge Functions. Otorgada a `authenticated`.
- `plan_amarrar_stripe(user_id, customer, sub, plan, vence_en)` —
  `SECURITY DEFINER`, hace upsert en `autorizados`. Otorgada SÓLO a
  `service_role` (un navegador nunca se puede subir el plan solo).

**Frontend** (`js/panel.js`):

- Al cargar `/panel?stripe=ok`, invoca `cl-revisar-suscripcion` y limpia el
  URL con `history.replaceState`.
- "Contratar" invoca `cl-crear-checkout`; "Administrar pago o cambiar de
  plan" invoca `cl-portal-cliente`.

## Pasos que hay que hacer una sola vez

1. ~~Exposed schemas~~ — hecho por migración
   (`ALTER ROLE authenticator SET pgrst.db_schemas` incluye `connectalive`).
2. ~~Bucket Storage `connectalive`~~ — creado con SQL con políticas por
   sala (leer/subir para participantes; borrar para el dirigente).
3. ~~Netlify~~ — sitio `connectalive` (`connectalive.netlify.app`, rama
   `master`), con las variables de LiveKit y `SUPABASE_SERVICE_ROLE_KEY`
   puestas. Dominio `connectalive.smrt-app.org` con certificado desde el
   2026-09-23 (antes estaba escrito `srmt-app.org` y el certificado nunca
   salía). Como las otras apps, lleva en Netlify una zona DNS
   `connectalive.smrt-app.org` con registro NETLIFY → `connectalive.netlify.app`;
   sin esa zona Netlify no emitía el certificado aunque el CNAME de Namecheap
   estuviera bien.

## Cómo funcionan los roles (esto es lo que hace la app)

- **Dirigente**: quien crea la sala. Es el único que aprueba solicitudes,
  cambia roles, deja pasar archivos y decide destinatarios. En LiveKit su
  token trae `roomAdmin=true` y `canPublish=true`.
- **Alumno**: entra con voz y video. Puede pedir compartir pantalla o
  mandar archivo; el dirigente decide si sí. Token con `canPublish=true`.
- **Oyente**: entra sólo para ver y oír. Puede **pedir la palabra**
  (mano alzada). Cuando el dirigente aprueba, la función
  `netlify/functions/permiso.js` **rehace el token** y le sube los
  permisos técnicos en LiveKit (`UpdateParticipant`). Al quitarle voz,
  vuelve a bajarlos. Los oyentes NUNCA reciben archivos salvo que el
  dirigente ponga destinatarios = `todos`.

**Tres cosas distintas** (Juan lo aclaró el 2026-09-23; no mezclarlas):

1. **Dar la palabra** (mano alzada → «Dar la palabra»): `voz_activa = true`,
   **sigue siendo oyente**. Es momentánea: el oyente la suelta con «Ya
   terminé» (`soltar_palabra(sala)`, sólo apaga, y `permiso.js` acepta que
   cada quien refleje lo suyo) o el dirigente la quita desde Peticiones, donde
   arriba sale quién tiene la palabra ahora.
2. **Cambiar a alumno**: un alumno que entró con el enlace de oyentes.
3. **Cambiar a oyente**: alguien que consiguió el código de alumnos sin serlo.

**Cómo entra cada quien** (esta parte la pidió Juan explícitamente):

Cada sala tiene **DOS códigos**: `codigo` (oyentes) y `codigo_alumnos`.
El dirigente los ve al crear la sala y comparte cada uno donde toca —
el de alumnos por privado, el de oyentes por donde sea. La función
`unirse_a_sala(codigo)` (SECURITY DEFINER) recibe cualquiera de los dos y
**la base** decide el rol: oyente con el público, alumno con el de alumnos.
El navegador ya no inserta su propio renglón (antes podía ponerse de alumno
o de dirigente con sólo el enlace público). El código de alumnos sólo se lo
da `sala_codigo_alumnos(sala)` al dirigente (botón "Invitar" de la clase).

Si aún así alguien no deseado consigue el código de alumnos, el dirigente
puede **bajarlo a oyente** desde la lista de gente (queda `rol_fijado`: volver
a abrir el enlace de alumnos ya no lo sube); y si un alumno legítimo usó el
enlace de oyentes, puede **subirlo a alumno** con un botón. El rol
en el navegador es cosmético: la verdad vive en la tabla `participantes` y
LiveKit refleja el permiso técnico en caliente vía `permiso.js`.

## Tableta como control y vistas de la clase

- **Modo control** (`/sala/<id>?control=1`, botón «Tableta» del dirigente o
  «Como control» en Inicio): la PC transmite la cámara y la tableta, con la
  MISMA cuenta, escribe en la pizarra o pasa diapositivas. Ese modo **no se
  conecta a LiveKit**: la identidad de LiveKit es el id de participante y dos
  conexiones con la misma sacan a la primera (la PC). Tampoco gasta minutos.
  «Salir» en modo control NO llama `salir_de_sala` (el renglón es el mismo
  que el de la PC).
- **Vista de cada quien** (Maestro / Ambos / Presentación o Pizarra):
  selector en la barra de arriba cuando hay pizarra o PDF abierto. Es de cada
  navegador (`localStorage cl-vista`), no cambia lo que ven los demás.
  Por defecto «Ambos»: contenido a la izquierda, videos en columna con el
  dirigente arriba.

## Estructura del repo

- `index.html` / `js/index.js` — portada: entrar, registrarse o pegar un código.
- `inicio.html` / `js/inicio.js` — **elegir**: Pizarra, Presentación o Clase;
  y "Tus clases abiertas".
- `panel.html` / `js/panel.js` — Mi plan y equipo (uso, maestros, planes, pago).
- `pizarra.html` / `js/pizarra-libre.js` — pizarra libre (`?c=CÓDIGO&modo=escribir`
  en la tableta, `?c=CÓDIGO` en la PC).
- `presentacion.html` / `js/presentacion-libre.js` — presentación remota
  (`/presentacion` la PC sube el PDF; `?c=CÓDIGO&modo=control` el celular).
- `crear.html` / `js/crear.js` — el dirigente crea la clase y ve sus enlaces.
- `unirse.html` / `js/unirse.js` — entrar a una clase con enlace o código.
- `sala.html` / `js/sala.js` — la clase en vivo (LiveKit + estado en Supabase).
- `js/lienzo.js` — motor de dibujo único (pizarra libre, anotaciones sobre
  diapositivas y pizarra de la clase). Trazos en vectores normalizados.
- `js/tablero.js` — sincroniza pizarra/presentación libres (broadcast +
  `tableros` + control de un solo dispositivo con latido).
- `js/pizarra.js` — pizarra dentro de la clase (usa `lienzo.js`).
- `js/diapositivas.js` — visor PDF (pdf.js 3.11, a propósito: la 4/5 truena
  en Chrome 131 de las tabletas Android).
- `js/plan.js` — estado del plan y renovación contra Stripe.
- `js/util.js`, `js/config.js`, `js/supabase.js`, `js/auth.js`, `js/livekit.js`.
- `netlify/functions/token.js` — JWT de LiveKit; niega si no hay plan/minutos.
- `netlify/functions/permiso.js` — refleja en LiveKit el permiso que YA
  grabó el dirigente en la base (lo lee de ahí, no del navegador).
- `supabase/migrations/` — el esquema completo (las del 2026-09-22 que se
  aplicaron sin guardarse se trajeron el 2026-09-23 con sufijo a/b/c/d).
- `supabase/functions/cl-*` — Stripe.

### Pizarra y presentación libres (tablas y funciones)

- `tableros (codigo, tipo, dueno_id, trazos, pagina, paginas, zoom, pan_x,
  pan_y, pdf_path, control_token, control_visto)` + `tablero_vistas`. RLS sin
  políticas; todo por `tablero_crear / leer / tomar_control / latido /
  guardar / cerrar`.
- **Controlar** (escribir o mover diapositivas) sólo lo hace la **cuenta que
  abrió la sesión** — el código se proyecta frente a todos. Un dispositivo a
  la vez; si deja de latir 2 min, otro lo toma (o se fuerza con confirmación).
  Ver con el código lo puede cualquier cuenta.
- PDFs libres en `connectalive/libres/<dueño>/<código>/…`. Sólo los lee quien
  ya abrió ese código (`tablero_vistas`), así listar el bucket no revela nada.
  Al crear un tablero se borran los propios de más de 2 días.

## Trampas conocidas

- **Exposed schemas**: si el navegador dice "relation connectalive.salas
  does not exist" pero SQL funciona, es que falta agregar el esquema en
  Settings → API. No es un `grant` que falte.
- **CORS de la Netlify Function**: el navegador llama a
  `/.netlify/functions/token` desde `connectalive.smrt-app.org`. Como la
  llamada es al mismo origen, no hay preflight — no confundir con
  Edge Functions de Supabase, que sí piden CORS explícito.
- **Voz temporal**: el token de LiveKit se firma al momento; cambiar el
  rol en la base NO desconecta al oyente. `permiso.js` llama a
  `RoomServiceClient.updateParticipant` con los permisos nuevos para que
  se actualice en caliente.
- **LiveKit desde CDN**: se carga `livekit-client` (cliente) por CDN. El
  SDK de servidor `livekit-server-sdk` va como dependencia en
  `package.json` porque las Netlify Functions sí corren en Node.
- **Realtime de `salas`**: la tabla no estaba en la publicación
  `supabase_realtime` y nadie veía abrir la pizarra, cambiar de diapositiva
  ni terminar la clase. Ya está (migración 2026-09-23).
- **Columnas de `salas`**: después de `20260923b_cerrar_participantes.sql`
  el navegador NO tiene SELECT sobre `codigo_alumnos`. Un `select('*')` a
  `salas` truena: pedir columnas explícitas (`COLS_SALA` en `sala.js`).
- **Estado al 2026-09-23**: todas las migraciones del repo están aplicadas
  (la de cierre, `20260923b`, después del push, como pide la memoria
  "Migración que cierra acceso va DESPUÉS del push") y las tres `cl-*`
  desplegadas.
- **Cuentas QA**: `qa.connectalive@smrt-app.org` (Premium, titular) y
  `qa.alumno.connectalive@smrt-app.org` (sin plan). Contraseña en
  `.local/qa-user.md` (fuera de git). Creadas por SQL; no tienen perfil de
  Smartagent.
