import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

// Llamado por el service worker cuando el browser rota el endpoint push
// (evento pushsubscriptionchange). Busca el endpoint viejo en la DB y lo
// reemplaza con el nuevo para que las notificaciones no se interrumpan.
export async function POST(req: NextRequest) {
  const { oldEndpoint, subscription } = await req.json() as {
    oldEndpoint: string
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  }

  if (!oldEndpoint || !subscription?.endpoint || !subscription?.keys) {
    return NextResponse.json({ error: "Datos incompletos" }, { status: 400 })
  }

  const supabase = await getSupabaseServerClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any

  // Buscar el registro del endpoint viejo para heredar user_id y rol
  const { data: old } = await sb
    .from("push_subscriptions")
    .select("user_id, rol")
    .eq("endpoint", oldEndpoint)
    .maybeSingle()

  if (!old) {
    console.warn("[v0] push/refresh: oldEndpoint no encontrado en DB:", oldEndpoint.slice(0, 60))
    return NextResponse.json({ ok: false, reason: "not_found" })
  }

  // Borrar el endpoint viejo e insertar el nuevo
  await sb.from("push_subscriptions").delete().eq("endpoint", oldEndpoint)
  const { error } = await sb.from("push_subscriptions").insert({
    user_id: old.user_id,
    rol: old.rol,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  })

  if (error) {
    console.error("[v0] push/refresh insert error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log(`[v0] push/refresh: endpoint rotado para user ${old.user_id} (${old.rol})`)
  return NextResponse.json({ ok: true })
}
