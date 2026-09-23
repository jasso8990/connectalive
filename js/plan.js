// Estado del plan del usuario (titular, maestro o sin plan).
//
// Patrón "sin webhook": nadie escucha a Stripe cuando cobra la renovación
// del mes. Por eso, si el plan viene de Stripe y ya venció (o vence en
// menos de un día), se le pregunta a Stripe al abrir la app. Sin esto, el
// cliente que SÍ pagó quedaba bloqueado al mes.

import { sb } from "./supabase.js";

export async function resumenDelPlan() {
  let { data, error } = await sb.rpc("panel_resumen");
  if (error) throw error;
  const t = data?.titular;
  const venceProx = t?.vence_en && new Date(t.vence_en).getTime() - Date.now() < 24 * 3600 * 1000;
  if (t?.con_stripe && (!t.vigente || venceProx)) {
    await revisarStripe();
    ({ data } = await sb.rpc("panel_resumen"));
  }
  return data;
}

export async function revisarStripe() {
  try { await sb.functions.invoke("cl-revisar-suscripcion", { body: {} }); }
  catch { /* sin Stripe configurado, se queda como estaba */ }
}

export function fechaCorta(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}
