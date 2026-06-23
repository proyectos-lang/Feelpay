import { NextRequest, NextResponse } from "next/server"
import webpush from "web-push"
import { getSupabaseServerClient } from "@/lib/supabase/server"

webpush.setVapidDetails(
  process.env.VAPID_EMAIL!,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
)

type PushSub = { endpoint: string; p256dh: string; auth: string }

export async function POST(req: NextRequest) {
  const { title, body, tag, url } = await req.json() as {
    title: string
    body: string
    tag?: string
    url?: string
  }

  const supabase = await getSupabaseServerClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("rol", "gerencia")

  if (error) {
    console.error("[v0] push/notify fetch error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const subs = (data ?? []) as PushSub[]
  if (!subs.length) return NextResponse.json({ sent: 0 })

  const payload = JSON.stringify({ title, body, tag: tag ?? "reporte", url: url ?? "/" })

  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      )
    )
  )

  // Eliminar suscripciones vencidas (dispositivo revocó el permiso)
  const expiredEndpoints = results
    .map((r, i) => ({ r, endpoint: subs[i].endpoint }))
    .filter(({ r }) => {
      if (r.status !== "rejected") return false
      const code = (r as PromiseRejectedResult).reason?.statusCode
      return code === 410 || code === 404
    })
    .map(({ endpoint }) => endpoint)

  if (expiredEndpoints.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("push_subscriptions").delete().in("endpoint", expiredEndpoints)
    console.log(`[v0] push/notify: limpiadas ${expiredEndpoints.length} suscripciones expiradas`)
  }

  const sent = results.filter((r) => r.status === "fulfilled").length
  console.log(`[v0] push/notify: enviado a ${sent}/${subs.length} suscripciones`)
  return NextResponse.json({ sent })
}
