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
- **LiveKit Cloud**: cuenta gratis (10,000 minutos-participante al mes,
  hasta 100 concurrentes). Cuando se cree, tres variables van al panel de
  Netlify (Site → Environment variables):
  - `LIVEKIT_URL` (ej: `wss://xxxxxxx.livekit.cloud`)
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
  Y una para el back-office desde funciones:
  - `SUPABASE_SERVICE_ROLE_KEY` (solo servidor, jamás en el navegador)

## Pasos que hay que hacer una sola vez en el panel

1. **Supabase → Settings → API → Exposed schemas**: agregar
   `connectalive` a la lista (además del `public` que ya está). Sin esto,
   `@supabase/supabase-js` no ve las tablas nuevas aunque los `grant` estén
   dados.
2. **Supabase → Storage**: crear bucket `connectalive`, privado. Sin
   políticas iniciales; los archivos se firman con el token del usuario y
   el dirigente los autoriza en la tabla `archivos`.
3. **Netlify → Site → Domain**: agregar `connectalive.smrt-app.org` y en
   Namecheap dejar el CNAME apuntando al sitio (ver la nota transversal
   `smrt-app-org-subdominios`).

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
