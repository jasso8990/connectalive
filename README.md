# Connectalive

Tres herramientas en una app:

- **Pizarra** (gratis) — escribe en la tableta, se ve en la PC en tiempo real.
- **Presentación remota** (gratis) — la PC muestra un PDF; el celular lo
  cambia, subraya y hace zoom.
- **Clase o taller en vivo** (con plan) — video con papeles claros:
  - **Dirigente** — conduce. Ve todo, aprueba todo, decide destinatarios.
  - **Alumno** — habla, ve, escribe, comparte pantalla y manda archivos (con permiso).
  - **Oyente** — ve y escucha. Levanta la mano; si el dirigente le da la palabra, habla.

Planes: Básico (1 persona), Premium (hasta 5 maestros) e Institucional
(escuelas y empresas, hasta 30 maestros). El titular da de alta a sus
maestros en "Mi plan".

Front en HTML/JS plano · Supabase (auth, estado, realtime) · LiveKit
(audio/video/pantalla) · Netlify (hosting + funciones serverless) · Stripe.

Detalles del proyecto en `CLAUDE.md`.

## Legal y pagos

- Aviso de privacidad: `/privacidad` · Términos de uso: `/terminos`. Contacto: soporte@smrt-app.org.
- Portal de Stripe propio, por el secreto `CL_PORTAL_CONFIG` (ver `CLAUDE.md` → «Legal y portal de Stripe»).
