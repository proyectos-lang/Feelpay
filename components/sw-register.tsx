"use client"

import { useEffect } from "react"

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("[v0] SW register error:", err))
  }, [])
  return null
}
