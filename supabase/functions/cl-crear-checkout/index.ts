/* ============================================================
   cl-crear-checkout · abre la sesión de Stripe Checkout (ConnectaLive)
   ------------------------------------------------------------
   Patrón "sin webhook", mismo que Cancha / Smartagent / Vitalia: la app
   abre Checkout, Stripe cobra y devuelve al cliente a `success_url`. Al
   volver, el frente llama `cl-revisar-suscripcion` (la otra Edge Function)
   que le pregunta a Stripe qué pasó y actualiza la base con
   `connectalive.plan_amarrar_stripe`.

   Secretos que TIENE QUE tener el proyecto (Supabase → Project Settings →
   Edge Functions → Secrets):
     STRIPE_SECRET_KEY          sk_/rk_test_... o sk_/rk_live_...
     Connect_Price_Basico       price_id del plan Básico $4.99         (slug 'clase')
     Connect_Price_Premium      price_id del plan Premium $19.99       (slug 'grupo')
     Connect_Price_Profecional  price_id del plan Institucional $49.99 (slug 'escuela')

   Los slugs internos (clase/grupo/escuela) NO cambian: los nombres raros
   son sólo los que Juan usó al crear los productos en Stripe.

   ⚠️  EL NOMBRE LLEVA `cl-` A PROPÓSITO. Las Edge Functions NO se separan
   por esquema: el slug es único para TODO el proyecto de Supabase, y este
   proyecto lo comparten Cancha (`cn-*`), Smartagent y SMRT-APP Market.
   Antes de desplegar cualquier cosa aquí: `list_edge_functions` primero.
============================================================ */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responde(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const PRECIOS: Record<string, string | undefined> = {
  clase:   Deno.env.get("Connect_Price_Basico"),
  grupo:   Deno.env.get("Connect_Price_Premium"),
  escuela: Deno.env.get("Connect_Price_Profecional"),
};

// Fallback si el request no trae origen legible.
const ORIGEN_POR_DEFECTO = Deno.env.get("CL_APP_ORIGEN")
  ?? "https://connectalive.smrt-app.org";

// Se aceptan sólo estos hosts para regresar el checkout (evita que un
// atacante ponga success_url en otro dominio via el header Origin).
const HOSTS_OK = new Set([
  "connectalive.smrt-app.org",
  "connectalive.netlify.app",
  "localhost:8888",
  "localhost:5173",
]);

function origenSeguro(req: Request): string {
  const raw = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
  try {
    const u = new URL(raw);
    if (HOSTS_OK.has(u.host)) return `${u.protocol}//${u.host}`;
  } catch { /* ignora */ }
  return ORIGEN_POR_DEFECTO;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responde({ error: "Sólo POST" }, 405);

  const STRIPE = Deno.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE) return responde({ error: "Stripe no está configurado (falta STRIPE_SECRET_KEY)" }, 500);

  try {
    const { plan } = await req.json();
    const price = PRECIOS[plan];
    if (!price) return responde({ error: `Plan '${plan}' no configurado` }, 400);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        db: { schema: "connectalive" },
        global: { headers: { Authorization: req.headers.get("Authorization")! } },
      },
    );
    const { data: yo, error: errYo } = await supa.auth.getUser();
    if (errYo || !yo?.user) return responde({ error: "Sesión inválida" }, 401);

    // Si el usuario ya tiene customer en Stripe (reactivación), se le pega.
    const { data: estatus } = await supa.rpc("plan_estatus");
    const estatus0 = Array.isArray(estatus) ? estatus[0] : estatus;

    // Con una suscripción de Stripe todavía vigente NO se abre otro
    // Checkout: saldría una segunda suscripción y se cobraría doble. El
    // cambio de plan va por el portal (cl-portal-cliente).
    const vigente = estatus0?.vence_en && new Date(estatus0.vence_en as string) > new Date();
    if (estatus0?.con_stripe && vigente) {
      return responde({
        error: "Ya tienes un plan activo. Para cambiarlo usa «Administrar pago o cambiar de plan».",
      }, 409);
    }

    const origen = origenSeguro(req);

    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("line_items[0][price]", price);
    body.set("line_items[0][quantity]", "1");
    body.set("success_url", `${origen}/panel?stripe=ok`);
    body.set("cancel_url",  `${origen}/panel?stripe=cancel`);
    body.set("client_reference_id", yo.user.id);
    // Stripe acepta `customer` O `customer_email`, no los dos: con ambos
    // rechaza la sesión y la recontratación fallaba.
    if (estatus0?.stripe_customer_id) {
      body.set("customer", estatus0.stripe_customer_id as string);
    } else {
      body.set("customer_email", yo.user.email ?? "");
    }

    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const sess = await r.json();
    if (!r.ok) return responde({ error: sess?.error?.message || "Stripe rechazó la petición" }, 400);
    return responde({ url: sess.url });
  } catch (e) {
    return responde({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
