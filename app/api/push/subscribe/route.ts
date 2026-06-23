import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { user_id, rol, subscription } = body as {
    user_id: string
    rol: string
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  }

  if (!user_id || !rol || !subscription?.endpoint || !subscription?.keys) {
    return NextResponse.json({ error: "Datos incompletos" }, { status: 400 })
  }

  const supabase = await getSupabaseServerClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from("push_subscriptions").upsert(
    {
      user_id: String(user_id),
      rol,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    { onConflict: "endpoint" }
  )

  if (error) {
    console.error("[v0] push/subscribe POST error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { endpoint } = await req.json()
  if (!endpoint) return NextResponse.json({ error: "endpoint requerido" }, { status: 400 })

  const supabase = await getSupabaseServerClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("push_subscriptions").delete().eq("endpoint", endpoint)
  return NextResponse.json({ ok: true })
}
