/* ============================================================
   cl-revisar-suscripcion · pregúntale a Stripe qué pasó (ConnectaLive)
   ------------------------------------------------------------
   El navegador vuelve del Checkout: aquí se le pregunta a Stripe por el
   customer del usuario, se saca la última sub y se guarda en la base con
   `connectalive.plan_amarrar_stripe` (que sólo acepta service_role — un
   navegador no puede subirse el plan solo).

   No hay webhook: el frente dispara esta revisión al volver del Checkout
   con `?stripe=ok`. Menos partes móviles.

   Precios detectados desde estos secrets (misma tabla que crear-checkout):
     Connect_Price_Basico     → slug 'clase'   ($4.99)
     Connect_Price_Premium    → slug 'grupo'   ($19.99)
     Connect_Price_Profecional → slug 'escuela' ($49.99)
============================================================ */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const responde = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function planDePrice(price?: string): string | null {
  if (!price) return null;
  if (price === Deno.env.get("Connect_Price_Basico"))     return "clase";
  if (price === Deno.env.get("Connect_Price_Premium"))    return "grupo";
  if (price === Deno.env.get("Connect_Price_Profecional")) return "escuela";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const STRIPE = Deno.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE) return responde({ error: "Stripe no está configurado" }, 500);

  try {
    const supaUsuario = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        db: { schema: "connectalive" },
        global: { headers: { Authorization: req.headers.get("Authorization")! } },
      },
    );
    const { data: yo, error: errYo } = await supaUsuario.auth.getUser();
    if (errYo || !yo?.user) return responde({ error: "Sesión inválida" }, 401);

    const { data: estatus } = await supaUsuario.rpc("plan_estatus");
    const estatus0 = Array.isArray(estatus) ? estatus[0] : estatus;
    let customer = estatus0?.stripe_customer_id as string | undefined;

    if (!customer) {
      const r = await fetch(
        `https://api.stripe.com/v1/customers?email=${encodeURIComponent(yo.user.email ?? "")}&limit=1`,
        { headers: { Authorization: `Bearer ${STRIPE}` } },
      );
      const rj = await r.json();
      customer = rj?.data?.[0]?.id;
    }
    if (!customer) return responde({ ok: true, cambio: false, mensaje: "Sin customer" });

    const rs = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customer}&status=all&limit=1`,
      { headers: { Authorization: `Bearer ${STRIPE}` } },
    );
    const sj = await rs.json();
    const sub = sj?.data?.[0];
    if (!sub) return responde({ ok: true, cambio: false, mensaje: "Sin suscripción" });

    const price = sub?.items?.data?.[0]?.price?.id;
    const plan  = planDePrice(price);
    if (!plan) return responde({ ok: true, cambio: false, mensaje: "Price desconocido" });

    // La suscripción activa (o en periodo pagado) determina la fecha
    // hasta la que vale el plan.
    const vence_en = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "connectalive" } },
    );
    const { error: errAma } = await admin.rpc("plan_amarrar_stripe", {
      p_user_id:  yo.user.id,
      p_customer: customer,
      p_sub:      sub.id,
      p_plan:     plan,
      p_vence_en: vence_en,
    });
    if (errAma) return responde({ error: errAma.message }, 500);

    return responde({ ok: true, cambio: true, plan, vence_en });
  } catch (e) {
    return responde({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
