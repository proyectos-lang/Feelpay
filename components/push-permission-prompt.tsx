"use client"

import { useEffect, useState } from "react"
import { Bell, X } from "lucide-react"
import type { AuthenticatedUser } from "./views/login-view"

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// Mapa del rol real del usuario al canal push que debe recibir notificaciones
function getPushRol(userRol: string): string | null {
  const r = userRol.toLowerCase()
  if (["admin", "administrador", "liquidador"].includes(r)) return "admin"
  if (["secretaria", "secretario"].includes(r)) return "secretaria"
  if (r === "gerencia") return "gerencia"
  if (r === "socioadmin") return "socioadmin"
  return null // vendedor/asesor no necesita push
}

async function subscribeUser(userId: string, pushRol: string) {
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!vapidKey) { console.error("[v0] push: VAPID key no configurada"); return }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return

  const reg = await navigator.serviceWorker.ready
  let existing = await reg.pushManager.getSubscription()
  if (existing && !existing.options?.applicationServerKey) {
    await existing.unsubscribe()
    existing = null
  }
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  })

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, rol: pushRol, subscription: sub.toJSON() }),
  })
  if (!res.ok) {
    console.error("[v0] push/subscribe error:", await res.text())
  } else {
    console.log("[v0] push: suscripción registrada para uid:", userId, "rol:", pushRol)
  }
}

interface Props {
  currentUser: AuthenticatedUser
}

export function PushPermissionPrompt({ currentUser }: Props) {
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return

    const pushRol = getPushRol(currentUser.rol ?? "")
    if (!pushRol) return

    const uid = String(currentUser.id)

    if (Notification.permission === "granted") {
      // Ya autorizado: re-suscribir silenciosamente para garantizar que el
      // endpoint esté vigente tras reinstalar la app o cambiar de dispositivo.
      subscribeUser(uid, pushRol).catch(() => {})
      return
    }

    if (Notification.permission === "denied") return

    // "default": mostrar banner. Usar sessionStorage para no repetir en la
    // misma sesión si el usuario lo descarta, pero sí volver a mostrar al
    // abrir la app de nuevo.
    const dismissedThisSession = sessionStorage.getItem("push_prompt_dismissed")
    if (!dismissedThisSession) {
      const t = setTimeout(() => setShow(true), 1200)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, currentUser.rol])

  const handleActivate = async () => {
    setLoading(true)
    try {
      const result = await Notification.requestPermission()
      if (result === "granted") {
        const pushRol = getPushRol(currentUser.rol ?? "")
        if (pushRol) await subscribeUser(String(currentUser.id), pushRol).catch(() => {})
      }
    } finally {
      setLoading(false)
      setShow(false)
    }
  }

  const handleDismiss = () => {
    sessionStorage.setItem("push_prompt_dismissed", "1")
    setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed bottom-20 md:bottom-6 left-0 right-0 z-50 px-4 animate-in slide-in-from-bottom-4 duration-300">
      <div className="max-w-sm mx-auto bg-card border border-border rounded-2xl shadow-2xl p-4 flex items-center gap-3">
        <div className="shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <Bell className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-tight">Activar notificaciones</p>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">
            Recibe alertas cuando lleguen nuevos reportes
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleActivate}
            disabled={loading}
            className="rounded-xl bg-primary text-primary-foreground text-xs font-bold px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "..." : "Activar"}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded-xl p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
