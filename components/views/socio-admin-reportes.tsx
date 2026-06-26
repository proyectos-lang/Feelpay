"use client"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import {
  Loader2,
  FileText,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ZoomIn,
  Bell,
  BellRing,
  MessageSquare,
  X,
  Download,
  FileSpreadsheet,
} from "lucide-react"
import type { AuthenticatedUser } from "@/components/views/login-view"

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface InformeImagen {
  id: string
  url_imagen: string
  nombre_archivo: string | null
  tipo: "imagen" | "archivo"
}

interface Informe {
  id: string
  secretaria_id: number
  secretaria_nombre: string
  ruta_id: number | null
  fecha: string
  nombre_reporte: string
  notas: string | null
  created_at: string
  destinatario: "gerencia" | "socioadmin"
  socioadmin_id: number | null
  informe_imagenes: InformeImagen[]
}

interface AgrupacionSecretaria {
  secretaria_id: number
  secretaria_nombre: string
  reportes: Informe[]
}

interface SocioAdminReportesProps {
  currentUser: AuthenticatedUser
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fechaColombiaHoy(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function SocioAdminReportes({ currentUser }: SocioAdminReportesProps) {
  const hoy = fechaColombiaHoy()
  const [selectedDate, setSelectedDate] = useState(hoy)
  const selectedDateRef = useRef(hoy)
  const [grupos, setGrupos] = useState<AgrupacionSecretaria[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default")
  const [newCount, setNewCount] = useState(0)
  const [banner, setBanner] = useState<{ nombre: string; reporte: string } | null>(null)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const uid = String(currentUser.id)

  useEffect(() => { selectedDateRef.current = selectedDate }, [selectedDate])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotifPermission("unsupported"); return
    }
    setNotifPermission(Notification.permission)
    if (Notification.permission === "granted") {
      subscribeToPush(uid).catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setLoading(true)
    setExpanded(new Set())
    const supabase = createClient()
    supabase
      .from("informes")
      .select("*, informe_imagenes(*)")
      .eq("destinatario", "socioadmin")
      .eq("socioadmin_id", Number(uid))
      .eq("fecha", selectedDate)
      .order("secretaria_nombre", { ascending: true })
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.error("[v0] SocioAdminReportes fetch error:", error); setLoading(false); return }
        const rows = (data as Informe[]) ?? []
        const map = new Map<number, AgrupacionSecretaria>()
        for (const inf of rows) {
          if (!map.has(inf.secretaria_id)) {
            map.set(inf.secretaria_id, { secretaria_id: inf.secretaria_id, secretaria_nombre: inf.secretaria_nombre, reportes: [] })
          }
          map.get(inf.secretaria_id)!.reportes.push(inf)
        }
        setGrupos(Array.from(map.values()))
        setLoading(false)
      })
  }, [selectedDate, uid])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("socioadmin-informes-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "informes" },
        (payload) => {
          const raw = payload.new as {
            id: string; secretaria_id: number; secretaria_nombre: string
            fecha: string; nombre_reporte: string; notas: string | null
            ruta_id: number | null; created_at: string
            destinatario: string; socioadmin_id: number | null
          }

          if (raw.destinatario !== "socioadmin" || raw.socioadmin_id !== Number(uid)) return

          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`Nuevo reporte — ${raw.secretaria_nombre}`, {
              body: raw.nombre_reporte, icon: "/opad-logo.png", tag: `informe-${raw.id}`,
            })
          }

          setNewCount((c) => c + 1)
          if (bannerTimer.current) clearTimeout(bannerTimer.current)
          setBanner({ nombre: raw.secretaria_nombre, reporte: raw.nombre_reporte })
          bannerTimer.current = setTimeout(() => setBanner(null), 7000)

          if (raw.fecha !== selectedDateRef.current) return
          supabase.from("informes").select("*, informe_imagenes(*)").eq("id", raw.id).single()
            .then(({ data }) => {
              if (!data) return
              const fullInf = data as Informe
              setGrupos((prev) => {
                const idx = prev.findIndex((g) => g.secretaria_id === fullInf.secretaria_id)
                if (idx >= 0) {
                  const next = [...prev]
                  next[idx] = { ...next[idx], reportes: [...next[idx].reportes, fullInf] }
                  return next
                }
                return [...prev, { secretaria_id: fullInf.secretaria_id, secretaria_nombre: fullInf.secretaria_nombre, reportes: [fullInf] }]
              })
            })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function subscribeToPush(userId: string) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapidKey) { console.error("[v0] VAPID public key no configurada"); return }

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
      body: JSON.stringify({ user_id: userId, rol: "socioadmin", subscription: sub.toJSON() }),
    })
    if (!res.ok) console.error("[v0] push/subscribe error:", await res.text())
    else console.log("[v0] push subscription guardada para socioadmin uid:", userId)
  }

  const requestPermission = async () => {
    if (!("Notification" in window)) return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
    if (result === "granted") {
      await subscribeToPush(uid).catch(() => {})
    }
  }

  const toggle = (id: number) =>
    setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })

  const [sy, sm, sd] = selectedDate.split("-").map(Number)
  const esHoy = selectedDate === hoy
  const fechaDisplay = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", weekday: "long", day: "numeric", month: "long",
  }).format(new Date(sy, sm - 1, sd))

  return (
    <div className="p-3 md:p-6 space-y-4">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 max-w-2xl mx-auto">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base md:text-lg font-bold leading-tight">Reportes</h2>
            <p className="text-xs text-muted-foreground">Socio Administrador</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!esHoy && (
            <Button size="sm" variant="outline" onClick={() => setSelectedDate(hoy)} className="h-8 text-xs px-3">
              Hoy
            </Button>
          )}
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={selectedDate}
              max={hoy}
              onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value) }}
              className="h-8 text-xs w-36"
            />
          </div>
          {notifPermission !== "unsupported" && (
            notifPermission === "granted" ? (
              <button
                type="button"
                title="Notificaciones activas"
                onClick={() => setNewCount(0)}
                className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card hover:bg-muted transition-colors"
              >
                <BellRing className="h-4 w-4 text-brand" />
                {newCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
                    {newCount > 9 ? "9+" : newCount}
                  </span>
                )}
              </button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={requestPermission}
                disabled={notifPermission === "denied"}
                className="shrink-0 h-8 gap-1.5 text-xs px-2.5"
              >
                <Bell className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{notifPermission === "denied" ? "Bloqueadas" : "Activar avisos"}</span>
              </Button>
            )
          )}
        </div>
      </div>

      {/* Banner in-app */}
      {banner && (
        <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand/10 px-4 py-2.5 text-sm max-w-2xl mx-auto">
          <BellRing className="h-4 w-4 shrink-0 animate-pulse text-brand" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">Nuevo reporte</span>
            <span className="text-muted-foreground"> · {banner.nombre}</span>
            {" — "}
            <span>{banner.reporte}</span>
          </div>
          <button type="button" onClick={() => setBanner(null)} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Subtítulo con fecha */}
      <p className="text-sm font-medium capitalize text-muted-foreground max-w-2xl mx-auto">
        {esHoy ? "Hoy · " : ""}{fechaDisplay}
      </p>

      {/* Lista */}
      <div className="max-w-2xl mx-auto">
        {loading ? (
          <div className="flex justify-center py-14">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : grupos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <FileText className="h-8 w-8 opacity-30" />
            <p className="text-sm">No hay reportes registrados{esHoy ? " hoy" : " este día"}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {grupos.map((grupo) => {
              const isExp = expanded.has(grupo.secretaria_id)
              return (
                <Card key={grupo.secretaria_id} className="overflow-hidden">
                  <button type="button" className="w-full text-left" onClick={() => toggle(grupo.secretaria_id)}>
                    <div className="flex items-center justify-between gap-2 px-4 py-3.5 hover:bg-muted/40 transition-colors">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <p className="font-semibold text-sm md:text-base leading-tight truncate">
                          {grupo.secretaria_nombre}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary" className="text-xs px-2">
                          {grupo.reportes.length} reporte{grupo.reportes.length !== 1 ? "s" : ""}
                        </Badge>
                        {isExp ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </div>
                  </button>
                  {isExp && (
                    <div className="border-t divide-y divide-border/60">
                      {grupo.reportes.map((inf) => {
                        const imagenes = inf.informe_imagenes.filter((a) => a.tipo !== "archivo")
                        const archivos = inf.informe_imagenes.filter((a) => a.tipo === "archivo")
                        return (
                          <div key={inf.id} className="px-4 py-4 space-y-3">
                            <p className="font-semibold text-sm md:text-base leading-snug">{inf.nombre_reporte}</p>
                            {inf.notas && (
                              <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                                <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-snug">{inf.notas}</p>
                              </div>
                            )}
                            {imagenes.length > 0 && (
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {imagenes.map((img) => (
                                  <button
                                    key={img.id}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setLightbox(img.url_imagen) }}
                                    className="relative aspect-square rounded-lg overflow-hidden border hover:opacity-90 transition-opacity group"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={img.url_imagen} alt={img.nombre_archivo ?? ""} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/25 transition-colors">
                                      <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                            {archivos.length > 0 && (
                              <div className="space-y-1.5">
                                {archivos.map((arch) => (
                                  <a
                                    key={arch.id}
                                    href={arch.url_imagen}
                                    download={arch.nombre_archivo ?? true}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 hover:bg-muted/70 transition-colors group"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <FileSpreadsheet className="h-5 w-5 shrink-0 text-green-600" />
                                    <span className="flex-1 text-sm font-medium truncate min-w-0">
                                      {arch.nombre_archivo ?? "Archivo"}
                                    </span>
                                    <Download className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                                  </a>
                                ))}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground/70">
                              {new Intl.DateTimeFormat("es-CO", {
                                timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true,
                              }).format(new Date(inf.created_at))}
                              {imagenes.length > 0 && ` · ${imagenes.length} img`}
                              {archivos.length > 0 && ` · ${archivos.length} archivo${archivos.length !== 1 ? "s" : ""}`}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Lightbox */}
      <Dialog open={!!lightbox} onOpenChange={(open) => { if (!open) setLightbox(null) }}>
        <DialogContent className="max-w-[95vw] md:max-w-3xl p-2 bg-black/95 border-0">
          {lightbox && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lightbox} alt="Imagen ampliada" className="w-full h-auto max-h-[85vh] object-contain rounded" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
