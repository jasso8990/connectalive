# ConnectaLive — notas del proyecto

Videollamada tipo clase o taller. La forma es Zoom, pero el papel manda:
el **dirigente** conduce, los **alumnos** pueden hablar y compartir, los
**oyentes** ven y escuchan. Un oyente puede pedir la palabra y el dirigente
se la da (o se la quita) cuando quiere. Todo lo que se pasa —pantalla,
archivos— llega primero al dirigente y él decide a quién le llega.

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

**Todos los participantes se autentican con correo/contraseña**, mismo
patrón que Vitalia. No hay ruta de invitado anónimo. La regla vive donde
Juan la pidió: cualquiera con el link puede *intentar* entrar a una sala,
pero primero tiene que loguearse; el "código de alumno" que sólo el
dirigente reparte es lo que sube el rol de oyente → alumno. Si un colado
consigue el código, el dirigente lo baja a oyente desde la lista de gente.

## Quién puede CREAR sala (autorización + plan)

Crear sala consume min-participante de LiveKit (cuenta de Juan). Sólo
cuentas con **plan vigente** crean sala. Cualquiera se registra, se
une a salas que le compartan, y usa pizarra / presentaciones gratis.

### Planes (regla ×2 sobre el costo real)

Costo real de LiveKit Ship = $50/150 000 min = **$0.000333/min-participante**.

| Slug | Nombre | Precio | Min-participante/mes | Costo real Juan |
|---|---|---|---|---|
| `clase` | Clase | $4.99 | 7 500 | ~$2.50 |
| `grupo` | Grupo | $19.99 | 30 000 | ~$10 |
| `escuela` | Escuela | $49.99 | 75 000 | ~$25 |

Viven en `connectalive.planes` (lectura pública para pintarlos en la
pantalla de "no autorizado").

### Cómo funciona el candado

- Tabla `connectalive.autorizados (user_id, plan_slug, vence_en, stripe_customer_id, stripe_subscription_id, autorizado_en, notas)`, RLS niega lectura (`autorizados_nadie`).
- Función `connectalive.puede_crear_sala()` `SECURITY DEFINER` devuelve
  `true` si el usuario tiene `plan_slug` y `vence_en > now()`.
- Política `salas_crear` exige `dirigente_id = auth.uid() AND puede_crear_sala()`.
- `js/crear.js` llama la RPC al cargar; si `false`, esconde el formulario y
  muestra `#paso-no-autorizado` con los 3 planes y un botón "Contratar"
  por plan que apunta a `/api/checkout?plan=<slug>`.

### Alta manual (mientras no está Stripe)

```sql
insert into connectalive.autorizados (user_id, plan_slug, vence_en, notas)
select id, 'grupo', now() + interval '1 month', 'contratado por WhatsApp'
from auth.users where email = 'nuevo@correo.com'
on conflict (user_id) do update
set plan_slug = excluded.plan_slug,
    vence_en = excluded.vence_en,
    notas = excluded.notas;
```

Juan (`jasso8990@gmail.com`) queda en plan `escuela` con vencimiento 2099.

### Pendiente: Stripe Checkout automático

Faltan:
1. Crear cuenta Stripe (o usar la que exista) y crear 3 productos
   recurrentes: precio $4.99, $19.99, $49.99 mensual.
2. Meter en Netlify → Environment variables:
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_CLASE`, `STRIPE_PRICE_GRUPO`, `STRIPE_PRICE_ESCUELA`
3. Escribir `netlify/functions/checkout.js` (crea sesión de Stripe Checkout
   con el `price_id` según el slug y el correo del usuario logueado) y
   `netlify/functions/stripe-webhook.js` (recibe `checkout.session.completed`
   y `customer.subscription.updated/deleted`, y con `SUPABASE_SERVICE_ROLE_KEY`
   escribe/actualiza `connectalive.autorizados`).
4. Rutas en `netlify.toml`: `/api/checkout` → `/.netlify/functions/checkout`
   y `/api/stripe-webhook` → `/.netlify/functions/stripe-webhook`.
5. Copiar el URL del webhook en el panel de Stripe.

### Pendiente: medir uso y bloquear al pasarse

Hoy el plan sólo controla *quién crea*, no el *volumen*. Cuando un cliente
real esté consumiendo, agregar tope: `netlify/functions/token.js` (que
emite el JWT de LiveKit) niega token si el mes actual ya rebasó
`minutos_participante_mes` del plan del dirigente de la sala. Fuente del
conteo: webhook de LiveKit (`participant_left` con duración) o cálculo
periódico desde el API de LiveKit.

## Pasos que hay que hacer una sola vez

1. ~~Exposed schemas~~ — hecho por migración
   (`ALTER ROLE authenticator SET pgrst.db_schemas` incluye `connectalive`).
2. ~~Bucket Storage `connectalive`~~ — creado con SQL con políticas por
   sala (leer/subir para participantes; borrar para el dirigente).
3. **Netlify** (falta): importar el repo `jasso8990/connectalive` como
   sitio nuevo y agregar `connectalive.smrt-app.org` en Domain management.
   En Namecheap, CNAME `connectalive → <site>.netlify.app`.
4. **LiveKit Cloud** (falta): crear cuenta gratis, meter las 3 variables
   (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) más
   `SUPABASE_SERVICE_ROLE_KEY` en Netlify → Site → Environment variables.

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

**Cómo entra cada quien** (esta parte la pidió Juan explícitamente):

Cada sala tiene **DOS códigos**: `codigo` (oyentes) y `codigo_alumnos`.
El dirigente los ve al crear la sala y comparte cada uno donde toca —
el de alumnos por privado, el de oyentes por donde sea. La función
`buscar_sala_por_codigo` recibe cualquiera de los dos y devuelve el rol
correspondiente. Cuando el navegador inserta el participante, va con ese
rol de entrada — no se necesita promoción manual para los alumnos.

Si aún así alguien no deseado consigue el código de alumnos, el dirigente
puede **bajarlo a oyente** desde la lista de gente; y si un alumno legítimo
usó el enlace de oyentes, puede **subirlo a alumno** con un botón. El rol
en el navegador es cosmético: la verdad vive en la tabla `participantes` y
LiveKit refleja el permiso técnico en caliente vía `permiso.js`.

## Estructura del repo

- `index.html` / `js/index.js` — portada: entrar, crear sala o unirse.
- `crear.html` / `js/crear.js` — dirigente crea sala y ve el código.
- `unirse.html` / `js/unirse.js` — cualquiera pega el código y entra.
- `sala.html` / `js/sala.js` — la sala en vivo (LiveKit + estado en Supabase).
- `js/config.js` — URL de Supabase y publishable key.
- `js/supabase.js` — cliente Supabase con `db: { schema: 'connectalive' }`.
- `js/auth.js` — helpers de sesión.
- `js/livekit.js` — conexión y helpers de LiveKit desde CDN.
- `netlify/functions/token.js` — emite JWT de LiveKit con permisos según rol.
- `netlify/functions/permiso.js` — el dirigente cambia el rol y esta función
  refleja el permiso técnico en LiveKit (subir/bajar `canPublish`) sin
  necesidad de que el oyente se reconecte.
- `supabase/migrations/20260921_connectalive_esquema.sql` — el esquema.

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
