/* ============================================================
   cl-portal-cliente · abre el Customer Portal de Stripe (ConnectaLive)
   ------------------------------------------------------------
   Para que el titular cambie la tarjeta, cambie de plan (Stripe prorratea)
   o cancele. Qué deja hacer el portal se configura en el panel de Stripe
   (Settings → Billing → Customer portal), no aquí.

   ⚠️  EL NOMBRE LLEVA `cl-` A PROPÓSITO: los slugs de Edge Functions son
   únicos en TODO el proyecto de Supabase (compartido con Cancha `cn-*`,
   Smartagent y Market). Antes de desplegar: `list_edge_functions`.
============================================================ */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const responde = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ORIGEN_POR_DEFECTO = Deno.env.get("CL_APP_ORIGEN") ?? "https://connectalive.smrt-app.org";
const HOSTS_OK = new Set(["connectalive.smrt-app.org", "connectalive.netlify.app", "localhost:8888", "localhost:5173"]);

function origenSeguro(req: Request): string {
  try {
    const u = new URL(req.headers.get("origin") ?? req.headers.get("referer") ?? "");
    if (HOSTS_OK.has(u.host)) return `${u.protocol}//${u.host}`;
  } catch { /* ignora */ }
  return ORIGEN_POR_DEFECTO;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const STRIPE = Deno.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE) return responde({ error: "Stripe no está configurado" }, 500);

  try {
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

    const { data: estatus } = await supa.rpc("plan_estatus");
    const estatus0 = Array.isArray(estatus) ? estatus[0] : estatus;
    const customer = estatus0?.stripe_customer_id as string | undefined;
    if (!customer) return responde({ error: "Tu plan no se pagó con Stripe; no hay portal de pagos." }, 400);

    const body = new URLSearchParams();
    body.set("customer", customer);
    // Al volver se relee Stripe: si cambió de plan, el panel ya lo enseña.
    body.set("return_url", `${origenSeguro(req)}/panel?stripe=ok`);

    const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${STRIPE}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const sess = await r.json();
    if (!r.ok) return responde({ error: sess?.error?.message || "Stripe rechazó la petición" }, 400);
    return responde({ url: sess.url });
  } catch (e) {
    return responde({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
