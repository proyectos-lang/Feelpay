"use client"

import { useEffect } from "react"

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return

    navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
        // Nunca usar la versión cacheada del SW — siempre buscar el archivo
        // actualizado en el servidor para que install+activate corran de
        // inmediato y el SW en "waiting" no bloquee las notificaciones push.
        updateViaCache: "none",
      })
      .then((reg) => {
        console.log("[v0] SW registrado, scope:", reg.scope)
        // Forzar update para que sw.js nuevo entre en vigor de inmediato
        reg.update().catch(() => {})
      })
      .catch((err) => console.error("[v0] SW register error:", err))
  }, [])

  return null
}
